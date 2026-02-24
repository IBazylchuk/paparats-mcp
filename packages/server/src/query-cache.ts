import { createHash } from 'crypto';
import type { SearchResponse } from './types.js';

export interface QueryCacheConfig {
  /** Maximum number of cached entries (default: 1000, env QUERY_CACHE_MAX_ENTRIES) */
  maxEntries?: number;
  /** TTL in milliseconds (default: 300_000 = 5min, env QUERY_CACHE_TTL_MS) */
  ttlMs?: number;
}

interface CacheEntry {
  response: SearchResponse;
  groupName: string;
  createdAt: number;
}

export interface QueryCacheStats {
  size: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  evictions: number;
}

export class QueryCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private hitCount = 0;
  private missCount = 0;
  private evictions = 0;

  constructor(config?: QueryCacheConfig) {
    this.maxEntries =
      config?.maxEntries ?? parseInt(process.env.QUERY_CACHE_MAX_ENTRIES ?? '1000', 10);
    this.ttlMs = config?.ttlMs ?? parseInt(process.env.QUERY_CACHE_TTL_MS ?? '300000', 10);
  }

  /** Build a deterministic cache key from search parameters */
  buildKey(
    group: string,
    query: string,
    options?: { project?: string; limit?: number },
    additionalFilter?: { must: Array<Record<string, unknown>> }
  ): string {
    const keyObj = {
      group,
      query,
      project: options?.project ?? 'all',
      limit: options?.limit ?? 5,
      filter: additionalFilter ?? null,
    };
    return createHash('sha256').update(JSON.stringify(keyObj)).digest('hex');
  }

  /** Get cached response, or null if not found / expired */
  get(key: string): SearchResponse | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.missCount++;
      return null;
    }

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }

    // Move to end for LRU (Map preserves insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hitCount++;
    return entry.response;
  }

  /** Store a search response in the cache */
  set(key: string, groupName: string, response: SearchResponse): void {
    // Delete existing entry first to update position
    this.cache.delete(key);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
        this.evictions++;
      }
    }

    this.cache.set(key, {
      response,
      groupName,
      createdAt: Date.now(),
    });
  }

  /** Invalidate all cached entries for a given group */
  invalidateGroup(groupName: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.groupName === groupName) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all entries */
  clear(): void {
    this.cache.clear();
  }

  /** Get cache statistics */
  getStats(): QueryCacheStats {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: total > 0 ? this.hitCount / total : 0,
      evictions: this.evictions,
    };
  }
}
