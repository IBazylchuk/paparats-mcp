import { posix } from 'node:path';
import type { ClassParent, UseSite } from './ast-symbol-extractor.js';
import type { EdgeConfidence, NameUsage, RelationType, SymbolEdge } from './types.js';

/**
 * A symbol defined in more than this many chunks is treated as structural noise
 * rather than a real call target — namespace roots, lifecycle hooks
 * (`initialize`, `render`), and shared base-class names get re-declared across
 * hundreds of chunks. Linking every caller of such a name to every definition
 * produces a quadratic fan-out (`uses × defines`) that has been observed to
 * generate millions of AMBIGUOUS edges for a single symbol, blocking the event
 * loop for minutes while they are inserted. These edges carry no navigational
 * value (a "call" to one of 600 `Business` definitions tells you nothing), so
 * we drop them entirely and report the count.
 */
export const MAX_DEFINITION_FANOUT = 50;

/**
 * Edges are matched by name, so `cache.get(k)` links to whichever class defines
 * `get` — and when that class is the only definition the edge even looks
 * certain. The names that collide like this are single lowercase words (`get`,
 * `add`, `close`, `run`, `each`, `create`, `digest`): methods every object has,
 * or that unrelated classes define alike. Ruby's conversions (`to_s`, `to_h`)
 * count as one word. A name is common when it has that shape and more than
 * {@link COMMON_NAME_MIN_FILES} files use it.
 *
 * The bar does not grow with the codebase. It used to be √(files), so in a
 * 6 000-file Rails app `create` (33 files) and `digest` (18) stayed specific
 * and linked every `Model.create` to a controller's `create` action. A real
 * caller through such a name usually also uses something specific from the
 * same file (the class name), which keeps it. Compound names (`ProjectConfig`,
 * `getChunkById`, `find_by_name`) rarely collide by chance, so a widely used
 * one is a real dependency and stays.
 */
export const COMMON_NAME_MIN_FILES = 8;

const SINGLE_LOWERCASE_WORD = /^(?:to_)?[a-z][a-z0-9]*[?!=]?$/;

/** Whether a name has the shape of a common one (see {@link isCommonName}); only those need counting. */
export function mayBeCommonName(name: string): boolean {
  return SINGLE_LOWERCASE_WORD.test(name);
}

export function isCommonName(name: string, usage: NameUsage): boolean {
  if (!SINGLE_LOWERCASE_WORD.test(name)) return false;
  return (usage.filesUsing.get(name) ?? 0) > COMMON_NAME_MIN_FILES;
}

/** Diagnostics returned alongside the edges so the indexer can log what it cut. */
export interface SymbolEdgeStats {
  /** Symbols skipped because they exceeded {@link MAX_DEFINITION_FANOUT}. */
  skippedSymbols: number;
  /** Estimated edges avoided by skipping those symbols. */
  skippedEdges: number;
}

/** Chunk-id prefix is `<group>//<project>//<file>//<lines>//<hash>` — the file
 * segment is the third `//`-delimited part. Used to decide whether two chunks
 * live in the same source file, which lets us label intra-file edges as
 * `EXTRACTED` vs cross-file `INFERRED`. */
function fileKey(chunkId: string): string | null {
  const parts = chunkId.split('//');
  if (parts.length < 3) return null;
  return parts.slice(0, 3).join('//');
}

/** The uses and definitions of one chunk, as the indexer reads them back from its payload. */
export interface ChunkSymbols {
  chunk_id: string;
  defines_symbols: string[];
  uses_symbols: string[];
  /** Absent on chunks extracted before use sites were recorded: every use then comes from the chunk. */
  use_sites?: UseSite[];
  /** Per defined method, its class (see `DefinedSymbol.owner`). */
  def_owners?: Record<string, string>;
  /** Names it defines that only its own file can use (see `DefinedSymbol.local`). */
  local_defs?: string[];
  /** Ruby class methods it defines (see `DefinedSymbol.classMethod`). */
  class_methods?: string[];
  /** The classes, modules and interfaces it defines, by full path, with their parents (see `DefinedSymbol.parents`). */
  def_classes?: Record<string, ClassParent[]>;
  /** Calls between its own methods: each method with the methods of the chunk calling it (see `SymbolExtractionResult.inner_calls`). */
  inner_calls?: Record<string, string[]>;
  /** TS/JS: the name its module exports by default (see `SymbolExtractionResult.default_export`). */
  default_export?: string;
}

/**
 * Stored per project when its graph is built (`graph_formats`). Bumping it
 * after a change to how edges are built from the stored symbols has every
 * project's graph built again on its next pass, with no file extracted again
 * (unlike `SYMBOL_FORMAT`). Projects without a recorded format count as older.
 *
 *  1 — TypeScript and JavaScript path alias imports (`~/lib/dates`) link as
 *      the relative import they resolve to (`resolveAliasImports()`).
 *  2 — in an ES module a name not imported links only within its file; an
 *      import follows re-exports to the file defining the name, and links to
 *      nothing when its module is not in the project; `.d.ts` declarations
 *      are not linked to; edges carry the steps of `reach_symbols`.
 */
export const GRAPH_FORMAT = 2;

/** TypeScript and JavaScript files: a class there is the one its file declares or imports. */
const ES_FILE = /\.(?:[cm]?[jt]sx?)$/;

function isEsFile(file: string | null): boolean {
  return file !== null && ES_FILE.test(file);
}

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/**
 * The files (as {@link fileKey}s) a relative import from `from` can load:
 * `./store.js` as `store.js`, `store.ts`, `store/index.ts`, ... Null for a
 * bare specifier (a package, a workspace, a path alias).
 */
function moduleFiles(from: string | null, spec: string): Set<string> | null {
  if (!from || !spec.startsWith('.')) return null;
  const parts = from.split('//');
  const file = parts.slice(2).join('//');
  const base = posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\/$/, '');
  const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  const prefix = `${parts[0]}//${parts[1]}//`;
  const files = new Set<string>([prefix + base]);
  for (const ext of MODULE_EXTENSIONS) {
    files.add(prefix + stem + ext);
    files.add(`${prefix}${base}/index${ext}`);
  }
  return files;
}

/** A re-export of a barrel file: `exported` is the public name (`*` for `export * from`). */
interface Reexport {
  exported: string;
  name: string;
  module: string;
  file: string;
}

/**
 * Where `name`, imported from `module` in the file of chunk `from`, is
 * defined: the module's files when they define it, else through the
 * re-exports of those files (`export { x as y } from`, `export * from`), up
 * to five files deep. Each file with the name it defines there (another one
 * after `as`). Null when the module is not a relative import; empty when it
 * names no file of the project (generated, or not indexed) or none defines it.
 */
function importedDefinitions(
  from: string,
  module: string,
  name: string,
  definesIn: (file: string, name: string) => boolean,
  reexports: Map<string, Reexport[]>,
  indexedFiles: Set<string>,
  defaultOf: Map<string, string>
): Map<string, string> | null {
  const start = moduleFiles(from, module);
  if (!start) return null;
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const queue: Array<{ files: Set<string>; name: string; depth: number }> = [
    { files: start, name, depth: 0 },
  ];
  while (queue.length > 0) {
    const { files, name: wanted, depth } = queue.shift()!;
    for (const file of files) {
      if (!indexedFiles.has(file) || seen.has(`${file}\0${wanted}`)) continue;
      seen.add(`${file}\0${wanted}`);
      if (wanted !== 'default' && definesIn(file, wanted)) {
        found.set(file, wanted);
        continue;
      }
      let through = (reexports.get(file) ?? []).filter(
        (r) => r.exported === wanted || r.exported === '*'
      );
      // `export { default as x } from`, or `import x from` a module that does
      // not define `x`: its default export, declared there or re-exported
      // (`export { default } from './x'`).
      if (wanted === 'default' || (depth === 0 && through.length === 0)) {
        const byDefault = defaultOf.get(file);
        if (byDefault !== undefined) {
          if (definesIn(file, byDefault)) found.set(file, byDefault);
          continue;
        }
        through = (reexports.get(file) ?? []).filter((r) => r.exported === 'default');
      }
      if (depth >= 5) continue;
      for (const r of through) {
        const next = moduleFiles(file, r.module);
        if (next)
          queue.push({ files: next, name: r.exported === '*' ? wanted : r.name, depth: depth + 1 });
      }
    }
  }
  return found;
}

/** Steps from each of `methods` back to every method of the chunk reaching one of them through its own calls. */
export function innerReach(
  inner: Record<string, string[]> | undefined,
  methods: Iterable<string>
): Map<string, number> {
  const steps = new Map<string, number>();
  if (!inner) return steps;
  let frontier = [...methods];
  for (const m of frontier) steps.set(m, 0);
  for (let d = 1; frontier.length > 0; d++) {
    const next: string[] = [];
    for (const m of frontier) {
      for (const caller of Object.hasOwn(inner, m) ? inner[m]! : []) {
        if (steps.has(caller)) continue;
        steps.set(caller, d);
        next.push(caller);
      }
    }
    frontier = next;
  }
  for (const m of methods) steps.delete(m);
  return steps;
}

/**
 * The project paths a relative import in the file `fromFile` (a path, not a
 * chunk id) may name: the file itself, with each module extension, or the
 * folder's index. Empty for a package or alias specifier.
 */
export function moduleFileCandidates(fromFile: string, spec: string): string[] {
  const files = moduleFiles(`g//p//${fromFile}`, spec);
  return files ? [...files].map((f) => f.split('//').slice(2).join('//')) : [];
}

/** A class as a use resolves it: its full path and, for a TS/JS class from a known file, that file. */
interface ClassRef {
  path: string;
  files?: Set<string>;
}

interface ClassRecord {
  file: string | null;
  parents: ClassParent[];
}

/**
 * The project's classes, modules and interfaces by full path, with what each
 * inherits from or mixes in, per file declaring (or reopening) it. A class a
 * method is defined in counts even where its `class` line defines nothing
 * (a reopened `String`).
 */
class ClassTable {
  private records = new Map<string, ClassRecord[]>();
  private byLastName = new Map<string, string[]>();
  private ancestry = new Map<string, { refs: ClassRef[]; depths: number[] }>();

  constructor(chunks: ChunkSymbols[]) {
    const add = (path: string, record: ClassRecord | null) => {
      let known = this.records.get(path);
      if (!known) {
        this.records.set(path, (known = []));
        const last = path.split('::').pop()!;
        const same = this.byLastName.get(last);
        if (same) same.push(path);
        else this.byLastName.set(last, [path]);
      }
      if (record) known.push(record);
    };
    for (const chunk of chunks) {
      const file = fileKey(chunk.chunk_id);
      for (const [path, parents] of Object.entries(chunk.def_classes ?? {})) {
        add(path, { file, parents });
      }
      for (const owner of Object.values(chunk.def_owners ?? {})) add(owner, null);
    }
  }

  has(path: string): boolean {
    return this.records.has(path);
  }

  /**
   * The classes a name written in `scope` can mean, as Ruby looks a constant
   * up: `::A::B` as it is; `B` in `A::C` as `A::C::B`, `A::B`, `B`; else
   * every class whose path ends with it.
   */
  find(name: string, scope: string | undefined): { paths: string[]; suffix: boolean } {
    if (name.startsWith('::')) {
      const path = name.slice(2);
      return { paths: this.records.has(path) ? [path] : [], suffix: false };
    }
    const parts = scope ? scope.split('::') : [];
    for (let n = parts.length; n >= 0; n--) {
      const path = [...parts.slice(0, n), name].join('::');
      if (this.records.has(path)) return { paths: [path], suffix: false };
    }
    const last = name.split('::').pop()!;
    const paths = (this.byLastName.get(last) ?? []).filter((p) => p.endsWith(`::${name}`));
    return { paths, suffix: true };
  }

  /** Those of a class's files that declare it, when it is declared in some of them. */
  declaredIn(path: string, files: Set<string>): Set<string> | null {
    const there = (this.records.get(path) ?? []).filter(
      (r) => r.file !== null && files.has(r.file)
    );
    return there.length > 0 ? new Set(there.map((r) => r.file!)) : null;
  }

  /**
   * A class and what it inherits, nearest first, each with its distance: the
   * superclass and mixins of every file declaring it, resolved from inside
   * the class; in a TS/JS file the import or the same file's declaration.
   */
  ancestors(start: ClassRef): { refs: ClassRef[]; depths: number[] } {
    const key = `${start.path}\0${[...(start.files ?? [])].sort().join('\0')}`;
    const known = this.ancestry.get(key);
    if (known) return known;
    const refs: ClassRef[] = [start];
    const depths = [0];
    const seen = new Set([start.path]);
    for (let i = 0; i < refs.length && refs.length < 64; i++) {
      const ref = refs[i]!;
      for (const record of this.records.get(ref.path) ?? []) {
        if (ref.files && (record.file === null || !ref.files.has(record.file))) continue;
        for (const parent of record.parents) {
          const imported = parent.module ? moduleFiles(record.file, parent.module) : null;
          for (const path of this.find(parent.name, ref.path).paths) {
            if (seen.has(path)) continue;
            let files: Set<string> | undefined;
            if (imported) {
              const there = this.declaredIn(path, imported);
              if (!there) continue;
              files = there;
            } else if (isEsFile(record.file)) {
              files = this.declaredIn(path, new Set([record.file!])) ?? undefined;
            }
            seen.add(path);
            refs.push(files ? { path, files } : { path });
            depths.push(depths[i]! + 1);
          }
        }
      }
    }
    const found = { refs, depths };
    this.ancestry.set(key, found);
    return found;
  }
}

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };

/** A class held as a value says most (`change_impact` follows it whatever changed), a re-export least. */
const RELATION_RANK: Record<RelationType, number> = {
  reexports: 0,
  calls: 1,
  references: 2,
};

function relationOf(site: UseSite): RelationType {
  if (site.reexport) return 'reexports';
  return site.value ? 'references' : 'calls';
}

/**
 * The definitions of a name in the class a use names, if the index has one.
 *
 * - `exact`: the class found the way Ruby looks a constant up: a `::` path
 *   as it is; a relative `Parser` called from `Intake::Pipeline` as
 *   `Intake::Pipeline::Parser`, then `Intake::Parser`, then `Parser`.
 * - `suffix`: no such class, but one class whose path ends with it
 *   (`Billing::Parser` for `Parser`) defines the name.
 * - `several`: several classes match, or the class defines the name in more
 *   than one file — the use could mean any of them.
 */
function resolveClass(
  site: UseSite,
  byClass: Map<string, string[]> | undefined
): { chunks: string[]; match: 'exact' | 'suffix' | 'several' } | null {
  if (site.on === undefined || !byClass) return null;
  const inFiles = (chunks: string[]) => new Set(chunks.map(fileKey)).size;
  const found = (chunks: string[], match: 'exact' | 'suffix') => ({
    chunks,
    match: inFiles(chunks) > 1 ? ('several' as const) : match,
  });

  if (site.on.startsWith('::')) {
    const chunks = byClass.get(site.on.slice(2));
    return chunks ? found(chunks, 'exact') : null;
  }
  const scope = site.in ? site.in.split('::') : [];
  for (let n = scope.length; n >= 0; n--) {
    const chunks = byClass.get([...scope.slice(0, n), site.on].join('::'));
    if (chunks) return found(chunks, 'exact');
  }
  const ending = `::${site.on}`;
  const classes = [...byClass].filter(([owner]) => owner.endsWith(ending));
  if (classes.length === 0) return null;
  const chunks = classes.flatMap(([, ids]) => ids);
  return classes.length === 1 ? found(chunks, 'suffix') : { chunks, match: 'several' };
}

/**
 * A bare Ruby constant, looked up the way Ruby does: in the namespace it is
 * written in (`site.in`), then each enclosing one, then the top level
 * (`topLevel`: definitions with no namespace). Null when none has it: a
 * constant from a gem, which links to nothing.
 */
function resolveLexical(
  site: UseSite,
  byClass: Map<string, string[]> | undefined,
  topLevel: string[]
): { chunks: string[]; match: 'exact' | 'several' } | null {
  const inFiles = (chunks: string[]) => new Set(chunks.map(fileKey)).size;
  const found = (chunks: string[]) => ({
    chunks,
    match: inFiles(chunks) > 1 ? ('several' as const) : ('exact' as const),
  });
  const scope = site.in ? site.in.split('::') : [];
  for (let n = scope.length; n > 0 && byClass; n--) {
    const chunks = byClass.get(scope.slice(0, n).join('::'));
    if (chunks) return found(chunks);
  }
  return topLevel.length > 0 ? found(topLevel) : null;
}

/**
 * The definitions a call on a class or an object reaches (`Grove.water`,
 * `x.water` after `x = Grove.new`, `this.water()`, a bare Ruby call): those of
 * the nearest class up its ancestry that defines the name; in Ruby, for a call
 * on self, else a method defined at the top of a file (Object's, which every
 * class inherits); else those of its subclasses and implementations (a call
 * on an interface, a mixin calling its host's method). Null when the class is
 * not the project's (a gem's, a package's) or nothing of it answers (Rails'
 * `where`, a `delegate`): the call does not reach a namesake elsewhere.
 * Undefined when the use names no class the project has but its import may
 * still hold the name (a type from another package of the project): it is
 * linked by name. `dispatch` when one known class reaches several
 * definitions (an interface's implementations): each is a real target, so
 * the edges are INFERRED, not AMBIGUOUS like a class name several classes
 * share (`several`).
 */
function resolveMember(
  site: UseSite,
  defs: Set<string>,
  callerFile: string | null,
  classes: ClassTable,
  byClass: Map<string, string[]> | undefined,
  topLevel: string[]
): { chunks: string[]; match: 'exact' | 'suffix' | 'several' | 'dispatch' } | null | undefined {
  const on = site.on!;
  const found = classes.find(on, site.in);
  if (found.paths.length === 0) return site.module !== undefined ? undefined : null;
  const imported = site.module !== undefined ? moduleFiles(callerFile, site.module) : null;
  const here = isEsFile(callerFile) ? new Set([callerFile!]) : null;
  // A TS/JS class is the one its import or its own file declares; a barrel
  // re-exporting it declares none, and then any class of that name may be it.
  const starts: ClassRef[] = found.paths.map((path) => {
    const files = imported
      ? classes.declaredIn(path, imported)
      : here
        ? classes.declaredIn(path, here)
        : null;
    return files ? { path, files } : { path };
  });
  const answering = (ref: ClassRef) =>
    (byClass?.get(ref.path) ?? []).filter(
      (id) => defs.has(id) && (!ref.files || ref.files.has(fileKey(id)!))
    );
  const files = (ids: string[]) => new Set(ids.map(fileKey)).size;

  const up = new Set<string>();
  for (const start of starts) {
    const { refs, depths } = classes.ancestors(start);
    let nearest = -1;
    for (let i = 0; i < refs.length; i++) {
      if (nearest >= 0 && depths[i]! > nearest) break;
      const there = answering(refs[i]!);
      if (there.length === 0) continue;
      nearest = depths[i]!;
      for (const id of there) up.add(id);
    }
  }
  if (up.size > 0) {
    // Up the ancestry one definition wins (Ruby's method lookup order).
    const ids = [...up];
    const match =
      starts.length > 1 || files(ids) > 1 ? 'several' : found.suffix ? 'suffix' : 'exact';
    return { chunks: ids, match };
  }
  if (on.startsWith('::') && !isEsFile(callerFile)) {
    const top = topLevel.filter((id) => defs.has(id));
    if (top.length > 0) {
      return { chunks: top, match: files(top) > 1 ? 'several' : 'suffix' };
    }
  }
  const startPaths = new Set(starts.map((ref) => ref.path));
  const below: string[] = [];
  const owners = new Set<string>();
  for (const [owner, ids] of byClass ?? []) {
    if (startPaths.has(owner)) continue;
    if (!classes.ancestors({ path: owner }).refs.some((ref) => startPaths.has(ref.path))) continue;
    for (const id of ids) {
      if (!defs.has(id)) continue;
      below.push(id);
      owners.add(owner);
    }
  }
  if (below.length === 0) return null;
  // Several classes below one known class each answer it (an interface's
  // implementations): the call reaches every one of them.
  const match =
    files(below) === 1
      ? 'suffix'
      : starts.length === 1 && owners.size === below.length
        ? 'dispatch'
        : 'several';
  return { chunks: below, match };
}

/**
 * Build cross-chunk symbol edges from chunk symbol data.
 *
 * For each use in a chunk, finds the chunks that define the name and creates a
 * `'calls'` edge (from_chunk → to_chunk via symbol). When the call names the
 * class it is made on (`Grove.water`, `self.water`) and {@link resolveClass}
 * finds that class's definitions, only those are linked.
 *
 * Each edge is tagged with a confidence label:
 * - `EXTRACTED`: caller and definition share the same source file, or the
 *   call names the class that defines it (an exact match, in one file).
 * - `INFERRED`: cross-file edge where exactly one chunk defines the symbol,
 *   or one class whose path ends with the name the call uses. Likely
 *   correct, but not proven.
 * - `AMBIGUOUS`: the symbol is defined in multiple chunks (or the named class
 *   could be several). The caller could be hitting any of them; surface all
 *   candidates with low confidence. A call on an object of a known class that
 *   several of its implementations or subclasses answer is `INFERRED`: the
 *   call reaches each of them.
 *
 * A re-export (`export { x } from`) links as `reexports`, a class held as a
 * value (`UseSite.value`) as `references`, anything else as `calls`.
 *
 * Skips self-edges and merges by (from, to, symbol): `from_symbols` collects the
 * methods making the call and the edge keeps its most certain label.
 *
 * The edges of a use depend only on the use and on every definition of its
 * name. `only` keeps the uses it accepts (by chunk and name), so a graph can be
 * updated for some chunks and names from just those chunks, the users of those
 * names and every chunk defining a name they use.
 */
export function buildSymbolEdges(
  chunkSymbols: ChunkSymbols[],
  maxDefinitionFanout: number = MAX_DEFINITION_FANOUT,
  only?: (chunkId: string, name: string) => boolean
): { edges: SymbolEdge[]; stats: SymbolEdgeStats } {
  // Build inverted indexes: symbol → defining chunk IDs, and symbol → class → the same
  const definedBy = new Map<string, Set<string>>();
  const definedIn = new Map<string, Map<string, string[]>>();
  // Per name, the chunks defining it file-private; a use elsewhere skips them.
  const localIn = new Map<string, Set<string>>();
  // Per name, the chunks defining it only as a Ruby class method.
  const classMethodIn = new Map<string, Set<string>>();
  // Per name, the chunks defining it inside a class or namespace.
  const ownedIn = new Map<string, Set<string>>();
  for (const chunk of chunkSymbols) {
    for (const sym of chunk.class_methods ?? []) {
      let set = classMethodIn.get(sym);
      if (!set) classMethodIn.set(sym, (set = new Set()));
      set.add(chunk.chunk_id);
    }
    for (const sym of chunk.local_defs ?? []) {
      let set = localIn.get(sym);
      if (!set) localIn.set(sym, (set = new Set()));
      set.add(chunk.chunk_id);
    }
    for (const sym of chunk.defines_symbols) {
      let defs = definedBy.get(sym);
      if (!defs) {
        defs = new Set();
        definedBy.set(sym, defs);
      }
      defs.add(chunk.chunk_id);
      const owner = chunk.def_owners?.[sym];
      if (owner === undefined) continue;
      let owned = ownedIn.get(sym);
      if (!owned) ownedIn.set(sym, (owned = new Set()));
      owned.add(chunk.chunk_id);
      let byClass = definedIn.get(sym);
      if (!byClass) definedIn.set(sym, (byClass = new Map()));
      let inClass = byClass.get(owner);
      if (!inClass) byClass.set(owner, (inClass = []));
      inClass.push(chunk.chunk_id);
    }
  }

  const classes = new ClassTable(chunkSymbols);

  // ES module facts per file: what it re-exports, and whether it imports at
  // all (a script's top-level names are global, a module's are imported).
  const indexedFiles = new Set<string>();
  const reexports = new Map<string, Reexport[]>();
  const esModules = new Set<string>();
  for (const chunk of chunkSymbols) {
    const file = fileKey(chunk.chunk_id);
    if (!file) continue;
    indexedFiles.add(file);
    if (!isEsFile(file)) continue;
    for (const site of chunk.use_sites ?? []) {
      if (site.module === undefined && !site.external) continue;
      esModules.add(file);
      if (!site.reexport || site.module === undefined) continue;
      let list = reexports.get(file);
      if (!list) reexports.set(file, (list = []));
      list.push({ exported: site.from, name: site.name, module: site.module, file });
    }
    if (/\.[cm]?tsx?$/.test(file)) esModules.add(file);
  }
  const defaultOf = new Map<string, string>();
  for (const chunk of chunkSymbols) {
    const file = fileKey(chunk.chunk_id);
    if (file && chunk.default_export !== undefined) defaultOf.set(file, chunk.default_export);
  }
  const definesIn = (file: string, name: string) =>
    [...(definedBy.get(name) ?? [])].some((id) => fileKey(id) === file);
  const isDeclarationFile = (id: string) => /\.d\.[cm]?ts$/.test(fileKey(id) ?? '');
  const innerOf = new Map<string, Record<string, string[]>>();
  for (const chunk of chunkSymbols)
    if (chunk.inner_calls) innerOf.set(chunk.chunk_id, chunk.inner_calls);

  const edges = new Map<string, SymbolEdge & { callers: Set<string>; reach: Set<string> }>();
  const skipped = new Set<string>();
  const stats: SymbolEdgeStats = { skippedSymbols: 0, skippedEdges: 0 };

  const addEdge = (
    from: string,
    to: string,
    sym: string,
    site: UseSite,
    confidence: EdgeConfidence
  ): void => {
    const key = `${from}\0${to}\0${sym}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = {
        from_chunk_id: from,
        to_chunk_id: to,
        relation_type: relationOf(site),
        symbol_name: sym,
        confidence,
        callers: new Set(),
        reach: new Set(),
      };
      edges.set(key, edge);
    } else if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[edge.confidence!]) {
      edge.confidence = confidence;
    }
    // One edge per (from, to, name), as the most telling of its uses.
    if (RELATION_RANK[relationOf(site)] > RELATION_RANK[edge.relation_type]) {
      edge.relation_type = relationOf(site);
    }
    (site.through ? edge.reach : edge.callers).add(site.from);
  };

  for (const chunk of chunkSymbols) {
    const sites: UseSite[] =
      chunk.use_sites ?? chunk.uses_symbols.map((name) => ({ name, from: '' }));
    const callerFile = fileKey(chunk.chunk_id);

    for (const site of sites) {
      const sym = site.name;
      // A string's `strip`, a `Map`'s `get`, `JSON.parse`: nothing of the project.
      if (site.external) continue;
      // An imported name need not be defined anywhere under it: `import Provider
      // from './provider'` names that module's default export, whatever it is called.
      const allDefs = definedBy.get(sym) ?? (site.module !== undefined ? new Set<string>() : null);
      if (!allDefs) continue;
      // A file-private definition is reachable only from its file, and there it
      // is the one meant: a module cannot also import a name it declares (an
      // imported name is the exported one, `import { Drawer as Trapdoor }`).
      const private_ = localIn.get(sym);
      const own =
        private_ && site.module === undefined
          ? [...private_].filter((id) => fileKey(id) === callerFile)
          : [];
      let defs =
        own.length > 0
          ? new Set(own)
          : private_
            ? new Set([...allDefs].filter((id) => !private_.has(id)))
            : allDefs;
      // `input.batch` is a call on an object, which a `def self.batch` cannot answer.
      const classOnly = site.onObject ? classMethodIn.get(sym) : undefined;
      if (classOnly) defs = new Set([...defs].filter((id) => !classOnly.has(id)));
      // A bare call next to a top-level definition of the name in the same file
      // (a script's helper `pairs(a, b)`) means that one.
      if (
        site.on === undefined &&
        site.module === undefined &&
        !site.lexical &&
        !site.onObject &&
        defs.size > 1
      ) {
        const owned = ownedIn.get(sym);
        const beside = [...defs].filter((id) => fileKey(id) === callerFile && !owned?.has(id));
        if (beside.length > 0) defs = new Set(beside);
      }
      // A `.d.ts` file declares what exists elsewhere (globals, a package's
      // types): nothing there is called.
      if (callerFile && !isDeclarationFile(callerFile)) {
        defs = new Set([...defs].filter((id) => !isDeclarationFile(id)));
      }
      // An imported name is the one its module defines (`import { parse } from
      // './names.js'`), through the barrels re-exporting it. A module the
      // project does not hold (generated code, not indexed) defines nothing here.
      let imported = false;
      let importedAs: Map<string, string> | null = null;
      if (site.module !== undefined && site.on === undefined && callerFile) {
        importedAs = importedDefinitions(
          callerFile,
          site.module,
          sym,
          definesIn,
          reexports,
          indexedFiles,
          defaultOf
        );
        if (importedAs) {
          const there = [...defs].filter((id) => importedAs!.get(fileKey(id)!) === sym);
          if (there.length > 0 || importedAs.size > 0 || isEsFile(callerFile)) {
            defs = new Set(there);
            imported = there.length > 0;
          }
        }
      } else if (
        callerFile &&
        esModules.has(callerFile) &&
        site.on === undefined &&
        !site.onObject &&
        !site.reexport
      ) {
        // In an ES module a name it does not import is its own, or a global.
        defs = new Set([...defs].filter((id) => fileKey(id) === callerFile));
      }
      // Imported under another name (`export { parse as parseName } from`,
      // `export { default as Provider } from`): the edge carries the name the
      // definition has, so the methods of the chunk it reaches are told apart.
      const aliased =
        importedAs && defs.size === 0 ? [...importedAs].filter(([, name]) => name !== sym) : [];
      if (aliased.length > 0) {
        for (const [file, name] of aliased) {
          for (const id of definedBy.get(name) ?? []) {
            if (fileKey(id) !== file || id === chunk.chunk_id) continue;
            if (only && !only(chunk.chunk_id, sym)) continue;
            addEdge(chunk.chunk_id, id, name, site, 'EXTRACTED');
          }
        }
        continue;
      }
      if (defs.size === 0) continue;
      if (only && !only(chunk.chunk_id, sym)) continue;

      let onClass:
        | ReturnType<typeof resolveClass>
        | ReturnType<typeof resolveLexical>
        | NonNullable<ReturnType<typeof resolveMember>>;
      if (site.lexical) {
        onClass = resolveLexical(
          site,
          definedIn.get(sym),
          [...defs].filter((id) => !ownedIn.get(sym)?.has(id))
        );
      } else if (site.on !== undefined && !site.constant) {
        const member = resolveMember(
          site,
          defs,
          callerFile,
          classes,
          definedIn.get(sym),
          [...defs].filter((id) => !ownedIn.get(sym)?.has(id))
        );
        if (member === null) continue;
        onClass = member ?? null;
        // `ThemeContext.Provider`, `api.fetch`: a member of an imported value,
        // defined (if anywhere in the project) in the file that value comes from.
        if (!member && site.module !== undefined && callerFile && isEsFile(callerFile)) {
          const home = importedDefinitions(
            callerFile,
            site.module,
            site.on,
            definesIn,
            reexports,
            indexedFiles,
            defaultOf
          );
          if (home) {
            defs = new Set([...defs].filter((id) => home.has(fileKey(id)!)));
            if (defs.size === 0) continue;
          }
        }
      } else {
        onClass = resolveClass(site, definedIn.get(sym));
      }
      // A Ruby constant the lookup does not find is a gem's (`ActiveRecord::Base`).
      if (site.constant && onClass === null) continue;
      const resolved = onClass !== null || imported;

      // Structural-noise cap: a symbol defined in too many chunks explodes into
      // a quadratic AMBIGUOUS fan-out with no navigational value. Each use we
      // encounter here avoids exactly `defs.size` edges — summing that across
      // all uses yields the same `uses × defines` total the eager pass would
      // have computed, but with no extra map or pre-pass. Count the symbol
      // itself once. A call resolved to its class is exempt: it links to that class only.
      if (!resolved && defs.size > maxDefinitionFanout) {
        stats.skippedEdges += defs.size;
        if (!skipped.has(sym)) {
          skipped.add(sym);
          stats.skippedSymbols += 1;
        }
        continue;
      }

      const targets = onClass ? onClass.chunks : [...defs];
      const ambiguous = onClass ? onClass.match === 'several' : targets.length > 1;

      for (const defChunkId of targets) {
        // Skip self-edges
        if (defChunkId === chunk.chunk_id) continue;

        let confidence: EdgeConfidence;
        if (onClass && !ambiguous) {
          confidence = onClass.match === 'exact' ? 'EXTRACTED' : 'INFERRED';
        } else if (ambiguous) {
          confidence = 'AMBIGUOUS';
        } else {
          const defFile = fileKey(defChunkId);
          confidence =
            imported || (callerFile && defFile && callerFile === defFile)
              ? 'EXTRACTED'
              : 'INFERRED';
        }

        addEdge(chunk.chunk_id, defChunkId, sym, site, confidence);
      }
    }
  }

  return {
    edges: [...edges.values()].map(({ callers, reach, ...edge }) => {
      // A use outside any method makes the whole chunk the caller.
      const whole = callers.has('');
      if (whole) return { ...edge, from_symbols: [] };
      const inner = innerOf.get(edge.from_chunk_id);
      if (inner) {
        // The chunk's other methods reaching the calling ones, with their steps.
        const steps = [...innerReach(inner, callers)].sort(
          (a, b) => a[1] - b[1] || a[0].localeCompare(b[0])
        );
        return {
          ...edge,
          from_symbols: [...callers],
          ...(steps.length > 0
            ? { reach_symbols: steps.map(([n]) => n), reach_steps: steps.map(([, d]) => d) }
            : {}),
        };
      }
      // Symbols stored by an older extraction: `through` uses, steps unknown.
      const further = [...reach].filter((name) => !callers.has(name));
      return {
        ...edge,
        from_symbols: [...callers],
        ...(further.length > 0 ? { reach_symbols: further } : {}),
      };
    }),
    stats,
  };
}
