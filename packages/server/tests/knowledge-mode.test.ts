import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createApp } from '../src/app.js';
import {
  KNOWLEDGE_MAX_BODY_BYTES,
  KNOWLEDGE_MAX_QUERY_CHARS,
  effectiveKnowledgeScope,
  parseKnowledgeModeEnv,
  type KnowledgeModeConfig,
} from '../src/knowledge-mode.js';
import {
  CODING_TOOLS,
  KNOWLEDGE_TOOLS,
  McpHandler,
  SUPPORT_TOOLS,
  pageDocument,
} from '../src/mcp-handler.js';
import { tctx } from '../src/telemetry/context.js';
import { prompts } from '../src/prompts/index.js';
import type { Searcher } from '../src/searcher.js';
import type { Indexer } from '../src/indexer.js';
import type { WatcherManager } from '../src/watcher.js';
import type { CachedEmbeddingProvider } from '../src/embeddings.js';
import type { DocsDocument, DocsSearchHit } from '../src/docs/types.js';
import type { ProjectConfig } from '../src/types.js';

const TOKEN = 'k'.repeat(32);
const OTHER_TOKEN = 'z'.repeat(40);

// ── parseKnowledgeModeEnv ──────────────────────────────────────────────────

describe('parseKnowledgeModeEnv', () => {
  const env = (vars: Record<string, string>) => vars;

  it('is off when neither tokens nor audience is set', () => {
    expect(parseKnowledgeModeEnv({})).toBeNull();
    // An unset `${VAR}` in a Compose file arrives as the empty string.
    expect(
      parseKnowledgeModeEnv(env({ PAPARATS_KNOWLEDGE_TOKENS: '', PAPARATS_KNOWLEDGE_AUDIENCE: '' }))
    ).toBeNull();
  });

  it('parses, trims and dedupes both lists', () => {
    expect(
      parseKnowledgeModeEnv(
        env({
          PAPARATS_KNOWLEDGE_TOKENS: ` ${TOKEN} , ${OTHER_TOKEN},${TOKEN}`,
          PAPARATS_KNOWLEDGE_AUDIENCE: 'client, public ,client',
          PAPARATS_KNOWLEDGE_PROJECTS: 'handbook, guides',
        })
      )
    ).toEqual({
      tokens: [TOKEN, OTHER_TOKEN],
      audience: ['client', 'public'],
      projects: ['handbook', 'guides'],
    });
    expect(
      parseKnowledgeModeEnv(
        env({ PAPARATS_KNOWLEDGE_TOKENS: TOKEN, PAPARATS_KNOWLEDGE_AUDIENCE: 'client' })
      )?.projects
    ).toBeNull();
  });

  it.each([
    [{ PAPARATS_KNOWLEDGE_TOKENS: TOKEN }, /PAPARATS_KNOWLEDGE_AUDIENCE is not set/],
    [{ PAPARATS_KNOWLEDGE_AUDIENCE: 'client' }, /PAPARATS_KNOWLEDGE_TOKENS is not set/],
    [
      { PAPARATS_KNOWLEDGE_TOKENS: TOKEN, PAPARATS_KNOWLEDGE_AUDIENCE: '' },
      /PAPARATS_KNOWLEDGE_AUDIENCE is not set/,
    ],
    [{ PAPARATS_KNOWLEDGE_PROJECTS: 'handbook' }, /knowledge mode is off/],
  ])('refuses a half configuration: %j', (vars, message) => {
    expect(() => parseKnowledgeModeEnv(vars)).toThrow(message);
  });

  it.each([
    [{ PAPARATS_KNOWLEDGE_TOKENS: ' , ', PAPARATS_KNOWLEDGE_AUDIENCE: 'client' }, /no tokens/],
    [{ PAPARATS_KNOWLEDGE_TOKENS: TOKEN, PAPARATS_KNOWLEDGE_AUDIENCE: '   ' }, /no labels/],
    [
      {
        PAPARATS_KNOWLEDGE_TOKENS: TOKEN,
        PAPARATS_KNOWLEDGE_AUDIENCE: 'client',
        PAPARATS_KNOWLEDGE_PROJECTS: ' ,',
      },
      /no projects/,
    ],
  ])('refuses a value that is empty after trimming: %j', (vars, message) => {
    expect(() => parseKnowledgeModeEnv(vars)).toThrow(message);
  });

  it('refuses a weak or malformed token without echoing it', () => {
    for (const bad of ['changeme', `${'a'.repeat(20)} spaced`, `${'a'.repeat(20)}"`]) {
      let message = '';
      try {
        parseKnowledgeModeEnv({
          PAPARATS_KNOWLEDGE_TOKENS: `${TOKEN},${bad}`,
          PAPARATS_KNOWLEDGE_AUDIENCE: 'client',
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/token #2 is not usable/);
      expect(message).not.toContain(bad);
      expect(message).not.toContain(TOKEN);
    }
  });

  it('refuses a malformed label and the internal label', () => {
    expect(() =>
      parseKnowledgeModeEnv({
        PAPARATS_KNOWLEDGE_TOKENS: TOKEN,
        PAPARATS_KNOWLEDGE_AUDIENCE: 'Client',
      })
    ).toThrow(/PAPARATS_KNOWLEDGE_AUDIENCE label/);
    // Every unlabelled document reads as internal, so allowing it would publish them all.
    expect(() =>
      parseKnowledgeModeEnv({
        PAPARATS_KNOWLEDGE_TOKENS: TOKEN,
        PAPARATS_KNOWLEDGE_AUDIENCE: 'client,internal',
      })
    ).toThrow(/must not include "internal"/);
  });
});

describe('effectiveKnowledgeScope', () => {
  it('lets the process-wide settings narrow the mode, never widen it', () => {
    const scope = { audience: ['client', 'public'], projects: ['handbook'] };
    expect(effectiveKnowledgeScope(scope, { docsAudience: null, projects: null })).toEqual(scope);
    expect(
      effectiveKnowledgeScope(scope, {
        docsAudience: ['public', 'partner'],
        projects: ['handbook', 'billing'],
      })
    ).toEqual({ audience: ['public'], projects: ['handbook'] });
    expect(
      effectiveKnowledgeScope(
        { audience: ['client'], projects: null },
        { docsAudience: ['partner'], projects: ['billing'] }
      )
    ).toEqual({ audience: [], projects: ['billing'] });
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

interface FakeDoc {
  project: string;
  file: string;
  /** Undefined = a chunk stored without the field, which reads as internal. */
  audience?: string;
  title: string;
  sections: Array<{ headingPath: string[]; text: string }>;
}

const CORPUS: FakeDoc[] = [
  {
    project: 'handbook',
    file: 'leave.md',
    audience: 'client',
    title: 'Leave policy',
    sections: [
      { headingPath: [], text: 'How leave works.' },
      { headingPath: ['Requesting'], text: 'Submit the form.' },
      { headingPath: ['Requesting', 'Approval'], text: 'A manager approves it.' },
    ],
  },
  {
    project: 'handbook',
    file: 'faq.md',
    audience: 'public',
    title: 'FAQ',
    sections: [{ headingPath: [], text: 'Answers.' }],
  },
  {
    project: 'handbook',
    file: 'salaries.md',
    audience: 'internal',
    title: 'Salary bands',
    sections: [{ headingPath: [], text: 'Internal only.' }],
  },
  {
    project: 'handbook',
    file: 'unlabelled.md',
    title: 'Unlabelled',
    sections: [{ headingPath: [], text: 'No label at all.' }],
  },
  {
    project: 'billing',
    file: 'invoices.md',
    audience: 'client',
    title: 'Invoices',
    sections: [{ headingPath: [], text: 'A client doc outside the allowlist.' }],
  },
];

/** What Qdrant's filter does: match-any on audience never matches a missing field. */
function audienceMatches(doc: FakeDoc, audience: string[] | undefined): boolean {
  if (audience === undefined) return true;
  return doc.audience !== undefined && audience.includes(doc.audience);
}

function toHit(doc: FakeDoc, score: number): DocsSearchHit {
  const crumb = [doc.title, ...(doc.sections[0]?.headingPath ?? [])].join(' > ');
  return {
    docId: `id-${doc.file}`,
    docTitle: doc.title,
    headingPath: doc.sections[0]?.headingPath ?? [],
    sourceUrl: `https://docs.example.com/${doc.file}`,
    file: doc.file,
    project: doc.project,
    audience: doc.audience ?? 'internal',
    chunkIndex: 0,
    content: `${crumb}\n\n${doc.sections[0]?.text ?? ''}`,
    startLine: 0,
    endLine: 3,
    score,
    docChunkCount: doc.sections.length,
    includedChunks: [0],
    kind: 'prose',
    lastModifiedAt: 1_700_000_000_000,
  };
}

function toDocument(doc: FakeDoc): DocsDocument {
  return {
    project: doc.project,
    file: doc.file,
    docTitle: doc.title,
    sourceUrl: `https://docs.example.com/${doc.file}`,
    audience: doc.audience ?? 'internal',
    kind: 'prose',
    lastModifiedAt: 1_700_000_000_000,
    sections: doc.sections.map((s, i) => ({
      index: i,
      headingPath: s.headingPath,
      text: s.text,
      startLine: i * 10,
      endLine: i * 10 + 5,
    })),
  };
}

/** A docs store that applies the same project/audience filters Qdrant would. */
function fakeDocsStore(corpus: FakeDoc[] = CORPUS) {
  return {
    search: vi.fn(
      async (
        _group: string,
        _query: string,
        opts: { project?: string; projects?: string[]; audience?: string | string[] }
      ) => {
        const audience =
          opts.audience === undefined
            ? undefined
            : Array.isArray(opts.audience)
              ? opts.audience
              : [opts.audience];
        return corpus
          .filter(
            (d) =>
              audienceMatches(d, audience) &&
              (opts.projects === undefined || opts.projects.includes(d.project)) &&
              (opts.project === undefined || d.project === opts.project)
          )
          .map((d, i) => toHit(d, 1 / (i + 1)));
      }
    ),
    getDocument: vi.fn(
      async (_group: string, project: string, file: string, opts: { audience?: string[] } = {}) => {
        const doc = corpus.find(
          (d) => d.project === project && d.file === file && audienceMatches(d, opts.audience)
        );
        return doc ? toDocument(doc) : null;
      }
    ),
  };
}

function projectConfig(name: string): ProjectConfig {
  return {
    name,
    path: '',
    group: 'g1',
    languages: ['generic'],
    patterns: [],
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
    embeddings: { provider: 'llama', model: 'test', dimensions: 4 },
    metadata: {
      service: name,
      bounded_context: null,
      tags: [],
      directory_tags: {},
      git: { enabled: false, maxCommitsPerFile: 50, ticketPatterns: [] },
    },
  };
}

function mockSearcher(projectScope: string[] | null = null): Searcher {
  return {
    search: vi.fn(),
    getUsageStats: vi.fn().mockReturnValue({ searchCount: 0, totalTokensSaved: 0 }),
    getQueryCacheStats: vi.fn().mockReturnValue(null),
    invalidateGroupCache: vi.fn(),
    getProjectScope: vi.fn().mockReturnValue(projectScope),
  } as unknown as Searcher;
}

function mockIndexer(): Indexer {
  return {
    // Group sync on `initialize` must keep g1, not prune it as stale.
    listGroups: vi.fn().mockResolvedValue({ g1: 10 }),
    listProjectsInGroup: vi.fn().mockResolvedValue([{ name: 'handbook', languages: [] }]),
    getGroupStats: vi.fn().mockResolvedValue({ points: 0, status: 'not_indexed' }),
    storedProjectName: vi.fn((name: string) => name),
  } as unknown as Indexer;
}

const KNOWLEDGE: KnowledgeModeConfig = {
  tokens: [TOKEN, OTHER_TOKEN],
  audience: ['client', 'public'],
  projects: ['handbook'],
};

interface Started {
  port: number;
  docsStore: ReturnType<typeof fakeDocsStore>;
  terminologyStore: { search: ReturnType<typeof vi.fn> };
  telemetry: { recordToolCall: ReturnType<typeof vi.fn> };
  seen: Array<{ tool: string; mode: string | null; user: string }>;
}

const running: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

async function start(
  opts: {
    knowledgeMode?: KnowledgeModeConfig;
    docsAudienceScope?: string[];
    projectScope?: string[] | null;
  } = {}
): Promise<Started> {
  const docsStore = fakeDocsStore();
  const terminologyStore = {
    search: vi
      .fn()
      .mockResolvedValue([{ term: 'PTO', definition: 'Paid time off.', aliases: [], score: 0.9 }]),
  };
  const seen: Started['seen'] = [];
  const telemetry = {
    recordToolCall: vi.fn((event: { tool: string }) => {
      const ctx = tctx.getOrAnonymous();
      seen.push({ tool: event.tool, mode: ctx.mcpMode, user: ctx.user });
    }),
  };
  const created = createApp({
    searcher: mockSearcher(opts.projectScope ?? null),
    indexer: mockIndexer(),
    watcherManager: { getStats: vi.fn() } as unknown as WatcherManager,
    embeddingProvider: { getCacheStats: vi.fn() } as unknown as CachedEmbeddingProvider,
    projectsByGroup: new Map([['g1', [projectConfig('handbook')]]]),
    docsStore: docsStore as never,
    terminologyStore: terminologyStore as never,
    telemetry: telemetry as never,
    ...(opts.docsAudienceScope ? { docsAudienceScope: opts.docsAudienceScope } : {}),
    ...(opts.knowledgeMode ? { knowledgeMode: opts.knowledgeMode } : {}),
  });
  const server: Server = created.app.listen(0);
  const port = (server.address() as { port: number }).port;
  running.push(async () => {
    created.stopGroupPoll();
    created.mcpHandler.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port, docsStore, terminologyStore, telemetry, seen };
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

let nextId = 1;
function rpcBody(method: string, params: unknown = {}) {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
  path = '/knowledge/mcp'
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Parse a JSON or SSE-framed MCP response. */
async function readRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.startsWith('{')) return JSON.parse(text) as Record<string, unknown>;
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  if (!data) throw new Error(`Cannot parse MCP response: ${text.slice(0, 200)}`);
  return JSON.parse(data.slice(6)) as Record<string, unknown>;
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1.0.0' },
};

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callTool(
  port: number,
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<ToolResult> {
  const res = await post(port, rpcBody('tools/call', { name, arguments: args }), headers);
  expect(res.status).toBe(200);
  const body = await readRpc(res);
  return body['result'] as ToolResult;
}

// ── Route ───────────────────────────────────────────────────────────────────

describe('/knowledge/mcp', () => {
  it('is not mounted when the mode is unconfigured', async () => {
    const { port } = await start();
    const res = await post(port, rpcBody('initialize', INIT_PARAMS));
    expect(res.status).toBe(404);
  });

  it('answers 401 with a Bearer challenge before any MCP handling', async () => {
    const { port, docsStore } = await start({ knowledgeMode: KNOWLEDGE });
    for (const headers of [
      {},
      { Authorization: 'Bearer wrong-token-of-enough-length' },
      { Authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}` },
      { Authorization: `Bearer ${TOKEN}x` },
    ]) {
      for (const body of [
        rpcBody('initialize', INIT_PARAMS),
        rpcBody('tools/list'),
        rpcBody('tools/call', { name: 'search_docs', arguments: { query: 'leave' } }),
      ]) {
        const res = await post(port, body, headers);
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
        expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
      }
    }
    expect(docsStore.search).not.toHaveBeenCalled();
  });

  it('serves exactly search_docs and get_document, statelessly, to any configured token', async () => {
    const { port } = await start({ knowledgeMode: KNOWLEDGE });

    const init = await post(port, rpcBody('initialize', INIT_PARAMS));
    expect(init.status).toBe(200);
    // Stateless: no session for a load balancer to pin.
    expect(init.headers.get('mcp-session-id')).toBeNull();
    const initResult = (await readRpc(init))['result'] as {
      capabilities: Record<string, unknown>;
      instructions: string;
    };
    expect(initResult.capabilities['tools']).toBeDefined();
    expect(initResult.capabilities['resources']).toBeUndefined();
    expect(initResult.capabilities['prompts']).toBeUndefined();
    expect(initResult.instructions).toMatch(/not documented/i);

    for (const token of [TOKEN, OTHER_TOKEN]) {
      const res = await post(port, rpcBody('tools/list'), { Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      const tools = ((await readRpc(res))['result'] as { tools: Array<Record<string, unknown>> })
        .tools;
      expect(tools.map((t) => t['name']).sort()).toEqual(['get_document', 'search_docs']);
      for (const tool of tools) expect(tool['outputSchema']).toBeDefined();
    }
  });

  it('answers GET and DELETE with 405', async () => {
    const { port } = await start({ knowledgeMode: KNOWLEDGE });
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${port}/knowledge/mcp`, {
        method,
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN}`,
        },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    }
  });

  it('enforces its own body limit instead of the global 50 MB one', async () => {
    const { port, docsStore } = await start({ knowledgeMode: KNOWLEDGE });
    const big = rpcBody('tools/call', {
      name: 'search_docs',
      arguments: { query: 'x'.repeat(KNOWLEDGE_MAX_BODY_BYTES + 1) },
    });
    const res = await post(port, big);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });

    // A non-JSON content type cannot slip an unparsed (unbounded) body through.
    const raw = await post(port, 'x'.repeat(KNOWLEDGE_MAX_BODY_BYTES + 1), {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'text/plain',
    });
    expect(raw.status).toBe(413);
    expect(docsStore.search).not.toHaveBeenCalled();
  });

  it('caps the query length', async () => {
    const { port, docsStore } = await start({ knowledgeMode: KNOWLEDGE });
    const result = await callTool(port, 'search_docs', {
      query: 'q'.repeat(KNOWLEDGE_MAX_QUERY_CHARS + 1),
    });
    expect(result.isError).toBe(true);
    expect(docsStore.search).not.toHaveBeenCalled();
  });

  it('records tool calls under the knowledge mode and the forwarded user', async () => {
    const { port, seen } = await start({ knowledgeMode: KNOWLEDGE });
    await callTool(
      port,
      'search_docs',
      { query: 'leave' },
      { Authorization: `Bearer ${TOKEN}`, 'x-paparats-user': 'agent-backend' }
    );
    expect(seen).toEqual([{ tool: 'search_docs', mode: 'knowledge', user: 'agent-backend' }]);
  });

  it('refuses to serve when mounted without its guards', async () => {
    // The guards normally run ahead of the body parser (createApp). A handler
    // mounted without them must fail closed, not open.
    const handler = new McpHandler({
      searcher: mockSearcher(),
      indexer: mockIndexer(),
      getProjects: () => new Map(),
      getGroupNames: () => ['g1'],
      docsStore: fakeDocsStore() as never,
      knowledge: { audience: ['client'], projects: null },
    });
    const app = express();
    app.use(express.json());
    handler.mount(app);
    const server = app.listen(0);
    running.push(async () => {
      handler.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as { port: number }).port;
    const res = await post(port, rpcBody('tools/list'));
    expect(res.status).toBe(401);
  });
});

// ── search_docs in knowledge mode ───────────────────────────────────────────

describe('knowledge search_docs', () => {
  const files = (r: ToolResult) =>
    (r.structuredContent!['hits'] as Array<{ file: string }>).map((h) => h.file).sort();

  it('never returns internal, unlabelled or out-of-allowlist documents', async () => {
    const { port, docsStore } = await start({ knowledgeMode: KNOWLEDGE });
    const result = await callTool(port, 'search_docs', { query: 'policy' });
    expect(files(result)).toEqual(['faq.md', 'leave.md']);
    const opts = docsStore.search.mock.calls[0]![2];
    expect(opts).toMatchObject({ audience: ['client', 'public'], projects: ['handbook'] });

    // Asking for internal cannot widen the ceiling: the intersection is empty.
    docsStore.search.mockClear();
    const internal = await callTool(port, 'search_docs', {
      query: 'salary bands',
      audience: ['internal'],
    });
    expect(internal.structuredContent).toEqual({ hits: [] });
    expect(internal.content[0]!.text).toMatch(/No documentation found/);
    expect(docsStore.search).not.toHaveBeenCalled();

    // Naming a project outside the allowlist finds nothing either.
    const billing = await callTool(port, 'search_docs', { query: 'invoices', project: 'billing' });
    expect(billing.structuredContent).toEqual({ hits: [] });
  });

  it('lets audience narrow within the ceiling', async () => {
    const { port, docsStore } = await start({ knowledgeMode: KNOWLEDGE });
    const result = await callTool(port, 'search_docs', {
      query: 'faq',
      audience: ['public', 'internal'],
    });
    expect(docsStore.search.mock.calls[0]![2]).toMatchObject({ audience: ['public'] });
    expect(files(result)).toEqual(['faq.md']);
  });

  it('narrows further under PAPARATS_DOCS_AUDIENCE and PAPARATS_PROJECTS', async () => {
    const { port, docsStore } = await start({
      knowledgeMode: { ...KNOWLEDGE, projects: null },
      docsAudienceScope: ['public', 'internal'],
      projectScope: ['handbook', 'billing'],
    });
    await callTool(port, 'search_docs', { query: 'anything' });
    expect(docsStore.search.mock.calls[0]![2]).toMatchObject({
      audience: ['public'],
      projects: ['handbook', 'billing'],
    });
  });

  it('adds no glossary block and points excerpts at get_document', async () => {
    const { port, terminologyStore } = await start({ knowledgeMode: KNOWLEDGE });
    const result = await callTool(port, 'search_docs', { query: 'PTO leave' });
    const text = result.content[0]!.text;
    expect(text).not.toMatch(/Glossary/);
    expect(terminologyStore.search).not.toHaveBeenCalled();
    expect(text).toContain(
      'call get_document with project `handbook` and file `leave.md` for the full text'
    );
    expect(text).not.toMatch(/read `leave\.md`/);
  });

  it('returns structured hits a caller can cite from', async () => {
    const { port } = await start({ knowledgeMode: KNOWLEDGE });
    const result = await callTool(port, 'search_docs', { query: 'leave', limit: 1 });
    // The SDK validates structuredContent against the advertised outputSchema
    // before answering, so reaching here means it conforms.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      hits: [
        {
          title: 'Leave policy',
          heading_path: [],
          source_url: 'https://docs.example.com/leave.md',
          project: 'handbook',
          file: 'leave.md',
          excerpt: 'How leave works.',
          included_sections: [1],
          total_sections: 3,
          last_modified: new Date(1_700_000_000_000).toISOString(),
          score: 1,
        },
      ],
    });
  });

  it('reports a backend failure without its internal details', async () => {
    const { port, docsStore } = await start({ knowledgeMode: KNOWLEDGE });
    docsStore.search.mockRejectedValueOnce(new Error('connect ECONNREFUSED qdrant.internal:6333'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await callTool(port, 'search_docs', { query: 'leave' });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe(
        'Documentation is temporarily unavailable. Try again shortly.'
      );
    } finally {
      error.mockRestore();
    }
  });
});

// ── get_document ────────────────────────────────────────────────────────────

describe('get_document', () => {
  it('returns the document section by section, in order', async () => {
    const { port } = await start({ knowledgeMode: KNOWLEDGE });
    const result = await callTool(port, 'get_document', { project: 'handbook', file: 'leave.md' });
    const text = result.content[0]!.text;
    expect(text).toMatch(/^# Leave policy\nSource: https:\/\/docs\.example\.com\/leave\.md/);
    expect(text).toContain('Complete document (3 sections).');
    const order = ['How leave works.', '## Requesting', 'Submit the form.', '### Approval'];
    const positions = order.map((s) => text.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(result.structuredContent).toMatchObject({
      title: 'Leave policy',
      source_url: 'https://docs.example.com/leave.md',
      total_sections: 3,
      next_section: null,
      sections: [
        { section: 1, heading_path: [], text: 'How leave works.' },
        { section: 2, heading_path: ['Requesting'], text: 'Submit the form.' },
        { section: 3, heading_path: ['Requesting', 'Approval'], text: 'A manager approves it.' },
      ],
    });
  });

  it('answers out-of-scope exactly like missing', async () => {
    const { port } = await start({ knowledgeMode: KNOWLEDGE });
    /** The response with the requested names masked, so only the shape is compared. */
    const masked = async (project: string, file: string, group?: string) => {
      const r = await callTool(port, 'get_document', {
        project,
        file,
        ...(group ? { group } : {}),
      });
      return JSON.stringify(r).split(project).join('P').split(file).join('F');
    };
    const missing = await masked('handbook', 'nope.md');
    expect(missing).toContain('Document not found');
    expect(await masked('handbook', 'salaries.md')).toBe(missing); // internal
    expect(await masked('handbook', 'unlabelled.md')).toBe(missing); // no label
    expect(await masked('billing', 'invoices.md')).toBe(missing); // project off the allowlist
    // An in-scope document asked for in a group this server does not know.
    expect(await masked('handbook', 'leave.md', 'nope')).toBe(missing);
  });

  it('pages a long document', async () => {
    const long: FakeDoc = {
      project: 'handbook',
      file: 'manual.md',
      audience: 'client',
      title: 'Manual',
      sections: [
        { headingPath: ['One'], text: 'a'.repeat(20_000) },
        { headingPath: ['Two'], text: 'b'.repeat(15_000) },
        { headingPath: ['Two'], text: 'c'.repeat(10_000) },
      ],
    };
    const handler = new McpHandler({
      searcher: mockSearcher(),
      indexer: mockIndexer(),
      getProjects: () => new Map(),
      getGroupNames: () => ['g1'],
      docsStore: fakeDocsStore([long]) as never,
    });
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    handler.mount(app);
    const server = app.listen(0);
    running.push(async () => {
      handler.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as { port: number }).port;

    // Support mode: a session first.
    const init = await post(port, rpcBody('initialize', INIT_PARAMS), {}, '/support/mcp');
    const session = init.headers.get('mcp-session-id')!;
    await init.text();
    const call = async (args: Record<string, unknown>) => {
      const res = await post(
        port,
        rpcBody('tools/call', { name: 'get_document', arguments: args }),
        { 'mcp-session-id': session },
        '/support/mcp'
      );
      return (await readRpc(res))['result'] as ToolResult;
    };

    const first = await call({ project: 'handbook', file: 'manual.md' });
    expect(first.structuredContent).toMatchObject({ total_sections: 3, next_section: 3 });
    expect((first.structuredContent!['sections'] as unknown[]).length).toBe(2);
    expect(first.content[0]!.text).toContain('Sections 1-2 of 3.');
    expect(first.content[0]!.text).toContain('from_section: 3');

    const rest = await call({ project: 'handbook', file: 'manual.md', from_section: 3 });
    expect(rest.structuredContent).toMatchObject({ next_section: null });
    // A page that starts mid-document restates where it is.
    expect(rest.content[0]!.text).toContain('## Two\n\n' + 'c'.repeat(10));

    const past = await call({ project: 'handbook', file: 'manual.md', from_section: 4 });
    expect(past.isError).toBe(true);
    expect(past.content[0]!.text).toMatch(/past the end/);
  });
});

describe('pageDocument', () => {
  const doc = toDocument(CORPUS[0]!);

  it('renders the whole document when it fits, headings at their depth', () => {
    const page = pageDocument(doc, 1, 40_000, 1_700_000_000_000)!;
    expect(page.text).toBe(
      [
        '# Leave policy',
        'Source: https://docs.example.com/leave.md',
        'Project: handbook · File: leave.md',
        `Last updated: ${new Date(1_700_000_000_000).toISOString().slice(0, 10)}`,
        'Complete document (3 sections).',
        '',
        '---',
        '',
        'How leave works.',
        '',
        '## Requesting',
        '',
        'Submit the form.',
        '',
        '### Approval',
        '',
        'A manager approves it.',
      ].join('\n')
    );
    expect(page.structured.next_section).toBeNull();
  });

  it('always returns at least one section, and restates headings on a later page', () => {
    const first = pageDocument(doc, 1, 1)!;
    expect(first.structured.sections.map((s) => s.section)).toEqual([1]);
    expect(first.structured.next_section).toBe(2);
    const third = pageDocument(doc, 3, 1)!;
    expect(third.text).toContain('## Requesting\n\n### Approval\n\nA manager approves it.');
    expect(pageDocument(doc, 4, 40_000)).toBeNull();
  });
});

// ── Tool sets per mode ──────────────────────────────────────────────────────

describe('tool sets', () => {
  it('give the knowledge mode the two docs reads and nothing else', () => {
    expect([...KNOWLEDGE_TOOLS].sort()).toEqual(['get_document', 'search_docs']);
  });

  it('add get_document to support only, leaving the rest of both sets unchanged', () => {
    expect([...CODING_TOOLS].sort()).toEqual(
      [
        'search_code',
        'get_chunk',
        'find_usages',
        'health_check',
        'delete_project',
        'list_projects',
        'arch_context',
        'arch_list',
        'arch_record_component',
        'arch_record_decision',
        'arch_record_lesson',
        'arch_suggest_components',
        'arch_delete',
        'search_docs',
        'term_record',
        'term_search',
        'term_list',
        'term_delete',
      ].sort()
    );
    expect([...SUPPORT_TOOLS].sort()).toEqual(
      [
        'search_code',
        'get_chunk',
        'find_usages',
        'health_check',
        'list_projects',
        'get_chunk_meta',
        'search_changes',
        'explain_feature',
        'recent_changes',
        'impact_analysis',
        'token_savings_report',
        'top_queries',
        'slowest_searches',
        'cross_project_share',
        'retry_rate',
        'failed_chunks',
        'search_docs',
        'term_search',
        'term_list',
        'term_record',
        'get_document',
      ].sort()
    );
  });

  /** Open a session on a coding or support endpoint and send one request on it. */
  async function onSession(
    path: '/mcp' | '/support/mcp',
    body: unknown
  ): Promise<Record<string, unknown>> {
    const handler = new McpHandler({
      searcher: mockSearcher(),
      indexer: mockIndexer(),
      getProjects: () => new Map(),
      getGroupNames: () => ['g1'],
      docsStore: fakeDocsStore() as never,
    });
    const app = express();
    app.use(express.json());
    handler.mount(app);
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const init = await post(port, rpcBody('initialize', INIT_PARAMS), {}, path);
      const session = init.headers.get('mcp-session-id')!;
      await init.text();
      const res = await post(port, body, { 'mcp-session-id': session }, path);
      return (await readRpc(res))['result'] as Record<string, unknown>;
    } finally {
      handler.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('registers get_document in support mode and not in coding mode', async () => {
    const names = async (path: '/mcp' | '/support/mcp') =>
      ((await onSession(path, rpcBody('tools/list')))['tools'] as Array<{ name: string }>).map(
        (t) => t.name
      );
    expect(await names('/support/mcp')).toContain('get_document');
    expect(await names('/mcp')).not.toContain('get_document');
  });

  it("points support's excerpts at get_document while coding keeps reading the file", async () => {
    const search = rpcBody('tools/call', {
      name: 'search_docs',
      arguments: { query: 'leave', project: 'handbook', audience: ['client'] },
    });
    const text = async (path: '/mcp' | '/support/mcp') =>
      ((await onSession(path, search))['content'] as Array<{ text: string }>)[0]!.text;

    const support = await text('/support/mcp');
    expect(support).toContain('call get_document with project `handbook` and file `leave.md`');
    expect(support).not.toMatch(/read `leave\.md`/);

    const coding = await text('/mcp');
    expect(coding).toContain('read `leave.md` for the rest');
    expect(coding).not.toContain('get_document');
  });
});

describe('knowledge prompts', () => {
  it('tell the agent to cite, read whole documents, report gaps and never quote live data', () => {
    const text = [
      prompts.knowledgeInstructions,
      prompts.knowledgeTools.search_docs.description,
      prompts.knowledgeTools.get_document.description,
    ].join('\n');
    expect(prompts.knowledgeInstructions).toMatch(/source link/i);
    expect(prompts.knowledgeInstructions).toMatch(/get_document/);
    expect(prompts.knowledgeInstructions).toMatch(/not documented/i);
    expect(prompts.knowledgeInstructions).toMatch(/metrics/i);
    // Written for an outside consumer: none of the internal tools or habits apply.
    // \b so `arch_` does not trip on search_docs.
    expect(text).not.toMatch(/search_code|term_search|\barch_|read the file|grep/i);
  });
});
