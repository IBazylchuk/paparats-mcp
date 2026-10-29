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
  /**
   * Default visibility label for this project's documents (e.g. `client`). A
   * document's own frontmatter `audience:` overrides it. Omit to store every
   * document as `internal`. Must match `^[a-z0-9][a-z0-9_-]{0,63}$`.
   */
  audience?: string;
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
  /** Default audience label for the project's documents, or null for `internal`. */
  audience: string | null;
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

/**
 * `calls`: a call. `references`: a class held as a value (passed, stored in a
 * hash, `Foo.new` kept in a variable), so any of its methods may be called.
 * `reexports`: a TS/JS `export { x } from` in a barrel file. `overrides`: a call
 * on self reaching the override a class below defines (a template method
 * calling the step its subclasses implement): the base depends on the
 * subclass's code, while the subclass's file is the one naming the base.
 */
export type RelationType = 'calls' | 'references' | 'reexports' | 'overrides';

/**
 * Confidence label for symbol-graph edges, mirroring the EXTRACTED/INFERRED/
 * AMBIGUOUS scheme used by graph-style code intelligence tools.
 *
 * - `EXTRACTED`: the edge is structurally certain: caller and definition are
 *   in the same file, or the call names the class that defines the method
 *   (`Grove.water`, or `self.water` / a bare Ruby call inside that class).
 * - `INFERRED`: cross-file edge resolved by name match where exactly one
 *   chunk defines the symbol — likely correct but not proven.
 * - `AMBIGUOUS`: name resolved to multiple defining chunks; the caller could
 *   be hitting any of them. Treat as low-confidence in `find_usages`.
 */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

/** How widely each linked name is used in a group; see `MetadataStore.getNameUsage`. */
export interface NameUsage {
  /** Files that use any name an edge links through. */
  callerFiles: number;
  /** Per name, the number of files using it. */
  filesUsing: Map<string, number>;
}

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
  /**
   * The functions or methods in the caller chunk that make the call. Empty, or
   * absent on rows written before the column existed, when the call is in a
   * class body or at the top of a file — then the whole chunk is the caller.
   */
  from_symbols?: string[];
  /**
   * Further methods of the caller chunk that reach the call through the
   * chunk's own calls (`call` → private `ledger_entry` → the call). `change_impact`
   * follows their callers too; they are not named as making the call.
   */
  reach_symbols?: string[];
  /**
   * Per name of `reach_symbols`, the calls inside the chunk from it to the
   * nearest calling method (1 = calls one directly). Absent on edges built
   * from symbols stored before `inner_calls` were recorded.
   */
  reach_steps?: number[];
}

/**
 * Files whose chunks were written or removed since a project's symbol graph was
 * last brought up to date (`MetadataStore.graphChanges()`).
 */
export interface GraphChanges {
  /** The last change read; later ones are left for the next update. */
  upTo: number;
  files: Set<string>;
  /** Names the files' old or new chunks define. */
  names: Set<string>;
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
  /** Commit-count percentile of the file within its project (see file-churn.ts). */
  file_churn: number | null;
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
  /**
   * Optional: embed a search query, for providers whose API tells queries from
   * documents natively (Voyage `input_type`). Others are prefixed with the model's
   * query instruction by the caching layer instead.
   */
  embedQuery?(text: string): Promise<number[]>;
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

/** Outcome of one {@link Indexer.indexProjectWithReport} run. */
export interface IndexProjectReport {
  /** Chunks written this run (unchanged files contribute 0). */
  chunks: number;
  /**
   * Files that failed this run, plus 1 when the project path was missing. Non-zero
   * means the index does not reflect the source, so change detection must not
   * record this state as indexed.
   */
  errors: number;
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
