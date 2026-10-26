import type { FileKey, ModuleMap } from './module-map.js';

/**
 * Folder views over a module map for the console's map page: the code of a
 * project as its folder tree, each level drawn as its folders and files with
 * the calls between them summed up. Folders are what people already know a
 * codebase by; the modules found from the call graph are listed next to them.
 */

/** Children drawn per level; the rest are folded into one "more" node. */
export const EXPLORER_MAX_CHILDREN = 24;
/** Folders outside the current one drawn around it, the most linked first. */
export const EXPLORER_MAX_OUTSIDE = 10;
/** Links lighter than this (about one specific call) are not drawn. */
export const EXPLORER_MIN_LINK = 1;
/** Key of the node holding the children beyond {@link EXPLORER_MAX_CHILDREN}. */
export const MORE_KEY = '…';

export type ExplorerKind = 'project' | 'folder' | 'file' | 'module' | 'more';

export interface ExplorerNode {
  /**
   * Stored project name at the top level, `#<id>` for a module, `[project]`
   * for another project seen from inside one, else a path inside the project.
   */
  key: string;
  kind: ExplorerKind;
  /** Files under it (1 for a file). */
  files: number;
  /** Summed weight of calls into it from outside it. */
  calledWeight: number;
}

export interface ExplorerLink {
  /** Caller node key. */
  from: string;
  /** Called node key. */
  to: string;
  weight: number;
}

export interface FolderView {
  /** Stored project name, or null for the projects of a group. */
  project: string | null;
  /** Folder inside the project, '' for its root. */
  path: string;
  nodes: ExplorerNode[];
  links: ExplorerLink[];
  /** Folders outside `path` that its files call or are called from, as paths or `project` keys. */
  outside: ExplorerNode[];
  /** Links between `nodes` and `outside`, either direction. */
  outsideLinks: ExplorerLink[];
  /** Files folded into the "more" node, the most called first. */
  more: string[];
  /** Modules with files under `path`, the most files here first. */
  modules: Array<{ id: number; name: string; filesHere: number; fileCount: number }>;
}

export interface FileView {
  project: string;
  file: string;
  /** The module the file is in, if any (shared files and tests are not). */
  module: { id: number; name: string } | null;
  shared: boolean;
  calls: Array<{ project: string; file: string; weight: number }>;
  calledBy: Array<{ project: string; file: string; weight: number }>;
}

interface ExplorerIndex {
  /** Files per stored project. */
  files: Map<string, string[]>;
  calledWeight: Map<FileKey, number>;
  moduleOf: Map<FileKey, number>;
  callersOf: Map<FileKey, Map<FileKey, number>>;
}

const indexes = new WeakMap<ModuleMap, ExplorerIndex>();

function splitKey(key: FileKey): { project: string; file: string } {
  const i = key.indexOf('//');
  return { project: key.slice(0, i), file: key.slice(i + 2) };
}

/** Built once per map and kept as long as the map is. */
function indexOf(map: ModuleMap): ExplorerIndex {
  const cached = indexes.get(map);
  if (cached) return cached;
  const all = new Set<FileKey>();
  const calledWeight = new Map<FileKey, number>();
  const callersOf = new Map<FileKey, Map<FileKey, number>>();
  for (const [from, row] of map.weights) {
    all.add(from);
    for (const [to, w] of row) {
      all.add(to);
      calledWeight.set(to, (calledWeight.get(to) ?? 0) + w);
      let callers = callersOf.get(to);
      if (!callers) callersOf.set(to, (callers = new Map()));
      callers.set(from, w);
    }
  }
  const moduleOf = new Map<FileKey, number>();
  for (const m of map.modules) {
    for (const k of m.files) {
      all.add(k);
      moduleOf.set(k, m.id);
    }
    for (const k of m.tests) all.add(k);
  }
  for (const s of map.shared) all.add(s.file);
  const files = new Map<string, string[]>();
  for (const k of [...all].sort()) {
    const { project, file } = splitKey(k);
    let list = files.get(project);
    if (!list) files.set(project, (list = []));
    list.push(file);
  }
  const index = { files, calledWeight, moduleOf, callersOf };
  indexes.set(map, index);
  return index;
}

/** Stored names of the projects in a map. */
export function mapProjects(map: ModuleMap): string[] {
  return [...indexOf(map).files.keys()];
}

/**
 * The view of one folder: its child folders and files, the calls between
 * them, and the folders elsewhere they call or are called from. With
 * `project` null and several projects in the map, the children are the
 * projects; with a single project, that project's root.
 */
export function folderView(map: ModuleMap, project: string | null, path: string): FolderView {
  const index = indexOf(map);
  const projects = [...index.files.keys()];
  if (project === null && projects.length === 1) project = projects[0]!;
  if (project === null) return projectsView(map, index);
  let view = projectFolderView(map, index, project, path);
  // A folder holding nothing but one folder opens that one instead.
  while (view.nodes.length === 1 && view.nodes[0]!.kind === 'folder') {
    view = projectFolderView(map, index, project, view.nodes[0]!.key);
  }
  return view;
}

function projectsView(map: ModuleMap, index: ExplorerIndex): FolderView {
  const nodes: ExplorerNode[] = [...index.files].map(([project, files]) => ({
    key: project,
    kind: 'project',
    files: files.length,
    calledWeight: 0,
  }));
  const sums = new Map<string, number>();
  for (const [from, row] of map.weights) {
    const a = splitKey(from).project;
    for (const [to, w] of row) {
      const b = splitKey(to).project;
      if (a === b) continue;
      sums.set(`${a}\0${b}`, (sums.get(`${a}\0${b}`) ?? 0) + w);
    }
  }
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const links = toLinks(sums);
  for (const l of links) byKey.get(l.to)!.calledWeight += l.weight;
  nodes.sort((a, b) => b.files - a.files || a.key.localeCompare(b.key));
  return {
    project: null,
    path: '',
    nodes,
    links,
    outside: [],
    outsideLinks: [],
    more: [],
    modules: [],
  };
}

function toLinks(sums: Map<string, number>): ExplorerLink[] {
  return [...sums]
    .filter(([, w]) => w >= EXPLORER_MIN_LINK)
    .map(([k, w]) => {
      const [from, to] = k.split('\0') as [string, string];
      return { from, to, weight: Math.round(w * 100) / 100 };
    })
    .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));
}

function projectFolderView(
  map: ModuleMap,
  index: ExplorerIndex,
  project: string,
  rawPath: string
): FolderView {
  const path = rawPath.replace(/^\/+|\/+$/g, '');
  const prefix = path ? `${path}/` : '';
  const members = (index.files.get(project) ?? []).filter((f) => f.startsWith(prefix));

  // Child of each member: the next folder down, or the file itself. A folder
  // holding nothing but one subfolder is skipped over (`app` → `app/services`).
  const folderMembers = new Map<string, string[]>();
  const childOf = new Map<string, string>();
  for (const f of members) {
    const rest = f.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      childOf.set(f, f);
      continue;
    }
    const folder = prefix + rest.slice(0, slash);
    let list = folderMembers.get(folder);
    if (!list) folderMembers.set(folder, (list = []));
    list.push(f);
  }
  for (const [folder, files] of folderMembers) {
    let name = folder;
    for (;;) {
      const next = new Set<string>();
      let direct = false;
      for (const f of files) {
        const rest = f.slice(name.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) direct = true;
        else next.add(rest.slice(0, slash));
      }
      if (direct || next.size !== 1) break;
      name = `${name}/${[...next][0]}`;
    }
    for (const f of files) childOf.set(f, name);
  }

  const key = (f: string) => `${project}//${f}`;
  const nodes = new Map<string, ExplorerNode>();
  for (const [f, child] of childOf) {
    let n = nodes.get(child);
    if (!n) {
      n = { key: child, kind: child === f ? 'file' : 'folder', files: 0, calledWeight: 0 };
      nodes.set(child, n);
    }
    n.files += 1;
  }

  // Calls between children, and between children and the rest.
  const inner = new Map<string, number>();
  const outer = new Map<string, number>();
  const outsideKey = (k: FileKey): string => {
    const { project: p, file } = splitKey(k);
    if (p !== project) return `[${p}]`;
    // The other file's folder one level below where its path leaves `path`.
    const a = file.split('/');
    const b = path ? path.split('/') : [];
    let i = 0;
    while (i < b.length && i < a.length - 1 && a[i] === b[i]) i++;
    return a.slice(0, Math.min(i + 1, a.length - 1)).join('/') || a[0]!;
  };
  const add = (m: Map<string, number>, from: string, to: string, w: number) => {
    const k = `${from}\0${to}`;
    m.set(k, (m.get(k) ?? 0) + w);
  };
  for (const [from, row] of map.weights) {
    const fp = splitKey(from);
    const cf = fp.project === project ? childOf.get(fp.file) : undefined;
    for (const [to, w] of row) {
      const tp = splitKey(to);
      const ct = tp.project === project ? childOf.get(tp.file) : undefined;
      if (cf !== undefined && ct !== undefined) {
        if (cf !== ct) add(inner, cf, ct, w);
      } else if (cf !== undefined) {
        add(outer, cf, outsideKey(to), w);
      } else if (ct !== undefined) {
        add(outer, outsideKey(from), ct, w);
      }
    }
  }
  for (const [k, w] of inner) {
    const to = k.split('\0')[1]!;
    nodes.get(to)!.calledWeight += w;
  }
  for (const [k, w] of outer) {
    const to = k.split('\0')[1]!;
    const n = nodes.get(to);
    if (n) n.calledWeight += w;
  }

  // Keep the most called children; fold the rest into one node.
  const sorted = [...nodes.values()].sort(
    (a, b) => b.calledWeight - a.calledWeight || b.files - a.files || a.key.localeCompare(b.key)
  );
  const kept = sorted.slice(0, EXPLORER_MAX_CHILDREN);
  const folded = sorted.slice(EXPLORER_MAX_CHILDREN);
  const keptKeys = new Set(kept.map((n) => n.key));
  const fold = (k: string) => (keptKeys.has(k) || !nodes.has(k) ? k : MORE_KEY);
  const refold = (m: Map<string, number>) => {
    const out = new Map<string, number>();
    for (const [k, w] of m) {
      const [a, b] = k.split('\0') as [string, string];
      const fa = fold(a);
      const fb = fold(b);
      if (fa === fb) continue;
      add(out, fa, fb, w);
    }
    return out;
  };
  const viewNodes = [...kept];
  if (folded.length > 0) {
    viewNodes.push({
      key: MORE_KEY,
      kind: 'more',
      files: folded.reduce((n, c) => n + c.files, 0),
      calledWeight: folded.reduce((n, c) => n + c.calledWeight, 0),
    });
  }

  // The most linked outside folders.
  const outerLinks = toLinks(refold(outer));
  const outsideWeight = new Map<string, number>();
  for (const l of outerLinks) {
    const o = nodes.has(l.from) || l.from === MORE_KEY ? l.to : l.from;
    outsideWeight.set(o, (outsideWeight.get(o) ?? 0) + l.weight);
  }
  const outsideKeys = [...outsideWeight]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, EXPLORER_MAX_OUTSIDE)
    .map(([k]) => k);
  const outsideSet = new Set(outsideKeys);
  const outside: ExplorerNode[] = outsideKeys.map((k) => {
    const isProject = k.startsWith('[') && k.endsWith(']');
    const files = isProject
      ? (index.files.get(k.slice(1, -1))?.length ?? 0)
      : (index.files.get(project) ?? []).filter((f) => f === k || f.startsWith(`${k}/`)).length;
    const isFile = !isProject && (index.files.get(project) ?? []).includes(k);
    return {
      key: k,
      kind: isProject ? 'project' : isFile ? 'file' : 'folder',
      files,
      calledWeight: outsideWeight.get(k) ?? 0,
    };
  });

  const filesHere = new Map<number, number>();
  for (const f of members) {
    const m = index.moduleOf.get(key(f));
    if (m !== undefined) filesHere.set(m, (filesHere.get(m) ?? 0) + 1);
  }
  const modules = [...filesHere]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 12)
    .map(([id, n]) => ({
      id,
      name: map.modules[id]!.name,
      filesHere: n,
      fileCount: map.modules[id]!.files.length,
    }));

  return {
    project,
    path,
    nodes: viewNodes.map((n) => ({ ...n, calledWeight: Math.round(n.calledWeight * 100) / 100 })),
    links: toLinks(refold(inner)),
    outside,
    outsideLinks: outerLinks.filter((l) => outsideSet.has(l.from) || outsideSet.has(l.to)),
    more: folded.map((n) => n.key),
    modules,
  };
}

/** One file: its module and the files it calls and is called from, heaviest first. */
export function fileView(map: ModuleMap, project: string, file: string): FileView | null {
  const index = indexOf(map);
  if (!(index.files.get(project) ?? []).includes(file)) return null;
  const k = `${project}//${file}`;
  const list = (row: Map<FileKey, number> | undefined) =>
    [...(row ?? [])]
      .map(([other, w]) => ({ ...splitKey(other), weight: Math.round(w * 100) / 100 }))
      .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));
  const m = index.moduleOf.get(k);
  return {
    project,
    file,
    module: m !== undefined ? { id: m, name: map.modules[m]!.name } : null,
    shared: map.shared.some((s) => s.file === k),
    calls: list(map.weights.get(k)),
    calledBy: list(index.callersOf.get(k)),
  };
}

export interface ModuleView {
  project: string;
  module: { id: number; name: string; fileCount: number; tests: string[] };
  /** The module's most called files; the rest are folded into one node. */
  nodes: ExplorerNode[];
  links: ExplorerLink[];
  /** Other modules this one calls or is called from, keyed `#<id>`. */
  outside: ExplorerNode[];
  outsideLinks: ExplorerLink[];
  more: string[];
}

/** One module: its files, the calls between them, and the modules around it. */
export function moduleView(map: ModuleMap, id: number): ModuleView | null {
  const mod = map.modules[id];
  if (!mod) return null;
  const index = indexOf(map);
  const fileOf = (k: FileKey) => splitKey(k).file;
  const kept = mod.files.slice(0, EXPLORER_MAX_CHILDREN);
  const keptSet = new Set(kept);
  const folded = mod.files.slice(EXPLORER_MAX_CHILDREN);
  const childOf = (k: FileKey): string | undefined => {
    if (keptSet.has(k)) return fileOf(k);
    return index.moduleOf.get(k) === id ? MORE_KEY : undefined;
  };
  const inner = new Map<string, number>();
  const outer = new Map<string, number>();
  const add = (m: Map<string, number>, from: string, to: string, w: number) => {
    const key = `${from}\0${to}`;
    m.set(key, (m.get(key) ?? 0) + w);
  };
  const called = new Map<string, number>();
  for (const [from, row] of map.weights) {
    const cf = childOf(from);
    const mf = index.moduleOf.get(from);
    for (const [to, w] of row) {
      const ct = childOf(to);
      if (cf !== undefined && ct !== undefined) {
        if (cf !== ct) add(inner, cf, ct, w);
      } else if (cf !== undefined) {
        const mt = index.moduleOf.get(to);
        if (mt !== undefined) add(outer, cf, `#${mt}`, w);
      } else if (ct !== undefined && mf !== undefined) {
        add(outer, `#${mf}`, ct, w);
      }
      if (ct !== undefined && cf !== ct) called.set(ct, (called.get(ct) ?? 0) + w);
    }
  }
  const nodes: ExplorerNode[] = kept.map((k) => ({
    key: fileOf(k),
    kind: 'file',
    files: 1,
    calledWeight: Math.round((called.get(fileOf(k)) ?? 0) * 100) / 100,
  }));
  if (folded.length > 0) {
    nodes.push({
      key: MORE_KEY,
      kind: 'more',
      files: folded.length,
      calledWeight: Math.round((called.get(MORE_KEY) ?? 0) * 100) / 100,
    });
  }
  const outerLinks = toLinks(outer);
  const weightOf = new Map<string, number>();
  for (const l of outerLinks) {
    const o = l.from.startsWith('#') ? l.from : l.to;
    weightOf.set(o, (weightOf.get(o) ?? 0) + l.weight);
  }
  const outsideKeys = [...weightOf]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, EXPLORER_MAX_OUTSIDE)
    .map(([k]) => k);
  const outsideSet = new Set(outsideKeys);
  return {
    project: mod.project,
    module: {
      id,
      name: mod.name,
      fileCount: mod.files.length,
      tests: mod.tests.map(fileOf),
    },
    nodes,
    links: toLinks(inner),
    outside: outsideKeys.map((k) => ({
      key: k,
      kind: 'module',
      files: map.modules[Number(k.slice(1))]!.files.length,
      calledWeight: weightOf.get(k) ?? 0,
    })),
    outsideLinks: outerLinks.filter((l) => outsideSet.has(l.from) || outsideSet.has(l.to)),
    more: folded.map(fileOf),
  };
}

/** Files whose path contains `query` (case-insensitive), the most called first. */
export function searchFiles(
  map: ModuleMap,
  query: string,
  limit = 30
): Array<{ project: string; file: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const index = indexOf(map);
  const hits: Array<{ project: string; file: string; w: number }> = [];
  for (const [project, files] of index.files) {
    for (const file of files) {
      if (file.toLowerCase().includes(q)) {
        hits.push({ project, file, w: index.calledWeight.get(`${project}//${file}`) ?? 0 });
      }
    }
  }
  return hits
    .sort((a, b) => b.w - a.w || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map(({ project, file }) => ({ project, file }));
}
