import { Router, type Request, type Response } from 'express';
import { validateGroupName } from './config.js';
import type { Indexer } from './indexer.js';
import type { ProjectScopeGuard } from './mcp-handler.js';
import { strongLinks, type FileKey, type ModuleMapService } from './module-map.js';

/** Files and tests listed per module; the page shows counts for the rest. */
const FILES_PER_MODULE = 60;
const TESTS_PER_MODULE = 30;

export interface ModuleMapRouterOptions {
  /** Null when the server has no metadata store, so no symbol graph. */
  moduleMaps: ModuleMapService | null;
  indexer: Pick<Indexer, 'storedProjectName' | 'displayProjectName' | 'listProjectsInGroup'>;
  getGroupNames: () => string[];
  scope: ProjectScopeGuard;
}

/** One module as the console's map page draws it. */
export interface ModuleMapNode {
  id: number;
  name: string;
  project: string;
  fileCount: number;
  files: string[];
  testCount: number;
  tests: string[];
  /** Strong links only (see `strongLinks`), heaviest first. */
  uses: Array<{ module: number; weight: number }>;
  usedBy: Array<{ module: number; weight: number }>;
}

export interface ModuleMapResponse {
  groups: string[];
  group: string | null;
  /** Projects of the group visible on this server. */
  projects: string[];
  project: string | null;
  map: {
    modules: ModuleMapNode[];
    shared: Array<{ file: string; callers: number }>;
    migrations: number;
  } | null;
}

/**
 * `GET /api/module-map?group=&project=` — the module map behind the console's
 * map page, from the same cache `module_map` uses. Mounted next to
 * `/api/analytics`, behind the same optional basic auth.
 */
export function buildModuleMapRouter(options: ModuleMapRouterOptions): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const groups = options.getGroupNames();
      const groupArg = typeof req.query['group'] === 'string' ? req.query['group'] : undefined;
      const projectArg =
        typeof req.query['project'] === 'string' && req.query['project'] !== ''
          ? req.query['project']
          : undefined;
      const group = groupArg ?? groups[0] ?? null;
      const body: ModuleMapResponse = { groups, group, projects: [], project: null, map: null };

      if (!options.moduleMaps) {
        res
          .status(503)
          .json({ ...body, error: 'Symbol graph is not available: no metadata store.' });
        return;
      }
      if (group === null) {
        res.json(body);
        return;
      }
      try {
        validateGroupName(group);
      } catch (err) {
        res.status(400).json({ ...body, error: (err as Error).message });
        return;
      }

      body.projects = (await options.indexer.listProjectsInGroup(group).catch(() => []))
        .map((p) => p.name)
        .filter((name) => options.scope.allowsProject(name))
        .sort();
      // A project out of scope maps as empty: its edges are filtered out anyway.
      body.project = projectArg ?? null;

      const map = options.moduleMaps.get(
        group,
        projectArg !== undefined ? options.indexer.storedProjectName(projectArg) : undefined,
        (id) => options.scope.allowsChunk(id)
      );

      const projects = new Set(
        map.modules.flatMap((m) => m.files.map((k) => k.slice(0, k.indexOf('//'))))
      );
      const show = (key: FileKey): string => {
        const i = key.indexOf('//');
        const file = key.slice(i + 2);
        return projects.size > 1
          ? `[${options.indexer.displayProjectName(key.slice(0, i))}] ${file}`
          : file;
      };
      const round = (links: Array<{ module: number; weight: number }>) =>
        strongLinks(links).map((l) => ({
          module: l.module,
          weight: Math.round(l.weight * 100) / 100,
        }));

      body.map = {
        modules: map.modules.map((m) => ({
          id: m.id,
          name: m.name,
          project: options.indexer.displayProjectName(m.project),
          fileCount: m.files.length,
          files: m.files.slice(0, FILES_PER_MODULE).map(show),
          testCount: m.tests.length,
          tests: m.tests.slice(0, TESTS_PER_MODULE).map(show),
          uses: round(m.uses),
          usedBy: round(m.usedBy),
        })),
        shared: map.shared.slice(0, 30).map((s) => ({ file: show(s.file), callers: s.callers })),
        migrations: map.migrations,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: `Module map failed: ${(err as Error).message}` });
    }
  });

  return router;
}
