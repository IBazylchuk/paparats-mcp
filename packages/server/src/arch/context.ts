import type { ArchStore } from './store.js';
import type {
  ArchPoint,
  ArchComponent,
  ArchDecision,
  ArchLesson,
  ArchContextResult,
} from './types.js';

const PER_BUCKET_LIMIT = 5;
const SEARCH_LIMIT = 20;

const INIT_HINT =
  'No architectural memory has been recorded for this group yet. Ask the user ' +
  'if you should initialise the arch layer: walk the repository, identify 8-20 ' +
  'components by domain boundaries, and write each via arch_record_component.';

function isComponent(p: ArchPoint): p is ArchComponent {
  return p.kind === 'component';
}
function isDecision(p: ArchPoint): p is ArchDecision {
  return p.kind === 'decision';
}
function isLesson(p: ArchPoint): p is ArchLesson {
  return p.kind === 'lesson';
}

function bucket(hits: ArchPoint[]): ArchContextResult {
  const components = hits.filter(isComponent).slice(0, PER_BUCKET_LIMIT);
  const decisions = hits.filter(isDecision).slice(0, PER_BUCKET_LIMIT);
  const lessons = hits.filter(isLesson).slice(0, PER_BUCKET_LIMIT);
  const empty = components.length === 0 && decisions.length === 0 && lessons.length === 0;
  return {
    components,
    decisions,
    lessons,
    empty,
    hint: empty ? INIT_HINT : null,
  };
}

export async function buildArchContext(
  store: ArchStore,
  group: string,
  question: string
): Promise<ArchContextResult> {
  const hits = await store.search(group, question, { limit: SEARCH_LIMIT });
  return bucket(hits);
}

/**
 * Same as `buildArchContext` but reuses a pre-computed query vector so callers
 * fanning out across many groups embed the question once.
 */
export async function buildArchContextWithVector(
  store: ArchStore,
  group: string,
  vector: number[]
): Promise<ArchContextResult> {
  const hits = await store.searchWithVector(group, vector, { limit: SEARCH_LIMIT });
  return bucket(hits);
}
