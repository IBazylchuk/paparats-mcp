import { QdrantClient } from '@qdrant/js-client-rest';
import type { CachedEmbeddingProvider } from './embeddings.js';
import type { SearchResult, SearchMetrics, SearchResponse } from './types.js';

export interface SearcherConfig {
  qdrantUrl: string;
  embeddingProvider: CachedEmbeddingProvider;
  /** Optional Qdrant client for testing */
  qdrantClient?: QdrantClient;
  /** Qdrant request timeout in milliseconds (default: 30000) */
  timeout?: number;
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
}

export class Searcher {
  private qdrant: QdrantClient;
  private provider: CachedEmbeddingProvider;
  private searchCount = 0;
  private totalTokensSaved = 0;

  constructor(config: SearcherConfig) {
    this.qdrant =
      config.qdrantClient ??
      new QdrantClient({
        url: config.qdrantUrl,
        timeout: config.timeout ?? QDRANT_TIMEOUT_MS,
      });
    this.provider = config.embeddingProvider;
  }

  /** Search within a group collection, optionally filtering by project */
  async search(
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

    const queryVector = await this.provider.embed(query);

    const filter =
      project !== 'all'
        ? { must: [{ key: 'project' as const, match: { value: project } }] }
        : undefined;

    let results: SearchResult[];
    try {
      const hits = await this.retryQdrant(() =>
        this.qdrant.search(groupName, {
          vector: queryVector,
          limit,
          with_payload: true,
          filter,
        })
      );

      results = hits
        .filter((h): h is typeof h & { payload: QdrantPayload } => this.validatePayload(h.payload))
        .map((h) => {
          const p = h.payload;
          return {
            project: p.project,
            file: p.file,
            language: p.language,
            startLine: p.startLine,
            endLine: p.endLine,
            content: p.content,
            score: h.score,
            hash: p.hash,
          };
        });
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
    this.searchCount++;
    this.totalTokensSaved += metrics.tokensSaved;

    return {
      results,
      total: results.length,
      metrics,
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
        return `**[${r.project}] ${r.file}:${r.startLine}** (${score}%)\n\`\`\`${r.language}\n${r.content}\n\`\`\``;
      })
      .join('\n\n---\n\n');
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
