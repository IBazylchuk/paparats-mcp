import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { v7 as uuidv7 } from 'uuid';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import {
  McpHandler,
  cleanChunkId,
  resolveSince,
  EXPLAIN_FEATURE_EDGES_PER_SEED,
  type McpHandlerConfig,
  describeExcerpt,
  describeGlossary,
  describeStaleness,
  GLOSSARY_MIN_SCORE,
  TERM_LOOKUP_MIN_SCORE,
} from '../src/mcp-handler.js';
import type { MetadataStore } from '../src/metadata-db.js';
import type { ProjectConfig, ChunkKind, SymbolEdge } from '../src/types.js';

/** Parse SSE or JSON response from MCP Streamable HTTP */
async function parseMcpResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.startsWith('{')) {
    return JSON.parse(text);
  }
  const lines = text.split('\n');
  const dataLine = lines.find((l) => l.startsWith('data: '));
  if (dataLine) {
    return JSON.parse(dataLine.slice(6));
  }
  throw new Error(`Cannot parse MCP response: ${text.slice(0, 200)}`);
}

function createMockSearcher(): Searcher {
  const emptyResponse = {
    results: [],
    total: 0,
    metrics: {
      tokensReturned: 0,
      estimatedFullFileTokens: 0,
      tokensSaved: 0,
      savingsPercent: 0,
    },
  };
  const searchMock = vi.fn().mockResolvedValue(emptyResponse);
  return {
    search: searchMock,
    expandedSearch: vi.fn().mockResolvedValue(emptyResponse),
    searchWithFilter: vi.fn().mockResolvedValue(emptyResponse),
    formatResults: vi.fn().mockReturnValue('No results found.'),
    getUsageStats: vi.fn().mockReturnValue({
      searchCount: 0,
      totalTokensSaved: 0,
      avgTokensSavedPerSearch: 0,
    }),
    getProjectScope: vi.fn().mockReturnValue(null),
    invalidateGroupCache: vi.fn(),
  } as unknown as Searcher;
}

/** Mock indexer. `suffix` mimics PAPARATS_PROJECT_SUFFIX: storedProjectName
 * appends the literal suffix (empty = identity), matching applyProjectSuffix. */
function createMockIndexer(suffix = ''): Indexer {
  return {
    listGroups: vi.fn().mockResolvedValue({}),
    getGroupStats: vi.fn().mockResolvedValue({ points: 0, status: 'not_indexed' }),
    deleteProjectChunks: vi.fn().mockResolvedValue(undefined),
    purgeProject: vi.fn().mockResolvedValue(undefined),
    getChunkById: vi.fn().mockResolvedValue(null),
    getAdjacentChunks: vi.fn().mockResolvedValue([]),
    listProjectsInGroup: vi.fn().mockResolvedValue([]),
    storedProjectName: vi.fn((name: string) => (suffix ? `${name}${suffix}` : name)),
    displayProjectName: vi.fn((stored: string) =>
      suffix && stored.endsWith(suffix) ? stored.slice(0, -suffix.length) : stored
    ),
  } as unknown as Indexer;
}

function createMockMetadataStore(): MetadataStore {
  return {
    getCommits: vi.fn().mockReturnValue([]),
    getTickets: vi.fn().mockReturnValue([]),
    getEdgesTo: vi.fn().mockReturnValue([]),
    getEdgesFrom: vi.fn().mockReturnValue([]),
    getGroupDegreeSnapshot: vi
      .fn()
      .mockReturnValue({ hubChunkIds: new Set(), calledHubChunkIds: new Set() }),
    getNameUsage: vi.fn().mockReturnValue({ callerFiles: 0, filesUsing: new Map() }),
    getEdgesFromFile: vi.fn().mockReturnValue([]),
    getTestFiles: vi.fn().mockReturnValue(null),
    edgesVersion: vi.fn().mockReturnValue('0:0'),
    edgeProjects: vi.fn().mockReturnValue([]),
    iterateProjectEdges: vi.fn().mockReturnValue([]),
    deleteByProject: vi.fn(),
  } as unknown as MetadataStore;
}

/** Serve `edges` through the store calls the module map reads. */
function mockEdges(store: MetadataStore, edges: () => SymbolEdge[]): void {
  vi.mocked(store.edgeProjects).mockImplementation(() => [
    ...new Set(edges().map((e) => e.from_chunk_id.split('//')[1]!)),
  ]);
  vi.mocked(store.iterateProjectEdges).mockImplementation((group, project) =>
    edges().filter((e) => e.from_chunk_id.startsWith(`${group}//${project}//`))
  );
}

/** Standard search result for orchestration tool tests */
function makeSearchResult(overrides?: Partial<Record<string, unknown>>) {
  return {
    project: 'p1',
    file: 'src/auth.ts',
    language: 'typescript',
    startLine: 10,
    endLine: 20,
    content: 'function authenticate() {}',
    score: 0.85,
    hash: 'h1',
    chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
    symbol_name: 'authenticate',
    kind: 'function' as ChunkKind,
    service: 'auth-service',
    bounded_context: 'auth',
    tags: [],
    last_commit_at: '2024-06-15T10:00:00Z',
    defines_symbols: ['authenticate'],
    uses_symbols: ['validateToken'],
    ...overrides,
  };
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

describe('McpHandler', () => {
  let handler: McpHandler;
  let mockSearcher: Searcher;
  let mockIndexer: Indexer;
  let getProjects: () => Map<string, ProjectConfig[]>;
  let getGroupNames: () => string[];

  beforeEach(() => {
    mockSearcher = createMockSearcher();
    mockIndexer = createMockIndexer();
    const projects = new Map<string, ProjectConfig[]>();
    projects.set('test-group', [createProjectConfig()]);
    getProjects = () => projects;
    getGroupNames = () => Array.from(projects.keys());

    handler = new McpHandler({
      searcher: mockSearcher,
      indexer: mockIndexer,
      getProjects,
      getGroupNames,
    });
  });

  afterEach(() => {
    handler.destroy();
  });

  it('creates McpHandler with config', () => {
    expect(handler).toBeDefined();
  });

  it('mount adds routes to Express app', () => {
    const app = express();
    app.use(express.json());

    const getSpy = vi.spyOn(app, 'get');
    const postSpy = vi.spyOn(app, 'post');
    const allSpy = vi.spyOn(app, 'all');

    handler.mount(app);

    // Coding routes
    expect(getSpy).toHaveBeenCalledWith('/sse', expect.any(Function));
    expect(postSpy).toHaveBeenCalledWith('/messages', expect.any(Function));
    expect(allSpy).toHaveBeenCalledWith('/mcp', expect.any(Function));

    // Support routes
    expect(getSpy).toHaveBeenCalledWith('/support/sse', expect.any(Function));
    expect(postSpy).toHaveBeenCalledWith('/support/messages', expect.any(Function));
    expect(allSpy).toHaveBeenCalledWith('/support/mcp', expect.any(Function));

    getSpy.mockRestore();
    postSpy.mockRestore();
    allSpy.mockRestore();
  });

  it('connectStdio serves the coding tool set over a single transport', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = await handler.connectStdio('coding', serverTransport);
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('search_code');
      expect(names).toContain('find_usages');
      expect(names).not.toContain('impact_analysis');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('destroy clears cleanup interval', () => {
    expect(() => handler.destroy()).not.toThrow();
    expect(() => handler.destroy()).not.toThrow();
  });

  it('POST /mcp without session returns 400 for non-initialize request', async () => {
    const app = express();
    app.use(express.json());
    handler.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'not_initialize',
          params: {},
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toContain('Bad Request');
    } finally {
      server.close();
    }
  });

  it('POST /mcp with initialize creates session and returns 200', async () => {
    const app = express();
    app.use(express.json());
    handler.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });

      expect(res.status).toBe(200);
      const sessionId = res.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const body = (await parseMcpResponse(res)) as { result?: { serverInfo?: { name?: string } } };
      expect(body.result).toBeDefined();
      expect(body.result?.serverInfo?.name).toBe('paparats-mcp');
    } finally {
      server.close();
    }
  });

  it('POST /mcp with unknown session ID transparently recreates session', async () => {
    const app = express();
    app.use(express.json());
    handler.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          // Well-formed (UUID) id the server no longer knows, e.g. after a restart.
          'mcp-session-id': uuidv7(),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'health_check', arguments: {} },
        }),
      });

      // Session is transparently recreated — the tool call should succeed
      expect(res.status).toBe(200);
      const body = (await parseMcpResponse(res)) as { result?: { content?: unknown[] } };
      expect(body.result).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('session stays alive when actively used within timeout', async () => {
    const app = express();
    app.use(express.json());
    handler.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      // Initialize session
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });

      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Make a follow-up request — session should still work
      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'health_check', arguments: {} },
        }),
      });

      expect(callRes.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('POST /mcp tools/call search_code returns results', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.search).mockResolvedValue({
      results: [
        {
          project: 'p1',
          file: 'src/foo.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 15,
          content: 'const x = 1;',
          score: 0.95,
          hash: 'h1',
          chunk_id: 'test-group//p1//src/foo.ts//10-15//h1',
          symbol_name: null,
          kind: null,
          service: null,
          bounded_context: null,
          tags: [],
          last_commit_at: null,
          defines_symbols: [],
          uses_symbols: [],
        },
      ],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 2000,
        tokensSaved: 1990,
        savingsPercent: 99,
      },
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });

      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_code',
            arguments: { query: 'authentication', limit: 5 },
          },
        }),
      });

      expect(callRes.status).toBe(200);
      const callBody = (await parseMcpResponse(callRes)) as {
        result?: { content?: { text?: string }[] };
      };
      expect(callBody.result).toBeDefined();
      expect(callBody.result.content).toBeDefined();
      expect(callBody.result.content[0]?.text).toContain('src/foo.ts');
      expect(callBody.result.content[0]?.text).toContain('const x = 1;');

      expect(searcher.search).toHaveBeenCalledWith('g1', 'authentication', {
        project: 'all',
        limit: 10,
        // Labels the search event so search_code is distinguishable from the
        // other tools that reach the searcher.
        tool: 'search_code',
      });
      // search_code runs the query once; query expansion stays with the support tools.
      expect(searcher.expandedSearch).not.toHaveBeenCalled();
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('POST /mcp tools/call health_check returns groups', async () => {
    const indexer = createMockIndexer();
    vi.mocked(indexer.listGroups).mockResolvedValue({ g1: 10, g2: 20 });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher: createMockSearcher(),
      indexer,
      getProjects: () => new Map(),
      getGroupNames: () => [],
      indexerHealth: async () => ({
        reachable: true,
        url: 'http://paparats-indexer:9877',
        globalStatus: 'idle',
        lastRunAt: '2026-10-29T08:00:00.000Z',
        repos: [
          {
            repo: 'org/app',
            status: 'success',
            lastRun: '2026-10-29T08:00:00.000Z',
            chunksIndexed: 42,
          },
          { repo: 'org/lib', status: 'error', lastError: '1 file(s) failed to index' },
        ],
      }),
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });

      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'health_check', arguments: {} },
        }),
      });

      expect(callRes.status).toBe(200);
      const callBody = (await parseMcpResponse(callRes)) as {
        result?: { content?: { text?: string }[] };
      };
      const text = callBody.result?.content?.[0]?.text;
      expect(text).toBeDefined();
      const parsed = JSON.parse(text!);
      expect(parsed.status).toBe('ok');
      expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(parsed.groups).toEqual({ g1: 10, g2: 20 });
      expect(parsed.indexer).toEqual({
        reachable: true,
        status: 'idle',
        lastRunAt: '2026-10-29T08:00:00.000Z',
        repos: [
          { repo: 'org/app', status: 'success', lastRun: '2026-10-29T08:00:00.000Z', chunks: 42 },
          { repo: 'org/lib', status: 'error', error: '1 file(s) failed to index' },
        ],
      });
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('health_check names an unreachable Qdrant instead of a bare "fetch failed"', async () => {
    const indexer = createMockIndexer();
    vi.mocked(indexer.listGroups).mockRejectedValue(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6333'), {
          code: 'ECONNREFUSED',
        }),
      })
    );

    const app = express();
    app.use(express.json());
    const handler2 = new McpHandler({
      searcher: createMockSearcher(),
      indexer,
      getProjects: () => new Map(),
      getGroupNames: () => [],
    });
    handler2.mount(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, isError } = await callTool(port, 'health_check', {});
      expect(isError).toBe(true);
      const parsed = JSON.parse(text);
      expect(parsed.status).toBe('error');
      expect(parsed.error).toContain('Cannot reach Qdrant (ECONNREFUSED)');
      expect(parsed.error).toContain('QDRANT_URL');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('POST /mcp tools/call delete_project removes chunks and registry entry', async () => {
    const indexer = createMockIndexer();
    const projectsMap = new Map([['g1', [createProjectConfig()]]]);
    const removeProject = vi.fn((group: string, name: string) => {
      const projects = projectsMap.get(group);
      if (projects) {
        const filtered = projects.filter((p) => p.name !== name);
        if (filtered.length > 0) projectsMap.set(group, filtered);
        else projectsMap.delete(group);
      }
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher: createMockSearcher(),
      indexer,
      getProjects: () => projectsMap,
      getGroupNames: () => Array.from(projectsMap.keys()),
      removeProject,
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });

      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'delete_project', arguments: { group: 'g1', project: 'test-project' } },
        }),
      });

      expect(callRes.status).toBe(200);
      const callBody = (await parseMcpResponse(callRes)) as {
        result?: { content?: { text?: string }[] };
      };
      const text = callBody.result?.content?.[0]?.text;
      expect(text).toContain('Deleted project');
      expect(text).toContain('test-project');
      expect(indexer.purgeProject).toHaveBeenCalledWith('g1', 'test-project');
      expect(removeProject).toHaveBeenCalledWith('g1', 'test-project');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  // ── delete_project ──────────────────────────────────────────────────────

  /** Spin up a handler + server, call delete_project, return the tool result. */
  async function runDeleteProject(
    indexer: Indexer,
    args: { group: string; project: string },
    searcher: Searcher = createMockSearcher()
  ): Promise<{ text: string; isError: boolean }> {
    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer,
      getProjects: () => new Map([[args.group, [createProjectConfig()]]]),
      getGroupNames: () => [args.group],
      metadataStore: createMockMetadataStore(),
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, isError } = await callTool(port, 'delete_project', args);
      return { text, isError };
    } finally {
      server.close();
      handler2.destroy();
    }
  }

  it('delete_project purges every layer through indexer.purgeProject with the clean name', async () => {
    // purgeProject owns the stored-name mapping for metadata and the docs
    // removal; the tool hands it the name the user typed.
    const indexer = createMockIndexer('-v3');
    const { text, isError } = await runDeleteProject(indexer, { group: 'g1', project: 'billing' });

    expect(isError).toBe(false);
    expect(indexer.purgeProject).toHaveBeenCalledWith('g1', 'billing');
    expect(text).toContain('Deleted project "billing"');
    expect(text).toContain('indexed docs');
  });

  it('delete_project reports a failed purge as an error, not as success', async () => {
    const indexer = createMockIndexer();
    vi.mocked(indexer.purgeProject).mockRejectedValueOnce(new Error('Qdrant unreachable'));
    const searcher = createMockSearcher();

    const { text, isError } = await runDeleteProject(
      indexer,
      { group: 'g1', project: 'billing' },
      searcher
    );

    expect(isError).toBe(true);
    expect(text).toContain('Qdrant unreachable');
    expect(text).not.toContain('Deleted project');
    // A partial purge may already have removed chunks — the cache must not keep them.
    expect(searcher.invalidateGroupCache).toHaveBeenCalledWith('g1');
  });

  it('delete_project refuses a project outside the server scope', async () => {
    const indexer = createMockIndexer();
    const searcher = createMockSearcher();
    vi.mocked(searcher.getProjectScope).mockReturnValue(['billing']);

    const { text, isError } = await runDeleteProject(
      indexer,
      { group: 'g1', project: 'handbook' },
      searcher
    );

    expect(isError).toBe(true);
    expect(text).toContain('outside');
    expect(indexer.purgeProject).not.toHaveBeenCalled();
  });

  it('delete_project refuses a group name that would address a sidecar collection', async () => {
    const indexer = createMockIndexer();
    const { text, isError } = await runDeleteProject(indexer, {
      group: 'billing_arch',
      project: 'billing',
    });

    expect(isError).toBe(true);
    expect(text).toContain('reserved');
    expect(indexer.purgeProject).not.toHaveBeenCalled();
  });

  // ── Orchestration tools ──────────────────────────────────────────────────

  /** Helper: init session + call tool in one shot */
  async function callTool(
    port: number,
    toolName: string,
    args: Record<string, unknown>,
    basePath = '/mcp'
  ): Promise<{ text: string; status: number; isError: boolean }> {
    const initRes = await fetch(`http://127.0.0.1:${port}${basePath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });

    const sessionId = initRes.headers.get('mcp-session-id')!;

    const callRes = await fetch(`http://127.0.0.1:${port}${basePath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });

    const callBody = (await parseMcpResponse(callRes)) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
    };
    return {
      text: callBody.result?.content?.[0]?.text ?? '',
      status: callRes.status,
      isError: callBody.result?.isError === true,
    };
  }

  it('search_code puts test files below code but shows their real similarity', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.search).mockResolvedValue({
      results: [
        makeSearchResult({ file: 'tests/symbol-graph.test.ts', score: 0.32, hash: 'ht' }),
        makeSearchResult({ file: 'src/symbol-graph.ts', score: 0.295, hash: 'hc' }),
      ],
      total: 2,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const app = express();
    app.use(express.json());
    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
    });
    handler2.mount(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text } = await callTool(port, 'search_code', { query: 'buildSymbolEdges' });
      expect(text.indexOf('src/symbol-graph.ts')).toBeLessThan(
        text.indexOf('tests/symbol-graph.test.ts')
      );
      // A chunk id is a code span: italics put a `_` an agent copies with it.
      expect(text).toContain('chunk: `g1//p1//src/auth.ts//10-20//h1`');
      expect(text).not.toContain('_chunk:');
      // The percentage is the similarity, not the demoted rank key.
      expect(text).toContain('(32.0%');
      expect(text).toContain('(29.5%');
      // Guidance reads the best similarity (0.32), not the first result (0.295, low).
      expect(text).not.toContain('Low confidence results');

      const asked = await callTool(port, 'search_code', { query: 'tests for buildSymbolEdges' });
      expect(asked.text.indexOf('tests/symbol-graph.test.ts')).toBeLessThan(
        asked.text.indexOf('src/symbol-graph.ts')
      );
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('search_code adds the definitions of named identifiers that dense search missed', async () => {
    const searcher = createMockSearcher();
    const response = (results: ReturnType<typeof makeSearchResult>[]) => ({
      results,
      total: results.length,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });
    vi.mocked(searcher.search).mockResolvedValue(
      response([
        makeSearchResult({
          file: 'src/report.ts',
          score: 0.52,
          hash: 'hu',
          defines_symbols: ['render'],
        }),
      ])
    );
    vi.mocked(searcher.searchWithFilter).mockResolvedValue(
      response([
        makeSearchResult({
          file: 'src/total.ts',
          score: 0.5,
          hash: 'hd',
          defines_symbols: ['InvoiceTotal'],
        }),
      ])
    );

    const app = express();
    app.use(express.json());
    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
    });
    handler2.mount(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text } = await callTool(port, 'search_code', {
        query: 'where is InvoiceTotal computed',
      });
      expect(searcher.searchWithFilter).toHaveBeenCalledWith(
        'g1',
        'where is InvoiceTotal computed',
        { must: [{ key: 'defines_symbols', match: { any: ['InvoiceTotal'] } }] },
        expect.objectContaining({ project: 'all', tool: 'search_code' })
      );
      // The definition ranks first; its shown score is still its similarity.
      expect(text.indexOf('src/total.ts')).toBeLessThan(text.indexOf('src/report.ts'));
      expect(text).toContain('(50.0%');

      vi.mocked(searcher.searchWithFilter).mockClear();
      await callTool(port, 'search_code', { query: 'where is the invoice total computed' });
      expect(searcher.searchWithFilter).not.toHaveBeenCalled();
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('explain_feature returns code locations table', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, status } = await callTool(
        port,
        'explain_feature',
        {
          question: 'How does authentication work?',
        },
        '/support/mcp'
      );

      expect(status).toBe(200);
      expect(text).toContain('## Code Locations');
      expect(text).toContain('src/auth.ts');
      expect(text).toContain('authenticate');
      expect(text).toContain('85.0%');
      expect(text).toContain('auth-service');
      // No code content — no ``` fences
      expect(text).not.toContain('```');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('explain_feature includes changes and related modules with metadataStore', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getCommits).mockReturnValue([
      {
        chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        commit_hash: 'abc123',
        committed_at: '2024-06-15T10:00:00Z',
        author_email: 'dev@test.com',
        message_summary: 'Add auth flow',
      },
    ]);
    vi.mocked(metadataStore.getTickets).mockReturnValue([
      {
        chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        ticket_key: 'PROJ-42',
        source: 'jira' as const,
      },
    ]);
    vi.mocked(metadataStore.getEdgesTo).mockReturnValue([
      {
        from_chunk_id: 'g1//p1//src/login.ts//5-15//h2',
        to_chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        relation_type: 'calls' as const,
        symbol_name: 'authenticate',
      },
    ]);
    vi.mocked(metadataStore.getEdgesFrom).mockReturnValue([]);

    const indexer = createMockIndexer();
    vi.mocked(indexer.getChunkById).mockResolvedValue({
      project: 'p1',
      file: 'src/login.ts',
      startLine: 5,
      endLine: 15,
      symbol_name: 'handleLogin',
      kind: 'function',
      service: 'auth-service',
      bounded_context: 'auth',
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer,
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
      metadataStore,
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text } = await callTool(
        port,
        'explain_feature',
        {
          question: 'How does authentication work?',
        },
        '/support/mcp'
      );

      expect(text).toContain('## Code Locations');
      expect(text).toContain('## Recent Changes');
      expect(text).toContain('dev@test.com');
      expect(text).toContain('Add auth flow');
      expect(text).toContain('PROJ-42');
      expect(text).toContain('## Related Modules');
      expect(text).toContain('Incoming (callers)');
      expect(text).toContain('authenticate');
      expect(text).toContain('src/login.ts');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('recent_changes returns timeline and code locations summary', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.searchWithFilter).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getCommits).mockReturnValue([
      {
        chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        commit_hash: 'abc123',
        committed_at: '2024-06-15T10:00:00Z',
        author_email: 'dev@test.com',
        message_summary: 'Update auth logic',
      },
    ]);

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
      metadataStore,
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, status } = await callTool(
        port,
        'recent_changes',
        {
          question: 'authentication changes',
          since: '2024-01-01',
        },
        '/support/mcp'
      );

      expect(status).toBe(200);
      expect(text).toContain('## Timeline');
      expect(text).toContain('2024-06-15');
      expect(text).toContain('dev@test.com');
      expect(text).toContain('Update auth logic');
      expect(text).toContain('## Code Locations Summary');
      expect(text).toContain('src/auth.ts');
      expect(text).not.toContain('```');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('resolveSince turns a relative date into the ISO date Qdrant filters on', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(resolveSince('7 days ago', now)).toBe('2026-10-21T12:00:00.000Z');
    expect(resolveSince('2 weeks', now)).toBe('2026-10-14T12:00:00.000Z');
    expect(resolveSince('last month', now)).toBe('2026-09-28T12:00:00.000Z');
    expect(resolveSince('yesterday', now)).toBe('2026-10-27');
    expect(resolveSince('2024-01-01', now)).toBe('2024-01-01');
    expect(resolveSince('2024-01-01 10:00+03:00', now)).toBe('2024-01-01T07:00:00.000Z');
    expect(resolveSince('since the release', now)).toBeNull();
  });

  it('recent_changes filters on a relative since and refuses one it cannot read', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.searchWithFilter).mockResolvedValue({
      results: [],
      total: 0,
      metrics: { tokensReturned: 0, estimatedFullFileTokens: 0, tokensSaved: 0, savingsPercent: 0 },
    });
    await withHandler({ searcher }, async (port) => {
      await callTool(
        port,
        'recent_changes',
        { question: 'auth', since: '7 days ago' },
        '/support/mcp'
      );
      const filter = vi.mocked(searcher.searchWithFilter).mock.calls[0]![2] as {
        must: Array<{ range: { gte: string } }>;
      };
      const gte = filter.must[0]!.range.gte;
      expect(gte).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Math.abs(Date.now() - 7 * 86_400_000 - Date.parse(gte))).toBeLessThan(60_000);

      vi.mocked(searcher.searchWithFilter).mockClear();
      const { text } = await callTool(
        port,
        'recent_changes',
        { question: 'auth', since: 'since the release' },
        '/support/mcp'
      );
      expect(text).toContain('Cannot read since');
      expect(searcher.searchWithFilter).not.toHaveBeenCalled();
    });
  });

  it('recent_changes without metadataStore still returns code locations', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.searchWithFilter).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
      // No metadataStore
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, status } = await callTool(
        port,
        'recent_changes',
        {
          question: 'authentication changes',
        },
        '/support/mcp'
      );

      expect(status).toBe(200);
      // No Timeline section without metadataStore
      expect(text).not.toContain('## Timeline');
      // Still has code locations summary
      expect(text).toContain('## Code Locations Summary');
      expect(text).toContain('src/auth.ts');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('impact_analysis returns seed chunks and impact by service', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getEdgesTo).mockReturnValue([
      {
        from_chunk_id: 'g1//p1//src/login.ts//5-15//h2',
        to_chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        relation_type: 'calls' as const,
        symbol_name: 'authenticate',
      },
    ]);
    vi.mocked(metadataStore.getEdgesFrom).mockReturnValue([
      {
        from_chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        to_chunk_id: 'g1//p1//src/token.ts//1-10//h3',
        relation_type: 'calls' as const,
        symbol_name: 'validateToken',
      },
    ]);

    const indexer = createMockIndexer();
    vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
      if (id === 'g1//p1//src/login.ts//5-15//h2') {
        return {
          project: 'p1',
          file: 'src/login.ts',
          startLine: 5,
          endLine: 15,
          symbol_name: 'handleLogin',
          kind: 'function',
          service: 'auth-service',
          bounded_context: 'auth',
        };
      }
      if (id === 'g1//p1//src/token.ts//1-10//h3') {
        return {
          project: 'p1',
          file: 'src/token.ts',
          startLine: 1,
          endLine: 10,
          symbol_name: 'validateToken',
          kind: 'function',
          service: 'token-service',
          bounded_context: 'auth',
        };
      }
      return null;
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer,
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
      metadataStore,
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, status } = await callTool(
        port,
        'impact_analysis',
        {
          question: 'authentication',
          max_hops: 1,
        },
        '/support/mcp'
      );

      expect(status).toBe(200);
      expect(text).toContain('## Seed Chunks');
      expect(text).toContain('src/auth.ts');
      expect(text).toContain('authenticate');
      expect(text).toContain('## Impact by Service');
      expect(text).toContain('auth-service');
      expect(text).toContain('token-service');
      expect(text).toContain('src/login.ts');
      expect(text).toContain('src/token.ts');
      expect(text).toContain('## Dependency Edges');
      expect(text).not.toContain('```');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  describe('change_impact', () => {
    const SEED = 'g1//p1//src/auth.ts//10-20//h1';
    const CALLER = 'g1//p1//src/login.ts//5-15//h2';
    const CALLER_OF_CALLER = 'g1//p1//src/routes.ts//0-30//h3';
    const MAYBE = 'g1//p1//src/legacy.ts//0-9//h4';
    const TEST = 'g1//p1//tests/auth.test.ts//0-40//h5';
    const BEHIND_TEST = 'g1//p1//tests/helpers.ts//0-5//h6';
    const SIBLING = 'g1//p1//src/auth.ts//22-30//h7';
    const SIBLING_CALLER = 'g1//p1//src/admin.ts//1-8//h8';

    const edge = (from: string, to: string, symbol: string, confidence?: string) => ({
      from_chunk_id: from,
      to_chunk_id: to,
      relation_type: 'calls' as const,
      symbol_name: symbol,
      ...(confidence ? { confidence } : {}),
    });
    const EDGES = [
      edge(CALLER, SEED, 'authenticate'),
      edge(MAYBE, SEED, 'authenticate', 'AMBIGUOUS'),
      edge(TEST, SEED, 'authenticate'),
      edge(CALLER_OF_CALLER, CALLER, 'handleLogin'),
      edge(BEHIND_TEST, TEST, 'setup'),
      edge(SIBLING_CALLER, SIBLING, 'refresh'),
    ];

    function mocks() {
      const metadataStore = createMockMetadataStore();
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => EDGES.filter((e) => e.to_chunk_id === id) as never
      );
      const indexer = createMockIndexer();
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const [, project, file, lines] = id.split('//');
        return {
          chunk_id: id,
          project,
          file,
          startLine: Number(lines!.split('-')[0]),
          symbol_name: id === SEED ? 'authenticate' : null,
          defines_symbols: id === SEED ? ['authenticate', 'logout'] : [],
        };
      });
      vi.mocked(indexer.getAdjacentChunks).mockResolvedValue([
        { chunk_id: SEED },
        { chunk_id: SIBLING },
      ]);
      return { metadataStore, indexer };
    }

    it('lists direct and further callers, tests apart, ambiguous links set aside', async () => {
      const { metadataStore, indexer } = mocks();
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text, isError } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(isError).toBe(false);
        expect(text).toContain('## Change impact of [p1] src/auth.ts:11-21 `authenticate`');
        expect(text).toContain(
          '3 chunks in 3 files depend on it within 2 steps: 2 directly, 1 through other code. 1 of them are tests.'
        );
        expect(text).toContain('### Uses it directly (1)');
        expect(text).toContain('**[p1] src/login.ts:6** — uses `authenticate`');
        expect(text).toContain(
          '### Linked only through a name defined in several places (1) — probably not dependents'
        );
        expect(text).toContain('- `authenticate` — 1 file: src/legacy.ts');
        expect(text).toContain('### 2 steps away (1)');
        expect(text).toContain('src/routes.ts:1** — uses `handleLogin`');
        expect(text).toContain('### Tests (1)');
        expect(text).toContain('tests/auth.test.ts:1** — uses `authenticate`, 1 step away');
        // Nothing meaningful depends on a test, so its callers are not followed.
        expect(text).not.toContain('tests/helpers.ts');
        // The sibling chunk of the same file is not part of a chunk-level change.
        expect(text).not.toContain('src/admin.ts');
        expect(text).not.toContain('`[maybe]`');
        expect(text).not.toContain('```');
      });
    });

    it('names the method that makes the call, and follows only that method', async () => {
      const { metadataStore, indexer } = mocks();
      const VIEW = 'g1//p1//src/view.ts//0-9//h9';
      const edges = [
        { ...edge(CALLER, SEED, 'authenticate'), from_symbols: ['submit'] },
        edge(CALLER_OF_CALLER, CALLER, 'handleLogin'),
        edge(VIEW, CALLER, 'submit'),
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain('**[p1] src/login.ts:6** `submit` — uses `authenticate`');
        expect(text).toContain('src/view.ts:1** — uses `submit`');
        // `handleLogin` sits in the same chunk as `submit` but does not call the change.
        expect(text).not.toContain('src/routes.ts');
      });
    });

    it('shows the line of the calling method and the methods of its chunk that reach it', async () => {
      const { metadataStore, indexer } = mocks();
      const VIEW = 'g1//p1//src/view.ts//0-9//h9';
      const edges = [
        {
          ...edge(CALLER, SEED, 'authenticate'),
          from_symbols: ['submit'],
          reach_symbols: ['wizard'],
        },
        edge(VIEW, CALLER, 'wizard'),
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      // CALLER calls a lot (an out-degree hub) but few call it: its callers are followed.
      vi.mocked(metadataStore.getGroupDegreeSnapshot).mockReturnValue({
        hubChunkIds: new Set([CALLER]),
        calledHubChunkIds: new Set(),
      } as never);
      const base = vi.mocked(indexer.getChunkById).getMockImplementation()!;
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const payload = await base(id);
        if (id !== CALLER) return payload;
        const content = [
          'export class LoginForm {',
          '  wizard() {',
          '    return this.submit();',
          '  }',
          '',
          '  async submit(): Promise<void> {',
          '    await authenticate();',
          '  }',
          '}',
        ].join('\n');
        return { ...payload, content };
      });
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED, depth: 3 });
        // The chunk starts at line 6 (1-indexed); `submit` is defined 5 lines in.
        expect(text).toContain('**[p1] src/login.ts:11** `submit` — uses `authenticate`');
        // Symbols stored without the chunk's own calls: only a lower bound for `wizard`.
        expect(text).toContain(
          '### At least 2 steps away (1)\n\n- **[p1] src/login.ts:7** `wizard` — reaches it through calls in this file'
        );
        // `wizard` is a step or more past `submit`, so what calls it is at least 3 steps away.
        expect(text).toContain(
          '### At least 3 steps away (1)\n\n- **[p1] src/view.ts:1** — uses `wizard`'
        );
        expect(text).not.toContain('[hub]');
        expect(text).toContain('_Steps count calls between methods');
      });
    });

    it('counts exact steps through the calls a chunk records between its methods', async () => {
      const { metadataStore, indexer } = mocks();
      const VIEW = 'g1//p1//src/view.ts//0-9//h9';
      const edges = [
        {
          ...edge(CALLER, SEED, 'authenticate'),
          from_symbols: ['submit'],
          reach_symbols: ['wizard'],
          reach_steps: [1],
        },
        edge(VIEW, CALLER, 'wizard'),
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      const base = vi.mocked(indexer.getChunkById).getMockImplementation()!;
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const payload = await base(id);
        if (id !== CALLER) return payload;
        return {
          ...payload,
          defines_symbols: ['wizard', 'submit'],
          inner_calls: { submit: ['wizard'] },
        };
      });
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED, depth: 3 });
        expect(text).toContain(
          '### 2 steps away (1)\n\n- **[p1] src/login.ts:6** `wizard` — calls `submit` in this file'
        );
        expect(text).toContain('### 3 steps away (1)\n\n- **[p1] src/view.ts:1** — uses `wizard`');
        expect(text).not.toContain('At least');
        // Asked for 2 steps: the caller 3 steps away is counted, not listed.
        const near = await callTool(port, 'change_impact', { chunk_id: SEED, depth: 2 });
        expect(near.text).toContain('1 more chunk is further than 2 steps away, not listed.');
        expect(near.text).not.toContain('src/view.ts');
      });
    });

    it('follows the callers of a method that begins in an earlier chunk of its file', async () => {
      const { metadataStore, indexer } = mocks();
      const HEAD = 'g1//p1//src/login.ts//0-4//h0';
      const VIEW = 'g1//p1//src/view.ts//0-9//h9';
      const TAIL = 'g1//p1//src/login.ts//16-20//h3';
      const edges = [
        { ...edge(CALLER, SEED, 'authenticate'), from_symbols: ['submit'] },
        { ...edge(TAIL, SEED, 'authenticate'), from_symbols: ['submit'] },
        { ...edge(VIEW, HEAD, 'submit'), from_symbols: ['render'] },
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      const base = vi.mocked(indexer.getChunkById).getMockImplementation()!;
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const payload = await base(id);
        if (id !== HEAD) return payload;
        const content =
          'export class LoginForm {\n  async submit(): Promise<void> {\n    const a = 1;';
        return { ...payload, defines_symbols: ['LoginForm', 'submit'], content };
      });
      vi.mocked(indexer.getAdjacentChunks).mockResolvedValue([
        { chunk_id: HEAD },
        { chunk_id: CALLER },
        { chunk_id: TAIL },
      ]);
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', {
          chunk_id: SEED,
          symbol: 'authenticate',
        });
        // `submit` begins on line 2 of the file, in the chunk before the one calling the change.
        expect(text).toContain('**[p1] src/login.ts:2** `submit` — uses `authenticate`');
        // Both later chunks of `submit` share its row.
        expect(text).toContain(`chunks: \`${CALLER}\`, \`${TAIL}\``);
        expect(text).toContain('### Uses it directly (1)');
        expect(text).toContain(
          '### 2 steps away (1)\n\n- **[p1] src/view.ts:1** `render` — uses `submit`'
        );
      });
    });

    it('lists a method calling the change from where it begins and a later chunk once', async () => {
      const { metadataStore, indexer } = mocks();
      const HEAD = 'g1//p1//src/login.ts//0-4//h0';
      const edges = [
        { ...edge(HEAD, SEED, 'authenticate'), from_symbols: ['submit'] },
        { ...edge(CALLER, SEED, 'authenticate'), from_symbols: ['submit'] },
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      const base = vi.mocked(indexer.getChunkById).getMockImplementation()!;
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const payload = await base(id);
        if (id !== HEAD) return payload;
        const content =
          'export class LoginForm {\n  async submit(): Promise<void> {\n    const a = 1;';
        return { ...payload, defines_symbols: ['LoginForm', 'submit'], content };
      });
      vi.mocked(indexer.getAdjacentChunks).mockResolvedValue([
        { chunk_id: HEAD },
        { chunk_id: CALLER },
      ]);
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', {
          chunk_id: SEED,
          symbol: 'authenticate',
        });
        expect(text).toContain('### Uses it directly (1)');
        expect(text).toContain('**[p1] src/login.ts:2** `submit` — uses `authenticate`');
        expect(text).toContain(`chunks: \`${HEAD}\`, \`${CALLER}\``);
        expect(text).toContain('2 chunks in 1 files depend on it');
      });
    });

    it('lists the methods of the changed chunk that call it, a step further each', async () => {
      const { metadataStore, indexer } = mocks();
      const VIEW = 'g1//p1//src/view.ts//0-9//h9';
      const edges = [edge(VIEW, SEED, 'logout')];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      const base = vi.mocked(indexer.getChunkById).getMockImplementation()!;
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const payload = await base(id);
        if (id !== SEED) return payload;
        const content =
          'export function authenticate() {}\nexport function logout() {\n  authenticate();\n}';
        return { ...payload, content, inner_calls: { authenticate: ['logout'] } };
      });
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', {
          chunk_id: SEED,
          symbol: 'authenticate',
        });
        expect(text).toContain('1 other method of the changed chunk calls it through the chunk');
        expect(text).toContain(
          '### Uses it directly (1)\n\n- **[p1] src/auth.ts:12** `logout` — calls `authenticate` in this file'
        );
        expect(text).toContain('### 2 steps away (1)\n\n- **[p1] src/view.ts:1** — uses `logout`');
      });
    });

    it('says steps count from every name of the chunk when no symbol is given', async () => {
      const { metadataStore, indexer } = mocks();
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) =>
          [edge(CALLER, SEED, 'authenticate')].filter((e) => e.to_chunk_id === id) as never
      );
      const base = vi.mocked(indexer.getChunkById).getMockImplementation()!;
      vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
        const payload = await base(id);
        return id === SEED ? { ...payload, defines_symbols: ['authenticate', 'logout'] } : payload;
      });
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain(
          'Steps are counted from any of the 2 names this chunk defines (`authenticate`, `logout`); pass `symbol` to count from one.'
        );
        const one = await callTool(port, 'change_impact', {
          chunk_id: SEED,
          symbol: 'authenticate',
        });
        expect(one.text).not.toContain('Steps are counted from any');
      });
    });

    it('lists a barrel file as re-exporting the change, not as a caller', async () => {
      const { metadataStore, indexer } = mocks();
      const BARREL = 'g1//p1//src/lib.ts//0-40//h10';
      const edges = [
        edge(CALLER, SEED, 'authenticate'),
        {
          ...edge(BARREL, SEED, 'authenticate'),
          relation_type: 'reexports' as const,
          from_symbols: ['authenticate'],
        },
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain('**[p1] src/lib.ts:1** — re-exports `authenticate`');
        expect(text).toContain('**[p1] src/login.ts:6** — uses `authenticate`');
      });
    });

    it('lists links further away through a name defined in several places apart', async () => {
      const { metadataStore, indexer } = mocks();
      const OTHER = 'g1//p1//src/feed.ts//0-9//h11';
      const edges = [
        edge(CALLER, SEED, 'authenticate'),
        edge(OTHER, CALLER, 'handleLogin', 'AMBIGUOUS'),
      ];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain('### Uses it directly (1)');
        expect(text).not.toContain('### 2 steps away');
        expect(text).toContain('### Linked only through a name defined in several places (1)');
        expect(text).toContain('- `handleLogin` — 1 file: src/feed.ts');
      });
    });

    it('says where the tests would be when no indexed test reaches the change', async () => {
      const { metadataStore, indexer } = mocks();
      const edges = [edge(CALLER, SEED, 'authenticate')];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain('No test in the index reaches it.');
        expect(text).toContain('- `src/auth.test.ts`');
        expect(text).toContain('- `src/login.spec.ts`');
      });
    });

    it("names the project's test files named after the change when they are recorded", async () => {
      const { metadataStore, indexer } = mocks();
      const edges = [edge(CALLER, SEED, 'authenticate')];
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => edges.filter((e) => e.to_chunk_id === id) as never
      );
      vi.mocked(metadataStore.getTestFiles).mockReturnValue([
        'test/unit/src/auth.test.ts',
        'test/unit/other/auth.test.ts',
        'test/unit/src/session.test.ts',
      ]);
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain('These test files of the project are named after it');
        expect(text).toContain('- `test/unit/src/auth.test.ts`');
        expect(text).not.toContain('other/auth.test.ts');
        expect(text).not.toContain('src/auth.spec.ts');

        vi.mocked(metadataStore.getTestFiles).mockReturnValue([]);
        const none = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(none.text).toContain('No test file of the project is named after it');
      });
    });

    it('stops at depth and says more is there', async () => {
      const { metadataStore, indexer } = mocks();
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED, depth: 1 });
        expect(text).not.toContain('src/routes.ts');
        expect(text).toContain('raise `depth`');
      });
    });

    it('takes the whole file as the change and narrows by symbol', async () => {
      const { metadataStore, indexer } = mocks();
      await withHandler({ metadataStore, indexer }, async (port) => {
        const file = await callTool(port, 'change_impact', { chunk_id: SEED, whole_file: true });
        expect(file.text).toContain('[p1] src/auth.ts (whole file, 2 chunks)');
        expect(file.text).toContain('src/admin.ts');

        const narrowed = await callTool(port, 'change_impact', {
          chunk_id: SEED,
          symbol: 'logout',
        });
        expect(narrowed.text).toContain(
          'Nothing in the indexed code depends on it through `logout`'
        );

        const wrong = await callTool(port, 'change_impact', { chunk_id: SEED, symbol: 'nope' });
        expect(wrong.text).toContain(
          'This chunk does not define `nope`; it defines `authenticate`, `logout`.'
        );
      });
    });

    it('lists callers linked only through a common name apart, without following them', async () => {
      const { metadataStore, indexer } = mocks();
      const setUsers = Array.from({ length: 12 }, (_, i) => `g1//p1//src/m${i}.ts//0-5//c${i}`);
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) =>
          [
            ...EDGES.filter((e) => e.to_chunk_id === id),
            ...(id === SEED ? setUsers.map((u) => edge(u, SEED, 'add')) : []),
            ...(id === setUsers[0] ? [edge(CALLER_OF_CALLER, setUsers[0]!, 'build')] : []),
          ] as never
      );
      vi.mocked(metadataStore.getNameUsage).mockReturnValue({
        callerFiles: 100,
        filesUsing: new Map([['add', 40]]),
      });
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED, depth: 1 });
        expect(text).toContain('2 chunks in 2 files depend on it');
        expect(text).toContain(
          '### Linked only through a common name (12) — probably not dependents'
        );
        expect(text).toContain(
          '- `add` (used in 40 files) — 12 chunks in 12 files: src/m0.ts, src/m1.ts, src/m10.ts, src/m11.ts, src/m2.ts (+7 more)'
        );
        expect(text).not.toContain('**[p1] src/m0.ts');
      });
    });

    it('keeps a common-name caller whose file also uses something specific from the changed file', async () => {
      const { metadataStore, indexer } = mocks();
      const QUEUE_USER = 'g1//p1//src/worker.ts//0-5//q1';
      vi.mocked(metadataStore.getEdgesTo).mockImplementation(
        (id: string) => (id === SEED ? [edge(QUEUE_USER, SEED, 'add')] : []) as never
      );
      vi.mocked(metadataStore.getEdgesFromFile).mockReturnValue([
        edge('g1//p1//src/worker.ts//6-9//q2', 'g1//p1//src/auth.ts//0-9//h9', 'AuthQueue'),
      ]);
      vi.mocked(metadataStore.getNameUsage).mockReturnValue({
        callerFiles: 100,
        filesUsing: new Map([['add', 40]]),
      });
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED });
        expect(text).toContain('src/worker.ts:1** — uses `add` [maybe]');
        expect(text).not.toContain('Linked only through a common name');
      });
    });

    it('is a coding tool only', async () => {
      const { metadataStore, indexer } = mocks();
      await withHandler({ metadataStore, indexer }, async (port) => {
        const { text } = await callTool(port, 'change_impact', { chunk_id: SEED }, '/support/mcp');
        expect(text).not.toContain('Change impact of');
      });
    });
  });

  describe('module_map', () => {
    /** Two tight clusters of files, `a*` and `b*`, with one link (imports) from a to b. */
    function clusterEdges(project = 'p1') {
      const edges: Array<Record<string, string>> = [];
      const link = (from: string, to: string, symbol: string, confidence = 'INFERRED') =>
        edges.push({
          from_chunk_id: `g1//${project}//${from}//0-5//h`,
          to_chunk_id: `g1//${project}//${to}//0-5//h`,
          relation_type: 'calls',
          symbol_name: symbol,
          confidence,
        });
      for (const [x, y] of [
        ['a1', 'a2'],
        ['a2', 'a3'],
        ['a3', 'a1'],
        ['b1', 'b2'],
        ['b2', 'b3'],
        ['b3', 'b1'],
      ]) {
        link(`src/${x![0]}/${x}.ts`, `src/${y![0]}/${y}.ts`, `use_${y}`);
        link(`src/${y![0]}/${y}.ts`, `src/${x![0]}/${x}.ts`, `use_${x}`);
      }
      link('src/a/a1.ts', 'src/b/b1.ts', 'crossOne', 'EXTRACTED');
      link('src/a/a2.ts', 'src/b/b2.ts', 'crossTwo', 'EXTRACTED');
      link('tests/a.test.ts', 'src/a/a1.ts', 'use_a1');
      return edges;
    }

    it('maps the group into modules with links and tests, in both modes', async () => {
      const metadataStore = createMockMetadataStore();
      mockEdges(metadataStore, () => clusterEdges() as SymbolEdge[]);
      await withHandler({ metadataStore }, async (port) => {
        for (const path of ['/mcp', '/support/mcp']) {
          const { text, isError } = await callTool(port, 'module_map', {}, path);
          expect(isError).toBe(false);
          expect(text).toContain('## Module map of `g1`');
          expect(text).toContain('2 modules over 6 files (1 test file attached');
          expect(text).toContain('### 1. src/a — 3 files, 1 test');
          expect(text).toContain('Uses: 2. src/b');
          expect(text).toContain('Used by: 1. src/a');
          expect(text).not.toContain('[p1]');
        }
      });
    });

    it('reuses the map until the edges change', async () => {
      const metadataStore = createMockMetadataStore();
      mockEdges(metadataStore, () => clusterEdges() as SymbolEdge[]);
      await withHandler({ metadataStore }, async (port) => {
        await callTool(port, 'module_map', { group: 'g1' });
        await callTool(port, 'module_map', { group: 'g1' });
        expect(metadataStore.iterateProjectEdges).toHaveBeenCalledTimes(1);
        // A fresh map is still served while it is young, even after edges change.
        vi.mocked(metadataStore.edgesVersion).mockReturnValue('0:1');
        await callTool(port, 'module_map', { group: 'g1' });
        expect(metadataStore.iterateProjectEdges).toHaveBeenCalledTimes(1);
      });
    });

    it('asks for a group when several are indexed', async () => {
      const metadataStore = createMockMetadataStore();
      await withHandler({ metadataStore, getGroupNames: () => ['g1', 'g2'] }, async (port) => {
        const { text } = await callTool(port, 'module_map', {});
        expect(text).toContain('Pass `group`: one of `g1`, `g2`.');
      });
    });

    it('maps one project only, and nothing for a project out of scope', async () => {
      const metadataStore = createMockMetadataStore();
      mockEdges(
        metadataStore,
        () => [...clusterEdges('billing-v3'), ...clusterEdges('handbook-v3')] as SymbolEdge[]
      );
      const searcher = createMockSearcher();
      vi.mocked(searcher.getProjectScope).mockReturnValue(['billing']);
      await withHandler(
        { metadataStore, searcher, indexer: createMockIndexer('-v3') },
        async (port) => {
          const all = await callTool(port, 'module_map', { group: 'g1' });
          expect(all.text).toContain('2 modules over 6 files');
          expect(all.text).not.toContain('handbook');

          const hidden = await callTool(port, 'module_map', { group: 'g1', project: 'handbook' });
          expect(hidden.text).toContain('No modules');
        }
      );
    });
  });

  it('rejects reuse of a coding session id on the support endpoint', async () => {
    const app = express();
    app.use(express.json());
    handler.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });

      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Replay the coding session id against the support endpoint — must be rejected.
      const crossRes = await fetch(`http://127.0.0.1:${port}/support/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'prompts/list',
          params: {},
        }),
      });

      expect(crossRes.status).toBe(400);
      const body = (await crossRes.json()) as { error?: { code?: number; message?: string } };
      expect(body.error?.code).toBe(-32000);
      expect(body.error?.message).toContain('coding mode');
      expect(body.error?.message).toContain('support endpoint');

      // The original coding session is still usable.
      const sameModeRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'prompts/list',
          params: {},
        }),
      });
      expect(sameModeRes.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('impact_analysis without metadataStore returns only seed chunks', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: {
        tokensReturned: 10,
        estimatedFullFileTokens: 100,
        tokensSaved: 90,
        savingsPercent: 90,
      },
    });

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher,
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
      // No metadataStore
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text, status } = await callTool(
        port,
        'impact_analysis',
        {
          question: 'authentication',
        },
        '/support/mcp'
      );

      expect(status).toBe(200);
      expect(text).toContain('## Seed Chunks');
      expect(text).toContain('Symbol graph not available');
      expect(text).not.toContain('## Impact by Service');
      expect(text).not.toContain('## Dependency Edges');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  // ── Shared harness for the tests below ───────────────────────────────────

  /** Mount a handler on a throwaway server, run `fn`, always tear both down. */
  async function withHandler<T>(
    config: Partial<McpHandlerConfig>,
    fn: (port: number, handler: McpHandler) => Promise<T>
  ): Promise<T> {
    const projects = new Map([['g1', [createProjectConfig()]]]);
    const h = new McpHandler({
      searcher: createMockSearcher(),
      indexer: createMockIndexer(),
      getProjects: () => projects,
      getGroupNames: () => ['g1'],
      ...config,
    });
    const app = express();
    app.use(express.json());
    h.mount(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      return await fn(port, h);
    } finally {
      server.close();
      h.destroy();
    }
  }

  /** Open a Streamable HTTP session and return its id. */
  async function initSession(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    });
    await res.text();
    return res.headers.get('mcp-session-id')!;
  }

  /** The handler's private session table — the tests steer idle times through it. */
  function sessionsOf(h: McpHandler): Record<string, { lastActivity: number }> {
    return (h as unknown as { transports: Record<string, { lastActivity: number }> }).transports;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  it('answers a malformed unknown session id with 404 instead of building a server for it', async () => {
    await withHandler({}, async (port, h) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': 'made-up-session',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'health_check', arguments: {} },
        }),
      });
      expect(res.status).toBe(404);
      expect(h.sessionCount).toBe(0);
    });
  });

  it('closes the least recently active session once the session limit is reached', async () => {
    await withHandler({ maxSessions: 2 }, async (port, h) => {
      const first = await initSession(port);
      const second = await initSession(port);
      sessionsOf(h)[second]!.lastActivity = 0; // idle the longest

      const third = await initSession(port);

      expect(h.sessionCount).toBe(2);
      expect(Object.keys(sessionsOf(h)).sort()).toEqual([first, third].sort());
    });
  });

  it('caps sessions recreated from client-supplied ids too', async () => {
    await withHandler({ maxSessions: 2 }, async (port, h) => {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-session-id': uuidv7(),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'health_check', arguments: {} },
          }),
        });
        expect(res.status).toBe(200);
        await res.text();
      }
      expect(h.sessionCount).toBe(2);
    });
  });

  it('ends an expired SSE stream instead of leaving the client hanging', async () => {
    await withHandler({}, async (port, h) => {
      const res = await fetch(`http://127.0.0.1:${port}/sse`);
      const reader = res.body!.getReader();
      await reader.read(); // the `endpoint` event: the session is live
      expect(h.sessionCount).toBe(1);

      for (const entry of Object.values(sessionsOf(h))) entry.lastActivity = 0;
      (h as unknown as { cleanupExpiredSessions(): void }).cleanupExpiredSessions();

      const drained = (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return true;
        }
      })();
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000));
      expect(await Promise.race([drained, timeout])).toBe(true);
      expect(h.sessionCount).toBe(0);
    });
  });

  // ── Project scope (PAPARATS_PROJECTS) outside the Searcher ────────────────

  const IN_SCOPE_CHUNK = 'g1//billing-v3//src/invoice.ts//0-10//h1';
  const OUT_OF_SCOPE_CHUNK = 'g1//handbook-v3//src/page.ts//0-10//h2';

  /** Searcher scoped to `billing`, indexer storing names with a `-v3` suffix. */
  function scopedMocks(): { searcher: Searcher; indexer: Indexer } {
    const searcher = createMockSearcher();
    vi.mocked(searcher.getProjectScope).mockReturnValue(['billing']);
    const indexer = createMockIndexer('-v3');
    vi.mocked(indexer.getChunkById).mockImplementation(async (id: string) => {
      const project = id.split('//')[1]!.replace(/-v3$/, '');
      return {
        chunk_id: id,
        project,
        file: id.split('//')[2],
        language: 'typescript',
        startLine: 0,
        endLine: 10,
        content: `// ${project}`,
        defines_symbols: ['charge'],
      };
    });
    return { searcher, indexer };
  }

  it('get_chunk treats an out-of-scope chunk exactly like a missing one', async () => {
    const { searcher, indexer } = scopedMocks();
    await withHandler({ searcher, indexer }, async (port) => {
      const hidden = await callTool(port, 'get_chunk', { chunk_id: OUT_OF_SCOPE_CHUNK });
      expect(hidden.text).toContain('Chunk not found');
      expect(indexer.getChunkById).not.toHaveBeenCalled();

      const visible = await callTool(port, 'get_chunk', { chunk_id: IN_SCOPE_CHUNK });
      expect(visible.text).toContain('src/invoice.ts');
    });
  });

  it('reads a chunk id copied with the markup around it', async () => {
    const { searcher, indexer } = scopedMocks();
    await withHandler({ searcher, indexer }, async (port) => {
      for (const copied of [
        `${IN_SCOPE_CHUNK}_`,
        `\`${IN_SCOPE_CHUNK}\``,
        ` ${IN_SCOPE_CHUNK}. `,
      ]) {
        const { text } = await callTool(port, 'get_chunk', { chunk_id: copied });
        expect(text).toContain('src/invoice.ts');
      }
      expect(
        vi.mocked(indexer.getChunkById).mock.calls.every(([id]) => id === IN_SCOPE_CHUNK)
      ).toBe(true);
    });
  });

  it('cleanChunkId strips only the marks around an id', () => {
    expect(cleanChunkId('g//p//a_b.rb//0-9//00ff_')).toBe('g//p//a_b.rb//0-9//00ff');
    expect(cleanChunkId('*`g//p//f//0-9//ab`*')).toBe('g//p//f//0-9//ab');
    expect(cleanChunkId('g//p//f//0-9//ab')).toBe('g//p//f//0-9//ab');
  });

  it('get_chunk_meta refuses an out-of-scope chunk', async () => {
    const { searcher, indexer } = scopedMocks();
    const metadataStore = createMockMetadataStore();
    await withHandler({ searcher, indexer, metadataStore }, async (port) => {
      const { text } = await callTool(
        port,
        'get_chunk_meta',
        { chunk_id: OUT_OF_SCOPE_CHUNK },
        '/support/mcp'
      );
      expect(text).toContain('Chunk not found');
      expect(metadataStore.getCommits).not.toHaveBeenCalled();
    });
  });

  it('find_usages refuses an out-of-scope seed and hides out-of-scope neighbours', async () => {
    const { searcher, indexer } = scopedMocks();
    const metadataStore = createMockMetadataStore();
    const otherCaller = 'g1//billing-v3//src/checkout.ts//5-9//h3';
    vi.mocked(metadataStore.getEdgesTo).mockReturnValue([
      {
        from_chunk_id: otherCaller,
        to_chunk_id: IN_SCOPE_CHUNK,
        relation_type: 'calls',
        symbol_name: 'charge',
      },
      {
        from_chunk_id: OUT_OF_SCOPE_CHUNK,
        to_chunk_id: IN_SCOPE_CHUNK,
        relation_type: 'calls',
        symbol_name: 'charge',
      },
    ] as never);
    (metadataStore as unknown as { getGroupDegreeSnapshot: unknown }).getGroupDegreeSnapshot = vi
      .fn()
      .mockReturnValue({ hubChunkIds: new Set(), calledHubChunkIds: new Set() });

    await withHandler({ searcher, indexer, metadataStore }, async (port) => {
      const seedHidden = await callTool(port, 'find_usages', { chunk_id: OUT_OF_SCOPE_CHUNK });
      expect(seedHidden.text).toContain('Chunk not found');

      const { text } = await callTool(port, 'find_usages', { chunk_id: IN_SCOPE_CHUNK });
      expect(text).toContain('src/checkout.ts');
      expect(text).not.toContain('handbook');
      expect(text).toContain('Incoming (1)');
    });
  });

  it('find_usages reads called_by and referenced_by as the stored edge types', async () => {
    const { searcher, indexer } = scopedMocks();
    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getEdgesTo).mockReturnValue([
      {
        from_chunk_id: 'g1//billing-v3//src/checkout.ts//5-9//h3',
        to_chunk_id: IN_SCOPE_CHUNK,
        relation_type: 'calls',
        symbol_name: 'charge',
      },
      {
        from_chunk_id: 'g1//billing-v3//src/registry.ts//0-4//h4',
        to_chunk_id: IN_SCOPE_CHUNK,
        relation_type: 'references',
        symbol_name: 'Invoice',
      },
    ] as never);
    (metadataStore as unknown as { getGroupDegreeSnapshot: unknown }).getGroupDegreeSnapshot = vi
      .fn()
      .mockReturnValue({ hubChunkIds: new Set(), calledHubChunkIds: new Set() });

    await withHandler({ searcher, indexer, metadataStore }, async (port) => {
      const called = await callTool(port, 'find_usages', {
        chunk_id: IN_SCOPE_CHUNK,
        relation_types: ['called_by'],
      });
      expect(called.text).toContain('src/checkout.ts');
      expect(called.text).not.toContain('src/registry.ts');

      const referenced = await callTool(port, 'find_usages', {
        chunk_id: IN_SCOPE_CHUNK,
        relation_types: ['referenced_by'],
      });
      expect(referenced.text).toContain('src/registry.ts');
      expect(referenced.text).not.toContain('src/checkout.ts');
    });
  });

  it('change_impact refuses an out-of-scope seed and hides out-of-scope callers', async () => {
    const { searcher, indexer } = scopedMocks();
    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getEdgesTo).mockImplementation((id: string) =>
      id === IN_SCOPE_CHUNK
        ? ([
            {
              from_chunk_id: 'g1//billing-v3//src/checkout.ts//5-9//h3',
              to_chunk_id: IN_SCOPE_CHUNK,
              relation_type: 'calls',
              symbol_name: 'charge',
            },
            {
              from_chunk_id: OUT_OF_SCOPE_CHUNK,
              to_chunk_id: IN_SCOPE_CHUNK,
              relation_type: 'calls',
              symbol_name: 'charge',
            },
          ] as never)
        : []
    );

    await withHandler({ searcher, indexer, metadataStore }, async (port) => {
      const hidden = await callTool(port, 'change_impact', { chunk_id: OUT_OF_SCOPE_CHUNK });
      expect(hidden.text).toContain('Chunk not found');

      const { text } = await callTool(port, 'change_impact', { chunk_id: IN_SCOPE_CHUNK });
      expect(text).toContain('src/checkout.ts');
      expect(text).not.toContain('handbook');
      expect(text).toContain('1 chunks in 1 files depend on it');
    });
  });

  it('list_projects lists only in-scope projects', async () => {
    const { searcher, indexer } = scopedMocks();
    vi.mocked(indexer.listProjectsInGroup).mockResolvedValue([
      { name: 'billing', chunks: 12, languages: ['typescript'] },
      { name: 'handbook', chunks: 40, languages: ['generic'] },
    ]);
    await withHandler({ searcher, indexer }, async (port) => {
      const { text } = await callTool(port, 'list_projects', {});
      expect(text).toContain('billing');
      expect(text).not.toContain('handbook');
      expect(text).toContain('(12 total chunks)');
    });
  });

  it('search_docs restricts docs to the scope and hides glossary terms of hidden projects', async () => {
    const { searcher, indexer } = scopedMocks();
    const docsStore = { search: vi.fn().mockResolvedValue([]) };
    const term = (name: string, project?: string) => ({
      id: name,
      term: name,
      definition: `${name} definition`,
      aliases: [],
      ...(project ? { project } : {}),
      createdAt: 0,
      updatedAt: 0,
      score: 0.9,
    });
    const terminologyStore = {
      search: vi
        .fn()
        .mockResolvedValue([
          term('ledger'),
          term('invoice run', 'billing'),
          term('style guide', 'handbook'),
        ]),
    };
    await withHandler(
      {
        searcher,
        indexer,
        docsStore: docsStore as never,
        terminologyStore: terminologyStore as never,
      },
      async (port) => {
        const { text } = await callTool(port, 'search_docs', { query: 'how are invoices run' });
        expect(docsStore.search).toHaveBeenCalledWith(
          'g1',
          'how are invoices run',
          expect.objectContaining({ projects: ['billing'] })
        );
        expect(text).toContain('ledger');
        expect(text).toContain('invoice run');
        expect(text).not.toContain('style guide');
      }
    );
  });

  it('search_docs on an unscoped server passes no project restriction', async () => {
    const docsStore = { search: vi.fn().mockResolvedValue([]) };
    await withHandler({ docsStore: docsStore as never }, async (port) => {
      await callTool(port, 'search_docs', { query: 'anything' });
      const opts = docsStore.search.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('projects');
    });
  });

  it('term_search and term_list keep group-wide terms but hide other projects', async () => {
    const { searcher, indexer } = scopedMocks();
    const terms = [
      {
        id: '1',
        term: 'ledger',
        definition: 'd',
        aliases: [],
        createdAt: 0,
        updatedAt: 0,
        score: 1,
      },
      {
        id: '2',
        term: 'invoice run',
        definition: 'd',
        aliases: [],
        project: 'billing',
        createdAt: 0,
        updatedAt: 0,
        score: 1,
      },
      {
        id: '3',
        term: 'style guide',
        definition: 'd',
        aliases: [],
        project: 'handbook',
        createdAt: 0,
        updatedAt: 0,
        score: 1,
      },
    ];
    const terminologyStore = {
      search: vi.fn().mockResolvedValue(terms),
      list: vi.fn().mockResolvedValue(terms),
    };
    await withHandler(
      { searcher, indexer, terminologyStore: terminologyStore as never },
      async (port) => {
        for (const [tool, args] of [
          ['term_search', { query: 'guide' }],
          ['term_list', {}],
        ] as const) {
          const { text } = await callTool(port, tool, args);
          expect(text).toContain('ledger');
          expect(text).toContain('invoice run');
          expect(text).not.toContain('style guide');
        }
      }
    );
  });

  it('arch_suggest_components drops candidates from out-of-scope projects', async () => {
    const { searcher, indexer } = scopedMocks();
    const metadataStore = createMockMetadataStore();
    (metadataStore as unknown as { getTopByInDegree: unknown }).getTopByInDegree = vi
      .fn()
      .mockReturnValue([
        { chunkId: OUT_OF_SCOPE_CHUNK, degree: 50 },
        { chunkId: IN_SCOPE_CHUNK, degree: 10 },
      ]);
    const archStore = { listPoints: vi.fn().mockResolvedValue({ points: [], nextOffset: null }) };
    await withHandler(
      { searcher, indexer, metadataStore, archStore: archStore as never },
      async (port) => {
        const { text } = await callTool(port, 'arch_suggest_components', { group: 'g1' });
        expect(text).toContain('src/invoice.ts');
        expect(text).not.toContain('src/page.ts');
        expect(indexer.getChunkById).not.toHaveBeenCalledWith(OUT_OF_SCOPE_CHUNK);
      }
    );
  });

  it('arch_suggest_components filters by the stored project name when a suffix is set', async () => {
    const indexer = createMockIndexer('-v3');
    const metadataStore = createMockMetadataStore();
    const getTopByInDegree = vi.fn().mockReturnValue([]);
    (metadataStore as unknown as { getTopByInDegree: unknown }).getTopByInDegree = getTopByInDegree;
    const archStore = { listPoints: vi.fn() };
    await withHandler({ indexer, metadataStore, archStore: archStore as never }, async (port) => {
      await callTool(port, 'arch_suggest_components', { group: 'g1', project: 'billing' });
      // Chunk ids embed the stored name, so the prefix filter must use it.
      expect(getTopByInDegree).toHaveBeenCalledWith('g1', 50, 'billing-v3');
    });
  });

  it('write tools refuse a project the server is scoped away from', async () => {
    const { searcher, indexer } = scopedMocks();
    const archStore = {
      upsertComponent: vi.fn(),
      upsertDecision: vi.fn(),
      upsertLesson: vi.fn(),
    };
    const terminologyStore = { recordTerm: vi.fn() };
    await withHandler(
      {
        searcher,
        indexer,
        archStore: archStore as never,
        terminologyStore: terminologyStore as never,
      },
      async (port) => {
        const calls: Array<[string, Record<string, unknown>]> = [
          ['arch_record_component', { name: 'n', summary: 's' }],
          ['arch_record_decision', { title: 't', context: 'c', decision: 'd', consequences: 'q' }],
          ['arch_record_lesson', { rule: 'r', why: 'w', when: 'w' }],
          ['term_record', { term: 't', definition: 'd' }],
        ];
        for (const [tool, args] of calls) {
          const res = await callTool(port, tool, { group: 'g1', project: 'handbook', ...args });
          expect(res.isError).toBe(true);
          expect(res.text).toContain('Project "handbook" is not available on this server');
        }
        expect(archStore.upsertComponent).not.toHaveBeenCalled();
        expect(archStore.upsertDecision).not.toHaveBeenCalled();
        expect(archStore.upsertLesson).not.toHaveBeenCalled();
        expect(terminologyStore.recordTerm).not.toHaveBeenCalled();
      }
    );
  });

  it('arch_list, arch_delete and term_delete pass the project scope to the store', async () => {
    const { searcher, indexer } = scopedMocks();
    const archStore = {
      listPoints: vi.fn().mockResolvedValue({ points: [], nextOffset: null }),
      deletePoints: vi.fn().mockResolvedValue({ deleted: [], notFound: ['x'] }),
    };
    const terminologyStore = { deleteTerm: vi.fn().mockResolvedValue('not_found') };
    await withHandler(
      {
        searcher,
        indexer,
        archStore: archStore as never,
        terminologyStore: terminologyStore as never,
      },
      async (port) => {
        await callTool(port, 'arch_list', { group: 'g1' });
        const listAllow = archStore.listPoints.mock.calls[0]![1].allowProject as (
          p: string
        ) => boolean;
        await callTool(port, 'arch_delete', { group: 'g1', ids: ['x'] });
        const deleteAllow = archStore.deletePoints.mock.calls[0]![2] as (p: string) => boolean;
        const { text } = await callTool(port, 'term_delete', { group: 'g1', id: 'x' });
        const termAllow = terminologyStore.deleteTerm.mock.calls[0]![2] as (p: string) => boolean;
        for (const allow of [listAllow, deleteAllow, termAllow]) {
          expect(allow('billing')).toBe(true);
          expect(allow('handbook')).toBe(false);
        }
        expect(text).toContain('No term with id x');
      }
    );
  });

  it('term_list shows each term id, so term_delete can be used', async () => {
    const terminologyStore = {
      list: vi.fn().mockResolvedValue([
        {
          id: '0190c2a0-0000-7000-8000-000000000001',
          term: 'ledger',
          definition: 'd',
          aliases: [],
          project: 'billing',
          createdAt: 0,
          updatedAt: 0,
        },
      ]),
    };
    await withHandler({ terminologyStore: terminologyStore as never }, async (port) => {
      const { text } = await callTool(port, 'term_list', { group: 'g1' });
      expect(text).toContain('id 0190c2a0-0000-7000-8000-000000000001, project billing');
    });
  });

  // ── explain_feature fan-out ───────────────────────────────────────────────

  it('explain_feature caps edges per seed and says the list was truncated', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: { tokensReturned: 0, estimatedFullFileTokens: 0, tokensSaved: 0, savingsPercent: 0 },
    });
    const seed = 'g1//p1//src/auth.ts//10-20//h1';
    const edge = (from: string, to: string) => ({
      from_chunk_id: from,
      to_chunk_id: to,
      relation_type: 'calls',
      symbol_name: 'authenticate',
    });
    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getEdgesTo).mockReturnValue(
      Array.from({ length: 30 }, (_, i) => edge(`g1//p1//src/in${i}.ts//0-1//x${i}`, seed)) as never
    );
    vi.mocked(metadataStore.getEdgesFrom).mockReturnValue(
      Array.from({ length: 25 }, (_, i) =>
        edge(seed, `g1//p1//src/out${i}.ts//0-1//y${i}`)
      ) as never
    );
    const indexer = createMockIndexer();

    await withHandler({ searcher, indexer, metadataStore }, async (port) => {
      const { text } = await callTool(
        port,
        'explain_feature',
        { question: 'How does authentication work?' },
        '/support/mcp'
      );
      expect(indexer.getChunkById).toHaveBeenCalledTimes(2 * EXPLAIN_FEATURE_EDGES_PER_SEED);
      expect(text).toContain('Truncated');
      expect(text).toContain('15 more edges');
    });
  });

  it('explain_feature does not mention truncation when nothing was cut', async () => {
    const searcher = createMockSearcher();
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
      results: [makeSearchResult()],
      total: 1,
      metrics: { tokensReturned: 0, estimatedFullFileTokens: 0, tokensSaved: 0, savingsPercent: 0 },
    });
    const metadataStore = createMockMetadataStore();
    vi.mocked(metadataStore.getEdgesTo).mockReturnValue([
      {
        from_chunk_id: 'g1//p1//src/a.ts//0-1//a',
        to_chunk_id: 'g1//p1//src/auth.ts//10-20//h1',
        relation_type: 'calls',
        symbol_name: 'authenticate',
      },
    ] as never);
    await withHandler({ searcher, metadataStore }, async (port) => {
      const { text } = await callTool(
        port,
        'explain_feature',
        { question: 'How does authentication work?' },
        '/support/mcp'
      );
      expect(text).toContain('## Related Modules');
      expect(text).not.toContain('Truncated');
    });
  });

  // ── Reserved group names on write tools ───────────────────────────────────

  it('write tools refuse a group name reserved for sidecar collections', async () => {
    const archStore = { upsertComponent: vi.fn() };
    const terminologyStore = { recordTerm: vi.fn() };
    await withHandler(
      { archStore: archStore as never, terminologyStore: terminologyStore as never },
      async (port) => {
        const component = await callTool(port, 'arch_record_component', {
          group: 'billing_docs',
          project: 'billing',
          name: 'invoice engine',
          summary: 'Does: builds invoices',
        });
        expect(component.isError).toBe(true);
        expect(component.text).toContain('reserved');
        expect(archStore.upsertComponent).not.toHaveBeenCalled();

        const term = await callTool(port, 'term_record', {
          group: 'billing_terms',
          term: 'ledger',
          definition: 'The book of record.',
        });
        expect(term.isError).toBe(true);
        expect(terminologyStore.recordTerm).not.toHaveBeenCalled();
      }
    );
  });
});

describe('describeStaleness', () => {
  const YEAR = 365 * 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;

  it('says nothing when the age is unknown', () => {
    // A fabricated age is worse than none: silence must not read as "current".
    expect(describeStaleness({ lastModifiedAt: null }, NOW, YEAR)).toBe('');
  });

  it('says nothing for a document younger than the threshold', () => {
    expect(describeStaleness({ lastModifiedAt: NOW - YEAR + 1000 }, NOW, YEAR)).toBe('');
  });

  it('reports months once past the threshold', () => {
    const out = describeStaleness({ lastModifiedAt: NOW - 400 * 24 * 60 * 60 * 1000 }, NOW, YEAR);
    expect(out).toContain('13 months ago');
    expect(out).toContain('may describe behaviour that has since changed');
  });

  it('switches to years past two years', () => {
    const out = describeStaleness({ lastModifiedAt: NOW - 3 * YEAR }, NOW, YEAR);
    expect(out).toContain('3 years ago');
  });

  it('ignores a non-finite timestamp instead of rendering NaN', () => {
    expect(describeStaleness({ lastModifiedAt: NaN }, NOW, YEAR)).toBe('');
  });
});

describe('describeGlossary', () => {
  it('renders nothing when no term matched', () => {
    expect(describeGlossary([])).toBe('');
  });

  it('renders term, aliases and definition ahead of the results', () => {
    const out = describeGlossary([
      { term: 'ACO', definition: 'Automated campaign optimiser.', aliases: ['auto-opt'] },
    ]);
    expect(out).toContain('## Glossary');
    expect(out).toContain('**ACO**');
    expect(out).toContain('auto-opt');
    expect(out).toContain('Automated campaign optimiser.');
    // Separator so the terms never read as part of the first excerpt.
    expect(out.endsWith('---\n\n')).toBe(true);
  });

  it('omits the aliases clause when there are none', () => {
    const out = describeGlossary([{ term: 'ACO', definition: 'A thing.', aliases: [] }]);
    expect(out).not.toContain('aka');
  });

  it('keeps the glossary above the results, not merged into them', () => {
    // The terms are context, not an answer — a term can match a question it does
    // not resolve, so it must be visibly separate from the retrieved excerpts.
    const out = describeGlossary([{ term: 'A', definition: 'd', aliases: [] }]);
    expect(out.indexOf('## Glossary')).toBeLessThan(out.indexOf('---'));
  });
});

describe('GLOSSARY_MIN_SCORE', () => {
  it('clears the highest score an absent-topic query reached', () => {
    // Re-measured at 75 terms on the instructed query path, where absent topics top
    // out at 0.399 — they reached 0.645 before the instruction was applied, which is
    // why this floor had to move with it.
    expect(GLOSSARY_MIN_SCORE).toBeGreaterThan(0.399);
  });

  it('stays low enough to still answer direct questions about a term', () => {
    // 0.50 surfaces the term for all 10 probes phrased directly about one; 0.55 drops
    // to 9/10 and 0.65 to 6/10, all without removing any absent-topic leak.
    expect(GLOSSARY_MIN_SCORE).toBeLessThanOrEqual(0.5);
  });
});

describe('TERM_LOOKUP_MIN_SCORE', () => {
  it('clears the highest negative measured on the instructed path', () => {
    // Swept over 40 negatives — invented acronyms, off-domain questions, and
    // in-domain concepts the glossary genuinely lacks. The highest scored
    // 0.515 (an invented acronym pulled toward a real one by letter overlap).
    expect(TERM_LOOKUP_MIN_SCORE).toBeGreaterThan(0.515);
  });

  it('stays low enough to keep the answers the vector does find', () => {
    // The bands overlap slightly, so this cannot be raised for safety alone: at 0.70
    // the floor drops 16 correct answers to remove 5 wrong ones. 0.55 keeps 67/75.
    expect(TERM_LOOKUP_MIN_SCORE).toBeLessThanOrEqual(0.6);
  });

  it('is stricter than the docs sidecar floor', () => {
    // Different failure costs: the sidecar volunteers context and a near-miss is
    // merely noise beside results that already answer the question, whereas
    // term_search was asked directly and a near-miss *is* the answer.
    expect(TERM_LOOKUP_MIN_SCORE).toBeGreaterThan(GLOSSARY_MIN_SCORE);
  });
});

describe('describeExcerpt', () => {
  it('says nothing when the excerpt is the whole document', () => {
    expect(describeExcerpt({ docChunkCount: 2, includedChunks: [0, 1], file: 'a.md' })).toBe('');
  });

  it('says nothing when the total is unknown', () => {
    // Better silent than "section 1 of 0".
    expect(describeExcerpt({ docChunkCount: 0, includedChunks: [0], file: 'a.md' })).toBe('');
  });

  it('reports a single section with 1-based numbering', () => {
    const out = describeExcerpt({ docChunkCount: 8, includedChunks: [2], file: 'a.md' });
    expect(out).toContain('section 3 of 8');
  });

  it('reports a range when several sections are merged', () => {
    const out = describeExcerpt({ docChunkCount: 65, includedChunks: [30, 31, 32], file: 'b.md' });
    expect(out).toContain('sections 31-33 of 65');
    expect(out).toContain('`b.md`');
  });
});

describe('tool annotations', () => {
  interface ListedTool {
    name: string;
    title?: string;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  }

  /**
   * Drive a real `tools/list` over HTTP and return the tools as the wire carries them.
   *
   * The arch, glossary, docs and analytics tools only register when their store is
   * wired up, so all four are stubbed — `tools/list` never calls into them, it only
   * needs them present for registration to happen.
   */
  async function listTools(path: '/mcp' | '/support/mcp'): Promise<ListedTool[]> {
    const projects = new Map<string, ProjectConfig[]>([['test-group', [createProjectConfig()]]]);
    const handler = new McpHandler({
      searcher: createMockSearcher(),
      indexer: createMockIndexer(),
      getProjects: () => projects,
      getGroupNames: () => Array.from(projects.keys()),
      metadataStore: createMockMetadataStore(),
      archStore: {} as never,
      docsStore: {} as never,
      terminologyStore: {} as never,
      analytics: {} as never,
    });

    const app = express();
    app.use(express.json());
    handler.mount(app);
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    try {
      const initRes = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sessionId! },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const body = (await parseMcpResponse(res)) as { result?: { tools?: ListedTool[] } };
      return body.result?.tools ?? [];
    } finally {
      server.close();
      handler.destroy();
    }
  }

  const READ_ONLY_TOOLS = [
    'search_code',
    'search_docs',
    'get_chunk',
    'find_usages',
    'change_impact',
    'module_map',
    'list_projects',
    'health_check',
    'term_search',
    'term_list',
    'arch_context',
    'arch_list',
    'arch_suggest_components',
  ];

  it('annotates every tool and gives it a title', async () => {
    // A tool registered without annotations inherits the spec's pessimistic
    // defaults silently, so absence is the failure worth guarding.
    for (const path of ['/mcp', '/support/mcp'] as const) {
      const tools = await listTools(path);
      expect(tools.length, `${path} should expose tools`).toBeGreaterThan(0);

      const unannotated = tools.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean');
      expect(
        unannotated.map((t) => t.name),
        `${path}: missing annotations`
      ).toEqual([]);

      const untitled = tools.filter((t) => !t.title);
      expect(
        untitled.map((t) => t.name),
        `${path}: missing title`
      ).toEqual([]);
    }
  });

  it('keeps the support endpoint read-only', async () => {
    // Support users have no code access and act on customers' behalf; nothing
    // they run may change the index, the glossary or the arch layer.
    const writers = (await listTools('/support/mcp')).filter(
      (t) => t.annotations?.readOnlyHint !== true
    );
    expect(writers.map((t) => t.name)).toEqual([]);
  });

  it('marks queries read-only in a closed domain', async () => {
    const tools = await listTools('/mcp');

    for (const name of READ_ONLY_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, `${name} should be read-only`).toBe(true);
      expect(tool?.annotations?.openWorldHint, `${name} is a closed domain`).toBe(false);
    }
  });

  it('omits destructiveHint and idempotentHint on read-only tools', async () => {
    // The spec: both are "meaningful only when readOnlyHint == false".
    const tools = await listTools('/mcp');

    for (const name of READ_ONLY_TOOLS) {
      const annotations = tools.find((t) => t.name === name)?.annotations;
      expect(annotations, `${name} should be registered`).toBeDefined();
      expect(annotations, `${name} should not carry destructiveHint`).not.toHaveProperty(
        'destructiveHint'
      );
      expect(annotations, `${name} should not carry idempotentHint`).not.toHaveProperty(
        'idempotentHint'
      );
    }
  });

  it('marks name-keyed writes additive and idempotent', async () => {
    // Overwrite-in-place by name: a repeat call leaves the store in the same state.
    const tools = await listTools('/mcp');

    for (const name of ['arch_record_component', 'arch_record_lesson', 'term_record']) {
      const annotations = tools.find((t) => t.name === name)?.annotations;
      expect(annotations, `${name} should be registered`).toBeDefined();
      expect(annotations?.readOnlyHint, `${name} writes`).toBe(false);
      expect(annotations?.destructiveHint, `${name} is additive`).toBe(false);
      expect(annotations?.idempotentHint, `${name} overwrites by name`).toBe(true);
    }
  });

  it('does not claim idempotency for arch_record_decision', async () => {
    // It mints a fresh id per call; the duplicate guard is a similarity
    // threshold, not a guarantee. Absent means the spec default `false`.
    const annotations = (await listTools('/mcp')).find(
      (t) => t.name === 'arch_record_decision'
    )?.annotations;

    expect(annotations, 'arch_record_decision should be registered').toBeDefined();
    expect(annotations?.readOnlyHint).toBe(false);
    expect(annotations?.destructiveHint).toBe(false);
    expect(annotations).not.toHaveProperty('idempotentHint');
  });

  it('marks deletions non-read-only and idempotent, leaving destructiveHint default', async () => {
    const tools = await listTools('/mcp');

    for (const name of ['delete_project', 'arch_delete', 'term_delete']) {
      const annotations = tools.find((t) => t.name === name)?.annotations;
      expect(annotations, `${name} should be registered`).toBeDefined();
      expect(annotations?.readOnlyHint, `${name} is not read-only`).toBe(false);
      expect(annotations?.idempotentHint, `${name} deleting twice is a no-op`).toBe(true);
      // `destructiveHint: true` is already the spec default — asserting it is noise.
      expect(annotations, `${name} should leave destructiveHint default`).not.toHaveProperty(
        'destructiveHint'
      );
    }
  });

  it('annotates support-mode tools too', async () => {
    const tools = await listTools('/support/mcp');

    for (const name of ['explain_feature', 'impact_analysis', 'token_savings_report']) {
      const annotations = tools.find((t) => t.name === name)?.annotations;
      expect(annotations, `${name} should be registered in support mode`).toBeDefined();
      expect(annotations?.readOnlyHint, `${name} is read-only`).toBe(true);
      expect(annotations?.openWorldHint, `${name} is a closed domain`).toBe(false);
    }

    // Support mode deliberately exposes no arch tools and no delete_project.
    expect(tools.find((t) => t.name === 'delete_project')).toBeUndefined();
  });
});

describe('tool call telemetry', () => {
  /**
   * Guards the wiring between tool registration and `recordToolCall`. The
   * instrumentation is installed by patching the registration method, so it is
   * silently lost if registration moves to a method that is not patched — the
   * handlers keep working and only the telemetry disappears. Asserting on a
   * real tools/call over HTTP is what makes that visible.
   */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    telemetry: { recordToolCall: ReturnType<typeof vi.fn> }
  ): Promise<void> {
    const app = express();
    app.use(express.json());
    const handler = new McpHandler({
      searcher: createMockSearcher(),
      indexer: createMockIndexer(),
      getProjects: () => new Map([['g1', [createProjectConfig()]]]),
      getGroupNames: () => ['g1'],
      telemetry: telemetry as never,
      indexerHealth: async () => ({ reachable: false, url: 'http://indexer', repos: [] }),
    });
    handler.mount(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const initRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      const sessionId = initRes.headers.get('mcp-session-id');
      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      // The answer arrives once the tool has run, telemetry included.
      await callRes.text();
    } finally {
      server.close();
      handler.destroy();
    }
  }

  it('records a tool call under its real MCP tool name', async () => {
    const telemetry = { recordToolCall: vi.fn() };
    await callTool('search_code', { query: 'authentication', limit: 5 }, telemetry);

    expect(telemetry.recordToolCall).toHaveBeenCalledTimes(1);
    const event = telemetry.recordToolCall.mock.calls[0]?.[0] as {
      tool: string;
      ok: boolean;
      durationMs: number;
      error: string | null;
    };
    // The MCP tool name, not the Searcher method that served it.
    expect(event.tool).toBe('search_code');
    expect(event.ok).toBe(true);
    expect(event.error).toBeNull();
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records health_check, which no search telemetry would cover', async () => {
    // search_events only ever sees tools that run a search; tool_calls is the
    // only place a non-search tool shows up at all.
    const telemetry = { recordToolCall: vi.fn() };
    await callTool('health_check', {}, telemetry);

    expect(telemetry.recordToolCall).toHaveBeenCalledTimes(1);
    expect(telemetry.recordToolCall.mock.calls[0]?.[0]?.tool).toBe('health_check');
  });
});
