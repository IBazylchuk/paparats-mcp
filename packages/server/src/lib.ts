// ── Re-exports for programmatic use ────────────────────────────────────────
// This module is the public library entry point for @paparats/server.
// index.ts imports from here and re-exports so existing consumers still work.

export { Chunker } from './chunker.js';
export type { ChunkerConfig } from './chunker.js';

export { chunkByAst } from './ast-chunker.js';
export type { AstChunkerConfig } from './ast-chunker.js';

export {
  readConfig,
  resolveProject,
  loadProject,
  getLanguageProfile,
  getSupportedLanguages,
  detectLanguages,
  autoProjectConfig,
  CONFIG_FILE,
} from './config.js';

export {
  EmbeddingCache,
  LlamaServerProvider,
  OpenAIProvider,
  VoyageProvider,
  CachedEmbeddingProvider,
  createEmbeddingProvider,
  resolveEmbeddingConfigFromEnv,
} from './embeddings.js';
export type { CacheStats, ResolvedEmbeddingConfig } from './embeddings.js';

export {
  Indexer,
  buildChunkId,
  parseChunkId,
  applyProjectSuffix,
  stripProjectSuffix,
  toCollectionName,
  fromCollectionName,
  createQdrantClient,
} from './indexer.js';
export type { IndexerConfig } from './indexer.js';

export { resolveTags, autoDetectTags } from './metadata.js';

export { Searcher } from './searcher.js';
export type { SearcherConfig } from './searcher.js';

export { expandQuery } from './query-expansion.js';

export { detectQueryType, prefixQuery, prefixPassage, modelFamily } from './task-prefixes.js';
export type { QueryType, TaskPrefixConfig, ModelFamily } from './task-prefixes.js';

export { McpHandler } from './mcp-handler.js';
export type { McpHandlerConfig } from './mcp-handler.js';

export { MetadataStore } from './metadata-db.js';

// ── Arch layer ─────────────────────────────────────────────────────────────
export { ArchStore } from './arch/store.js';
export type { ArchStoreConfig, SearchOpts as ArchSearchOpts } from './arch/store.js';
export {
  toArchCollectionName,
  fromArchCollectionName,
  isArchCollection,
  ensureArchCollection,
  dropArchCollection,
} from './arch/collection.js';
export { buildArchContext, buildArchContextWithVector } from './arch/context.js';
export { createArchEmbeddingProvider, resolveArchEmbeddingConfig } from './arch/text-embeddings.js';
export type { ArchEmbeddingConfig } from './arch/text-embeddings.js';
export type {
  ArchKind,
  ArchStatus,
  ArchScope,
  ArchSeverity,
  ArchPoint,
  ArchComponent,
  ArchDecision,
  ArchLesson,
  ArchContextResult,
} from './arch/types.js';

// ── Docs layer ─────────────────────────────────────────────────────────────
export { DocsStore } from './docs/store.js';
export type { DocsStoreConfig, IndexDocumentInput, DocsSearchOpts } from './docs/store.js';
export { DocsIdfStore } from './docs/idf-store.js';
export { chunkMarkdown, detectMarkdown, NotMarkdownError } from './docs/chunker.js';
export {
  toDocsCollectionName,
  fromDocsCollectionName,
  isDocsCollection,
  ensureDocsCollection,
  dropDocsCollection,
} from './docs/collection.js';
export type { DocsChunk, DocsSearchHit, MarkdownChunkOptions } from './docs/types.js';

// ── Terminology layer ──────────────────────────────────────────────────────
export { TerminologyStore } from './terminology/store.js';
export type {
  TerminologyStoreConfig,
  RecordTermInput,
  TermSearchOpts,
} from './terminology/store.js';
export {
  toTermsCollectionName,
  fromTermsCollectionName,
  isTermsCollection,
  ensureTermsCollection,
  dropTermsCollection,
} from './terminology/collection.js';
export type { Term, TermSearchHit, TermWriteResult } from './terminology/types.js';

export { createTreeSitterManager } from './tree-sitter-parser.js';
export type { TreeSitterManager, ParsedFile } from './tree-sitter-parser.js';
export { extractSymbolsForChunks } from './ast-symbol-extractor.js';
export type { SymbolExtractionResult, DefinedSymbol } from './ast-symbol-extractor.js';
export { buildSymbolEdges } from './symbol-graph.js';
export { LANGUAGE_QUERIES } from './ast-queries.js';
export type { LanguageQuerySet } from './ast-queries.js';
export { extractTickets, validateTicketPatterns } from './ticket-extractor.js';
export type { ExtractedTicket } from './ticket-extractor.js';
export { extractGitMetadata, collectIndexedChunks } from './git-metadata.js';
export type { ExtractGitMetadataOptions, ExtractGitMetadataResult } from './git-metadata.js';

export { ProjectWatcher, WatcherManager } from './watcher.js';
export type { WatcherCallbacks, ProjectWatcherOptions, WatcherStats } from './watcher.js';

export { createApp, withTimeout, refreshGaugeMetrics } from './app.js';
export type {
  CreateAppOptions,
  CreateAppResult,
  RefreshGaugeMetricsOptions,
  GaugeSnapshot,
} from './app.js';

export { QueryCache } from './query-cache.js';
export type { QueryCacheConfig, QueryCacheStats } from './query-cache.js';

export { createMetrics, NoOpMetrics } from './metrics.js';
export type { MetricsRegistry } from './metrics.js';

// ── Telemetry ─────────────────────────────────────────────────────────────
export { createTelemetry } from './telemetry/facade.js';
export type { Telemetry, TelemetrySink } from './telemetry/facade.js';
export { buildTelemetry } from './telemetry/factory.js';
export type { BuildTelemetryOptions, BuiltTelemetry } from './telemetry/factory.js';
export { AnalyticsStore } from './telemetry/analytics-store.js';
export type { AnalyticsStoreOptions } from './telemetry/analytics-store.js';
export { tctx, newContext, systemContext } from './telemetry/context.js';
export type { TelemetryContext } from './telemetry/context.js';
export { identityMiddleware } from './telemetry/identity-middleware.js';
export { scheduleRetention, runRetention, getRetentionConfig } from './telemetry/retention.js';
export type { RetentionConfig } from './telemetry/retention.js';
export { hashQuery, tokenizeQuery, normalizeQuery } from './telemetry/query-utils.js';
export type {
  ChunkFetchEvent,
  ChunkingErrorEvent,
  EmbeddingCallEvent,
  FileSnapshotRecord,
  IndexingRunEvent,
  SearchRecordEvent,
  SearchResultRecord,
  ToolCallEvent,
} from './telemetry/types.js';

export type {
  ChunkKind,
  GitMetadataConfig,
  MetadataConfig,
  ResolvedMetadataConfig,
  PaparatsConfig,
  ProjectConfig,
  GroupInfo,
  ChunkResult,
  ChunkCommit,
  ChunkTicket,
  SearchResult,
  SearchMetrics,
  SearchResponse,
  EmbeddingProvider,
  LanguageProfile,
  IndexerStats,
  IndexingConfig,
  WatcherConfig,
  EmbeddingsConfig,
  ResolvedIndexingConfig,
  RelationType,
  SymbolEdge,
} from './types.js';
