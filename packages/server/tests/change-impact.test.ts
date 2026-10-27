import { describe, expect, it } from 'vitest';
import { collectDependents } from '../src/change-impact.js';
import { buildSymbolEdges } from '../src/symbol-graph.js';
import type { EdgeConfidence, SymbolEdge } from '../src/types.js';

/** Edges as `[caller, callee, symbol, confidence?, calling methods?]`. */
function graph(edges: Array<[string, string, string, EdgeConfidence?, string[]?]>) {
  const rows: SymbolEdge[] = edges.map(([from, to, sym, confidence, fromSymbols]) => ({
    from_chunk_id: from,
    to_chunk_id: to,
    relation_type: 'calls',
    symbol_name: sym,
    ...(confidence ? { confidence } : {}),
    ...(fromSymbols ? { from_symbols: fromSymbols } : {}),
  }));
  return (id: string) => rows.filter((e) => e.to_chunk_id === id);
}

const base = { depth: 2, maxDependents: 50, isHub: () => false };

describe('collectDependents', () => {
  it('walks callers hop by hop and reports each chunk once, at its nearest hop', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['b', 'a', 'g'],
      ['b', 'seed', 'f'],
      ['c', 'b', 'h'],
    ]);
    const { dependents, deeper } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => [d.chunkId, d.hop])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 2],
    ]);
    expect(deeper).toBe(false);
  });

  it('passes the change on only through the calling method, not its neighbours in the chunk', () => {
    // `config` holds two methods; only `description` calls the seed.
    const edgesTo = graph([
      ['config', 'seed', 'f', 'INFERRED', ['description']],
      ['page', 'config', 'description'],
      ['header', 'config', 'title'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => [d.chunkId, d.hop, d.callers])).toEqual([
      ['config', 1, ['description']],
      ['page', 2, []],
    ]);
  });

  it('follows a chunk again when a later hop reaches another of its methods', () => {
    const edgesTo = graph([
      ['config', 'seed', 'f', 'INFERRED', ['description']],
      ['helper', 'seed', 'f', 'INFERRED', ['run']],
      ['config', 'helper', 'run', 'INFERRED', ['title']],
      ['header', 'config', 'title'],
    ]);
    const { dependents } = collectDependents({ ...base, depth: 3, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => d.chunkId)).toEqual(['config', 'helper', 'header']);
  });

  it('keeps a common name when the edge names its target', () => {
    const edgesTo = graph([
      ['a', 'seed', 'create', 'EXTRACTED'],
      ['b', 'seed', 'create', 'INFERRED'],
    ]);
    const { dependents, viaCommonNames } = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isCommonName: (n) => n === 'create',
    });
    expect(dependents.map((d) => [d.chunkId, d.certain])).toEqual([['a', true]]);
    expect(viaCommonNames).toEqual([{ symbol: 'create', chunkIds: ['b'] }]);
  });

  it('collects every name a dependent uses from the previous level', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['a', 'seed', 'g'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(dependents[0]?.symbols).toEqual(['f', 'g']);
  });

  it('never reports a seed, even when seeds call each other', () => {
    const edgesTo = graph([
      ['s2', 's1', 'f'],
      ['a', 's2', 'g'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['s1', 's2'], edgesTo });
    expect(dependents.map((d) => d.chunkId)).toEqual(['a']);
  });

  it('filters the first hop by symbol only', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['x', 'seed', 'other'],
      ['b', 'a', 'unrelated'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo, symbol: 'f' });
    expect(dependents.map((d) => d.chunkId)).toEqual(['a', 'b']);
  });

  it('marks a dependent uncertain only when every path to it is ambiguous', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f', 'AMBIGUOUS'],
      ['b', 'a', 'g', 'INFERRED'],
      ['c', 'seed', 'f', 'AMBIGUOUS'],
      ['c', 'seed', 'h', 'EXTRACTED'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    const certain = Object.fromEntries(dependents.map((d) => [d.chunkId, d.certain]));
    expect(certain).toEqual({ a: false, c: true, b: false });
  });

  it('lists hubs and leaves without following their callers', () => {
    const edgesTo = graph([
      ['hub', 'seed', 'f'],
      ['test', 'seed', 'f'],
      ['behindHub', 'hub', 'g'],
      ['behindTest', 'test', 'g'],
    ]);
    const { dependents } = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isHub: (id) => id === 'hub',
      isLeaf: (id) => id === 'test',
    });
    expect(dependents.map((d) => [d.chunkId, d.hub])).toEqual([
      ['hub', true],
      ['test', false],
    ]);
  });

  it('stops at maxDependents and says so', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['b', 'seed', 'f'],
      ['c', 'seed', 'f'],
    ]);
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo, maxDependents: 2 });
    expect(res.dependents).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('sets aside callers linked only through a common name, and does not follow them', () => {
    const edgesTo = graph([
      ['real', 'seed', 'enqueue'],
      ['setUser', 'seed', 'add'],
      ['setUser2', 'seed', 'add'],
      ['both', 'seed', 'add'],
      ['both', 'real', 'run'],
      ['behindSetUser', 'setUser', 'build'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isCommonName: (s) => s === 'add',
    });
    expect(res.dependents.map((d) => [d.chunkId, d.hop])).toEqual([
      ['real', 1],
      ['both', 2],
    ]);
    // `both` is reached through a real link too, so it is a dependent, not a coincidence.
    expect(res.viaCommonNames).toEqual([{ symbol: 'add', chunkIds: ['setUser', 'setUser2'] }]);
    expect(res.dependents.some((d) => d.chunkId === 'behindSetUser')).toBe(false);
  });

  it('keeps a common-name caller the file link confirms, as uncertain', () => {
    const edgesTo = graph([
      ['queueUser', 'seed', 'add'],
      ['setUser', 'seed', 'add'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isCommonName: (s) => s === 'add',
      confirmsLink: (caller) => caller === 'queueUser',
    });
    expect(res.dependents.map((d) => [d.chunkId, d.certain])).toEqual([['queueUser', false]]);
    expect(res.viaCommonNames).toEqual([{ symbol: 'add', chunkIds: ['setUser'] }]);
  });

  it('does not count common-name callers as deeper work', () => {
    const edgesTo = graph([
      ['a', 'seed', 'enqueue'],
      ['x', 'a', 'get'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      depth: 1,
      isCommonName: (s) => s === 'get',
    });
    expect(res.deeper).toBe(false);
  });

  it('reports callers left beyond depth', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['b', 'a', 'g'],
    ]);
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo, depth: 1 });
    expect(res.dependents.map((d) => d.chunkId)).toEqual(['a']);
    expect(res.deeper).toBe(true);
    expect(res.truncated).toBe(false);
  });
  it('lists a barrel file that re-exports the change, without following its other names', () => {
    // lib.ts re-exports `toName` and defines `version` in the same chunk; `cli` only uses `version`.
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//names.ts//0-9//a', defines_symbols: ['toName'], uses_symbols: [] },
      {
        chunk_id: 'g//p//lib.ts//0-9//b',
        defines_symbols: ['version'],
        uses_symbols: ['toName'],
        use_sites: [{ name: 'toName', from: 'toName', reexport: true }],
      },
      {
        chunk_id: 'g//p//cli.ts//0-9//c',
        defines_symbols: [],
        uses_symbols: ['version'],
        use_sites: [{ name: 'version', from: '' }],
      },
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['g//p//names.ts//0-9//a'],
      edgesTo: (id) => edges.filter((e) => e.to_chunk_id === id),
    });
    expect(res.dependents.map((d) => [d.chunkId, d.symbols, d.reexport])).toEqual([
      ['g//p//lib.ts//0-9//b', ['toName'], true],
    ]);
    expect(edges.find((x) => x.symbol_name === 'toName')?.relation_type).toBe('references');
  });
});
