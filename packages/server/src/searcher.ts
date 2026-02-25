import { QdrantClient } from '@qdrant/js-client-rest';
import type { CachedEmbeddingProvider } from './embeddings.js';
import type { SearchResult, SearchMetrics, SearchResponse, ChunkKind } from './types.js';
import { expandQuery } from './query-expansion.js';
import type { QueryCache } from './query-cache.js';
import type { MetricsRegistry } from './metrics.js';
import { toCollectionName } from './indexer.js';

export interface SearcherConfig {
  qdrantUrl: string;
  /** Qdrant API key for authenticated access (e.g. Qdrant Cloud) */
  qdrantApiKey?: string;
  embeddingProvider: CachedEmbeddingProvider;
  /** Optional Qdrant client for testing */
  qdrantClient?: QdrantClient;
  /** Qdrant request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional query result cache */
  cache?: QueryCache;
  /** Optional metrics registry */
  metrics?: MetricsRegistry;
  /** Optional list of allowed project names (from PAPARATS_PROJECTS env var) */
  allowedProjects?: string[];
}

const QDRANT_TIMEOUT_MS = 30_000;

/** Expected payload shape from Qdrant chunks */
interface QdrantPayload {
  project: string;
  file: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  hash: string;
  chunk_id?: string;
  symbol_name?: string | null;
  kind?: string | null;
  service?: string | null;
  bounded_context?: string | null;
  tags?: string[];
  last_commit_hash?: string;
  last_commit_at?: string;
  last_author_email?: string;
  ticket_keys?: string[];
  defines_symbols?: string[];
  uses_symbols?: string[];
}

export class Searcher {
  private qdrant: QdrantClient;
  private provider: CachedEmbeddingProvider;
  private searchCount = 0;
  private totalTokensSaved = 0;
  private cache?: QueryCache;
  private metrics?: MetricsRegistry;
  private readonly allowedProjects: string[] | null;

  constructor(config: SearcherConfig) {
    this.qdrant =
      config.qdrantClient ??
      new QdrantClient({
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        timeout: config.timeout ?? QDRANT_TIMEOUT_MS,
      });
    this.provider = config.embeddingProvider;
    this.cache = config.cache;
    this.metrics = config.metrics;
    this.allowedProjects =
      config.allowedProjects && config.allowedProjects.length > 0 ? config.allowedProjects : null;
  }

  /** Search within a group collection, optionally filtering by project */
  async search(
    groupName: string,
    query: string,
    options?: { project?: string; limit?: number }
  ): Promise<SearchResponse> {
    const startTime = performance.now();

    // Check cache
    if (this.cache) {
      const cacheKey = this.cache.buildKey(groupName, query, options);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.searchCount++;
        this.totalTokensSaved += cached.metrics.tokensSaved;
        this.metrics?.incSearchTotal(groupName, 'search');
        this.metrics?.observeSearchDuration(
          groupName,
          'search',
          (performance.now() - startTime) / 1000
        );
        return cached;
      }
    }

    const response = await this._searchInternal(groupName, query, options);

    this.searchCount++;
    this.totalTokensSaved += response.metrics.tokensSaved;

    // Store in cache
    if (this.cache) {
      const cacheKey = this.cache.buildKey(groupName, query, options);
      this.cache.set(cacheKey, groupName, response);
    }

    this.metrics?.incSearchTotal(groupName, 'search');
    this.metrics?.observeSearchDuration(
      groupName,
      'search',
      (performance.now() - startTime) / 1000
    );

    return response;
  }

  /** Search with automatic query expansion for broader semantic coverage */
  async expandedSearch(
    groupName: string,
    query: string,
    options?: { project?: string; limit?: number }
  ): Promise<SearchResponse> {
    const startTime = performance.now();

    // Check cache
    if (this.cache) {
      const cacheKey = this.cache.buildKey(groupName, `expanded:${query}`, options);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.searchCount++;
        this.totalTokensSaved += cached.metrics.tokensSaved;
        this.metrics?.incSearchTotal(groupName, 'expandedSearch');
        this.metrics?.observeSearchDuration(
          groupName,
          'expandedSearch',
          (performance.now() - startTime) / 1000
        );
        return cached;
      }
    }

    const variations = expandQuery(query);

    if (variations.length <= 1) {
      return this.search(groupName, query, options);
    }

    const limit = options?.limit ?? 5;
    const internalLimit = Math.max(1, Math.min(limit * 2, 100));

    const responses = await Promise.all(
      variations.map((q) =>
        this._searchInternal(groupName, q, { ...options, limit: internalLimit })
      )
    );

    // Merge: keep highest score per unique hash, track which variation contributed each result
    const byHash = new Map<string, SearchResult>();
    const contributedBy = new Map<string, number>(); // hash -> variation index that first added it
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i]!;
      for (const result of response.results) {
        const existing = byHash.get(result.hash);
        if (!existing) {
          byHash.set(result.hash, result);
          contributedBy.set(result.hash, i);
        } else if (result.score > existing.score) {
          byHash.set(result.hash, result);
        }
      }
    }

    const merged = Array.from(byHash.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Log which variations contributed to final results
    const variationHits = new Map<number, number>();
    for (const result of merged) {
      const idx = contributedBy.get(result.hash) ?? 0;
      variationHits.set(idx, (variationHits.get(idx) ?? 0) + 1);
    }

    if (merged.length > 0) {
      const breakdown = variations
        .map((q, i) => {
          const count = variationHits.get(i) ?? 0;
          return count > 0 ? `"${q}" (${count})` : null;
        })
        .filter(Boolean)
        .join(', ');
      console.log(
        `[searcher] Query expansion: "${query}" → ${variations.length} variations, ${merged.length} results [${breakdown}]`
      );
    }

    const metrics = this.computeMetrics(merged);
    this.searchCount++;
    this.totalTokensSaved += metrics.tokensSaved;

    const response: SearchResponse = {
      results: merged,
      total: merged.length,
      metrics,
    };

    // Store in cache
    if (this.cache) {
      const cacheKey = this.cache.buildKey(groupName, `expanded:${query}`, options);
      this.cache.set(cacheKey, groupName, response);
    }

    this.metrics?.incSearchTotal(groupName, 'expandedSearch');
    this.metrics?.observeSearchDuration(
      groupName,
      'expandedSearch',
      (performance.now() - startTime) / 1000
    );

    return response;
  }

  /** Search with additional Qdrant filter conditions (e.g. date range on last_commit_at) */
  async searchWithFilter(
    groupName: string,
    query: string,
    additionalFilter: { must: Array<Record<string, unknown>> },
    options?: { project?: string; limit?: number }
  ): Promise<SearchResponse> {
    if (!groupName?.trim()) {
      throw new Error('Group name is required');
    }
    if (!query?.trim()) {
      throw new Error('Query string is required');
    }

    const startTime = performance.now();

    // Check cache
    if (this.cache) {
      const cacheKey = this.cache.buildKey(groupName, query, options, additionalFilter);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.searchCount++;
        this.totalTokensSaved += cached.metrics.tokensSaved;
        this.metrics?.incSearchTotal(groupName, 'searchWithFilter');
        this.metrics?.observeSearchDuration(
          groupName,
          'searchWithFilter',
          (performance.now() - startTime) / 1000
        );
        return cached;
      }
    }

    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const project = options?.project ?? 'all';

    const { projects: effectiveProjects, forbidden } = this.resolveEffectiveProjects(project);
    if (forbidden) {
      const metrics = this.computeMetrics([]);
      this.searchCount++;
      const response: SearchResponse = { results: [], total: 0, metrics };
      if (this.cache) {
        const cacheKey = this.cache.buildKey(groupName, query, options, additionalFilter);
        this.cache.set(cacheKey, groupName, response);
      }
      this.metrics?.incSearchTotal(groupName, 'searchWithFilter');
      this.metrics?.observeSearchDuration(
        groupName,
        'searchWithFilter',
        (performance.now() - startTime) / 1000
      );
      return response;
    }

    const queryVector = await this.provider.embedQuery(query);

    const must: Array<Record<string, unknown>> = [...additionalFilter.must];
    if (effectiveProjects) {
      must.push(this.buildProjectCondition(effectiveProjects));
    }

    let results: SearchResult[];
    try {
      const hits = await this.retryQdrant(() =>
        this.qdrant.search(toCollectionName(groupName), {
          vector: queryVector,
          limit,
          with_payload: true,
          filter: { must },
        })
      );

      results = hits
        .filter((h): h is typeof h & { payload: QdrantPayload } => this.validatePayload(h.payload))
        .map((h) => this.mapPayload(h.payload, h.score));
    } catch (err) {
      const errorMsg = (err as Error).message.toLowerCase();
      if (errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
        results = [];
      } else {
        throw new Error(`Search failed in group "${groupName}": ${(err as Error).message}`, {
          cause: err,
        });
      }
    }

    const metrics = this.computeMetrics(results);
    this.searchCount++;
    this.totalTokensSaved += metrics.tokensSaved;

    const response: SearchResponse = { results, total: results.length, metrics };

    // Store in cache
    if (this.cache) {
      const cacheKey = this.cache.buildKey(groupName, query, options, additionalFilter);
      this.cache.set(cacheKey, groupName, response);
    }

    this.metrics?.incSearchTotal(groupName, 'searchWithFilter');
    this.metrics?.observeSearchDuration(
      groupName,
      'searchWithFilter',
      (performance.now() - startTime) / 1000
    );

    return response;
  }

  /** Core search logic without counter updates */
  private async _searchInternal(
    groupName: string,
    query: string,
    options?: { project?: string; limit?: number }
  ): Promise<SearchResponse> {
    // Input validation
    if (!groupName?.trim()) {
      throw new Error('Group name is required');
    }
    if (!query?.trim()) {
      throw new Error('Query string is required');
    }
    const limit = Math.max(1, Math.min(options?.limit ?? 5, 100));
    const project = options?.project ?? 'all';

    const { projects: effectiveProjects, forbidden } = this.resolveEffectiveProjects(project);
    if (forbidden) {
      return { results: [], total: 0, metrics: this.computeMetrics([]) };
    }

    const queryVector = await this.provider.embedQuery(query);

    const filter = effectiveProjects
      ? { must: [this.buildProjectCondition(effectiveProjects)] }
      : undefined;

    let results: SearchResult[];
    try {
      const hits = await this.retryQdrant(() =>
        this.qdrant.search(toCollectionName(groupName), {
          vector: queryVector,
          limit,
          with_payload: true,
          filter,
        })
      );

      results = hits
        .filter((h): h is typeof h & { payload: QdrantPayload } => this.validatePayload(h.payload))
        .map((h) => this.mapPayload(h.payload, h.score));
    } catch (err) {
      const errorMsg = (err as Error).message.toLowerCase();
      if (errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
        // Collection doesn't exist yet - expected
        results = [];
      } else {
        console.error(`[searcher] Search failed in group "${groupName}":`, err);
        throw new Error(`Search failed in group "${groupName}": ${(err as Error).message}`, {
          cause: err,
        });
      }
    }

    const metrics = this.computeMetrics(results);

    return {
      results,
      total: results.length,
      metrics,
    };
  }

  /**
   * Resolve effective project list from allowedProjects + explicit project param.
   * Returns `forbidden: true` if the explicit project is not in the allowed set.
   */
  private resolveEffectiveProjects(explicitProject: string): {
    projects: string[] | null;
    forbidden: boolean;
  } {
    if (this.allowedProjects) {
      if (explicitProject === 'all') {
        return { projects: this.allowedProjects, forbidden: false };
      }
      if (this.allowedProjects.includes(explicitProject)) {
        return { projects: [explicitProject], forbidden: false };
      }
      return { projects: null, forbidden: true };
    }
    // No allowedProjects restriction
    if (explicitProject === 'all') {
      return { projects: null, forbidden: false };
    }
    return { projects: [explicitProject], forbidden: false };
  }

  /** Build a single Qdrant condition from a project list */
  private buildProjectCondition(projects: string[]): Record<string, unknown> {
    if (projects.length === 1) {
      return { key: 'project', match: { value: projects[0] } };
    }
    return { key: 'project', match: { any: projects } };
  }

  /** Get the configured project scope, or null if unrestricted */
  getProjectScope(): string[] | null {
    return this.allowedProjects;
  }

  private mapPayload(p: QdrantPayload, score: number): SearchResult {
    return {
      project: p.project,
      file: p.file,
      language: p.language,
      startLine: p.startLine,
      endLine: p.endLine,
      content: p.content,
      score,
      hash: p.hash,
      chunk_id: p.chunk_id ?? null,
      symbol_name: (p.symbol_name as string | null) ?? null,
      kind: (p.kind as ChunkKind | null) ?? null,
      service: (p.service as string | null) ?? null,
      bounded_context: (p.bounded_context as string | null) ?? null,
      tags: p.tags ?? [],
      last_commit_at: (p.last_commit_at as string | null) ?? null,
      defines_symbols: p.defines_symbols ?? [],
      uses_symbols: p.uses_symbols ?? [],
    };
  }

  private async retryQdrant<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message.toLowerCase();
        if (msg.includes('not found') || msg.includes('does not exist')) {
          throw lastError;
        }
        if (attempt < retries - 1) {
          const delay = delayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          console.warn(`[searcher] Qdrant search failed, retrying (${attempt + 1}/${retries})...`);
        }
      }
    }
    throw lastError;
  }

  private validatePayload(p: unknown): p is QdrantPayload {
    if (typeof p !== 'object' || p === null) return false;
    const obj = p as Record<string, unknown>;
    return (
      typeof obj.project === 'string' &&
      typeof obj.file === 'string' &&
      typeof obj.language === 'string' &&
      typeof obj.startLine === 'number' &&
      typeof obj.endLine === 'number' &&
      typeof obj.content === 'string' &&
      typeof obj.hash === 'string'
    );
  }

  /** Format search results as markdown for MCP tool responses */
  formatResults(response: SearchResponse): string {
    if (response.results.length === 0) {
      return 'No results found. Make sure the project is indexed.';
    }

    return response.results
      .map((r) => {
        const score = (r.score * 100).toFixed(1);
        const symbolInfo = r.symbol_name ? ` — ${r.kind ?? 'unknown'}: ${r.symbol_name}` : '';
        const chunkRef = r.chunk_id ? `\n_chunk: ${r.chunk_id}_` : '';
        return `**[${r.project}] ${r.file}:${r.startLine}** (${score}%${symbolInfo})${chunkRef}\n\`\`\`${r.language}\n${r.content}\n\`\`\``;
      })
      .join('\n\n---\n\n');
  }

  /** Invalidate all cached search results for a group (e.g. after file change) */
  invalidateGroupCache(groupName: string): void {
    this.cache?.invalidateGroup(groupName);
  }

  /** Get query cache stats, or null if cache is not configured */
  getQueryCacheStats() {
    return this.cache?.getStats() ?? null;
  }

  /** Usage stats */
  getUsageStats(): {
    searchCount: number;
    totalTokensSaved: number;
    avgTokensSavedPerSearch: number;
  } {
    return {
      searchCount: this.searchCount,
      totalTokensSaved: Math.round(this.totalTokensSaved),
      avgTokensSavedPerSearch: Math.round(this.totalTokensSaved / (this.searchCount || 1)),
    };
  }

  private computeMetrics(results: SearchResult[]): SearchMetrics {
    if (results.length === 0) {
      return {
        tokensReturned: 0,
        estimatedFullFileTokens: 0,
        tokensSaved: 0,
        savingsPercent: 0,
      };
    }

    const tokensReturned = results.reduce(
      (sum, r) => sum + Math.ceil((r.content?.length ?? 0) / 4),
      0
    );

    // Estimate full file tokens from line ranges (~50 chars per line, 4 chars per token)
    const fileLineEstimates = new Map<string, number>();
    for (const r of results) {
      const currentMax = fileLineEstimates.get(r.file) ?? 0;
      fileLineEstimates.set(r.file, Math.max(currentMax, r.endLine));
    }
    const estimatedFullFileTokens = Array.from(fileLineEstimates.values()).reduce(
      (sum, lines) => sum + Math.ceil((lines * 50) / 4),
      0
    );

    const tokensSaved = Math.max(0, estimatedFullFileTokens - tokensReturned);
    const savingsPercent =
      estimatedFullFileTokens > 0 ? Math.round((tokensSaved / estimatedFullFileTokens) * 100) : 0;

    return {
      tokensReturned,
      estimatedFullFileTokens,
      tokensSaved,
      savingsPercent,
    };
  }
}
