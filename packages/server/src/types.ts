// ── Config types (from .paparats.yml) ──────────────────────────────────────

export interface PaparatsConfig {
  group: string;
  language: string | string[];
  indexing?: IndexingConfig;
  watcher?: WatcherConfig;
  embeddings?: EmbeddingsConfig;
}

export interface IndexingConfig {
  paths?: string[];
  exclude?: string[];
  respectGitignore?: boolean;
  extensions?: string[];
  chunkSize?: number;
  overlap?: number;
  concurrency?: number;
  batchSize?: number;
}

export interface WatcherConfig {
  enabled?: boolean;
  debounce?: number;
  /** awaitWriteFinish: ms to wait for file write to stabilize (default: 1000) */
  stabilityThreshold?: number;
}

export interface EmbeddingsConfig {
  provider?: 'ollama' | 'openai';
  model?: string;
  dimensions?: number;
}

// ── Resolved project (after merging config + language profile) ──────────────

export interface ProjectConfig {
  name: string;
  path: string;
  group: string;
  languages: string[];
  patterns: string[];
  exclude: string[];
  indexing: ResolvedIndexingConfig;
  watcher: Required<WatcherConfig>;
  embeddings: Required<EmbeddingsConfig>;
}

export interface ResolvedIndexingConfig {
  paths: string[];
  exclude: string[];
  respectGitignore: boolean;
  extensions: string[];
  chunkSize: number;
  overlap: number;
  concurrency: number;
  batchSize: number;
}

// ── Group = Qdrant collection ──────────────────────────────────────────────

export interface GroupInfo {
  name: string;
  projects: string[];
  chunksTotal: number;
}

// ── Chunker output ─────────────────────────────────────────────────────────

export interface ChunkResult {
  content: string;
  startLine: number;
  endLine: number;
  hash: string;
}

// ── Search types ───────────────────────────────────────────────────────────

export interface SearchResult {
  project: string;
  file: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  hash: string;
}

export interface SearchMetrics {
  tokensReturned: number;
  estimatedFullFileTokens: number;
  tokensSaved: number;
  savingsPercent: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  metrics: SearchMetrics;
}

// ── Embedding provider ─────────────────────────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  /** Optional: batch embedding for better performance. Falls back to sequential embed() if not supported. */
  embedBatch?(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly model: string;
}

// ── Language profile (built-in) ────────────────────────────────────────────

export interface LanguageProfile {
  patterns: string[];
  exclude: string[];
  extensions: string[];
}

// ── Indexer stats ──────────────────────────────────────────────────────────

export interface IndexerStats {
  files: number;
  chunks: number;
  cached: number;
  errors: number;
  skipped: number;
}
