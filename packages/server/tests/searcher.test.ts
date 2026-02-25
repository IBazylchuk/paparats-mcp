import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Searcher } from '../src/searcher.js';
import { EmbeddingCache, CachedEmbeddingProvider } from '../src/embeddings.js';
import type { EmbeddingProvider } from '../src/types.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-searcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'test-model';
  readonly dimensions = 4;

  async embed(text: string): Promise<number[]> {
    return [text.length, text.charCodeAt(0) ?? 0, 0, 1];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => [t.length, t.charCodeAt(0) ?? 0, 0, 1]);
  }
}

function createMockQdrant() {
  const search = vi.fn();
  return { client: { search } };
}

describe('Searcher', () => {
  let projectDir: string;
  let embeddingProvider: CachedEmbeddingProvider;
  let mockQdrant: ReturnType<typeof createMockQdrant>;

  beforeEach(() => {
    projectDir = createTempDir();
    const mock = new MockEmbeddingProvider();
    const cache = new EmbeddingCache(path.join(projectDir, 'cache.db'), 100);
    embeddingProvider = new CachedEmbeddingProvider(mock, cache);
    mockQdrant = createMockQdrant();
  });

  afterEach(() => {
    embeddingProvider.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates Searcher with config', async () => {
    mockQdrant.client.search.mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('test-group', 'foo');
    expect(response.results).toEqual([]);
    expect(response.total).toBe(0);
    expect(response.metrics.tokensReturned).toBe(0);
  });

  it('search returns results and maps payload correctly', async () => {
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.95,
        payload: {
          project: 'my-project',
          file: 'src/foo.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 25,
          content: 'const x = 1;',
          hash: 'abc123',
        },
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('test-group', 'foo bar');

    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toEqual({
      project: 'my-project',
      file: 'src/foo.ts',
      language: 'typescript',
      startLine: 10,
      endLine: 25,
      content: 'const x = 1;',
      score: 0.95,
      hash: 'abc123',
      chunk_id: null,
      symbol_name: null,
      kind: null,
      service: null,
      bounded_context: null,
      tags: [],
      last_commit_at: null,
      defines_symbols: [],
      uses_symbols: [],
    });
    expect(response.total).toBe(1);
    expect(response.metrics.tokensReturned).toBeGreaterThan(0);
    expect(response.metrics.tokensSaved).toBeGreaterThanOrEqual(0);

    expect(mockQdrant.client.search).toHaveBeenCalledWith('test-group', {
      vector: expect.any(Array),
      limit: 5,
      with_payload: true,
      filter: undefined,
    });
  });

  it('search uses project filter when project is specified', async () => {
    mockQdrant.client.search.mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await searcher.search('test-group', 'query', { project: 'my-project' });

    expect(mockQdrant.client.search).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({
        filter: {
          must: [{ key: 'project', match: { value: 'my-project' } }],
        },
      })
    );
  });

  it('search uses limit option', async () => {
    mockQdrant.client.search.mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await searcher.search('test-group', 'query', { limit: 10 });

    expect(mockQdrant.client.search).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({
        limit: 10,
      })
    );
  });

  it('search returns empty results when collection does not exist', async () => {
    mockQdrant.client.search.mockRejectedValue(new Error('Collection not found'));

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('nonexistent', 'query');

    expect(response.results).toEqual([]);
    expect(response.total).toBe(0);
    expect(response.metrics.tokensReturned).toBe(0);
  });

  it('search returns empty results when collection does not exist ("does not exist" wording)', async () => {
    mockQdrant.client.search.mockRejectedValue(new Error('Collection my-group does not exist'));

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('my-group', 'query');

    expect(response.results).toEqual([]);
    expect(response.total).toBe(0);
  });

  it('search throws on network error (not collection not found)', async () => {
    mockQdrant.client.search.mockRejectedValue(new Error('Connection refused'));

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await expect(searcher.search('test-group', 'query')).rejects.toThrow(
      'Search failed in group "test-group"'
    );
  });

  it('search retries on transient error and succeeds on second attempt', async () => {
    mockQdrant.client.search
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockResolvedValueOnce([
        {
          id: '1',
          score: 0.9,
          payload: {
            project: 'p',
            file: 'f.ts',
            language: 'ts',
            startLine: 1,
            endLine: 10,
            content: 'result',
            hash: 'h',
          },
        },
      ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('test-group', 'query');

    expect(response.results).toHaveLength(1);
    expect(response.results[0].content).toBe('result');
    expect(mockQdrant.client.search).toHaveBeenCalledTimes(2);
  });

  it('search validates input: empty groupName', async () => {
    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await expect(searcher.search('', 'query')).rejects.toThrow('Group name is required');
    await expect(searcher.search('   ', 'query')).rejects.toThrow('Group name is required');
  });

  it('search validates input: empty query', async () => {
    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await expect(searcher.search('test-group', '')).rejects.toThrow('Query string is required');
    await expect(searcher.search('test-group', '   ')).rejects.toThrow('Query string is required');
  });

  it('search clamps limit to 1-100', async () => {
    mockQdrant.client.search.mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await searcher.search('test-group', 'query', { limit: 0 });
    expect(mockQdrant.client.search).toHaveBeenLastCalledWith(
      'test-group',
      expect.objectContaining({ limit: 1 })
    );

    await searcher.search('test-group', 'query', { limit: 500 });
    expect(mockQdrant.client.search).toHaveBeenLastCalledWith(
      'test-group',
      expect.objectContaining({ limit: 100 })
    );
  });

  it('search filters invalid payloads', async () => {
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.9,
        payload: {
          project: 'p',
          file: 'f.ts',
          language: 'ts',
          startLine: 1,
          endLine: 10,
          content: 'x',
          hash: 'h',
        },
      },
      {
        id: '2',
        score: 0.8,
        payload: { invalid: 'payload' }, // Missing required fields
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('test-group', 'query');

    expect(response.results).toHaveLength(1);
    expect(response.results[0].file).toBe('f.ts');
  });

  it('search filters payloads with wrong types (e.g. startLine as string)', async () => {
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.9,
        payload: {
          project: 'p',
          file: 'f.ts',
          language: 'ts',
          startLine: '10', // wrong type
          endLine: 20,
          content: 'x',
          hash: 'h',
        },
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('test-group', 'query');

    expect(response.results).toHaveLength(0);
  });

  it('computeMetrics uses max endLine per file for token estimation', async () => {
    // Two chunks from same file: lines 1-20 and 50-100. Max endLine = 100.
    // estimatedFullFileTokens = ceil(100 * 50 / 4) = 1250
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.95,
        payload: {
          project: 'p',
          file: 'src/utils.ts',
          language: 'ts',
          startLine: 1,
          endLine: 20,
          content: 'a'.repeat(80), // ~20 tokens
          hash: 'h1',
        },
      },
      {
        id: '2',
        score: 0.9,
        payload: {
          project: 'p',
          file: 'src/utils.ts',
          language: 'ts',
          startLine: 50,
          endLine: 100,
          content: 'b'.repeat(200), // ~50 tokens
          hash: 'h2',
        },
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.search('test-group', 'query');

    expect(response.results).toHaveLength(2);
    // estimatedFullFileTokens = ceil(100 * 50 / 4) = 1250 (one file, max endLine 100)
    expect(response.metrics.estimatedFullFileTokens).toBe(1250);
    expect(response.metrics.tokensReturned).toBeGreaterThan(0);
    expect(response.metrics.tokensSaved).toBeGreaterThanOrEqual(0);
    expect(response.metrics.savingsPercent).toBeGreaterThan(0);
  });

  it('getUsageStats returns search count and token savings', async () => {
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.9,
        payload: {
          project: 'p',
          file: 'f.ts',
          language: 'ts',
          startLine: 1,
          endLine: 10,
          content: 'x'.repeat(100),
          hash: 'h',
        },
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await searcher.search('g', 'q1');
    await searcher.search('g', 'q2');

    const stats = searcher.getUsageStats();
    expect(stats.searchCount).toBe(2);
    expect(stats.totalTokensSaved).toBeGreaterThanOrEqual(0);
  });

  it('formatResults returns message for empty results', () => {
    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const formatted = searcher.formatResults({
      results: [],
      total: 0,
      metrics: {
        tokensReturned: 0,
        estimatedFullFileTokens: 0,
        tokensSaved: 0,
        savingsPercent: 0,
      },
    });

    expect(formatted).toBe('No results found. Make sure the project is indexed.');
  });

  it('expandedSearch returns merged results from multiple query variations', async () => {
    // "auth middleware" expands to ["auth middleware", "authentication middleware", ...]
    // Each call returns different results
    mockQdrant.client.search
      .mockResolvedValueOnce([
        {
          id: '1',
          score: 0.9,
          payload: {
            project: 'p',
            file: 'src/auth.ts',
            language: 'ts',
            startLine: 1,
            endLine: 10,
            content: 'auth check',
            hash: 'h1',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: '2',
          score: 0.85,
          payload: {
            project: 'p',
            file: 'src/middleware.ts',
            language: 'ts',
            startLine: 5,
            endLine: 15,
            content: 'authentication middleware',
            hash: 'h2',
          },
        },
      ])
      .mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.expandedSearch('test-group', 'auth middleware', { limit: 5 });

    expect(response.results.length).toBeGreaterThanOrEqual(2);
    expect(response.results.map((r) => r.hash)).toContain('h1');
    expect(response.results.map((r) => r.hash)).toContain('h2');
    // Sorted by score descending
    for (let i = 1; i < response.results.length; i++) {
      expect(response.results[i - 1]!.score).toBeGreaterThanOrEqual(response.results[i]!.score);
    }
  });

  it('expandedSearch deduplicates by hash, keeping highest score', async () => {
    // Same hash returned by two variations with different scores
    mockQdrant.client.search
      .mockResolvedValueOnce([
        {
          id: '1',
          score: 0.7,
          payload: {
            project: 'p',
            file: 'src/auth.ts',
            language: 'ts',
            startLine: 1,
            endLine: 10,
            content: 'auth',
            hash: 'shared-hash',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: '2',
          score: 0.95,
          payload: {
            project: 'p',
            file: 'src/auth.ts',
            language: 'ts',
            startLine: 1,
            endLine: 10,
            content: 'auth',
            hash: 'shared-hash',
          },
        },
      ])
      .mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.expandedSearch('test-group', 'auth middleware', { limit: 5 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.hash).toBe('shared-hash');
    expect(response.results[0]!.score).toBe(0.95);
  });

  it('expandedSearch falls through to single search when no expansions generated', async () => {
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.9,
        payload: {
          project: 'p',
          file: 'f.ts',
          language: 'ts',
          startLine: 1,
          endLine: 10,
          content: 'result',
          hash: 'h',
        },
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    // "Searcher" is a single PascalCase word with no abbreviations - no expansion
    const response = await searcher.expandedSearch('test-group', 'Searcher', { limit: 5 });

    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.content).toBe('result');
    // Single search: only 1 call to qdrant
    expect(mockQdrant.client.search).toHaveBeenCalledTimes(1);
  });

  it('expandedSearch logs which variations contributed results', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockQdrant.client.search
      .mockResolvedValueOnce([
        {
          id: '1',
          score: 0.9,
          payload: {
            project: 'p',
            file: 'src/auth.ts',
            language: 'ts',
            startLine: 1,
            endLine: 10,
            content: 'auth',
            hash: 'h1',
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: '2',
          score: 0.85,
          payload: {
            project: 'p',
            file: 'src/auth2.ts',
            language: 'ts',
            startLine: 1,
            endLine: 10,
            content: 'authentication',
            hash: 'h2',
          },
        },
      ])
      .mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await searcher.expandedSearch('test-group', 'auth middleware', { limit: 5 });

    const logCall = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('[searcher] Query expansion:')
    );
    expect(logCall).toBeDefined();
    expect(logCall![0]).toContain('"auth middleware"');
    expect(logCall![0]).toContain('variations');
    expect(logCall![0]).toContain('results');

    consoleSpy.mockRestore();
  });

  it('expandedSearch respects limit parameter', async () => {
    // Return many results from multiple expansions
    const makeHit = (id: string, score: number, hash: string) => ({
      id,
      score,
      payload: {
        project: 'p',
        file: 'f.ts',
        language: 'ts',
        startLine: 1,
        endLine: 10,
        content: 'x',
        hash,
      },
    });

    mockQdrant.client.search
      .mockResolvedValueOnce([
        makeHit('1', 0.9, 'h1'),
        makeHit('2', 0.8, 'h2'),
        makeHit('3', 0.7, 'h3'),
      ])
      .mockResolvedValueOnce([makeHit('4', 0.85, 'h4'), makeHit('5', 0.75, 'h5')])
      .mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.expandedSearch('test-group', 'auth middleware', { limit: 3 });

    expect(response.results).toHaveLength(3);
    // Top 3 by score: 0.9, 0.85, 0.8
    expect(response.results[0]!.score).toBe(0.9);
    expect(response.results[1]!.score).toBe(0.85);
    expect(response.results[2]!.score).toBe(0.8);
  });

  it('searchWithFilter applies additional filter conditions', async () => {
    mockQdrant.client.search.mockResolvedValue([
      {
        id: '1',
        score: 0.9,
        payload: {
          project: 'p',
          file: 'src/auth.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 10,
          content: 'const x = 1;',
          hash: 'h1',
        },
      },
    ]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const response = await searcher.searchWithFilter(
      'test-group',
      'auth code',
      {
        must: [
          {
            key: 'last_commit_at',
            range: { gte: '2024-01-01T00:00:00Z' },
          },
        ],
      },
      { limit: 5 }
    );

    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.file).toBe('src/auth.ts');

    // Verify filter includes the additional condition
    expect(mockQdrant.client.search).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({
        filter: {
          must: expect.arrayContaining([
            {
              key: 'last_commit_at',
              range: { gte: '2024-01-01T00:00:00Z' },
            },
          ]),
        },
      })
    );
  });

  it('searchWithFilter merges project filter with additional filter', async () => {
    mockQdrant.client.search.mockResolvedValue([]);

    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await searcher.searchWithFilter(
      'test-group',
      'query',
      { must: [{ key: 'ticket_keys', match: { value: 'PROJ-123' } }] },
      { project: 'my-project', limit: 3 }
    );

    expect(mockQdrant.client.search).toHaveBeenCalledWith(
      'test-group',
      expect.objectContaining({
        limit: 3,
        filter: {
          must: expect.arrayContaining([
            { key: 'ticket_keys', match: { value: 'PROJ-123' } },
            { key: 'project', match: { value: 'my-project' } },
          ]),
        },
      })
    );
  });

  it('searchWithFilter validates empty groupName', async () => {
    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await expect(searcher.searchWithFilter('', 'query', { must: [] })).rejects.toThrow(
      'Group name is required'
    );
  });

  it('searchWithFilter validates empty query', async () => {
    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    await expect(searcher.searchWithFilter('group', '', { must: [] })).rejects.toThrow(
      'Query string is required'
    );
  });

  it('formatResults formats results as markdown', () => {
    const searcher = new Searcher({
      qdrantUrl: 'http://127.0.0.1:6333',
      embeddingProvider,
      qdrantClient: mockQdrant.client as never,
    });

    const formatted = searcher.formatResults({
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
          chunk_id: null,
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

    expect(formatted).toContain('[p1] src/foo.ts:10');
    expect(formatted).toContain('95.0%');
    expect(formatted).toContain('```typescript');
    expect(formatted).toContain('const x = 1;');
  });

  describe('allowedProjects', () => {
    it('no allowedProjects: no project filter applied (existing behavior)', async () => {
      mockQdrant.client.search.mockResolvedValue([]);

      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
      });

      await searcher.search('test-group', 'query');

      expect(mockQdrant.client.search).toHaveBeenCalledWith(
        'test-group',
        expect.objectContaining({
          filter: undefined,
        })
      );
    });

    it('single allowedProject: filters via match.value', async () => {
      mockQdrant.client.search.mockResolvedValue([]);

      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/billing'],
      });

      await searcher.search('test-group', 'query');

      expect(mockQdrant.client.search).toHaveBeenCalledWith(
        'test-group',
        expect.objectContaining({
          filter: {
            must: [{ key: 'project', match: { value: 'org/billing' } }],
          },
        })
      );
    });

    it('multiple allowedProjects: filters via match.any', async () => {
      mockQdrant.client.search.mockResolvedValue([]);

      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/core', 'org/tracking', 'org/events'],
      });

      await searcher.search('test-group', 'query');

      expect(mockQdrant.client.search).toHaveBeenCalledWith(
        'test-group',
        expect.objectContaining({
          filter: {
            must: [{ key: 'project', match: { any: ['org/core', 'org/tracking', 'org/events'] } }],
          },
        })
      );
    });

    it('explicit project within allowed set: narrows to that single project', async () => {
      mockQdrant.client.search.mockResolvedValue([]);

      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/core', 'org/tracking'],
      });

      await searcher.search('test-group', 'query', { project: 'org/tracking' });

      expect(mockQdrant.client.search).toHaveBeenCalledWith(
        'test-group',
        expect.objectContaining({
          filter: {
            must: [{ key: 'project', match: { value: 'org/tracking' } }],
          },
        })
      );
    });

    it('explicit project NOT in allowed set: returns empty, Qdrant not called', async () => {
      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/core', 'org/tracking'],
      });

      const response = await searcher.search('test-group', 'query', {
        project: 'org/forbidden',
      });

      expect(response.results).toEqual([]);
      expect(response.total).toBe(0);
      expect(mockQdrant.client.search).not.toHaveBeenCalled();
    });

    it('getProjectScope returns scope when set', () => {
      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/core', 'org/tracking'],
      });

      expect(searcher.getProjectScope()).toEqual(['org/core', 'org/tracking']);
    });

    it('getProjectScope returns null when not set', () => {
      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
      });

      expect(searcher.getProjectScope()).toBeNull();
    });

    it('getProjectScope returns null for empty allowedProjects', () => {
      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: [],
      });

      expect(searcher.getProjectScope()).toBeNull();
    });

    it('searchWithFilter: forbidden project returns empty without calling Qdrant', async () => {
      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/core'],
      });

      const response = await searcher.searchWithFilter(
        'test-group',
        'query',
        { must: [{ key: 'last_commit_at', range: { gte: '2024-01-01' } }] },
        { project: 'org/forbidden' }
      );

      expect(response.results).toEqual([]);
      expect(response.total).toBe(0);
      expect(mockQdrant.client.search).not.toHaveBeenCalled();
    });

    it('searchWithFilter: allowedProjects merged with additional filter', async () => {
      mockQdrant.client.search.mockResolvedValue([]);

      const searcher = new Searcher({
        qdrantUrl: 'http://127.0.0.1:6333',
        embeddingProvider,
        qdrantClient: mockQdrant.client as never,
        allowedProjects: ['org/core', 'org/tracking'],
      });

      await searcher.searchWithFilter(
        'test-group',
        'query',
        { must: [{ key: 'last_commit_at', range: { gte: '2024-01-01' } }] },
        { limit: 5 }
      );

      expect(mockQdrant.client.search).toHaveBeenCalledWith(
        'test-group',
        expect.objectContaining({
          filter: {
            must: expect.arrayContaining([
              { key: 'last_commit_at', range: { gte: '2024-01-01' } },
              { key: 'project', match: { any: ['org/core', 'org/tracking'] } },
            ]),
          },
        })
      );
    });
  });
});
