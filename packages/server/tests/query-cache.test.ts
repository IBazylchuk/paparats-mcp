import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryCache } from '../src/query-cache.js';
import type { SearchResponse } from '../src/types.js';

function makeResponse(content = 'test'): SearchResponse {
  return {
    results: [
      {
        project: 'p',
        file: 'f.ts',
        language: 'typescript',
        startLine: 0,
        endLine: 10,
        content,
        score: 0.9,
        hash: `hash-${content}`,
        chunk_id: null,
        symbol_name: null,
        kind: null,
        service: null,
        bounded_context: null,
        tags: [],
        last_commit_at: null,
        defines_symbols: [],
        uses_symbols: [],
      },
    ],
    total: 1,
    metrics: {
      tokensReturned: 10,
      estimatedFullFileTokens: 100,
      tokensSaved: 90,
      savingsPercent: 90,
    },
  };
}

describe('QueryCache', () => {
  let cache: QueryCache;

  beforeEach(() => {
    cache = new QueryCache({ maxEntries: 10, ttlMs: 5000 });
  });

  it('buildKey returns consistent hash for same inputs', () => {
    const key1 = cache.buildKey('group', 'query', { project: 'p', limit: 5 });
    const key2 = cache.buildKey('group', 'query', { project: 'p', limit: 5 });
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64); // SHA-256 hex
  });

  it('buildKey returns different hashes for different inputs', () => {
    const key1 = cache.buildKey('group', 'query1');
    const key2 = cache.buildKey('group', 'query2');
    expect(key1).not.toBe(key2);
  });

  it('buildKey includes filter in hash', () => {
    const key1 = cache.buildKey('group', 'query');
    const key2 = cache.buildKey('group', 'query', undefined, {
      must: [{ key: 'last_commit_at', range: { gte: '2024-01-01' } }],
    });
    expect(key1).not.toBe(key2);
  });

  it('get/set roundtrip works', () => {
    const key = cache.buildKey('group', 'query');
    const response = makeResponse();

    cache.set(key, 'group', response);
    const cached = cache.get(key);

    expect(cached).toEqual(response);
  });

  it('get returns null for missing key', () => {
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('get returns null for expired entry', () => {
    vi.useFakeTimers();
    try {
      const shortCache = new QueryCache({ maxEntries: 10, ttlMs: 100 });
      const key = shortCache.buildKey('group', 'query');
      shortCache.set(key, 'group', makeResponse());

      // Not expired yet
      expect(shortCache.get(key)).not.toBeNull();

      // Advance past TTL
      vi.advanceTimersByTime(200);
      expect(shortCache.get(key)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts oldest entry when at capacity', () => {
    const tinyCache = new QueryCache({ maxEntries: 3, ttlMs: 60_000 });

    // Fill to capacity
    for (let i = 0; i < 3; i++) {
      const key = tinyCache.buildKey('group', `query-${i}`);
      tinyCache.set(key, 'group', makeResponse(`content-${i}`));
    }
    expect(tinyCache.getStats().size).toBe(3);

    // Add one more — should evict oldest (query-0)
    const newKey = tinyCache.buildKey('group', 'query-new');
    tinyCache.set(newKey, 'group', makeResponse('new'));

    expect(tinyCache.getStats().size).toBe(3);
    expect(tinyCache.getStats().evictions).toBe(1);

    // Oldest should be gone
    const oldKey = tinyCache.buildKey('group', 'query-0');
    expect(tinyCache.get(oldKey)).toBeNull();

    // Newest should be present
    expect(tinyCache.get(newKey)).not.toBeNull();
  });

  it('LRU: accessing an entry moves it to the end', () => {
    const tinyCache = new QueryCache({ maxEntries: 3, ttlMs: 60_000 });

    const key0 = tinyCache.buildKey('group', 'query-0');
    const key1 = tinyCache.buildKey('group', 'query-1');
    const key2 = tinyCache.buildKey('group', 'query-2');

    tinyCache.set(key0, 'group', makeResponse('0'));
    tinyCache.set(key1, 'group', makeResponse('1'));
    tinyCache.set(key2, 'group', makeResponse('2'));

    // Access key0 to make it most recently used
    tinyCache.get(key0);

    // Add a new entry — should evict key1 (oldest non-accessed)
    const key3 = tinyCache.buildKey('group', 'query-3');
    tinyCache.set(key3, 'group', makeResponse('3'));

    expect(tinyCache.get(key0)).not.toBeNull(); // Still there (was accessed)
    expect(tinyCache.get(key1)).toBeNull(); // Evicted
    expect(tinyCache.get(key2)).not.toBeNull(); // Still there
  });

  it('invalidateGroup removes only entries for that group', () => {
    const keyA = cache.buildKey('group-a', 'query');
    const keyB = cache.buildKey('group-b', 'query');

    cache.set(keyA, 'group-a', makeResponse('a'));
    cache.set(keyB, 'group-b', makeResponse('b'));

    expect(cache.getStats().size).toBe(2);

    cache.invalidateGroup('group-a');

    expect(cache.getStats().size).toBe(1);
    expect(cache.get(keyA)).toBeNull();
    expect(cache.get(keyB)).not.toBeNull();
  });

  it('clear removes all entries', () => {
    cache.set(cache.buildKey('g', 'q1'), 'g', makeResponse('1'));
    cache.set(cache.buildKey('g', 'q2'), 'g', makeResponse('2'));

    expect(cache.getStats().size).toBe(2);
    cache.clear();
    expect(cache.getStats().size).toBe(0);
  });

  it('stats track hits and misses correctly', () => {
    const key = cache.buildKey('g', 'q');
    cache.set(key, 'g', makeResponse());

    // 1 hit
    cache.get(key);
    // 2 misses
    cache.get('nonexistent1');
    cache.get('nonexistent2');

    const stats = cache.getStats();
    expect(stats.hitCount).toBe(1);
    expect(stats.missCount).toBe(2);
    expect(stats.hitRate).toBeCloseTo(1 / 3);
  });

  it('stats hitRate is 0 when no lookups', () => {
    expect(cache.getStats().hitRate).toBe(0);
  });
});
