import { stemmer } from 'stemmer';

/**
 * BM25 sparse-vector construction for the docs hybrid-search layer.
 *
 * The split follows Qdrant's own BM25 recipe (FastEmbed `Qdrant/bm25`): a
 * document vector carries only the saturated, length-normalised term frequency,
 * a query vector carries 1 per term, and Qdrant multiplies in the IDF at query
 * time from the live collection (`modifier: idf` on the sparse vector). IDF is
 * therefore applied exactly once and never goes stale as documents change.
 *
 * The corpus statistics in idf-store.ts still supply the average chunk length
 * for length normalisation.
 */

// BM25 parameters — standard defaults. k1 controls term-frequency saturation,
// b controls length normalisation.
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** A sparse vector in Qdrant's `{indices, values}` shape. */
export interface SparseVector {
  indices: number[];
  values: number[];
}

/** Corpus statistics needed to weight a document's terms with BM25. */
export interface CorpusStats {
  /** Total number of documents (chunks) in the corpus. */
  docCount: number;
  /** Average document length in tokens. */
  avgDocLength: number;
  /** Per-term document frequency: how many docs contain the term. */
  docFreq(term: string): number;
}

// A small, language-agnostic English stop-word set. Kept minimal — over-pruning
// hurts recall on short technical queries ("how to X").
const STOP_WORDS = new Set([
  'about',
  'been',
  'being',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'had',
  'have',
  'having',
  'her',
  'here',
  'him',
  'his',
  'how',
  'if',
  'into',
  'me',
  'my',
  'our',
  'she',
  'should',
  'so',
  'than',
  'their',
  'them',
  'then',
  'there',
  'they',
  'us',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'would',
  'your',
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'this',
  'these',
  'those',
  'or',
  'but',
  'not',
  'we',
  'you',
]);

/**
 * Bumped whenever `tokenize()` changes. Corpus counts made with another version
 * are rebuilt from the stored chunks (`DocsIdfStore.isCurrent()`): removing a
 * document tokenises it again, which is exact only with the same tokeniser.
 * 2 — letters and digits of every script, Latin accents folded, CJK bigrams.
 * 3 — English stop-words include question words; Latin words are Porter-stemmed.
 */
export const TOKENIZER_VERSION = 3;

// Scripts written without spaces between words: a run of them is indexed as
// overlapping two-character pieces (as Lucene's CJK analyzer does), so a query
// matches part of a run without a dictionary to cut words.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_MARKS = /(?<=\p{Script=Latin})\p{M}+/gu;

/**
 * Tokenise text for BM25: lowercase, split on anything but letters, digits and
 * `_` (any script), drop stop-words and single characters. Accents on Latin
 * letters are dropped ("café" and "cafe" are one term); other scripts keep
 * theirs. A CJK run becomes its character bigrams (a lone character stays).
 * Deterministic and dependency-free so the same text always yields the same
 * tokens (indexing and query must agree).
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text
    .normalize('NFKD')
    .replace(LATIN_MARKS, '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}_]+/u);
  for (const word of words) {
    if (!word) continue;
    let last = 0;
    for (const m of word.matchAll(CJK_RUN)) {
      addWord(out, word.slice(last, m.index));
      const run = Array.from(m[0]);
      if (run.length === 1) out.push(run[0]!);
      for (let i = 0; i + 1 < run.length; i++) out.push(run[i]! + run[i + 1]!);
      last = m.index + m[0].length;
    }
    addWord(out, word.slice(last));
  }
  return out;
}

const LATIN_WORD = /^[a-z]+$/;

function addWord(out: string[], word: string): void {
  if (Array.from(word).length <= 1 || STOP_WORDS.has(word)) return;
  out.push(LATIN_WORD.test(word) ? stemmer(word) : word);
}

/**
 * Map a token to a stable non-negative int32 index for Qdrant's sparse-vector
 * `indices`. A 32-bit FNV-1a hash — collisions are astronomically rare at our
 * vocabulary size and would only slightly blur two terms' weights, never corrupt
 * search. Indexing and query use the same function, so a term always maps to the
 * same index on both sides.
 */
export function termToIndex(term: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Qdrant sparse indices must be non-negative; >>>0 already guarantees that,
  // but clamp the top bit off to stay comfortably within a safe int range.
  return h & 0x7fffffff;
}

/**
 * Build a BM25 sparse vector for a DOCUMENT (indexing side): each unique term's
 * saturated, length-normalised frequency. The IDF factor is Qdrant's, at query
 * time.
 */
export function buildDocumentSparseVector(text: string, stats: CorpusStats): SparseVector {
  const tokens = tokenize(text);
  const docLength = tokens.length;
  if (docLength === 0) return { indices: [], values: [] };

  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const avg = stats.avgDocLength > 0 ? stats.avgDocLength : docLength;
  const byIndex = new Map<number, number>();
  for (const [term, freq] of tf) {
    const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avg));
    const weight = (freq * (BM25_K1 + 1)) / denom;
    if (weight <= 0) continue;
    const idx = termToIndex(term);
    // On the rare hash collision, keep the larger weight (more discriminative).
    byIndex.set(idx, Math.max(byIndex.get(idx) ?? 0, weight));
  }

  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, w] of byIndex) {
    indices.push(idx);
    values.push(w);
  }
  return { indices, values };
}

/**
 * Build a sparse vector for a QUERY (search side): 1 per unique term. Qdrant
 * weights each term by its IDF over the collection (`modifier: idf`).
 */
export function buildQuerySparseVector(query: string): SparseVector {
  const indices = [...new Set(tokenize(query).map(termToIndex))];
  return { indices, values: indices.map(() => 1) };
}
