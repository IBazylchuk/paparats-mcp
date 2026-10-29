import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Server } from 'http';
import { createApp, parseCorsOrigins, withTimeout } from '../src/app.js';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import type { CachedEmbeddingProvider } from '../src/embeddings.js';
import type { MetadataStore } from '../src/metadata-db.js';
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
    embeddings: { provider: 'llama', model: 'test', dimensions: 4 },
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
    getProjectScope: vi.fn().mockReturnValue(null),
  } as unknown as Searcher;
}

/** Mock indexer. `suffix` mimics PAPARATS_PROJECT_SUFFIX: storedProjectName
 * appends the literal suffix (empty = identity), matching applyProjectSuffix. */
function createMockIndexer(suffix = ''): Indexer {
  return {
    listGroups: vi.fn().mockResolvedValue({}),
    getGroupStats: vi.fn().mockResolvedValue({ points: 0, status: 'not_indexed' }),
    indexFilesContent: vi.fn().mockResolvedValue(0),
    updateFileContent: vi.fn().mockResolvedValue(0),
    deleteFileByPath: vi.fn().mockResolvedValue(undefined),
    deleteProjectChunks: vi.fn().mockResolvedValue(undefined),
    purgeProject: vi.fn().mockResolvedValue(undefined),
    getChunkById: vi.fn().mockResolvedValue(null),
    getAdjacentChunks: vi.fn().mockResolvedValue([]),
    storedProjectName: vi.fn((name: string) => (suffix ? `${name}${suffix}` : name)),
    reindexGroup: vi.fn().mockResolvedValue(0),
    stats: { files: 0, chunks: 0, cached: 0, errors: 0, skipped: 0 },
  } as unknown as Indexer;
}

function createMockMetadataStore(): MetadataStore {
  return {
    deleteByProject: vi.fn(),
  } as unknown as MetadataStore;
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
    mockEmbedding = createMockEmbeddingProvider();

    const { app } = createApp({
      searcher: mockSearcher,
      indexer: mockIndexer,
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

    function postIndex(body: Record<string, unknown>): Promise<Response> {
      return fetchApi('/api/index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'test-group',
          project: 'test-project',
          files: [{ path: 'src/foo.ts', content: 'const x = 1;' }],
          ...body,
        }),
      });
    }

    it.each([
      ['batchSize of 0', { batchSize: 0 }],
      ['batchSize above the ceiling', { batchSize: 100_000 }],
      ['non-numeric batchSize', { batchSize: '50' }],
      ['concurrency of 0', { concurrency: 0 }],
      ['fractional concurrency', { concurrency: 1.5 }],
      ['non-object config', 'fast'],
      ['non-array languages', { languages: 'typescript' }],
    ])('returns 400 for %s, even without chunkSize/overlap', async (_label, config) => {
      const res = await postIndex({ config });
      expect(res.status).toBe(400);
      expect(mockIndexer.indexFilesContent).not.toHaveBeenCalled();
      expect(projectsByGroup.has('test-group')).toBe(false);
    });

    it('returns 400 for a group name reserved for sidecar collections', async () => {
      const res = await postIndex({ group: 'billing_arch' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('reserved');
      expect(mockIndexer.indexFilesContent).not.toHaveBeenCalled();
    });

    it('invalidates the group query cache after indexing', async () => {
      const res = await postIndex({});
      expect(res.status).toBe(200);
      expect(mockSearcher.invalidateGroupCache).toHaveBeenCalledWith('test-group');
    });

    it('returns 500 without indexing when force cannot clear the old chunks', async () => {
      vi.mocked(mockIndexer.deleteProjectChunks).mockRejectedValueOnce(
        new Error('Qdrant unreachable')
      );
      const res = await postIndex({ force: true });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('Qdrant unreachable');
      expect(mockIndexer.indexFilesContent).not.toHaveBeenCalled();
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

  describe('file routes', () => {
    beforeEach(() => {
      projectsByGroup.set('test-group', [
        createProjectConfig({ path: tmpDir, name: 'test-project' }),
      ]);
    });

    it('file-changed and file-deleted invalidate the group query cache', async () => {
      for (const [route, extra] of [
        ['/api/file-changed', { content: 'const x = 1;' }],
        ['/api/file-deleted', {}],
      ] as const) {
        vi.mocked(mockSearcher.invalidateGroupCache).mockClear();
        const res = await fetchApi(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group: 'test-group',
            project: 'test-project',
            path: 'src/foo.ts',
            ...extra,
          }),
        });
        expect(res.status).toBe(200);
        expect(mockSearcher.invalidateGroupCache).toHaveBeenCalledWith('test-group');
      }
    });

    it('file-changed refuses a group name reserved for sidecar collections', async () => {
      const res = await fetchApi('/api/file-changed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: 'test-group_docs',
          project: 'test-project',
          path: 'src/foo.ts',
          content: 'x',
        }),
      });
      expect(res.status).toBe(400);
      expect(mockIndexer.updateFileContent).not.toHaveBeenCalled();
    });
  });

  describe('chunk routes under a project scope', () => {
    const IN_SCOPE = 'g1//billing-v3//src/invoice.ts//0-10//h1';
    const OUT_OF_SCOPE = 'g1//handbook-v3//src/page.ts//0-10//h2';

    async function getChunk(path: string): Promise<{ status: number; indexer: Indexer }> {
      const searcher = createMockSearcher();
      vi.mocked(searcher.getProjectScope).mockReturnValue(['billing']);
      const indexer = createMockIndexer('-v3');
      vi.mocked(indexer.getChunkById).mockResolvedValue({ chunk_id: IN_SCOPE, project: 'billing' });
      const metadataStore = {
        ...createMockMetadataStore(),
        getCommits: vi.fn().mockReturnValue([]),
        getTickets: vi.fn().mockReturnValue([]),
        getLatestCommit: vi.fn().mockReturnValue(null),
      } as unknown as MetadataStore;
      const { app } = createApp({
        searcher,
        indexer,
        embeddingProvider: createMockEmbeddingProvider(),
        projectsByGroup: new Map([['g1', [createProjectConfig()]]]),
        metadataStore,
      });
      const srv = app.listen(0);
      const p = (srv.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${p}${path}`);
        return { status: res.status, indexer };
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    }

    it('answers 404 for an out-of-scope chunk without looking it up', async () => {
      for (const suffix of ['', '/meta']) {
        const { status, indexer } = await getChunk(
          `/api/chunk/${encodeURIComponent(OUT_OF_SCOPE)}${suffix}`
        );
        expect(status).toBe(404);
        expect(indexer.getChunkById).not.toHaveBeenCalled();
      }
    });

    it('serves an in-scope chunk whose id carries the suffixed name', async () => {
      for (const suffix of ['', '/meta']) {
        const { status } = await getChunk(`/api/chunk/${encodeURIComponent(IN_SCOPE)}${suffix}`);
        expect(status).toBe(200);
      }
    });
  });

  describe('DELETE /api/project/:group/:name', () => {
    /** Build an app around the given mocks, call the delete route, return status + body. */
    async function runDelete(
      group: string,
      name: string,
      opts: { indexer?: Indexer; searcher?: Searcher; projects?: Map<string, ProjectConfig[]> } = {}
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const { app } = createApp({
        searcher: opts.searcher ?? createMockSearcher(),
        indexer: opts.indexer ?? createMockIndexer(),
        embeddingProvider: createMockEmbeddingProvider(),
        projectsByGroup: opts.projects ?? new Map(),
        metadataStore: createMockMetadataStore(),
      });
      const srv = app.listen(0);
      const p = (srv.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/project/${group}/${name}`, {
          method: 'DELETE',
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      } finally {
        await new Promise<void>((resolve, reject) => {
          srv.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }

    it('purges every layer with the clean name, clears the cache and unregisters', async () => {
      // purgeProject owns the stored-name mapping (metadata) and the docs removal.
      const indexer = createMockIndexer('-v3');
      const searcher = createMockSearcher();
      const projects = new Map([['g1', [createProjectConfig({ name: 'billing', group: 'g1' })]]]);

      const { status } = await runDelete('g1', 'billing', { indexer, searcher, projects });

      expect(status).toBe(200);
      expect(indexer.purgeProject).toHaveBeenCalledWith('g1', 'billing');
      expect(searcher.invalidateGroupCache).toHaveBeenCalledWith('g1');
      expect(projects.has('g1')).toBe(false);
    });

    it('returns 500 and keeps the registry entry when the purge fails', async () => {
      const indexer = createMockIndexer();
      vi.mocked(indexer.purgeProject).mockRejectedValueOnce(new Error('Qdrant unreachable'));
      const searcher = createMockSearcher();
      const projects = new Map([['g1', [createProjectConfig({ name: 'billing', group: 'g1' })]]]);

      const { status, body } = await runDelete('g1', 'billing', { indexer, searcher, projects });

      expect(status).toBe(500);
      expect(body.error).toBe('Qdrant unreachable');
      expect(projects.has('g1')).toBe(true);
      // A partial purge may have removed chunks already.
      expect(searcher.invalidateGroupCache).toHaveBeenCalledWith('g1');
    });

    it('refuses a project outside the server scope', async () => {
      const indexer = createMockIndexer();
      const searcher = createMockSearcher();
      vi.mocked(searcher.getProjectScope).mockReturnValue(['billing']);

      const { status } = await runDelete('g1', 'handbook', { indexer, searcher });

      expect(status).toBe(403);
      expect(indexer.purgeProject).not.toHaveBeenCalled();
    });

    it('refuses a group name reserved for sidecar collections', async () => {
      const indexer = createMockIndexer();
      const { status, body } = await runDelete('billing_arch', 'billing', { indexer });
      expect(status).toBe(400);
      expect(String(body.error)).toContain('reserved');
      expect(indexer.purgeProject).not.toHaveBeenCalled();
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
    it('returns 200 with groups, cache, usage', async () => {
      const res = await fetchApi('/api/stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.groups).toBeDefined();
      expect(body.registeredProjects).toBeDefined();
      expect(body.cache).toBeDefined();
      expect(body.watcher).toBeUndefined();
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

// ── Cross-origin protection ─────────────────────────────────────────────────

describe('cross-origin requests', () => {
  const envBefore = process.env['PAPARATS_CORS_ORIGINS'];

  afterEach(() => {
    if (envBefore === undefined) delete process.env['PAPARATS_CORS_ORIGINS'];
    else process.env['PAPARATS_CORS_ORIGINS'] = envBefore;
  });

  /** Start an app (reading PAPARATS_CORS_ORIGINS as set), run `fn`, close it. */
  async function withApp(fn: (base: string, searcher: Searcher) => Promise<void>): Promise<void> {
    const searcher = createMockSearcher();
    const { app, mcpHandler } = createApp({
      searcher,
      indexer: createMockIndexer(),
      embeddingProvider: createMockEmbeddingProvider(),
      projectsByGroup: new Map(),
    });
    const srv = app.listen(0);
    const p = (srv.address() as { port: number }).port;
    try {
      await fn(`http://127.0.0.1:${p}`, searcher);
    } finally {
      mcpHandler.destroy();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  function search(base: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ group: 'g', query: 'foo' }),
    });
  }

  it('serves requests without an Origin header and sends no CORS headers', async () => {
    await withApp(async (base) => {
      const res = await search(base);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('refuses a request from another site on the API and the MCP endpoints', async () => {
    await withApp(async (base, searcher) => {
      const origin = { Origin: 'https://attacker.example.com' };
      const res = await search(base, origin);
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(searcher.search).not.toHaveBeenCalled();

      for (const path of ['/mcp', '/support/mcp', '/health', '/api/analytics']) {
        const r = await fetch(`${base}${path}`, { headers: origin });
        expect(r.status, path).toBe(403);
      }
    });
  });

  it('refuses an opaque (null) origin', async () => {
    await withApp(async (base) => {
      const res = await search(base, { Origin: 'null' });
      expect(res.status).toBe(403);
    });
  });

  it('lets a same-origin page (the dashboard) through', async () => {
    await withApp(async (base) => {
      const res = await search(base, { Origin: base });
      expect(res.status).toBe(200);
    });
  });

  it('allows and answers CORS for origins listed in PAPARATS_CORS_ORIGINS', async () => {
    process.env['PAPARATS_CORS_ORIGINS'] = 'https://app.example.com/, https://tools.example.com';
    await withApp(async (base) => {
      const res = await search(base, { Origin: 'https://app.example.com' });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');

      const preflight = await fetch(`${base}/mcp`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://tools.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,mcp-session-id',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        'https://tools.example.com'
      );

      const other = await search(base, { Origin: 'https://attacker.example.com' });
      expect(other.status).toBe(403);
    });
  });
});

describe('parseCorsOrigins', () => {
  it('returns an empty list when unset or blank', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins(' , ')).toEqual([]);
  });

  it('normalises entries to the origin a browser sends', () => {
    expect(parseCorsOrigins('https://App.Example.com/, http://localhost:3000')).toEqual([
      'https://app.example.com',
      'http://localhost:3000',
    ]);
  });

  it.each(['*', 'app.example.com', 'https://app.example.com/path', 'ftp://example.com'])(
    'rejects %s',
    (entry) => {
      expect(() => parseCorsOrigins(entry)).toThrow(/PAPARATS_CORS_ORIGINS/);
    }
  );
});

// ── Dashboard basic auth ────────────────────────────────────────────────────

describe('PAPARATS_UI_BASIC_AUTH', () => {
  const envBefore = process.env['PAPARATS_UI_BASIC_AUTH'];

  afterEach(() => {
    if (envBefore === undefined) delete process.env['PAPARATS_UI_BASIC_AUTH'];
    else process.env['PAPARATS_UI_BASIC_AUTH'] = envBefore;
  });

  function build(): ReturnType<typeof createApp> {
    return createApp({
      searcher: createMockSearcher(),
      indexer: createMockIndexer(),
      embeddingProvider: createMockEmbeddingProvider(),
      projectsByGroup: new Map(),
    });
  }

  it.each(['adminsecret', ':secret', 'admin:'])(
    'refuses to start with a malformed value (%s) rather than leave the dashboard open',
    (value) => {
      process.env['PAPARATS_UI_BASIC_AUTH'] = value;
      expect(() => build()).toThrow(/PAPARATS_UI_BASIC_AUTH/);
    }
  );

  it('treats an empty value as unset', () => {
    process.env['PAPARATS_UI_BASIC_AUTH'] = '';
    let created: ReturnType<typeof createApp> | undefined;
    expect(() => {
      created = build();
    }).not.toThrow();
    created?.mcpHandler.destroy();
    created?.stopGroupPoll();
  });

  it('protects the dashboard when well-formed', async () => {
    process.env['PAPARATS_UI_BASIC_AUTH'] = 'admin:s3cret:with-colon';
    const { app, mcpHandler } = build();
    const srv = app.listen(0);
    const p = (srv.address() as { port: number }).port;
    try {
      const denied = await fetch(`http://127.0.0.1:${p}/api/analytics`);
      expect(denied.status).toBe(401);
      const mapDenied = await fetch(`http://127.0.0.1:${p}/api/module-map`);
      expect(mapDenied.status).toBe(401);
      const auth = 'Basic ' + Buffer.from('admin:s3cret:with-colon').toString('base64');
      const allowed = await fetch(`http://127.0.0.1:${p}/ui/`, {
        headers: { Authorization: auth },
      });
      expect(allowed.status).not.toBe(401);
    } finally {
      mcpHandler.destroy();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

// ── Optional API key ────────────────────────────────────────────────────────

describe('PAPARATS_API_KEY', () => {
  const KEY = 'k'.repeat(20);
  const vars = ['PAPARATS_API_KEY', 'PAPARATS_UI_BASIC_AUTH'] as const;
  const before = Object.fromEntries(vars.map((v) => [v, process.env[v]]));

  afterEach(() => {
    for (const v of vars) {
      if (before[v] === undefined) delete process.env[v];
      else process.env[v] = before[v];
    }
  });

  async function withServer(run: (base: string) => Promise<void>): Promise<void> {
    const { app, mcpHandler, stopGroupPoll } = createApp({
      searcher: createMockSearcher(),
      indexer: createMockIndexer(),
      embeddingProvider: createMockEmbeddingProvider(),
      projectsByGroup: new Map(),
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      mcpHandler.destroy();
      stopGroupPoll();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
  const search = (base: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query: 'x' }),
    });

  it('leaves every route open when unset', async () => {
    delete process.env['PAPARATS_API_KEY'];
    await withServer(async (base) => {
      expect((await search(base)).status).not.toBe(401);
      expect((await fetch(`${base}/api/module-map`)).status).not.toBe(401);
      const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
      expect(health).toHaveProperty('groups');
    });
  });

  it('refuses to start with a key it cannot use', () => {
    process.env['PAPARATS_API_KEY'] = 'changeme';
    expect(() =>
      createApp({
        searcher: createMockSearcher(),
        indexer: createMockIndexer(),
        embeddingProvider: createMockEmbeddingProvider(),
        projectsByGroup: new Map(),
      })
    ).toThrow(/PAPARATS_API_KEY: key #1/);
  });

  it('asks for the key on the API and MCP routes, and accepts any listed key', async () => {
    process.env['PAPARATS_API_KEY'] = `${'a'.repeat(16)}, ${KEY}`;
    await withServer(async (base) => {
      const denied = await search(base);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toBe('Bearer realm="paparats"');
      const wrong = await search(base, bearer('w'.repeat(20)));
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('www-authenticate')).toContain('invalid_token');
      expect((await search(base, bearer(KEY))).status).not.toBe(401);
      expect((await search(base, bearer('a'.repeat(16)))).status).not.toBe(401);

      const mcp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(mcp.status).toBe(401);
      expect((await fetch(`${base}/api/stats`)).status).toBe(401);
    });
  });

  it('keeps /health open but shows the projects only to a caller with the key', async () => {
    process.env['PAPARATS_API_KEY'] = KEY;
    await withServer(async (base) => {
      const open = await fetch(`${base}/health`);
      expect(open.status).toBe(200);
      expect(await open.json()).toEqual({ status: 'ok' });
      const full = (await (
        await fetch(`${base}/health`, { headers: bearer(KEY) })
      ).json()) as Record<string, unknown>;
      expect(full).toHaveProperty('groups');
    });
  });

  it('lets a browser open the pages with the key as a basic-auth password', async () => {
    process.env['PAPARATS_API_KEY'] = KEY;
    delete process.env['PAPARATS_UI_BASIC_AUTH'];
    await withServer(async (base) => {
      const page = await fetch(`${base}/ui/`, { headers: { Accept: 'text/html' } });
      expect(page.status).toBe(401);
      expect(page.headers.get('www-authenticate')).toBe('Basic realm="paparats"');
      const basic = 'Basic ' + Buffer.from(`anyone:${KEY}`).toString('base64');
      expect((await fetch(`${base}/ui/`, { headers: { Authorization: basic } })).status).not.toBe(
        401
      );
      expect((await fetch(`${base}/api/module-map`, { headers: bearer(KEY) })).status).not.toBe(
        401
      );
    });
  });

  it('leaves the pages to PAPARATS_UI_BASIC_AUTH when that is set', async () => {
    process.env['PAPARATS_API_KEY'] = KEY;
    process.env['PAPARATS_UI_BASIC_AUTH'] = 'admin:s3cret';
    await withServer(async (base) => {
      const basic = 'Basic ' + Buffer.from('admin:s3cret').toString('base64');
      expect((await fetch(`${base}/ui/`, { headers: { Authorization: basic } })).status).not.toBe(
        401
      );
      expect((await fetch(`${base}/api/analytics`)).status).toBe(401);
      expect((await search(base, { Authorization: basic })).status).toBe(401);
    });
  });
});
