import { describe, it, expect, vi } from 'vitest';
import {
  toDocsCollectionName,
  fromDocsCollectionName,
  isDocsCollection,
  ensureDocsCollection,
  DOCS_DENSE_VECTOR,
  DOCS_SPARSE_VECTOR,
} from '../../src/docs/collection.js';
import { TOKENIZER_VERSION } from '../../src/docs/bm25.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

describe('docs collection naming', () => {
  it('round-trips group ↔ collection name', () => {
    expect(toDocsCollectionName('my-app')).toBe('paparats_my-app_docs');
    expect(fromDocsCollectionName('paparats_my-app_docs')).toBe('my-app');
  });

  it('rejects non-docs collection names', () => {
    expect(fromDocsCollectionName('paparats_my-app')).toBeNull();
    // The code collection of a group named `docs`, not a sidecar of ''.
    expect(fromDocsCollectionName('paparats_docs')).toBeNull();
    expect(fromDocsCollectionName('paparats_my-app_arch')).toBeNull();
    expect(isDocsCollection('paparats_my-app_docs')).toBe(true);
    expect(isDocsCollection('paparats_my-app_arch')).toBe(false);
  });
});

describe('ensureDocsCollection', () => {
  it('creates a collection with named dense + sparse vectors when missing', async () => {
    const qdrant = {
      getCollection: vi.fn().mockRejectedValue(new Error('missing')),
      createCollection: vi.fn().mockResolvedValue(undefined),
      createPayloadIndex: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    await ensureDocsCollection(
      qdrant as unknown as QdrantClient,
      'g',
      1024,
      'qwen3-embedding-0.6b'
    );
    const arg = qdrant.createCollection.mock.calls[0]![1] as {
      vectors: Record<string, unknown>;
      sparse_vectors: Record<string, unknown>;
    };
    expect(arg.vectors[DOCS_DENSE_VECTOR]).toEqual({ size: 1024, distance: 'Cosine' });
    expect(arg.sparse_vectors[DOCS_SPARSE_VECTOR]).toEqual({ modifier: 'idf' });
    const sentinel = (
      qdrant.upsert.mock.calls[0]![1] as { points: Array<{ payload: Record<string, unknown> }> }
    ).points[0]!;
    expect(sentinel.payload).toMatchObject({
      model: 'qwen3-embedding-0.6b',
      dimensions: 1024,
      tokenizer_version: TOKENIZER_VERSION,
    });
  });

  it('is a no-op when the collection already exists', async () => {
    const qdrant = {
      getCollection: vi.fn().mockResolvedValue({}),
      createCollection: vi.fn(),
    };
    await ensureDocsCollection(qdrant as unknown as QdrantClient, 'g', 1024);
    expect(qdrant.createCollection).not.toHaveBeenCalled();
  });
});
