import type { SymbolEdge } from './types.js';

/** Deepest walk `change_impact` accepts. Past three hops nearly everything connects. */
export const MAX_IMPACT_DEPTH = 3;

/** One chunk that depends, directly or through others, on the code being changed. */
export interface Dependent {
  chunkId: string;
  /** Chunks from the change: 1 = uses the changed code itself; 2 = uses a hop-1 dependent; and so on. */
  hop: number;
  /**
   * Method calls from the change to the nearest of its methods: 1 calls the
   * changed code, 2 calls a method that does, and so on, counting calls inside
   * a chunk between its methods too.
   */
  step: number;
  /**
   * False when `step` is only a lower bound: the nearest path goes through
   * calls inside a chunk whose symbols were stored before those were recorded.
   */
  exact: boolean;
  /** Each affected method of the chunk with its step (`''` for code outside any method). */
  methods: Array<{ name: string; step: number; exact: boolean }>;
  /** Names it uses from the chunks one hop closer to the change. */
  symbols: string[];
  /** The methods in it that make those calls; empty when the call is outside any method. */
  callers: string[];
  /**
   * Other methods of the chunk that reach `callers` through its own calls
   * (`write` calling `record_entry`), each at its own step in `methods`.
   */
  reach: string[];
  /**
   * False when every path to the change goes through a common name kept by
   * `confirmsLink`: the graph links by name, so such a caller may be using a
   * different definition.
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
  /** More leaves (tests) than `maxDependents` reached it; the rest are not listed. */
  testsTruncated: boolean;
  /** Chunks at the last hop have callers of their own that `depth` left unwalked. */
  deeper: boolean;
  /**
   * Chunks linked only through a common name (see `isCommonName`), per name,
   * most chunks first. Most are calls on other objects that share the name, so
   * they are neither listed as dependents nor followed.
   */
  viaCommonNames: Array<{ symbol: string; chunkIds: string[] }>;
  /**
   * Chunks linked only through a name defined in several places (AMBIGUOUS
   * edges), per name, most chunks first. Such a call on an object of unknown
   * class is most often another class's method of the same name (15% of them
   * were real in a blind check of a Ruby codebase), so they are set aside
   * like common names.
   */
  viaAmbiguousNames: Array<{ symbol: string; chunkIds: string[] }>;
}

export interface CollectDependentsOptions {
  /** The chunks being changed. Never reported as their own dependents. */
  seeds: string[];
  /** Incoming edges of a chunk (its callers), already filtered to what may be shown. */
  edgesTo: (chunkId: string) => SymbolEdge[];
  /**
   * Incoming edges through `method` to the other chunks of the chunk's file:
   * a method too long for one chunk is called where it begins, while the call
   * that makes it a dependent may sit in a later chunk.
   */
  edgesToMethod?: (chunkId: string, method: string) => SymbolEdge[];
  depth: number;
  /** At most this many dependents, and apart from them at most this many leaves. */
  maxDependents: number;
  /** Only callers using this name count at the first hop. */
  symbol?: string;
  /**
   * With `symbol`: the other methods of the changed chunks that call it through
   * their own chunk (a wrapper), each with its steps from it. Their callers
   * count at the first hop too, that many steps further.
   */
  seedSteps?: Map<string, number>;
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
  /** The class a method of a chunk belongs to (`Billing::Invoice`), when known. */
  ownerOf?: (chunkId: string, method: string) => string | undefined;
  /**
   * The class an edge's call is made on self from (a bare `total` or
   * `self.total` in `Billing::Refund`); null when some of its calls are not on
   * self, undefined when not known.
   */
  selfCallFrom?: (edge: SymbolEdge) => string | null | undefined;
}

/** The names a chunk's callers must use to be affected: some of its methods, or all of it. */
type Via = Set<string> | 'all';

/** What of the caller chunk an edge says is affected: its calling methods, or the whole chunk. */
function viaOf(edge: SymbolEdge): Via {
  if (!edge.from_symbols || edge.from_symbols.length === 0) return 'all';
  return new Set([...edge.from_symbols, ...(edge.reach_symbols ?? [])]);
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
 * level. Leaves are reported but not expanded. Hubs are expanded through the
 * methods they are reached by, after the rest of their hop, so a widely-called
 * helper fills the places left, not those of nearer code; a hub reached as a
 * whole chunk is not expanded.
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
  const ambiguous = new Map<string, Set<string>>();
  const setAside = (into: Map<string, Set<string>>, symbol: string, caller: string) => {
    if (found.has(caller)) return;
    let set = into.get(symbol);
    if (!set) into.set(symbol, (set = new Set()));
    set.add(caller);
  };
  // Per chunk, the names already followed (or queued) into its callers.
  const followed = new Map<string, Via>(opts.seeds.map((id) => [id, 'all']));
  let frontier = new Map<string, Via>(opts.seeds.map((id) => [id, 'all']));
  let truncated = false;
  let testsTruncated = false;
  // Leaves (tests) have a cap of their own: they are never walked, so they
  // must not take the places of code the walk would follow.
  let codeCount = 0;
  let leafCount = 0;
  // Per reached chunk, the step of each of its affected methods: a calling
  // method's own, one more at least for a method reaching it through the
  // chunk's own calls; `''` for calls made outside any method (the whole chunk).
  const methodSteps = new Map<string, Map<string, { step: number; exact: boolean }>>();
  const setStep = (chunk: string, name: string, step: number, exact: boolean) => {
    let steps = methodSteps.get(chunk);
    if (!steps) methodSteps.set(chunk, (steps = new Map()));
    const prev = steps.get(name);
    if (!prev || step < prev.step || (step === prev.step && exact && !prev.exact)) {
      steps.set(name, { step, exact });
    }
  };
  const recordSteps = (edge: SymbolEdge, step: number, exact: boolean) => {
    const from = edge.from_symbols ?? [];
    if (from.length === 0) setStep(edge.from_chunk_id, '', step, exact);
    for (const name of from) setStep(edge.from_chunk_id, name, step, exact);
    const reach = edge.reach_symbols ?? [];
    reach.forEach((name, i) => {
      const more = edge.reach_steps?.[i];
      // Without recorded steps (older symbols), only a lower bound is known.
      setStep(edge.from_chunk_id, name, step + (more ?? 1), exact && more !== undefined);
    });
  };
  const stepThrough = (target: string, edge: SymbolEdge): { step: number; exact: boolean } => {
    if (seeds.has(target)) return { step: opts.seedSteps?.get(edge.symbol_name) ?? 0, exact: true };
    const steps = methodSteps.get(target);
    const own = steps?.get(edge.symbol_name) ?? steps?.get('');
    if (own) return own;
    // Reached through no method it records: as near as the chunk's nearest method.
    const all = [...(steps?.values() ?? [])].sort(
      (x, y) => x.step - y.step || Number(y.exact) - Number(x.exact)
    );
    return all[0] ?? { step: found.get(target)?.step ?? 0, exact: false };
  };
  // Per reached chunk, per affected method: the class the object must be of
  // (`Sub`, reached through a call on self in `Base` that only an object of
  // `Sub` sends to the changed override), or null when it may be any object.
  // A call on self from another class below `Base` (a sibling of `Sub`)
  // never runs `Sub`'s code.
  const objectOf = new Map<string, Map<string, string | null>>();
  const objectFor = (chunk: string, name: string) => objectOf.get(chunk)?.get(name) ?? null;
  const bindObject = (chunk: string, via: Via, object: string | null) => {
    if (via === 'all') return;
    let methods = objectOf.get(chunk);
    if (!methods) objectOf.set(chunk, (methods = new Map()));
    for (const name of via) {
      const had = methods.get(name);
      methods.set(name, had === undefined ? object : had === object ? had : null);
    }
  };
  /** The class the caller's object must be of when it reaches `target` through `edge`, or null. */
  const objectThrough = (target: string, edge: SymbolEdge): string | null => {
    if (edge.relation_type === 'overrides') {
      return (
        objectFor(target, edge.symbol_name) ?? opts.ownerOf?.(target, edge.symbol_name) ?? null
      );
    }
    const object = objectFor(target, edge.symbol_name);
    return object !== null && typeof opts.selfCallFrom?.(edge) === 'string' ? object : null;
  };
  /** A call on self from a class other than the one the object must be of, nor the method's own. */
  const fromSibling = (target: string, edge: SymbolEdge): boolean => {
    const object = objectFor(target, edge.symbol_name);
    if (object === null) return false;
    const from = opts.selfCallFrom?.(edge);
    return (
      typeof from === 'string' &&
      from !== object &&
      from !== opts.ownerOf?.(target, edge.symbol_name)
    );
  };
  // Methods followed only for an object of one class: followed again when
  // they turn out to be reached for any object.
  const followedBound = new Map<string, Set<string>>();
  const better = (dep: Dependent, step: number, exact: boolean) =>
    step < dep.step || (step === dep.step && exact && !dep.exact);

  const followsEdge = (edge: SymbolEdge, via: Via, hop: number): boolean => {
    // A file opening a namespace (`module Billing`) calls nothing of it.
    if (edge.relation_type === 'opens') return false;
    if (
      hop === 1 &&
      opts.symbol !== undefined &&
      edge.symbol_name !== opts.symbol &&
      !opts.seedSteps?.has(edge.symbol_name)
    ) {
      return false;
    }
    // Code holding a class as a value (`references`) depends on the class, not on
    // one of its methods: what a framework or job queue calls on it is not in
    // the code, and in a blind check few such dependents were real.
    return via === 'all' || via.has(edge.symbol_name);
  };

  // A chunk's callers, and those of its methods that begin in an earlier chunk.
  const incoming = (target: string, via: Via): SymbolEdge[] => {
    const edges = opts.edgesTo(target);
    if (via === 'all' || !opts.edgesToMethod || seeds.has(target)) return edges;
    for (const method of via) {
      for (const edge of opts.edgesToMethod(target, method)) {
        if (edge.to_chunk_id !== target) edges.push({ ...edge, to_chunk_id: target });
      }
    }
    return edges;
  };

  for (let hop = 1; hop <= opts.depth && frontier.size > 0 && !truncated; hop++) {
    const level = new Map<string, Dependent>();
    const reached = new Map<string, Via>();
    for (const [target, via] of frontier) {
      const targetCertain = certainSoFar.get(target) ?? false;
      for (const edge of incoming(target, via)) {
        if (!followsEdge(edge, via, hop)) continue;
        const caller = edge.from_chunk_id;
        if (seeds.has(caller)) continue;
        if (fromSibling(target, edge)) continue;
        // Extracted edges name their target (same file, or `Class.method`), so
        // even a common name is a real link through them.
        const commonName =
          edge.confidence !== 'EXTRACTED' && (opts.isCommonName?.(edge.symbol_name) ?? false);
        if (commonName && !opts.confirmsLink?.(caller, target)) {
          setAside(common, edge.symbol_name, caller);
          continue;
        }
        if (edge.confidence === 'AMBIGUOUS') {
          setAside(ambiguous, edge.symbol_name, caller);
          continue;
        }

        const edgeVia = viaOf(edge);
        bindObject(caller, edgeVia, objectThrough(target, edge));
        const certain = targetCertain && !commonName;
        const through = stepThrough(target, edge);
        const step = through.step + 1;
        recordSteps(edge, step, through.exact);
        const known = found.get(caller);
        if (known) {
          // Already listed at a nearer hop: only its newly affected methods are followed.
          if (better(known, step, through.exact)) {
            known.step = step;
            known.exact = through.exact;
          }
          const prev = reached.get(caller);
          reached.set(caller, prev === undefined ? edgeVia : unionVia(prev, edgeVia));
          continue;
        }
        let dep = level.get(caller);
        if (!dep) {
          const leaf = opts.isLeaf?.(caller) ?? false;
          if ((leaf ? leafCount : codeCount) >= opts.maxDependents) {
            if (leaf) testsTruncated = true;
            else truncated = true;
            continue;
          }
          if (leaf) leafCount++;
          else codeCount++;
          dep = {
            chunkId: caller,
            hop,
            step,
            exact: through.exact,
            methods: [],
            symbols: [],
            callers: [],
            reach: [],
            certain,
            hub: opts.isHub(caller),
            reexport: true,
          };
          level.set(caller, dep);
        }
        if (better(dep, step, through.exact)) {
          dep.step = step;
          dep.exact = through.exact;
        }
        if (!dep.symbols.includes(edge.symbol_name)) dep.symbols.push(edge.symbol_name);
        for (const name of edge.from_symbols ?? []) {
          if (!dep.callers.includes(name)) dep.callers.push(name);
        }
        for (const name of edge.reach_symbols ?? []) {
          if (!dep.reach.includes(name)) dep.reach.push(name);
        }
        dep.certain ||= certain;
        dep.reexport &&= edge.relation_type === 'reexports';
        const prev = reached.get(caller);
        reached.set(caller, prev === undefined ? edgeVia : unionVia(prev, edgeVia));
      }
    }

    for (const dep of level.values()) {
      dep.reach = dep.reach.filter((name) => !dep.callers.includes(name));
      found.set(dep.chunkId, dep);
      certainSoFar.set(dep.chunkId, dep.certain);
    }
    // A hub is followed through the methods it is reached by, after the rest of
    // its hop, so when the walk runs out of places, what lies behind hubs goes
    // first. Reached as a whole chunk, every caller of any name in it would
    // count: a hub is not followed that way.
    frontier = new Map();
    const hubsNext = new Map<string, Via>();
    for (const [id, via] of reached) {
      const dep = found.get(id);
      if (!dep || opts.isLeaf?.(id) || (dep.hub && via === 'all')) continue;
      const open = via === 'all' ? via : new Set([...via].filter((n) => objectFor(id, n) === null));
      const added = open === 'all' || open.size > 0 ? mergeVia(followed, id, open) : null;
      // Bound to one class of object: followed now, and again if that is lifted.
      let bound = followedBound.get(id);
      if (!bound) followedBound.set(id, (bound = new Set()));
      const done = followed.get(id);
      const boundAdded =
        via === 'all'
          ? []
          : [...via].filter(
              (n) =>
                objectFor(id, n) !== null && !bound!.has(n) && !(done === 'all' || done?.has(n))
            );
      for (const n of boundAdded) bound.add(n);
      const next: Via | null =
        added === 'all'
          ? 'all'
          : added || boundAdded.length > 0
            ? new Set([...(added ?? []), ...boundAdded])
            : null;
      if (next) (dep.hub ? hubsNext : frontier).set(id, next);
    }
    for (const [id, via] of hubsNext) frontier.set(id, via);
  }

  const deeper =
    !truncated &&
    [...frontier].some(([id, via]) =>
      incoming(id, via).some(
        (e) =>
          (via === 'all' || via.has(e.symbol_name)) &&
          e.relation_type !== 'opens' &&
          !seeds.has(e.from_chunk_id) &&
          !found.has(e.from_chunk_id) &&
          e.confidence !== 'AMBIGUOUS' &&
          !opts.isCommonName?.(e.symbol_name)
      )
    );
  // A chunk also reached through a real link is a dependent, not a coincidence.
  const byName = (from: Map<string, Set<string>>) =>
    [...from.entries()]
      .map(([symbol, ids]) => ({ symbol, chunkIds: [...ids].filter((id) => !found.has(id)) }))
      .filter((c) => c.chunkIds.length > 0)
      .sort((a, b) => b.chunkIds.length - a.chunkIds.length || a.symbol.localeCompare(b.symbol));
  return {
    dependents: [...found.values()].map((dep) => ({
      ...dep,
      methods: [...(methodSteps.get(dep.chunkId) ?? [])]
        .map(([name, at]) => ({ name, ...at }))
        .sort((a, b) => a.step - b.step || a.name.localeCompare(b.name)),
    })),
    truncated,
    testsTruncated,
    deeper,
    viaCommonNames: byName(common),
    viaAmbiguousNames: byName(ambiguous),
  };
}

function unionVia(a: Via, b: Via): Via {
  if (a === 'all' || b === 'all') return 'all';
  return new Set([...a, ...b]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The line `name` is defined on in a chunk (0-indexed, like `startLine`), or
 * null when no definition of it is found there. With `calls`, of several
 * definitions of the name (Ruby `def self.call` and `def call`), the one
 * whose body uses one of those names: the one making the call.
 */
export function definitionLine(
  content: string,
  startLine: number,
  name: string,
  file: string,
  calls: string[] = []
): number | null {
  const n = escapeRe(name);
  const keyword = new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:def\\s+(?:self\\.)?|function\\s*\\*?\\s*|func\\s+(?:\\([^)]*\\)\\s*)?|fn\\s+|(?:const|let|var)\\s+)${n}(?![\\w?!])`
  );
  const lines = content.split('\n');
  let found = lines.flatMap((l, i) => (keyword.test(l) ? [i] : []));
  if (found.length === 0 && !/\.(?:rb|rake|py)$/.test(file)) {
    const method = new RegExp(
      `^\\s*(?:(?:public|private|protected|internal|static|async|readonly|override|abstract|final|get|set)\\s+)*\\*?${n}\\s*[(<].*\\{\\s*$`
    );
    found = lines.flatMap((l, i) => (method.test(l) ? [i] : []));
  }
  if (found.length === 0) return null;
  if (found.length > 1 && calls.length > 0) {
    const used = new RegExp(`(?<![\\w$])(?:${calls.map(escapeRe).join('|')})(?![\\w$?!])`);
    const indent = (l: string) => l.length - l.trimStart().length;
    for (const i of found) {
      const own = indent(lines[i]!);
      let end = i + 1;
      while (end < lines.length) {
        const l = lines[end]!;
        if (l.trim() !== '' && indent(l) <= own && !/^\s*[}\])]/.test(l) && !/^\s*end\b/.test(l))
          break;
        end++;
      }
      if (lines.slice(i + 1, end).some((l) => used.test(l))) return startLine + i;
    }
  }
  return startLine + found[0]!;
}
