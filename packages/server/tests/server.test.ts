import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Server } from 'http';
import { createApp, withTimeout } from '../src/app.js';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import type { WatcherManager } from '../src/watcher.js';
import type { CachedEmbeddingProvider } from '../src/embeddings.js';
import type { ProjectConfig } from '../src/types.js';
// ── Test helpers ───────────────────────────────────────────────────────────

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function createProjectConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: 'test-project',
    path: '/tmp/test',
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
    watcher: { enabled: false, debounce: 1000, stabilityThreshold: 1000 },
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

function createMockSearcher(): Searcher {
  return {
    search: vi.fn().mockResolvedValue({
      results: [],
      total: 0,
      metrics: {
        tokensReturned: 0,
        estimatedFullFileTokens: 0,
        tokensSaved: 0,
        savingsPercent: 0,
      },
    }),
    formatResults: vi.fn().mockReturnValue('No results found.'),
    getUsageStats: vi.fn().mockReturnValue({
      searchCount: 0,
      totalTokensSaved: 0,
      avgTokensSavedPerSearch: 0,
    }),
    getQueryCacheStats: vi.fn().mockReturnValue(null),
    invalidateGroupCache: vi.fn(),
  } as unknown as Searcher;
}

function createMockIndexer(): Indexer {
  return {
    listGroups: vi.fn().mockResolvedValue({}),
    getGroupStats: vi.fn().mockResolvedValue({ points: 0, status: 'not_indexed' }),
    indexFilesContent: vi.fn().mockResolvedValue(0),
    updateFileContent: vi.fn().mockResolvedValue(0),
    deleteFileByPath: vi.fn().mockResolvedValue(undefined),
    deleteProjectChunks: vi.fn().mockResolvedValue(undefined),
    reindexGroup: vi.fn().mockResolvedValue(0),
    stats: { files: 0, chunks: 0, cached: 0, errors: 0, skipped: 0 },
  } as unknown as Indexer;
}

function createMockWatcherManager(): WatcherManager {
  return {
    watch: vi.fn(),
    unwatch: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({}),
    get size() {
      return 0;
    },
  } as unknown as WatcherManager;
}

function createMockEmbeddingProvider(): CachedEmbeddingProvider {
  return {
    getCacheStats: vi.fn().mockReturnValue({
      size: 0,
      hitCount: 0,
      maxSize: 100000,
      hitRate: 0,
      embedCalls: 0,
    }),
    close: vi.fn(),
    model: 'test',
    dimensions: 4,
    embed: vi.fn(),
    embedBatch: vi.fn(),
  } as unknown as CachedEmbeddingProvider;
}

// ── withTimeout unit tests ──────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves when promise resolves before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'timeout');
    expect(result).toBe(42);
  });

  it('rejects with error message when timeout exceeds', async () => {
    const slowPromise = new Promise<number>((resolve) => setTimeout(() => resolve(1), 500));
    await expect(withTimeout(slowPromise, 50, 'Custom timeout')).rejects.toThrow('Custom timeout');
  });

  it('rejects when promise rejects', async () => {
    await expect(withTimeout(Promise.reject(new Error('Boom')), 1000, 'timeout')).rejects.toThrow(
      'Boom'
    );
  });
});

// ── HTTP API tests ──────────────────────────────────────────────────────────

describe('Server API', () => {
  let server: Server;
  let port: number;
  let mockSearcher: Searcher;
  let mockIndexer: Indexer;
  let mockWatcher: WatcherManager;
  let mockEmbedding: CachedEmbeddingProvider;
  let projectsByGroup: Map<string, ProjectConfig[]>;
  let tmpDir: string;

  async function fetchApi(path: string, options?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, options);
  }

  beforeEach(() => {
    tmpDir = createTempDir();
    projectsByGroup = new Map();
    mockSearcher = createMockSearcher();
    mockIndexer = createMockIndexer();
    mockWatcher = createMockWatcherManager();
    mockEmbedding = createMockEmbeddingProvider();

    const { app } = createApp({
      searcher: mockSearcher,
      indexer: mockIndexer,
      watcherManager: mockWatcher,
      embeddingProvider: mockEmbedding,
      projectsByGroup,
    });

    server = app.listen(0);
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('POST /api/search', () => {
    it('returns 400 when query is missing', async () => {
      const res = await fetchApi('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'g' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('query is required');
    });

    it('returns 400 when group is missing', async () => {
      const res = await fetchApi('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'foo' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('group is required');
    });

    it('returns 200 with search results when valid', async () => {
      const res = await fetchApi('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'g', query: 'foo' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
      expect(mockSearcher.search).toHaveBeenCalledWith('g', 'foo', {
        project: undefined,
        limit: undefined,
      });
    });

    it('returns 500 when search throws', async () => {
      vi.mocked(mockSearcher.search).mockRejectedValueOnce(new Error('Qdrant connection refused'));
      const res = await fetchApi('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'g', query: 'foo' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Qdrant connection refused');
    });
  });

  describe('POST /api/index', () => {
    it('returns 400 when group, project, or files is missing', async () => {
      const res = await fetchApi('/api/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('group, project, and files (array) are required');
    });

    it('returns 200 and indexes when valid content', async () => {
      const res = await fetchApi('/api/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'test-group',
          project: 'test-project',
          files: [{ path: 'src/foo.ts', content: 'const x = 1;', language: 'typescript' }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.group).toBe('test-group');
      expect(body.project).toBe('test-project');
      expect(body.chunks).toBeDefined();
      expect(projectsByGroup.has('test-group')).toBe(true);
      expect(mockIndexer.indexFilesContent).toHaveBeenCalled();
    });
  });

  describe('POST /api/file-changed', () => {
    it('returns 400 when group, project, path, or content is missing', async () => {
      const res = await fetchApi('/api/file-changed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'g' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('group, project, path, and content are required');
    });

    it('returns 400 when project is unknown', async () => {
      const res = await fetchApi('/api/file-changed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'g',
          project: 'unknown',
          path: 'src/foo.ts',
          content: 'const x = 1;',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Unknown project');
    });

    it('returns 200 when project is registered', async () => {
      projectsByGroup.set('test-group', [
        createProjectConfig({ path: tmpDir, name: 'test-project' }),
      ]);

      const res = await fetchApi('/api/file-changed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'test-group',
          project: 'test-project',
          path: 'src/foo.ts',
          content: 'const x = 1;',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.message).toBe('File reindexed');
      expect(mockIndexer.updateFileContent).toHaveBeenCalledWith(
        'test-group',
        'test-project',
        'src/foo.ts',
        'const x = 1;',
        expect.any(String),
        expect.any(Object)
      );
    });
  });

  describe('POST /api/file-deleted', () => {
    it('returns 400 when group, project, or path is missing', async () => {
      const res = await fetchApi('/api/file-deleted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: 'g' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('group, project, and path are required');
    });

    it('returns 400 when project is unknown', async () => {
      const res = await fetchApi('/api/file-deleted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'g',
          project: 'unknown',
          path: 'src/foo.ts',
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Unknown project');
    });

    it('returns 200 when project is registered', async () => {
      projectsByGroup.set('test-group', [
        createProjectConfig({ path: tmpDir, name: 'test-project' }),
      ]);

      const res = await fetchApi('/api/file-deleted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'test-group',
          project: 'test-project',
          path: 'src/foo.ts',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.message).toBe('File removed from index');
      expect(mockIndexer.deleteFileByPath).toHaveBeenCalledWith(
        'test-group',
        'test-project',
        'src/foo.ts'
      );
    });
  });

  describe('GET /health', () => {
    it('returns 200 with status, groups, uptime, memory', async () => {
      const res = await fetchApi('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.groups).toBeDefined();
      expect(typeof body.uptime).toBe('number');
      expect(body.memory).toBeDefined();
      expect(body.memory.heapUsed).toMatch(/\d+MB/);
      expect(body.memory.heapTotal).toMatch(/\d+MB/);
      expect(typeof body.memory.percent).toBe('number');
    });

    it('returns 503 when indexer.listGroups throws', async () => {
      vi.mocked(mockIndexer.listGroups).mockRejectedValueOnce(new Error('Qdrant down'));
      const res = await fetchApi('/health');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('error');
      expect(body.error).toBe('Qdrant down');
    });
  });

  describe('GET /api/stats', () => {
    it('returns 200 with groups, cache, watcher, usage', async () => {
      const res = await fetchApi('/api/stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.groups).toBeDefined();
      expect(body.registeredProjects).toBeDefined();
      expect(body.cache).toBeDefined();
      expect(body.watcher).toBeDefined();
      expect(body.usage).toBeDefined();
      expect(body.memory).toBeDefined();
    });
  });

  describe('Shutdown state', () => {
    it('returns 503 when shuttingDown is true', async () => {
      const projects2 = new Map<string, ProjectConfig[]>();
      const { app: app2, setShuttingDown: setShuttingDown2 } = createApp({
        searcher: createMockSearcher(),
        indexer: createMockIndexer(),
        watcherManager: createMockWatcherManager(),
        embeddingProvider: createMockEmbeddingProvider(),
        projectsByGroup: projects2,
      });
      const srv2 = app2.listen(0);
      const port2 = (srv2.address() as { port: number }).port;

      setShuttingDown2(true);

      const res = await fetch(`http://127.0.0.1:${port2}/health`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('Server is shutting down');

      await new Promise<void>((resolve, reject) => {
        srv2.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });
});
