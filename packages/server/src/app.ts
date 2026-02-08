import express, { type Express } from 'express';
import cors from 'cors';
import { readConfig, resolveProject } from './config.js';
import type { PaparatsConfig } from './types.js';
import { Indexer } from './indexer.js';
import { Searcher } from './searcher.js';
import { McpHandler } from './mcp-handler.js';
import { WatcherManager } from './watcher.js';
import type { ProjectConfig } from './types.js';
import type { CachedEmbeddingProvider } from './embeddings.js';

/** Run a promise with a timeout; reject with Error on timeout */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMsg: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
}

export const SEARCH_TIMEOUT_MS = 30_000;
export const INDEX_TIMEOUT_MS = 120_000;
export const FILE_CHANGED_TIMEOUT_MS = 60_000;

/** Options for createApp - all services required for the HTTP server */
export interface CreateAppOptions {
  searcher: Searcher;
  indexer: Indexer;
  watcherManager: WatcherManager;
  embeddingProvider: CachedEmbeddingProvider;
  /** Projects map - mutated by registerProject */
  projectsByGroup: Map<string, ProjectConfig[]>;
  /** Config reader for /api/index (default: readConfig from config.js) */
  readConfigFn?: (projectDir: string) => PaparatsConfig;
  /** Project resolver for /api/index (default: resolveProject from config.js) */
  resolveProjectFn?: (projectDir: string, raw: PaparatsConfig) => ProjectConfig;
}

export interface CreateAppResult {
  app: Express;
  mcpHandler: McpHandler;
  /** Call with true to simulate shutdown state (returns 503 on new requests) */
  setShuttingDown: (value: boolean) => void;
  /** Check if server is in shutdown state */
  getShuttingDown: () => boolean;
}

export function createApp(options: CreateAppOptions): CreateAppResult {
  const {
    searcher,
    indexer,
    watcherManager,
    embeddingProvider,
    projectsByGroup,
    readConfigFn = readConfig,
    resolveProjectFn = resolveProject,
  } = options;

  function getGroupNames(): string[] {
    return Array.from(projectsByGroup.keys());
  }

  function getProjects(): Map<string, ProjectConfig[]> {
    return projectsByGroup;
  }

  function registerProject(project: ProjectConfig): void {
    const existing = projectsByGroup.get(project.group) ?? [];
    const filtered = existing.filter((p) => p.name !== project.name);
    filtered.push(project);
    projectsByGroup.set(project.group, filtered);
  }

  let shuttingDown = false;
  const setShuttingDown = (value: boolean): void => {
    shuttingDown = value;
  };
  const getShuttingDown = (): boolean => shuttingDown;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    if (shuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' });
      return;
    }
    next();
  });

  // ── POST /api/search ───────────────────────────────────────────────────────

  app.post('/api/search', async (req, res) => {
    try {
      const { group, query, project, limit } = req.body;

      if (!query) {
        res.status(400).json({ error: 'query is required' });
        return;
      }
      if (!group) {
        res.status(400).json({ error: 'group is required' });
        return;
      }

      const response = await withTimeout(
        searcher.search(group, query, { project, limit }),
        SEARCH_TIMEOUT_MS,
        'Search timeout'
      );
      res.json(response);
    } catch (err) {
      if ((err as Error).message === 'Search timeout') {
        res.status(504).json({ error: 'Search request timed out after 30s' });
      } else {
        console.error('[api] Search error:', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // ── POST /api/index ────────────────────────────────────────────────────────

  app.post('/api/index', async (req, res) => {
    try {
      const { projectDir } = req.body;

      if (!projectDir) {
        res.status(400).json({ error: 'projectDir is required' });
        return;
      }

      const raw = readConfigFn(projectDir);
      const project = resolveProjectFn(projectDir, raw);

      registerProject(project);

      console.log(`[api] Indexing ${project.group}/${project.name}...`);
      const chunks = await withTimeout(
        indexer.indexProject(project),
        INDEX_TIMEOUT_MS,
        'Index timeout'
      );

      watcherManager.watch(project);

      res.json({
        status: 'ok',
        group: project.group,
        project: project.name,
        chunks,
      });
    } catch (err) {
      if ((err as Error).message === 'Index timeout') {
        res.status(504).json({ error: 'Index request timed out after 120s' });
      } else {
        console.error('[api] Index error:', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // ── POST /api/file-changed ─────────────────────────────────────────────────

  app.post('/api/file-changed', async (req, res) => {
    try {
      const { group, project: projectName, file } = req.body;

      if (!group || !projectName || !file) {
        res.status(400).json({ error: 'group, project, and file are required' });
        return;
      }

      const projects = projectsByGroup.get(group);
      const project = projects?.find((p) => p.name === projectName);

      if (!project) {
        res.status(400).json({ error: `Unknown project: ${group}/${projectName}` });
        return;
      }

      const filePath = file.startsWith('/') ? file : `${project.path}/${file}`;
      await withTimeout(
        indexer.updateFile(group, project, filePath),
        FILE_CHANGED_TIMEOUT_MS,
        'File-changed timeout'
      );

      res.json({ status: 'ok', message: 'File reindexed' });
    } catch (err) {
      if ((err as Error).message === 'File-changed timeout') {
        res.status(504).json({ error: 'File-changed request timed out after 60s' });
      } else {
        console.error('[api] File-changed error:', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // ── POST /api/file-deleted ─────────────────────────────────────────────────

  app.post('/api/file-deleted', async (req, res) => {
    try {
      const { group, project: projectName, file } = req.body;

      if (!group || !projectName || !file) {
        res.status(400).json({ error: 'group, project, and file are required' });
        return;
      }

      const projects = projectsByGroup.get(group);
      const project = projects?.find((p) => p.name === projectName);

      if (!project) {
        res.status(400).json({ error: `Unknown project: ${group}/${projectName}` });
        return;
      }

      const filePath = file.startsWith('/') ? file : `${project.path}/${file}`;
      await withTimeout(
        indexer.deleteFile(group, project, filePath),
        FILE_CHANGED_TIMEOUT_MS,
        'File-deleted timeout'
      );

      res.json({ status: 'ok', message: 'File removed from index' });
    } catch (err) {
      if ((err as Error).message === 'File-deleted timeout') {
        res.status(504).json({ error: 'File-deleted request timed out after 60s' });
      } else {
        console.error('[api] File-deleted error:', err);
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // ── GET /health ────────────────────────────────────────────────────────────

  app.get('/health', async (_req, res) => {
    try {
      const groups = await indexer.listGroups();
      const mem = process.memoryUsage();
      const memPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
      const status = memPercent > 90 ? 'degraded' : 'ok';

      res.json({
        status,
        groups,
        uptime: process.uptime(),
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
          percent: memPercent,
        },
      });
    } catch (err) {
      res.status(503).json({ status: 'error', error: (err as Error).message });
    }
  });

  // ── GET /api/stats ─────────────────────────────────────────────────────────

  app.get('/api/stats', async (_req, res) => {
    try {
      const groups = await indexer.listGroups();
      const usage = searcher.getUsageStats();
      const cacheStats = embeddingProvider.getCacheStats();
      const watcherStats = watcherManager.getStats();

      res.json({
        groups,
        registeredProjects: Object.fromEntries(
          Array.from(projectsByGroup.entries()).map(([g, ps]) => [g, ps.map((p) => p.name)])
        ),
        cache: cacheStats,
        watcher: watcherStats,
        memory: process.memoryUsage(),
        usage,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── MCP transports ─────────────────────────────────────────────────────────

  const mcpHandler = new McpHandler({
    searcher,
    indexer,
    getProjects,
    getGroupNames,
  });
  mcpHandler.mount(app);

  return { app, mcpHandler, setShuttingDown, getShuttingDown };
}
