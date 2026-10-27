import type { UseSite } from './ast-symbol-extractor.js';
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
}

const CONFIDENCE_RANK: Record<EdgeConfidence, number> = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };

/** A class held as a value says most (`change_impact` follows it whatever changed), a re-export least. */
const RELATION_RANK: Record<RelationType, number> = {
  reexports: 0,
  calls: 1,
  called_by: 1,
  referenced_by: 1,
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
 *   as it is; a relative `Parser` called from `Extraction::Pipeline` as
 *   `Extraction::Pipeline::Parser`, then `Extraction::Parser`, then `Parser`.
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
 * Build cross-chunk symbol edges from chunk symbol data.
 *
 * For each use in a chunk, finds the chunks that define the name and creates a
 * `'calls'` edge (from_chunk → to_chunk via symbol). When the call names the
 * class it is made on (`Usage.claim`, `self.claim`) and {@link resolveClass}
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
 *   candidates with low confidence.
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

  const edges = new Map<string, SymbolEdge & { callers: Set<string>; reach: Set<string> }>();
  const skipped = new Set<string>();
  const stats: SymbolEdgeStats = { skippedSymbols: 0, skippedEdges: 0 };

  for (const chunk of chunkSymbols) {
    const sites: UseSite[] =
      chunk.use_sites ?? chunk.uses_symbols.map((name) => ({ name, from: '' }));
    const callerFile = fileKey(chunk.chunk_id);

    for (const site of sites) {
      const sym = site.name;
      const allDefs = definedBy.get(sym);
      if (!allDefs) continue;
      // A file-private definition is reachable only from its file, and there it
      // is the one meant: a module cannot also import a name it declares.
      const private_ = localIn.get(sym);
      const own = private_ ? [...private_].filter((id) => fileKey(id) === callerFile) : [];
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
      if (site.on === undefined && !site.lexical && !site.onObject && defs.size > 1) {
        const owned = ownedIn.get(sym);
        const beside = [...defs].filter((id) => fileKey(id) === callerFile && !owned?.has(id));
        if (beside.length > 0) defs = new Set(beside);
      }
      if (defs.size === 0) continue;
      if (only && !only(chunk.chunk_id, sym)) continue;

      const onClass = site.lexical
        ? resolveLexical(
            site,
            definedIn.get(sym),
            [...defs].filter((id) => !ownedIn.get(sym)?.has(id))
          )
        : resolveClass(site, definedIn.get(sym));
      // A Ruby constant the lookup does not find is a gem's (`ActiveRecord::Base`).
      if (site.constant && onClass === null) continue;
      const resolved = onClass !== null;

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
          confidence = callerFile && defFile && callerFile === defFile ? 'EXTRACTED' : 'INFERRED';
        }

        const key = `${chunk.chunk_id}\0${defChunkId}\0${sym}`;
        let edge = edges.get(key);
        if (!edge) {
          edge = {
            from_chunk_id: chunk.chunk_id,
            to_chunk_id: defChunkId,
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
      }
    }
  }

  return {
    edges: [...edges.values()].map(({ callers, reach, ...edge }) => {
      // A use outside any method makes the whole chunk the caller.
      const whole = callers.has('');
      const further = whole ? [] : [...reach].filter((name) => !callers.has(name));
      return {
        ...edge,
        from_symbols: whole ? [] : [...callers],
        ...(further.length > 0 ? { reach_symbols: further } : {}),
      };
    }),
    stats,
  };
}
