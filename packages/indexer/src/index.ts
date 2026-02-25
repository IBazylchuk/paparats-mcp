import { QdrantClient } from '@qdrant/js-client-rest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  createEmbeddingProvider,
  Indexer,
  MetadataStore,
  createTreeSitterManager,
  loadProject,
} from '@paparats/server';
import type { TreeSitterManager, ProjectConfig } from '@paparats/server';
import { parseReposEnv, cloneOrPull, repoPath } from './repo-manager.js';
import { startScheduler } from './scheduler.js';
import type { RepoConfig, HealthResponse, RepoStatus, RunStatus } from './types.js';

// ── Config ──────────────────────────────────────────────────────────────────

const REPOS = process.env['REPOS'] ?? '';
const GITHUB_TOKEN = process.env['GITHUB_TOKEN'];
const CRON = process.env['CRON'] ?? '0 */6 * * *';
const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333';
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
const REPOS_DIR = process.env['REPOS_DIR'] ?? '/data/repos';
const PORT = parseInt(process.env['PORT'] ?? '9877', 10);
/** When set, all repos share this single Qdrant collection (group) */
const PAPARATS_GROUP = process.env['PAPARATS_GROUP']?.trim() || undefined;

if (OLLAMA_URL !== 'http://127.0.0.1:11434') {
  process.env['OLLAMA_URL'] = OLLAMA_URL;
}

// ── State ───────────────────────────────────────────────────────────────────

let globalStatus: RunStatus = 'idle';
let lastRunAt: string | undefined;
const repoStatuses = new Map<string, RepoStatus>();

// ── Bootstrap ───────────────────────────────────────────────────────────────

const repos = parseReposEnv(REPOS, GITHUB_TOKEN);
if (repos.length === 0) {
  console.warn('[indexer] No repos configured. Set REPOS env (e.g. "org/repo1,org/repo2").');
}

for (const repo of repos) {
  repoStatuses.set(repo.fullName, { repo: repo.fullName, status: 'idle' });
}

const embeddingProvider = createEmbeddingProvider({
  provider: 'ollama',
  model: process.env['EMBEDDING_MODEL'] ?? 'jina-code-embeddings',
  dimensions: parseInt(process.env['EMBEDDING_DIMENSIONS'] ?? '1536', 10),
});

const metadataStore = new MetadataStore();
const qdrantClient = new QdrantClient({ url: QDRANT_URL, timeout: 30_000 });

let treeSitter: TreeSitterManager | undefined;
try {
  treeSitter = await createTreeSitterManager();
  console.log('[indexer] Tree-sitter WASM initialized');
} catch (err) {
  console.warn(
    `[indexer] Tree-sitter initialization failed (non-fatal): ${(err as Error).message}`
  );
}

const indexer = new Indexer({
  qdrantUrl: QDRANT_URL,
  embeddingProvider,
  dimensions: embeddingProvider.dimensions,
  metadataStore,
  treeSitter,
  qdrantClient,
});

// ── Index cycle ─────────────────────────────────────────────────────────────

function buildDefaultProject(repo: RepoConfig, localPath: string): ProjectConfig {
  return {
    name: repo.name,
    path: localPath,
    group: PAPARATS_GROUP ?? repo.name,
    languages: ['generic'],
    patterns: ['**/*'],
    exclude: [],
    indexing: {
      paths: ['./'],
      exclude: [],
      respectGitignore: true,
      extensions: [],
      chunkSize: 1024,
      overlap: 0,
      concurrency: 2,
      batchSize: 50,
    },
    watcher: { enabled: false, debounce: 1000, stabilityThreshold: 1000 },
    embeddings: {
      provider: 'ollama',
      model: 'jina-code-embeddings',
      dimensions: 1536,
    },
    metadata: {
      service: repo.name,
      bounded_context: null,
      tags: [],
      directory_tags: {},
      git: { enabled: true, maxCommitsPerFile: 50, ticketPatterns: [] },
    },
  };
}

async function indexRepo(repo: RepoConfig): Promise<number> {
  const localPath = repoPath(repo, REPOS_DIR);
  const status = repoStatuses.get(repo.fullName)!;
  status.status = 'running';

  try {
    await cloneOrPull(repo, REPOS_DIR);

    let project: ProjectConfig;
    const configPath = path.join(localPath, '.paparats.yml');
    if (fs.existsSync(configPath)) {
      project = loadProject(localPath);
      if (PAPARATS_GROUP) {
        project = { ...project, group: PAPARATS_GROUP };
      }
    } else {
      console.log(`[indexer] No .paparats.yml in ${repo.fullName}, using defaults`);
      project = buildDefaultProject(repo, localPath);
    }

    const chunks = await indexer.indexProject(project);
    status.status = 'success';
    status.lastRun = new Date().toISOString();
    status.chunksIndexed = chunks;
    status.lastError = undefined;
    console.log(`[indexer] ${repo.fullName}: indexed ${chunks} chunks`);
    return chunks;
  } catch (err) {
    status.status = 'error';
    status.lastRun = new Date().toISOString();
    status.lastError = (err as Error).message;
    console.error(`[indexer] ${repo.fullName}: failed - ${(err as Error).message}`);
    return 0;
  }
}

let indexCycleRunning = false;

async function runIndexCycle(filter?: string[]): Promise<void> {
  if (indexCycleRunning) {
    console.warn('[indexer] Index cycle already running, skipping');
    return;
  }

  indexCycleRunning = true;
  globalStatus = 'running';
  const startTime = Date.now();
  const targets = filter ? repos.filter((r) => filter.includes(r.fullName)) : repos;

  console.log(`[indexer] Starting index cycle for ${targets.length} repo(s)...`);

  try {
    let totalChunks = 0;
    for (const repo of targets) {
      totalChunks += await indexRepo(repo);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    lastRunAt = new Date().toISOString();
    globalStatus = 'success';
    console.log(`[indexer] Index cycle complete: ${totalChunks} total chunks in ${elapsed}s`);
  } catch (err) {
    globalStatus = 'error';
    throw err;
  } finally {
    indexCycleRunning = false;
  }
}

// ── HTTP API ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.post('/trigger', async (req, res) => {
  try {
    const body = req.body as { repos?: string[] } | undefined;
    const filter = body?.repos;
    // Run async — don't block the response
    runIndexCycle(filter).catch((err) => {
      console.error('[indexer] Triggered cycle failed:', (err as Error).message);
    });
    res.json({ status: 'triggered', repos: filter ?? repos.map((r) => r.fullName) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/health', (_req, res) => {
  const health: HealthResponse = {
    status: globalStatus,
    lastRunAt,
    nextScheduledAt: undefined,
    repoCount: repos.length,
    repos: Array.from(repoStatuses.values()),
  };
  res.json(health);
});

// ── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[indexer] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[indexer] Repos: ${repos.map((r) => r.fullName).join(', ') || '(none)'}`);
  console.log(`[indexer] Cron: ${CRON}`);
  console.log(`[indexer] Qdrant: ${QDRANT_URL}`);
  console.log(`[indexer] Ollama: ${OLLAMA_URL}`);
  if (PAPARATS_GROUP) {
    console.log(`[indexer] Shared group: ${PAPARATS_GROUP} (all repos → one collection)`);
  }
});

// Start cron scheduler
if (repos.length > 0) {
  startScheduler(CRON, () => runIndexCycle());

  // Run initial index cycle on startup
  console.log('[indexer] Running initial index cycle...');
  runIndexCycle().catch((err) => {
    console.error('[indexer] Initial cycle failed:', (err as Error).message);
  });
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('\n[indexer] Shutting down...');
  server.close();
  embeddingProvider.close();
  metadataStore.close();
  treeSitter?.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
