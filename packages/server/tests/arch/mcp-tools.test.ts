import { describe, it, expect, vi } from 'vitest';
import { SUPPORT_TOOLS } from '../../src/mcp-handler.js';
import { ArchStore } from '../../src/arch/store.js';
import type { CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

function fakeProvider(): CachedEmbeddingProvider {
  return {
    dimensions: 512,
    model: 'jina-embeddings-v5-text-small',
    embed: vi.fn(async () => Array(512).fill(0.1)),
    embedBatch: vi.fn(),
    embedQuery: vi.fn(),
    embedPassage: vi.fn(),
    embedBatchPassage: vi.fn(),
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
    createCollection: vi.fn(),
    createPayloadIndex: vi.fn(),
    upsert: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    search: vi.fn().mockResolvedValue([]),
    setPayload: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn(),
  };
}

describe('SUPPORT_TOOLS', () => {
  it('includes the four arch tools', () => {
    expect(SUPPORT_TOOLS.has('arch_context')).toBe(true);
    expect(SUPPORT_TOOLS.has('arch_record_component')).toBe(true);
    expect(SUPPORT_TOOLS.has('arch_record_decision')).toBe(true);
    expect(SUPPORT_TOOLS.has('arch_record_lesson')).toBe(true);
  });
});

describe('ArchStore wiring sanity', () => {
  it('an ArchStore built with mocks round-trips upsert + upsert call', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertComponent('my-app', {
      name: 'X',
      summary: 's',
      files: [],
      neighbours: [],
      anchors: [],
    });
    expect(typeof result.id).toBe('string');
    expect(result.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
  });
});
