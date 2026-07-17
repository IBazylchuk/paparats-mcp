/**
 * BM25 sparse-vector construction for the docs hybrid-search layer.
 *
 * We compute BM25 term weights OURSELVES (in TS) and push a raw Qdrant
 * `sparse_vector` — we do NOT rely on Qdrant server-side BM25 inference (which
 * needs the Python/FastEmbed client or a Cloud inference module; our indexer is
 * TS + llama.cpp). Dense (qwen3) and sparse (this) are fused server-side via the
 * Query API `prefetch` + `fusion: rrf`, which IS available in OSS Qdrant.
 *
 * The IDF component (corpus document frequencies) lives in a SEPARATE SQLite
 * file — see idf-store.ts — never in metadata.db.
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
 * Tokenise text for BM25: lowercase, split on non-alphanumeric, drop stop-words
 * and single characters. Deterministic and dependency-free so the same text
 * always yields the same tokens (indexing and query must agree).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
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
 * Robertson-Spärck-Jones IDF with the +0.5 smoothing used by Lucene/BM25.
 *
 * Cold-start: when the corpus is empty (docCount 0) — which happens for the very
 * first document indexed, before any corpus stats exist — every term is treated
 * as maximally rare (df 0 in a size-1 corpus), so the first document still gets
 * non-zero sparse weights instead of an all-zero vector. Subsequent documents
 * see real corpus stats. The self-heal reindex rebuilds IDF from the full corpus
 * anyway, so this bootstrap value is never load-bearing long-term.
 */
export function idf(docFreq: number, docCount: number): number {
  const n = docCount <= 0 ? 1 : docCount;
  return Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
}

/**
 * Build a BM25 sparse vector for a DOCUMENT (indexing side). Weights each unique
 * term by its BM25 score against the corpus stats. Terms not yet in the corpus
 * (docFreq 0) are still weighted — idf() handles df=0 gracefully.
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
    const termIdf = idf(stats.docFreq(term), stats.docCount);
    if (termIdf <= 0) continue;
    // BM25 term saturation with length normalisation.
    const denom = freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avg));
    const weight = termIdf * ((freq * (BM25_K1 + 1)) / denom);
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
 * Build a sparse vector for a QUERY (search side). A query is short, so we weight
 * each term by its IDF only (no TF saturation) — the standard BM25 query-side
 * treatment. Fusion with dense happens in Qdrant via RRF.
 */
export function buildQuerySparseVector(query: string, stats: CorpusStats): SparseVector {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { indices: [], values: [] };
  const seen = new Map<number, number>();
  for (const term of new Set(tokens)) {
    const termIdf = idf(stats.docFreq(term), stats.docCount);
    if (termIdf <= 0) continue;
    seen.set(termToIndex(term), termIdf);
  }
  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, w] of seen) {
    indices.push(idx);
    values.push(w);
  }
  return { indices, values };
}
