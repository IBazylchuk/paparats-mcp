import { describe, it, expect } from 'vitest';
import { buildSymbolEdges } from '../src/symbol-graph.js';

describe('buildSymbolEdges', () => {
  it('creates edges from usage to definition', () => {
    const edges = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      from_chunk_id: 'b',
      to_chunk_id: 'a',
      relation_type: 'calls',
      symbol_name: 'greet',
    });
  });

  it('creates multiple edges for multiple symbols', () => {
    const edges = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['foo', 'bar'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['foo', 'bar'] },
    ]);

    expect(edges).toHaveLength(2);
    const symbols = edges.map((e) => e.symbol_name).sort();
    expect(symbols).toEqual(['bar', 'foo']);
  });

  it('skips self-edges', () => {
    const edges = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(0);
  });

  it('deduplicates edges by (from, to, symbol)', () => {
    // Same symbol defined in same chunk, used by same chunk - should only appear once
    const edges = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
  });

  it('handles multiple callers for one definition', () => {
    const edges = buildSymbolEdges([
      { chunk_id: 'def', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'caller1', defines_symbols: [], uses_symbols: ['greet'] },
      { chunk_id: 'caller2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.to_chunk_id === 'def')).toBe(true);
  });

  it('handles symbol defined in multiple chunks', () => {
    const edges = buildSymbolEdges([
      { chunk_id: 'def1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'def2', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    // Caller -> def1 and Caller -> def2
    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.to_chunk_id).sort();
    expect(targets).toEqual(['def1', 'def2']);
  });

  it('returns empty array for no input', () => {
    expect(buildSymbolEdges([])).toEqual([]);
  });

  it('returns empty array when no cross-references exist', () => {
    const edges = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['foo'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: ['bar'], uses_symbols: [] },
    ]);

    expect(edges).toEqual([]);
  });
});
