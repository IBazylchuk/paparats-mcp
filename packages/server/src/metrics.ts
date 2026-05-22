import type { RequestHandler } from 'express';

// ── Public interface ────────────────────────────────────────────────────────

export interface MetricsRegistry {
  readonly enabled: boolean;

  incSearchTotal(group: string, method: string): void;
  observeSearchDuration(group: string, method: string, durationSec: number): void;
  incIndexFilesTotal(group: string, count?: number): void;
  incIndexChunksTotal(group: string, count?: number): void;
  incIndexErrorsTotal(group: string, count?: number): void;
  observeEmbeddingDuration(durationSec: number): void;
  incWatcherEventsTotal(group: string, eventType: string): void;

  setEmbeddingCacheSize(value: number): void;
  setEmbeddingCacheHitRate(value: number): void;
  setQueryCacheSize(value: number): void;
  setQueryCacheHitRate(value: number): void;
  setQdrantCollections(value: number): void;

  // ── Architectural memory ─────────────────────────────────────────────────
  /** A write call landed on the arch store. Counts by card kind and gate outcome. */
  incArchWriteTotal(kind: string, status: string): void;
  /** `arch_context` was called for a group. */
  incArchContextCallsTotal(group: string): void;
  /** Cosine score of a hit returned by `arch_context` (post-min_score filter). */
  observeArchSearchScore(score: number): void;
  /** Snapshot of how many points the arch collection holds, by kind and status. */
  setArchCollectionSize(group: string, kind: string, status: string, value: number): void;

  getMetricsHandler(): RequestHandler;
}

// ── No-op implementation ────────────────────────────────────────────────────

class NoOpMetrics implements MetricsRegistry {
  readonly enabled = false;

  incSearchTotal(_group: string, _method: string): void {}
  observeSearchDuration(_group: string, _method: string, _durationSec: number): void {}
  incIndexFilesTotal(_group: string, _count?: number): void {}
  incIndexChunksTotal(_group: string, _count?: number): void {}
  incIndexErrorsTotal(_group: string, _count?: number): void {}
  observeEmbeddingDuration(_durationSec: number): void {}
  incWatcherEventsTotal(_group: string, _eventType: string): void {}
  setEmbeddingCacheSize(_value: number): void {}
  setEmbeddingCacheHitRate(_value: number): void {}
  setQueryCacheSize(_value: number): void {}
  setQueryCacheHitRate(_value: number): void {}
  setQdrantCollections(_value: number): void {}
  incArchWriteTotal(_kind: string, _status: string): void {}
  incArchContextCallsTotal(_group: string): void {}
  observeArchSearchScore(_score: number): void {}
  setArchCollectionSize(_group: string, _kind: string, _status: string, _value: number): void {}

  getMetricsHandler(): RequestHandler {
    return (_req, res) => {
      res.status(404).json({ error: 'Metrics not enabled. Set PAPARATS_METRICS=true' });
    };
  }
}

// ── Prometheus implementation ───────────────────────────────────────────────

async function createPrometheusMetrics(): Promise<MetricsRegistry> {
  const prom = await import('prom-client');

  const registry = new prom.Registry();
  prom.collectDefaultMetrics({ register: registry, prefix: 'paparats_' });

  const searchTotal = new prom.Counter({
    name: 'paparats_search_total',
    help: 'Total number of search requests',
    labelNames: ['group', 'method'] as const,
    registers: [registry],
  });

  const searchDuration = new prom.Histogram({
    name: 'paparats_search_duration_seconds',
    help: 'Search request duration in seconds',
    labelNames: ['group', 'method'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const indexFilesTotal = new prom.Counter({
    name: 'paparats_index_files_total',
    help: 'Total number of files indexed',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const indexChunksTotal = new prom.Counter({
    name: 'paparats_index_chunks_total',
    help: 'Total number of chunks indexed',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const indexErrorsTotal = new prom.Counter({
    name: 'paparats_index_errors_total',
    help: 'Total number of indexing errors',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const embeddingDuration = new prom.Histogram({
    name: 'paparats_embedding_duration_seconds',
    help: 'Embedding generation duration in seconds',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const watcherEventsTotal = new prom.Counter({
    name: 'paparats_watcher_events_total',
    help: 'Total number of watcher events',
    labelNames: ['group', 'event_type'] as const,
    registers: [registry],
  });

  const embeddingCacheSize = new prom.Gauge({
    name: 'paparats_embedding_cache_size',
    help: 'Number of entries in embedding cache',
    registers: [registry],
  });

  const embeddingCacheHitRate = new prom.Gauge({
    name: 'paparats_embedding_cache_hit_rate',
    help: 'Embedding cache hit rate (0-1)',
    registers: [registry],
  });

  const queryCacheSize = new prom.Gauge({
    name: 'paparats_query_cache_size',
    help: 'Number of entries in query cache',
    registers: [registry],
  });

  const queryCacheHitRate = new prom.Gauge({
    name: 'paparats_query_cache_hit_rate',
    help: 'Query cache hit rate (0-1)',
    registers: [registry],
  });

  const qdrantCollections = new prom.Gauge({
    name: 'paparats_qdrant_collections',
    help: 'Number of Qdrant collections (groups)',
    registers: [registry],
  });

  const archWriteTotal = new prom.Counter({
    name: 'paparats_arch_write_total',
    help: 'Architectural-memory write calls by card kind and similarity-gate outcome',
    labelNames: ['kind', 'status'] as const,
    registers: [registry],
  });

  const archContextCallsTotal = new prom.Counter({
    name: 'paparats_arch_context_calls_total',
    help: 'Number of arch_context calls per group',
    labelNames: ['group'] as const,
    registers: [registry],
  });

  const archSearchScore = new prom.Histogram({
    name: 'paparats_arch_search_score',
    help: 'Cosine similarity of hits returned by arch_context (post min_score filter)',
    buckets: [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0],
    registers: [registry],
  });

  const archCollectionSize = new prom.Gauge({
    name: 'paparats_arch_collection_size',
    help: 'Architectural-memory card count by group, kind, and status',
    labelNames: ['group', 'kind', 'status'] as const,
    registers: [registry],
  });

  return {
    enabled: true,

    incSearchTotal(group: string, method: string) {
      searchTotal.inc({ group, method });
    },
    observeSearchDuration(group: string, method: string, durationSec: number) {
      searchDuration.observe({ group, method }, durationSec);
    },
    incIndexFilesTotal(group: string, count = 1) {
      indexFilesTotal.inc({ group }, count);
    },
    incIndexChunksTotal(group: string, count = 1) {
      indexChunksTotal.inc({ group }, count);
    },
    incIndexErrorsTotal(group: string, count = 1) {
      indexErrorsTotal.inc({ group }, count);
    },
    observeEmbeddingDuration(durationSec: number) {
      embeddingDuration.observe(durationSec);
    },
    incWatcherEventsTotal(group: string, eventType: string) {
      watcherEventsTotal.inc({ group, event_type: eventType });
    },
    setEmbeddingCacheSize(value: number) {
      embeddingCacheSize.set(value);
    },
    setEmbeddingCacheHitRate(value: number) {
      embeddingCacheHitRate.set(value);
    },
    setQueryCacheSize(value: number) {
      queryCacheSize.set(value);
    },
    setQueryCacheHitRate(value: number) {
      queryCacheHitRate.set(value);
    },
    setQdrantCollections(value: number) {
      qdrantCollections.set(value);
    },
    incArchWriteTotal(kind: string, status: string) {
      archWriteTotal.inc({ kind, status });
    },
    incArchContextCallsTotal(group: string) {
      archContextCallsTotal.inc({ group });
    },
    observeArchSearchScore(score: number) {
      archSearchScore.observe(score);
    },
    setArchCollectionSize(group: string, kind: string, status: string, value: number) {
      archCollectionSize.set({ group, kind, status }, value);
    },

    getMetricsHandler(): RequestHandler {
      return async (_req, res) => {
        try {
          const metrics = await registry.metrics();
          res.set('Content-Type', registry.contentType);
          res.end(metrics);
        } catch (err) {
          res.status(500).json({ error: (err as Error).message });
        }
      };
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

export async function createMetrics(): Promise<MetricsRegistry> {
  const enabled = process.env.PAPARATS_METRICS === 'true';
  if (!enabled) {
    return new NoOpMetrics();
  }

  try {
    return await createPrometheusMetrics();
  } catch (err) {
    console.warn(
      `[metrics] Failed to initialize Prometheus metrics (non-fatal): ${(err as Error).message}`
    );
    return new NoOpMetrics();
  }
}

// Export NoOpMetrics for testing
export { NoOpMetrics };
