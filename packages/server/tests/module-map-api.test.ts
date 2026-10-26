import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { buildModuleMapRouter, type ModuleMapResponse } from '../src/module-map-api.js';
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
  out.push(edge(project, 'tests/a.test.ts', 'src/a/a1.ts', 'to_src/a/a1.ts'));
  return out;
}

const unscoped: ProjectScopeGuard = {
  projects: null,
  allowsProject: () => true,
  allowsChunk: () => true,
};

async function get(
  options: Parameters<typeof buildModuleMapRouter>[0],
  query = ''
): Promise<{ status: number; body: ModuleMapResponse & { error?: string } }> {
  const app = express();
  app.use('/api/module-map', buildModuleMapRouter(options));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/module-map${query}`);
    return { status: res.status, body: (await res.json()) as ModuleMapResponse };
  } finally {
    server.close();
  }
}

function options(all: MapEdge[], scope = unscoped, projects = ['billing']) {
  const store = {
    edgesVersion: vi.fn().mockReturnValue('0:0'),
    iterateGroupEdges: vi.fn().mockImplementation(() => all),
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

  it('prefixes files with their project when the map spans several', async () => {
    const { body } = await get(
      options([...edges('billing'), ...edges('ledger')], unscoped, ['billing', 'ledger'])
    );
    expect(body.map!.modules.flatMap((m) => m.files)).toContain('[ledger] src/a/a1.ts');
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
