// Phase 1a: exports for core modules
// HTTP server + MCP handler will be added in Phase 1b

export { Chunker } from './chunker.js';
export type { ChunkerConfig } from './chunker.js';

export {
  readConfig,
  resolveProject,
  loadProject,
  getLanguageProfile,
  getSupportedLanguages,
  CONFIG_FILE,
} from './config.js';

export {
  EmbeddingCache,
  OllamaProvider,
  CachedEmbeddingProvider,
  createEmbeddingProvider,
} from './embeddings.js';

export { Indexer } from './indexer.js';
export type { IndexerConfig } from './indexer.js';

export type {
  PaparatsConfig,
  ProjectConfig,
  GroupInfo,
  ChunkResult,
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
} from './types.js';
