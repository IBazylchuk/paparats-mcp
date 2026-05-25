import type { QdrantClient } from '@qdrant/js-client-rest';
import { v7 as uuidv7 } from 'uuid';
import type { CachedEmbeddingProvider } from '../embeddings.js';
import { ensureArchCollection, toArchCollectionName } from './collection.js';
import type {
  ArchKind,
  ArchPoint,
  ArchStatus,
  ArchScope,
  ArchSeverity,
  ArchWriteResult,
} from './types.js';

export interface ArchStoreConfig {
  qdrant: QdrantClient;
  provider: CachedEmbeddingProvider;
}

interface UpsertComponentInput {
  /** Required. Same value the indexer uses in code-chunk `payload.project`. */
  project: string;
  name: string;
  summary: string;
  files: string[];
  neighbours: string[];
  anchors: string[];
}

interface UpsertDecisionInput {
  /** Optional. Omit for decisions that apply across all projects in the group. */
  project?: string;
  title: string;
  context: string;
  decision: string;
  alternativesRejected: string;
  consequences: string;
  scope: ArchScope;
  status?: ArchStatus;
  supersedes?: string | null;
}

interface UpsertLessonInput {
  /** Optional. Omit for lessons that apply across all projects in the group. */
  project?: string;
  rule: string;
  why: string;
  when: string;
  scope: ArchScope;
  severity: ArchSeverity;
  evidence?: string | null;
  status?: ArchStatus;
}

export interface SearchOpts {
  kinds?: ArchKind[];
  /** Include superseded/deprecated. Default false. */
  includeHistory?: boolean;
  limit?: number;
  /** Drop hits whose cosine similarity is below this threshold. 0..1. */
  minScore?: number;
  /**
   * Scope results to a single project inside the group.
   *
   * Components are filtered hard: a component card without `project=X` is
   * dropped. Decisions and lessons are filtered soft: cards with `project=X`
   * OR no `project` field at all pass through, so globally-scoped guidance
   * still surfaces alongside project-scoped components.
   *
   * Omit to query the whole group.
   */
  project?: string;
}

/** Search hit — the stored card payload plus the cosine similarity from the vector search. */
export type ArchSearchHit = ArchPoint & { score: number };

// ── Similarity gate thresholds ─────────────────────────────────────────────
// Calibrated on bge-m3 against a labelled probe set (offline measurement) and
// confirmed against a live e2e run (lessons + decisions about embeddings,
// chunking, ids, caching):
//   - Duplicates (same idea, different words):  cosine ∈ [0.84, 0.94]
//   - Similar (overlapping topic, distinct):    cosine ∈ [0.65, 0.78]
//   - Different (same domain, distinct topic):  cosine ∈ [0.55, 0.65]
// The original SIMILAR threshold of 0.62 turned out too greedy — a clearly
// unrelated lesson about UUIDv7 scored 0.63 against a lesson about Qdrant
// timestamps because both texts mention "Qdrant" and "ids". Raising it to
// 0.70 keeps real near-misses (e.g. "Use jina-code-embeddings" vs the bge-m3
// decision at 0.69) just below the band so they don't false-positive, while
// the genuine-duplicate band at 0.85+ is untouched.
const DUPLICATE_THRESHOLD = 0.85;
const SIMILAR_THRESHOLD = 0.7;

// ── Project-scoped retrieval boost ─────────────────────────────────────────
// Additive boost applied to cards whose `project` matches the caller's
// project filter during `searchWithVector` (i.e. `arch_context`). Designed
// to break the short-text cosine bias that lets globally-scoped one-line
// decisions outrank longer project-scoped components.
//
// Sized at roughly one tier of the calibrated bge-m3 score bands (the gap
// between "different topic" and "overlapping topic") so it nudges ranking
// without rewriting the ordering of genuinely stronger matches. Applies
// to ranking only; the similarity gate (findNearest) uses raw cosine.
export const PROJECT_SCORE_BOOST = 0.05;

export class ArchStore {
  private qdrant: QdrantClient;
  private provider: CachedEmbeddingProvider;

  constructor(config: ArchStoreConfig) {
    this.qdrant = config.qdrant;
    this.provider = config.provider;
  }

  /** Embed an arbitrary query — exposed so callers can fan a single embedding across groups. */
  async embedQuestion(question: string): Promise<number[]> {
    return this.provider.embed(question);
  }

  /**
   * Idempotent by name. Components match on `name`, not on vector similarity —
   * a deliberate "structural" key that matches how humans refer to a component.
   * Returns `updated` when an existing card with the same name was overwritten,
   * `created` otherwise.
   */
  async upsertComponent(group: string, input: UpsertComponentInput): Promise<ArchWriteResult> {
    await ensureArchCollection(this.qdrant, group, this.provider.dimensions);
    const existing = await this.findByName(group, 'component', input.name, input.project);
    const id = existing?.id ?? uuidv7();
    const now = Date.now();
    const text = renderComponentForEmbedding(input);
    const vector = await this.provider.embed(text);
    const payload: Record<string, unknown> = {
      arch_kind: 'component',
      kind: 'component',
      id,
      project: input.project,
      name: input.name,
      summary: input.summary,
      files: input.files,
      neighbours: input.neighbours,
      anchors: input.anchors,
      status: 'accepted',
      scope: 'global',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.qdrant.upsert(toArchCollectionName(group), {
      wait: true,
      points: [{ id, vector, payload }],
    });
    return { status: existing ? 'updated' : 'created', id };
  }

  /**
   * Decisions go through the similarity gate. Possible outcomes:
   *  - `duplicate` (>= DUPLICATE_THRESHOLD): nothing is written, the matched
   *    decision id is returned so the agent can ask the user why they didn't
   *    find it earlier.
   *  - `similar` (>= SIMILAR_THRESHOLD): nothing is written; the agent should
   *    consider passing `supersedes` if it really wants to replace the existing.
   *  - `created`: a new decision point is written.
   *
   * If `supersedes` is passed explicitly, the gate is bypassed — the caller has
   * already decided to replace a specific prior decision.
   */
  async upsertDecision(group: string, input: UpsertDecisionInput): Promise<ArchWriteResult> {
    await ensureArchCollection(this.qdrant, group, this.provider.dimensions);
    const text = renderDecisionForEmbedding(input);
    const vector = await this.provider.embed(text);

    if (!input.supersedes) {
      const match = await this.findNearest(group, 'decision', vector, input.project);
      if (match && match.score >= DUPLICATE_THRESHOLD) {
        return {
          status: 'duplicate',
          id: match.id,
          similarity: match.score,
          matchedLabel: match.label,
        };
      }
      if (match && match.score >= SIMILAR_THRESHOLD) {
        return {
          status: 'similar',
          id: match.id,
          similarity: match.score,
          matchedLabel: match.label,
        };
      }
    }

    const id = uuidv7();
    const now = Date.now();
    const supersedes = input.supersedes ?? null;
    await this.qdrant.upsert(toArchCollectionName(group), {
      wait: true,
      points: [
        {
          id,
          vector,
          payload: {
            arch_kind: 'decision',
            kind: 'decision',
            id,
            ...(input.project !== undefined ? { project: input.project } : {}),
            title: input.title,
            context: input.context,
            decision: input.decision,
            alternativesRejected: input.alternativesRejected,
            consequences: input.consequences,
            status: input.status ?? 'accepted',
            supersedes,
            scope: input.scope,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    if (supersedes) {
      await this.markSuperseded(group, supersedes);
    }
    return { status: 'created', id };
  }

  /**
   * Lessons go through the similarity gate. Possible outcomes:
   *  - `duplicate` (>= DUPLICATE_THRESHOLD): the existing lesson's updatedAt is
   *    bumped (signal: rule confirmed again), no new card is written, status
   *    `updated` is returned with the existing id.
   *  - `similar` (>= SIMILAR_THRESHOLD): nothing is written; the agent should
   *    decide whether to update the existing or write a distinct new lesson.
   *  - `created`: a new lesson point is written.
   */
  async upsertLesson(group: string, input: UpsertLessonInput): Promise<ArchWriteResult> {
    await ensureArchCollection(this.qdrant, group, this.provider.dimensions);
    const text = renderLessonForEmbedding(input);
    const vector = await this.provider.embed(text);

    const match = await this.findNearest(group, 'lesson', vector, input.project);
    if (match && match.score >= DUPLICATE_THRESHOLD) {
      await this.bumpUpdatedAt(group, match.id);
      return {
        status: 'updated',
        id: match.id,
        similarity: match.score,
        matchedLabel: match.label,
      };
    }
    if (match && match.score >= SIMILAR_THRESHOLD) {
      return {
        status: 'similar',
        id: match.id,
        similarity: match.score,
        matchedLabel: match.label,
      };
    }

    const id = uuidv7();
    const now = Date.now();
    await this.qdrant.upsert(toArchCollectionName(group), {
      wait: true,
      points: [
        {
          id,
          vector,
          payload: {
            arch_kind: 'lesson',
            kind: 'lesson',
            id,
            ...(input.project !== undefined ? { project: input.project } : {}),
            rule: input.rule,
            why: input.why,
            when: input.when,
            scope: input.scope,
            severity: input.severity,
            evidence: input.evidence ?? null,
            status: input.status ?? 'accepted',
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    return { status: 'created', id };
  }

  async markSuperseded(group: string, pointId: string): Promise<void> {
    await this.qdrant.setPayload(toArchCollectionName(group), {
      payload: { status: 'superseded' },
      points: [pointId],
      wait: true,
    });
  }

  /** Bump only `updatedAt` on a point — used when a duplicate lesson re-confirms the rule. */
  async bumpUpdatedAt(group: string, pointId: string): Promise<void> {
    await this.qdrant.setPayload(toArchCollectionName(group), {
      payload: { updatedAt: Date.now() },
      points: [pointId],
      wait: true,
    });
  }

  /**
   * Hard-delete one or more arch points by id. Idempotent: ids that aren't
   * present in the collection are reported in `notFound` rather than failing
   * the call. No status change, no audit trail — the points are gone.
   *
   * Two round-trips: one `retrieve` to split requested ids into found/missing,
   * then a `delete` for the found set. Arch collections are tiny so the extra
   * round-trip is cheap, and the explicit `notFound` list lets callers detect
   * stale id lists (e.g. when running a migration script twice).
   *
   * A missing arch collection (first-run-of-a-migration) is caught explicitly
   * and treated as "every id not found". Any other Qdrant error propagates —
   * we don't want a transient network glitch to silently report "deleted 0,
   * not found N" when the collection actually exists.
   */
  async deletePoints(
    group: string,
    ids: string[]
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) return { deleted: [], notFound: [] };
    const collection = toArchCollectionName(group);
    try {
      await this.qdrant.getCollection(collection);
    } catch {
      // Collection doesn't exist yet — first run of a migration. Treat every
      // requested id as not-found so the call is safe to retry.
      return { deleted: [], notFound: [...ids] };
    }
    const points = await this.qdrant.retrieve(collection, {
      ids,
      with_payload: false,
      with_vector: false,
    });
    const foundSet = new Set<string>();
    for (const p of points) {
      const raw = p.id;
      const asStr = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
      if (asStr) foundSet.add(asStr);
    }
    const foundIds = ids.filter((id) => foundSet.has(id));
    const notFound = ids.filter((id) => !foundSet.has(id));
    if (foundIds.length === 0) return { deleted: [], notFound };
    await this.qdrant.delete(collection, { points: foundIds, wait: true });
    return { deleted: foundIds, notFound };
  }

  /**
   * Enumerate all arch cards in a group, optionally filtered by kind and
   * project. Unlike `search`/`searchWithVector`, this is a *list* — no vector,
   * no ranking, no similarity threshold. Use it when the caller needs every
   * card (audit, dedupe, migration), since the search ranker tends to starve
   * one kind under another and hides long project-scoped cards behind shorter
   * global ones.
   *
   * Pagination is offset-based and stable within a scroll session. The
   * `nextOffset` field is the Qdrant page cursor verbatim (string | number)
   * — callers pass it back as `offset` on the next call. `null` means the
   * scroll is exhausted.
   *
   * Project filtering mirrors `makeProjectPredicate`: components are
   * hard-filtered (only `project=X` passes), decisions and lessons are
   * soft-filtered (`project=X` OR no project field). Project filtering is
   * post-fetch so an oversample is fetched to avoid an artificially short
   * page; arch collections are tiny (low thousands), so 3x is cheap.
   *
   * Returns an empty page when the collection doesn't exist yet — first run
   * of a fresh group.
   */
  async listPoints(
    group: string,
    opts: {
      project?: string;
      kinds?: ArchKind[];
      includeHistory?: boolean;
      limit?: number;
      offset?: string | number | Record<string, unknown>;
    } = {}
  ): Promise<{
    points: ArchPoint[];
    nextOffset: string | number | Record<string, unknown> | null;
  }> {
    const limit = opts.limit ?? 50;
    const collection = toArchCollectionName(group);
    const must: unknown[] = [];
    if (opts.kinds && opts.kinds.length > 0) {
      must.push({ key: 'arch_kind', match: { any: opts.kinds } });
    }
    const must_not: unknown[] = [];
    if (!opts.includeHistory) {
      must_not.push(
        { key: 'status', match: { value: 'superseded' } },
        { key: 'status', match: { value: 'deprecated' } }
      );
    }
    const filter: Record<string, unknown> = {};
    if (must.length > 0) filter['must'] = must;
    if (must_not.length > 0) filter['must_not'] = must_not;

    const matchesProject = makeProjectPredicate(opts.project);
    const fetchLimit = opts.project !== undefined ? limit * 3 : limit;
    try {
      const page = await this.qdrant.scroll(collection, {
        limit: fetchLimit,
        with_payload: true,
        with_vector: false,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      });
      // Cursor correctness on early break.
      //
      // With a project filter we overfetch 3x. If `limit` matches accumulate
      // before the fetched batch is exhausted, `page.next_page_offset` would
      // skip every unprocessed point in this batch on the next call. Track
      // the last point we actually saw so we can resume strictly after it.
      let lastSeenId: string | number | null = null;
      const filtered: ArchPoint[] = [];
      for (const p of page.points) {
        const rawId = p.id;
        if (typeof rawId === 'string' || typeof rawId === 'number') {
          lastSeenId = rawId;
        }
        if (!p.payload) continue;
        const point = p.payload as unknown as ArchPoint;
        if (!matchesProject(point)) continue;
        filtered.push(point);
        if (filtered.length >= limit) break;
      }
      const exhaustedBatch = filtered.length < limit;
      // Forward Qdrant's cursor verbatim (string | number | object) when we
      // walked the whole fetched batch. When we broke early, use the last
      // seen id — Qdrant's scroll treats the offset as "start exclusive of
      // this id", which is exactly the resume semantics we want.
      const raw = page.next_page_offset;
      let nextOffset: string | number | Record<string, unknown> | null;
      if (!exhaustedBatch && lastSeenId !== null) {
        nextOffset = lastSeenId;
      } else if (typeof raw === 'string' || typeof raw === 'number') {
        nextOffset = raw;
      } else if (raw !== null && typeof raw === 'object') {
        nextOffset = raw as Record<string, unknown>;
      } else {
        nextOffset = null;
      }
      return { points: filtered, nextOffset };
    } catch {
      return { points: [], nextOffset: null };
    }
  }

  async findByName(
    group: string,
    kind: ArchKind,
    name: string,
    /** Scope the lookup to a single project. Required to keep component idempotency
     *  per-project: two projects in the same group may legitimately have a
     *  component with the same name (e.g. "indexer"). */
    project?: string
  ): Promise<{ id: string; createdAt?: number } | null> {
    try {
      const must: unknown[] = [
        { key: 'arch_kind', match: { value: kind } },
        { key: 'name', match: { value: name } },
      ];
      if (project !== undefined) {
        must.push({ key: 'project', match: { value: project } });
      }
      const res = await this.qdrant.scroll(toArchCollectionName(group), {
        filter: { must },
        with_payload: true,
        with_vector: false,
        limit: 1,
      });
      const point = res.points[0];
      if (!point) return null;
      const rawId = point.id;
      const id =
        typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
      if (!id) return null;
      const createdAt = (point.payload as { createdAt?: unknown } | undefined)?.createdAt;
      return typeof createdAt === 'number' ? { id, createdAt } : { id };
    } catch {
      return null;
    }
  }

  /**
   * Find the single nearest accepted point of the given kind to the supplied
   * vector — scoped to the same set of cards that would be visible to a
   * `searchWithVector` call with the same `project`. Superseded/deprecated
   * points are excluded so we don't ever treat an obsolete card as "duplicate"
   * of a new write.
   *
   * Project scoping rules (mirror `makeProjectPredicate`):
   *  - `project=X` passed → match cards with `project=X` OR no `project` field.
   *    A same-text card in `project=Y` is invisible to the gate, so writing
   *    "use UUIDv7" in app-a is never blocked by an identical card in app-b.
   *  - `project` undefined → only consider cards without a `project` field.
   *    A new global card isn't blocked by a project-scoped near-match, and a
   *    project-scoped card's `updatedAt` is never bumped by a global write.
   *
   * Filtering is post-fetch: Qdrant `must`/`should` semantics with absent-key
   * detection are awkward to express cleanly, and the gate fetches a tiny
   * overfetch (10 hits) so the cost is bounded.
   */
  private async findNearest(
    group: string,
    kind: ArchKind,
    vector: number[],
    project: string | undefined
  ): Promise<{ id: string; score: number; label: string } | null> {
    try {
      const hits = await this.qdrant.search(toArchCollectionName(group), {
        vector,
        // Overfetch so the post-filter has candidates if the top-1 is in a
        // different project. Arch collections are tiny — 10 is cheap.
        limit: 10,
        with_payload: true,
        filter: {
          must: [{ key: 'arch_kind', match: { value: kind } }],
          must_not: [
            { key: 'status', match: { value: 'superseded' } },
            { key: 'status', match: { value: 'deprecated' } },
          ],
        },
      });
      for (const hit of hits) {
        const payload = (hit.payload ?? {}) as { project?: unknown };
        const hitProject = payload.project;
        if (project === undefined) {
          // Global write: only consider cards without a project field.
          if (hitProject !== undefined && hitProject !== null) continue;
        } else {
          // Project-scoped write: same project OR no project field.
          if (hitProject !== undefined && hitProject !== null && hitProject !== project) {
            continue;
          }
        }
        const rawId = hit.id;
        const id =
          typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
        if (!id) continue;
        return { id, score: hit.score, label: labelFromPayload(hit.payload) };
      }
      return null;
    } catch {
      return null;
    }
  }

  async search(group: string, query: string, opts: SearchOpts = {}): Promise<ArchSearchHit[]> {
    const vector = await this.provider.embed(query);
    return this.searchWithVector(group, vector, opts);
  }

  /**
   * Same as `search`, but accepts a pre-computed query vector — lets callers
   * embed once and fan out across multiple groups without re-embedding.
   */
  async searchWithVector(
    group: string,
    vector: number[],
    opts: SearchOpts = {}
  ): Promise<ArchSearchHit[]> {
    const limit = opts.limit ?? 8;
    const must: unknown[] = [];
    if (opts.kinds && opts.kinds.length > 0) {
      must.push({ key: 'arch_kind', match: { any: opts.kinds } });
    }
    const must_not: unknown[] = [];
    if (!opts.includeHistory) {
      must_not.push(
        { key: 'status', match: { value: 'superseded' } },
        { key: 'status', match: { value: 'deprecated' } }
      );
    }
    const filter: Record<string, unknown> = {};
    if (must.length > 0) filter['must'] = must;
    if (must_not.length > 0) filter['must_not'] = must_not;
    // When `project` is set the project filter is applied post-fetch (Qdrant
    // can't express "hard match for components, soft match for decisions/
    // lessons" in a single filter cleanly). Overfetch so the post-filter
    // doesn't return an artificially short list. Arch collections are tiny
    // (low thousands), so 3x is cheap and bounded.
    const fetchLimit = opts.project !== undefined ? limit * 3 : limit;
    try {
      const hits = await this.qdrant.search(toArchCollectionName(group), {
        vector,
        limit: fetchLimit,
        with_payload: true,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      });
      const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0;
      const matchesProject = makeProjectPredicate(opts.project);
      // Project-scoped retrieval boost.
      //
      // bge-m3 cosine systematically favours short generic text — a one-line
      // global decision often outscores a longer project-scoped component
      // even when the component is what the caller actually wants. When the
      // caller asked for a specific project, bias the ranking toward cards
      // that name that project so they aren't drowned out on cosine alone.
      //
      // Only the *ranking* surface boosts. The similarity gate (findNearest)
      // is intentionally untouched — duplicate detection must compare raw
      // cosines, otherwise a project-tagged card becomes harder to dedupe.
      //
      // The boost is additive (not multiplicative) so a strong global card
      // (e.g. 0.85) still beats a weak project-scoped one (e.g. 0.45 + 0.05 =
      // 0.50). 0.05 ≈ one tier in the calibrated bge-m3 score bands — enough
      // to break ties on short-text bias without rewriting the ordering of
      // genuinely better matches. minScore is applied AFTER the boost so a
      // borderline project-scoped card can still surface.
      const boosted = hits.map((h) => {
        const point = h.payload as unknown as ArchPoint;
        const cardProject = (point as { project?: unknown }).project;
        const boost =
          opts.project !== undefined &&
          typeof cardProject === 'string' &&
          cardProject === opts.project
            ? PROJECT_SCORE_BOOST
            : 0;
        return { point, score: Math.min(1, h.score + boost) };
      });
      // Re-sort after the boost — the original `hits` were ordered by raw
      // cosine, but a freshly-boosted project-scoped card may now outrank an
      // earlier global one.
      boosted.sort((a, b) => b.score - a.score);
      const filtered = boosted
        .filter((h) => h.score >= minScore)
        .filter((h) => matchesProject(h.point))
        .map((h) => ({ ...h.point, score: h.score }));
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * Count points per `arch_kind` and `status`, plus min/avg/max `updatedAt`.
   * Drives the `arch://stats/{group}` resource and the Prometheus
   * `paparats_arch_collection_size` gauge.
   */
  async stats(group: string): Promise<ArchStats> {
    const out: ArchStats = {
      group,
      total: 0,
      byKind: { component: 0, decision: 0, lesson: 0 },
      byStatus: { proposed: 0, accepted: 0, superseded: 0, deprecated: 0 },
      oldestUpdatedAt: null,
      newestUpdatedAt: null,
    };
    let offset: string | number | Record<string, unknown> | undefined | null = undefined;
    try {
      // Scroll the whole collection. Arch collections are tiny (< low thousands),
      // so scan-all is fine — no need for cardinality estimators.
      while (true) {
        const page = await this.qdrant.scroll(toArchCollectionName(group), {
          limit: 256,
          with_payload: true,
          with_vector: false,
          ...(offset !== undefined && offset !== null ? { offset } : {}),
        });
        for (const p of page.points) {
          const pl = p.payload ?? {};
          out.total += 1;
          const kind = pl['arch_kind'] ?? pl['kind'];
          if (kind === 'component' || kind === 'decision' || kind === 'lesson') {
            out.byKind[kind] += 1;
          }
          const status = pl['status'];
          if (
            status === 'proposed' ||
            status === 'accepted' ||
            status === 'superseded' ||
            status === 'deprecated'
          ) {
            out.byStatus[status] += 1;
          }
          const updatedAt = pl['updatedAt'];
          if (typeof updatedAt === 'number') {
            if (out.oldestUpdatedAt === null || updatedAt < out.oldestUpdatedAt) {
              out.oldestUpdatedAt = updatedAt;
            }
            if (out.newestUpdatedAt === null || updatedAt > out.newestUpdatedAt) {
              out.newestUpdatedAt = updatedAt;
            }
          }
        }
        if (!page.next_page_offset) break;
        offset = page.next_page_offset;
      }
    } catch {
      // Collection doesn't exist yet (or transient error) — leave zeros.
    }
    return out;
  }
}

export interface ArchStats {
  group: string;
  total: number;
  byKind: Record<ArchKind, number>;
  byStatus: Record<ArchStatus, number>;
  oldestUpdatedAt: number | null;
  newestUpdatedAt: number | null;
}

// ── Embedding text renderers ───────────────────────────────────────────────
// Kept as free functions so tests can call them without standing up a store.

function renderComponentForEmbedding(input: UpsertComponentInput): string {
  return [
    `Component: ${input.name}`,
    '',
    input.summary,
    '',
    `Files: ${input.files.join(', ')}`,
    `Neighbours: ${input.neighbours.join(', ')}`,
  ].join('\n');
}

function renderDecisionForEmbedding(input: UpsertDecisionInput): string {
  return [
    `Decision: ${input.title}`,
    '',
    `Context: ${input.context}`,
    '',
    `Decision: ${input.decision}`,
    '',
    `Alternatives rejected: ${input.alternativesRejected}`,
    '',
    `Consequences: ${input.consequences}`,
  ].join('\n');
}

function renderLessonForEmbedding(input: UpsertLessonInput): string {
  return [`Lesson: ${input.rule}`, '', `Why: ${input.why}`, '', `When: ${input.when}`].join('\n');
}

/**
 * Build a predicate that scopes hits to a single project:
 *   - components: kept only when their `project` matches (hard filter — a
 *     component with no project, or a project ≠ the target, is dropped).
 *   - decisions / lessons: kept when their `project` matches OR is absent
 *     (soft filter — globally-scoped cards still surface).
 * Returns a pass-everything predicate when `project` is undefined, so callers
 * can apply it unconditionally.
 */
export function makeProjectPredicate(project: string | undefined): (point: ArchPoint) => boolean {
  if (project === undefined) return () => true;
  return (point) => {
    const cardProject = (point as { project?: unknown }).project;
    if (point.kind === 'component') {
      return typeof cardProject === 'string' && cardProject === project;
    }
    // decisions / lessons: project=X passes, no project field also passes
    if (cardProject === undefined || cardProject === null) return true;
    return typeof cardProject === 'string' && cardProject === project;
  };
}

function labelFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  if (typeof p['title'] === 'string') return p['title'] as string;
  if (typeof p['name'] === 'string') return p['name'] as string;
  if (typeof p['rule'] === 'string') return p['rule'] as string;
  return '';
}
