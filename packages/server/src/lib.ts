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
  OllamaProvider,
  CachedEmbeddingProvider,
  createEmbeddingProvider,
} from './embeddings.js';
export type { CacheStats } from './embeddings.js';

export {
  Indexer,
  buildChunkId,
  parseChunkId,
  toCollectionName,
  fromCollectionName,
  createQdrantClient,
} from './indexer.js';
export type { IndexerConfig } from './indexer.js';

export { resolveTags, autoDetectTags } from './metadata.js';

export { Searcher } from './searcher.js';
export type { SearcherConfig } from './searcher.js';

export { expandQuery } from './query-expansion.js';

export {
  detectQueryType,
  prefixQuery,
  prefixPassage,
  getQueryPrefix,
  getPassagePrefix,
} from './task-prefixes.js';
export type { QueryType, TaskPrefixConfig } from './task-prefixes.js';

export { McpHandler } from './mcp-handler.js';
export type { McpHandlerConfig } from './mcp-handler.js';

export { MetadataStore } from './metadata-db.js';
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

export { createApp, withTimeout } from './app.js';
export type { CreateAppOptions, CreateAppResult } from './app.js';

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
