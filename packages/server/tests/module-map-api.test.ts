import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { buildModuleMapRouter, type ModuleMapResponse } from '../src/module-map-api.js';
import type { FileView, FolderView, ModuleView } from '../src/map-explorer.js';
import { ModuleMapService, type MapEdge } from '../src/module-map.js';
import type { ProjectScopeGuard } from '../src/mcp-handler.js';

const edge = (project: string, from: string, to: string, symbol: string): MapEdge => ({
  from_chunk_id: `g1//${project}//${from}//0-5//h`,
  to_chunk_id: `g1//${project}//${to}//0-5//h`,
  symbol_name: symbol,
});

/** Two three-file clusters per project, `src/a` using `src/b`. */
function edges(project: string): MapEdge[] {
  const out: MapEdge[] = [];
  for (const dir of ['a', 'b']) {
    const files = [1, 2, 3].map((n) => `src/${dir}/${dir}${n}.ts`);
    for (const x of files)
      for (const y of files) if (x !== y) out.push(edge(project, x, y, `to_${y}`));
  }
  out.push(edge(project, 'src/a/a1.ts', 'src/b/b1.ts', 'crossOne'));
  out.push(edge(project, 'src/a/a2.ts', 'src/b/b2.ts', 'crossTwo'));
  out.push(edge(project, 'tests/a.test.ts', 'src/a/a1.ts', 'aOneForTests'));
  return out;
}

const unscoped: ProjectScopeGuard = {
  projects: null,
  allowsProject: () => true,
  allowsChunk: () => true,
};

async function get<T = ModuleMapResponse>(
  options: Parameters<typeof buildModuleMapRouter>[0],
  query = '',
  route = ''
): Promise<{ status: number; body: T & { error?: string } }> {
  const app = express();
  app.use('/api/module-map', buildModuleMapRouter(options));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/module-map${route}${query}`);
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  } finally {
    server.close();
  }
}

function options(all: MapEdge[], scope = unscoped, projects = ['billing']) {
  const store = {
    edgesVersion: vi.fn().mockReturnValue('0:0'),
    edgeProjects: vi.fn(() => [...new Set(all.map((e) => e.from_chunk_id.split('//')[1]!))]),
    iterateProjectEdges: vi.fn((group: string, project: string) =>
      all.filter((e) => e.from_chunk_id.startsWith(`${group}//${project}//`))
    ),
  };
  return {
    moduleMaps: new ModuleMapService(store),
    indexer: {
      storedProjectName: (n: string) => n,
      displayProjectName: (n: string) => n,
      listProjectsInGroup: vi
        .fn()
        .mockResolvedValue(projects.map((name) => ({ name, chunks: 1, languages: [] }))),
    },
    getGroupNames: () => ['g1'],
    scope,
  };
}

describe('GET /api/module-map', () => {
  it('returns the first group’s modules, their files, tests and strong links', async () => {
    const { status, body } = await get(options(edges('billing')));
    expect(status).toBe(200);
    expect(body.group).toBe('g1');
    expect(body.projects).toEqual(['billing']);
    const [a, b] = body.map!.modules;
    expect(a).toMatchObject({ name: 'src/a', fileCount: 3, testCount: 1, project: 'billing' });
    expect(a!.files).toContain('src/a/a1.ts');
    expect(a!.tests).toEqual(['tests/a.test.ts']);
    expect(a!.uses.map((l) => l.module)).toEqual([b!.id]);
    expect(b!.usedBy.map((l) => l.module)).toEqual([a!.id]);
  });

  it('keeps each module in its project, and filters by project without renumbering', async () => {
    const opts = options([...edges('billing'), ...edges('ledger')], unscoped, [
      'billing',
      'ledger',
    ]);
    const all = await get(opts);
    const ledger = all.body.map!.modules.filter((m) => m.project === 'ledger');
    expect(ledger.map((m) => m.name).sort()).toEqual(['src/a', 'src/b']);
    expect(ledger[0]!.files).toContain(
      `src/${ledger[0]!.name.slice(4)}/${ledger[0]!.name.slice(4)}1.ts`
    );

    const one = await get(opts, '?project=ledger');
    expect(one.body.map!.modules.map((m) => m.id)).toEqual(ledger.map((m) => m.id));
  });

  it('maps one project when asked, and hides out-of-scope projects', async () => {
    const scope: ProjectScopeGuard = {
      projects: ['billing'],
      allowsProject: (p) => p === 'billing',
      allowsChunk: (id) => id.split('//')[1] === 'billing',
    };
    const all = [...edges('billing'), ...edges('handbook')];
    const scoped = await get(options(all, scope, ['billing', 'handbook']));
    expect(scoped.body.projects).toEqual(['billing']);
    expect(JSON.stringify(scoped.body)).not.toContain('handbook');

    const hidden = await get(options(all, scope, ['billing', 'handbook']), '?project=handbook');
    expect(hidden.body.map!.modules).toEqual([]);
  });

  it('rejects an invalid group and reports a missing symbol graph', async () => {
    const bad = await get(options([]), '?group=billing_arch');
    expect(bad.status).toBe(400);
    const none = await get({ ...options([]), moduleMaps: null });
    expect(none.status).toBe(503);
    expect(none.body.error).toContain('Symbol graph is not available');
  });
});

describe('GET /api/module-map/tree, /module, /file, /search', () => {
  const two = () =>
    options([...edges('billing'), ...edges('ledger')], unscoped, ['billing', 'ledger']);

  it('starts a group of several projects at its projects', async () => {
    const { body } = await get<FolderView>(two(), '?group=g1', '/tree');
    expect(body.project).toBeNull();
    expect(body.nodes.map((n) => [n.key, n.kind])).toEqual([
      ['billing', 'project'],
      ['ledger', 'project'],
    ]);
  });

  it('opens a project at its root, skipping a folder that holds only one folder', async () => {
    const { body } = await get<FolderView>(two(), '?group=g1&project=billing', '/tree');
    expect(body.path).toBe('');
    // `src` holds only `a` and `b`: it is shown, with the calls a → b summed up.
    expect(body.nodes.map((n) => n.key).sort()).toEqual(['src', 'tests']);
    const src = await get<FolderView>(two(), '?group=g1&project=billing&path=src', '/tree');
    expect(src.body.nodes.map((n) => n.key).sort()).toEqual(['src/a', 'src/b']);
    expect(src.body.links).toEqual([expect.objectContaining({ from: 'src/a', to: 'src/b' })]);
    expect(src.body.outside.map((n) => n.key)).toEqual(['tests']);
    expect(src.body.modules.map((m) => m.filesHere)).toEqual([3, 3]);
  });

  it('shows one module, one file, and finds files by path', async () => {
    const meta = await get(two(), '?group=g1');
    const a = meta.body.map!.modules.find((m) => m.project === 'billing' && m.name === 'src/a')!;
    const mod = await get<ModuleView>(two(), `?group=g1&module=${a.id}`, '/module');
    expect(mod.body.project).toBe('billing');
    expect(mod.body.nodes.map((n) => n.key).sort()).toEqual([
      'src/a/a1.ts',
      'src/a/a2.ts',
      'src/a/a3.ts',
    ]);
    expect(mod.body.outside.map((n) => n.kind)).toEqual(['module']);

    const file = await get<FileView>(two(), '?group=g1&project=billing&file=src/a/a1.ts', '/file');
    expect(file.body.module).toEqual({ id: a.id, name: 'src/a' });
    expect(file.body.calls.map((c) => c.file)).toContain('src/b/b1.ts');
    expect(file.body.calledBy.map((c) => c.file)).toContain('tests/a.test.ts');

    const missing = await get(two(), '?group=g1&project=billing&file=nope.ts', '/file');
    expect(missing.status).toBe(404);

    const found = await get<{ files: Array<{ project: string; file: string }> }>(
      two(),
      '?group=g1&q=b2',
      '/search'
    );
    expect(found.body.files).toEqual([
      { project: 'billing', file: 'src/b/b2.ts' },
      { project: 'ledger', file: 'src/b/b2.ts' },
    ]);
  });

  it('rejects a missing group', async () => {
    const { status } = await get(two(), '', '/tree');
    expect(status).toBe(400);
  });
});
