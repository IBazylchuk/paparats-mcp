/**
 * Okapi BM25 over whole files — the lexical baseline arm of the bench.
 *
 * Everything that decides the numbers is fixed here and in `docs/benchmarking.md`,
 * not chosen per run: k1 = 1.2, b = 0.75, one document per file, the tokenizer
 * below for files and queries alike, no stemming, no stop words. Nothing in this
 * module is tuned on bench results.
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** A maximal run of letters, digits and `_` — what a programmer reads as one identifier. */
const IDENTIFIER = /[\p{L}\p{N}_]+/gu;

/**
 * Split one `_`-free identifier at camelCase boundaries: `fooBar` → foo, Bar;
 * `HTTPServer` → HTTP, Server; `utf8Decode` → utf8, Decode. Digits stay with the
 * letters before them.
 */
function camelParts(segment: string): string[] {
  return segment
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(' ');
}

/**
 * Tokens of a text: every identifier (a run of letters, digits and `_`) gives its
 * lowercased self without the underscores, plus its snake_case and camelCase
 * parts when it has more than one. `toCollectionName` → `tocollectionname`, `to`,
 * `collection`, `name`; `to_collection_name` gives the same. Anything else
 * (`/`, `.`, `-`, spaces, punctuation) only separates identifiers. A repeated
 * token is repeated in the output: term frequency counts it.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(IDENTIFIER) ?? []) {
    const parts = word
      .split('_')
      .filter((s) => s !== '')
      .flatMap(camelParts)
      .map((p) => p.toLowerCase());
    if (parts.length === 0) continue;
    const whole = parts.join('');
    out.push(whole);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

export interface Bm25Document {
  /** Stable identifier returned in results (a file path). */
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

interface Posting {
  doc: number;
  tf: number;
}

/**
 * In-memory index. Scoring is Okapi BM25 with the non-negative IDF
 * `ln(1 + (N - n + 0.5) / (n + 0.5))`; a query contributes each distinct token once.
 * Documents with no query token score 0 and are not returned. Ties are broken by id,
 * so a ranking is reproducible.
 */
export class Bm25Index {
  private readonly ids: string[] = [];
  private readonly lengths: number[] = [];
  private readonly postings = new Map<string, Posting[]>();
  private readonly avgLength: number;

  constructor(
    documents: Bm25Document[],
    private readonly k1: number = BM25_K1,
    private readonly b: number = BM25_B
  ) {
    let total = 0;
    documents.forEach((d, doc) => {
      const tokens = tokenize(d.text);
      this.ids.push(d.id);
      this.lengths.push(tokens.length);
      total += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, count] of tf) {
        const list = this.postings.get(term);
        if (list) list.push({ doc, tf: count });
        else this.postings.set(term, [{ doc, tf: count }]);
      }
    });
    this.avgLength = documents.length > 0 ? total / documents.length : 0;
  }

  get size(): number {
    return this.ids.length;
  }

  /** Document frequency of a token (tests and diagnostics). */
  docFreq(token: string): number {
    return this.postings.get(token)?.length ?? 0;
  }

  search(query: string, limit: number): Bm25Hit[] {
    const n = this.ids.length;
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = 1 - this.b + this.b * ((this.lengths[doc] ?? 0) / this.avgLength);
        const weight = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * norm);
        scores.set(doc, (scores.get(doc) ?? 0) + weight);
      }
    }
    return [...scores]
      .map(([doc, score]) => ({ id: this.ids[doc] ?? '', score }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit);
  }
}
