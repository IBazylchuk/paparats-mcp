import { QdrantClient } from '@qdrant/js-client-rest';
import { createEmbeddingProvider } from './embeddings.js';
import { Indexer } from './indexer.js';
import { Searcher } from './searcher.js';
import { WatcherManager } from './watcher.js';
import { MetadataStore } from './metadata-db.js';
import { createTreeSitterManager } from './tree-sitter-parser.js';
import type { TreeSitterManager } from './tree-sitter-parser.js';
import type { ProjectConfig } from './types.js';
import { createApp } from './app.js';
import { QueryCache } from './query-cache.js';
import { createMetrics } from './metrics.js';

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

const metadataStore = new MetadataStore();

let treeSitter: TreeSitterManager | undefined;
try {
  treeSitter = await createTreeSitterManager();
  console.log('[startup] Tree-sitter WASM initialized');
} catch (err) {
  console.warn(
    `[startup] Tree-sitter initialization failed (non-fatal): ${(err as Error).message}`
  );
}

const qdrantClient = new QdrantClient({ url: QDRANT_URL, timeout: 30_000 });
const queryCache = new QueryCache();
const metrics = await createMetrics();

const indexer = new Indexer({
  qdrantUrl: QDRANT_URL,
  embeddingProvider,
  dimensions: embeddingProvider.dimensions,
  metadataStore,
  treeSitter,
  qdrantClient,
});

const searcher = new Searcher({
  qdrantUrl: QDRANT_URL,
  embeddingProvider,
  qdrantClient,
  cache: queryCache,
  metrics,
});

const watcherManager = new WatcherManager({
  onFileChanged: async (groupName, project, filePath) => {
    searcher.invalidateGroupCache(groupName);
    metrics.incWatcherEventsTotal(groupName, 'changed');
    await indexer.updateFile(groupName, project, filePath);
  },
  onFileDeleted: async (groupName, project, filePath) => {
    searcher.invalidateGroupCache(groupName);
    metrics.incWatcherEventsTotal(groupName, 'deleted');
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
  metadataStore,
  metrics,
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`paparats-mcp listening on http://0.0.0.0:${PORT}`);
  console.log(`  MCP Coding:               http://localhost:${PORT}/mcp`);
  console.log(`  MCP Support:              http://localhost:${PORT}/support/mcp`);
  console.log(`  MCP SSE (legacy):         http://localhost:${PORT}/sse`);
  console.log(`  Health:                   http://localhost:${PORT}/health`);
  console.log(`  Stats:                    http://localhost:${PORT}/api/stats`);
  console.log(`  Qdrant:                   ${QDRANT_URL}`);
  console.log(`  Ollama:                   ${OLLAMA_URL}`);
  if (metrics.enabled) {
    console.log(`  Metrics:                  http://localhost:${PORT}/metrics`);
  }

  // Restore groups from Qdrant so search works without re-indexing
  indexer
    .listGroups()
    .then((groups) => {
      for (const groupName of Object.keys(groups)) {
        if (!projectsByGroup.has(groupName)) {
          projectsByGroup.set(groupName, []);
          console.log(`  Restored group from Qdrant: ${groupName} (${groups[groupName]} chunks)`);
        }
      }
    })
    .catch((err) => {
      console.warn('[startup] Could not restore groups from Qdrant:', (err as Error).message);
    });
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

  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) console.error('Error closing server:', err);
      resolve();
    });
    // Force-resolve after 5s if connections don't drain
    setTimeout(resolve, 5000);
  });

  mcpHandler.destroy();
  await watcherManager.stopAll();
  embeddingProvider.close();
  metadataStore.close();
  treeSitter?.close();

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Re-exports for programmatic use (from lib.ts) ─────────────────────────
export * from './lib.js';
