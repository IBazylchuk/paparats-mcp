import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  createEmbeddingProvider,
  Indexer,
  createQdrantClient,
  MetadataStore,
  createTreeSitterManager,
  loadProject,
  autoProjectConfig,
  resolveProject,
  detectLanguages,
} from '@paparats/server';
import type { TreeSitterManager, ProjectConfig, PaparatsConfig } from '@paparats/server';
import { normalizeExcludePatterns } from '@paparats/shared';
import { parseReposEnv, cloneOrPull, repoPath } from './repo-manager.js';
import { startScheduler } from './scheduler.js';
import { tryLoadIndexerConfig } from './config-loader.js';
import { ConfigWatcher } from './config-watcher.js';
import type { RepoConfig, RepoOverrides, HealthResponse, RepoStatus, RunStatus } from './types.js';

// ── Config ──────────────────────────────────────────────────────────────────

const REPOS = process.env['REPOS'] ?? '';
const GITHUB_TOKEN = process.env['GITHUB_TOKEN'];
const CRON = process.env['CRON'] ?? '0 */6 * * *';
const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333';
const QDRANT_API_KEY = process.env['QDRANT_API_KEY'] || undefined;
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

const CONFIG_DIR = process.env['CONFIG_DIR'] ?? '/config';

let repos: RepoConfig[];
let configCron: string | undefined;

const fileConfig = tryLoadIndexerConfig(CONFIG_DIR, GITHUB_TOKEN);
if (fileConfig) {
  repos = fileConfig.repos;
  configCron = fileConfig.cron;
  console.log(`[indexer] Loaded ${repos.length} repo(s) from config file`);
} else {
  repos = parseReposEnv(REPOS, GITHUB_TOKEN);
  if (repos.length === 0) {
    console.warn('[indexer] No repos configured. Set REPOS env or mount paparats-indexer.yml.');
  }
}

const effectiveCron = configCron ?? CRON;

for (const repo of repos) {
  repoStatuses.set(repo.fullName, { repo: repo.fullName, status: 'idle' });
}

const embeddingProvider = createEmbeddingProvider({
  provider: 'ollama',
  model: process.env['EMBEDDING_MODEL'] ?? 'jina-code-embeddings',
  dimensions: parseInt(process.env['EMBEDDING_DIMENSIONS'] ?? '1536', 10),
});

const metadataStore = new MetadataStore();
const qdrantClient = createQdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

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

/**
 * Build a PaparatsConfig from repo overrides (indexer YAML) for repos without .paparats.yml.
 * Falls back to auto-detected languages if not specified in overrides.
 */
function buildConfigFromOverrides(
  repo: RepoConfig,
  localPath: string,
  overrides: RepoOverrides
): PaparatsConfig {
  const group = PAPARATS_GROUP ?? overrides.group ?? repo.name;
  const language = overrides.language ?? detectLanguages(localPath);

  const config: PaparatsConfig = { group, language };
  if (overrides.indexing) config.indexing = overrides.indexing;
  if (overrides.metadata) config.metadata = overrides.metadata;

  return config;
}

/**
 * Apply indexer YAML overrides on top of an already-resolved ProjectConfig.
 * Used when .paparats.yml exists in the repo — overrides are additive.
 */
function applyOverrides(project: ProjectConfig, overrides: RepoOverrides): ProjectConfig {
  const result = { ...project };

  if (overrides.group) result.group = overrides.group;

  if (overrides.indexing) {
    result.indexing = { ...result.indexing };
    if (overrides.indexing.exclude) {
      result.exclude = overrides.indexing.exclude;
      result.indexing.exclude = overrides.indexing.exclude;
    }
    if (overrides.indexing.exclude_extra) {
      const extra = normalizeExcludePatterns(overrides.indexing.exclude_extra);
      result.exclude = [...result.exclude, ...extra];
      result.indexing.exclude = [...result.indexing.exclude, ...extra];
    }
    if (overrides.indexing.paths) result.indexing.paths = overrides.indexing.paths;
    if (overrides.indexing.extensions) result.indexing.extensions = overrides.indexing.extensions;
    if (overrides.indexing.respectGitignore !== undefined)
      result.indexing.respectGitignore = overrides.indexing.respectGitignore;
    if (overrides.indexing.chunkSize !== undefined)
      result.indexing.chunkSize = overrides.indexing.chunkSize;
    if (overrides.indexing.overlap !== undefined)
      result.indexing.overlap = overrides.indexing.overlap;
    if (overrides.indexing.concurrency !== undefined)
      result.indexing.concurrency = overrides.indexing.concurrency;
    if (overrides.indexing.batchSize !== undefined)
      result.indexing.batchSize = overrides.indexing.batchSize;
  }

  return result;
}

function buildDefaultProject(repo: RepoConfig, localPath: string): ProjectConfig {
  const project = autoProjectConfig(localPath, {
    group: PAPARATS_GROUP ?? repo.name,
  });
  // Disable watcher in indexer (indexer uses cron, not filesystem events)
  project.watcher.enabled = false;
  return project;
}

async function indexRepo(repo: RepoConfig, opts?: { force?: boolean }): Promise<number> {
  const localPath = repoPath(repo, REPOS_DIR);
  const status = repoStatuses.get(repo.fullName)!;
  status.status = 'running';
  const force = opts?.force === true;

  try {
    await cloneOrPull(repo, REPOS_DIR);

    let project: ProjectConfig;
    const configPath = path.join(localPath, '.paparats.yml');
    const hasRepoConfig = fs.existsSync(configPath);
    const overrides = repo.overrides;

    if (hasRepoConfig) {
      // .paparats.yml in the repo takes priority
      project = loadProject(localPath);
      if (PAPARATS_GROUP) {
        project = { ...project, group: PAPARATS_GROUP };
      }
      // Apply indexer YAML overrides on top
      if (overrides) {
        project = applyOverrides(project, overrides);
        console.log(`[indexer] ${repo.fullName}: .paparats.yml + indexer overrides applied`);
      }
    } else if (overrides) {
      // No .paparats.yml but indexer YAML has overrides
      const config = buildConfigFromOverrides(repo, localPath, overrides);
      project = resolveProject(localPath, config);
      project.watcher.enabled = false;
      console.log(
        `[indexer] ${repo.fullName}: using indexer config overrides (${project.languages.join(', ')})`
      );
    } else {
      // No config at all — auto-detect
      project = buildDefaultProject(repo, localPath);
      console.log(
        `[indexer] No .paparats.yml in ${repo.fullName}, auto-detected: ${project.languages.join(', ')} (${project.exclude.length} exclude patterns)`
      );
    }

    if (force) {
      console.log(
        `[indexer] ${repo.fullName}: force=true → dropping existing chunks for ${project.group}/${project.name}`
      );
      await indexer.deleteProjectChunks(project.group, project.name);
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

async function runIndexCycle(filter?: string[], opts?: { force?: boolean }): Promise<void> {
  if (indexCycleRunning) {
    console.warn('[indexer] Index cycle already running, skipping');
    return;
  }

  indexCycleRunning = true;
  globalStatus = 'running';
  const startTime = Date.now();
  const targets = filter ? repos.filter((r) => filter.includes(r.fullName)) : repos;
  const force = opts?.force === true;

  console.log(
    `[indexer] Starting index cycle for ${targets.length} repo(s)${force ? ' (force)' : ''}...`
  );

  try {
    let totalChunks = 0;
    for (const repo of targets) {
      totalChunks += await indexRepo(repo, { force });
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
    const body = req.body as { repos?: string[]; force?: boolean } | undefined;
    const filter = body?.repos;
    const force = body?.force === true;
    // Run async — don't block the response
    runIndexCycle(filter, { force }).catch((err) => {
      console.error('[indexer] Triggered cycle failed:', (err as Error).message);
    });
    res.json({
      status: 'triggered',
      repos: filter ?? repos.map((r) => r.fullName),
      force,
    });
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
  console.log(`[indexer] Cron: ${effectiveCron}`);
  console.log(`[indexer] Qdrant: ${QDRANT_URL}${QDRANT_API_KEY ? ' (authenticated)' : ''}`);
  console.log(`[indexer] Ollama: ${OLLAMA_URL}`);
  if (PAPARATS_GROUP) {
    console.log(`[indexer] Shared group: ${PAPARATS_GROUP} (all repos → one collection)`);
  }
});

// Start cron scheduler
if (repos.length > 0) {
  startScheduler(effectiveCron, () => runIndexCycle());

  // Run initial index cycle on startup
  console.log('[indexer] Running initial index cycle...');
  runIndexCycle().catch((err) => {
    console.error('[indexer] Initial cycle failed:', (err as Error).message);
  });
}

// ── Hot-reload watcher ──────────────────────────────────────────────────────

let configWatcher: ConfigWatcher | undefined;
const configFilePath = `${CONFIG_DIR}/paparats-indexer.yml`;

if (fileConfig && fs.existsSync(configFilePath)) {
  configWatcher = new ConfigWatcher(
    {
      configPath: configFilePath,
      token: GITHUB_TOKEN,
      onChange: (change) => {
        console.log(
          `[indexer] Config changed: +${change.added.length} -${change.removed.length} ~${change.modified.length}`
        );
        // Replace the in-memory project list with the parsed `next`.
        repos.length = 0;
        repos.push(...change.next);

        // Drop bookkeeping for removed repos.
        for (const repo of change.removed) {
          repoStatuses.delete(repo.fullName);
        }
        // Register added repos.
        for (const repo of change.added) {
          repoStatuses.set(repo.fullName, { repo: repo.fullName, status: 'idle' });
        }
        // Reindex added + modified.
        const targets = [...change.added, ...change.modified];
        for (const repo of targets) {
          indexRepo(repo).catch((err) => {
            console.error(
              `[indexer] Hot-reload index for ${repo.fullName} failed: ${(err as Error).message}`
            );
          });
        }
      },
      onError: (err) => console.error(`[indexer] config-watcher error: ${err.message}`),
    },
    repos
  );
  console.log(`[indexer] Watching ${configFilePath} for changes`);
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('\n[indexer] Shutting down...');
  server.close();
  await configWatcher?.close();
  embeddingProvider.close();
  metadataStore.close();
  treeSitter?.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
