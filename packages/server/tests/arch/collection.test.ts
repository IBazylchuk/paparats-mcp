import { describe, it, expect, vi } from 'vitest';
import {
  toArchCollectionName,
  fromArchCollectionName,
  isArchCollection,
  ensureArchCollection,
  dropArchCollection,
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
});

describe('dropArchCollection', () => {
  it('deletes the arch collection only', async () => {
    const qdrant = { deleteCollection: vi.fn().mockResolvedValue(undefined) };
    await dropArchCollection(qdrant as never, 'my-app');
    expect(qdrant.deleteCollection).toHaveBeenCalledWith('paparats_my-app_arch');
  });
});
