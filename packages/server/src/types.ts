import type { DocsKind } from './docs/types.js';

// ── Chunk kind / symbol types ─────────────────────────────────────────────

export type ChunkKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'module'
  | 'resource'
  | 'data'
  | 'output'
  | 'provider'
  | 'unknown';

// ── Config types (from .paparats.yml) ──────────────────────────────────────

export interface GitMetadataConfig {
  enabled?: boolean;
  maxCommitsPerFile?: number;
  ticketPatterns?: string[];
}

export interface MetadataConfig {
  service?: string;
  bounded_context?: string;
  tags?: string[];
  directory_tags?: Record<string, string[]>;
  git?: GitMetadataConfig;
}

export interface ResolvedMetadataConfig {
  service: string;
  bounded_context: string | null;
  tags: string[];
  directory_tags: Record<string, string[]>;
  git: Required<GitMetadataConfig>;
}

export interface PaparatsConfig {
  group: string;
  language: string | string[];
  indexing?: IndexingConfig;
  watcher?: WatcherConfig;
  embeddings?: EmbeddingsConfig;
  metadata?: MetadataConfig;
  docs?: DocsConfig;
}

/** Per-project docs-layer settings from `.paparats.yml`. */
export interface DocsConfig {
  /**
   * Override how this project's markdown is classified. Omit to auto-detect:
   * a repo with no detected code languages is `prose`, anything else is `code`.
   * Set this when auto-detection is wrong — e.g. a docs site that also ships a
   * small build script, which would otherwise be treated as `code`.
   */
  kind?: DocsKind;
}

export interface IndexingConfig {
  paths?: string[];
  exclude?: string[];
  exclude_extra?: string[];
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
  provider?: 'llama' | 'openai' | 'voyage';
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
  metadata: ResolvedMetadataConfig;
  /**
   * Docs-layer settings. Optional because callers outside this package construct
   * ProjectConfig by hand; absent means "auto-detect everything".
   */
  docs?: ResolvedDocsConfig;
}

/** Docs-layer settings after merging config with defaults. */
export interface ResolvedDocsConfig {
  /** Explicit classification, or null to let the indexer auto-detect. */
  kind: DocsKind | null;
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

// ── Symbol graph types ────────────────────────────────────────────────────

export type RelationType = 'calls' | 'called_by' | 'references' | 'referenced_by';

/**
 * Confidence label for symbol-graph edges, mirroring the EXTRACTED/INFERRED/
 * AMBIGUOUS scheme used by graph-style code intelligence tools.
 *
 * - `EXTRACTED`: the edge is structurally certain (e.g. caller and definition
 *   are in the same file, resolved by AST without name lookup).
 * - `INFERRED`: cross-file edge resolved by name match where exactly one
 *   chunk defines the symbol — likely correct but not proven.
 * - `AMBIGUOUS`: name resolved to multiple defining chunks; the caller could
 *   be hitting any of them. Treat as low-confidence in `find_usages`.
 */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export interface SymbolEdge {
  from_chunk_id: string;
  to_chunk_id: string;
  relation_type: RelationType;
  symbol_name: string;
  /**
   * Optional on the way in for backwards compatibility with rows written
   * before the column existed — readers should default to `'INFERRED'` when
   * absent, matching the legacy classification.
   */
  confidence?: EdgeConfidence;
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
  chunk_id: string | null;
  symbol_name: string | null;
  kind: ChunkKind | null;
  service: string | null;
  bounded_context: string | null;
  tags: string[];
  last_commit_at: string | null;
  defines_symbols: string[];
  uses_symbols: string[];
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

// ── Git metadata types ──────────────────────────────────────────────────

export interface ChunkCommit {
  chunk_id: string;
  commit_hash: string;
  committed_at: string;
  author_email: string;
  message_summary: string;
}

export interface ChunkTicket {
  chunk_id: string;
  ticket_key: string;
  source: 'jira' | 'github' | 'custom';
}
