import type { EdgeConfidence, SymbolEdge } from './types.js';

/** Chunk-id prefix is `<group>//<project>//<file>//<lines>//<hash>` — the file
 * segment is the third `//`-delimited part. Used to decide whether two chunks
 * live in the same source file, which lets us label intra-file edges as
 * `EXTRACTED` vs cross-file `INFERRED`. */
function fileKey(chunkId: string): string | null {
  const parts = chunkId.split('//');
  if (parts.length < 3) return null;
  return parts.slice(0, 3).join('//');
}

/**
 * Build cross-chunk symbol edges from chunk symbol data.
 *
 * For each chunk's `uses_symbols`, finds chunks that define those symbols
 * and creates a `'calls'` edge (from_chunk → to_chunk via symbol).
 *
 * Each edge is tagged with a confidence label:
 * - `EXTRACTED`: caller and definition share the same source file — the
 *   AST resolver already proved they're connected.
 * - `INFERRED`: cross-file edge where exactly one chunk defines the symbol.
 *   Likely correct, but the linker is just matching names.
 * - `AMBIGUOUS`: the symbol is defined in multiple chunks. The caller could
 *   be hitting any of them; surface all candidates with low confidence.
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

      const ambiguous = defChunks.size > 1;
      const callerFile = fileKey(chunk.chunk_id);

      for (const defChunkId of defChunks) {
        // Skip self-edges
        if (defChunkId === chunk.chunk_id) continue;

        const key = `${chunk.chunk_id}\0${defChunkId}\0${sym}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let confidence: EdgeConfidence;
        if (ambiguous) {
          confidence = 'AMBIGUOUS';
        } else {
          const defFile = fileKey(defChunkId);
          confidence = callerFile && defFile && callerFile === defFile ? 'EXTRACTED' : 'INFERRED';
        }

        edges.push({
          from_chunk_id: chunk.chunk_id,
          to_chunk_id: defChunkId,
          relation_type: 'calls',
          symbol_name: sym,
          confidence,
        });
      }
    }
  }

  return edges;
}
