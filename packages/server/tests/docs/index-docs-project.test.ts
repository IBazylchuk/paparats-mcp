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
    pruneDocuments: vi.fn(async (): Promise<string[]> => []),
  };
}

/** The set of files the walk asked the store to keep, from its single prune call. */
function keptFiles(store: { pruneDocuments: ReturnType<typeof vi.fn> }): string[] {
  expect(store.pruneDocuments).toHaveBeenCalledTimes(1);
  const [group, projectName, keep] = store.pruneDocuments.mock.calls[0] as [
    string,
    string,
    Set<string>,
  ];
  expect(group).toBe('g');
  expect(projectName).toBe('billing');
  return Array.from(keep).sort();
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
      pruneDocuments: vi.fn(async (): Promise<string[]> => []),
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

  it('does not walk into markdown reached through a symlink into .git or out of the project', async () => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.git', 'config'),
      '# not docs\n\nurl = https://token@git.example.com\n'
    );
    fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\nbody');
    fs.symlinkSync(path.join(dir, '.git', 'config'), path.join(dir, 'notes.md'));
    const docsStore = fakeDocsStore();
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider: provider,
      dimensions: 4,
      qdrantClient: {} as never,
      docsStore: docsStore as unknown as DocsStore,
    });
    await indexer.indexDocsProject(project(dir));
    const files = docsStore.indexDocument.mock.calls.map((c) => (c[1] as { file: string }).file);
    expect(files).toEqual(['guide.md']);
    // And the link is outside the kept set, so anything indexed through it before is pruned.
    expect(keptFiles(docsStore)).toEqual(['guide.md']);
  });

  describe('classifying docs as prose or code', () => {
    function indexerWith(docsStore: unknown): Indexer {
      return new Indexer({
        qdrantUrl: 'http://localhost:6333',
        embeddingProvider: provider,
        dimensions: 4,
        qdrantClient: {} as never,
        docsStore: docsStore as DocsStore,
      });
    }
    const kinds = (store: ReturnType<typeof fakeDocsStore>): string[] =>
      store.indexDocument.mock.calls.map((c) => (c[1] as { kind: string }).kind);

    it('treats a markdown-only repository with no detected language as prose', async () => {
      fs.writeFileSync(path.join(dir, 'page-one.md'), '# One\n\nbody');
      fs.writeFileSync(path.join(dir, 'page-two.md'), '# Two\n\nbody');
      fs.writeFileSync(path.join(dir, 'diagram.png'), 'not really a png');
      const store = fakeDocsStore();
      await indexerWith(store).indexDocsProject(project(dir, { languages: ['generic'] }));
      expect(kinds(store)).toEqual(['prose', 'prose']);
    });

    it('keeps code for a repository in a language without a profile', async () => {
      fs.writeFileSync(path.join(dir, 'README.md'), '# Service\n\nbody');
      for (const name of ['a.ex', 'b.ex', 'c.ex']) {
        fs.writeFileSync(path.join(dir, name), 'defmodule A do\nend\n');
      }
      const store = fakeDocsStore();
      await indexerWith(store).indexDocsProject(project(dir, { languages: ['generic'] }));
      expect(kinds(store)).toEqual(['code']);
    });

    it('treats a detected language as code', async () => {
      fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\nbody');
      const store = fakeDocsStore();
      await indexerWith(store).indexDocsProject(project(dir));
      expect(kinds(store)).toEqual(['code']);
    });

    it('lets docs.kind override the detection', async () => {
      fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\nbody');
      const store = fakeDocsStore();
      await indexerWith(store).indexDocsProject(project(dir, { docs: { kind: 'prose' } }));
      expect(kinds(store)).toEqual(['prose']);
    });
  });

  describe('removing documents that are gone', () => {
    function indexerWith(docsStore: unknown): Indexer {
      return new Indexer({
        qdrantUrl: 'http://localhost:6333',
        embeddingProvider: provider,
        dimensions: 4,
        qdrantClient: {} as never,
        docsStore: docsStore as DocsStore,
      });
    }

    it('keeps exactly the files the walk found, so a deleted one is pruned', async () => {
      fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\nhow to deploy');
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', 'ops.md'), '# Ops\n\nrestart');
      const docsStore = fakeDocsStore();
      await indexerWith(docsStore).indexDocsProject(project(dir));
      expect(keptFiles(docsStore)).toEqual(['guide.md', path.join('sub', 'ops.md')].sort());
    });

    it('prunes every document once the last markdown file is gone', async () => {
      fs.writeFileSync(path.join(dir, 'code.ts'), 'const x = 1;');
      const docsStore = fakeDocsStore();
      expect(await indexerWith(docsStore).indexDocsProject(project(dir))).toBe(0);
      expect(keptFiles(docsStore)).toEqual([]);
    });

    it('prunes a file that is no longer markdown', async () => {
      fs.writeFileSync(path.join(dir, 'good.md'), '# Good\n\nreal markdown');
      fs.writeFileSync(path.join(dir, 'bad.md'), 'not really markdown');
      const { NotMarkdownError } = await import('../../src/docs/chunker.js');
      const docsStore = {
        indexDocument: vi.fn(async (_g: string, input: { file: string }) => {
          if (input.file === 'bad.md') throw new NotMarkdownError('no structure');
          return 2;
        }),
        pruneDocuments: vi.fn(async (): Promise<string[]> => []),
      };
      await indexerWith(docsStore).indexDocsProject(project(dir));
      expect(keptFiles(docsStore)).toEqual(['good.md']);
    });

    it('keeps a file whose indexing failed, so a transient error does not unpublish it', async () => {
      fs.writeFileSync(path.join(dir, 'good.md'), '# Good\n\nreal markdown');
      fs.writeFileSync(path.join(dir, 'flaky.md'), '# Flaky\n\nembedder was down');
      const docsStore = {
        indexDocument: vi.fn(async (_g: string, input: { file: string }) => {
          if (input.file === 'flaky.md') throw new Error('embedding server unavailable');
          return 2;
        }),
        pruneDocuments: vi.fn(async (): Promise<string[]> => []),
      };
      await indexerWith(docsStore).indexDocsProject(project(dir));
      expect(keptFiles(docsStore)).toEqual(['flaky.md', 'good.md']);
    });

    it('does not prune when the project path is missing', async () => {
      const docsStore = fakeDocsStore();
      await indexerWith(docsStore).indexDocsProject(project(path.join(dir, 'gone')));
      expect(docsStore.pruneDocuments).not.toHaveBeenCalled();
    });

    it('does not fail the run when the prune fails', async () => {
      fs.writeFileSync(path.join(dir, 'guide.md'), '# Guide\n\nhow to deploy');
      const docsStore = fakeDocsStore();
      docsStore.pruneDocuments.mockRejectedValueOnce(new Error('qdrant down'));
      expect(await indexerWith(docsStore).indexDocsProject(project(dir))).toBe(3);
    });
  });
});
