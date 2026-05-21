import type { QdrantClient } from '@qdrant/js-client-rest';
import { v7 as uuidv7 } from 'uuid';
import type { CachedEmbeddingProvider } from '../embeddings.js';
import { ensureArchCollection, toArchCollectionName } from './collection.js';
import type { ArchKind, ArchPoint, ArchStatus, ArchScope, ArchSeverity } from './types.js';

export interface ArchStoreConfig {
  qdrant: QdrantClient;
  provider: CachedEmbeddingProvider;
}

interface UpsertComponentInput {
  name: string;
  summary: string;
  files: string[];
  neighbours: string[];
  anchors: string[];
}

interface UpsertDecisionInput {
  title: string;
  context: string;
  decision: string;
  consequences: string;
  scope: ArchScope;
  status?: ArchStatus;
  supersedes?: string | null;
}

interface UpsertLessonInput {
  summary: string;
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
}

export class ArchStore {
  private qdrant: QdrantClient;
  private provider: CachedEmbeddingProvider;

  constructor(config: ArchStoreConfig) {
    this.qdrant = config.qdrant;
    this.provider = config.provider;
  }

  /** Idempotent by name: a component with the same name reuses its id. */
  async upsertComponent(group: string, input: UpsertComponentInput): Promise<string> {
    await ensureArchCollection(this.qdrant, group, this.provider.dimensions);
    const existingId = await this.findByName(group, 'component', input.name);
    const id = existingId ?? uuidv7();
    const now = Date.now();
    const text = `Component: ${input.name}\n\n${input.summary}\n\nFiles: ${input.files.join(
      ', '
    )}\nNeighbours: ${input.neighbours.join(', ')}`;
    const vector = await this.provider.embed(text);
    const payload: Record<string, unknown> = {
      arch_kind: 'component',
      kind: 'component',
      id,
      name: input.name,
      summary: input.summary,
      files: input.files,
      neighbours: input.neighbours,
      anchors: input.anchors,
      status: 'accepted',
      scope: 'global',
      updatedAt: now,
    };
    if (!existingId) payload['createdAt'] = now;
    await this.qdrant.upsert(toArchCollectionName(group), {
      wait: true,
      points: [{ id, vector, payload }],
    });
    return id;
  }

  async upsertDecision(group: string, input: UpsertDecisionInput): Promise<string> {
    await ensureArchCollection(this.qdrant, group, this.provider.dimensions);
    const id = uuidv7();
    const now = Date.now();
    const text = `Decision: ${input.title}\n\nContext:\n${input.context}\n\nDecision:\n${input.decision}\n\nConsequences:\n${input.consequences}`;
    const vector = await this.provider.embed(text);
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
            title: input.title,
            context: input.context,
            decision: input.decision,
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
    return id;
  }

  async upsertLesson(group: string, input: UpsertLessonInput): Promise<string> {
    await ensureArchCollection(this.qdrant, group, this.provider.dimensions);
    const id = uuidv7();
    const now = Date.now();
    const text = `Lesson: ${input.summary}${
      input.evidence ? `\n\nEvidence: ${input.evidence}` : ''
    }`;
    const vector = await this.provider.embed(text);
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
            summary: input.summary,
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
    return id;
  }

  async markSuperseded(group: string, pointId: string): Promise<void> {
    await this.qdrant.setPayload(toArchCollectionName(group), {
      payload: { status: 'superseded' },
      points: [pointId],
      wait: true,
    });
  }

  async findByName(group: string, kind: ArchKind, name: string): Promise<string | null> {
    try {
      const res = await this.qdrant.scroll(toArchCollectionName(group), {
        filter: {
          must: [
            { key: 'arch_kind', match: { value: kind } },
            { key: 'name', match: { value: name } },
          ],
        },
        with_payload: false,
        with_vector: false,
        limit: 1,
      });
      const id = res.points[0]?.id;
      if (typeof id === 'string') return id;
      if (typeof id === 'number') return String(id);
      return null;
    } catch {
      return null;
    }
  }

  async search(group: string, query: string, opts: SearchOpts = {}): Promise<ArchPoint[]> {
    const limit = opts.limit ?? 8;
    const vector = await this.provider.embed(query);
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
    try {
      const hits = await this.qdrant.search(toArchCollectionName(group), {
        vector,
        limit,
        with_payload: true,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      });
      return hits.map((h) => h.payload as unknown as ArchPoint);
    } catch {
      return [];
    }
  }
}
