import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TerminologyStore } from '../../src/terminology/store.js';
import {
  toTermsCollectionName,
  fromTermsCollectionName,
  isTermsCollection,
} from '../../src/terminology/collection.js';
import type { CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

function fakeProvider(vec: () => number[] = () => Array(1024).fill(0.1)): CachedEmbeddingProvider {
  return {
    dimensions: 1024,
    model: 'qwen3-embedding-0.6b',
    embed: vi.fn(async () => vec()),
    getCacheStats: vi.fn(),
    attachTelemetry: vi.fn(),
    attachMetrics: vi.fn(),
    close: vi.fn(),
    cacheHits: 0,
    prefixesEnabled: false,
  } as unknown as CachedEmbeddingProvider;
}

function fakeQdrant() {
  return {
    getCollection: vi.fn().mockResolvedValue({}),
    createCollection: vi.fn().mockResolvedValue(undefined),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
    search: vi.fn().mockResolvedValue([]),
    retrieve: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  };
}

describe('terms collection naming', () => {
  it('round-trips and rejects other layers', () => {
    expect(toTermsCollectionName('g')).toBe('paparats_g_terms');
    expect(fromTermsCollectionName('paparats_g_terms')).toBe('g');
    expect(fromTermsCollectionName('paparats_g_docs')).toBeNull();
    expect(isTermsCollection('paparats_g_terms')).toBe(true);
  });
});

describe('TerminologyStore.recordTerm', () => {
  let qdrant: ReturnType<typeof fakeQdrant>;
  let store: TerminologyStore;

  beforeEach(() => {
    qdrant = fakeQdrant();
    store = new TerminologyStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
  });

  it('creates a new term when no near match', async () => {
    const res = await store.recordTerm('g', {
      term: 'feed-poster',
      definition: 'service that posts feeds',
      aliases: ['fp'],
    });
    expect(res.status).toBe('created');
    const call = qdrant.upsert.mock.calls.at(-1)![1] as {
      points: Array<{ payload: Record<string, unknown> }>;
    };
    expect(call.points[0]!.payload['term']).toBe('feed-poster');
    expect(call.points[0]!.payload['aliases']).toEqual(['fp']);
  });

  it('updates in place when an exact term name already exists', async () => {
    qdrant.scroll.mockResolvedValueOnce({
      points: [{ id: 'existing-id', payload: { createdAt: 111 } }],
      next_page_offset: null,
    });
    const res = await store.recordTerm('g', { term: 'feed-poster', definition: 'new def' });
    expect(res.status).toBe('updated');
    expect(res.id).toBe('existing-id');
  });

  it('blocks a duplicate definition via the similarity gate', async () => {
    // No exact-name match (findByTerm), but findNearest returns a high score.
    qdrant.scroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    qdrant.search.mockResolvedValueOnce([
      { id: 'dup-id', score: 0.92, payload: { term: 'poster', project: undefined } },
    ]);
    const res = await store.recordTerm('g', { term: 'feed-poster', definition: 'posts feeds' });
    expect(res.status).toBe('duplicate');
    expect(res.id).toBe('dup-id');
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('flags a similar (not duplicate) definition', async () => {
    qdrant.scroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    qdrant.search.mockResolvedValueOnce([
      { id: 'sim-id', score: 0.75, payload: { term: 'poster' } },
    ]);
    const res = await store.recordTerm('g', { term: 'feed-poster', definition: 'posts feeds' });
    expect(res.status).toBe('similar');
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });
});

describe('TerminologyStore.search', () => {
  let qdrant: ReturnType<typeof fakeQdrant>;
  let store: TerminologyStore;

  beforeEach(() => {
    qdrant = fakeQdrant();
    store = new TerminologyStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
  });

  it('returns hits and excludes the meta sentinel', async () => {
    qdrant.search.mockResolvedValueOnce([
      { score: 1, payload: { __meta: true } },
      {
        score: 0.8,
        payload: { id: 't1', term: 'CLIC', definition: 'the platform', aliases: [] },
      },
    ]);
    const hits = await store.search('g', 'what is CLIC');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.term).toBe('CLIC');
    expect(hits[0]!.score).toBe(0.8);
  });

  it('soft-filters by project (global terms surface too)', async () => {
    qdrant.search.mockResolvedValueOnce([
      { score: 0.9, payload: { id: 'a', term: 'A', definition: 'x', aliases: [], project: 'billing' } },
      { score: 0.8, payload: { id: 'b', term: 'B', definition: 'y', aliases: [] } },
      { score: 0.7, payload: { id: 'c', term: 'C', definition: 'z', aliases: [], project: 'other' } },
    ]);
    const hits = await store.search('g', 'q', { project: 'billing' });
    const terms = hits.map((h) => h.term);
    expect(terms).toContain('A'); // project match
    expect(terms).toContain('B'); // global
    expect(terms).not.toContain('C'); // other project
  });

  it('returns [] gracefully on a missing collection', async () => {
    qdrant.search.mockRejectedValueOnce(new Error('missing'));
    expect(await store.search('g', 'q')).toEqual([]);
  });
});

describe('TerminologyStore.healAllTermsModels', () => {
  it('re-embeds a group whose model differs', async () => {
    const qdrant = fakeQdrant();
    qdrant.getCollections.mockResolvedValue({
      collections: [{ name: toTermsCollectionName('g') }],
    });
    qdrant.retrieve.mockResolvedValue([
      { payload: { __meta: true, model: 'old', dimensions: 1024 } },
    ]);
    qdrant.scroll
      .mockResolvedValueOnce({
        points: [{ id: 't1', payload: { id: 't1', term: 'X', definition: 'd', aliases: [] } }],
        next_page_offset: null,
      })
      .mockResolvedValue({ points: [], next_page_offset: null });
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { size: 1024 } } },
    });
    const store = new TerminologyStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.healAllTermsModels();
    expect(qdrant.upsert).toHaveBeenCalled();
  });
});
