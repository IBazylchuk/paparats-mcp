import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  DocsStore,
  DEFAULT_AUDIENCE,
  normalizeAudience,
  applyAudienceScope,
} from '../../src/docs/store.js';
import { DocsIdfStore } from '../../src/docs/idf-store.js';
import { NotMarkdownError } from '../../src/docs/chunker.js';
import {
  DOCS_DENSE_VECTOR,
  DOCS_SPARSE_VECTOR,
  toDocsCollectionName,
} from '../../src/docs/collection.js';
import type { CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

function fakeProvider(): CachedEmbeddingProvider {
  return {
    dimensions: 1024,
    model: 'qwen3-embedding-0.6b',
    embed: vi.fn(async () => Array(1024).fill(0.1)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.1))),
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
    query: vi.fn().mockResolvedValue({ points: [] }),
    retrieve: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  };
}

const tmpDbs: string[] = [];
function mkIdf(): DocsIdfStore {
  const p = path.join(
    os.tmpdir(),
    `docs-store-idf-${process.pid}-${tmpDbs.length}-${Math.floor(performance.now())}.db`
  );
  tmpDbs.push(p);
  return new DocsIdfStore(p);
}

afterEach(() => {
  for (const p of tmpDbs.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(p + suffix);
      } catch {
        // ignore
      }
    }
  }
});

const MD = `# Runbook

Intro paragraph about the runbook.

## Deploy

Run the deploy script and wait for green.

## Rollback

Run the rollback script if deploy fails.`;

describe('DocsStore.indexDocument', () => {
  let qdrant: ReturnType<typeof fakeQdrant>;
  let idf: DocsIdfStore;
  let store: DocsStore;

  beforeEach(() => {
    qdrant = fakeQdrant();
    idf = mkIdf();
    store = new DocsStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
      idf,
    });
  });

  it('throws NotMarkdownError on plain text (never reaches Qdrant)', async () => {
    await expect(
      store.indexDocument('g', { project: 'p', file: 'a.txt', content: 'just plain prose here' })
    ).rejects.toThrow(NotMarkdownError);
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('chunks, embeds, and upserts dense+sparse points with a shared doc_id', async () => {
    const n = await store.indexDocument('g', {
      project: 'billing',
      file: 'docs/runbook.md',
      content: MD,
      sourceUrl: 'https://conf/RUNBOOK',
    });
    expect(n).toBeGreaterThan(1);
    const call = qdrant.upsert.mock.calls.at(-1)![1] as {
      points: Array<{ vector: Record<string, unknown>; payload: Record<string, unknown> }>;
    };
    const points = call.points;
    // Every point carries the dense named vector.
    for (const pt of points) {
      expect(pt.vector[DOCS_DENSE_VECTOR]).toBeDefined();
    }
    // At least one carries a sparse vector.
    expect(points.some((pt) => pt.vector[DOCS_SPARSE_VECTOR])).toBe(true);
    // All chunks share one doc_id and carry project/file/source_url/heading_path.
    const docIds = new Set(points.map((pt) => pt.payload['doc_id']));
    expect(docIds.size).toBe(1);
    expect(points[0]!.payload['project']).toBe('billing');
    expect(points[0]!.payload['file']).toBe('docs/runbook.md');
    expect(points[0]!.payload['source_url']).toBe('https://conf/RUNBOOK');
    expect(Array.isArray(points[0]!.payload['heading_path'])).toBe(true);
  });

  it('deletes prior chunks for the same (project, file) before re-index', async () => {
    await store.indexDocument('g', { project: 'p', file: 'x.md', content: MD });
    expect(qdrant.delete).toHaveBeenCalled();
    const delArg = qdrant.delete.mock.calls[0]![1] as { filter: { must: unknown[] } };
    expect(delArg.filter.must).toContainEqual({ key: 'project', match: { value: 'p' } });
    expect(delArg.filter.must).toContainEqual({ key: 'file', match: { value: 'x.md' } });
  });

  it('records corpus stats in the IDF store', async () => {
    await store.indexDocument('g', { project: 'p', file: 'x.md', content: MD });
    const stats = idf.getCorpusStats('g');
    expect(stats.docCount).toBeGreaterThan(0);
    expect(stats.docFreq('rollback')).toBeGreaterThan(0);
  });

  it('feeds raw token length (not unique-term count) into avgDocLength', async () => {
    // A single-chunk doc whose tokens repeat: raw token count > unique count.
    // avgDocLength must reflect the RAW count so BM25 length normalisation
    // (docLength / avgDocLength) uses matching units.
    const content = '# Repeats\n\nalpha alpha alpha beta beta gamma';
    await store.indexDocument('g', { project: 'p', file: 'rep.md', content });
    const stats = idf.getCorpusStats('g');
    // Body tokens repeat (alpha×3, beta×2, gamma×1 → 6 raw vs 3 unique). With the
    // old bug avgDocLength tracked unique-term count; the fix makes it track raw
    // token length, which is strictly greater whenever any token repeats.
    const uniqueBody = new Set('alpha alpha alpha beta beta gamma'.split(' ')).size;
    expect(stats.docCount).toBe(1);
    expect(stats.avgDocLength).toBeGreaterThan(uniqueBody);
  });
});

describe('DocsStore.search', () => {
  let qdrant: ReturnType<typeof fakeQdrant>;
  let idf: DocsIdfStore;
  let store: DocsStore;

  beforeEach(() => {
    qdrant = fakeQdrant();
    idf = mkIdf();
    store = new DocsStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
      idf,
    });
  });

  it('issues a hybrid query with dense + sparse prefetch and RRF fusion', async () => {
    idf.addDocument('g', new Set(['rollback', 'deploy']), 2); // give the query sparse terms
    qdrant.query.mockResolvedValueOnce({
      points: [
        {
          score: 0.9,
          payload: {
            doc_id: 'd1',
            doc_title: 'Runbook',
            project: 'p',
            file: 'x.md',
            heading_path: ['Runbook', 'Rollback'],
            chunk_index: 2,
            content: 'Runbook > Rollback\n\nRun the rollback script.',
            startLine: 10,
            endLine: 12,
            source_url: null,
          },
        },
      ],
    });
    const hits = await store.search('g', 'how to rollback', { mergeNeighbours: 0 });
    expect(qdrant.query).toHaveBeenCalled();
    const arg = qdrant.query.mock.calls[0]![1] as {
      prefetch: Array<{ using: string }>;
      query: { fusion: string };
    };
    const usings = arg.prefetch.map((p) => p.using);
    expect(usings).toContain(DOCS_DENSE_VECTOR);
    expect(usings).toContain(DOCS_SPARSE_VECTOR);
    expect(arg.query.fusion).toBe('rrf');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.docTitle).toBe('Runbook');
  });

  it('excludes the meta sentinel from results', async () => {
    qdrant.query.mockResolvedValueOnce({
      points: [
        { score: 1, payload: { __meta: true } },
        {
          score: 0.5,
          payload: {
            doc_id: 'd1',
            doc_title: 'T',
            project: 'p',
            file: 'x.md',
            heading_path: [],
            chunk_index: 0,
            content: 'real chunk',
            startLine: 0,
            endLine: 1,
          },
        },
      ],
    });
    const hits = await store.search('g', 'q', { mergeNeighbours: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toBe('real chunk');
  });

  it('returns [] gracefully when the collection does not exist', async () => {
    qdrant.query.mockRejectedValueOnce(new Error('Not found'));
    const hits = await store.search('g', 'q');
    expect(hits).toEqual([]);
  });

  it('auto-merges neighbouring chunks of the top hit', async () => {
    qdrant.query.mockResolvedValueOnce({
      points: [
        {
          score: 0.9,
          payload: {
            doc_id: 'd1',
            doc_title: 'Doc',
            project: 'p',
            file: 'x.md',
            heading_path: ['Doc', 'S'],
            chunk_index: 1,
            content: 'Doc > S\n\nmiddle chunk',
            startLine: 5,
            endLine: 6,
          },
        },
      ],
    });
    // Neighbour scroll returns chunks 0,1,2 of the same doc.
    qdrant.scroll.mockResolvedValueOnce({
      points: [
        {
          payload: {
            doc_id: 'd1',
            doc_title: 'Doc',
            project: 'p',
            file: 'x.md',
            heading_path: ['Doc', 'S'],
            chunk_index: 0,
            content: 'Doc > S\n\nfirst chunk',
            startLine: 3,
            endLine: 4,
          },
        },
        {
          payload: {
            doc_id: 'd1',
            doc_title: 'Doc',
            project: 'p',
            file: 'x.md',
            heading_path: ['Doc', 'S'],
            chunk_index: 1,
            content: 'Doc > S\n\nmiddle chunk',
            startLine: 5,
            endLine: 6,
          },
        },
        {
          payload: {
            doc_id: 'd1',
            doc_title: 'Doc',
            project: 'p',
            file: 'x.md',
            heading_path: ['Doc', 'S'],
            chunk_index: 2,
            content: 'Doc > S\n\nlast chunk',
            startLine: 7,
            endLine: 8,
          },
        },
      ],
      next_page_offset: null,
    });
    const hits = await store.search('g', 'q', { mergeNeighbours: 1 });
    expect(hits).toHaveLength(1);
    // Merged content spans all three neighbours; breadcrumb prepended once.
    expect(hits[0]!.content).toContain('first chunk');
    expect(hits[0]!.content).toContain('middle chunk');
    expect(hits[0]!.content).toContain('last chunk');
    expect(hits[0]!.startLine).toBe(3);
    expect(hits[0]!.endLine).toBe(8);
  });
});

describe('DocsStore.healAllDocsModels', () => {
  it('re-embeds a group whose stored model differs', async () => {
    const qdrant = fakeQdrant();
    qdrant.getCollections.mockResolvedValue({
      collections: [{ name: toDocsCollectionName('g') }],
    });
    // Meta sentinel says an old model → mismatch → reindex.
    qdrant.retrieve.mockResolvedValue([
      { payload: { __meta: true, model: 'old-model', dimensions: 1024 } },
    ]);
    // reindexDocs scrolls chunks once, then empty.
    qdrant.scroll
      .mockResolvedValueOnce({
        points: [
          {
            id: 'c1',
            payload: {
              doc_id: 'd1',
              doc_title: 'T',
              project: 'p',
              file: 'x.md',
              heading_path: [],
              chunk_index: 0,
              content: 'some content to re-embed',
              startLine: 0,
              endLine: 1,
            },
          },
        ],
        next_page_offset: null,
      })
      .mockResolvedValue({ points: [], next_page_offset: null });
    qdrant.getCollection.mockResolvedValue({
      config: { params: { vectors: { [DOCS_DENSE_VECTOR]: { size: 1024 } } } },
    });
    const idf = mkIdf();
    const store = new DocsStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
      idf,
    });
    await store.healAllDocsModels();
    // Re-upserted the chunk + re-stamped the meta.
    expect(qdrant.upsert).toHaveBeenCalled();
  });
});

describe('normalizeAudience', () => {
  it('returns null for undefined (unrestricted)', () => {
    expect(normalizeAudience(undefined)).toBeNull();
  });

  it('wraps a single string into a one-element list', () => {
    expect(normalizeAudience('client')).toEqual(['client']);
  });

  it('trims, drops empties, and dedupes', () => {
    expect(normalizeAudience([' client ', 'client', '', '  ', 'public'])).toEqual([
      'client',
      'public',
    ]);
  });

  it('collapses an all-empty input to null (never an impossible filter)', () => {
    expect(normalizeAudience(['', '   '])).toBeNull();
  });
});

describe('applyAudienceScope (fail-closed intersection)', () => {
  it('no scope → request stands (including unrestricted null)', () => {
    expect(applyAudienceScope(null, null)).toBeNull();
    expect(applyAudienceScope(['client'], null)).toEqual(['client']);
  });

  it('scope but no request → scope applies (a request cannot opt out of the ceiling)', () => {
    expect(applyAudienceScope(null, ['client', 'public'])).toEqual(['client', 'public']);
  });

  it('intersects both, never widening past the scope', () => {
    // request asks for internal+client, scope only allows client → client only
    expect(applyAudienceScope(['internal', 'client'], ['client', 'public'])).toEqual(['client']);
  });

  it('disjoint request/scope → empty set (match nothing), not a silent widen', () => {
    expect(applyAudienceScope(['internal'], ['client'])).toEqual([]);
  });
});

describe('DocsStore audience — payload + search filter', () => {
  let qdrant: ReturnType<typeof fakeQdrant>;
  let idf: DocsIdfStore;
  let store: DocsStore;

  beforeEach(() => {
    qdrant = fakeQdrant();
    idf = mkIdf();
    store = new DocsStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
      idf,
    });
  });

  it('stamps the explicit audience into every chunk payload', async () => {
    await store.indexDocument('g', {
      project: 'p',
      file: 'x.md',
      content: '# Title\n\nSome prose that is long enough to chunk.',
      audience: 'client',
    });
    const call = qdrant.upsert.mock.calls.at(-1)![1] as {
      points: Array<{ payload: Record<string, unknown> }>;
    };
    expect(call.points.length).toBeGreaterThan(0);
    for (const pt of call.points) expect(pt.payload.audience).toBe('client');
  });

  it('defaults a missing audience to internal (fail-closed)', async () => {
    await store.indexDocument('g', {
      project: 'p',
      file: 'x.md',
      content: '# Title\n\nSome prose that is long enough to chunk.',
    });
    const call = qdrant.upsert.mock.calls.at(-1)![1] as {
      points: Array<{ payload: Record<string, unknown> }>;
    };
    for (const pt of call.points) expect(pt.payload.audience).toBe(DEFAULT_AUDIENCE);
  });

  it('reads back a missing payload audience as internal', async () => {
    qdrant.query.mockResolvedValueOnce({
      points: [
        {
          score: 0.5,
          payload: {
            doc_id: 'd1',
            doc_title: 'T',
            project: 'p',
            file: 'x.md',
            heading_path: [],
            chunk_index: 0,
            content: 'legacy chunk with no audience field',
            startLine: 0,
            endLine: 1,
          },
        },
      ],
    });
    const hits = await store.search('g', 'q', { mergeNeighbours: 0 });
    expect(hits[0]!.audience).toBe(DEFAULT_AUDIENCE);
  });

  it('adds a match-any audience clause to every prefetch when filtered', async () => {
    idf.addDocument('g', new Set(['rollback']), 1);
    await store.search('g', 'rollback', { audience: ['client', 'public'], mergeNeighbours: 0 });
    const arg = qdrant.query.mock.calls[0]![1] as {
      prefetch: Array<{ filter?: { must: Array<Record<string, unknown>> } }>;
    };
    for (const pf of arg.prefetch) {
      const clause = pf.filter?.must.find((m) => m['key'] === 'audience');
      expect(clause).toBeDefined();
      expect((clause as { match: { any: string[] } }).match.any).toEqual(['client', 'public']);
    }
  });

  it('omits the audience clause entirely when unrestricted', async () => {
    await store.search('g', 'q', { mergeNeighbours: 0 });
    const arg = qdrant.query.mock.calls[0]![1] as {
      prefetch: Array<{ filter?: { must: Array<Record<string, unknown>> } }>;
    };
    for (const pf of arg.prefetch) {
      const clause = pf.filter?.must?.find((m) => m['key'] === 'audience');
      expect(clause).toBeUndefined();
    }
  });
});
