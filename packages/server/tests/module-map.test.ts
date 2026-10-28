import { describe, it, expect } from 'vitest';
import {
  buildModuleMap,
  codeRoot,
  fileWeights,
  formatModuleMap,
  isMigrationPath,
  louvain,
  mergeModuleMaps,
  ModuleMapService,
  moduleMapDiagram,
  splitLarge,
  type MapEdge,
} from '../src/module-map.js';

const e = (from: string, to: string, symbol: string, project = 'p'): MapEdge => ({
  from_chunk_id: `g//${project}//${from}//0-5//h`,
  to_chunk_id: `g//${project}//${to}//0-5//h`,
  symbol_name: symbol,
});

/** Undirected adjacency for `n` nodes from pairs. */
function adjacency(n: number, pairs: Array<[number, number]>): Array<Map<number, number>> {
  const adj = Array.from({ length: n }, () => new Map<number, number>());
  for (const [a, b] of pairs) {
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + 1);
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + 1);
  }
  return adj;
}

/** Every pair inside `nodes`. */
const clique = (nodes: number[]): Array<[number, number]> =>
  nodes.flatMap((a, i) => nodes.slice(i + 1).map((b): [number, number] => [a, b]));

describe('louvain', () => {
  it('separates two cliques joined by one edge', () => {
    const adj = adjacency(8, [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), [3, 4]]);
    const c = louvain(adj);
    expect(new Set(c.slice(0, 4)).size).toBe(1);
    expect(new Set(c.slice(4)).size).toBe(1);
    expect(c[0]).not.toBe(c[4]);
  });

  it('is deterministic', () => {
    const adj = adjacency(8, [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), [3, 4]]);
    expect(louvain(adj)).toEqual(louvain(adj));
  });

  it('leaves isolated nodes alone', () => {
    expect(louvain(adjacency(3, []))).toEqual([0, 1, 2]);
  });
});

describe('splitLarge', () => {
  it('splits a community bigger than the limit along its own structure', () => {
    const adj = adjacency(8, [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), [3, 4]]);
    const out = splitLarge(adj, new Array(8).fill(0), 5);
    expect(new Set(out).size).toBe(2);
    expect(out[0]).toBe(out[3]);
    expect(out[0]).not.toBe(out[4]);
  });

  it('keeps a community within the limit whole', () => {
    const adj = adjacency(8, [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), [3, 4]]);
    expect(new Set(splitLarge(adj, new Array(8).fill(0), 8)).size).toBe(1);
  });
});

describe('fileWeights', () => {
  it('splits one use over its definitions and drops uses inside a file', () => {
    const w = fileWeights([
      e('a.ts', 'b.ts', 'run'),
      e('a.ts', 'c.ts', 'run'),
      e('a.ts', 'a.ts', 'x'),
    ]).weights;
    expect(w.get('p//a.ts')?.get('p//b.ts')).toBe(0.5);
    expect(w.get('p//a.ts')?.get('p//c.ts')).toBe(0.5);
    expect(w.get('p//a.ts')?.has('p//a.ts')).toBe(false);
  });

  it('weighs a name used from every file far below a name used from one', () => {
    const edges: MapEdge[] = [];
    for (let i = 0; i < 20; i++) edges.push(e(`f${i}.ts`, 'store.ts', 'get'));
    edges.push(e('f0.ts', 'queue.ts', 'enqueueJob'));
    const w = fileWeights(edges).weights;
    expect(w.get('p//f0.ts')?.get('p//store.ts') ?? 0).toBe(0);
    expect(w.get('p//f0.ts')?.get('p//queue.ts')).toBe(1);
  });

  it('judges how specific a name is within the caller’s own project', () => {
    const edges: MapEdge[] = [];
    // `runTask` is used from every file of project q...
    for (let i = 0; i < 20; i++) edges.push(e(`q${i}.ts`, 'tasks.ts', 'runTask', 'q'));
    // ...and from one file of project p, where it says a lot.
    edges.push(e('a.ts', 'tasks.ts', 'runTask'), e('b.ts', 'other.ts', 'otherCall'));
    const w = fileWeights(edges).weights;
    expect(w.get('p//a.ts')?.get('p//tasks.ts')).toBeCloseTo(Math.log(2) / Math.log(2));
    expect(w.get('q//q0.ts')?.get('q//tasks.ts') ?? 0).toBe(0);
  });
});

describe('isMigrationPath', () => {
  it('recognises migration folders', () => {
    expect(isMigrationPath('db/migrate/20240101_add_users.rb')).toBe(true);
    expect(isMigrationPath('src/migrations/0001.ts')).toBe(true);
    expect(isMigrationPath('src/migration-helper.ts')).toBe(false);
  });
});

describe('buildModuleMap', () => {
  /** Two clusters with names specific enough to keep their full weight. */
  function twoClusters(): MapEdge[] {
    const edges: MapEdge[] = [];
    const pairs = [
      ['src/a/one.ts', 'src/a/two.ts'],
      ['src/a/two.ts', 'src/a/three.ts'],
      ['src/a/three.ts', 'src/a/one.ts'],
      ['src/b/one.ts', 'src/b/two.ts'],
      ['src/b/two.ts', 'src/b/three.ts'],
      ['src/b/three.ts', 'src/b/one.ts'],
    ];
    for (const [x, y] of pairs) {
      edges.push(e(x!, y!, `to_${y}`), e(y!, x!, `to_${x}`));
    }
    edges.push(e('src/a/one.ts', 'src/b/one.ts', 'to_src/b/one.ts'));
    return edges;
  }

  it('sets each project’s thresholds by its own size, next to a much larger one', () => {
    const edges: MapEdge[] = [];
    // Small project p: twelve files calling one hub file.
    for (let i = 0; i < 12; i++) edges.push(e(`src/f${i}.ts`, 'src/hub.ts', `hubCall${i}`));
    // Large project q: two thousand files in pairs.
    for (let i = 0; i < 1000; i++) {
      edges.push(e(`x${i}.ts`, `y${i}.ts`, `pairCall${i}`, 'q'));
    }
    const map = buildModuleMap(edges, []);
    expect(map.shared.map((s) => s.file)).toEqual(['p//src/hub.ts']);
    expect(new Set(map.modules.map((m) => m.project))).toEqual(new Set(['q']));
  });

  it('groups files, names modules by folder and links them by direction', () => {
    const map = buildModuleMap(twoClusters(), []);
    expect(map.modules.map((m) => [m.name, m.files.length])).toEqual([
      ['src/a', 3],
      ['src/b', 3],
    ]);
    expect(map.modules[0]!.uses.map((l) => l.module)).toEqual([1]);
    expect(map.modules[1]!.usedBy.map((l) => l.module)).toEqual([0]);
    expect(map.modules[1]!.uses).toEqual([]);
  });

  it('attaches tests to the module they call most and leaves migrations out', () => {
    const map = buildModuleMap(
      [
        ...twoClusters(),
        e('tests/b.test.ts', 'src/b/two.ts', 'to_src/b/two.ts'),
        e('db/migrate/001_init.rb', 'src/a/one.ts', 'to_src/a/one.ts'),
      ],
      ['p//db/migrate/002_more.rb']
    );
    expect(map.modules[1]!.tests).toEqual(['p//tests/b.test.ts']);
    expect(map.migrations).toBe(2);
    expect(map.modules.flatMap((m) => m.files).some((f) => f.includes('migrate'))).toBe(false);
  });

  it('lists a file called from most of the code as shared, outside every module', () => {
    const edges = twoClusters();
    for (let i = 0; i < 12; i++) {
      const caller = `src/c/caller${i}.ts`;
      edges.push(e(caller, 'src/lib/log.ts', 'logLine'));
    }
    const map = buildModuleMap(edges, []);
    expect(map.shared.map((s) => [s.file, s.callers])).toEqual([['p//src/lib/log.ts', 12]]);
    expect(map.modules.flatMap((m) => m.files)).not.toContain('p//src/lib/log.ts');
  });

  it('tells apart two modules in the same folder by their most called file', () => {
    const edges: MapEdge[] = [];
    for (const g of ['x', 'y']) {
      const files = [`src/${g}1.ts`, `src/${g}2.ts`, `src/${g}3.ts`];
      for (const a of files) for (const b of files) if (a !== b) edges.push(e(a, b, `to_${b}`));
    }
    edges.push(e('src/x1.ts', 'src/y1.ts', 'to_src/y1.ts'));
    const names = buildModuleMap(edges, []).modules.map((m) => m.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((n) => n.startsWith('src ('))).toBe(true);
  });
});

describe('mergeModuleMaps', () => {
  it('builds the same map from per-project maps as from all edges at once', () => {
    const edges: MapEdge[] = [];
    for (const project of ['p', 'q']) {
      for (const dir of ['a', 'b']) {
        const files = [1, 2, 3].map((i) => `src/${dir}/${project}${i}.ts`);
        for (const x of files)
          for (const y of files) if (x !== y) edges.push(e(x, y, `to_${y}`, project));
      }
      edges.push(e(`src/a/${project}1.ts`, `src/b/${project}1.ts`, `cross_${project}`, project));
    }
    edges.push(...[1, 2, 3, 4].map((i) => e(`src/q/x${i}.ts`, 'src/q/x0.ts', `x${i}`, 'q')));
    const byProject = ['p', 'q'].map((p) =>
      buildModuleMap(
        edges.filter((x) => x.from_chunk_id.startsWith(`g//${p}//`)),
        []
      )
    );

    const merged = mergeModuleMaps(byProject);
    const whole = buildModuleMap(edges, []);
    expect(merged.modules).toEqual(whole.modules);
    expect(merged.shared).toEqual(whole.shared);
    expect(merged.unconnected).toEqual(whole.unconnected);
    expect(merged.weights).toEqual(whole.weights);
  });
});

describe('ModuleMapService', () => {
  it('maps again only the projects whose edges changed', () => {
    const edges = [e('a.ts', 'b.ts', 'toB', 'p'), e('c.ts', 'd.ts', 'toD', 'q')];
    const versions: Record<string, string> = { p: '1', q: '1' };
    const reads: string[] = [];
    let now = 0;
    const service = new ModuleMapService(
      {
        edgesVersion: (_group: string, project?: string) => versions[project!]!,
        edgeProjects: () => ['p', 'q'],
        iterateProjectEdges: (_group: string, project: string) => {
          reads.push(project);
          return edges.filter((x) => x.from_chunk_id.startsWith(`g//${project}//`)) as never;
        },
      },
      () => now
    );

    const first = service.get('g', undefined, () => true);
    expect(first.modules).toHaveLength(2);
    expect(service.get('g', undefined, () => true)).toBe(first);
    expect(reads).toEqual(['p', 'q']);

    versions.q = '2';
    now += 10 * 60 * 1000;
    const second = service.get('g', undefined, () => true);
    expect(reads).toEqual(['p', 'q', 'q']);
    expect(second).not.toBe(first);
  });
  it('leaves re-exports out, so a barrel file does not tie the modules together', () => {
    const edges = [
      e('a.ts', 'b.ts', 'toB'),
      { ...e('lib.ts', 'a.ts', 'toA'), relation_type: 'reexports' },
      { ...e('lib.ts', 'b.ts', 'toB'), relation_type: 'reexports' },
    ];
    const service = new ModuleMapService({
      edgesVersion: () => '1',
      edgeProjects: () => ['p'],
      iterateProjectEdges: () => edges as never,
    });
    const map = JSON.stringify(service.get('g', undefined, () => true));
    expect(map).toContain('a.ts');
    expect(map).not.toContain('lib.ts');
  });
});

describe('codeRoot', () => {
  it('is the top folder, or the package under a folder of packages', () => {
    expect(codeRoot('src/lib/dates.ts')).toBe('src');
    expect(codeRoot('packages/server/src/indexer.ts')).toBe('packages/server');
    expect(codeRoot('apps/web/page.tsx')).toBe('apps/web');
    expect(codeRoot('packages/README.md')).toBe('packages');
    expect(codeRoot('index.ts')).toBe('index.ts');
  });
});

describe('formatModuleMap', () => {
  it('shows modules with main files and links, and summarises the rest', () => {
    const map = buildModuleMap(
      [
        e('src/a/one.ts', 'src/a/two.ts', 'to_two'),
        e('src/a/two.ts', 'src/a/one.ts', 'to_one'),
        e('src/b/one.ts', 'src/b/two.ts', 'to_btwo'),
        e('src/b/two.ts', 'src/b/one.ts', 'to_bone'),
        e('src/a/one.ts', 'src/b/one.ts', 'to_bone2'),
      ],
      []
    );
    const text = formatModuleMap(map, {
      title: '`g`',
      limit: 1,
      showFile: (k) => k.slice(3),
    });
    expect(text).toContain('## Module map of `g`');
    expect(text).toContain('2 modules over 4 files.');
    expect(text).toContain('### 1. src/a — 2 files');
    expect(text).toContain('Uses: 2. src/b');
    expect(text).toContain(
      '_1 smaller module (2 files) not shown: src/b. Raise `limit` to see them._'
    );
  });

  it('names the file a used module is reached through when it is in another package or app', () => {
    const built = buildModuleMap(
      [
        e('src/a/one.ts', 'src/a/two.ts', 'to_two'),
        e('src/a/two.ts', 'src/a/one.ts', 'to_one'),
        e('src/b/one.ts', 'src/b/two.ts', 'to_btwo'),
        e('src/b/two.ts', 'src/b/one.ts', 'to_bone'),
        e('src/a/one.ts', 'src/b/one.ts', 'to_bone2'),
      ],
      []
    );
    expect(built.modules[0]!.uses).toEqual([
      expect.objectContaining({ module: 1, via: 'p//src/b/one.ts' }),
    ]);
    expect(built.modules[1]!.usedBy).toEqual([
      expect.objectContaining({ module: 0, via: 'p//src/a/one.ts' }),
    ]);

    // The `ext/b` module also holds a file of src/, and src/a reaches it through that one.
    const mod = (id: number, name: string, files: string[]) => ({
      id,
      name,
      project: 'p',
      files: files.map((f) => `p//${f}`),
      tests: [],
      uses: [],
      usedBy: [],
    });
    const a = mod(0, 'src/a', ['src/a/one.ts', 'src/a/two.ts']);
    const b = mod(1, 'ext/b', ['src/lib/shared.ts', 'ext/b/one.ts', 'ext/b/two.ts']);
    a.uses = [{ module: 1, weight: 3, via: 'p//src/lib/shared.ts' }] as never;
    b.usedBy = [{ module: 0, weight: 3, via: 'p//src/a/one.ts' }] as never;
    b.uses = [{ module: 0, weight: 2, via: 'p//src/a/two.ts' }] as never;
    const text = formatModuleMap(
      { modules: [a, b], shared: [], unconnected: [], migrations: 0, weights: new Map() },
      { title: '`g`', limit: 5, showFile: (k) => k.slice(3) }
    );
    expect(text).toContain('Uses: 2. ext/b (src/lib/shared.ts)\n');
    // Within the package the module is named after, and never for `Used by`: nothing to add.
    expect(text).toContain('Used by: 1. src/a\n');
    expect(text).toContain('Uses: 1. src/a\n');
  });

  it('says so when there is nothing to map', () => {
    const text = formatModuleMap(buildModuleMap([], []), {
      title: '`g`',
      limit: 5,
      showFile: (k) => k,
    });
    expect(text).toContain('No modules');
  });
});

describe('moduleMapDiagram', () => {
  it('draws the given modules and the strong links between them, labels escaped', () => {
    const map = buildModuleMap(
      [
        e('src/a/one.ts', 'src/a/two.ts', 'to_two'),
        e('src/a/two.ts', 'src/a/one.ts', 'to_one'),
        e('src/b/one.ts', 'src/b/two.ts', 'to_btwo'),
        e('src/b/two.ts', 'src/b/one.ts', 'to_bone'),
        e('src/a/one.ts', 'src/b/one.ts', 'to_bone2'),
      ],
      []
    );
    const text = moduleMapDiagram(map.modules, (m) => `<${m.name}> "x"`);
    expect(text).toContain('```mermaid\nflowchart LR\n');
    expect(text).toContain('  m1["1. #lt;src/a#gt; #quot;x#quot; · 2"]');
    expect(text).toContain('  m1 --> m2');
    expect(text).not.toContain('m2 --> m1');
    // A module left out of the diagram takes its arrows with it.
    expect(moduleMapDiagram([map.modules[0]!], (m) => m.name)).not.toContain('-->');
  });
});
