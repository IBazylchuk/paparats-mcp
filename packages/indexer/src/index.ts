import express from 'express';
import path from 'path';
import {
  createEmbeddingProvider,
  resolveEmbeddingConfigFromEnv,
  Indexer,
  createQdrantClient,
  MetadataStore,
  createTreeSitterManager,
  createMetrics,
  DocsStore,
  DocsIdfStore,
  createArchEmbeddingProvider,
  resolveArchEmbeddingConfig,
  buildTelemetry,
  systemContext,
  tctx,
} from '@paparats/server';
import type { TreeSitterManager } from '@paparats/server';
import { parseReposEnv, cloneOrPull, repoPath } from './repo-manager.js';
import { startScheduler } from './scheduler.js';
import { tryLoadIndexerConfig, resolveConfigPath } from './config-loader.js';
import { ConfigWatcher } from './config-watcher.js';
import { StateStore } from './state-store.js';
import { GitDetector, MtimeDetector } from './change-detector.js';
import { resolveRepoProject } from './project-resolver.js';
import { IndexOrchestrator } from './orchestrator.js';
import type { RepoConfig } from './types.js';

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
/** Opt-in: also walk each repo's markdown into the docs layer. Off by default. */
const INDEX_DOCS = (process.env['INDEX_DOCS'] ?? 'false').toLowerCase() === 'true';
const QDRANT_URL = process.env['QDRANT_URL'] ?? 'http://localhost:6333';
const QDRANT_API_KEY = process.env['QDRANT_API_KEY'] || undefined;
const EMBED_URL = process.env['EMBED_URL'] ?? 'http://127.0.0.1:18434';
const REPOS_DIR = process.env['REPOS_DIR'] ?? '/data/repos';
const STATE_DB_PATH =
  process.env['STATE_DB_PATH'] ?? path.join(REPOS_DIR, '..', 'indexer-state.db');
const PORT = parseInt(process.env['PORT'] ?? '9877', 10);
/** When set, all repos share this single Qdrant collection (group) */
const PAPARATS_GROUP = process.env['PAPARATS_GROUP']?.trim() || undefined;
/**
 * Suffix appended to project names in the storage layer so two stands sharing
 * one Qdrant don't evict each other's chunks. Default '' = unchanged behavior.
 */
const PAPARATS_PROJECT_SUFFIX = process.env['PAPARATS_PROJECT_SUFFIX']?.trim() ?? '';

if (EMBED_URL !== 'http://127.0.0.1:18434') {
  process.env['EMBED_URL'] = EMBED_URL;
}

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

const embeddingConfig = resolveEmbeddingConfigFromEnv();
const embeddingProvider = createEmbeddingProvider(embeddingConfig);
console.log(
  `[indexer] Embedding provider: ${embeddingConfig.provider} (${embeddingConfig.model}, ${embeddingConfig.dimensions}d)`
);

const metrics = await createMetrics();
embeddingProvider.attachMetrics(metrics);

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

// Docs layer (opt-in). Uses the qwen3 text provider — a second embedder next to
// the code one — and its own IDF store. Only built when INDEX_DOCS is set so the
// default code-only path pulls in nothing extra.
let docsStore: DocsStore | undefined;
if (INDEX_DOCS) {
  const textConfig = resolveArchEmbeddingConfig(process.env);
  const textProvider = createArchEmbeddingProvider(textConfig);
  textProvider.attachMetrics(metrics);
  console.log(
    `[indexer] Docs embedding provider: ${textConfig.provider} (${textConfig.model}, ${textConfig.dimensions}d)`
  );
  docsStore = new DocsStore({
    qdrant: qdrantClient,
    provider: textProvider,
    idf: new DocsIdfStore(),
  });
}

// The indexer writes the `files` table (one row per indexed file, with its line
// count). The server reads it to price a search result against the whole file it
// came from. Both containers mount the same paparats_data volume, so they share
// one analytics.db. Without telemetry here that table stays empty and every
// token-savings figure falls back to a constant.
const { telemetry } = await buildTelemetry();

const indexer = new Indexer({
  qdrantUrl: QDRANT_URL,
  embeddingProvider,
  dimensions: embeddingProvider.dimensions,
  metadataStore,
  treeSitter,
  qdrantClient,
  metrics,
  telemetry,
  projectSuffix: PAPARATS_PROJECT_SUFFIX,
  ...(docsStore ? { docsStore } : {}),
});

const stateStore = new StateStore(STATE_DB_PATH);
const gitDetector = new GitDetector();
// With docs indexing on, markdown edits must move the local fingerprint too.
const mtimeDetector = new MtimeDetector({ includeDocs: INDEX_DOCS });

// ── Orchestration ───────────────────────────────────────────────────────────

const resolveProjectFor = (repo: RepoConfig, localPath: string) =>
  resolveRepoProject(repo, localPath, { sharedGroup: PAPARATS_GROUP });

const orchestrator = new IndexOrchestrator(
  {
    indexer,
    stateStore,
    syncRepo: (repo) => cloneOrPull(repo, REPOS_DIR),
    repoPath: (repo) => repoPath(repo, REPOS_DIR),
    resolveProject: resolveProjectFor,
    fingerprint: async (repo) => {
      if (repo.localPath) {
        const { project } = resolveProjectFor(repo, repo.localPath);
        return mtimeDetector.fingerprint(repo.localPath, project);
      }
      return gitDetector.fingerprint(repo);
    },
    indexDocs: INDEX_DOCS,
    sharedGroup: PAPARATS_GROUP,
    // Rows this indexer writes are attributed to `system:indexer` rather than
    // the anonymous fallback.
    runInContext: (task) => tctx.run(systemContext('indexer'), task),
  },
  repos
);

// ── HTTP API ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.post('/trigger', (req, res) => {
  try {
    const body = (req.body ?? {}) as { repos?: unknown; force?: unknown };
    if (
      body.repos !== undefined &&
      (!Array.isArray(body.repos) || !body.repos.every((r) => typeof r === 'string'))
    ) {
      res.status(400).json({ error: '"repos" must be an array of repo names' });
      return;
    }
    // An empty list means "all", same as omitting it.
    const filter = body.repos && body.repos.length > 0 ? (body.repos as string[]) : undefined;
    const force = body.force === true;

    // Resolve the filter to actual repos *before* queueing the cycle so we
    // can reject unknown identifiers with 404 instead of returning 200 and
    // silently doing nothing — the CLI's --force recovery path depends on
    // this signal.
    const targets = filter ? orchestrator.resolveTargets(filter) : [...orchestrator.repos];
    if (filter && targets.length === 0) {
      res.status(404).json({
        error: 'No matching repos',
        requested: filter,
        known: orchestrator.repos.map((r) => ({ name: r.name, fullName: r.fullName })),
      });
      return;
    }

    // Runs in the background. While another cycle is running the request is
    // queued (merged with other queued requests) and runs right after it.
    const state = orchestrator.requestCycle({ ...(filter ? { repos: filter } : {}), force });
    res.status(state === 'queued' ? 202 : 200).json({
      status: state === 'queued' ? 'queued' : 'triggered',
      repos: targets.map((r) => r.fullName),
      force,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

if (metrics.enabled) {
  app.get('/metrics', metrics.getMetricsHandler());
}

app.get('/health', (_req, res) => {
  res.json(orchestrator.health());
});

// ── Start ───────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[indexer] Listening on http://0.0.0.0:${PORT}`);
  console.log(
    `[indexer] Repos: ${orchestrator.repos.map((r) => r.fullName).join(', ') || '(none)'}`
  );
  console.log(`[indexer] Full cron: ${effectiveCron}`);
  console.log(
    `[indexer] Fast cron: ${CHANGE_DETECTION_ENABLED ? effectiveCronFast : '(disabled)'}`
  );
  console.log(`[indexer] State DB: ${STATE_DB_PATH}`);
  console.log(`[indexer] Qdrant: ${QDRANT_URL}${QDRANT_API_KEY ? ' (authenticated)' : ''}`);
  console.log(`[indexer] Embeddings: ${EMBED_URL}`);
  if (PAPARATS_GROUP) {
    console.log(`[indexer] Shared group: ${PAPARATS_GROUP} (all repos → one collection)`);
  }
  if (metrics.enabled) {
    console.log(`[indexer] Metrics: http://localhost:${PORT}/metrics`);
  }
});

// Start cron schedulers. Always — even with no repos yet: `paparats install`
// writes an empty project list and repos arrive later via hot-reload; a cycle
// over an empty list is a no-op.
startScheduler(effectiveCron, async () => orchestrator.scheduledFullCycle());
if (CHANGE_DETECTION_ENABLED) {
  startScheduler(effectiveCronFast, () => orchestrator.runChangeCheckCycle());
}

if (orchestrator.repos.length > 0) {
  console.log('[indexer] Running initial index cycle...');
  orchestrator.requestCycle({});
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
        // Removed repos are purged; added and modified ones reindexed. Each
        // task waits for any in-flight work on the same repo.
        void orchestrator.applyConfigChange(change);
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
