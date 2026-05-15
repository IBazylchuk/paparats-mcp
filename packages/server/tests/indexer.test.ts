import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Indexer, toCollectionName } from '../src/indexer.js';
import { EmbeddingCache, CachedEmbeddingProvider } from '../src/embeddings.js';
import type { EmbeddingProvider, ProjectConfig } from '../src/types.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-indexer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

/** Mock embedding provider - returns fixed-size vectors */
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

/** Mock Qdrant - stores points in memory */
function createMockQdrant() {
  const collections = new Map<string, Map<string, unknown>>();
  const upsertedPoints: { group: string; points: unknown[] }[] = [];

  const client = {
    getCollection: vi.fn().mockImplementation((name: string) => {
      if (!collections.has(name)) {
        throw new Error('Collection not found');
      }
      const points = collections.get(name)!;
      return Promise.resolve({
        points_count: points.size,
        status: 'green',
      });
    }),

    createCollection: vi.fn().mockImplementation((name: string, _opts?: unknown) => {
      if (!collections.has(name)) {
        collections.set(name, new Map());
      }
      return Promise.resolve(true);
    }),

    createPayloadIndex: vi.fn().mockResolvedValue(true),

    upsert: vi.fn().mockImplementation((groupName: string, opts: { points: unknown[] }) => {
      upsertedPoints.push({ group: groupName, points: opts.points });
      if (!collections.has(groupName)) {
        collections.set(groupName, new Map());
      }
      const points = collections.get(groupName)!;
      for (const p of opts.points as { id: string }[]) {
        points.set(String(p.id), p);
      }
      return Promise.resolve(true);
    }),

    delete: vi.fn().mockImplementation((groupName: string, opts: { filter?: unknown }) => {
      if (collections.has(groupName)) {
        const filter = opts?.filter as {
          must?: { key: string; match: { value: string } }[];
        };
        const fileMatch = filter?.must?.find((m) => m.key === 'file');
        const projectMatch = filter?.must?.find((m) => m.key === 'project');
        const points = collections.get(groupName)!;
        for (const [id, point] of points.entries()) {
          const payload = (point as { payload?: { file?: string; project?: string } }).payload;
          const fileOk = !fileMatch || payload?.file === fileMatch.match.value;
          const projectOk = !projectMatch || payload?.project === projectMatch.match.value;
          if (fileOk && projectOk) points.delete(id);
        }
      }
      return Promise.resolve(true);
    }),

    scroll: vi.fn().mockImplementation((groupName: string, opts: { filter?: unknown }) => {
      if (!collections.has(groupName)) {
        return Promise.resolve({ points: [], next_page_offset: null });
      }
      const filter = opts?.filter as {
        must?: { key: string; match: { value: string } }[];
      };
      const fileMatch = filter?.must?.find((m) => m.key === 'file');
      const projectMatch = filter?.must?.find((m) => m.key === 'project');
      const points = collections.get(groupName)!;
      const matched: unknown[] = [];
      for (const point of points.values()) {
        const payload = (point as { payload?: { file?: string; project?: string } }).payload;
        if (
          (!fileMatch || payload?.file === fileMatch.match.value) &&
          (!projectMatch || payload?.project === projectMatch.match.value)
        ) {
          matched.push(point);
        }
      }
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
  };

  return { client, upsertedPoints, collections };
}

function createProjectConfig(
  projectDir: string,
  overrides?: Partial<ProjectConfig>
): ProjectConfig {
  return {
    name: 'test-project',
    path: projectDir,
    group: 'test-group',
    languages: ['typescript'],
    patterns: ['**/*.ts', '**/*.bin'],
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
    embeddings: { provider: 'ollama', model: 'test', dimensions: 4 },
    metadata: {
      service: 'test-project',
      bounded_context: null,
      tags: [],
      directory_tags: {},
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    },
    ...overrides,
  };
}

describe('Indexer', () => {
  let projectDir: string;
  let mockQdrant: ReturnType<typeof createMockQdrant>;
  let embeddingProvider: CachedEmbeddingProvider;

  beforeEach(() => {
    projectDir = createTempDir();
    mockQdrant = createMockQdrant();
    const mock = new MockEmbeddingProvider();
    const cache = new EmbeddingCache(path.join(projectDir, 'cache.db'), 100);
    embeddingProvider = new CachedEmbeddingProvider(mock, cache);
  });

  afterEach(() => {
    embeddingProvider.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates Indexer with config', () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });
    expect(indexer.stats).toEqual({ files: 0, chunks: 0, cached: 0, errors: 0, skipped: 0 });
  });

  it('getGroupStats returns not_indexed for missing collection', async () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const stats = await indexer.getGroupStats('nonexistent');
    expect(stats).toEqual({ points: 0, status: 'not_indexed' });
  });

  it('getGroupStats returns points for existing collection', async () => {
    mockQdrant.collections.set(toCollectionName('my-group'), new Map());
    mockQdrant.client.getCollection.mockResolvedValueOnce({ points_count: 42, status: 'green' });

    const indexer = new Indexer({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const stats = await indexer.getGroupStats('my-group');
    expect(stats).toEqual({ points: 42, status: 'green' });
  });

  it('ensureCollection creates collection when missing', async () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    await indexer.ensureCollection('new-group');

    expect(mockQdrant.client.createCollection).toHaveBeenCalledWith(toCollectionName('new-group'), {
      vectors: { size: 4, distance: 'Cosine' },
    });
    expect(mockQdrant.client.createPayloadIndex).toHaveBeenCalledWith(
      toCollectionName('new-group'),
      {
        field_name: 'project',
        field_schema: 'keyword',
        wait: true,
      }
    );
    expect(mockQdrant.client.createPayloadIndex).toHaveBeenCalledWith(
      toCollectionName('new-group'),
      {
        field_name: 'file',
        field_schema: 'keyword',
        wait: true,
      }
    );
  });

  it('indexFile skips binary files', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const binaryPath = path.join(srcDir, 'binary.bin');
    fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    const result = await indexer.indexFile('test-group', project, binaryPath);
    expect(result).toBe(0);
    expect(mockQdrant.upsertedPoints).toHaveLength(0);
  });

  it('indexFile skips invalid UTF-8', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const badPath = path.join(srcDir, 'bad.txt');
    fs.writeFileSync(badPath, Buffer.from([0xff, 0xfe]));

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    const result = await indexer.indexFile('test-group', project, badPath);
    expect(result).toBe(0);
    expect(mockQdrant.upsertedPoints).toHaveLength(0);
  });

  it('indexFile skips empty content', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const emptyPath = path.join(srcDir, 'empty.ts');
    fs.writeFileSync(emptyPath, '');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    const result = await indexer.indexFile('test-group', project, emptyPath);
    expect(result).toBe(0);
    expect(mockQdrant.upsertedPoints).toHaveLength(0);
  });

  it('indexFile indexes text file and upserts points', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const tsPath = path.join(srcDir, 'foo.ts');
    fs.writeFileSync(
      tsPath,
      [
        'export function foo() {',
        '  return 1;',
        '}',
        '',
        'export function bar() {',
        '  return 2;',
        '}',
      ].join('\n')
    );

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    const result = await indexer.indexFile('test-group', project, tsPath);
    expect(result).toBeGreaterThan(0);
    expect(mockQdrant.upsertedPoints.length).toBeGreaterThan(0);

    const points = mockQdrant.upsertedPoints.flatMap((u) => u.points) as {
      id: string;
      vector: number[];
      payload: { file: string; project: string; content: string };
    }[];
    expect(points[0]!.payload.file).toBe('src/foo.ts');
    expect(points[0]!.payload.project).toBe('test-project');
    expect(points[0]!.vector).toHaveLength(4);
    expect(points[0]!.payload.content).toBeDefined();
  });

  it('deleteFile removes chunks for file', async () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    const filePath = path.join(projectDir, 'src', 'deleted.ts');

    await indexer.deleteFile('test-group', project, filePath);

    expect(mockQdrant.client.delete).toHaveBeenCalledWith(toCollectionName('test-group'), {
      filter: {
        must: [
          { key: 'project', match: { value: 'test-project' } },
          { key: 'file', match: { value: 'src/deleted.ts' } },
        ],
      },
      wait: true,
    });
  });

  it('indexProject excludes files matching .gitignore when respectGitignore is true', async () => {
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(projectDir, 'secrets', 'key.ts'), 'const secret = "key";');
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'secrets/\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir, {
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
    });

    const count = await indexer.indexProject(project);
    expect(count).toBeGreaterThan(0);

    const files = mockQdrant.upsertedPoints.flatMap((u) =>
      (u.points as { payload?: { file?: string } }[]).map((p) => p.payload?.file ?? '')
    );
    expect(files.some((f) => f.includes('secrets'))).toBe(false);
    expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
  });

  it('indexProject includes gitignored files when respectGitignore is false', async () => {
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(projectDir, 'secrets', 'key.ts'), 'const secret = "key";');
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'secrets/\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir, {
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
    });

    const count = await indexer.indexProject(project);
    expect(count).toBeGreaterThan(0);

    const files = mockQdrant.upsertedPoints.flatMap((u) =>
      (u.points as { payload?: { file?: string } }[]).map((p) => p.payload?.file ?? '')
    );
    expect(files.some((f) => f.includes('secrets'))).toBe(true);
    expect(files.some((f) => f.includes('src/index.ts'))).toBe(true);
  });

  it('indexFile skips unchanged file on re-index', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const tsPath = path.join(srcDir, 'same.ts');
    fs.writeFileSync(tsPath, 'export const x = 1;\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);

    // First index: should create chunks
    const first = await indexer.indexFile('test-group', project, tsPath);
    expect(first).toBeGreaterThan(0);
    expect(indexer.stats.skipped).toBe(0);

    // Second index: same content, should skip
    const second = await indexer.indexFile('test-group', project, tsPath);
    expect(second).toBe(0);
    expect(indexer.stats.skipped).toBe(1);
  });

  it('indexFile re-indexes when file content changes', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const tsPath = path.join(srcDir, 'changing.ts');
    fs.writeFileSync(tsPath, 'export const x = 1;\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);

    // First index
    const first = await indexer.indexFile('test-group', project, tsPath);
    expect(first).toBeGreaterThan(0);

    // Change file content
    fs.writeFileSync(tsPath, 'export const x = 2;\nexport const y = 3;\n');

    // Second index: different content, should re-index
    const second = await indexer.indexFile('test-group', project, tsPath);
    expect(second).toBeGreaterThan(0);
    expect(indexer.stats.skipped).toBe(0);

    // Verify delete was called to remove old chunks before re-indexing
    expect(mockQdrant.client.delete).toHaveBeenCalled();
  });

  it('indexFile proceeds with full index when no existing chunks', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const tsPath = path.join(srcDir, 'new.ts');
    fs.writeFileSync(tsPath, 'export const fresh = true;\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);

    const result = await indexer.indexFile('test-group', project, tsPath);
    expect(result).toBeGreaterThan(0);
    expect(indexer.stats.skipped).toBe(0);
    // delete should NOT have been called since there were no existing chunks
    expect(mockQdrant.client.delete).not.toHaveBeenCalled();
  });

  it('indexFilesContent skips unchanged files', async () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    const files = [{ path: 'src/a.ts', content: 'export const a = 1;\n' }];

    // First index
    const first = await indexer.indexFilesContent(project, files);
    expect(first).toBeGreaterThan(0);
    expect(indexer.stats.skipped).toBe(0);

    // Second index: same content
    const second = await indexer.indexFilesContent(project, files);
    expect(second).toBe(0);
    expect(indexer.stats.skipped).toBe(1);
  });

  it('indexProject removes orphaned chunks for deleted files', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'keep.ts'), 'export const keep = true;\n');
    fs.writeFileSync(path.join(srcDir, 'remove.ts'), 'export const remove = true;\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir, {
      patterns: ['**/*.ts'],
      exclude: [],
    });

    // First index: both files
    const first = await indexer.indexProject(project);
    expect(first).toBeGreaterThan(0);

    const allFiles = mockQdrant.upsertedPoints.flatMap((u) =>
      (u.points as { payload?: { file?: string } }[]).map((p) => p.payload?.file ?? '')
    );
    expect(allFiles).toContain('src/keep.ts');
    expect(allFiles).toContain('src/remove.ts');

    // Delete one file from disk
    fs.unlinkSync(path.join(srcDir, 'remove.ts'));

    // Reset stats for clean count
    mockQdrant.client.delete.mockClear();

    // Second index: only keep.ts exists
    await indexer.indexProject(project);

    // Verify delete was called for the orphaned file
    const deleteCalls = mockQdrant.client.delete.mock.calls as Array<
      [string, { filter: { must: Array<{ key: string; match: { value: string } }> } }]
    >;
    const orphanDelete = deleteCalls.find((call) => {
      const must = call[1]?.filter?.must;
      return must?.some((m) => m.key === 'file' && m.match.value === 'src/remove.ts');
    });
    expect(orphanDelete).toBeDefined();

    // Verify keep.ts chunks still exist
    const collection = mockQdrant.collections.get(toCollectionName('test-group'))!;
    const remainingFiles = new Set<string>();
    for (const point of collection.values()) {
      const payload = (point as { payload?: { file?: string } }).payload;
      if (payload?.file) remainingFiles.add(payload.file);
    }
    expect(remainingFiles.has('src/keep.ts')).toBe(true);
    expect(remainingFiles.has('src/remove.ts')).toBe(false);
  });

  it('indexFilesContent does not remove other files (supports partial batches)', async () => {
    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);

    // First batch: two files
    const firstFiles = [
      { path: 'src/a.ts', content: 'export const a = true;\n' },
      { path: 'src/b.ts', content: 'export const b = true;\n' },
    ];
    await indexer.indexFilesContent(project, firstFiles);

    // Second batch: different file (simulating batched API calls)
    const secondFiles = [{ path: 'src/c.ts', content: 'export const c = true;\n' }];
    await indexer.indexFilesContent(project, secondFiles);

    // Verify all three files remain in Qdrant (no orphan cleanup)
    const collection = mockQdrant.collections.get(toCollectionName('test-group'))!;
    const remainingFiles = new Set<string>();
    for (const point of collection.values()) {
      const payload = (point as { payload?: { file?: string } }).payload;
      if (payload?.file) remainingFiles.add(payload.file);
    }
    expect(remainingFiles.has('src/a.ts')).toBe(true);
    expect(remainingFiles.has('src/b.ts')).toBe(true);
    expect(remainingFiles.has('src/c.ts')).toBe(true);
  });

  it('indexProject does not delete when no orphaned files exist', async () => {
    const srcDir = path.join(projectDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'stable.ts'), 'export const stable = true;\n');

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir, {
      patterns: ['**/*.ts'],
      exclude: [],
    });

    // First index
    await indexer.indexProject(project);

    // Reset delete mock
    mockQdrant.client.delete.mockClear();

    // Second index: same files
    await indexer.indexProject(project);

    // delete should not be called (no orphans, and file unchanged so skip logic applies)
    expect(mockQdrant.client.delete).not.toHaveBeenCalled();
  });

  it('listGroups returns groups with point counts', async () => {
    mockQdrant.collections.set(toCollectionName('g1'), new Map());
    mockQdrant.collections.set(toCollectionName('g2'), new Map());
    mockQdrant.client.getCollections.mockResolvedValue({
      collections: [{ name: toCollectionName('g1') }, { name: toCollectionName('g2') }],
    });
    mockQdrant.client.getCollection
      .mockResolvedValueOnce({ points_count: 10, status: 'green' })
      .mockResolvedValueOnce({ points_count: 20, status: 'green' });

    const indexer = new Indexer({
      qdrantUrl: 'http://localhost:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const groups = await indexer.listGroups();
    expect(groups).toEqual({ g1: 10, g2: 20 });
  });

  it('evicts project chunks from old group when re-indexing under a new group', async () => {
    // Stage: project "billing" used to live in group "old-group" (legacy
    // chunks with chunk_id starting `old-group//billing//...`). The user
    // moved it to "new-group" and re-runs the indexer. The first thing
    // indexProject must do is evict the stale chunks — otherwise search
    // returns chunk_ids whose symbol-graph edges live under the new key,
    // and find_usages silently returns 0 results.
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const x = 1;\n');

    const oldCollection = toCollectionName('old-group');
    const newCollection = toCollectionName('new-group');
    mockQdrant.collections.set(oldCollection, new Map());
    mockQdrant.collections.get(oldCollection)!.set('legacy-1', {
      id: 'legacy-1',
      payload: { project: 'billing', file: 'a.ts' },
    });
    // A chunk for an UNRELATED project sharing old-group must NOT be touched.
    mockQdrant.collections.get(oldCollection)!.set('keep-1', {
      id: 'keep-1',
      payload: { project: 'other-project', file: 'b.ts' },
    });

    const indexer = new Indexer({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir, { name: 'billing', group: 'new-group' });
    await indexer.indexProject(project);

    // Old group lost the billing chunk but kept the unrelated one.
    const oldPoints = mockQdrant.collections.get(oldCollection)!;
    expect(Array.from(oldPoints.keys())).toEqual(['keep-1']);
    // New group received the freshly-indexed chunk(s).
    const newPoints = mockQdrant.collections.get(newCollection)!;
    expect(newPoints.size).toBeGreaterThan(0);
    for (const point of newPoints.values()) {
      const payload = (point as { payload: { project: string } }).payload;
      expect(payload.project).toBe('billing');
    }
  });

  it('does not delete from the keep group during eviction (no self-eviction)', async () => {
    fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const x = 1;\n');
    // Pre-existing chunk in the SAME group must survive the eviction probe.
    const keepCollection = toCollectionName('test-group');
    mockQdrant.collections.set(keepCollection, new Map());
    mockQdrant.collections.get(keepCollection)!.set('preexisting', {
      id: 'preexisting',
      payload: { project: 'test-project', file: 'old.ts' },
    });

    const indexer = new Indexer({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      dimensions: 4,
      qdrantClient: mockQdrant.client as never,
    });

    const project = createProjectConfig(projectDir);
    await indexer.indexProject(project);

    const keepPoints = mockQdrant.collections.get(keepCollection)!;
    // The pre-existing chunk should still be there (the orphan-cleanup pass
    // will reap it because the file no longer exists, but eviction itself
    // must not fire on the keep group). Inspecting the delete calls confirms
    // no delete was issued targeting test-group with a project-only filter.
    const deleteCalls = mockQdrant.client.delete.mock.calls as Array<
      [string, { filter?: { must?: Array<{ key: string; match: { value: string } }> } }]
    >;
    const projectOnlyDeletesOnKeep = deleteCalls.filter(([colName, opts]) => {
      if (colName !== keepCollection) return false;
      const must = opts.filter?.must ?? [];
      const hasProject = must.some((m) => m.key === 'project');
      const hasFile = must.some((m) => m.key === 'file');
      return hasProject && !hasFile;
    });
    expect(projectOnlyDeletesOnKeep).toHaveLength(0);
    // And the orphan is still around (sanity: orphan-cleanup runs per-file,
    // so this point only goes if the file no longer exists in `currentRelPaths`)
    expect(keepPoints.has('preexisting')).toBe(false); // orphan-cleanup reaped it
  });
});
