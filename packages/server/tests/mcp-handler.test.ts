import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import {
  McpHandler,
  describeExcerpt,
  describeGlossary,
  describeStaleness,
  GLOSSARY_MIN_SCORE,
  TERM_LOOKUP_MIN_SCORE,
} from '../src/mcp-handler.js';
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
    getChunkById: vi.fn().mockResolvedValue(null),
    storedProjectName: vi.fn((name: string) => (suffix ? `${name}${suffix}` : name)),
  } as unknown as Indexer;
}

function createMockMetadataStore(): MetadataStore {
  return {
    getCommits: vi.fn().mockReturnValue([]),
    getTickets: vi.fn().mockReturnValue([]),
    getEdgesTo: vi.fn().mockReturnValue([]),
    getEdgesFrom: vi.fn().mockReturnValue([]),
    deleteByProject: vi.fn(),
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
        // Labels the search event so search_code is distinguishable from the
        // other tools that reach expandedSearch.
        tool: 'search_code',
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
      expect(indexer.deleteProjectChunks).toHaveBeenCalledWith('g1', 'test-project');
      expect(removeProject).toHaveBeenCalledWith('g1', 'test-project');
    } finally {
      server.close();
      handler2.destroy();
    }
  });

  // ── delete_project suffix behavior (PAPARATS_PROJECT_SUFFIX) ───────────────

  /** Spin up a handler + server, call delete_project, return metadataStore. */
  async function runDeleteProject(
    indexer: Indexer,
    metadataStore: MetadataStore,
    args: { group: string; project: string }
  ): Promise<{ text: string }> {
    const app = express();
    app.use(express.json());

    const handler2 = new McpHandler({
      searcher: createMockSearcher(),
      indexer,
      getProjects: () => new Map([[args.group, [createProjectConfig()]]]),
      getGroupNames: () => [args.group],
      metadataStore,
    });
    handler2.mount(app);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const { text } = await callTool(port, 'delete_project', args);
      return { text };
    } finally {
      server.close();
      handler2.destroy();
    }
  }

  it('delete_project passes the SUFFIXED name to metadataStore.deleteByProject when a suffix is set', async () => {
    const indexer = createMockIndexer('-v3');
    const metadataStore = createMockMetadataStore();

    const { text } = await runDeleteProject(indexer, metadataStore, {
      group: 'g1',
      project: 'billing',
    });

    // Clean name surfaces at the MCP boundary + user-facing text.
    expect(text).toContain('Deleted project');
    expect(text).toContain('billing');
    // Qdrant side gets the CLEAN name — deleteProjectChunks suffixes internally.
    expect(indexer.deleteProjectChunks).toHaveBeenCalledWith('g1', 'billing');
    // Metadata side must get the STORED (suffixed) name — chunk_id embeds it.
    expect(indexer.storedProjectName).toHaveBeenCalledWith('billing');
    expect(metadataStore.deleteByProject).toHaveBeenCalledWith('g1', 'billing-v3');
  });

  it('delete_project passes the clean name unchanged when no suffix is set', async () => {
    const indexer = createMockIndexer(''); // empty suffix = identity
    const metadataStore = createMockMetadataStore();

    await runDeleteProject(indexer, metadataStore, { group: 'g1', project: 'billing' });

    expect(indexer.deleteProjectChunks).toHaveBeenCalledWith('g1', 'billing');
    expect(indexer.storedProjectName).toHaveBeenCalledWith('billing');
    // No suffix → metadata gets the clean name.
    expect(metadataStore.deleteByProject).toHaveBeenCalledWith('g1', 'billing');
  });

  it('delete_project routes metadata deletion through storedProjectName (single source of truth)', async () => {
    const indexer = createMockIndexer('-v3');
    const metadataStore = createMockMetadataStore();

    await runDeleteProject(indexer, metadataStore, { group: 'g1', project: 'billing' });

    // The handler never constructs the stored name itself — the name handed to
    // deleteByProject is exactly what storedProjectName returned.
    const returned = vi.mocked(indexer.storedProjectName).mock.results[0]?.value;
    expect(returned).toBe('billing-v3');
    expect(metadataStore.deleteByProject).toHaveBeenCalledWith('g1', returned);
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
    // recruiting-adjacent concepts the glossary genuinely lacks. The highest scored
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
      await fetch(`http://127.0.0.1:${port}/mcp`, {
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
