import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Indexer } from '../../src/indexer.js';
import { EmbeddingCache, CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { EmbeddingProvider, ProjectConfig } from '../../src/types.js';
import type { DocsStore } from '../../src/docs/store.js';

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-model';
  readonly dimensions = 4;
  async embed(): Promise<number[]> {
    return [0, 0, 0, 1];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0, 1]);
  }
}

function tmp(): string {
  const d = path.join(os.tmpdir(), `docs-walk-${process.pid}-${Math.floor(performance.now())}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function project(dir: string, overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: 'billing',
    path: dir,
    group: 'g',
    languages: ['typescript'],
    patterns: ['**/*.ts'],
    exclude: [],
    indexing: {
      paths: [],
      exclude: [],
      respectGitignore: false,
      extensions: [],
      chunkSize: 1024,
      overlap: 128,
      concurrency: 2,
      batchSize: 50,
    },
    watcher: { enabled: true, debounce: 1000, stabilityThreshold: 1000 },
    embeddings: { provider: 'llama', model: 'test', dimensions: 4 },
    metadata: {
      service: 'billing',
      bounded_context: null,
      tags: [],
      directory_tags: {},
      git: { enabled: false, maxCommitsPerFile: 50, ticketPatterns: [] },
    },
    ...overrides,
  };
}

function fakeDocsStore() {
  return {
    indexDocument: vi.fn(async () => 3),
  };
}

describe('Indexer.indexDocsProject', () => {
  let dir: string;
  let provider: CachedEmbeddingProvider;

  beforeEach(() => {
    dir = tmp();
    provider = new CachedEmbeddingProvider(
      new MockEmbeddingProvider(),
      new EmbeddingCache(':memory:')
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when no docsStore is configured', async () => {
    fs.writeFileSync(path.join(dir, 'a.md'), '# Title\n\nbody');
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider: provider,
      dimensions: 4,
      qdrantClient: {} as never,
    });
    expect(await indexer.indexDocsProject(project(dir))).toBe(0);
  });

  it('walks .md files and calls docsStore.indexDocument with the clean project name', async () => {
    fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\nhow to deploy the service');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'ops.markdown'), '# Ops\n\nrestart the pods');
    const docsStore = fakeDocsStore();
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider: provider,
      dimensions: 4,
      qdrantClient: {} as never,
      docsStore: docsStore as unknown as DocsStore,
      // Suffix is set, but docs must still write the CLEAN name.
      projectSuffix: '-v3',
    });
    const n = await indexer.indexDocsProject(project(dir));
    expect(n).toBe(6); // 2 files × 3 chunks (mock)
    expect(docsStore.indexDocument).toHaveBeenCalledTimes(2);
    for (const call of docsStore.indexDocument.mock.calls) {
      const [group, input] = call as [string, { project: string; file: string }];
      expect(group).toBe('g');
      expect(input.project).toBe('billing'); // clean, NOT billing-v3
    }
    const files = docsStore.indexDocument.mock.calls.map((c) => (c[1] as { file: string }).file);
    expect(files).toContain('guide.md');
    expect(files).toContain(path.join('sub', 'ops.markdown'));
  });

  it('ignores non-.md files', async () => {
    fs.writeFileSync(path.join(dir, 'code.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(dir, 'readme.md'), '# R\n\nhi');
    const docsStore = fakeDocsStore();
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider: provider,
      dimensions: 4,
      qdrantClient: {} as never,
      docsStore: docsStore as unknown as DocsStore,
    });
    await indexer.indexDocsProject(project(dir));
    expect(docsStore.indexDocument).toHaveBeenCalledTimes(1);
  });

  it('skips a file the store rejects as non-markdown, without failing the run', async () => {
    fs.writeFileSync(path.join(dir, 'good.md'), '# Good\n\nreal markdown');
    fs.writeFileSync(path.join(dir, 'bad.md'), 'not really markdown');
    const { NotMarkdownError } = await import('../../src/docs/chunker.js');
    const docsStore = {
      indexDocument: vi.fn(async (_g: string, input: { file: string }) => {
        if (input.file === 'bad.md') throw new NotMarkdownError('no structure');
        return 2;
      }),
    };
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider: provider,
      dimensions: 4,
      qdrantClient: {} as never,
      docsStore: docsStore as unknown as DocsStore,
    });
    const n = await indexer.indexDocsProject(project(dir));
    expect(n).toBe(2); // only good.md contributed
    expect(docsStore.indexDocument).toHaveBeenCalledTimes(2);
  });
});
