import type { QdrantClient } from '@qdrant/js-client-rest';
import { v7 as uuidv7 } from 'uuid';
import type { CachedEmbeddingProvider } from '../embeddings.js';
import {
  DOCS_DENSE_VECTOR,
  DOCS_SPARSE_VECTOR,
  dropDocsCollection,
  ensureDocsCollection,
  fromDocsCollectionName,
  readDocsCollectionMeta,
  toDocsCollectionName,
  writeDocsCollectionMeta,
} from './collection.js';
import {
  buildDocumentSparseVector,
  buildQuerySparseVector,
  tokenize,
  type SparseVector,
} from './bm25.js';
import type { DocsIdfStore } from './idf-store.js';
import { chunkMarkdown, NotMarkdownError } from './chunker.js';
import type { DocsChunk, DocsSearchHit } from './types.js';

export interface DocsStoreConfig {
  qdrant: QdrantClient;
  provider: CachedEmbeddingProvider;
  idf: DocsIdfStore;
}

/** Input describing one markdown document to index (or re-index). */
export interface IndexDocumentInput {
  project: string;
  /** Repo-relative path of the source file. The (project, file) pair is the dedup key. */
  file: string;
  content: string;
  /** Human title for the breadcrumb/citation. Defaults to the file basename. */
  docTitle?: string;
  /** Canonical link (e.g. Confluence page URL) surfaced in search results. */
  sourceUrl?: string | null;
}

export interface DocsSearchOpts {
  project?: string;
  limit?: number;
  /** Number of neighbouring chunks to merge around each hit for context. Default 1. */
  mergeNeighbours?: number;
}

/**
 * The docs layer store: indexes markdown documents into a hybrid (dense qwen3 +
 * sparse BM25) Qdrant collection and searches them with server-side RRF fusion,
 * then auto-merges neighbouring chunks for context.
 *
 * Unlike arch (tool-authored, similarity-gated) docs are file-authored: the
 * indexer walks `.md` files and calls {@link indexDocument}. Dedup is by
 * (project, file) — re-indexing a file deletes its prior chunks first.
 */
export class DocsStore {
  private qdrant: QdrantClient;
  private provider: CachedEmbeddingProvider;
  private idf: DocsIdfStore;

  constructor(config: DocsStoreConfig) {
    this.qdrant = config.qdrant;
    this.provider = config.provider;
    this.idf = config.idf;
  }

  /**
   * Index (or re-index) one markdown document. Chunks it structurally, embeds
   * each chunk with the dense provider, builds a BM25 sparse vector, and upserts
   * all chunks under a shared `doc_id`. Prior chunks for the same (project, file)
   * are deleted first so updates don't leave stragglers.
   *
   * @throws {NotMarkdownError} — propagated from the chunker; callers (the walk)
   *   log and skip. Non-markdown files must never reach the collection.
   * @returns the number of chunks written.
   */
  async indexDocument(group: string, input: IndexDocumentInput): Promise<number> {
    // chunkMarkdown throws NotMarkdownError for non-markdown — let it propagate.
    const docTitle = input.docTitle ?? basename(input.file);
    const chunks = chunkMarkdown(input.content, { docTitle });

    await ensureDocsCollection(
      this.qdrant,
      group,
      this.provider.dimensions,
      this.provider.model
    );

    // Remove the file's previous chunks (and their IDF contribution) first.
    await this.deleteDocument(group, input.project, input.file);

    if (chunks.length === 0) return 0;

    const docId = uuidv7();
    const stats = this.idf.getCorpusStats(group);
    const points = [];
    for (const chunk of chunks) {
      const dense = await this.provider.embed(chunk.content);
      const sparse = buildDocumentSparseVector(chunk.content, stats);
      const id = uuidv7();
      points.push({
        id,
        vector: {
          [DOCS_DENSE_VECTOR]: dense,
          ...(sparse.indices.length > 0 ? { [DOCS_SPARSE_VECTOR]: sparse } : {}),
        },
        payload: buildPayload(docId, docTitle, input, chunk),
      });
      // Update corpus stats with this chunk's DISTINCT terms.
      const terms = new Set(tokenize(chunk.content));
      this.idf.addDocument(group, terms, terms.size);
    }

    await this.qdrant.upsert(toDocsCollectionName(group), { wait: true, points });
    return points.length;
  }

  /**
   * Delete every chunk of a (project, file) document and reverse its IDF
   * contribution. Idempotent — a file with no indexed chunks is a no-op.
   */
  async deleteDocument(group: string, project: string, file: string): Promise<void> {
    const collection = toDocsCollectionName(group);
    // Reverse IDF first: scroll the file's chunks to recover their term sets.
    let offset: string | number | Record<string, unknown> | undefined | null = undefined;
    const filter = {
      must: [
        { key: 'project', match: { value: project } },
        { key: 'file', match: { value: file } },
      ],
    };
    try {
      while (true) {
        const page = await this.qdrant.scroll(collection, {
          limit: 256,
          with_payload: true,
          with_vector: false,
          filter,
          ...(offset !== undefined && offset !== null ? { offset } : {}),
        });
        for (const p of page.points) {
          const content = (p.payload as { content?: unknown } | undefined)?.content;
          if (typeof content === 'string') {
            const terms = new Set(tokenize(content));
            this.idf.removeDocument(group, terms, terms.size);
          }
        }
        if (!page.next_page_offset) break;
        offset = page.next_page_offset;
      }
    } catch {
      // Collection doesn't exist yet — nothing to delete.
      return;
    }
    await this.qdrant.delete(collection, { filter, wait: true });
  }

  /** Delete all docs for a project (all files). Also clears is left to reindex flows. */
  async deleteProject(group: string, project: string): Promise<void> {
    const collection = toDocsCollectionName(group);
    try {
      await this.qdrant.delete(collection, {
        filter: { must: [{ key: 'project', match: { value: project } }] },
        wait: true,
      });
    } catch {
      // Collection missing — nothing to do.
    }
  }

  /**
   * Hybrid search: dense (qwen3) + sparse (BM25) prefetch fused with RRF
   * server-side, then auto-merge neighbouring chunks of each hit's document for
   * context. Returns at most `limit` merged hits.
   */
  async search(group: string, query: string, opts: DocsSearchOpts = {}): Promise<DocsSearchHit[]> {
    const limit = opts.limit ?? 8;
    const collection = toDocsCollectionName(group);
    const dense = await this.provider.embed(query);
    const stats = this.idf.getCorpusStats(group);
    const sparse = buildQuerySparseVector(query, stats);

    const projectFilter =
      opts.project !== undefined
        ? { must: [{ key: 'project', match: { value: opts.project } }] }
        : undefined;

    // Overfetch on each prefetch so RRF has candidates and neighbour-merge has
    // material. Exclude the meta sentinel from results.
    const prefetchLimit = Math.max(limit * 4, 20);
    const prefetch: unknown[] = [
      {
        query: dense,
        using: DOCS_DENSE_VECTOR,
        limit: prefetchLimit,
        ...(projectFilter ? { filter: projectFilter } : {}),
      },
    ];
    if (sparse.indices.length > 0) {
      prefetch.push({
        query: sparse as SparseVector,
        using: DOCS_SPARSE_VECTOR,
        limit: prefetchLimit,
        ...(projectFilter ? { filter: projectFilter } : {}),
      });
    }

    let hits;
    try {
      const res = await this.qdrant.query(collection, {
        prefetch: prefetch as never,
        query: { fusion: 'rrf' } as never,
        limit: limit * 2, // fetch extra; neighbour-merge dedupes by doc
        with_payload: true,
        filter: { must_not: [{ key: '__meta', match: { value: true } }] } as never,
      });
      hits = res.points;
    } catch {
      return [];
    }

    const base: DocsSearchHit[] = [];
    for (const h of hits) {
      const payload = h.payload as Record<string, unknown> | null;
      if (!payload || payload['__meta'] === true) continue;
      base.push(toHit(payload, h.score));
    }

    return this.mergeNeighbours(group, base, limit, opts.mergeNeighbours ?? 1);
  }

  /**
   * Auto-merge: for each hit, pull neighbouring chunks (±n by chunk_index within
   * the same doc_id) and concatenate their content so the caller gets the
   * surrounding context, not an isolated fragment. Dedupes by doc_id, keeping the
   * best-scoring hit per document. See docs/chunking-strategy.md (parent/auto-
   * merge retrieval).
   */
  private async mergeNeighbours(
    group: string,
    hits: DocsSearchHit[],
    limit: number,
    n: number
  ): Promise<DocsSearchHit[]> {
    const collection = toDocsCollectionName(group);
    // Keep the best hit per document (dedupe by doc_id).
    const byDoc = new Map<string, DocsSearchHit>();
    for (const h of hits) {
      const prev = byDoc.get(h.docId);
      if (!prev || h.score > prev.score) byDoc.set(h.docId, h);
    }
    const top = Array.from(byDoc.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (n <= 0) return top;

    const merged: DocsSearchHit[] = [];
    for (const hit of top) {
      const lo = Math.max(0, hit.chunkIndex - n);
      const hi = hit.chunkIndex + n;
      try {
        const page = await this.qdrant.scroll(collection, {
          limit: 2 * n + 1,
          with_payload: true,
          with_vector: false,
          filter: {
            must: [
              { key: 'doc_id', match: { value: hit.docId } },
              { key: 'chunk_index', range: { gte: lo, lte: hi } },
            ],
          },
        });
        const neighbours = page.points
          .map((p) => p.payload as Record<string, unknown> | null)
          .filter((p): p is Record<string, unknown> => !!p && p['__meta'] !== true)
          .map((p) => toHit(p, 0))
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        if (neighbours.length > 0) {
          const content = neighbours.map((c) => stripBreadcrumb(c.content)).join('\n\n');
          const first = neighbours[0]!;
          const last = neighbours[neighbours.length - 1]!;
          merged.push({
            ...hit,
            content: `${breadcrumbOf(hit)}\n\n${content}`.trimStart(),
            startLine: first.startLine,
            endLine: last.endLine,
          });
          continue;
        }
      } catch {
        // fall through to the un-merged hit
      }
      merged.push(hit);
    }
    return merged;
  }

  // ── Model self-heal (mirror arch) ─────────────────────────────────────────

  /**
   * Re-embed every chunk in the group's docs collection with the current
   * provider. Needed after a text-model swap — the docs collection is
   * source-driven, but a full re-walk only happens on the indexer's schedule, so
   * this heals in place at startup. On a dimension change the collection is
   * dropped and recreated. Corpus IDF is rebuilt from the re-scanned chunks.
   *
   * Returns the number of chunks re-embedded (0 if empty/missing/current).
   */
  async reindexDocs(group: string): Promise<number> {
    const collection = toDocsCollectionName(group);
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

    // Rebuild IDF from scratch for this group (counts must match the re-scan).
    this.idf.clearGroup(group);
    for (const r of rows) {
      const content = typeof r.payload['content'] === 'string' ? r.payload['content'] : '';
      const terms = new Set(tokenize(content));
      this.idf.addDocument(group, terms, terms.size);
    }
    const stats = this.idf.getCorpusStats(group);

    let dimensionChanged: boolean;
    try {
      const info = await this.qdrant.getCollection(collection);
      const vectors = info.config?.params?.vectors as
        | Record<string, { size?: number }>
        | undefined;
      const size = vectors?.[DOCS_DENSE_VECTOR]?.size;
      dimensionChanged = typeof size === 'number' && size !== this.provider.dimensions;
    } catch {
      dimensionChanged = true;
    }
    if (dimensionChanged) {
      await dropDocsCollection(this.qdrant, group);
    }
    await ensureDocsCollection(this.qdrant, group, this.provider.dimensions, this.provider.model);

    const BATCH = 64;
    const points = [];
    for (const r of rows) {
      const content = typeof r.payload['content'] === 'string' ? r.payload['content'] : '';
      const dense = await this.provider.embed(content);
      const sparse = buildDocumentSparseVector(content, stats);
      points.push({
        id: r.id,
        vector: {
          [DOCS_DENSE_VECTOR]: dense,
          ...(sparse.indices.length > 0 ? { [DOCS_SPARSE_VECTOR]: sparse } : {}),
        },
        payload: r.payload,
      });
    }
    for (let i = 0; i < points.length; i += BATCH) {
      await this.qdrant.upsert(collection, { wait: true, points: points.slice(i, i + BATCH) });
    }
    await writeDocsCollectionMeta(this.qdrant, group, {
      model: this.provider.model,
      dimensions: this.provider.dimensions,
    });
    return points.length;
  }

  /** Heal one group if its stored model differs from the running provider. */
  async healDocsModel(group: string): Promise<number> {
    const meta = await readDocsCollectionMeta(this.qdrant, group);
    if (meta && meta.model === this.provider.model && meta.dimensions === this.provider.dimensions) {
      return 0;
    }
    return this.reindexDocs(group);
  }

  /** Heal every docs collection whose text model no longer matches. Best-effort. */
  async healAllDocsModels(): Promise<void> {
    let collections: string[];
    try {
      const res = await this.qdrant.getCollections();
      collections = res.collections.map((c) => c.name);
    } catch (err) {
      console.warn(
        `[docs] model-heal skipped — could not list collections: ${(err as Error).message}`
      );
      return;
    }
    for (const name of collections) {
      const group = fromDocsCollectionName(name);
      if (group === null) continue;
      try {
        const n = await this.healDocsModel(group);
        if (n > 0) {
          console.log(
            `[docs] re-embedded ${n} chunk(s) in group "${group}" with ${this.provider.model} (text model changed)`
          );
        }
      } catch (err) {
        console.warn(`[docs] model-heal failed for group "${group}": ${(err as Error).message}`);
      }
    }
  }
}

// ── Payload helpers ─────────────────────────────────────────────────────────

function buildPayload(
  docId: string,
  docTitle: string,
  input: IndexDocumentInput,
  chunk: DocsChunk
): Record<string, unknown> {
  return {
    doc_id: docId,
    doc_title: docTitle,
    project: input.project,
    file: input.file,
    source_url: input.sourceUrl ?? null,
    heading_path: chunk.headingPath,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };
}

function toHit(payload: Record<string, unknown>, score: number): DocsSearchHit {
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    docId: str(payload['doc_id']),
    docTitle: str(payload['doc_title']),
    headingPath: arr(payload['heading_path']),
    sourceUrl: typeof payload['source_url'] === 'string' ? payload['source_url'] : null,
    file: str(payload['file']),
    project: str(payload['project']),
    chunkIndex: num(payload['chunk_index']),
    content: str(payload['content']),
    startLine: num(payload['startLine']),
    endLine: num(payload['endLine']),
    score,
  };
}

/** The breadcrumb prefix `chunkMarkdown` prepends is the first line up to a blank line. */
function stripBreadcrumb(content: string): string {
  const nl = content.indexOf('\n\n');
  if (nl === -1) return content;
  const head = content.slice(0, nl);
  // Only strip if the head looks like a breadcrumb (contains ' > ' and no newline).
  if (head.includes(' > ') && !head.includes('\n')) return content.slice(nl + 2);
  return content;
}

function breadcrumbOf(hit: DocsSearchHit): string {
  return [hit.docTitle, ...hit.headingPath].filter((p) => p && p.length > 0).join(' > ');
}

function basename(file: string): string {
  const parts = file.split('/');
  const last = parts[parts.length - 1] ?? file;
  return last.replace(/\.(md|markdown)$/i, '');
}

export { NotMarkdownError };
