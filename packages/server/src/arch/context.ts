import type { ArchSearchHit, ArchStore } from './store.js';
import type { ArchContextResult } from './types.js';

const PER_BUCKET_LIMIT = 5;
const SEARCH_LIMIT = 20;

/** Default min cosine score for arch_context. Calibrated against bge-m3 — see store.ts. */
export const DEFAULT_MIN_SCORE = 0.45;

const INIT_HINT =
  'No architectural memory has been recorded for this group yet. Ask the user ' +
  'if you should initialise the arch layer: walk the repository, identify 8-20 ' +
  'components by domain boundaries, and write each via arch_record_component.';

const LOW_CONFIDENCE_HINT =
  'No high-confidence cards matched (cosine >= min_score). Either the question ' +
  'is off-topic for this group, the arch memory is incomplete, or min_score is ' +
  'too strict — try lowering it or rephrasing the question.';

function bucket(hits: ArchSearchHit[], hasAnyCards: boolean): ArchContextResult {
  const components = hits.filter((h) => h.kind === 'component').slice(0, PER_BUCKET_LIMIT);
  const decisions = hits.filter((h) => h.kind === 'decision').slice(0, PER_BUCKET_LIMIT);
  const lessons = hits.filter((h) => h.kind === 'lesson').slice(0, PER_BUCKET_LIMIT);
  const empty = components.length === 0 && decisions.length === 0 && lessons.length === 0;
  let hint: string | null = null;
  if (empty) {
    hint = hasAnyCards ? LOW_CONFIDENCE_HINT : INIT_HINT;
  }
  return { components, decisions, lessons, empty, hint };
}

export interface BuildArchContextOpts {
  /** Drop hits below this cosine score. Defaults to DEFAULT_MIN_SCORE. */
  minScore?: number;
}

export async function buildArchContext(
  store: ArchStore,
  group: string,
  question: string,
  opts: BuildArchContextOpts = {}
): Promise<ArchContextResult> {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const hits = await store.search(group, question, { limit: SEARCH_LIMIT, minScore });
  const hasAnyCards = hits.length > 0 || (await groupHasAnyCards(store, group));
  return bucket(hits, hasAnyCards);
}

/**
 * Same as `buildArchContext` but reuses a pre-computed query vector so callers
 * fanning out across many groups embed the question once.
 */
export async function buildArchContextWithVector(
  store: ArchStore,
  group: string,
  vector: number[],
  opts: BuildArchContextOpts = {}
): Promise<ArchContextResult> {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const hits = await store.searchWithVector(group, vector, { limit: SEARCH_LIMIT, minScore });
  const hasAnyCards = hits.length > 0 || (await groupHasAnyCards(store, group));
  return bucket(hits, hasAnyCards);
}

async function groupHasAnyCards(store: ArchStore, group: string): Promise<boolean> {
  const stats = await store.stats(group);
  return stats.total > 0;
}
