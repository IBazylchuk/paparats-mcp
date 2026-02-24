import type { SymbolEdge } from './types.js';

/**
 * Build cross-chunk symbol edges from chunk symbol data.
 *
 * For each chunk's `uses_symbols`, finds chunks that define those symbols
 * and creates a `'calls'` edge (from_chunk → to_chunk via symbol).
 *
 * Skips self-edges and deduplicates by (from, to, symbol) triple.
 */
export function buildSymbolEdges(
  chunkSymbols: Array<{
    chunk_id: string;
    defines_symbols: string[];
    uses_symbols: string[];
  }>
): SymbolEdge[] {
  // Build inverted index: symbol → set of defining chunk IDs
  const definedBy = new Map<string, Set<string>>();
  for (const chunk of chunkSymbols) {
    for (const sym of chunk.defines_symbols) {
      let set = definedBy.get(sym);
      if (!set) {
        set = new Set();
        definedBy.set(sym, set);
      }
      set.add(chunk.chunk_id);
    }
  }

  const edges: SymbolEdge[] = [];
  const seen = new Set<string>();

  for (const chunk of chunkSymbols) {
    for (const sym of chunk.uses_symbols) {
      const defChunks = definedBy.get(sym);
      if (!defChunks) continue;

      for (const defChunkId of defChunks) {
        // Skip self-edges
        if (defChunkId === chunk.chunk_id) continue;

        const key = `${chunk.chunk_id}\0${defChunkId}\0${sym}`;
        if (seen.has(key)) continue;
        seen.add(key);

        edges.push({
          from_chunk_id: chunk.chunk_id,
          to_chunk_id: defChunkId,
          relation_type: 'calls',
          symbol_name: sym,
        });
      }
    }
  }

  return edges;
}
