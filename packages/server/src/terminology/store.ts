import type { QdrantClient } from '@qdrant/js-client-rest';
import { v7 as uuidv7 } from 'uuid';
import type { CachedEmbeddingProvider } from '../embeddings.js';
import {
  dropTermsCollection,
  ensureTermsCollection,
  fromTermsCollectionName,
  readTermsCollectionMeta,
  toTermsCollectionName,
  writeTermsCollectionMeta,
} from './collection.js';
import type { Term, TermSearchHit, TermWriteResult } from './types.js';

export interface TerminologyStoreConfig {
  qdrant: QdrantClient;
  provider: CachedEmbeddingProvider;
}

export interface RecordTermInput {
  term: string;
  definition: string;
  aliases?: string[];
  project?: string;
}

export interface TermSearchOpts {
  project?: string;
  limit?: number;
  minScore?: number;
}

/**
 * Similarity floor above which a write is refused as a duplicate.
 *
 * Deliberately very high, because cosine similarity between rendered glossary
 * entries does not separate "same concept" from "same kind of concept". Entries
 * share their structure and their domain ("ACO template that...", "Jobs in the
 * inbound feed that...", "Cost Per X — spend divided by Y"), so the vector largely
 * reflects the genre of the text rather than which term it defines — and the effect
 * worsens as the glossary grows, because more legitimate neighbours crowd the top
 * of the range.
 *
 * Measured while importing a 53-entry glossary into a store that already held 26
 * terms. The previous 0.72 floor refused 19 of the 53; on inspection only 3 were
 * genuine (a canonical name colliding with an existing alias), so 16/19 — 84% —
 * were false, spread across 0.724–0.889. Blocked pairs included a campaign-strategy
 * template against a publisher-side bidding mode, a volume metric against a scoring
 * subsystem, and two separate cost metrics from the same family: all distinct
 * concepts that merely read alike.
 *
 * That 0.72 came from an earlier calibration on a 27-term glossary, where genuine
 * duplicates appeared to start at 0.739. At 75 terms that band is simply full of
 * legitimate pairs, so the earlier number did not survive scale.
 *
 * At 0.95 the gate only catches near-verbatim restatements. It gives up on
 * detecting reworded duplicates on purpose: the three genuine collisions it would
 * have caught are all already handled by name idempotency (recording an existing
 * `term` overwrites in place), whereas a false block silently costs a real term.
 * Losing a term is worse than admitting a near-duplicate an author can merge.
 *
 * `TermWriteStatus` still carries `'similar'` for wire compatibility, but nothing
 * produces it.
 */
const DUPLICATE_THRESHOLD = 0.95;

/**
 * Is this error just "the glossary doesn't exist yet"?
 *
 * That case is genuinely an empty glossary and must read as one — a group that has
 * never had a term recorded has no collection. Everything else (auth rejected,
 * host unreachable, timeout) is a failure that happens to *look* identical if
 * swallowed: callers cannot tell "no terms" from "could not ask", so query
 * expansion silently stops enriching and `term_list` reports an empty glossary the
 * agent may then re-populate. Qdrant answers 404 for the missing collection and
 * 401/5xx/network for the rest, so the two are cleanly separable.
 */
function isMissingCollection(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * The glossary store. Agent-authored via MCP `term_record`; searched via
 * `term_search`. Records go through a similarity gate (like arch decisions) so
 * the agent doesn't silently pile up near-duplicate definitions. Terms are
 * idempotent by canonical `term` name within a project scope.
 */
export class TerminologyStore {
  private qdrant: QdrantClient;
  private provider: CachedEmbeddingProvider;

  constructor(config: TerminologyStoreConfig) {
    this.qdrant = config.qdrant;
    this.provider = config.provider;
  }

  async embedQuestion(question: string): Promise<number[]> {
    return this.provider.embed(question);
  }

  /**
   * Record a term. If a term with the same canonical name (and project scope)
   * exists, it's overwritten (`updated`). Otherwise the definition text goes
   * through the similarity gate: a duplicate/similar near-match short-circuits
   * the write and returns the matched term so the agent can reconcile.
   */
  async recordTerm(group: string, input: RecordTermInput): Promise<TermWriteResult> {
    await ensureTermsCollection(this.qdrant, group, this.provider.dimensions, this.provider.model);

    // Idempotent by exact term name within the project scope.
    const existing = await this.findByTerm(group, input.term, input.project);
    const text = renderTermForEmbedding(input);
    const vector = await this.provider.embed(text);

    if (!existing) {
      const match = await this.findNearest(group, vector, input.project);
      if (match && match.score >= DUPLICATE_THRESHOLD) {
        return {
          status: 'duplicate',
          id: match.id,
          similarity: match.score,
          matchedLabel: match.label,
        };
      }
    }

    const id = existing?.id ?? uuidv7();
    const now = Date.now();
    const payload: Record<string, unknown> = {
      id,
      term: input.term,
      definition: input.definition,
      aliases: input.aliases ?? [],
      ...(input.project !== undefined ? { project: input.project } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.qdrant.upsert(toTermsCollectionName(group), {
      wait: true,
      points: [{ id, vector, payload }],
    });
    return { status: existing ? 'updated' : 'created', id };
  }

  /**
   * Look up the glossary: exact name/alias match first, vector search as fallback.
   *
   * A glossary lookup is overwhelmingly "what does <acronym> mean", and that is the
   * one query shape the vector is worst at. Embedding a bare token gives the model
   * nothing to condition on, so the vector lands in the centre of the glossary's
   * genre rather than near the entry that defines it. Measured against a live
   * 75-term glossary: a three-letter acronym queried on its own ranked its own entry
   * 21st (0.469), behind an unrelated volume metric at 0.620 — while the same acronym
   * wrapped as "what is X" ranked it 1st. Two cost metrics likewise returned a
   * same-family neighbour above their own entry.
   *
   * A score floor cannot rescue this, because the bands overlap: invented acronyms
   * (0.605, 0.623) outscore real entries queried by name (0.576, 0.597), so any
   * floor that suppresses noise also deletes real terms. Exact match sidesteps
   * the vector entirely for the queries that matter, and leaves the vector to do what
   * it is good at — paraphrases and descriptive questions — with a floor applied.
   *
   * The fallback embeds via `embedQuery`, not `embed`. qwen3 is a decoder with
   * last-token pooling, so the card's retrieval instruction is part of its trained
   * query interface rather than decoration, and the stored entries are unprefixed
   * (see `prefixPassage`) — so this needs no re-indexing. Measured over one
   * paraphrase per glossary entry (75 queries, each the entry's own definition with
   * every name and alias token stripped): bare `embed` ranked the right term first
   * 46/75 (61.3%), instructed 68/75 (90.7%), and the right term went from 65/75 to
   * 75/75 within the top 8. It also pushes noise down hard — across 40 negatives the
   * top score fell from the 0.59-0.62 band to 0.515 — which is what makes a
   * meaningful floor possible at all.
   *
   * Priority is canonical name over alias: 7 of the live glossary's alias keys shadow
   * some other entry's canonical name — a cost metric that is also listed as an alias
   * of a broader quality concept, a campaign template that is also an alias of the
   * subsystem owning it — and returning the alias holder for an exact name query hides
   * the entry the caller asked for.
   */
  async search(group: string, query: string, opts: TermSearchOpts = {}): Promise<TermSearchHit[]> {
    const limit = opts.limit ?? 8;

    const exact = await this.findExactMatches(group, query, opts.project, limit);
    if (exact.length > 0) return exact;

    const vector = await this.provider.embedQuery(query);
    const must_not: unknown[] = [{ key: '__meta', match: { value: true } }];
    const fetchLimit = opts.project !== undefined ? limit * 3 : limit;
    try {
      const hits = await this.qdrant.search(toTermsCollectionName(group), {
        vector,
        limit: fetchLimit,
        with_payload: true,
        filter: { must_not },
      });
      const minScore = typeof opts.minScore === 'number' ? opts.minScore : 0;
      const matchesProject = makeProjectPredicate(opts.project);
      return hits
        .map((h) => ({ term: toTerm(h.payload), score: h.score }))
        .filter((h) => h.term !== null && h.score >= minScore)
        .filter((h) => matchesProject(h.term!))
        .map((h) => ({ ...(h.term as Term), score: h.score }))
        .slice(0, limit);
    } catch (err) {
      if (isMissingCollection(err)) return [];
      throw err;
    }
  }

  /** List all terms in a group (optionally project-scoped). */
  async list(group: string, opts: { project?: string; limit?: number } = {}): Promise<Term[]> {
    const limit = opts.limit ?? 200;
    const matchesProject = makeProjectPredicate(opts.project);
    const out: Term[] = [];
    let offset: string | number | Record<string, unknown> | undefined | null = undefined;
    try {
      while (out.length < limit) {
        const page = await this.qdrant.scroll(toTermsCollectionName(group), {
          limit: 256,
          with_payload: true,
          with_vector: false,
          filter: { must_not: [{ key: '__meta', match: { value: true } }] },
          ...(offset !== undefined && offset !== null ? { offset } : {}),
        });
        for (const p of page.points) {
          const term = toTerm(p.payload);
          if (term && matchesProject(term)) out.push(term);
        }
        if (!page.next_page_offset) break;
        offset = page.next_page_offset;
      }
    } catch (err) {
      if (isMissingCollection(err)) return [];
      throw err;
    }
    return out.slice(0, limit);
  }

  /** Delete a term by id. Idempotent. */
  async deleteTerm(group: string, id: string): Promise<boolean> {
    try {
      await this.qdrant.delete(toTermsCollectionName(group), { points: [id], wait: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Terms whose canonical name or alias equals `query`, case- and space-insensitively.
   *
   * Matching happens client-side over the group's terms rather than as a Qdrant
   * filter: `match: { value }` is exact and case-sensitive, so it would miss a
   * lowercased acronym, and there is no portable case-folding filter. A glossary is small
   * (hundreds of entries) and `list` already pages it, so the scan is cheap.
   *
   * Exact matches carry `score: 1` — they are identity, not similarity, and callers
   * applying a `minScore` floor must never filter them out.
   */
  private async findExactMatches(
    group: string,
    query: string,
    project: string | undefined,
    limit: number
  ): Promise<TermSearchHit[]> {
    const wanted = normalizeLookupKey(query);
    if (wanted === '') return [];

    const all = await this.list(group, { ...(project !== undefined ? { project } : {}) });
    const byName: Term[] = [];
    const byAlias: Term[] = [];
    for (const term of all) {
      if (normalizeLookupKey(term.term) === wanted) byName.push(term);
      else if (term.aliases.some((a) => normalizeLookupKey(a) === wanted)) byAlias.push(term);
    }
    // Name beats alias; an alias claimed by several terms returns all of them so the
    // caller can disambiguate instead of silently getting whichever came back first.
    const matches = byName.length > 0 ? byName : byAlias;
    return matches.slice(0, limit).map((term) => ({ ...term, score: 1 }));
  }

  private async findByTerm(
    group: string,
    term: string,
    project?: string
  ): Promise<{ id: string; createdAt?: number } | null> {
    try {
      const must: unknown[] = [{ key: 'term', match: { value: term } }];
      if (project !== undefined) must.push({ key: 'project', match: { value: project } });
      const res = await this.qdrant.scroll(toTermsCollectionName(group), {
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
    } catch (err) {
      // Must not degrade to null on a real failure: recordTerm reads null as
      // "no such term yet" and mints a fresh id, so a transient error would
      // write a duplicate of an existing term and reset its createdAt.
      if (isMissingCollection(err)) return null;
      throw err;
    }
  }

  private async findNearest(
    group: string,
    vector: number[],
    project: string | undefined
  ): Promise<{ id: string; score: number; label: string } | null> {
    try {
      const hits = await this.qdrant.search(toTermsCollectionName(group), {
        vector,
        limit: 10,
        with_payload: true,
        filter: { must_not: [{ key: '__meta', match: { value: true } }] },
      });
      for (const hit of hits) {
        const payload = (hit.payload ?? {}) as { project?: unknown; term?: unknown };
        const hitProject = payload.project;
        if (project === undefined) {
          if (hitProject !== undefined && hitProject !== null) continue;
        } else {
          if (hitProject !== undefined && hitProject !== null && hitProject !== project) continue;
        }
        const rawId = hit.id;
        const id =
          typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
        if (!id) continue;
        return {
          id,
          score: hit.score,
          label: typeof payload.term === 'string' ? payload.term : '',
        };
      }
      return null;
    } catch (err) {
      // Null here means "nothing similar", which lets the write through. On a real
      // failure that silently disables the duplicate/similar gate.
      if (isMissingCollection(err)) return null;
      throw err;
    }
  }

  // ── Model self-heal (mirror arch/docs) ────────────────────────────────────

  async reindexTerms(group: string): Promise<number> {
    const collection = toTermsCollectionName(group);
    const rows: Array<{ id: string | number; payload: Record<string, unknown> }> = [];
    let offset: string | number | Record<string, unknown> | undefined | null = undefined;
    try {
      while (true) {
        const page = await this.qdrant.scroll(collection, {
          limit: 256,
          with_payload: true,
          with_vector: false,
          ...(offset !== undefined && offset !== null ? { offset } : {}),
        });
        for (const p of page.points) {
          if (p.id === undefined || p.id === null) continue;
          const payload = (p.payload ?? {}) as Record<string, unknown>;
          if (payload['__meta'] === true) continue;
          rows.push({ id: p.id, payload });
        }
        if (!page.next_page_offset) break;
        offset = page.next_page_offset;
      }
    } catch {
      return 0;
    }
    if (rows.length === 0) return 0;

    let dimensionChanged: boolean;
    try {
      const info = await this.qdrant.getCollection(collection);
      const size = (info.config?.params?.vectors as { size?: number } | undefined)?.size;
      dimensionChanged = typeof size === 'number' && size !== this.provider.dimensions;
    } catch {
      dimensionChanged = true;
    }
    if (dimensionChanged) {
      await dropTermsCollection(this.qdrant, group);
    }
    await ensureTermsCollection(this.qdrant, group, this.provider.dimensions, this.provider.model);

    const points = [];
    for (const r of rows) {
      const text = renderTermForEmbedding({
        term: typeof r.payload['term'] === 'string' ? r.payload['term'] : '',
        definition: typeof r.payload['definition'] === 'string' ? r.payload['definition'] : '',
        aliases: Array.isArray(r.payload['aliases']) ? r.payload['aliases'].map(String) : [],
      });
      const vector = await this.provider.embed(text);
      points.push({ id: r.id, vector, payload: r.payload });
    }
    const BATCH = 128;
    for (let i = 0; i < points.length; i += BATCH) {
      await this.qdrant.upsert(collection, { wait: true, points: points.slice(i, i + BATCH) });
    }
    await writeTermsCollectionMeta(this.qdrant, group, {
      model: this.provider.model,
      dimensions: this.provider.dimensions,
    });
    return points.length;
  }

  async healTermsModel(group: string): Promise<number> {
    const meta = await readTermsCollectionMeta(this.qdrant, group);
    if (
      meta &&
      meta.model === this.provider.model &&
      meta.dimensions === this.provider.dimensions
    ) {
      return 0;
    }
    return this.reindexTerms(group);
  }

  async healAllTermsModels(): Promise<void> {
    let collections: string[];
    try {
      const res = await this.qdrant.getCollections();
      collections = res.collections.map((c) => c.name);
    } catch (err) {
      console.warn(
        `[terms] model-heal skipped — could not list collections: ${(err as Error).message}`
      );
      return;
    }
    for (const name of collections) {
      const group = fromTermsCollectionName(name);
      if (group === null) continue;
      try {
        const n = await this.healTermsModel(group);
        if (n > 0) {
          console.log(
            `[terms] re-embedded ${n} term(s) in group "${group}" with ${this.provider.model} (text model changed)`
          );
        }
      } catch (err) {
        console.warn(`[terms] model-heal failed for group "${group}": ${(err as Error).message}`);
      }
    }
  }

  /**
   * Number of glossary terms in one group.
   *
   * Read from `points_count` less the meta sentinel: one point per term, so no
   * scroll is needed. Unlike `list()`, this is not capped by a page limit.
   * Returns 0 for a group with no terms collection yet.
   */
  async stats(group: string): Promise<TermsStats> {
    try {
      const info = await this.qdrant.getCollection(toTermsCollectionName(group));
      const raw = info.points_count ?? 0;
      return { group, terms: Math.max(0, raw - 1) };
    } catch {
      return { group, terms: 0 };
    }
  }
}

/** Per-group total for the terminology layer, surfaced by the dashboard. */
export interface TermsStats {
  group: string;
  terms: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function renderTermForEmbedding(input: {
  term: string;
  definition: string;
  aliases?: string[];
}): string {
  const aliases =
    input.aliases && input.aliases.length > 0 ? `\nAliases: ${input.aliases.join(', ')}` : '';
  return `Term: ${input.term}\n\n${input.definition}${aliases}`;
}

/** Fold a term name or alias to a comparison key: trimmed, collapsed, lowercased. */
function normalizeLookupKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function toTerm(payload: unknown): Term | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p['__meta'] === true) return null;
  if (typeof p['term'] !== 'string' || typeof p['id'] !== 'string') return null;
  return {
    id: p['id'],
    term: p['term'],
    definition: typeof p['definition'] === 'string' ? p['definition'] : '',
    aliases: Array.isArray(p['aliases']) ? p['aliases'].map(String) : [],
    ...(typeof p['project'] === 'string' ? { project: p['project'] } : {}),
    createdAt: typeof p['createdAt'] === 'number' ? p['createdAt'] : 0,
    updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : 0,
  };
}

/** project=X → cards with project=X or no project pass; undefined → all pass. */
function makeProjectPredicate(project: string | undefined): (t: Term) => boolean {
  if (project === undefined) return () => true;
  return (t) => t.project === undefined || t.project === project;
}
