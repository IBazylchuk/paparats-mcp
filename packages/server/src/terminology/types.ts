/**
 * Terminology (glossary) layer types.
 *
 * A company glossary — abbreviations, service names, domain terms — that dense
 * embeddings alone retrieve poorly ("CLIC", "feed-poster", "the stand"). Stored
 * in a separate Qdrant collection (`paparats_<group>_terms`, qwen3 1024d) and
 * authored by the AGENT via MCP tools (like arch memory), not by the file
 * indexer. A bulk-extraction skill can seed it by walking the docs.
 */

/** A glossary entry as stored/returned. */
export interface Term {
  id: string;
  /** The canonical term, e.g. "feed-poster". */
  term: string;
  /** Plain-language definition. */
  definition: string;
  /** Alternate spellings / abbreviations that mean the same thing. */
  aliases: string[];
  /** Optional project scope. Omit for group-wide terms. */
  project?: string;
  createdAt: number;
  updatedAt: number;
}

/** A search hit: the stored term plus its cosine similarity. */
export type TermSearchHit = Term & { score: number };

/**
 * Result of a term_record write through the similarity gate (mirrors arch):
 *  - `created`   : no near match — a new term was written.
 *  - `updated`   : an existing term with the same canonical name was overwritten,
 *                  OR a duplicate re-confirmed an existing term (updatedAt bumped).
 *  - `duplicate` : similarity >= DUPLICATE_THRESHOLD — nothing written, the
 *                  caller is pointed at the existing term.
 *  - `similar`   : similarity in the SIMILAR..DUPLICATE band — nothing written,
 *                  the caller is invited to update the existing term instead.
 */
export type TermWriteStatus = 'created' | 'updated' | 'duplicate' | 'similar';

export interface TermWriteResult {
  status: TermWriteStatus;
  id: string;
  similarity?: number;
  matchedLabel?: string;
}
