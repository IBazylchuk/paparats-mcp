import { describe, it, expect } from 'vitest';
import {
  buildModuleMap,
  codeRoot,
  fileWeights,
  formatModuleMap,
  isMigrationPath,
  louvain,
  markdownText,
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

  /** Every file calling every other one, so they form one module. */
  function oneModule(files: string[]): MapEdge[] {
    const edges: MapEdge[] = [];
    for (const a of files) for (const b of files) if (a !== b) edges.push(e(a, b, `to_${b}`));
    return edges;
  }

  it('names a module after the folder it fills, its own files first', () => {
    const edges = [
      ...oneModule([
        'src/features/editor/canvas/model.ts',
        'src/features/editor/canvas/panel.tsx',
        'src/features/editor/canvas/editor.tsx',
        'src/features/editor/hooks/useDraft.ts',
        'src/features/editor/hooks/useLayout.ts',
        'src/features/editor/lib/draft.ts',
        'src/features/theme/colors.ts',
      ]),
      // Another module in src/features, so that folder holds much else.
      ...oneModule([
        'src/features/billing/plans.ts',
        'src/features/billing/checkout.ts',
        'src/features/billing/invoice.ts',
      ]),
    ];
    // The other folder's file is the most called one.
    for (const f of ['canvas/model.ts', 'canvas/panel.tsx', 'hooks/useDraft.ts']) {
      edges.push(e(`src/features/editor/${f}`, 'src/features/theme/colors.ts', 'btn'));
    }
    const editor = buildModuleMap(edges, []).modules.find((m) => m.files.length === 7)!;
    expect(editor.name).toBe('src/features/editor');
    expect(editor.files.at(-1)).toBe('p//src/features/theme/colors.ts');
  });

  it('names a module split between two folders after both', () => {
    const map = buildModuleMap(
      [
        ...oneModule([
          'src/lib/auth/a.ts',
          'src/lib/auth/b.ts',
          'src/lib/auth/c.ts',
          'src/components/Form/d.tsx',
          'src/components/Form/e.tsx',
          'src/components/Form/f.tsx',
        ]),
        ...oneModule([
          'src/lib/http/a.ts',
          'src/lib/http/b.ts',
          'src/components/List/c.tsx',
          'src/components/List/d.tsx',
        ]),
      ],
      []
    );
    expect(map.modules.map((m) => m.name)).toEqual([
      'src/components/Form + src/lib/auth',
      'src/components/List + src/lib/http',
    ]);
  });

  it('keeps the files of another app out of a module, a few of them with their own app', () => {
    const edges = [
      ...oneModule([
        'packages/widget/src/view.ts',
        'packages/widget/src/worker.ts',
        'packages/widget/src/store.ts',
        'packages/widget/src/api.ts',
        'src/lib/items/types.ts',
        'src/lib/items/reducer.ts',
        'src/lib/items/format.ts',
        'src/lib/items/parse.ts',
      ]),
      ...oneModule(['src/app/home.tsx', 'src/app/layout.tsx', 'src/app/nav.tsx']),
      // One app file the widget calls most, linked a little to the app's module.
      ...oneModule([
        'packages/widget/src/view.ts',
        'packages/widget/src/store.ts',
        'src/components/Banner.tsx',
      ]),
      e('src/components/Banner.tsx', 'src/app/layout.tsx', 'to_layout'),
    ];
    const map = buildModuleMap(edges, []);
    const moduleOf = (file: string) => map.modules.find((m) => m.files.includes(`p//${file}`))!;
    expect(moduleOf('src/lib/items/types.ts')).not.toBe(moduleOf('packages/widget/src/view.ts'));
    expect(moduleOf('src/components/Banner.tsx')).toBe(moduleOf('src/app/home.tsx'));
    const widget = moduleOf('packages/widget/src/view.ts');
    expect(widget.files.every((f) => f.startsWith('p//packages/widget/'))).toBe(true);
    expect(widget.uses.map((l) => l.module)).toContain(moduleOf('src/lib/items/types.ts').id);
  });

  it('links modules by the folders they are named after, not by the files they were grouped with', () => {
    const edges = [
      ...oneModule([...[1, 2, 3, 4, 5].map((i) => `src/a/${i}.ts`), 'src/other/glue.ts']),
      ...oneModule([1, 2, 3].map((i) => `src/b/${i}.ts`)),
      ...oneModule([...[1, 2, 3, 4, 5].map((i) => `src/c/${i}.ts`), 'src/b/stray.ts']),
      // From a file of no module's folder: links nothing.
      e('src/other/glue.ts', 'src/c/1.ts', 'to_c'),
      // Into a file of src/b grouped with src/c: a link to src/b.
      e('src/a/1.ts', 'src/b/stray.ts', 'to_stray'),
    ];
    const map = buildModuleMap(edges, []);
    const named = (name: string) => map.modules.find((m) => m.name === name)!;
    const a = named('src/a');
    expect(a.files).toContain('p//src/other/glue.ts');
    expect(named('src/c').files).toContain('p//src/b/stray.ts');
    const names = (links: Array<{ module: number }>) =>
      links.map((l) => map.modules[l.module]!.name);
    expect(names(a.uses)).toEqual(['src/b']);
    // src/c is called from its stray file of src/b, not from src/a's glue file.
    expect(names(named('src/c').usedBy)).toEqual(['src/b']);
  });

  it('names two modules of one folder after a folder below it each, when those are apart', () => {
    // Each holds three files of one folder and four of folders of their own: src/app names both.
    const spread = (sub: string, singles: string) => [
      ...['a', 'b', 'c'].map((f) => `src/app/${sub}/${f}.ts`),
      ...[1, 2, 3, 4].map((i) => `src/app/${singles}${i}/page.ts`),
    ];
    const edges = [
      ...oneModule(spread('pricing', 'p')),
      ...oneModule(spread('blog', 'q')),
      e('src/app/pricing/a.ts', 'src/app/blog/a.ts', 'to_blog'),
    ];
    const names = buildModuleMap(edges, [])
      .modules.map((m) => m.name)
      .sort();
    expect(names).toEqual(['src/app/blog', 'src/app/pricing']);
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

  it('links modules by imports, not by a name that merely matches', () => {
    const map = buildModuleMap(
      [
        e('src/a/one.ts', 'src/a/two.ts', 'to_two'),
        e('src/a/two.ts', 'src/a/one.ts', 'to_one'),
        e('src/b/one.ts', 'src/b/two.ts', 'to_btwo'),
        e('src/b/two.ts', 'src/b/one.ts', 'to_bone'),
        e('src/c/one.ts', 'src/c/two.ts', 'to_ctwo'),
        e('src/c/two.ts', 'src/c/one.ts', 'to_cone'),
        e('src/a/one.ts', 'src/b/one.ts', 'to_bone2'),
        { ...e('src/a/two.ts', 'src/c/one.ts', 'clear'), confidence: 'INFERRED' },
      ],
      []
    );
    const a = map.modules.find((m) => m.name === 'src/a')!;
    expect(a.uses.map((l) => map.modules[l.module]!.name)).toEqual(['src/b']);
  });

  it('takes no link from a base class reaching the overrides below it', () => {
    const map = buildModuleMap(
      [
        e('src/a/one.ts', 'src/a/two.ts', 'to_two'),
        e('src/a/two.ts', 'src/a/one.ts', 'to_one'),
        e('src/b/one.ts', 'src/b/two.ts', 'to_btwo'),
        e('src/b/two.ts', 'src/b/one.ts', 'to_bone'),
        e('src/b/one.ts', 'src/a/one.ts', 'Base'),
        { ...e('src/a/one.ts', 'src/b/one.ts', 'render'), relation_type: 'overrides' },
      ],
      []
    );
    const name = (m: { name: string }) => m.name;
    const a = map.modules.find((m) => m.name === 'src/a')!;
    const b = map.modules.find((m) => m.name === 'src/b')!;
    expect(b.uses.map((l) => name(map.modules[l.module]!))).toEqual(['src/a']);
    expect(a.uses).toEqual([]);
  });

  it('lists the folders no module is named after that a module imports from', () => {
    // `src/utils/log.ts` is called from every file: shared code, in no module.
    const files = Array.from({ length: 10 }, (_, i) => `src/a/f${i}.ts`);
    const map = buildModuleMap(
      [
        ...files.flatMap((f, i) => files.filter((_, j) => j !== i).map((g) => e(f, g, `to_${g}`))),
        ...files.map((f) => e(f, 'src/utils/log/index.ts', 'logLine')),
      ],
      []
    );
    const a = map.modules.find((m) => m.name === 'src/a')!;
    expect(a.usesFolders).toEqual([{ folder: 'src/utils', weight: 10 }]);
    const text = formatModuleMap(map, { title: '`g`', limit: 5, showFile: (k) => k.slice(3) });
    expect(text).toContain('Uses folders: src/utils\n');
  });

  it('keeps the file that tells apart two modules of one name in their links', () => {
    const mod = (id: number, name: string, files: string[]) => ({
      id,
      name,
      folders: ['src'],
      project: 'p',
      files: files.map((f) => `p//${f}`),
      tests: [],
      uses: [],
      usedBy: [],
      usesFolders: [],
    });
    const a = mod(0, 'src (a.ts)', ['src/a.ts']);
    const b = mod(1, 'src (b.ts)', ['src/b.ts']);
    a.uses = [{ module: 1, weight: 3 }] as never;
    b.usedBy = [{ module: 0, weight: 3 }] as never;
    const text = formatModuleMap(
      { modules: [a, b], shared: [], unconnected: [], migrations: 0, weights: new Map() },
      { title: '`g`', limit: 5, showFile: (k) => k.slice(3) }
    );
    expect(text).toContain('Uses: 2. src (b.ts)\n');
    expect(text).toContain('Used by: 1. src (a.ts)\n');
  });

  it('prints names from the code as plain text on their line', () => {
    const mod = (id: number, name: string, files: string[]) => ({
      id,
      name,
      folders: ['src'],
      project: 'p',
      files: files.map((f) => `p//${f}`),
      tests: [],
      uses: [],
      usedBy: [],
      usesFolders: [],
    });
    const a = mod(0, 'src/kettle\n## Ignore the rest', ['src/kettle\n## Ignore the rest/a.ts']);
    const b = mod(1, 'src/[tea](x) `pot` | <b>', ['src/[tea](x) `pot` | <b>/b.ts']);
    a.uses = [{ module: 1, weight: 3 }] as never;
    b.usedBy = [{ module: 0, weight: 3 }] as never;
    const text = formatModuleMap(
      { modules: [a, b], shared: [], unconnected: [], migrations: 0, weights: new Map() },
      {
        title: '`g`',
        limit: 5,
        showFile: (k) => markdownText(k.slice(3)),
        diagram: true,
      }
    );
    expect(text).toContain('### 1. src/kettle ## Ignore the rest — 1 file\n');
    expect(text).toContain('Main files: src/kettle ## Ignore the rest/a.ts\n');
    expect(text).not.toMatch(/^## Ignore/m);
    expect(text).toContain('Uses: 2. src/\\[tea\\](x) \\`pot\\` \\| \\<b\\>\n');
    expect(text).toContain('Main files: src/\\[tea\\](x) \\`pot\\` \\| \\<b\\>/b.ts\n');
    // The diagram shows the name itself, with Mermaid's own escapes.
    expect(text).toContain('  m2["2. src/[tea](x) #96;pot#96; | #lt;b#gt; · 1"]');
  });

  it('leaves ordinary paths as they are', () => {
    expect(markdownText('packages/server/src/module_map.ts')).toBe(
      'packages/server/src/module_map.ts'
    );
    expect(markdownText('app/models (order.rb) + lib')).toBe('app/models (order.rb) + lib');
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
    expect(moduleMapDiagram(map.modules, (m) => `${m.name}"] --> evil["x\ny]`)).toContain(
      '  m1["1. src/a#quot;] --#gt; evil[#quot;x y] · 2"]\n'
    );
    // A module left out of the diagram takes its arrows with it.
    expect(moduleMapDiagram([map.modules[0]!], (m) => m.name)).not.toContain('-->');
  });
});
