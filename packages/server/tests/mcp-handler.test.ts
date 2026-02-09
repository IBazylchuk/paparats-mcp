import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import { McpHandler } from '../src/mcp-handler.js';
import type { ProjectConfig } from '../src/types.js';

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
  const searchMock = vi.fn().mockResolvedValue({
    results: [],
    total: 0,
    metrics: {
      tokensReturned: 0,
      estimatedFullFileTokens: 0,
      tokensSaved: 0,
      savingsPercent: 0,
    },
  });
  return {
    search: searchMock,
    expandedSearch: searchMock,
    formatResults: vi.fn().mockReturnValue('No results found.'),
    getUsageStats: vi.fn().mockReturnValue({
      searchCount: 0,
      totalTokensSaved: 0,
      avgTokensSavedPerSearch: 0,
    }),
  } as unknown as Searcher;
}

function createMockIndexer(): Indexer {
  return {
    listGroups: vi.fn().mockResolvedValue({}),
    getGroupStats: vi.fn().mockResolvedValue({ points: 0, status: 'not_indexed' }),
    reindexGroup: vi.fn().mockResolvedValue(0),
  } as unknown as Indexer;
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
      extensions: [],
      chunkSize: 1024,
      overlap: 128,
      concurrency: 2,
      batchSize: 50,
    },
    watcher: { enabled: true, debounce: 1000 },
    embeddings: { provider: 'ollama', model: 'test', dimensions: 4 },
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

    expect(getSpy).toHaveBeenCalledWith('/sse', expect.any(Function));
    expect(postSpy).toHaveBeenCalledWith('/messages', expect.any(Function));
    expect(allSpy).toHaveBeenCalledWith('/mcp', expect.any(Function));

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
});
