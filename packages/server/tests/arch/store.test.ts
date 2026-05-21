import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArchStore } from '../../src/arch/store.js';
import type { CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

function fakeProvider(): CachedEmbeddingProvider {
  return {
    dimensions: 512,
    model: 'jina-embeddings-v5-text-small',
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

  it('embeds the natural-language passage and writes a single point', async () => {
    const id = await store.upsertComponent('my-app', {
      name: 'indexer pipeline',
      summary: 'Indexes files into Qdrant',
      files: ['packages/server/src/indexer.ts'],
      neighbours: ['embedding cache'],
      anchors: ['Indexer'],
    });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(qdrant.upsert).toHaveBeenCalledTimes(1);
    const call = qdrant.upsert.mock.calls[0]!;
    expect(call[0]).toBe('paparats_my-app_arch');
    const point = (call[1] as { points: Array<{ id: string; payload: Record<string, unknown> }> })
      .points[0]!;
    expect(point.payload['arch_kind']).toBe('component');
    expect(point.payload['name']).toBe('indexer pipeline');
    expect(point.payload['files']).toEqual(['packages/server/src/indexer.ts']);
  });

  it('reuses the same id when a component with the same name exists', async () => {
    qdrant.scroll = vi.fn().mockResolvedValue({
      points: [{ id: 'existing-uuid', payload: { arch_kind: 'component', name: 'X' } }],
    });
    const id = await store.upsertComponent('my-app', {
      name: 'X',
      summary: 's',
      files: [],
      neighbours: [],
      anchors: [],
    });
    expect(id).toBe('existing-uuid');
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

describe('ArchStore.upsertDecision', () => {
  it('defaults status to accepted and supersedes to null', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.upsertDecision('my-app', {
      title: 'Use Qdrant',
      context: '...',
      decision: '...',
      consequences: '...',
      scope: 'global',
    });
    const point = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(point.payload['status']).toBe('accepted');
    expect(point.payload['supersedes']).toBeNull();
  });

  it('marks the old decision superseded when supersedes is given', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.upsertDecision('my-app', {
      title: 'new',
      context: 'c',
      decision: 'd',
      consequences: 'q',
      scope: 'global',
      supersedes: 'old-id',
    });
    expect(qdrant.setPayload).toHaveBeenCalledWith('paparats_my-app_arch', {
      payload: { status: 'superseded' },
      points: ['old-id'],
      wait: true,
    });
  });
});

describe('ArchStore.upsertLesson', () => {
  it('writes lesson with severity and global scope by default', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    await store.upsertLesson('my-app', {
      summary: 'Always use UUIDv7',
      scope: 'global',
      severity: 'warning',
    });
    const point = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(point.payload['arch_kind']).toBe('lesson');
    expect(point.payload['severity']).toBe('warning');
    expect(point.payload['status']).toBe('accepted');
  });
});

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
