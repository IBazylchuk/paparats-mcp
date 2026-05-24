export type ArchKind = 'component' | 'decision' | 'lesson';
export type ArchStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated';
export type ArchScope = 'global' | 'component' | 'file';
export type ArchSeverity = 'info' | 'warning' | 'critical';

interface ArchBase {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArchComponent extends ArchBase {
  kind: 'component';
  /** Required. Use the same project name the indexer registers in payload.project of code chunks. */
  project: string;
  name: string;
  summary: string;
  files: string[];
  neighbours: string[];
  anchors: string[];
}

export interface ArchDecision extends ArchBase {
  kind: 'decision';
  /** Optional. Omit for decisions that apply across all projects in the group. */
  project?: string;
  title: string;
  context: string;
  decision: string;
  alternativesRejected: string;
  consequences: string;
  status: ArchStatus;
  supersedes: string | null;
  scope: ArchScope;
}

export interface ArchLesson extends ArchBase {
  kind: 'lesson';
  /** Optional. Omit for lessons that apply across all projects in the group. */
  project?: string;
  rule: string;
  why: string;
  when: string;
  scope: ArchScope;
  evidence: string | null;
  severity: ArchSeverity;
  status: ArchStatus;
}

export type ArchPoint = ArchComponent | ArchDecision | ArchLesson;

export interface ArchContextResult {
  components: Array<ArchComponent & { score: number }>;
  decisions: Array<ArchDecision & { score: number }>;
  lessons: Array<ArchLesson & { score: number }>;
  empty: boolean;
  hint: string | null;
}

/**
 * Result of a write that goes through the similarity gate.
 * - `created`   : no near match — a new point was written.
 * - `updated`   : component matched an existing one by name OR lesson was a
 *                 duplicate and we bumped updatedAt instead of writing again.
 * - `duplicate` : decision/lesson with similarity >= DUPLICATE_THRESHOLD.
 *                 For lessons the existing card's updatedAt is bumped.
 *                 For decisions nothing is written — the caller is asked to
 *                 explain why they didn't find it first.
 * - `similar`   : near match in the SIMILAR..DUPLICATE band.
 *                 Nothing is written; the caller is invited to update the
 *                 existing card (lesson) or supersede it (decision).
 */
export type ArchWriteStatus = 'created' | 'updated' | 'duplicate' | 'similar';

export interface ArchWriteResult {
  status: ArchWriteStatus;
  /** Id of the newly written point (created/updated) or the matched point (duplicate/similar). */
  id: string;
  /** Cosine similarity of the matched point. Present for duplicate/similar. */
  similarity?: number;
  /** Short label of the matched point — name/title/rule — to help the agent decide. */
  matchedLabel?: string;
}
