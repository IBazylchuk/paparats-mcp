/**
 * The text a code chunk is embedded as. The stored payload keeps the plain
 * chunk; only the vector sees the header.
 *
 *   Filepath: app/models/billing/invoice.rb
 *   ---
 *     def total
 *
 * A method chunk on its own says nothing about where it lives; the path gives
 * the vector that context. On the retrieval bench, plain-language support
 * questions found the right file first for 38% of
 * queries instead of 21% in plain similarity order, and 33% instead of 21%
 * with the `search_code` ranking. Adding the enclosing class and module lines
 * as well won and lost about as many queries, so the header carries the path
 * only.
 */

/**
 * Stored in each code point as `embed_format`. Indexing compares it with the
 * stored value, so bumping it re-embeds files whose chunks did not change.
 * Points without it were embedded as the plain chunk.
 */
export const EMBED_TEXT_FORMAT = 2;

/** The text to embed for a chunk of `relPath`. */
export function chunkEmbedText(relPath: string, content: string): string {
  return `Filepath: ${relPath}\n---\n${content}`;
}
