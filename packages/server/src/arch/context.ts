import type { ArchSearchHit, ArchStore } from './store.js';
import type { ArchContextResult, ArchKind } from './types.js';

export const DEFAULT_PER_KIND_LIMIT = 5;

/** Default min cosine score for arch_context. Calibrated against bge-m3 — see store.ts. */
export const DEFAULT_MIN_SCORE = 0.45;

const INIT_HINT =
  'No architectural memory has been recorded for this group yet. Ask the user ' +
  'if you should initialise the arch layer: walk the repository, identify 8-20 ' +
  'components by domain boundaries, and write each via arch_record_component.';

export const LOW_CONFIDENCE_HINT =
  'No high-confidence cards matched (cosine >= min_score). Either the question ' +
  'is off-topic for this group, the arch memory is incomplete, or min_score is ' +
  'too strict — try lowering it or rephrasing the question.';

/** Per-kind limits — callers can override one or more buckets independently. */
export interface PerKindLimits {
  component?: number;
  decision?: number;
  lesson?: number;
}

function resolveLimits(limits: PerKindLimits | undefined): Required<PerKindLimits> {
  return {
    component: limits?.component ?? DEFAULT_PER_KIND_LIMIT,
    decision: limits?.decision ?? DEFAULT_PER_KIND_LIMIT,
    lesson: limits?.lesson ?? DEFAULT_PER_KIND_LIMIT,
  };
}

function assemble(
  components: ArchSearchHit[],
  decisions: ArchSearchHit[],
  lessons: ArchSearchHit[],
  hasAnyCards: boolean
): ArchContextResult {
  const comps = components.filter(
    (h): h is ArchSearchHit & { kind: 'component' } => h.kind === 'component'
  );
  const decs = decisions.filter(
    (h): h is ArchSearchHit & { kind: 'decision' } => h.kind === 'decision'
  );
  const less = lessons.filter((h): h is ArchSearchHit & { kind: 'lesson' } => h.kind === 'lesson');
  const empty = comps.length === 0 && decs.length === 0 && less.length === 0;
  let hint: string | null = null;
  if (empty) {
    hint = hasAnyCards ? LOW_CONFIDENCE_HINT : INIT_HINT;
  }
  return { components: comps, decisions: decs, lessons: less, empty, hint };
}

export interface BuildArchContextOpts {
  /** Drop hits below this cosine score. Defaults to DEFAULT_MIN_SCORE. */
  minScore?: number;
  /**
   * Scope results to a single project inside the group.
   * Components are filtered hard (project must match); decisions and lessons
   * are filtered soft (project=X or no project field both pass) so globally
   * scoped guidance still surfaces.
   */
  project?: string;
  /**
   * Per-kind result limits. Components, decisions, and lessons each get their
   * own top-N — a verbose decision bucket can no longer starve components out
   * of the result. Defaults to DEFAULT_PER_KIND_LIMIT per kind.
   */
  limits?: PerKindLimits;
}

/**
 * Search one kind in isolation so its top-N is independent of the others.
 * Previous implementation did a single global top-20 and bucketed post-fetch,
 * which let one kind dominate the limit and silently drop the others. Now
 * each kind has its own budget; arch collections are tiny so three queries
 * are cheap.
 */
async function searchOneKind(
  store: ArchStore,
  group: string,
  vector: number[],
  kind: ArchKind,
  limit: number,
  minScore: number,
  project: string | undefined
): Promise<ArchSearchHit[]> {
  if (limit <= 0) return [];
  return store.searchWithVector(group, vector, {
    kinds: [kind],
    limit,
    minScore,
    ...(project !== undefined ? { project } : {}),
  });
}

export async function buildArchContext(
  store: ArchStore,
  group: string,
  question: string,
  opts: BuildArchContextOpts = {}
): Promise<ArchContextResult> {
  const vector = await store.embedQuestion(question);
  return buildArchContextWithVector(store, group, vector, opts);
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
  const limits = resolveLimits(opts.limits);
  const project = opts.project;
  const [components, decisions, lessons] = await Promise.all([
    searchOneKind(store, group, vector, 'component', limits.component, minScore, project),
    searchOneKind(store, group, vector, 'decision', limits.decision, minScore, project),
    searchOneKind(store, group, vector, 'lesson', limits.lesson, minScore, project),
  ]);
  const totalHits = components.length + decisions.length + lessons.length;
  const hasAnyCards = totalHits > 0 || (await groupHasAnyCards(store, group));
  return assemble(components, decisions, lessons, hasAnyCards);
}

async function groupHasAnyCards(store: ArchStore, group: string): Promise<boolean> {
  const stats = await store.stats(group);
  return stats.total > 0;
}
