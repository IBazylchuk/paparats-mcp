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
});
