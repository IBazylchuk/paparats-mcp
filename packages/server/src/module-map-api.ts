import { Router, type Request, type Response } from 'express';
import { validateGroupName } from './config.js';
import type { Indexer } from './indexer.js';
import type { ProjectScopeGuard } from './mcp-handler.js';
import { strongLinks, type ModuleMap, type ModuleMapService } from './module-map.js';
import {
  fileView,
  folderView,
  moduleView,
  searchFiles,
  type ExplorerLink,
  type ExplorerNode,
} from './map-explorer.js';

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

/** One module as the console's map page lists it. */
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
    shared: Array<{ project: string; file: string; callers: number }>;
    migrations: number;
  } | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The module map API behind the console's map page, from the same cache
 * `module_map` uses. Mounted at `/api/module-map`, behind the same optional
 * basic auth as `/api/analytics`.
 *
 * - `GET /?group=&project=` — the modules (of one project, when given)
 * - `GET /tree?group=&project=&path=` — one folder: its folders and files and the calls between them
 * - `GET /module?group=&module=` — one module: its files and the modules around it
 * - `GET /file?group=&project=&file=` — one file: its module, what it calls and what calls it
 * - `GET /search?group=&q=` — files whose path contains `q`
 *
 * Every route reads the group's map, so module ids are the same on all of them.
 */
export function buildModuleMapRouter(options: ModuleMapRouterOptions): Router {
  const router = Router();
  const display = (stored: string) => options.indexer.displayProjectName(stored);
  const str = (req: Request, name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };

  /** The group's map; throws an HttpError for a bad group or no symbol graph. */
  const groupMap = (group: string | undefined): ModuleMap => {
    if (!options.moduleMaps) {
      throw new HttpError(503, 'Symbol graph is not available: no metadata store.');
    }
    if (group === undefined) throw new HttpError(400, 'group is required');
    try {
      validateGroupName(group);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return options.moduleMaps.get(group, undefined, (id) => options.scope.allowsChunk(id));
  };

  const handle = (what: string, fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.json(fn(req));
    } catch (err) {
      if (err instanceof HttpError) res.status(err.status).json({ error: err.message });
      else res.status(500).json({ error: `${what} failed: ${(err as Error).message}` });
    }
  };

  /** Node keys naming a project (`project` nodes, `[project]` outside nodes) shown by display name. */
  const showNode = (n: ExplorerNode): ExplorerNode =>
    n.kind !== 'project'
      ? n
      : n.key.startsWith('[')
        ? { ...n, key: `[${display(n.key.slice(1, -1))}]` }
        : { ...n, key: display(n.key) };
  const showLinks = (links: ExplorerLink[], nodes: ExplorerNode[]): ExplorerLink[] => {
    const rename = new Map<string, string>();
    for (const n of nodes) {
      const shown = showNode(n).key;
      if (shown !== n.key) rename.set(n.key, shown);
    }
    return links.map((l) => ({
      ...l,
      from: rename.get(l.from) ?? l.from,
      to: rename.get(l.to) ?? l.to,
    }));
  };

  router.get(
    '/tree',
    handle('Folder view', (req) => {
      const map = groupMap(str(req, 'group'));
      const project = str(req, 'project');
      const view = folderView(
        map,
        project !== undefined ? options.indexer.storedProjectName(project) : null,
        str(req, 'path') ?? ''
      );
      return {
        ...view,
        project: view.project !== null ? display(view.project) : null,
        nodes: view.nodes.map(showNode),
        links: showLinks(view.links, view.nodes),
        outside: view.outside.map(showNode),
        outsideLinks: showLinks(view.outsideLinks, view.outside),
      };
    })
  );

  router.get(
    '/search',
    handle('File search', (req) => {
      const map = groupMap(str(req, 'group'));
      return {
        files: searchFiles(map, str(req, 'q') ?? '').map((f) => ({
          ...f,
          project: display(f.project),
        })),
      };
    })
  );

  router.get(
    '/module',
    handle('Module view', (req) => {
      const map = groupMap(str(req, 'group'));
      const view = moduleView(map, Number(str(req, 'module')));
      if (!view) throw new HttpError(404, `No module ${str(req, 'module') ?? ''} in this map.`);
      return { ...view, project: display(view.project) };
    })
  );

  router.get(
    '/file',
    handle('File view', (req) => {
      const map = groupMap(str(req, 'group'));
      const project = str(req, 'project');
      const file = str(req, 'file');
      if (project === undefined || file === undefined) {
        throw new HttpError(400, 'project and file are required');
      }
      const view = fileView(map, options.indexer.storedProjectName(project), file);
      if (!view) throw new HttpError(404, `No file ${file} in this map.`);
      const show = (l: { project: string; file: string; weight: number }) => ({
        ...l,
        project: display(l.project),
      });
      return {
        ...view,
        project: display(view.project),
        calls: view.calls.map(show),
        calledBy: view.calledBy.map(show),
      };
    })
  );

  router.get('/', async (req: Request, res: Response) => {
    const groups = options.getGroupNames();
    const group = str(req, 'group') ?? groups[0] ?? null;
    const project = str(req, 'project') ?? null;
    const body: ModuleMapResponse = { groups, group, projects: [], project, map: null };
    try {
      if (group === null) {
        if (!options.moduleMaps) groupMap(undefined);
        res.json(body);
        return;
      }
      const map = groupMap(group);
      body.projects = (await options.indexer.listProjectsInGroup(group).catch(() => []))
        .map((p) => p.name)
        .filter((name) => options.scope.allowsProject(name))
        .sort();
      // A project out of scope maps as empty: its edges are filtered out anyway.
      const stored = project !== null ? options.indexer.storedProjectName(project) : null;
      const fileOf = (key: string) => key.slice(key.indexOf('//') + 2);
      const projectOf = (key: string) => key.slice(0, key.indexOf('//'));
      const round = (links: Array<{ module: number; weight: number }>) =>
        strongLinks(links).map((l) => ({
          module: l.module,
          weight: Math.round(l.weight * 100) / 100,
        }));
      body.map = {
        modules: map.modules
          .filter((m) => stored === null || m.project === stored)
          .map((m) => ({
            id: m.id,
            name: m.name,
            project: display(m.project),
            fileCount: m.files.length,
            files: m.files.slice(0, FILES_PER_MODULE).map(fileOf),
            testCount: m.tests.length,
            tests: m.tests.slice(0, TESTS_PER_MODULE).map(fileOf),
            uses: round(m.uses),
            usedBy: round(m.usedBy),
          })),
        shared: map.shared
          .filter((s) => stored === null || projectOf(s.file) === stored)
          .slice(0, 30)
          .map((s) => ({
            project: display(projectOf(s.file)),
            file: fileOf(s.file),
            callers: s.callers,
          })),
        migrations: map.migrations,
      };
      res.json(body);
    } catch (err) {
      if (err instanceof HttpError) res.status(err.status).json({ ...body, error: err.message });
      else res.status(500).json({ ...body, error: `Module map failed: ${(err as Error).message}` });
    }
  });

  return router;
}
