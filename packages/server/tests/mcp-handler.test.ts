import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import { McpHandler } from '../src/mcp-handler.js';
import type { MetadataStore } from '../src/metadata-db.js';
import type { ProjectConfig, ChunkKind } from '../src/types.js';

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
    expandedSearch: searchMock,
    searchWithFilter: vi.fn().mockResolvedValue(emptyResponse),
    formatResults: vi.fn().mockReturnValue('No results found.'),
    getUsageStats: vi.fn().mockReturnValue({
      searchCount: 0,
      totalTokensSaved: 0,
      avgTokensSavedPerSearch: 0,
    }),
    getProjectScope: vi.fn().mockReturnValue(null),
  } as unknown as Searcher;
}

function createMockIndexer(): Indexer {
  return {
    listGroups: vi.fn().mockResolvedValue({}),
    getGroupStats: vi.fn().mockResolvedValue({ points: 0, status: 'not_indexed' }),
    reindexGroup: vi.fn().mockResolvedValue(0),
    getChunkById: vi.fn().mockResolvedValue(null),
  } as unknown as Indexer;
}

function createMockMetadataStore(): MetadataStore {
  return {
    getCommits: vi.fn().mockReturnValue([]),
    getTickets: vi.fn().mockReturnValue([]),
    getEdgesTo: vi.fn().mockReturnValue([]),
    getEdgesFrom: vi.fn().mockReturnValue([]),
  } as unknown as MetadataStore;
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
          'mcp-session-id': 'non-existent-session-id',
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
    vi.mocked(searcher.expandedSearch).mockResolvedValue({
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

      expect(searcher.expandedSearch).toHaveBeenCalledWith('g1', 'authentication', {
        project: 'all',
        limit: 10,
      });
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
      expect(parsed.groups).toEqual({ g1: 10, g2: 20 });
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  it('POST /mcp tools/call reindex returns job ID', async () => {
    const indexer = createMockIndexer();
    vi.mocked(indexer.reindexGroup).mockResolvedValue(5);

    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher: createMockSearcher(),
      indexer,
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
          params: { name: 'reindex', arguments: { group: 'g1' } },
        }),
      });

      expect(callRes.status).toBe(200);
      const callBody = (await parseMcpResponse(callRes)) as {
        result?: { content?: { text?: string }[] };
      };
      const text = callBody.result?.content?.[0]?.text;
      expect(text).toContain('Reindex started');
      expect(text).toMatch(/Job ID: [a-f0-9]+/);
      expect(text).toContain('health_check');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  // ── Orchestration tools ──────────────────────────────────────────────────

  /** Helper: init session + call tool in one shot */
  async function callTool(
    port: number,
    toolName: string,
    args: Record<string, unknown>,
    basePath = '/mcp'
  ): Promise<{ text: string; status: number }> {
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
      result?: { content?: { text?: string }[] };
    };
    return {
      text: callBody.result?.content?.[0]?.text ?? '',
      status: callRes.status,
    };
  }

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
});
