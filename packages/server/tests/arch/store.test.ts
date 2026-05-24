import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArchStore } from '../../src/arch/store.js';
import type { CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

function fakeProvider(): CachedEmbeddingProvider {
  return {
    dimensions: 512,
    model: 'bge-m3',
    embed: vi.fn(async () => Array(512).fill(0.1)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => Array(512).fill(0.1))),
    embedQuery: vi.fn(async () => Array(512).fill(0.1)),
    embedPassage: vi.fn(async () => Array(512).fill(0.1)),
    embedBatchPassage: vi.fn(async (texts: string[]) => texts.map(() => Array(512).fill(0.1))),
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
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    search: vi.fn().mockResolvedValue([]),
    setPayload: vi.fn().mockResolvedValue(undefined),
  };
}

// ── ArchStore.upsertComponent (no similarity gate — idempotent by name) ────

describe('ArchStore.upsertComponent', () => {
  let qdrant: ReturnType<typeof fakeQdrant>;
  let store: ArchStore;

  beforeEach(() => {
    qdrant = fakeQdrant();
    store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
  });

  it('writes a component point and returns status=created', async () => {
    const result = await store.upsertComponent('my-app', {
      name: 'indexer pipeline',
      summary: '**Does:** indexes files.',
      files: ['packages/server/src/indexer.ts'],
      neighbours: ['embedding cache'],
      anchors: ['Indexer'],
    });
    expect(result.status).toBe('created');
    expect(typeof result.id).toBe('string');
    expect(qdrant.upsert).toHaveBeenCalledTimes(1);
    const point = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(point.payload['arch_kind']).toBe('component');
    expect(point.payload['name']).toBe('indexer pipeline');
  });

  it('reuses id and returns status=updated when component with same name exists', async () => {
    qdrant.scroll = vi.fn().mockResolvedValue({
      points: [{ id: 'existing-uuid', payload: { arch_kind: 'component', name: 'X' } }],
    });
    const result = await store.upsertComponent('my-app', {
      name: 'X',
      summary: 's',
      files: [],
      neighbours: [],
      anchors: [],
    });
    expect(result.status).toBe('updated');
    expect(result.id).toBe('existing-uuid');
  });

  it('preserves createdAt when re-upserting an existing component', async () => {
    const originalCreatedAt = 1700000000000;
    qdrant.scroll = vi.fn().mockResolvedValue({
      points: [
        {
          id: 'existing-uuid',
          payload: {
            arch_kind: 'component',
            name: 'X',
            createdAt: originalCreatedAt,
            updatedAt: originalCreatedAt,
          },
        },
      ],
    });
    await store.upsertComponent('my-app', {
      name: 'X',
      summary: 'updated summary',
      files: [],
      neighbours: [],
      anchors: [],
    });
    const point = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(point.payload['createdAt']).toBe(originalCreatedAt);
    expect(point.payload['updatedAt']).not.toBe(originalCreatedAt);
  });
});

// ── ArchStore.upsertDecision (similarity gate) ─────────────────────────────

describe('ArchStore.upsertDecision', () => {
  it('creates a new decision when nothing similar exists', async () => {
    const qdrant = fakeQdrant();
    // nearest-search returns nothing
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertDecision('my-app', {
      title: 'Use Qdrant',
      context: 'need vector db',
      decision: 'use Qdrant',
      alternativesRejected: '',
      consequences: 'self-host',
      scope: 'global',
    });
    expect(result.status).toBe('created');
    const point = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(point.payload['status']).toBe('accepted');
    expect(point.payload['supersedes']).toBeNull();
    expect(point.payload['alternativesRejected']).toBe('');
  });

  it('returns status=duplicate when a near-identical decision exists (>= 0.85)', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi
      .fn()
      .mockResolvedValue([
        { id: 'prior-uuid', score: 0.9, payload: { arch_kind: 'decision', title: 'Prior choice' } },
      ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertDecision('my-app', {
      title: 'Same again',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
    });
    expect(result.status).toBe('duplicate');
    expect(result.id).toBe('prior-uuid');
    expect(result.similarity).toBe(0.9);
    expect(result.matchedLabel).toBe('Prior choice');
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('returns status=similar when a related decision exists (0.70 <= sim < 0.85)', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi
      .fn()
      .mockResolvedValue([
        { id: 'related-uuid', score: 0.7, payload: { arch_kind: 'decision', title: 'Related' } },
      ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertDecision('my-app', {
      title: 'Different but related',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
    });
    expect(result.status).toBe('similar');
    expect(result.id).toBe('related-uuid');
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });

  it('bypasses similarity gate when supersedes is explicit', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi
      .fn()
      .mockResolvedValue([
        { id: 'prior-uuid', score: 0.95, payload: { arch_kind: 'decision', title: 'Prior' } },
      ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertDecision('my-app', {
      title: 'new',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
      supersedes: 'old-id',
    });
    expect(result.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
    expect(qdrant.setPayload).toHaveBeenCalledWith('paparats_my-app_arch', {
      payload: { status: 'superseded' },
      points: ['old-id'],
      wait: true,
    });
  });
});

// ── ArchStore.upsertLesson (similarity gate; duplicates bump updatedAt) ────

describe('ArchStore.upsertLesson', () => {
  it('creates a new lesson when nothing similar exists', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertLesson('my-app', {
      rule: 'Always use UUIDv7',
      why: 'time ordering matters for Qdrant',
      when: 'when generating an id for any entity',
      scope: 'global',
      severity: 'warning',
    });
    expect(result.status).toBe('created');
    const point = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(point.payload['arch_kind']).toBe('lesson');
    expect(point.payload['rule']).toBe('Always use UUIDv7');
    expect(point.payload['why']).toBeDefined();
    expect(point.payload['when']).toBeDefined();
    expect(point.payload['severity']).toBe('warning');
  });

  it('returns status=updated and bumps updatedAt on duplicate lesson', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi
      .fn()
      .mockResolvedValue([
        { id: 'lesson-uuid', score: 0.9, payload: { arch_kind: 'lesson', rule: 'Use UUIDv7' } },
      ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertLesson('my-app', {
      rule: 'Always pick UUIDv7',
      why: 'same reason',
      when: 'same situation',
      scope: 'global',
      severity: 'warning',
    });
    expect(result.status).toBe('updated');
    expect(result.id).toBe('lesson-uuid');
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect(qdrant.setPayload).toHaveBeenCalledWith(
      'paparats_my-app_arch',
      expect.objectContaining({
        points: ['lesson-uuid'],
        payload: expect.objectContaining({ updatedAt: expect.any(Number) }),
      })
    );
  });

  it('returns status=similar without writing when sim is in the mid band', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi
      .fn()
      .mockResolvedValue([
        { id: 'lesson-uuid', score: 0.7, payload: { arch_kind: 'lesson', rule: 'Related rule' } },
      ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertLesson('my-app', {
      rule: 'A related but distinct rule',
      why: 'different reason',
      when: 'overlapping situation',
      scope: 'global',
      severity: 'info',
    });
    expect(result.status).toBe('similar');
    expect(result.id).toBe('lesson-uuid');
    expect(qdrant.upsert).not.toHaveBeenCalled();
    expect(qdrant.setPayload).not.toHaveBeenCalled();
  });
});

// ── ArchStore.search (unchanged contract) ──────────────────────────────────

describe('ArchStore.search', () => {
  it('embeds the query and filters by arch_kind when given', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'a',
        score: 0.9,
        payload: {
          arch_kind: 'component',
          kind: 'component',
          id: 'a',
          name: 'X',
          summary: 's',
          files: [],
          neighbours: [],
          anchors: [],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const out = await store.search('my-app', 'how does indexing work', {
      kinds: ['component'],
      limit: 5,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('component');
    const searchArgs = qdrant.search.mock.calls[0]![1] as { filter: { must: unknown[] } };
    expect(JSON.stringify(searchArgs.filter)).toContain('arch_kind');
  });

  it('hides superseded/deprecated by default', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.search('my-app', 'x', { limit: 5 });
    const searchArgs = qdrant.search.mock.calls[0]![1] as { filter: { must_not: unknown[] } };
    const must_not = JSON.stringify(searchArgs.filter.must_not);
    expect(must_not).toContain('superseded');
    expect(must_not).toContain('deprecated');
  });

  it('includes superseded when includeHistory=true', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.search('my-app', 'x', { includeHistory: true, limit: 5 });
    const searchArgs = qdrant.search.mock.calls[0]![1] as {
      filter?: { must_not?: unknown[] };
    };
    if (searchArgs.filter && searchArgs.filter.must_not) {
      expect(JSON.stringify(searchArgs.filter.must_not)).not.toContain('superseded');
    }
  });
});

describe('ArchStore.searchWithVector', () => {
  it('skips embedding when caller supplies a pre-computed vector', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const provider = fakeProvider();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider,
    });
    const vector = Array(512).fill(0.5);
    await store.searchWithVector('my-app', vector, { limit: 3 });
    expect(provider.embed).not.toHaveBeenCalled();
    const searchArgs = qdrant.search.mock.calls[0]![1] as { vector: number[]; limit: number };
    expect(searchArgs.vector).toBe(vector);
    expect(searchArgs.limit).toBe(3);
  });
});

describe('ArchStore.markSuperseded', () => {
  it('flips status payload on the target point', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.markSuperseded('my-app', 'old-id');
    expect(qdrant.setPayload).toHaveBeenCalledWith('paparats_my-app_arch', {
      payload: { status: 'superseded' },
      points: ['old-id'],
      wait: true,
    });
  });
});

describe('ArchStore.bumpUpdatedAt', () => {
  it('writes only updatedAt to the target point', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.bumpUpdatedAt('my-app', 'lesson-id');
    expect(qdrant.setPayload).toHaveBeenCalledWith('paparats_my-app_arch', {
      payload: { updatedAt: expect.any(Number) },
      points: ['lesson-id'],
      wait: true,
    });
  });
});

// ── min_score filter ───────────────────────────────────────────────────────

describe('ArchStore.searchWithVector min_score filter', () => {
  it('drops hits below the minScore threshold and attaches the score to survivors', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'hi',
        score: 0.8,
        payload: { kind: 'component', name: 'hi', files: [], neighbours: [], anchors: [] },
      },
      {
        id: 'mid',
        score: 0.55,
        payload: { kind: 'component', name: 'mid', files: [], neighbours: [], anchors: [] },
      },
      {
        id: 'lo',
        score: 0.3,
        payload: { kind: 'component', name: 'lo', files: [], neighbours: [], anchors: [] },
      },
    ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const out = await store.searchWithVector('my-app', Array(512).fill(0), { minScore: 0.5 });
    expect(out.map((h) => h.name)).toEqual(['hi', 'mid']);
    expect(out.map((h) => h.score)).toEqual([0.8, 0.55]);
  });
});

// ── pathPrefixes filter ────────────────────────────────────────────────────

describe('ArchStore.searchWithVector pathPrefixes filter', () => {
  it('keeps only components whose files start with one of the prefixes, and lets non-file kinds through', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'a-comp',
        score: 0.8,
        payload: {
          kind: 'component',
          name: 'a-comp',
          files: ['service-a/src/x.ts'],
          neighbours: [],
          anchors: [],
        },
      },
      {
        id: 'b-comp',
        score: 0.78,
        payload: {
          kind: 'component',
          name: 'b-comp',
          files: ['service-b/src/y.ts'],
          neighbours: [],
          anchors: [],
        },
      },
      {
        id: 'global-decision',
        score: 0.75,
        payload: { kind: 'decision', title: 'cross-cutting', scope: 'global' },
      },
      {
        id: 'rule',
        score: 0.7,
        payload: { kind: 'lesson', rule: 'r', scope: 'global', severity: 'info' },
      },
    ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const out = await store.searchWithVector('shared', Array(512).fill(0), {
      pathPrefixes: ['service-a/'],
    });
    const names = out.map((h) => {
      const p = h as { name?: string; title?: string; rule?: string };
      return p.name ?? p.title ?? p.rule;
    });
    expect(names).toEqual(['a-comp', 'cross-cutting', 'r']);
  });

  it('overfetches when a prefix is set so the post-filter does not return short', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.searchWithVector('shared', Array(512).fill(0), {
      limit: 5,
      pathPrefixes: ['service-a/'],
    });
    const searchArgs = qdrant.search.mock.calls[0]![1] as { limit: number };
    expect(searchArgs.limit).toBeGreaterThanOrEqual(15);
  });

  it('returns full limit-sized list when no prefix is set (no overfetch)', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.searchWithVector('shared', Array(512).fill(0), { limit: 5 });
    const searchArgs = qdrant.search.mock.calls[0]![1] as { limit: number };
    expect(searchArgs.limit).toBe(5);
  });

  it('is best-effort: when the prefix filter leaves fewer hits than limit, returns the short list with a single Qdrant call (no recursive top-up)', async () => {
    // Overfetched 30 hits, only 2 match the prefix. We return those 2 — we
    // do NOT issue a second qdrant.search to top up. Pin this behaviour so
    // nobody adds a recursive fetch loop under the hood later.
    const hits = Array.from({ length: 30 }, (_, i) => ({
      id: `c-${i}`,
      score: 0.8 - i * 0.01,
      payload: {
        kind: 'component',
        name: `c-${i}`,
        files: [i < 2 ? 'service-a/src/x.ts' : 'service-b/src/y.ts'],
        neighbours: [],
        anchors: [],
      },
    }));
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue(hits);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const out = await store.searchWithVector('shared', Array(512).fill(0), {
      limit: 10,
      pathPrefixes: ['service-a/'],
    });
    expect(out).toHaveLength(2);
    expect(qdrant.search).toHaveBeenCalledTimes(1);
  });
});

// ── stats() ────────────────────────────────────────────────────────────────

describe('ArchStore.stats', () => {
  it('aggregates kind/status counts and oldest/newest updatedAt across pages', async () => {
    const qdrant = fakeQdrant();
    // First page returns 2 points + an offset; second page returns 1 point and no offset.
    let calls = 0;
    qdrant.scroll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          points: [
            { id: '1', payload: { arch_kind: 'component', status: 'accepted', updatedAt: 100 } },
            { id: '2', payload: { arch_kind: 'decision', status: 'superseded', updatedAt: 200 } },
          ],
          next_page_offset: 'page-2',
        };
      }
      return {
        points: [{ id: '3', payload: { arch_kind: 'lesson', status: 'accepted', updatedAt: 50 } }],
      };
    });
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const stats = await store.stats('my-app');
    expect(stats.total).toBe(3);
    expect(stats.byKind).toEqual({ component: 1, decision: 1, lesson: 1 });
    expect(stats.byStatus.accepted).toBe(2);
    expect(stats.byStatus.superseded).toBe(1);
    expect(stats.oldestUpdatedAt).toBe(50);
    expect(stats.newestUpdatedAt).toBe(200);
  });

  it('returns zeros when scroll throws (collection missing)', async () => {
    const qdrant = fakeQdrant();
    qdrant.scroll = vi.fn().mockRejectedValue(new Error('no such collection'));
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const stats = await store.stats('empty-group');
    expect(stats.total).toBe(0);
    expect(stats.byKind).toEqual({ component: 0, decision: 0, lesson: 0 });
    expect(stats.oldestUpdatedAt).toBeNull();
  });
});
