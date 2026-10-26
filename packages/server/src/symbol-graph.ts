import type { EdgeConfidence, NameUsage, SymbolEdge } from './types.js';

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
 * `add`, `close`, `run`, `each`): methods every object has. A name is common
 * when it has that shape and more files use it than the square root of all
 * files that use any name, and at least {@link COMMON_NAME_MIN_FILES} — in a
 * 10 000-file group over 100 files, in a 150-file one over 12. Compound names
 * (`ProjectConfig`, `getChunkById`, `find_by_name`) rarely collide by chance,
 * so a widely used one is a real dependency and stays.
 */
export const COMMON_NAME_MIN_FILES = 8;

const SINGLE_LOWERCASE_WORD = /^[a-z][a-z0-9]*[?!=]?$/;

export function isCommonName(name: string, usage: NameUsage): boolean {
  if (!SINGLE_LOWERCASE_WORD.test(name)) return false;
  const f = usage.filesUsing.get(name) ?? 0;
  return f > Math.max(COMMON_NAME_MIN_FILES, Math.sqrt(usage.callerFiles));
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
  }>,
  maxDefinitionFanout: number = MAX_DEFINITION_FANOUT
): { edges: SymbolEdge[]; stats: SymbolEdgeStats } {
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
  const stats: SymbolEdgeStats = { skippedSymbols: 0, skippedEdges: 0 };

  for (const chunk of chunkSymbols) {
    for (const sym of chunk.uses_symbols) {
      const defChunks = definedBy.get(sym);
      if (!defChunks) continue;

      // Structural-noise cap: a symbol defined in too many chunks explodes into
      // a quadratic AMBIGUOUS fan-out with no navigational value. Each use we
      // encounter here avoids exactly `defChunks.size` edges — summing that
      // across all uses yields the same `uses × defines` total the eager pass
      // would have computed, but with no extra map or pre-pass. Count the symbol
      // itself once (guarded by `seen`).
      if (defChunks.size > maxDefinitionFanout) {
        stats.skippedEdges += defChunks.size;
        const skipKey = `\0skip\0${sym}`;
        if (!seen.has(skipKey)) {
          seen.add(skipKey);
          stats.skippedSymbols += 1;
        }
        continue;
      }

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

  return { edges, stats };
}
