import path from 'node:path';
import type { EdgeConfidence, SymbolEdge } from './types.js';
import type { MetadataStore } from './metadata-db.js';
import { isTestPath } from './ranking.js';
import { isCommonName } from './symbol-graph.js';

/** The part of a symbol edge the module map needs. */
export interface MapEdge {
  from_chunk_id: string;
  to_chunk_id: string;
  symbol_name: string;
  confidence?: EdgeConfidence;
}

/** A file as the map knows it: `<project>//<file>`, so equal paths in two projects stay apart. */
export type FileKey = string;

/**
 * A file called from at least this share of the other files is shared code
 * (a logger, a config reader, a base class): it is listed apart and kept out
 * of the grouping, where it would glue unrelated modules together.
 */
export const SHARED_FILE_CALLER_SHARE = 0.15;
/** ...and from at least this many files, so a small repository keeps its hubs in modules. */
export const SHARED_FILE_MIN_CALLERS = 10;

/**
 * A module bigger than this share of the mapped files is split again on its
 * own: on a large graph one pass merges whole layers (all models, all API
 * types) into a few modules of a thousand files.
 */
export const MAX_MODULE_SHARE = 0.08;
/** ...but a module this small is never split further. */
export const MIN_SPLIT_FILES = 30;

/**
 * Schema migrations: hundreds of files, each touching the models of its day,
 * that would otherwise be glued onto the models and name half the modules.
 * Left out of the map, like vendored code.
 */
const MIGRATION_PATH_RE = /(^|\/)(db\/migrate|migrations?)\//i;

export function isMigrationPath(file: string): boolean {
  return MIGRATION_PATH_RE.test(file);
}

export interface ModuleLink {
  module: number;
  /** Summed edge weight in that direction. */
  weight: number;
}

export interface CodeModule {
  id: number;
  name: string;
  project: string;
  /** Non-test files, the most called first. */
  files: string[];
  /** Test files whose calls land mostly in this module. */
  tests: string[];
  /** Modules this one calls, heaviest first. */
  uses: ModuleLink[];
  /** Modules that call this one, heaviest first. */
  usedBy: ModuleLink[];
}

export interface ModuleMap {
  modules: CodeModule[];
  /** Shared files, the most called first, with the number of files calling each. */
  shared: Array<{ file: FileKey; callers: number }>;
  /** Non-test files with no edge to any other file. */
  unconnected: FileKey[];
  /** Migration files left out of the map. */
  migrations: number;
  /** The file-to-file weights the map was built from, to show the files inside a module. */
  weights: Map<FileKey, Map<FileKey, number>>;
}

function fileKeyOf(chunkId: string): FileKey | null {
  const parts = chunkId.split('//');
  if (parts.length < 3 || !parts[1] || !parts[2]) return null;
  return `${parts[1]}//${parts[2]}`;
}

function splitKey(key: FileKey): { project: string; file: string } {
  const i = key.indexOf('//');
  return { project: key.slice(0, i), file: key.slice(i + 2) };
}

/**
 * Directed file-to-file weights. Every symbol use counts 1, split evenly over
 * its definitions: a call to a name defined in four chunks adds 0.25 to each of
 * the four links, because the graph links by name and only one of them is real.
 *
 * Then each use is scaled by how specific its name is. The graph cannot tell
 * `cache.get(k)` from a call to some class's own `get`, so a name used across
 * half the files says almost nothing about which file depends on which, while
 * a name used by two files says a lot: the factor is ln(F / f) / ln(F), where
 * f is the number of files using the name and F the number of files using any,
 * both counted within the caller's project.
 * Uses inside one file do not link files and are dropped.
 */
export interface FileGraph {
  /** Directed link weights, caller file → called file. */
  weights: Map<FileKey, Map<FileKey, number>>;
  /**
   * Per called file, the files that clearly call it: through a name defined in
   * at most two chunks that is not a common one (`isCommonName`). Counted
   * unscaled, so a logger every file calls is still seen as called by all.
   */
  callers: Map<FileKey, Set<FileKey>>;
}

export function fileWeights(edges: Iterable<MapEdge>): FileGraph {
  // Definitions per (caller chunk, symbol), to split one use over its candidates.
  const uses = new Map<string, MapEdge[]>();
  // Name usage per project: a name common in one repository of a group says
  // nothing about how specific it is in another.
  const usersOf = new Map<string, Map<string, Set<FileKey>>>();
  const callers = new Map<string, Set<FileKey>>();
  for (const e of edges) {
    const key = `${e.from_chunk_id}\0${e.symbol_name}`;
    let list = uses.get(key);
    if (!list) uses.set(key, (list = []));
    list.push(e);
    const from = fileKeyOf(e.from_chunk_id);
    if (!from) continue;
    const project = splitKey(from).project;
    let projectCallers = callers.get(project);
    if (!projectCallers) callers.set(project, (projectCallers = new Set()));
    projectCallers.add(from);
    let names = usersOf.get(project);
    if (!names) usersOf.set(project, (names = new Map()));
    let users = names.get(e.symbol_name);
    if (!users) names.set(e.symbol_name, (users = new Set()));
    users.add(from);
  }
  const usage = new Map(
    [...usersOf].map(([project, names]) => [
      project,
      {
        callerFiles: callers.get(project)?.size ?? 0,
        filesUsing: new Map([...names].map(([name, set]) => [name, set.size])),
      },
    ])
  );
  const specificity = (project: string, symbol: string): number => {
    const total = callers.get(project)?.size ?? 0;
    const logF = Math.log(total);
    const f = usersOf.get(project)?.get(symbol)?.size ?? 1;
    return logF > 0 ? Math.max(0, Math.log(total / f) / logF) : 1;
  };

  const out = new Map<FileKey, Map<FileKey, number>>();
  const clearCallers = new Map<FileKey, Set<FileKey>>();
  for (const list of uses.values()) {
    const symbol = list[0]!.symbol_name;
    const caller = fileKeyOf(list[0]!.from_chunk_id);
    if (!caller) continue;
    const project = splitKey(caller).project;
    const share = specificity(project, symbol) / list.length;
    const clear = list.length <= 2 && !isCommonName(symbol, usage.get(project)!);
    for (const e of list) {
      const from = fileKeyOf(e.from_chunk_id);
      const to = fileKeyOf(e.to_chunk_id);
      if (!from || !to || from === to) continue;
      if (clear) {
        let set = clearCallers.get(to);
        if (!set) clearCallers.set(to, (set = new Set()));
        set.add(from);
      }
      if (share === 0) continue;
      let row = out.get(from);
      if (!row) out.set(from, (row = new Map()));
      row.set(to, (row.get(to) ?? 0) + share);
    }
  }
  return { weights: out, callers: clearCallers };
}

/**
 * Louvain community detection on an undirected weighted graph given as
 * adjacency maps. Nodes are visited in index order, so the same graph always
 * gives the same partition. Returns a community index per node.
 */
export function louvain(adj: Array<Map<number, number>>, resolution = 1): number[] {
  let membership = adj.map((_, i) => i);
  let graph = adj;

  for (;;) {
    const n = graph.length;
    const degree = graph.map((row) => {
      let k = 0;
      for (const w of row.values()) k += w;
      return k;
    });
    const twoM = degree.reduce((a, b) => a + b, 0);
    if (twoM === 0) return membership;

    const community = graph.map((_, i) => i);
    const total = degree.slice();
    let moved = false;

    for (let improved = true; improved;) {
      improved = false;
      for (let i = 0; i < n; i++) {
        const own = community[i]!;
        const ki = degree[i]!;
        const toCommunity = new Map<number, number>();
        for (const [j, w] of graph[i]!) {
          if (j === i) continue;
          const c = community[j]!;
          toCommunity.set(c, (toCommunity.get(c) ?? 0) + w);
        }
        total[own]! -= ki;
        let best = own;
        let bestGain = (toCommunity.get(own) ?? 0) - (resolution * total[own]! * ki) / twoM;
        for (const [c, w] of toCommunity) {
          const gain = w - (resolution * total[c]! * ki) / twoM;
          if (gain > bestGain + 1e-12) {
            best = c;
            bestGain = gain;
          }
        }
        total[best]! += ki;
        if (best !== own) {
          community[i] = best;
          improved = true;
          moved = true;
        }
      }
    }
    if (!moved) return membership;

    // Renumber communities densely and fold the graph onto them.
    const renumber = new Map<number, number>();
    for (const c of community) if (!renumber.has(c)) renumber.set(c, renumber.size);
    const folded: Array<Map<number, number>> = Array.from(
      { length: renumber.size },
      () => new Map()
    );
    for (let i = 0; i < n; i++) {
      const ci = renumber.get(community[i]!)!;
      for (const [j, w] of graph[i]!) {
        const cj = renumber.get(community[j]!)!;
        folded[ci]!.set(cj, (folded[ci]!.get(cj) ?? 0) + w);
      }
    }
    membership = membership.map((c) => renumber.get(community[c]!)!);
    graph = folded;
  }
}

function maxModuleFiles(total: number): number {
  return Math.max(MIN_SPLIT_FILES, Math.ceil(MAX_MODULE_SHARE * total));
}

/**
 * Re-run Louvain inside every community larger than `limit`, on the subgraph
 * of its own files, until the parts fit or stop splitting. Returns a fresh
 * community index per node.
 */
export function splitLarge(
  adj: Array<Map<number, number>>,
  membership: number[],
  limit: number
): number[] {
  const groups = new Map<number, number[]>();
  membership.forEach((c, i) => {
    let g = groups.get(c);
    if (!g) groups.set(c, (g = []));
    g.push(i);
  });
  const out = new Array<number>(adj.length);
  let next = 0;
  const place = (members: number[], depth: number): void => {
    if (members.length > limit && depth < 4) {
      const local = new Map(members.map((n, i) => [n, i]));
      const sub = members.map((n) => {
        const row = new Map<number, number>();
        for (const [j, w] of adj[n]!) {
          const lj = local.get(j);
          if (lj !== undefined) row.set(lj, w);
        }
        return row;
      });
      const parts = new Map<number, number[]>();
      louvain(sub).forEach((c, i) => {
        let p = parts.get(c);
        if (!p) parts.set(c, (p = []));
        p.push(members[i]!);
      });
      if (parts.size > 1) {
        for (const p of parts.values()) place(p, depth + 1);
        return;
      }
    }
    const id = next++;
    for (const n of members) out[n] = id;
  };
  for (const g of groups.values()) place(g, 0);
  return out;
}

/** The directory holding most of `files`; ties go to the shorter, then alphabetically first. */
function dominantDir(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const d = path.posix.dirname(f);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0])
  )[0]![0];
}

function sortLinks(m: Map<number, number>): ModuleLink[] {
  return [...m.entries()]
    .map(([module, weight]) => ({ module, weight }))
    .sort((a, b) => b.weight - a.weight || a.module - b.module);
}

/**
 * Group the files of a code graph into modules: sets of files that call each
 * other much more than they call the rest. Tests and shared files are taken out
 * first — tests call across everything, shared files are called by everything —
 * then each test is attached to the module it calls most.
 *
 * `files` lists every indexed file (key `<project>//<file>`), so files without
 * edges are reported as unconnected instead of vanishing.
 */
export function buildModuleMap(edges: Iterable<MapEdge>, files: Iterable<FileKey>): ModuleMap {
  const graph = fileWeights(edges);
  const weights = graph.weights;
  const all = new Set<FileKey>(files);
  for (const [from, row] of weights) {
    all.add(from);
    for (const to of row.keys()) all.add(to);
  }
  for (const [to, set] of graph.callers) {
    all.add(to);
    for (const from of set) all.add(from);
  }
  const isTest = (k: FileKey) => isTestPath(splitKey(k).file);
  const isMigration = (k: FileKey) => isMigrationPath(splitKey(k).file);
  const migrations = [...all].filter(isMigration).length;
  for (const k of all) if (isMigration(k)) all.delete(k);
  const code = [...all].filter((k) => !isTest(k)).sort();

  // Each project is grouped on its own: edges stay inside a project, and the
  // thresholds (shared files, module size) depend on the project's size, so a
  // small project next to a large one in a group still gets split.
  const byProject = new Map<string, FileKey[]>();
  for (const k of code) {
    const p = splitKey(k).project;
    let list = byProject.get(p);
    if (!list) byProject.set(p, (list = []));
    list.push(k);
  }
  const codeCallers = (file: FileKey) =>
    [...(graph.callers.get(file) ?? [])].filter((c) => !isTest(c) && !isMigration(c)).length;
  const shared: ModuleMap['shared'] = [];
  const unconnected: FileKey[] = [];
  const groups: FileKey[][] = [];
  for (const projectFiles of byProject.values()) {
    // Shared files: clearly called from a large share of the project's other code files.
    const sharedFloor = Math.max(
      SHARED_FILE_MIN_CALLERS,
      SHARED_FILE_CALLER_SHARE * projectFiles.length
    );
    const sharedHere = projectFiles
      .map((file) => ({ file, callers: codeCallers(file) }))
      .filter((s) => s.callers >= sharedFloor);
    shared.push(...sharedHere);
    const sharedSet = new Set(sharedHere.map((s) => s.file));

    // Undirected graph over the remaining code files.
    const nodes = projectFiles.filter((k) => !sharedSet.has(k));
    const index = new Map(nodes.map((k, i) => [k, i]));
    const adj: Array<Map<number, number>> = nodes.map(() => new Map());
    for (const [from, row] of weights) {
      const i = index.get(from);
      if (i === undefined) continue;
      for (const [to, w] of row) {
        const j = index.get(to);
        if (j === undefined) continue;
        adj[i]!.set(j, (adj[i]!.get(j) ?? 0) + w);
        adj[j]!.set(i, (adj[j]!.get(i) ?? 0) + w);
      }
    }

    unconnected.push(...nodes.filter((_, i) => adj[i]!.size === 0));
    const membership = splitLarge(adj, louvain(adj), maxModuleFiles(nodes.length));
    const byCommunity = new Map<number, FileKey[]>();
    nodes.forEach((k, i) => {
      if (adj[i]!.size === 0) return;
      const c = membership[i]!;
      let list = byCommunity.get(c);
      if (!list) byCommunity.set(c, (list = []));
      list.push(k);
    });
    groups.push(...byCommunity.values());
  }
  shared.sort((a, b) => b.callers - a.callers || a.file.localeCompare(b.file));
  unconnected.sort();

  // Weighted in-degree, to order files by how much the rest relies on them.
  const inWeight = new Map<FileKey, number>();
  for (const row of weights.values()) {
    for (const [to, w] of row) inWeight.set(to, (inWeight.get(to) ?? 0) + w);
  }

  groups.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  const moduleOf = new Map<FileKey, number>();
  groups.forEach((g, id) => g.forEach((k) => moduleOf.set(k, id)));

  const modules: CodeModule[] = groups.map((g, id) => {
    const sorted = [...g].sort(
      (a, b) => (inWeight.get(b) ?? 0) - (inWeight.get(a) ?? 0) || a.localeCompare(b)
    );
    const projects = new Map<string, number>();
    for (const k of g) {
      const p = splitKey(k).project;
      projects.set(p, (projects.get(p) ?? 0) + 1);
    }
    const project = [...projects.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0]![0];
    return {
      id,
      name: dominantDir(
        g.filter((k) => splitKey(k).project === project).map((k) => splitKey(k).file)
      ),
      project,
      files: sorted,
      tests: [],
      uses: [],
      usedBy: [],
    };
  });

  // Same directory named twice: tell them apart by their most called file.
  const nameCount = new Map<string, number>();
  for (const m of modules)
    nameCount.set(`${m.project}//${m.name}`, (nameCount.get(`${m.project}//${m.name}`) ?? 0) + 1);
  for (const m of modules) {
    if ((nameCount.get(`${m.project}//${m.name}`) ?? 0) > 1) {
      m.name = `${m.name} (${path.posix.basename(splitKey(m.files[0]!).file)})`;
    }
  }

  // Links between modules, and each test to the module it calls most.
  const uses = modules.map(() => new Map<number, number>());
  const usedBy = modules.map(() => new Map<number, number>());
  const testTarget = new Map<FileKey, Map<number, number>>();
  for (const [from, row] of weights) {
    const a = moduleOf.get(from);
    for (const [to, w] of row) {
      const b = moduleOf.get(to);
      if (b === undefined) continue;
      if (isTest(from)) {
        let t = testTarget.get(from);
        if (!t) testTarget.set(from, (t = new Map()));
        t.set(b, (t.get(b) ?? 0) + w);
        continue;
      }
      if (a === undefined || a === b) continue;
      uses[a]!.set(b, (uses[a]!.get(b) ?? 0) + w);
      usedBy[b]!.set(a, (usedBy[b]!.get(a) ?? 0) + w);
    }
  }
  modules.forEach((m, i) => {
    m.uses = sortLinks(uses[i]!);
    m.usedBy = sortLinks(usedBy[i]!);
  });
  for (const [test, targets] of [...testTarget.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const best = sortLinks(targets)[0];
    if (best) modules[best.module]!.tests.push(test);
  }

  return { modules, shared, unconnected, migrations, weights };
}

/**
 * Links shown per module: at least this weight (about one specific call) and
 * at least {@link LINK_MIN_SHARE} of the module's strongest link that way —
 * the weak tail is mostly names that happen to match.
 */
export const LINK_MIN_WEIGHT = 1;
export const LINK_MIN_SHARE = 0.2;

export function strongLinks(links: ModuleLink[]): ModuleLink[] {
  const top = links[0]?.weight ?? 0;
  return links.filter((l) => l.weight >= LINK_MIN_WEIGHT && l.weight >= LINK_MIN_SHARE * top);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface FormatModuleMapOptions {
  /** Heading target, e.g. `` `billing` `` or `` `main-stand` / `billing` ``. */
  title: string;
  /** Modules to show in full; the rest are summarised. */
  limit: number;
  /** How a file key is printed (clean project name, or none when only one project). */
  showFile: (key: FileKey) => string;
  /** How a module is named; defaults to its folder. */
  showName?: (module: CodeModule) => string;
  /** Append a Mermaid diagram of the shown modules and their strong links. */
  diagram?: boolean;
}

/**
 * Mermaid flowchart of `modules`: one box per module labelled with its name and
 * size, one arrow per strong link between two of them (caller → called).
 * Labels are quoted, with quotes and angle brackets replaced by Mermaid entities.
 */
export function moduleMapDiagram(modules: CodeModule[], name: (m: CodeModule) => string): string {
  const shown = new Set(modules.map((m) => m.id));
  const label = (m: CodeModule) =>
    `${m.id + 1}. ${name(m)} · ${m.files.length}`
      .replace(/"/g, '#quot;')
      .replace(/</g, '#lt;')
      .replace(/>/g, '#gt;');
  const lines = ['```mermaid', 'flowchart LR'];
  for (const m of modules) lines.push(`  m${m.id + 1}["${label(m)}"]`);
  for (const m of modules) {
    for (const l of strongLinks(m.uses)) {
      if (shown.has(l.module)) lines.push(`  m${m.id + 1} --> m${l.module + 1}`);
    }
  }
  lines.push('```');
  return lines.join('\n') + '\n';
}

/** Markdown for `module_map`: modules largest first, their main files and links, then shared code. */
export function formatModuleMap(map: ModuleMap, opts: FormatModuleMapOptions): string {
  const fileCount = map.modules.reduce((n, m) => n + m.files.length, 0);
  const testCount = map.modules.reduce((n, m) => n + m.tests.length, 0);
  let text = `## Module map of ${opts.title}\n\n`;
  if (map.modules.length === 0) {
    text +=
      'No modules: the symbol graph has no links between files here. Index the project, or check `health_check` — a language without AST support has no graph.\n';
    return text;
  }

  const extras = [
    testCount > 0
      ? `${plural(testCount, 'test file', 'test files')} attached to the module they test`
      : '',
    map.shared.length > 0
      ? `${plural(map.shared.length, 'shared file', 'shared files')} listed apart`
      : '',
    map.migrations > 0 ? `${plural(map.migrations, 'migration', 'migrations')} left out` : '',
  ].filter(Boolean);
  text += `${plural(map.modules.length, 'module', 'modules')} over ${plural(fileCount, 'file', 'files')}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}. A module is a set of files that call each other much more than they call the rest; it is named after the folder most of its files sit in.\n`;

  const number = (id: number) => `${id + 1}`;
  const name = opts.showName ?? ((m: CodeModule) => m.name);
  const linkList = (links: ModuleLink[]) =>
    strongLinks(links)
      .slice(0, 4)
      .map((l) => `${number(l.module)}. ${name(map.modules[l.module]!)}`)
      .join('; ');

  const shown = map.modules.slice(0, opts.limit);
  for (const m of shown) {
    text += `\n### ${number(m.id)}. ${name(m)} — ${plural(m.files.length, 'file', 'files')}${m.tests.length > 0 ? `, ${plural(m.tests.length, 'test', 'tests')}` : ''}\n\n`;
    text += `Main files: ${m.files.slice(0, 4).map(opts.showFile).join(', ')}\n`;
    const uses = linkList(m.uses);
    const usedBy = linkList(m.usedBy);
    if (uses) text += `Uses: ${uses}\n`;
    if (usedBy) text += `Used by: ${usedBy}\n`;
  }
  const rest = map.modules.slice(opts.limit);
  if (rest.length > 0) {
    const files = rest.reduce((n, m) => n + m.files.length, 0);
    text += `\n_${plural(rest.length, 'smaller module', 'smaller modules')} (${plural(files, 'file', 'files')}) not shown: ${rest
      .slice(0, 8)
      .map(name)
      .join(', ')}${rest.length > 8 ? ', …' : ''}. Raise \`limit\` to see them._\n`;
  }

  if (map.shared.length > 0) {
    text += `\n### Shared code — called from much of the rest, not part of one module\n\n`;
    for (const s of map.shared.slice(0, 10)) {
      text += `- ${opts.showFile(s.file)} — called from ${s.callers} files\n`;
    }
    if (map.shared.length > 10) text += `- …and ${map.shared.length - 10} more\n`;
  }

  if (opts.diagram) {
    text += `\n### Diagram — arrows point from a module to the modules it uses\n\n`;
    text += moduleMapDiagram(shown, name);
  }

  text +=
    '\n_The graph links code by name, so module borders are a strong hint, not a rule. Read the main files of a module before relying on what it contains._\n';
  return text;
}

/**
 * One map out of maps of separate projects, as `buildModuleMap` would build it
 * from all their edges: each project is grouped on its own there too, and
 * edges never cross projects. Modules are numbered again, largest first.
 */
export function mergeModuleMaps(maps: ModuleMap[]): ModuleMap {
  const entries = maps.flatMap((map, m) => map.modules.map((mod) => ({ m, mod })));
  // buildModuleMap orders by size, then by the module's alphabetically first file.
  const first = (mod: CodeModule) => [...mod.files].sort()[0] ?? '';
  entries.sort(
    (a, b) => b.mod.files.length - a.mod.files.length || first(a.mod).localeCompare(first(b.mod))
  );
  const newId = new Map<string, number>();
  entries.forEach(({ m, mod }, id) => newId.set(`${m}:${mod.id}`, id));
  const relink = (m: number, links: ModuleLink[]): ModuleLink[] =>
    links.map((l) => ({ ...l, module: newId.get(`${m}:${l.module}`)! }));
  const modules = entries.map(({ m, mod }, id) => ({
    ...mod,
    id,
    uses: relink(m, mod.uses),
    usedBy: relink(m, mod.usedBy),
  }));

  const weights = new Map<FileKey, Map<FileKey, number>>();
  for (const map of maps) for (const [from, row] of map.weights) weights.set(from, row);
  return {
    modules,
    shared: maps
      .flatMap((map) => map.shared)
      .sort((a, b) => b.callers - a.callers || a.file.localeCompare(b.file)),
    unconnected: maps.flatMap((map) => map.unconnected).sort(),
    migrations: maps.reduce((n, map) => n + map.migrations, 0),
    weights,
  };
}

/**
 * A module map older than this is rebuilt when its project's edges changed
 * since. Younger ones are served as they are while the indexer keeps writing
 * edges: mapping a large project takes seconds.
 */
export const MODULE_MAP_MAX_AGE_MS = 5 * 60 * 1000;

type ModuleMapStore = Pick<MetadataStore, 'edgesVersion' | 'edgeProjects' | 'iterateProjectEdges'>;

/**
 * Module maps per (group, project), shared by `module_map` and the console's
 * map page. A group's map is put together from its projects' maps, so after
 * indexing only the projects whose edges changed are mapped again.
 */
export class ModuleMapService {
  private cache = new Map<string, { version: string; builtAt: number; map: ModuleMap }>();

  constructor(
    private readonly store: ModuleMapStore,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * The map of `group`, or of one project in it when `storedProject` (the name
   * as chunk ids carry it) is given. `visible` drops chunks outside the
   * server's project scope; it must be the same for every call, as it is not
   * part of the cache key.
   */
  get(
    group: string,
    storedProject: string | undefined,
    visible: (chunkId: string) => boolean
  ): ModuleMap {
    if (storedProject !== undefined) return this.projectMap(group, storedProject, visible);
    const projects = this.store.edgeProjects(group).sort();
    const maps = projects.map((p) => this.projectMap(group, p, visible));
    const key = `${group}\0`;
    const version = projects.map((p) => this.cache.get(`${group}\0${p}`)!.version).join(',');
    const cached = this.cache.get(key);
    if (cached && cached.version === version) return cached.map;
    const map = mergeModuleMaps(maps);
    this.cache.set(key, { version, builtAt: this.now(), map });
    return map;
  }

  private projectMap(
    group: string,
    project: string,
    visible: (chunkId: string) => boolean
  ): ModuleMap {
    const key = `${group}\0${project}`;
    const version = this.store.edgesVersion(group, project);
    const cached = this.cache.get(key);
    if (
      cached &&
      (cached.version === version || this.now() - cached.builtAt < MODULE_MAP_MAX_AGE_MS)
    ) {
      return cached.map;
    }
    const store = this.store;
    const prefix = `${group}//${project}//`;
    function* visibleEdges(): Generator<SymbolEdge> {
      for (const e of store.iterateProjectEdges(group, project)) {
        if (!e.to_chunk_id.startsWith(prefix)) continue;
        if (!visible(e.from_chunk_id) || !visible(e.to_chunk_id)) continue;
        yield e;
      }
    }
    const map = buildModuleMap(visibleEdges(), []);
    // The group map is keyed by the versions its project maps were built at,
    // so it is put together again exactly when one of them was rebuilt.
    this.cache.set(key, { version, builtAt: this.now(), map });
    return map;
  }
}
