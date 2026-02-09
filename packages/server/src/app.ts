import express, { type Express } from 'express';
import cors from 'cors';
import { buildProjectConfigFromContent } from './config.js';
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

/** Sanitize user-supplied string for safe logging (prevents log injection) */
function sanitizeForLog(s: string, maxLen = 200): string {
  const cleaned = String(s)
    // eslint-disable-next-line no-control-regex -- intentional: strip control chars for log safety
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

/** Options for createApp - all services required for the HTTP server */
export interface CreateAppOptions {
  searcher: Searcher;
  indexer: Indexer;
  watcherManager: WatcherManager;
  embeddingProvider: CachedEmbeddingProvider;
  /** Projects map - mutated by registerProject */
  projectsByGroup: Map<string, ProjectConfig[]>;
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
  const { searcher, indexer, watcherManager, embeddingProvider, projectsByGroup } = options;

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
  app.use(express.json({ limit: '50mb' }));

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

  // ── POST /api/index (content-based) ─────────────────────────────────────────

  app.post('/api/index', async (req, res) => {
    try {
      const { group, project: projectName, config: apiConfig, files, force } = req.body;

      if (!group || !projectName || !Array.isArray(files)) {
        res.status(400).json({ error: 'group, project, and files (array) are required' });
        return;
      }

      const project = buildProjectConfigFromContent(projectName, group, apiConfig);
      registerProject(project);

      if (force) {
        await indexer.deleteProjectChunks(group, projectName);
      }

      console.log(
        `[api] Indexing ${sanitizeForLog(project.group)}/${sanitizeForLog(project.name)} (${files.length} files)...`
      );
      const chunks = await withTimeout(
        indexer.indexFilesContent(project, files),
        INDEX_TIMEOUT_MS,
        'Index timeout'
      );

      res.json({
        status: 'ok',
        group: project.group,
        project: project.name,
        chunks,
        skipped: indexer.stats.skipped,
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

  // ── POST /api/file-changed (content-based) ─────────────────────────────────

  app.post('/api/file-changed', async (req, res) => {
    try {
      const { group, project: projectName, path: filePath, content, language } = req.body;

      if (!group || !projectName || !filePath || content === undefined) {
        res.status(400).json({ error: 'group, project, path, and content are required' });
        return;
      }

      const projects = projectsByGroup.get(group);
      const project = projects?.find((p) => p.name === projectName);

      if (!project) {
        res.status(400).json({ error: `Unknown project: ${group}/${projectName}` });
        return;
      }

      const lang = language ?? project.languages[0] ?? 'generic';
      await withTimeout(
        indexer.updateFileContent(group, projectName, filePath, content, lang, project),
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

  // ── POST /api/file-deleted (content-based) ──────────────────────────────────

  app.post('/api/file-deleted', async (req, res) => {
    try {
      const { group, project: projectName, path: filePath } = req.body;

      if (!group || !projectName || !filePath) {
        res.status(400).json({ error: 'group, project, and path are required' });
        return;
      }

      const projects = projectsByGroup.get(group);
      const project = projects?.find((p) => p.name === projectName);

      if (!project) {
        res.status(400).json({ error: `Unknown project: ${group}/${projectName}` });
        return;
      }

      await withTimeout(
        indexer.deleteFileByPath(group, projectName, filePath),
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
