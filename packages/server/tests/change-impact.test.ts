import { describe, expect, it } from 'vitest';
import { collectDependents } from '../src/change-impact.js';
import type { EdgeConfidence, SymbolEdge } from '../src/types.js';

/** Edges as `[caller, callee, symbol, confidence?]`. */
function graph(edges: Array<[string, string, string, EdgeConfidence?]>) {
  const rows: SymbolEdge[] = edges.map(([from, to, sym, confidence]) => ({
    from_chunk_id: from,
    to_chunk_id: to,
    relation_type: 'calls',
    symbol_name: sym,
    ...(confidence ? { confidence } : {}),
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
});
