import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer.js';
import { MetadataStore } from '../src/metadata-db.js';
import { EmbeddingCache, CachedEmbeddingProvider } from '../src/embeddings.js';
import type { EmbeddingProvider, ProjectConfig } from '../src/types.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-incr-enrich-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-model';
  readonly dimensions = 4;

  async embed(text: string): Promise<number[]> {
    return [text.length, 0, 0, 1];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => [t.length, 0, 0, 1]);
  }
}

/** Mock Qdrant - stores points in memory, records setPayload calls */
function createMockQdrant() {
  const collections = new Map<string, Map<string, unknown>>();

  const matchesFilter = (
    point: unknown,
    filter?: { must?: { key: string; match: { value: string } }[] }
  ): boolean => {
    const payload = (point as { payload?: Record<string, unknown> }).payload;
    if (!filter?.must) return true;
    return filter.must.every((m) => payload?.[m.key] === m.match.value);
  };

  const client = {
    getCollection: vi.fn().mockImplementation((name: string) => {
      if (!collections.has(name)) throw new Error('Collection not found');
      return Promise.resolve({ points_count: collections.get(name)!.size, status: 'green' });
    }),
    createCollection: vi.fn().mockImplementation((name: string) => {
      if (!collections.has(name)) collections.set(name, new Map());
      return Promise.resolve(true);
    }),
    createPayloadIndex: vi.fn().mockResolvedValue(true),
    upsert: vi.fn().mockImplementation((name: string, opts: { points: { id: string }[] }) => {
      if (!collections.has(name)) collections.set(name, new Map());
      const points = collections.get(name)!;
      for (const p of opts.points) points.set(String(p.id), p);
      return Promise.resolve(true);
    }),
    delete: vi.fn().mockImplementation((name: string, opts: { filter?: unknown }) => {
      const points = collections.get(name);
      if (points) {
        for (const [id, point] of points.entries()) {
          if (matchesFilter(point, opts.filter as never)) points.delete(id);
        }
      }
      return Promise.resolve(true);
    }),
    scroll: vi.fn().mockImplementation((name: string, opts: { filter?: unknown }) => {
      const points = collections.get(name);
      if (!points) return Promise.resolve({ points: [], next_page_offset: null });
      const matched = Array.from(points.values()).filter((p) =>
        matchesFilter(p, opts.filter as never)
      );
      return Promise.resolve({ points: matched, next_page_offset: null });
    }),
    deleteCollection: vi.fn().mockImplementation((name: string) => {
      collections.delete(name);
      return Promise.resolve(true);
    }),
    getCollections: vi.fn().mockImplementation(() =>
      Promise.resolve({
        collections: Array.from(collections.keys()).map((name) => ({ name })),
      })
    ),
    retrieve: vi.fn().mockImplementation((name: string, opts: { ids: string[] }) => {
      const points = collections.get(name);
      if (!points) return Promise.resolve([]);
      return Promise.resolve(opts.ids.map((id) => points.get(String(id))).filter(Boolean));
    }),
    setPayload: vi.fn().mockResolvedValue(true),
  };

  return { client, collections };
}

function createProjectConfig(projectDir: string): ProjectConfig {
  return {
    name: 'test-project',
    path: projectDir,
    group: 'test-group',
    languages: ['typescript'],
    patterns: ['**/*.ts'],
    exclude: [],
    indexing: {
      paths: [],
      exclude: [],
      respectGitignore: true,
      extensions: [],
      chunkSize: 1024,
      overlap: 128,
      concurrency: 2,
      batchSize: 50,
    },
    watcher: { enabled: true, debounce: 1000, stabilityThreshold: 1000 },
    embeddings: { provider: 'llama', model: 'test', dimensions: 4 },
    metadata: {
      service: 'test-project',
      bounded_context: null,
      tags: [],
      directory_tags: {},
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    },
  };
}

function git(dir: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd: dir, stdio: 'ignore' });
}

/** Extract the chunk_id filter values from recorded setPayload calls */
function setPayloadChunkIds(client: ReturnType<typeof createMockQdrant>['client']): string[] {
  return client.setPayload.mock.calls.map((call) => {
    const opts = call[1] as {
      filter: { must: Array<{ key: string; match: { value: string } }> };
    };
    return opts.filter.must.find((m) => m.key === 'chunk_id')!.match.value;
  });
}

describe('indexProject incremental git enrichment', () => {
  let projectDir: string;
  let auxDir: string;
  let mockQdrant: ReturnType<typeof createMockQdrant>;
  let embeddingProvider: CachedEmbeddingProvider;
  let metadataStore: MetadataStore;

  beforeEach(() => {
    projectDir = createTempDir();
    auxDir = createTempDir();
    mockQdrant = createMockQdrant();
    embeddingProvider = new CachedEmbeddingProvider(
      new MockEmbeddingProvider(),
      new EmbeddingCache(path.join(auxDir, 'cache.db'), 100)
    );
    metadataStore = new MetadataStore(path.join(auxDir, 'metadata.db'));

    git(projectDir, 'init');
    git(projectDir, 'config user.email "test@test.com"');
    git(projectDir, 'config user.name "Test"');
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, 'a.ts'),
      'export function alpha() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n'
    );
    fs.writeFileSync(
      path.join(srcDir, 'b.ts'),
      'export function beta() {\n  const a = 3;\n  const b = 4;\n  return a + b;\n}\n'
    );
    git(projectDir, 'add .');
    git(projectDir, 'commit -m "initial"');
  });

  afterEach(() => {
    metadataStore.close();
    embeddingProvider.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(auxDir, { recursive: true, force: true });
  });

  it('re-enriches only reindexed files, not skipped-unchanged ones', async () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
      metadataStore,
    });
    const project = createProjectConfig(projectDir);

    // First index: both files enriched
    await indexer.indexProject(project);
    const firstIds = setPayloadChunkIds(mockQdrant.client);
    expect(firstIds.some((id) => id.includes('//src/a.ts//'))).toBe(true);
    expect(firstIds.some((id) => id.includes('//src/b.ts//'))).toBe(true);

    // Change only b.ts and commit
    fs.writeFileSync(
      path.join(projectDir, 'src', 'b.ts'),
      'export function beta() {\n  const a = 3;\n  const b = 4;\n  return a + b;\n}\nexport function gamma() {\n  return 5;\n}\n'
    );
    git(projectDir, 'add .');
    git(projectDir, 'commit -m "change b"');

    mockQdrant.client.setPayload.mockClear();

    // Second index: a.ts is skipped (unchanged), only b.ts reindexed
    await indexer.indexProject(project);
    const secondIds = setPayloadChunkIds(mockQdrant.client);
    expect(secondIds.some((id) => id.includes('//src/b.ts//'))).toBe(true);
    expect(secondIds.some((id) => id.includes('//src/a.ts//'))).toBe(false);
  });
});
