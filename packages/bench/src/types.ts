// ── Dataset ────────────────────────────────────────────────────────────────
//
// Line numbers in datasets and reports are 1-indexed and inclusive (what an
// editor shows). The Qdrant payload stores 0-indexed lines; the runner converts
// on the way out so labels and hits are always compared in the same base.

/** One place a query is expected to find. `file` is relative to the project root. */
export interface ExpectedLocation {
  file: string;
  /** First line of the relevant span (1-indexed). Omit to accept any chunk of the file. */
  startLine?: number;
  /** Last line of the relevant span (1-indexed, inclusive). Required with `startLine`. */
  endLine?: number;
  /** Symbol defined in the span — documentation for labellers, checked by `validate`. */
  symbol?: string;
}

export interface BenchQuery {
  /** Stable identifier; reports are compared by it. */
  id: string;
  /** Query category, used to break results down (e.g. `nl`, `identifier`, `error`). */
  type: string;
  query: string;
  /** Project name the query is scoped to (the `project` filter of search_code). */
  project: string;
  expected: ExpectedLocation[];
  /** Free-form labelling notes. */
  notes?: string;
}

export interface DatasetProject {
  /** Project name written into the index and used by queries. */
  name: string;
  /** Directory inside the repository at `commit` to index (default: `.`). */
  path?: string;
}

export interface Dataset {
  name: string;
  description?: string;
  /** Full commit SHA every label was taken from. */
  commit: string;
  projects: DatasetProject[];
  queries: BenchQuery[];
}

// ── Results ────────────────────────────────────────────────────────────────

/** A search result reduced to what the metrics need (lines 1-indexed, inclusive). */
export interface Hit {
  file: string;
  startLine: number;
  endLine: number;
  score?: number;
}

export interface MetricSet {
  'recall@1': number;
  'recall@5': number;
  'recall@10': number;
  'mrr@10': number;
  'ndcg@10': number;
}

export interface QueryResult {
  id: string;
  type: string;
  query: string;
  project: string;
  /** Wall-clock time of the search call (embedding + Qdrant), in milliseconds. */
  latencyMs: number;
  hits: Hit[];
  /** A hit counts when its file is an expected file. */
  file: MetricSet;
  /** A hit counts when it overlaps an expected line span. */
  chunk: MetricSet;
  /** Set when the search call failed; the metrics are then all zero. */
  error?: string;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  mean: number;
}

export interface Aggregate {
  count: number;
  file: MetricSet;
  chunk: MetricSet;
  latency: LatencyStats;
  /** Queries whose search call failed (included in `count`, scored zero). */
  errors: number;
}

export interface ReportConfig {
  /** `search_code` replicates the MCP tool; `search` is the plain HTTP /api/search path. */
  mode: 'search_code' | 'search';
  group: string;
  limit: number;
  embedModel: string;
  /** Free-form label for the run (e.g. `baseline`, `hybrid-bm25`). */
  label?: string;
  /** Chunks in the collection when the queries ran. */
  points?: number;
}

export interface Report {
  schemaVersion: 1;
  createdAt: string;
  dataset: {
    name: string;
    commit: string;
    queryCount: number;
  };
  config: ReportConfig;
  overall: Aggregate;
  byType: Record<string, Aggregate>;
  queries: QueryResult[];
}
