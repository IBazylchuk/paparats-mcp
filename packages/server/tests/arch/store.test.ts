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
    retrieve: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
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

  it('writes a component point with project in payload and returns status=created', async () => {
    const result = await store.upsertComponent('my-app', {
      project: 'my-app',
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
    expect(point.payload['project']).toBe('my-app');
  });

  it('reuses id and returns status=updated when component with same (name, project) exists', async () => {
    qdrant.scroll = vi.fn().mockResolvedValue({
      points: [
        { id: 'existing-uuid', payload: { arch_kind: 'component', name: 'X', project: 'my-app' } },
      ],
    });
    const result = await store.upsertComponent('shared', {
      project: 'my-app',
      name: 'X',
      summary: 's',
      files: [],
      neighbours: [],
      anchors: [],
    });
    expect(result.status).toBe('updated');
    expect(result.id).toBe('existing-uuid');
  });

  it('isolates components by project: same name in different projects does not collide', async () => {
    // Scroll filter must include project — when it doesn't match, findByName
    // returns null and upsert creates a fresh card instead of overwriting.
    qdrant.scroll = vi.fn().mockResolvedValue({ points: [] });
    const result = await store.upsertComponent('shared', {
      project: 'app-b',
      name: 'indexer',
      summary: 's',
      files: [],
      neighbours: [],
      anchors: [],
    });
    expect(result.status).toBe('created');
    // Verify the scroll filter actually included project=app-b.
    const scrollFilter = (
      qdrant.scroll.mock.calls[0]![1] as {
        filter: { must: Array<{ key: string; match: { value: unknown } }> };
      }
    ).filter.must;
    const projectClause = scrollFilter.find((c) => c.key === 'project');
    expect(projectClause).toBeDefined();
    expect(projectClause!.match.value).toBe('app-b');
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
            project: 'my-app',
            createdAt: originalCreatedAt,
            updatedAt: originalCreatedAt,
          },
        },
      ],
    });
    await store.upsertComponent('my-app', {
      project: 'my-app',
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

  it('writes project to payload when provided, omits the field when not', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.upsertDecision('shared', {
      project: 'app-a',
      title: 'Scoped',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: '-',
      scope: 'global',
    });
    const withProject = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!.payload;
    expect(withProject['project']).toBe('app-a');

    await store.upsertDecision('shared', {
      title: 'Global',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: '-',
      scope: 'global',
    });
    const withoutProject = (
      qdrant.upsert.mock.calls[1]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!.payload;
    expect('project' in withoutProject).toBe(false);
  });

  it('similarity gate is scoped: identical decision in another project does not block the write', async () => {
    // Qdrant returns a duplicate-score hit but it belongs to project=app-b.
    // The gate must skip it and let the app-a write through.
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'b-prior',
        score: 0.95,
        payload: { arch_kind: 'decision', title: 'Same idea (app-b)', project: 'app-b' },
      },
    ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertDecision('shared', {
      project: 'app-a',
      title: 'Same idea (app-a)',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
    });
    expect(result.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
  });

  it('similarity gate visible scope: same-project duplicate still blocks, global duplicate also blocks a project write', async () => {
    // Two visible cases for an app-a write:
    //   1. duplicate already in app-a → block (already covered by base test, repeated here for clarity)
    //   2. duplicate sitting at global scope (no project field) → also block,
    //      because globals are visible to every project query.
    const qdrantSameProject = fakeQdrant();
    qdrantSameProject.search = vi.fn().mockResolvedValue([
      {
        id: 'a-prior',
        score: 0.92,
        payload: { arch_kind: 'decision', title: 'Prior', project: 'app-a' },
      },
    ]);
    const storeA = new ArchStore({
      qdrant: qdrantSameProject as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const sameProjectResult = await storeA.upsertDecision('shared', {
      project: 'app-a',
      title: 'Same again',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
    });
    expect(sameProjectResult.status).toBe('duplicate');
    expect(qdrantSameProject.upsert).not.toHaveBeenCalled();

    const qdrantGlobal = fakeQdrant();
    qdrantGlobal.search = vi.fn().mockResolvedValue([
      {
        id: 'global-prior',
        score: 0.92,
        payload: { arch_kind: 'decision', title: 'Cross-cutting prior' },
      },
    ]);
    const storeB = new ArchStore({
      qdrant: qdrantGlobal as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const globalVisibleResult = await storeB.upsertDecision('shared', {
      project: 'app-a',
      title: 'Same again',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
    });
    expect(globalVisibleResult.status).toBe('duplicate');
    expect(qdrantGlobal.upsert).not.toHaveBeenCalled();
  });

  it('global write does not get blocked by a project-scoped near-match', async () => {
    // Writing without project (global) and Qdrant returns a project-scoped
    // near-match. Gate must skip it; the global write proceeds.
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'a-prior',
        score: 0.95,
        payload: { arch_kind: 'decision', title: 'app-a only', project: 'app-a' },
      },
    ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertDecision('shared', {
      title: 'Cross-cutting',
      context: 'c',
      decision: 'd',
      alternativesRejected: '',
      consequences: 'q',
      scope: 'global',
    });
    expect(result.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
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

  it('writes project to payload when provided, omits the field when not', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.upsertLesson('shared', {
      project: 'app-a',
      rule: 'Always X.',
      why: 'because',
      when: 'when Y',
      scope: 'global',
      severity: 'info',
    });
    const withProject = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!.payload;
    expect(withProject['project']).toBe('app-a');

    await store.upsertLesson('shared', {
      rule: 'Global rule.',
      why: 'because',
      when: 'when Y',
      scope: 'global',
      severity: 'info',
    });
    const withoutProject = (
      qdrant.upsert.mock.calls[1]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!.payload;
    expect('project' in withoutProject).toBe(false);
  });

  it('similarity gate is scoped: identical lesson in another project does not bump or block', async () => {
    // Top-1 hit belongs to project=app-b. Writing the same rule in project=app-a
    // must create a fresh lesson — and crucially must NOT bumpUpdatedAt on
    // app-b's lesson.
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'b-lesson',
        score: 0.95,
        payload: { arch_kind: 'lesson', rule: 'Same rule', project: 'app-b' },
      },
    ]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertLesson('shared', {
      project: 'app-a',
      rule: 'Same rule',
      why: 'app-a context',
      when: 'app-a situation',
      scope: 'global',
      severity: 'info',
    });
    expect(result.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
    // bumpUpdatedAt for the duplicate path calls setPayload with updatedAt.
    // The cross-project hit must NOT trigger this.
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

// ── project filter ─────────────────────────────────────────────────────────

describe('ArchStore.searchWithVector project filter', () => {
  it('hard-filters components to project=X and lets decisions/lessons (project=X or no project) pass', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([
      {
        id: 'a-comp',
        score: 0.8,
        payload: {
          kind: 'component',
          name: 'a-comp',
          project: 'app-a',
          files: [],
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
          project: 'app-b',
          files: [],
          neighbours: [],
          anchors: [],
        },
      },
      {
        id: 'no-proj-comp',
        score: 0.77,
        payload: {
          kind: 'component',
          name: 'no-proj-comp',
          files: [],
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
        id: 'a-decision',
        score: 0.74,
        payload: { kind: 'decision', title: 'app-a decision', project: 'app-a', scope: 'global' },
      },
      {
        id: 'b-decision',
        score: 0.73,
        payload: { kind: 'decision', title: 'app-b decision', project: 'app-b', scope: 'global' },
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
      project: 'app-a',
    });
    const labels = out.map((h) => {
      const p = h as { name?: string; title?: string; rule?: string };
      return p.name ?? p.title ?? p.rule;
    });
    // Components: only app-a survives. no-proj-comp is dropped (hard filter).
    // Decisions: cross-cutting (no project) and app-a's pass; app-b's is dropped.
    // Lessons: rule has no project — passes.
    expect(labels).toEqual(['a-comp', 'cross-cutting', 'app-a decision', 'r']);
  });

  it('overfetches when project is set so the post-filter does not return short', async () => {
    const qdrant = fakeQdrant();
    qdrant.search = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.searchWithVector('shared', Array(512).fill(0), {
      limit: 5,
      project: 'app-a',
    });
    const searchArgs = qdrant.search.mock.calls[0]![1] as { limit: number };
    expect(searchArgs.limit).toBeGreaterThanOrEqual(15);
  });

  it('returns full limit-sized list when no project is set (no overfetch)', async () => {
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

  it('is best-effort: when the project filter leaves fewer hits than limit, returns the short list with a single Qdrant call (no recursive top-up)', async () => {
    // Overfetched 30 hits, only 2 match project=app-a. We return those 2 — we
    // do NOT issue a second qdrant.search to top up. Pin this behaviour so
    // nobody adds a recursive fetch loop under the hood later.
    const hits = Array.from({ length: 30 }, (_, i) => ({
      id: `c-${i}`,
      score: 0.8 - i * 0.01,
      payload: {
        kind: 'component',
        name: `c-${i}`,
        project: i < 2 ? 'app-a' : 'app-b',
        files: [],
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
      project: 'app-a',
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

// ── ArchStore.deletePoints ─────────────────────────────────────────────────

describe('ArchStore.deletePoints', () => {
  it('deletes every requested id when all are present and reports zero missing', async () => {
    const qdrant = fakeQdrant();
    qdrant.retrieve = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.deletePoints('my-app', ['a', 'b', 'c']);
    expect(result.deleted).toEqual(['a', 'b', 'c']);
    expect(result.notFound).toEqual([]);
    expect(qdrant.delete).toHaveBeenCalledWith('paparats_my-app_arch', {
      points: ['a', 'b', 'c'],
      wait: true,
    });
  });

  it('partitions missing ids into notFound and only deletes the found ones', async () => {
    const qdrant = fakeQdrant();
    qdrant.retrieve = vi.fn().mockResolvedValue([{ id: 'a' }, { id: 'c' }]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.deletePoints('my-app', ['a', 'b', 'c', 'd']);
    expect(result.deleted).toEqual(['a', 'c']);
    expect(result.notFound).toEqual(['b', 'd']);
    expect(qdrant.delete).toHaveBeenCalledWith('paparats_my-app_arch', {
      points: ['a', 'c'],
      wait: true,
    });
  });

  it('does not call qdrant.delete when every id is missing', async () => {
    const qdrant = fakeQdrant();
    qdrant.retrieve = vi.fn().mockResolvedValue([]);
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.deletePoints('my-app', ['x', 'y']);
    expect(result.deleted).toEqual([]);
    expect(result.notFound).toEqual(['x', 'y']);
    expect(qdrant.delete).not.toHaveBeenCalled();
  });

  it('treats a missing collection as "every id not found" — never throws', async () => {
    // First-run-of-a-migration safety: the arch collection may not exist yet.
    const qdrant = fakeQdrant();
    qdrant.retrieve = vi.fn().mockRejectedValue(new Error('collection not found'));
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.deletePoints('missing-group', ['a', 'b']);
    expect(result.deleted).toEqual([]);
    expect(result.notFound).toEqual(['a', 'b']);
    expect(qdrant.delete).not.toHaveBeenCalled();
  });

  it('returns immediately for an empty id list and makes no Qdrant calls', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.deletePoints('my-app', []);
    expect(result).toEqual({ deleted: [], notFound: [] });
    expect(qdrant.retrieve).not.toHaveBeenCalled();
    expect(qdrant.delete).not.toHaveBeenCalled();
  });
});
