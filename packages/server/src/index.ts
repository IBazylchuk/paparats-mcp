import { resolveProject, readConfig } from './config.js';
import { createEmbeddingProvider } from './embeddings.js';
import { Indexer } from './indexer.js';
import { Searcher } from './searcher.js';
import { WatcherManager } from './watcher.js';
import type { ProjectConfig } from './types.js';
import { createApp } from './app.js';

// ── State ──────────────────────────────────────────────────────────────────

/** Registered projects grouped by group name */
const projectsByGroup = new Map<string, ProjectConfig[]>();

// ── Bootstrap ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '9876', 10);
const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';

const embeddingProvider = createEmbeddingProvider({
  provider: 'ollama',
  model: process.env.EMBEDDING_MODEL ?? 'jina-code-embeddings',
  dimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1536', 10),
});

if (OLLAMA_URL !== 'http://127.0.0.1:11434') {
  process.env.OLLAMA_URL = OLLAMA_URL;
}

const indexer = new Indexer({
  qdrantUrl: QDRANT_URL,
  embeddingProvider,
  dimensions: embeddingProvider.dimensions,
});

const searcher = new Searcher({
  qdrantUrl: QDRANT_URL,
  embeddingProvider,
});

const watcherManager = new WatcherManager({
  onFileChanged: async (groupName, project, filePath) => {
    await indexer.updateFile(groupName, project, filePath);
  },
  onFileDeleted: async (groupName, project, filePath) => {
    await indexer.deleteFile(groupName, project, filePath);
  },
});

// ── Create and start server ─────────────────────────────────────────────────

const { app, mcpHandler, setShuttingDown, getShuttingDown } = createApp({
  searcher,
  indexer,
  watcherManager,
  embeddingProvider,
  projectsByGroup,
  readConfigFn: readConfig,
  resolveProjectFn: resolveProject,
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`paparats-mcp listening on http://0.0.0.0:${PORT}`);
  console.log(`  MCP SSE (Cursor):         http://localhost:${PORT}/sse`);
  console.log(`  MCP Streamable HTTP:      http://localhost:${PORT}/mcp`);
  console.log(`  Health:                   http://localhost:${PORT}/health`);
  console.log(`  Stats:                    http://localhost:${PORT}/api/stats`);
  console.log(`  Qdrant:                   ${QDRANT_URL}`);
  console.log(`  Ollama:                   ${OLLAMA_URL}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nError: Port ${PORT} is already in use`);
    console.error('Set a different PORT environment variable or stop the other process\n');
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (getShuttingDown()) return;
  setShuttingDown(true);

  console.log('\nShutting down gracefully...');

  server.close((err) => {
    if (err) console.error('Error closing server:', err);
  });

  await new Promise((resolve) => setTimeout(resolve, 5000));

  mcpHandler.destroy();
  await watcherManager.stopAll();
  embeddingProvider.close();

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Re-exports for programmatic use ────────────────────────────────────────

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
export type { CacheStats } from './embeddings.js';

export { Indexer } from './indexer.js';
export type { IndexerConfig } from './indexer.js';

export { Searcher } from './searcher.js';
export type { SearcherConfig } from './searcher.js';

export { McpHandler } from './mcp-handler.js';
export type { McpHandlerConfig } from './mcp-handler.js';

export { ProjectWatcher, WatcherManager } from './watcher.js';
export type { WatcherCallbacks, ProjectWatcherOptions, WatcherStats } from './watcher.js';

export { createApp, withTimeout } from './app.js';
export type { CreateAppOptions, CreateAppResult } from './app.js';

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
