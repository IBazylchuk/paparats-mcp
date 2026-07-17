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

// Similarity gate — carried over from the arch bands (calibrated on bge-m3,
// re-used here with qwen3, not re-tuned). A near-identical term is a duplicate;
// an overlapping-but-distinct one is "similar".
const DUPLICATE_THRESHOLD = 0.85;
const SIMILAR_THRESHOLD = 0.7;

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
    await ensureTermsCollection(
      this.qdrant,
      group,
      this.provider.dimensions,
      this.provider.model
    );

    // Idempotent by exact term name within the project scope.
    const existing = await this.findByTerm(group, input.term, input.project);
    const text = renderTermForEmbedding(input);
    const vector = await this.provider.embed(text);

    if (!existing) {
      const match = await this.findNearest(group, vector, input.project);
      if (match && match.score >= DUPLICATE_THRESHOLD) {
        return { status: 'duplicate', id: match.id, similarity: match.score, matchedLabel: match.label };
      }
      if (match && match.score >= SIMILAR_THRESHOLD) {
        return { status: 'similar', id: match.id, similarity: match.score, matchedLabel: match.label };
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

  /** Semantic search over the glossary. */
  async search(group: string, query: string, opts: TermSearchOpts = {}): Promise<TermSearchHit[]> {
    const limit = opts.limit ?? 8;
    const vector = await this.provider.embed(query);
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
    } catch {
      return [];
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
    } catch {
      return [];
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
      const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
      if (!id) return null;
      const createdAt = (point.payload as { createdAt?: unknown } | undefined)?.createdAt;
      return typeof createdAt === 'number' ? { id, createdAt } : { id };
    } catch {
      return null;
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
        const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : null;
        if (!id) continue;
        return { id, score: hit.score, label: typeof payload.term === 'string' ? payload.term : '' };
      }
      return null;
    } catch {
      return null;
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
    if (meta && meta.model === this.provider.model && meta.dimensions === this.provider.dimensions) {
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
}

// ── helpers ─────────────────────────────────────────────────────────────────

function renderTermForEmbedding(input: {
  term: string;
  definition: string;
  aliases?: string[];
}): string {
  const aliases = input.aliases && input.aliases.length > 0 ? `\nAliases: ${input.aliases.join(', ')}` : '';
  return `Term: ${input.term}\n\n${input.definition}${aliases}`;
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
