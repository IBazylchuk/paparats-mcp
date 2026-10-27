import type { SymbolEdge } from './types.js';

/** Deepest walk `change_impact` accepts. Past three hops nearly everything connects. */
export const MAX_IMPACT_DEPTH = 3;

/** One chunk that depends, directly or through others, on the code being changed. */
export interface Dependent {
  chunkId: string;
  /** 1 = uses the changed code itself; 2 = uses a hop-1 dependent; and so on. */
  hop: number;
  /** Names it uses from the chunks one hop closer to the change. */
  symbols: string[];
  /** The methods in it that make those calls; empty when the call is outside any method. */
  callers: string[];
  /**
   * False when every path to the change goes through a name defined in several
   * chunks (an AMBIGUOUS edge) or a common name kept by `confirmsLink`: the
   * graph links by name, so such a caller may be using a different definition.
   */
  certain: boolean;
  /** A high-degree chunk. Listed, but its own dependents are not followed. */
  hub: boolean;
  /** Reached only through re-exports (`export { x } from`): a barrel file, not a caller. */
  reexport: boolean;
}

export interface DependentsResult {
  dependents: Dependent[];
  /** The walk stopped at `maxDependents` with more left to visit. */
  truncated: boolean;
  /** Chunks at the last hop have callers of their own that `depth` left unwalked. */
  deeper: boolean;
  /**
   * Chunks linked only through a common name (see `isCommonName`), per name,
   * most chunks first. Most are calls on other objects that share the name, so
   * they are neither listed as dependents nor followed.
   */
  viaCommonNames: Array<{ symbol: string; chunkIds: string[] }>;
}

export interface CollectDependentsOptions {
  /** The chunks being changed. Never reported as their own dependents. */
  seeds: string[];
  /** Incoming edges of a chunk (its callers), already filtered to what may be shown. */
  edgesTo: (chunkId: string) => SymbolEdge[];
  depth: number;
  maxDependents: number;
  /** Only callers using this name count at the first hop. */
  symbol?: string;
  isHub: (chunkId: string) => boolean;
  /** Chunks whose dependents are not followed (tests: nothing meaningful calls them). */
  isLeaf?: (chunkId: string) => boolean;
  /** Names too common to trust as a link; edges through them are set aside. */
  isCommonName?: (symbol: string) => boolean;
  /**
   * Whether a caller linked to `target` through a common name is still likely
   * real — e.g. its file also uses a specific name from the target's file, as
   * `queue.add(...)` next to `new TriggerQueue()`. Such a caller is kept, as an
   * uncertain dependent.
   */
  confirmsLink?: (callerChunkId: string, targetChunkId: string) => boolean;
}

/** The names a chunk's callers must use to be affected: some of its methods, or all of it. */
type Via = Set<string> | 'all';

/** What of the caller chunk an edge says is affected: its calling methods, or the whole chunk. */
function viaOf(edge: SymbolEdge): Via {
  return edge.from_symbols && edge.from_symbols.length > 0 ? new Set(edge.from_symbols) : 'all';
}

/** Adds `more` to `into`; returns what was not in it before ('all' stands for any name). */
function mergeVia(into: Map<string, Via>, id: string, more: Via): Via | null {
  const have = into.get(id);
  if (have === 'all') return null;
  if (more === 'all') {
    into.set(id, 'all');
    return 'all';
  }
  if (!have) {
    into.set(id, new Set(more));
    return more;
  }
  const added = new Set([...more].filter((name) => !have.has(name)));
  for (const name of added) have.add(name);
  return added.size > 0 ? added : null;
}

/**
 * Breadth-first walk over incoming symbol edges from `seeds`: everything that
 * would have to be checked if the seeds changed. Each chunk is reported once,
 * at the hop it is first reached, with every name it uses from the previous
 * level. Hubs and leaves are reported but not expanded, which keeps one
 * widely-called helper from pulling in half the codebase.
 *
 * The walk follows methods, not whole chunks: a chunk reached because its
 * method `a` calls the change passes the change on only to callers of `a`, not
 * to callers of `b` sitting in the same chunk. A chunk reached again later
 * through another of its methods is followed through that one too.
 */
export function collectDependents(opts: CollectDependentsOptions): DependentsResult {
  const seeds = new Set(opts.seeds);
  const found = new Map<string, Dependent>();
  const certainSoFar = new Map<string, boolean>(opts.seeds.map((id) => [id, true]));
  const common = new Map<string, Set<string>>();
  // Per chunk, the names already followed (or queued) into its callers.
  const followed = new Map<string, Via>(opts.seeds.map((id) => [id, 'all']));
  let frontier = new Map<string, Via>(opts.seeds.map((id) => [id, 'all']));
  let truncated = false;

  const followsEdge = (edge: SymbolEdge, via: Via, hop: number): boolean => {
    if (hop === 1 && opts.symbol !== undefined && edge.symbol_name !== opts.symbol) return false;
    return via === 'all' || via.has(edge.symbol_name);
  };

  for (let hop = 1; hop <= opts.depth && frontier.size > 0 && !truncated; hop++) {
    const level = new Map<string, Dependent>();
    const reached = new Map<string, Via>();
    for (const [target, via] of frontier) {
      const targetCertain = certainSoFar.get(target) ?? false;
      for (const edge of opts.edgesTo(target)) {
        if (!followsEdge(edge, via, hop)) continue;
        const caller = edge.from_chunk_id;
        if (seeds.has(caller)) continue;
        // Extracted edges name their target (same file, or `Class.method`), so
        // even a common name is a real link through them.
        const commonName =
          edge.confidence !== 'EXTRACTED' && (opts.isCommonName?.(edge.symbol_name) ?? false);
        if (commonName && !opts.confirmsLink?.(caller, target)) {
          if (!found.has(caller)) {
            let set = common.get(edge.symbol_name);
            if (!set) common.set(edge.symbol_name, (set = new Set()));
            set.add(caller);
          }
          continue;
        }

        const edgeVia = viaOf(edge);
        const certain = targetCertain && !commonName && edge.confidence !== 'AMBIGUOUS';
        if (found.has(caller)) {
          // Already listed at a nearer hop: only its newly affected methods are followed.
          const prev = reached.get(caller);
          reached.set(caller, prev === undefined ? edgeVia : unionVia(prev, edgeVia));
          continue;
        }
        let dep = level.get(caller);
        if (!dep) {
          if (found.size + level.size >= opts.maxDependents) {
            truncated = true;
            continue;
          }
          dep = {
            chunkId: caller,
            hop,
            symbols: [],
            callers: [],
            certain,
            hub: opts.isHub(caller),
            reexport: true,
          };
          level.set(caller, dep);
        }
        if (!dep.symbols.includes(edge.symbol_name)) dep.symbols.push(edge.symbol_name);
        for (const name of edge.from_symbols ?? []) {
          if (!dep.callers.includes(name)) dep.callers.push(name);
        }
        dep.certain ||= certain;
        dep.reexport &&= edge.relation_type === 'references';
        const prev = reached.get(caller);
        reached.set(caller, prev === undefined ? edgeVia : unionVia(prev, edgeVia));
      }
    }

    for (const dep of level.values()) {
      found.set(dep.chunkId, dep);
      certainSoFar.set(dep.chunkId, dep.certain);
    }
    frontier = new Map();
    for (const [id, via] of reached) {
      const dep = found.get(id);
      if (!dep || dep.hub || opts.isLeaf?.(id)) continue;
      const added = mergeVia(followed, id, via);
      if (added) frontier.set(id, added);
    }
  }

  const deeper =
    !truncated &&
    [...frontier].some(([id, via]) =>
      opts
        .edgesTo(id)
        .some(
          (e) =>
            (via === 'all' || via.has(e.symbol_name)) &&
            !seeds.has(e.from_chunk_id) &&
            !found.has(e.from_chunk_id) &&
            !opts.isCommonName?.(e.symbol_name)
        )
    );
  // A chunk also reached through a real link is a dependent, not a coincidence.
  const viaCommonNames = [...common.entries()]
    .map(([symbol, ids]) => ({ symbol, chunkIds: [...ids].filter((id) => !found.has(id)) }))
    .filter((c) => c.chunkIds.length > 0)
    .sort((a, b) => b.chunkIds.length - a.chunkIds.length || a.symbol.localeCompare(b.symbol));
  return { dependents: [...found.values()], truncated, deeper, viaCommonNames };
}

function unionVia(a: Via, b: Via): Via {
  if (a === 'all' || b === 'all') return 'all';
  return new Set([...a, ...b]);
}
