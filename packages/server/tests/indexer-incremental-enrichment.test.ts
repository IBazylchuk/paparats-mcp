import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Indexer } from '../src/indexer.js';
import { MetadataStore } from '../src/metadata-db.js';
import { createTreeSitterManager } from '../src/tree-sitter-parser.js';
import { buildSymbolEdges, type ChunkSymbols } from '../src/symbol-graph.js';
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
    filter?: { must?: { key: string; match: { value?: unknown; any?: unknown[] } }[] }
  ): boolean => {
    const payload = (point as { payload?: Record<string, unknown> }).payload;
    if (!filter?.must) return true;
    return filter.must.every((m) => {
      const wanted = m.match.any ?? [m.match.value];
      const value = payload?.[m.key];
      return Array.isArray(value) ? value.some((v) => wanted.includes(v)) : wanted.includes(value);
    });
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

/**
 * Extract the chunk_id filter values from recorded setPayload calls (the
 * per-file `file_churn` updates filter by file, not chunk_id, and are skipped).
 */
function setPayloadChunkIds(client: ReturnType<typeof createMockQdrant>['client']): string[] {
  return client.setPayload.mock.calls.flatMap((call) => {
    const opts = call[1] as {
      filter: { must: Array<{ key: string; match: { value: string } }> };
    };
    const chunkId = opts.filter.must.find((m) => m.key === 'chunk_id');
    return chunkId ? [chunkId.match.value] : [];
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

  it('rebuilds a lost symbol graph even when no file changed', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'c.ts'),
      "import { alpha } from './a';\nexport function gamma() {\n  return alpha() + 1;\n}\n"
    );
    git(projectDir, 'add .');
    git(projectDir, 'commit -m "add caller"');

    const treeSitter = await createTreeSitterManager();
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
      metadataStore,
      treeSitter,
    });
    const project = createProjectConfig(projectDir);

    await indexer.indexProject(project);
    expect(metadataStore.hasEdgesForProject('test-group', 'test-project')).toBe(true);

    // Simulate a rebuild that deleted the edges and then failed to write new ones.
    metadataStore.deleteEdgesByProject('test-group', 'test-project');
    expect(metadataStore.hasEdgesForProject('test-group', 'test-project')).toBe(false);

    // Nothing changed on disk, so every file is skipped — the graph must still come back.
    expect(await indexer.indexProject(project)).toBe(0);
    expect(metadataStore.hasEdgesForProject('test-group', 'test-project')).toBe(true);
  });
  it('rebuilds the graph after a single file changes outside a project pass', async () => {
    const treeSitter = await createTreeSitterManager();
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
      metadataStore,
      treeSitter,
    });
    const project = createProjectConfig(projectDir);
    await indexer.indexProject(project);
    const callers = () =>
      metadataStore
        .getEdgesFromFile('test-group', 'test-project', 'src/c.ts')
        .map((e) => e.symbol_name);
    expect(callers()).toEqual([]);

    // A new caller arrives through the content API, as the CLI watcher sends it.
    await indexer.updateFileContent(
      'test-group',
      'test-project',
      'src/c.ts',
      'export function gamma() {\n  return alpha() + beta();\n}\n',
      'typescript',
      project
    );
    await indexer.flushSymbolGraphs();
    expect(callers().sort()).toEqual(['alpha', 'beta']);

    // It changes again: the edges follow the new chunk, none point at the old one.
    await indexer.updateFileContent(
      'test-group',
      'test-project',
      'src/c.ts',
      'export function gamma() {\n  return beta();\n}\n',
      'typescript',
      project
    );
    await indexer.flushSymbolGraphs();
    const edges = metadataStore.getEdgesFromFile('test-group', 'test-project', 'src/c.ts');
    expect(edges.map((e) => e.symbol_name)).toEqual(['beta']);
    const live = new Set(
      [...mockQdrant.collections.values()].flatMap((points) =>
        [...points.values()].map((p) => (p as { payload: { chunk_id: string } }).payload.chunk_id)
      )
    );
    expect(live.has(edges[0]!.from_chunk_id)).toBe(true);

    await indexer.deleteFileByPath('test-group', 'test-project', 'src/c.ts');
    await indexer.flushSymbolGraphs();
    expect(callers()).toEqual([]);
  });

  it('updates the graph for changes to what a full rebuild gives, without reading the whole project', async () => {
    const treeSitter = await createTreeSitterManager();
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
      metadataStore,
      treeSitter,
    });
    const project = createProjectConfig(projectDir);
    fs.writeFileSync(
      path.join(projectDir, 'src', 'c.ts'),
      'export function gamma() {\n  return alpha() + beta();\n}\n'
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'd.ts'),
      'export function delta() {\n  return gamma() + alpha();\n}\n'
    );
    await indexer.indexProject(project);

    const chunks = (): ChunkSymbols[] =>
      [...mockQdrant.collections.values()].flatMap((points) =>
        [...points.values()].flatMap((p) => {
          const payload = (p as { payload?: Record<string, unknown> }).payload ?? {};
          if (typeof payload['chunk_id'] !== 'string') return [];
          return {
            chunk_id: payload['chunk_id'] as string,
            defines_symbols: (payload['defines_symbols'] as string[]) ?? [],
            uses_symbols: (payload['uses_symbols'] as string[]) ?? [],
            use_sites: payload['use_sites'] as ChunkSymbols['use_sites'],
            def_owners: payload['def_owners'] as Record<string, string>,
          };
        })
      );
    const key = (e: {
      from_chunk_id: string;
      to_chunk_id: string;
      symbol_name: string;
      confidence?: string;
      from_symbols?: string[];
    }) =>
      [
        e.from_chunk_id,
        e.to_chunk_id,
        e.symbol_name,
        e.confidence,
        [...(e.from_symbols ?? [])].sort().join(','),
      ].join(' ');
    const stored = () =>
      chunks()
        .flatMap((c) => metadataStore.getEdgesFrom(c.chunk_id))
        .map(key)
        .sort();
    const rebuilt = () => buildSymbolEdges(chunks()).edges.map(key).sort();
    // Scans of every chunk's symbols (the git step reads every chunk too, for other fields).
    const fullScans = () =>
      mockQdrant.client.scroll.mock.calls.filter((call) => {
        const opts = call[1] as {
          filter?: { must?: Array<{ key: string }> };
          with_payload?: { include?: string[] };
        };
        const must = opts.filter?.must;
        return (
          must?.length === 1 &&
          must[0]!.key === 'project' &&
          !!opts.with_payload?.include?.includes('defines_symbols')
        );
      }).length;
    const update = async (file: string, content: string | null) => {
      if (content === null) await indexer.deleteFileByPath('test-group', 'test-project', file);
      else
        await indexer.updateFileContent(
          'test-group',
          'test-project',
          file,
          content,
          'typescript',
          project
        );
      await indexer.flushSymbolGraphs();
      expect(stored()).toEqual(rebuilt());
    };

    expect(stored()).toEqual(rebuilt());
    const scansBefore = fullScans();
    // A second definition of `alpha`: its callers in c.ts and d.ts become ambiguous.
    await update('src/e.ts', 'export function alpha() {\n  return 2;\n}\n');
    expect(stored().filter((e) => e.includes(' alpha AMBIGUOUS'))).toHaveLength(4);
    // The first one goes: they link to the one left.
    await update('src/a.ts', 'export function alphaOld() {\n  return 1;\n}\n');
    await update('src/e.ts', null);
    expect(stored().some((e) => e.includes(' alpha '))).toBe(false);
    await update('src/c.ts', 'export function gamma() {\n  return beta() + delta();\n}\n');
    await update('src/b.ts', null);
    // A project pass applies what it changed the same way.
    fs.writeFileSync(
      path.join(projectDir, 'src', 'd.ts'),
      'export function delta() {\n  return gamma();\n}\nexport function alpha() {\n  return 3;\n}\n'
    );
    await indexer.indexProject(project);
    expect(stored()).toEqual(rebuilt());
    expect(fullScans()).toBe(scansBefore);
    expect(metadataStore.graphChanges('test-group', 'test-project')).toBeNull();
  });
});
