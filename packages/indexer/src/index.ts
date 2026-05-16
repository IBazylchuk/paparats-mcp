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
import { DEFAULT_GROUP, normalizeExcludePatterns } from '@paparats/shared';
import { parseReposEnv, cloneOrPull, repoPath } from './repo-manager.js';
import { startScheduler } from './scheduler.js';
import { tryLoadIndexerConfig, resolveConfigPath } from './config-loader.js';
import { ConfigWatcher } from './config-watcher.js';
import { resolveTriggerTargets } from './trigger-filter.js';
import { StateStore } from './state-store.js';
import { GitDetector, MtimeDetector, type Fingerprint } from './change-detector.js';
import type { RepoConfig, RepoOverrides, HealthResponse, RepoStatus, RunStatus } from './types.js';

// ── Config ──────────────────────────────────────────────────────────────────

const REPOS = process.env['REPOS'] ?? '';
const GITHUB_TOKEN = process.env['GITHUB_TOKEN'];
/** Slow safety-net cycle: indexes every repo unconditionally. */
const CRON = process.env['CRON'] ?? '0 */3 * * *';
/** Fast change-detection cycle: only indexes repos whose fingerprint changed. */
const CRON_FAST = process.env['CRON_FAST'] ?? '*/10 * * * *';
/** Set to "false" to disable change-detection entirely and rely on CRON only. */
const CHANGE_DETECTION_ENABLED =
  (process.env['CHANGE_DETECTION'] ?? 'true').toLowerCase() !== 'false';
const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333';
const QDRANT_API_KEY = process.env['QDRANT_API_KEY'] || undefined;
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
const REPOS_DIR = process.env['REPOS_DIR'] ?? '/data/repos';
const STATE_DB_PATH =
  process.env['STATE_DB_PATH'] ?? path.join(REPOS_DIR, '..', 'indexer-state.db');
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
let configCronFast: string | undefined;

const fileConfig = tryLoadIndexerConfig(CONFIG_DIR, GITHUB_TOKEN);
if (fileConfig) {
  repos = fileConfig.repos;
  configCron = fileConfig.cron;
  configCronFast = fileConfig.cronFast;
  console.log(`[indexer] Loaded ${repos.length} repo(s) from config file`);
} else {
  repos = parseReposEnv(REPOS, GITHUB_TOKEN);
  if (repos.length === 0) {
    console.warn('[indexer] No repos configured. Set REPOS env or mount projects.yml.');
  }
}

const effectiveCron = configCron ?? CRON;
const effectiveCronFast = configCronFast ?? CRON_FAST;

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

const stateStore = new StateStore(STATE_DB_PATH);
const gitDetector = new GitDetector();
const mtimeDetector = new MtimeDetector();

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
  const group = PAPARATS_GROUP ?? overrides.group ?? DEFAULT_GROUP;
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
    group: PAPARATS_GROUP ?? DEFAULT_GROUP,
  });
  // Disable watcher in indexer (indexer uses cron, not filesystem events)
  project.watcher.enabled = false;
  return project;
}

/**
 * Resolve a `ProjectConfig` for a repo using whichever source applies:
 * `.paparats.yml` in the repo, indexer YAML overrides, or auto-detection.
 * The repo must already be on disk (either bind-mounted or cloned).
 */
function resolveRepoProject(repo: RepoConfig, localPath: string): ProjectConfig {
  const configPath = path.join(localPath, '.paparats.yml');
  const hasRepoConfig = fs.existsSync(configPath);
  const overrides = repo.overrides;

  if (hasRepoConfig) {
    let project = loadProject(localPath);
    if (PAPARATS_GROUP) project = { ...project, group: PAPARATS_GROUP };
    if (overrides) project = applyOverrides(project, overrides);
    return project;
  }
  if (overrides) {
    const config = buildConfigFromOverrides(repo, localPath, overrides);
    const project = resolveProject(localPath, config);
    project.watcher.enabled = false;
    return project;
  }
  return buildDefaultProject(repo, localPath);
}

interface IndexRepoResult {
  chunks: number;
  success: boolean;
  project?: ProjectConfig;
}

async function indexRepo(repo: RepoConfig, opts?: { force?: boolean }): Promise<IndexRepoResult> {
  const localPath = repoPath(repo, REPOS_DIR);
  const status = repoStatuses.get(repo.fullName)!;
  status.status = 'running';
  const force = opts?.force === true;

  try {
    await cloneOrPull(repo, REPOS_DIR);

    const project = resolveRepoProject(repo, localPath);
    const overrides = repo.overrides;
    const hasRepoConfig = fs.existsSync(path.join(localPath, '.paparats.yml'));
    if (hasRepoConfig && overrides) {
      console.log(`[indexer] ${repo.fullName}: .paparats.yml + indexer overrides applied`);
    } else if (!hasRepoConfig && overrides) {
      console.log(
        `[indexer] ${repo.fullName}: using indexer config overrides (${project.languages.join(', ')})`
      );
    } else if (!hasRepoConfig) {
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
    return { chunks, success: true, project };
  } catch (err) {
    status.status = 'error';
    status.lastRun = new Date().toISOString();
    status.lastError = (err as Error).message;
    console.error(`[indexer] ${repo.fullName}: failed - ${(err as Error).message}`);
    return { chunks: 0, success: false };
  }
}

/**
 * Refresh the fingerprint for a repo after a successful index. Failures here
 * are non-fatal — the next fast-check tick will recompute and may decide to
 * reindex defensively. We only advance state when we can prove "this is what
 * was indexed".
 */
async function refreshFingerprint(
  repo: RepoConfig,
  project: ProjectConfig,
  chunks: number
): Promise<void> {
  try {
    const fp = await computeFingerprint(repo, project);
    stateStore.set(repo.fullName, fp.value, fp.kind, chunks);
  } catch (err) {
    console.warn(
      `[indexer] ${repo.fullName}: post-index fingerprint refresh failed: ${(err as Error).message}`
    );
  }
}

async function computeFingerprint(repo: RepoConfig, project?: ProjectConfig): Promise<Fingerprint> {
  if (repo.localPath) {
    const resolved = project ?? resolveRepoProject(repo, repo.localPath);
    return mtimeDetector.fingerprint(repo.localPath, resolved);
  }
  return gitDetector.fingerprint(repo);
}

let indexCycleRunning = false;
let fastCycleRunning = false;

async function runIndexCycle(filter?: string[], opts?: { force?: boolean }): Promise<void> {
  if (indexCycleRunning) {
    console.warn('[indexer] Index cycle already running, skipping');
    return;
  }
  if (fastCycleRunning) {
    console.warn('[indexer] Fast cycle running, deferring full cycle');
    return;
  }

  indexCycleRunning = true;
  globalStatus = 'running';
  const startTime = Date.now();
  // Shallow-copy: the hot-reload watcher swaps `repos` in place
  // (`repos.length = 0; repos.push(...next)`). If a config change lands
  // mid-cycle and `targets === repos`, the for-of loop below would terminate
  // early. resolveTriggerTargets already returns a fresh array.
  const targets = filter ? resolveTriggerTargets(repos, filter) : [...repos];
  const force = opts?.force === true;

  console.log(
    `[indexer] Starting index cycle for ${targets.length} repo(s)${force ? ' (force)' : ''}...`
  );

  try {
    let totalChunks = 0;
    for (const repo of targets) {
      const result = await indexRepo(repo, { force });
      totalChunks += result.chunks;
      if (result.success && result.project) {
        await refreshFingerprint(repo, result.project, result.chunks);
      }
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

/**
 * Fast cycle: compute a cheap fingerprint per repo (remote `ls-remote` or
 * local file-stat hash) and only invoke indexProject() when it differs from
 * the last persisted fingerprint. Detector failures fall through to a
 * defensive reindex.
 */
async function runChangeCheckCycle(): Promise<void> {
  if (fastCycleRunning) {
    console.log('[indexer] Fast cycle already running, skipping');
    return;
  }
  if (indexCycleRunning) {
    console.log('[indexer] Full cycle running, skipping fast check');
    return;
  }

  fastCycleRunning = true;
  const startTime = Date.now();
  const targets = [...repos];
  let skipped = 0;
  let indexed = 0;
  let totalChunks = 0;

  try {
    for (const repo of targets) {
      try {
        const current = await computeFingerprint(repo);
        const stored = stateStore.get(repo.fullName);
        if (stored && stored.fingerprint === current.value) {
          skipped++;
          continue;
        }
        console.log(
          `[indexer] ${repo.fullName}: changed (${stored?.fingerprint ?? 'new'} → ${current.value.slice(0, 12)}), reindexing`
        );
        const result = await indexRepo(repo);
        if (result.success) {
          indexed++;
          totalChunks += result.chunks;
          stateStore.set(repo.fullName, current.value, current.kind, result.chunks);
        }
      } catch (err) {
        console.warn(
          `[indexer] ${repo.fullName}: fingerprint failed (${(err as Error).message}), reindexing defensively`
        );
        const result = await indexRepo(repo);
        if (result.success) {
          indexed++;
          totalChunks += result.chunks;
          // State not advanced — next tick will retry the fingerprint.
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (indexed > 0) {
      lastRunAt = new Date().toISOString();
      globalStatus = 'success';
    }
    console.log(
      `[indexer] Fast cycle complete: ${indexed} indexed, ${skipped} skipped, ${totalChunks} chunks in ${elapsed}s`
    );
  } finally {
    fastCycleRunning = false;
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

    // Resolve the filter to actual repos *before* spawning the cycle so we
    // can reject unknown identifiers with 404 instead of returning 200 and
    // silently doing nothing — the CLI's --force recovery path depends on
    // this signal.
    let targets: RepoConfig[];
    if (filter && filter.length > 0) {
      targets = resolveTriggerTargets(repos, filter);
      if (targets.length === 0) {
        res.status(404).json({
          error: 'No matching repos',
          requested: filter,
          known: repos.map((r) => ({ name: r.name, fullName: r.fullName })),
        });
        return;
      }
    } else {
      targets = repos;
    }

    // Run async — don't block the response
    runIndexCycle(filter, { force }).catch((err) => {
      console.error('[indexer] Triggered cycle failed:', (err as Error).message);
    });
    res.json({
      status: 'triggered',
      repos: targets.map((r) => r.fullName),
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
  console.log(`[indexer] Full cron: ${effectiveCron}`);
  console.log(
    `[indexer] Fast cron: ${CHANGE_DETECTION_ENABLED ? effectiveCronFast : '(disabled)'}`
  );
  console.log(`[indexer] State DB: ${STATE_DB_PATH}`);
  console.log(`[indexer] Qdrant: ${QDRANT_URL}${QDRANT_API_KEY ? ' (authenticated)' : ''}`);
  console.log(`[indexer] Ollama: ${OLLAMA_URL}`);
  if (PAPARATS_GROUP) {
    console.log(`[indexer] Shared group: ${PAPARATS_GROUP} (all repos → one collection)`);
  }
});

// Start cron schedulers
if (repos.length > 0) {
  startScheduler(effectiveCron, () => runIndexCycle());
  if (CHANGE_DETECTION_ENABLED) {
    startScheduler(effectiveCronFast, () => runChangeCheckCycle());
  }

  // Run initial index cycle on startup
  console.log('[indexer] Running initial index cycle...');
  runIndexCycle().catch((err) => {
    console.error('[indexer] Initial cycle failed:', (err as Error).message);
  });
}

// ── Hot-reload watcher ──────────────────────────────────────────────────────

let configWatcher: ConfigWatcher | undefined;
const configFilePath = resolveConfigPath(CONFIG_DIR);

if (fileConfig && configFilePath) {
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
          stateStore.delete(repo.fullName);
        }
        // Register added repos.
        for (const repo of change.added) {
          repoStatuses.set(repo.fullName, { repo: repo.fullName, status: 'idle' });
        }
        // Modified repos: when fullName changed (e.g. `url` was repointed),
        // the old key is now stale and the new one doesn't exist yet —
        // indexRepo would dereference undefined. Re-key bookkeeping so the
        // new fullName has an entry before the indexer touches it.
        // Also drop the prior fingerprint — overrides like `exclude_extra`
        // can shift which files get indexed without touching content, so
        // the stale fingerprint would otherwise mask a real config change.
        for (const { prior, next } of change.modified) {
          if (prior.fullName !== next.fullName) {
            repoStatuses.delete(prior.fullName);
            repoStatuses.set(next.fullName, { repo: next.fullName, status: 'idle' });
            stateStore.delete(prior.fullName);
          } else {
            stateStore.delete(prior.fullName);
          }
        }
        // Reindex added + modified.
        const targets = [...change.added, ...change.modified.map((m) => m.next)];
        for (const repo of targets) {
          indexRepo(repo)
            .then(async (result) => {
              if (result.success && result.project) {
                await refreshFingerprint(repo, result.project, result.chunks);
              }
            })
            .catch((err) => {
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
  stateStore.close();
  treeSitter?.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
