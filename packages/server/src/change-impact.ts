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
  /**
   * False when every path to the change goes through a name defined in several
   * chunks (an AMBIGUOUS edge): the graph links by name, so such a caller may be
   * using a different definition.
   */
  certain: boolean;
  /** A high-degree chunk. Listed, but its own dependents are not followed. */
  hub: boolean;
}

export interface DependentsResult {
  dependents: Dependent[];
  /** The walk stopped at `maxDependents` with more left to visit. */
  truncated: boolean;
  /** Chunks at the last hop have callers of their own that `depth` left unwalked. */
  deeper: boolean;
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
}

/**
 * Breadth-first walk over incoming symbol edges from `seeds`: everything that
 * would have to be checked if the seeds changed. Each chunk is reported once,
 * at the hop it is first reached, with every name it uses from the previous
 * level. Hubs and leaves are reported but not expanded, which keeps one
 * widely-called helper from pulling in half the codebase.
 */
export function collectDependents(opts: CollectDependentsOptions): DependentsResult {
  const seeds = new Set(opts.seeds);
  const found = new Map<string, Dependent>();
  const certainSoFar = new Map<string, boolean>(opts.seeds.map((id) => [id, true]));
  let frontier = [...seeds];
  let truncated = false;

  for (let hop = 1; hop <= opts.depth && frontier.length > 0 && !truncated; hop++) {
    const level = new Map<string, Dependent>();
    for (const target of frontier) {
      const targetCertain = certainSoFar.get(target) ?? false;
      for (const edge of opts.edgesTo(target)) {
        if (hop === 1 && opts.symbol !== undefined && edge.symbol_name !== opts.symbol) continue;
        const caller = edge.from_chunk_id;
        if (seeds.has(caller) || found.has(caller)) continue;

        const certain = targetCertain && edge.confidence !== 'AMBIGUOUS';
        let dep = level.get(caller);
        if (!dep) {
          if (found.size + level.size >= opts.maxDependents) {
            truncated = true;
            continue;
          }
          dep = { chunkId: caller, hop, symbols: [], certain, hub: opts.isHub(caller) };
          level.set(caller, dep);
        }
        if (!dep.symbols.includes(edge.symbol_name)) dep.symbols.push(edge.symbol_name);
        dep.certain ||= certain;
      }
    }

    frontier = [];
    for (const dep of level.values()) {
      found.set(dep.chunkId, dep);
      certainSoFar.set(dep.chunkId, dep.certain);
      if (!dep.hub && !opts.isLeaf?.(dep.chunkId)) frontier.push(dep.chunkId);
    }
  }

  const deeper =
    !truncated &&
    frontier.some((id) =>
      opts.edgesTo(id).some((e) => !seeds.has(e.from_chunk_id) && !found.has(e.from_chunk_id))
    );
  return { dependents: [...found.values()], truncated, deeper };
}
