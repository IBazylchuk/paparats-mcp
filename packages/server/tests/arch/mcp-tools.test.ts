import { describe, it, expect, vi } from 'vitest';
import { SUPPORT_TOOLS, CODING_TOOLS, pickArchContextEmptyText } from '../../src/mcp-handler.js';
import { LOW_CONFIDENCE_HINT } from '../../src/arch/context.js';
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

describe('pickArchContextEmptyText', () => {
  it('returns LOW_CONFIDENCE_HINT verbatim in both modes when memory exists but matched nothing', () => {
    expect(pickArchContextEmptyText(LOW_CONFIDENCE_HINT, 'coding')).toBe(LOW_CONFIDENCE_HINT);
    expect(pickArchContextEmptyText(LOW_CONFIDENCE_HINT, 'support')).toBe(LOW_CONFIDENCE_HINT);
  });

  it('returns a support-safe message when the group has no memory at all', () => {
    const supportText = pickArchContextEmptyText(null, 'support');
    // Must not mention any writer tool — support mode can't reach them.
    expect(supportText).not.toMatch(/arch_record_/);
    expect(supportText).toMatch(/coding mode/);
  });

  it('returns the INIT_HINT (or default coding fallback) in coding mode', () => {
    const codingDefault = pickArchContextEmptyText(null, 'coding');
    expect(codingDefault).toMatch(/arch_record_component/);

    const fromHint = 'Custom init hint with arch_record_component reference.';
    expect(pickArchContextEmptyText(fromHint, 'coding')).toBe(fromHint);
  });
});

describe('arch tool exposure per mode', () => {
  it('coding mode exposes the full arch toolkit (read + write + delete)', () => {
    expect(CODING_TOOLS.has('arch_context')).toBe(true);
    expect(CODING_TOOLS.has('arch_record_component')).toBe(true);
    expect(CODING_TOOLS.has('arch_record_decision')).toBe(true);
    expect(CODING_TOOLS.has('arch_record_lesson')).toBe(true);
    expect(CODING_TOOLS.has('arch_delete')).toBe(true);
  });

  it('support mode is read-only — only arch_context, no arch_record_*, no arch_delete', () => {
    expect(SUPPORT_TOOLS.has('arch_context')).toBe(true);
    expect(SUPPORT_TOOLS.has('arch_record_component')).toBe(false);
    expect(SUPPORT_TOOLS.has('arch_record_decision')).toBe(false);
    expect(SUPPORT_TOOLS.has('arch_record_lesson')).toBe(false);
    expect(SUPPORT_TOOLS.has('arch_delete')).toBe(false);
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
