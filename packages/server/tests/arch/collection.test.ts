import { describe, it, expect, vi } from 'vitest';
import {
  toArchCollectionName,
  fromArchCollectionName,
  isArchCollection,
  ensureArchCollection,
  dropArchCollection,
  readArchCollectionMeta,
  writeArchCollectionMeta,
  ARCH_META_ID,
} from '../../src/arch/collection.js';

describe('arch collection name helpers', () => {
  it('builds an arch collection name from a group', () => {
    expect(toArchCollectionName('my-app')).toBe('paparats_my-app_arch');
  });

  it('parses an arch collection name back to a group', () => {
    expect(fromArchCollectionName('paparats_my-app_arch')).toBe('my-app');
  });

  it('returns null when name is not an arch collection', () => {
    expect(fromArchCollectionName('paparats_my-app')).toBeNull();
    expect(fromArchCollectionName('random')).toBeNull();
  });

  it('identifies arch collections', () => {
    expect(isArchCollection('paparats_my-app_arch')).toBe(true);
    expect(isArchCollection('paparats_my-app')).toBe(false);
  });
});

describe('ensureArchCollection', () => {
  it('creates the collection with the given dimensions when missing', async () => {
    const qdrant = {
      getCollection: vi.fn().mockRejectedValue(new Error('not found')),
      createCollection: vi.fn().mockResolvedValue(undefined),
      createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    };
    await ensureArchCollection(qdrant as never, 'my-app', 512);
    expect(qdrant.createCollection).toHaveBeenCalledWith('paparats_my-app_arch', {
      vectors: { size: 512, distance: 'Cosine' },
    });
    const indexFields = qdrant.createPayloadIndex.mock.calls.map(
      (c) => (c[1] as { field_name: string }).field_name
    );
    expect(indexFields).toEqual(
      expect.arrayContaining(['arch_kind', 'name', 'status', 'scope', 'supersedes'])
    );
  });

  it('skips creation when collection already exists', async () => {
    const qdrant = {
      getCollection: vi.fn().mockResolvedValue({}),
      createCollection: vi.fn(),
      createPayloadIndex: vi.fn(),
    };
    await ensureArchCollection(qdrant as never, 'my-app', 512);
    expect(qdrant.createCollection).not.toHaveBeenCalled();
  });

  it('stamps the embedding metadata sentinel when a model is given', async () => {
    const qdrant = {
      getCollection: vi.fn().mockRejectedValue(new Error('not found')),
      createCollection: vi.fn().mockResolvedValue(undefined),
      createPayloadIndex: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    await ensureArchCollection(qdrant as never, 'my-app', 1024, 'qwen3-embedding-0.6b');
    expect(qdrant.upsert).toHaveBeenCalledTimes(1);
    const points = (qdrant.upsert.mock.calls[0]![1] as { points: Array<Record<string, unknown>> })
      .points;
    expect(points[0]!.id).toBe(ARCH_META_ID);
    expect((points[0]!.payload as Record<string, unknown>)['__meta']).toBe(true);
    expect((points[0]!.payload as Record<string, unknown>)['model']).toBe('qwen3-embedding-0.6b');
  });

  it('does not stamp metadata when no model is given (backward compatible)', async () => {
    const qdrant = {
      getCollection: vi.fn().mockRejectedValue(new Error('not found')),
      createCollection: vi.fn().mockResolvedValue(undefined),
      createPayloadIndex: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    await ensureArchCollection(qdrant as never, 'my-app', 512);
    expect(qdrant.upsert).not.toHaveBeenCalled();
  });
});

describe('arch collection metadata sentinel', () => {
  it('reads back a stamped model + dimensions', async () => {
    const qdrant = {
      retrieve: vi.fn().mockResolvedValue([
        {
          id: ARCH_META_ID,
          payload: { __meta: true, model: 'qwen3-embedding-0.6b', dimensions: 1024 },
        },
      ]),
    };
    const meta = await readArchCollectionMeta(qdrant as never, 'my-app');
    expect(meta).toEqual({ model: 'qwen3-embedding-0.6b', dimensions: 1024 });
  });

  it('returns null when the sentinel is missing', async () => {
    const qdrant = { retrieve: vi.fn().mockResolvedValue([]) };
    expect(await readArchCollectionMeta(qdrant as never, 'my-app')).toBeNull();
  });

  it('returns null when the point is not a meta sentinel', async () => {
    const qdrant = {
      retrieve: vi
        .fn()
        .mockResolvedValue([{ id: ARCH_META_ID, payload: { model: 'x', dimensions: 1 } }]),
    };
    expect(await readArchCollectionMeta(qdrant as never, 'my-app')).toBeNull();
  });

  it('writes a zero-vector sentinel at the fixed id', async () => {
    const qdrant = { upsert: vi.fn().mockResolvedValue(undefined) };
    await writeArchCollectionMeta(qdrant as never, 'my-app', {
      model: 'bge-m3',
      dimensions: 3,
    });
    const points = (qdrant.upsert.mock.calls[0]![1] as { points: Array<Record<string, unknown>> })
      .points;
    expect(points[0]!.id).toBe(ARCH_META_ID);
    expect(points[0]!.vector).toEqual([0, 0, 0]);
  });
});

describe('dropArchCollection', () => {
  it('deletes the arch collection only', async () => {
    const qdrant = { deleteCollection: vi.fn().mockResolvedValue(undefined) };
    await dropArchCollection(qdrant as never, 'my-app');
    expect(qdrant.deleteCollection).toHaveBeenCalledWith('paparats_my-app_arch');
  });
});
