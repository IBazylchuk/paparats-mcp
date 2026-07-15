import { describe, it, expect } from 'vitest';
import { buildSymbolEdges, MAX_DEFINITION_FANOUT } from '../src/symbol-graph.js';

describe('buildSymbolEdges', () => {
  it('creates edges from usage to definition', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//f1.ts//1-5//h1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//f2.ts//1-5//h2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      from_chunk_id: 'g//p//f2.ts//1-5//h2',
      to_chunk_id: 'g//p//f1.ts//1-5//h1',
      relation_type: 'calls',
      symbol_name: 'greet',
      confidence: 'INFERRED',
    });
  });

  it('labels intra-file edges as EXTRACTED (same `<group>//<project>//<file>` prefix)', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//same.ts//1-5//h1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//same.ts//6-10//h2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.confidence).toBe('EXTRACTED');
  });

  it('labels edges AMBIGUOUS when a symbol resolves to multiple chunks', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//a.ts//1-5//h1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//b.ts//1-5//h2', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//c.ts//1-5//h3', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.confidence === 'AMBIGUOUS')).toBe(true);
  });

  it('creates multiple edges for multiple symbols', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['foo', 'bar'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['foo', 'bar'] },
    ]);

    expect(edges).toHaveLength(2);
    const symbols = edges.map((e) => e.symbol_name).sort();
    expect(symbols).toEqual(['bar', 'foo']);
  });

  it('skips self-edges', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(0);
  });

  it('deduplicates edges by (from, to, symbol)', () => {
    // Same symbol defined in same chunk, used by same chunk - should only appear once
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
  });

  it('handles multiple callers for one definition', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'def', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'caller1', defines_symbols: [], uses_symbols: ['greet'] },
      { chunk_id: 'caller2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.to_chunk_id === 'def')).toBe(true);
  });

  it('handles symbol defined in multiple chunks', () => {
    const { edges } = buildSymbolEdges([
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
    expect(buildSymbolEdges([])).toEqual({
      edges: [],
      stats: { skippedSymbols: 0, skippedEdges: 0 },
    });
  });

  it('returns empty array when no cross-references exist', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['foo'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: ['bar'], uses_symbols: [] },
    ]);

    expect(edges).toEqual([]);
  });

  describe('high-fanout cap', () => {
    it('skips a symbol defined in more chunks than the fanout cap', () => {
      // `Business` is defined in 3 chunks; with a cap of 2 it is structural
      // noise and must not link the caller to any of them.
      const chunks = [
        { chunk_id: 'def1', defines_symbols: ['Business'], uses_symbols: [] },
        { chunk_id: 'def2', defines_symbols: ['Business'], uses_symbols: [] },
        { chunk_id: 'def3', defines_symbols: ['Business'], uses_symbols: [] },
        { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['Business'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks, 2);

      expect(edges).toHaveLength(0);
      expect(stats.skippedSymbols).toBe(1);
      // 1 caller × 3 definitions = 3 edges avoided.
      expect(stats.skippedEdges).toBe(3);
    });

    it('keeps a symbol defined at exactly the cap (boundary is >, not >=)', () => {
      const chunks = [
        { chunk_id: 'def1', defines_symbols: ['helper'], uses_symbols: [] },
        { chunk_id: 'def2', defines_symbols: ['helper'], uses_symbols: [] },
        { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['helper'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks, 2);

      expect(edges).toHaveLength(2);
      expect(stats.skippedSymbols).toBe(0);
      expect(stats.skippedEdges).toBe(0);
    });

    it('counts a skipped symbol once even when many chunks use it', () => {
      const chunks = [
        { chunk_id: 'def1', defines_symbols: ['ns'], uses_symbols: [] },
        { chunk_id: 'def2', defines_symbols: ['ns'], uses_symbols: [] },
        { chunk_id: 'def3', defines_symbols: ['ns'], uses_symbols: [] },
        { chunk_id: 'c1', defines_symbols: [], uses_symbols: ['ns'] },
        { chunk_id: 'c2', defines_symbols: [], uses_symbols: ['ns'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks, 2);

      expect(edges).toHaveLength(0);
      expect(stats.skippedSymbols).toBe(1);
      // 2 callers × 3 definitions.
      expect(stats.skippedEdges).toBe(6);
    });

    it('defaults to MAX_DEFINITION_FANOUT and keeps normal symbols', () => {
      // Well under the default cap — nothing is skipped.
      const chunks = [
        { chunk_id: 'def', defines_symbols: ['greet'], uses_symbols: [] },
        { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['greet'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks);

      expect(MAX_DEFINITION_FANOUT).toBeGreaterThan(1);
      expect(edges).toHaveLength(1);
      expect(stats.skippedSymbols).toBe(0);
    });
  });
});
