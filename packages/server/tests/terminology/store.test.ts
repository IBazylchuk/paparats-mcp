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
    // Distinct fills so a test can tell which path produced the vector. The absence
    // of embedQuery here is what let the missing-instruction defect go unnoticed.
    embed: vi.fn(async () => vec()),
    embedQuery: vi.fn(async () => Array(1024).fill(0.2)),
    embedPassage: vi.fn(async () => Array(1024).fill(0.3)),
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

  it('refuses to write a duplicate when the existence lookup fails', async () => {
    // A swallowed error here reads as "no such term yet", so recordTerm would mint
    // a fresh id: the existing term gets shadowed by a copy and loses its
    // createdAt. Failing loudly is the only safe answer.
    qdrant.scroll.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    await expect(
      store.recordTerm('g', { term: 'feed-poster', definition: 'new def' })
    ).rejects.toThrow('Unauthorized');
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('blocks a near-verbatim restatement', async () => {
    // No exact-name match (findByTerm), but findNearest scores high enough that the
    // two texts are effectively the same entry.
    qdrant.scroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    qdrant.search.mockResolvedValueOnce([
      { id: 'dup-id', score: 0.97, payload: { term: 'poster', project: undefined } },
    ]);
    const res = await store.recordTerm('g', { term: 'feed-poster', definition: 'posts feeds' });
    expect(res.status).toBe('duplicate');
    expect(res.id).toBe('dup-id');
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  // Scores observed while importing a 53-entry glossary under the old 0.72 floor,
  // where 16 of 19 refusals were distinct concepts spread over 0.724-0.889. Glossary
  // entries share structure and domain, so cosine tracks the genre of the text more
  // than which term it defines — these must all still be admitted.
  it.each([0.724, 0.781, 0.804, 0.889])('admits a distinct term scoring %s', async (score) => {
    qdrant.scroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    qdrant.search.mockResolvedValueOnce([{ id: 'other-id', score, payload: { term: 'OTHER' } }]);
    const res = await store.recordTerm('g', {
      term: `TERM-${score}`,
      definition: 'a distinct concept that happens to read like its neighbour',
    });
    expect(res.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
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
      {
        score: 0.9,
        payload: { id: 'a', term: 'A', definition: 'x', aliases: [], project: 'billing' },
      },
      { score: 0.8, payload: { id: 'b', term: 'B', definition: 'y', aliases: [] } },
      {
        score: 0.7,
        payload: { id: 'c', term: 'C', definition: 'z', aliases: [], project: 'other' },
      },
    ]);
    const hits = await store.search('g', 'q', { project: 'billing' });
    const terms = hits.map((h) => h.term);
    expect(terms).toContain('A'); // project match
    expect(terms).toContain('B'); // global
    expect(terms).not.toContain('C'); // other project
  });

  // A bare acronym is the commonest glossary query and the one the vector handles
  // worst: measured on a live 75-term glossary, one acronym ranked its own entry 21st
  // at 0.469 while an unrelated metric took the top slot at 0.620. Exact name/alias
  // matching has to run before the vector, or the tool answers with a neighbour.
  describe('exact name/alias lookup', () => {
    const term = (id: string, name: string, aliases: string[] = []) => ({
      id,
      payload: { id, term: name, definition: `def of ${name}`, aliases },
    });

    function withGlossary(points: ReturnType<typeof term>[]) {
      qdrant.scroll.mockResolvedValue({ points, next_page_offset: null });
    }

    it('matches a canonical name without consulting the vector', async () => {
      withGlossary([term('x', 'XYZ'), term('o', 'Other Thing')]);
      const hits = await store.search('g', 'XYZ');
      expect(hits.map((h) => h.term)).toEqual(['XYZ']);
      expect(hits[0]!.score).toBe(1);
      expect(qdrant.search).not.toHaveBeenCalled();
    });

    it.each(['xyz', '  XYZ  ', 'XyZ'])('matches case- and space-insensitively: %s', async (q) => {
      withGlossary([term('x', 'XYZ')]);
      expect((await store.search('g', q)).map((h) => h.term)).toEqual(['XYZ']);
    });

    it('matches an alias', async () => {
      withGlossary([term('t', 'Canonical Name', ['Friendly Alias'])]);
      const hits = await store.search('g', 'friendly alias');
      expect(hits.map((h) => h.term)).toEqual(['Canonical Name']);
      expect(qdrant.search).not.toHaveBeenCalled();
    });

    it('prefers a canonical name over another term holding it as an alias', async () => {
      // The live glossary has 7 such shadows, where one entry lists another entry's
      // canonical name among its aliases. Returning the alias holder would hide the
      // entry the caller actually named.
      withGlossary([term('broad', 'broad concept', ['NARROW']), term('narrow', 'NARROW')]);
      expect((await store.search('g', 'NARROW')).map((h) => h.term)).toEqual(['NARROW']);
    });

    it('returns every term sharing an ambiguous alias', async () => {
      withGlossary([term('a', 'First', ['shared alias']), term('b', 'Second', ['shared alias'])]);
      expect((await store.search('g', 'shared alias')).map((h) => h.term).sort()).toEqual([
        'First',
        'Second',
      ]);
    });

    it('falls back to the vector when nothing matches by name', async () => {
      withGlossary([term('x', 'XYZ')]);
      qdrant.search.mockResolvedValueOnce([
        { id: 'x', score: 0.81, payload: { id: 'x', term: 'XYZ', definition: 'd', aliases: [] } },
      ]);
      const hits = await store.search('g', 'a descriptive question about the concept');
      expect(qdrant.search).toHaveBeenCalled();
      expect(hits[0]!.score).toBe(0.81);
    });

    it('keeps an exact match that scores below a caller minScore', async () => {
      // Exact matches are identity, not similarity. term_search applies a 0.70 floor
      // to suppress the vector's guesses; it must not suppress a real name match.
      withGlossary([term('t', 'TLA')]);
      const hits = await store.search('g', 'TLA', { minScore: 0.7 });
      expect(hits.map((h) => h.term)).toEqual(['TLA']);
    });
  });

  it('embeds the query with the retrieval instruction, not bare', async () => {
    // qwen3 pools on the last token, so the card's instruction is part of its trained
    // query interface. Measured over 75 paraphrase queries against a live glossary:
    // bare embed ranked the right term first 46/75, instructed 68/75. Stored entries
    // stay unprefixed, so this costs no re-index.
    const provider = fakeProvider();
    const s = new TerminologyStore({ qdrant: qdrant as unknown as QdrantClient, provider });
    await s.search('g', 'a descriptive question with no exact name match');
    expect(provider.embedQuery).toHaveBeenCalled();
    expect(provider.embed).not.toHaveBeenCalled();
    const used = qdrant.search.mock.calls.at(-1)![1] as { vector: number[] };
    expect(used.vector[0]).toBe(0.2);
  });

  it('returns [] gracefully on a missing collection', async () => {
    qdrant.search.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await store.search('g', 'q')).toEqual([]);
  });

  it('propagates a real failure instead of reporting an empty glossary', async () => {
    // An empty result and an unreachable store are indistinguishable to the
    // caller, so swallowing this silently disables glossary enrichment.
    qdrant.search.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    await expect(store.search('g', 'q')).rejects.toThrow('Unauthorized');
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
