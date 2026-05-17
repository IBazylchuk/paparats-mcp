import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  EmbeddingCache,
  OllamaProvider,
  OpenAIProvider,
  VoyageProvider,
  CachedEmbeddingProvider,
  createEmbeddingProvider,
  resolveEmbeddingConfigFromEnv,
} from '../src/embeddings.js';
import type { EmbeddingProvider } from '../src/types.js';

function createTempDbPath(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-embeddings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, 'embeddings.db');
}

/** Mock provider that returns deterministic vectors for testing */
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

describe('EmbeddingCache', () => {
  let cache: EmbeddingCache;
  let dbPath: string;

  beforeEach(() => {
    dbPath = createTempDbPath();
    cache = new EmbeddingCache(dbPath, 10);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns null for cache miss', () => {
    expect(cache.get('abc123', 'model1')).toBeNull();
  });

  it('stores and retrieves vectors', () => {
    const vector = [0.1, 0.2, 0.3, 0.4];
    cache.set('hash1', 'model1', vector);
    const retrieved = cache.get('hash1', 'model1');
    expect(retrieved).toHaveLength(4);
    retrieved!.forEach((v, i) => expect(v).toBeCloseTo(vector[i]!, 5));
  });

  it('increments hitCount on cache hit', () => {
    cache.set('h1', 'm1', [1, 2, 3, 4]);
    cache.get('h1', 'm1');
    cache.get('h1', 'm1');
    expect(cache.hitCount).toBe(2);
  });

  it('returns null for wrong model', () => {
    cache.set('h1', 'model1', [1, 2, 3, 4]);
    expect(cache.get('h1', 'model2')).toBeNull();
    expect(cache.get('h1', 'model1')).toEqual([1, 2, 3, 4]);
  });

  it('stores Float32 correctly', () => {
    const vector = Array.from({ length: 100 }, (_, i) => i * 0.01);
    cache.set('large', 'm', vector);
    const retrieved = cache.get('large', 'm');
    expect(retrieved).toHaveLength(100);
    retrieved!.forEach((v, i) => expect(v).toBeCloseTo(vector[i]!, 5));
  });

  it('returns getStats', () => {
    cache.set('h1', 'm', [1, 2, 3, 4]);
    cache.set('h2', 'm', [5, 6, 7, 8]);
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.hitCount).toBe(0);
    expect(stats.maxSize).toBe(10);
  });

  it('evicts oldest when over maxCacheSize', () => {
    const smallCache = new EmbeddingCache(dbPath, 3);
    smallCache.set('h1', 'm', [1, 2, 3, 4]);
    smallCache.set('h2', 'm', [5, 6, 7, 8]);
    smallCache.set('h3', 'm', [9, 10, 11, 12]);
    expect(smallCache.get('h1', 'm')).toEqual([1, 2, 3, 4]);

    smallCache.set('h4', 'm', [13, 14, 15, 16]);
    const stats = smallCache.getStats();
    expect(stats.size).toBe(3);
    expect(smallCache.get('h1', 'm')).toBeNull();
    expect(smallCache.get('h4', 'm')).toEqual([13, 14, 15, 16]);
    smallCache.close();
  });

  it('close is idempotent', () => {
    cache.close();
    cache.close();
  });
});

describe('CachedEmbeddingProvider', () => {
  let dbPath: string;
  let provider: CachedEmbeddingProvider;
  let mock: MockEmbeddingProvider;

  beforeEach(() => {
    dbPath = createTempDbPath();
    mock = new MockEmbeddingProvider();
    const cache = new EmbeddingCache(dbPath, 100);
    provider = new CachedEmbeddingProvider(mock, cache);
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('delegates dimensions and model', () => {
    expect(provider.dimensions).toBe(4);
    expect(provider.model).toBe('test-model');
  });

  it('caches embed results', async () => {
    const v1 = await provider.embed('hello');
    const v2 = await provider.embed('hello');
    expect(v1).toEqual(v2);
    expect(provider.cacheHits).toBe(1);
  });

  it('caches embedBatch results', async () => {
    const texts = ['a', 'b', 'c'];
    const v1 = await provider.embedBatch(texts);
    const v2 = await provider.embedBatch(texts);
    expect(v1).toEqual(v2);
    expect(provider.cacheHits).toBe(3);
  });

  it('returns empty array for empty embedBatch', async () => {
    expect(await provider.embedBatch([])).toEqual([]);
  });

  it('getCacheStats returns hit rate', async () => {
    await provider.embed('first');
    await provider.embed('first');
    await provider.embed('second');
    const stats = provider.getCacheStats();
    expect(stats.hitCount).toBe(1);
    expect(stats.hitRate).toBeGreaterThan(0);
    expect(stats.hitRate).toBeLessThanOrEqual(1);
  });

  it('embedBatch uses cache for partial hits', async () => {
    await provider.embed('cached');
    const results = await provider.embedBatch(['cached', 'uncached']);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual([6, 99, 0, 1]); // 'cached' = 6 chars, 'c' = 99
    expect(results[1]).toEqual([8, 117, 0, 1]); // 'uncached' = 8 chars, 'u' = 117
  });
});

describe('createEmbeddingProvider', () => {
  it('creates CachedEmbeddingProvider for ollama', () => {
    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'test',
      dimensions: 256,
    });
    expect(provider).toBeInstanceOf(CachedEmbeddingProvider);
    expect(provider.model).toBe('test');
    expect(provider.dimensions).toBe(256);
    provider.close();
  });

  it('throws for unsupported provider', () => {
    expect(() =>
      createEmbeddingProvider({
        provider: 'unsupported',
        model: 'x',
        dimensions: 10,
      })
    ).toThrow('Unsupported embedding provider');
  });
});

describe('OllamaProvider', () => {
  it('has default config', () => {
    const provider = new OllamaProvider();
    expect(provider.model).toBe('jina-code-embeddings');
    expect(provider.dimensions).toBe(1536);
  });

  it('accepts config overrides', () => {
    const provider = new OllamaProvider({
      model: 'custom',
      dimensions: 384,
    });
    expect(provider.model).toBe('custom');
    expect(provider.dimensions).toBe(384);
  });

  it('embedBatch splits large batches', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: { body?: string }) => {
      const body = JSON.parse(opts?.body ?? '{}');
      const input = body.input as string[];
      const count = input?.length ?? 0;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            embeddings: Array.from({ length: count }, (_, i) => [i, 0, 0, 0]),
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider({ url: 'http://localhost:9999' });
    const texts = Array.from({ length: 150 }, (_, i) => `text${i}`);
    const results = await provider.embedBatch(texts);

    expect(results).toHaveLength(150);
    // 150 items / default batch size 5 = 30 fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(30);

    vi.unstubAllGlobals();
  });

  it('embedBatch further splits when total chars exceed the per-request budget', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: { body?: string }) => {
      const body = JSON.parse(opts?.body ?? '{}');
      const input = body.input as string[];
      const count = input?.length ?? 0;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            embeddings: Array.from({ length: count }, () => [0, 0, 0, 0]),
          }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 4 chunks within the count cap (5) but ~32k chars total — well past the
    // 16k char cap. Adaptive splitter must subdivide so no single request
    // carries the full payload that would time out on CPU Ollama.
    const big = 'x'.repeat(8000);
    const provider = new OllamaProvider({ url: 'http://localhost:9999' });
    const results = await provider.embedBatch([big, big, big, big]);

    expect(results).toHaveLength(4);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchMock.mock.calls) {
      const inputs = JSON.parse((call[1] as { body: string }).body).input as string[];
      const totalChars = inputs.reduce((s, t) => s + t.length, 0);
      expect(totalChars).toBeLessThanOrEqual(16_000);
    }

    vi.unstubAllGlobals();
  });
});

describe('OpenAIProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects construction without an API key', () => {
    expect(() => new OpenAIProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('embed sends model+input+dimensions and returns the vector', async () => {
    const fetchMock = vi.fn(async (_url, opts) => {
      const body = JSON.parse((opts as { body: string }).body);
      expect(body.model).toBe('text-embedding-3-small');
      expect(body.input).toBe('hello');
      expect(body.dimensions).toBe(1536);
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const v = await provider.embed('hello');
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  it('embedBatch returns results sorted by `index`', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: [3], index: 2 },
              { embedding: [1], index: 0 },
              { embedding: [2], index: 1 },
            ],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const result = await provider.embedBatch(['a', 'b', 'c']);
    expect(result).toEqual([[1], [2], [3]]);
  });

  it('does not retry on 401 (bad key)', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ apiKey: 'sk-bad' });
    await expect(provider.embed('x')).rejects.toThrow(/OpenAI error 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and eventually succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 2) return new Response('busy', { status: 429 });
      return new Response(JSON.stringify({ data: [{ embedding: [9], index: 0 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });
    const v = await provider.embed('x');
    expect(v).toEqual([9]);
    expect(calls).toBe(2);
  });
});

describe('VoyageProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects construction without an API key', () => {
    expect(() => new VoyageProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('tags input_type=document by default, query after setInputType', async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_url, opts) => {
      seen.push(JSON.parse((opts as { body: string }).body).input_type);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VoyageProvider({ apiKey: 'pa-test' });
    await provider.embed('a passage');
    provider.setInputType('query');
    await provider.embed('a query');
    expect(seen).toEqual(['document', 'query']);
  });

  it('only sends output_dimension when non-default', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url, opts) => {
      seen.push(JSON.parse((opts as { body: string }).body));
      return new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const defaultDim = new VoyageProvider({ apiKey: 'pa' });
    await defaultDim.embed('x');
    const customDim = new VoyageProvider({ apiKey: 'pa', dimensions: 512 });
    await customDim.embed('x');

    expect(seen[0]).not.toHaveProperty('output_dimension');
    expect(seen[1]?.['output_dimension']).toBe(512);
  });

  it('does not retry on 402 (no credit)', async () => {
    const fetchMock = vi.fn(async () => new Response('billing', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new VoyageProvider({ apiKey: 'pa' });
    await expect(provider.embed('x')).rejects.toThrow(/Voyage error 402/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveEmbeddingConfigFromEnv', () => {
  it('defaults to ollama with jina model and 1536 dims when nothing is set', () => {
    const c = resolveEmbeddingConfigFromEnv({});
    expect(c).toEqual({
      provider: 'ollama',
      model: 'jina-code-embeddings',
      dimensions: 1536,
    });
  });

  it('auto-picks openai when only OPENAI_API_KEY is set', () => {
    const c = resolveEmbeddingConfigFromEnv({ OPENAI_API_KEY: 'sk-test' });
    expect(c.provider).toBe('openai');
    expect(c.apiKey).toBe('sk-test');
    expect(c.model).toBe('text-embedding-3-small');
    expect(c.dimensions).toBe(1536);
  });

  it('auto-picks voyage when only VOYAGE_API_KEY is set', () => {
    const c = resolveEmbeddingConfigFromEnv({ VOYAGE_API_KEY: 'pa-test' });
    expect(c.provider).toBe('voyage');
    expect(c.apiKey).toBe('pa-test');
    expect(c.model).toBe('voyage-code-3');
    expect(c.dimensions).toBe(1024);
  });

  it('explicit EMBEDDING_PROVIDER wins over key auto-detect', () => {
    const c = resolveEmbeddingConfigFromEnv({
      EMBEDDING_PROVIDER: 'voyage',
      VOYAGE_API_KEY: 'pa-test',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(c.provider).toBe('voyage');
  });

  it('explicit cloud provider without a key throws a useful error', () => {
    expect(() => resolveEmbeddingConfigFromEnv({ EMBEDDING_PROVIDER: 'openai' })).toThrow(
      /OPENAI_API_KEY/
    );
    expect(() => resolveEmbeddingConfigFromEnv({ EMBEDDING_PROVIDER: 'voyage' })).toThrow(
      /VOYAGE_API_KEY/
    );
  });

  it('respects EMBEDDING_MODEL and EMBEDDING_DIMENSIONS overrides', () => {
    const c = resolveEmbeddingConfigFromEnv({
      OPENAI_API_KEY: 'sk',
      EMBEDDING_MODEL: 'text-embedding-3-large',
      EMBEDDING_DIMENSIONS: '3072',
    });
    expect(c.model).toBe('text-embedding-3-large');
    expect(c.dimensions).toBe(3072);
  });
});
