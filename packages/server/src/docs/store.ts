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
import type { DocsChunk, DocsKind, DocsSearchHit } from './types.js';

export interface DocsStoreConfig {
  qdrant: QdrantClient;
  provider: CachedEmbeddingProvider;
  idf: DocsIdfStore;
}

/**
 * Default visibility for a chunk that carries no explicit `audience`. Deliberately
 * the most restrictive label: un-labelled docs (and every chunk indexed before
 * this field existed) read back as `internal`, so a narrower-audience search
 * never surfaces them by accident. Fail-closed by construction.
 */
export const DEFAULT_AUDIENCE = 'internal';

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
  /**
   * Visibility label for the document (e.g. `internal`, `client`, `public`).
   * Free-form; the core does not prescribe values. Omitted → {@link DEFAULT_AUDIENCE}.
   */
  audience?: string;
  /**
   * Which kind of prose this is. Omitted → {@link DEFAULT_DOCS_KIND}, so callers
   * that don't classify keep the permissive floor they had before.
   */
  kind?: DocsKind;
  /**
   * Unix epoch milliseconds of the document's last content change (e.g. the
   * authoring commit date). Omitted → stored as `null`, which reads back as
   * "age unknown" and suppresses any staleness notice rather than guessing.
   */
  lastModifiedAt?: number | null;
}

export interface DocsSearchOpts {
  project?: string;
  limit?: number;
  /** Number of neighbouring chunks to merge around each hit for context. Default 1. */
  mergeNeighbours?: number;
  /**
   * Restrict results to these visibility labels (match-any). Omit to search every
   * audience. A chunk with no stored audience is treated as {@link DEFAULT_AUDIENCE},
   * so passing e.g. `['client']` will NOT surface un-labelled (internal) docs.
   */
  audience?: string | string[];
  /**
   * Drop hits whose dense cosine to the query is below this, as a relevance
   * floor. Defaults to {@link DEFAULT_DOCS_MIN_COSINE}; pass 0 to disable.
   *
   * This is a floor on the COSINE, deliberately not on the returned RRF score.
   * RRF is `1/(k+rank)`, a function of position alone, so the top hit scores high
   * even when nothing relevant matched — measured on a 41-query set, topics
   * absent from the corpus still produced RRF 0.500/0.700/1.000, indistinguishable
   * from real answers. Cosine separates them cleanly (absent ≤0.410 vs real
   * ≥0.474), which is why the gate reads the cosine and the ranking keeps RRF.
   *
   * Applies to `prose` documents. `code` documents use {@link minCosineCode},
   * which defaults higher — see {@link DEFAULT_DOCS_CODE_MIN_COSINE}.
   */
  minCosine?: number;
  /**
   * Relevance floor applied to `code`-kind documents instead of {@link minCosine}.
   * Defaults to {@link DEFAULT_DOCS_CODE_MIN_COSINE}; pass 0 to disable for this
   * kind only.
   */
  minCosineCode?: number;
}

/**
 * Relevance floor for docs search, as a dense cosine.
 *
 * Chosen from a 41-query measurement (37 answerable, 4 deliberately absent):
 * absent-topic top hits scored 0.332–0.410, real answers 0.474 upward, so 0.45
 * sits in the empty band between them — it kept 36/37 real answers and dropped
 * 4/4 absent ones. Deliberately at the permissive end of that band: a missing
 * answer costs the caller a search, while a confidently-wrong one can be quoted
 * as fact.
 */
export const DEFAULT_DOCS_MIN_COSINE = 0.45;

/**
 * Relevance floor for `code`-kind documents — markdown that lives beside source.
 *
 * Higher than {@link DEFAULT_DOCS_MIN_COSINE} because the two corpora are
 * calibrated differently. Measured over 102 answerable queries and 30 verified
 * absent-topic ones against a mixed index (57% long-form prose, 43% code prose):
 *
 * - A single global floor forces a bad trade. 0.45 blocked 16/30 absent topics;
 *   pushing it to 0.60 blocked 30/30 but dropped precision@1 from 87.3% to 76.5%.
 * - Per-kind floors make the trade disappear: prose at 0.45 with code at 0.60
 *   blocked 29/30 absent topics and lost *zero* real answers, leaving
 *   precision@1 unchanged.
 *
 * That works because code prose is almost never the right first answer but often
 * a confident wrong one: across 102 answerable queries it produced the top hit
 * twice, and was wrong both times. So raising its floor costs nothing.
 *
 * The one absent topic that still gets through scores 0.547 in long-form prose;
 * blocking it would mean raising the prose floor to 0.55, which does cost real
 * answers. Left through deliberately.
 */
export const DEFAULT_DOCS_CODE_MIN_COSINE = 0.6;

/**
 * Kind assumed for a document indexed without an explicit one, and for chunks
 * written before the field existed. `prose` keeps the permissive floor, so an
 * un-classified corpus behaves exactly as it did before per-kind floors existed.
 */
export const DEFAULT_DOCS_KIND: DocsKind = 'prose';

/**
 * Age past which a document is reported as possibly out of date.
 *
 * A year is long enough that ordinary docs are not perpetually flagged (which
 * would train the reader to ignore the notice) and short enough to catch prose
 * describing a design that has since moved on. It is a disclosure threshold, not
 * a ranking input: an old document is frequently the only one on its topic, so
 * demoting it would lose answers that flagging merely qualifies.
 */
export const DEFAULT_DOCS_STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

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

    await ensureDocsCollection(this.qdrant, group, this.provider.dimensions, this.provider.model);

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
      // Update corpus stats: df bumps use the DISTINCT term set, but the corpus
      // length total must be the RAW token count (matches docLength in the BM25
      // builder — avgDocLength is meaningless if the units differ).
      const tokens = tokenize(chunk.content);
      const terms = new Set(tokens);
      this.idf.addDocument(group, terms, tokens.length);
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
            const tokens = tokenize(content);
            this.idf.removeDocument(group, new Set(tokens), tokens.length);
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
    // embedQuery, NOT embed: qwen3 is a decoder with last-token pooling, so the
    // card's retrieval instruction is part of its trained query interface, not
    // decoration. Embedding the bare query put it in a different region of the
    // space than the instruction-conditioned one the floors were calibrated on.
    // Measured on one deployment over 102 answerable + 30 absent-topic queries:
    // bare 74.5% precision@1 with 28/30 absent topics leaking past the floor,
    // instructed 87.3% with 5/30. Documents stay unprefixed — see prefixPassage.
    const dense = await this.provider.embedQuery(query);
    const stats = this.idf.getCorpusStats(group);
    const sparse = buildQuerySparseVector(query, stats);

    // Build the prefetch filter from project + audience clauses. Both are `must`
    // (AND). The audience clause is match-any over the requested labels; a chunk
    // with no stored `audience` field does NOT match it — so `audience: ['client']`
    // never surfaces un-labelled (internal) docs. Fail-closed by construction.
    const must: Array<Record<string, unknown>> = [];
    if (opts.project !== undefined) {
      must.push({ key: 'project', match: { value: opts.project } });
    }
    const audiences = normalizeAudience(opts.audience);
    if (audiences) {
      must.push({ key: 'audience', match: { any: audiences } });
    }
    const searchFilter = must.length > 0 ? { must } : undefined;

    // Overfetch on each prefetch so RRF has candidates and neighbour-merge has
    // material. Exclude the meta sentinel from results.
    const prefetchLimit = Math.max(limit * 4, 20);
    const prefetch: unknown[] = [
      {
        query: dense,
        using: DOCS_DENSE_VECTOR,
        limit: prefetchLimit,
        ...(searchFilter ? { filter: searchFilter } : {}),
      },
    ];
    if (sparse.indices.length > 0) {
      prefetch.push({
        query: sparse as SparseVector,
        using: DOCS_SPARSE_VECTOR,
        limit: prefetchLimit,
        ...(searchFilter ? { filter: searchFilter } : {}),
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
    const ids: Array<string | number> = [];
    for (const h of hits) {
      const payload = h.payload as Record<string, unknown> | null;
      if (!payload || payload['__meta'] === true) continue;
      base.push(toHit(payload, h.score));
      ids.push(h.id);
    }

    const minCosine = opts.minCosine ?? DEFAULT_DOCS_MIN_COSINE;
    const minCosineCode = opts.minCosineCode ?? DEFAULT_DOCS_CODE_MIN_COSINE;
    const floorFor = (hit: DocsSearchHit): number =>
      hit.kind === 'code' ? minCosineCode : minCosine;
    // Skip the rescore round-trip only when BOTH floors are off.
    const gated =
      minCosine > 0 || minCosineCode > 0
        ? await this.gateByCosine(collection, dense, base, ids, floorFor)
        : base;

    return this.mergeNeighbours(group, gated, limit, opts.mergeNeighbours ?? 1);
  }

  /**
   * Drop hits whose dense cosine to the query is below `minCosine`, preserving the
   * RRF order of the survivors.
   *
   * The cosine needs a second request: the fused response carries the RRF score,
   * not the per-vector similarity. It is one extra query over an explicit id set
   * (already-fetched points, no re-search), so the cost is a round-trip rather
   * than another ANN traversal.
   *
   * Fails OPEN — if the rescore errors, the un-gated hits are returned. A gate
   * that silently empties the result set on a transient error would look exactly
   * like "the docs don't cover this", which is the very confusion it exists to
   * prevent.
   */
  private async gateByCosine(
    collection: string,
    dense: number[],
    hits: DocsSearchHit[],
    ids: Array<string | number>,
    floorFor: (hit: DocsSearchHit) => number
  ): Promise<DocsSearchHit[]> {
    if (hits.length === 0) return hits;
    let cosineById: Map<string | number, number>;
    try {
      const res = await this.qdrant.query(collection, {
        query: dense,
        using: DOCS_DENSE_VECTOR,
        limit: ids.length,
        with_payload: false,
        filter: { must: [{ has_id: ids }] } as never,
      });
      cosineById = new Map(res.points.map((p) => [p.id, p.score]));
    } catch {
      return hits; // fail open — see above
    }
    const kept = hits.filter((hit, i) => {
      const id = ids[i];
      if (id === undefined) return true;
      const cos = cosineById.get(id);
      // A hit missing from the rescore is kept rather than silently dropped.
      if (cos === undefined) return true;
      const floor = floorFor(hit);
      return floor <= 0 || cos >= floor;
    });
    return kept;
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

    // Total chunk count per document, so the caller can see that a hit is an
    // EXCERPT and how much of the document is missing. Best-effort: a failure
    // leaves the count at 0 rather than failing the search.
    const counts = await this.docChunkCounts(
      collection,
      top.map((h) => h.docId)
    );
    const withCounts = top.map((h) => ({
      ...h,
      docChunkCount: counts.get(h.docId) ?? 0,
      includedChunks: [h.chunkIndex],
    }));

    if (n <= 0) return withCounts;

    const merged: DocsSearchHit[] = [];
    for (const hit of withCounts) {
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
            includedChunks: neighbours.map((c) => c.chunkIndex),
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

  /**
   * Total chunk count for each document id. Best-effort — any failure yields no
   * entry for that document, which the caller reads back as 0 ("unknown"), never
   * as "the document is empty".
   */
  private async docChunkCounts(collection: string, docIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    await Promise.all(
      Array.from(new Set(docIds)).map(async (docId) => {
        try {
          const res = await this.qdrant.count(collection, {
            filter: {
              must: [{ key: 'doc_id', match: { value: docId } }],
              must_not: [{ key: '__meta', match: { value: true } }],
            },
            exact: true,
          });
          out.set(docId, res.count);
        } catch {
          // leave unset — reads back as unknown
        }
      })
    );
    return out;
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
      const tokens = tokenize(content);
      this.idf.addDocument(group, new Set(tokens), tokens.length);
    }
    const stats = this.idf.getCorpusStats(group);

    let dimensionChanged: boolean;
    try {
      const info = await this.qdrant.getCollection(collection);
      const vectors = info.config?.params?.vectors as Record<string, { size?: number }> | undefined;
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
    if (
      meta &&
      meta.model === this.provider.model &&
      meta.dimensions === this.provider.dimensions
    ) {
      return 0;
    }
    return this.reindexDocs(group);
  }

  /**
   * Rebuild this group's BM25 corpus statistics from the chunks already in Qdrant,
   * but only when they are missing.
   *
   * The stats live in a local SQLite file written by whoever indexes. A process
   * that only SEARCHES (the MCP server, in the usual split-container deployment)
   * therefore starts with an empty store and never fills it — nothing on the read
   * path writes df. With no stats, `buildQuerySparseVector` cannot weight terms
   * and returns an empty vector, so search silently degrades to dense-only:
   * correct, but it throws away the keyword half of a hybrid index.
   *
   * Rebuilding is a pure function of the stored chunks, so it is safe to run on
   * any process and idempotent. Skipped when stats already exist, so a normal
   * indexer restart costs nothing.
   *
   * @returns the number of chunks folded into the stats (0 when already present).
   */
  async rebuildIdfIfEmpty(group: string): Promise<number> {
    if (this.idf.getCorpusStats(group).docCount > 0) return 0;
    const collection = toDocsCollectionName(group);
    let offset: string | number | Record<string, unknown> | undefined | null = undefined;
    let folded = 0;
    try {
      for (;;) {
        const page = await this.qdrant.scroll(collection, {
          limit: 256,
          with_payload: { include: ['content'] },
          with_vector: false,
          filter: { must_not: [{ key: '__meta', match: { value: true } }] },
          ...(offset !== undefined && offset !== null ? { offset } : {}),
        });
        for (const point of page.points) {
          const content = (point.payload as { content?: unknown } | undefined)?.content;
          if (typeof content !== 'string') continue;
          const tokens = tokenize(content);
          // Same split as the indexer: df counts DISTINCT terms, the corpus total
          // counts RAW tokens — mixing them corrupts avgDocLength.
          this.idf.addDocument(group, new Set(tokens), tokens.length);
          folded++;
        }
        if (!page.next_page_offset) break;
        offset = page.next_page_offset;
      }
    } catch (err) {
      console.warn(`[docs] IDF rebuild failed for group "${group}": ${(err as Error).message}`);
      return folded;
    }
    return folded;
  }

  /**
   * Rebuild missing BM25 stats for every docs collection. Best-effort: a failure
   * on one group leaves search dense-only there rather than failing startup.
   */
  async rebuildAllIdf(): Promise<void> {
    let collections: string[];
    try {
      const res = await this.qdrant.getCollections();
      collections = res.collections.map((c) => c.name);
    } catch (err) {
      console.warn(
        `[docs] IDF rebuild skipped — could not list collections: ${(err as Error).message}`
      );
      return;
    }
    for (const name of collections) {
      const group = fromDocsCollectionName(name);
      if (group === null) continue;
      try {
        const n = await this.rebuildIdfIfEmpty(group);
        if (n > 0) {
          console.log(`[docs] rebuilt BM25 stats for group "${group}" from ${n} chunk(s)`);
        }
      } catch (err) {
        console.warn(`[docs] IDF rebuild failed for group "${group}": ${(err as Error).message}`);
      }
    }
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

  /**
   * Chunk and document counts for one group's docs collection.
   *
   * `chunks` is `points_count` minus the meta sentinel. `documents` comes from a
   * `facet` on the indexed `doc_id` key rather than a full scroll: a docs
   * collection holds one point per chunk, so scrolling it to count distinct
   * documents would read the entire corpus on every dashboard poll.
   *
   * `facet` returns at most `limit` distinct values, so `documents` saturates
   * there; `documentsExact` reports whether the count is complete. Returns all
   * zeros when the collection does not exist yet — an unindexed group is not an
   * error for a stats read.
   */
  async stats(group: string): Promise<DocsStats> {
    const name = toDocsCollectionName(group);
    const out: DocsStats = { group, chunks: 0, documents: 0, documentsExact: true };
    try {
      const info = await this.qdrant.getCollection(name);
      const raw = info.points_count ?? 0;
      out.chunks = Math.max(0, raw - 1); // less the meta sentinel
    } catch {
      return out; // collection missing — group has no docs
    }
    try {
      const limit = 10_000;
      const res = await this.qdrant.facet(name, { key: 'doc_id', limit, exact: true });
      out.documents = res.hits.length;
      out.documentsExact = res.hits.length < limit;
    } catch {
      // Counting documents is supplementary — keep the chunk count.
      out.documentsExact = false;
    }
    return out;
  }
}

/** Per-group totals for the docs layer, surfaced by the analytics dashboard. */
export interface DocsStats {
  group: string;
  chunks: number;
  documents: number;
  /** False when `documents` hit the facet limit, or the facet call failed. */
  documentsExact: boolean;
}

// ── Audience helpers ─────────────────────────────────────────────────────────

/**
 * Normalize an audience filter into a clean, deduped label list, or `null` when
 * there is no effective restriction. `null` means "search every audience";
 * a non-empty array means "match any of these labels". Empty strings are dropped
 * (an all-empty input collapses to `null` rather than an impossible filter).
 */
export function normalizeAudience(audience?: string | string[]): string[] | null {
  if (audience === undefined) return null;
  const list = (Array.isArray(audience) ? audience : [audience])
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (list.length === 0) return null;
  return Array.from(new Set(list));
}

/**
 * Combine a caller-supplied audience with a server-enforced scope, fail-closed.
 * The scope is a hard ceiling: the result is the INTERSECTION, so a request can
 * only ever narrow within the scope, never widen past it.
 *
 * - no scope → the request stands as-is (may be `null` = unrestricted).
 * - scope but no request → the scope applies.
 * - both → intersection; if disjoint, returns `[]` (match nothing) rather than
 *   silently falling back to the wider set.
 */
export function applyAudienceScope(
  requested: string[] | null,
  scope: string[] | null
): string[] | null {
  if (!scope) return requested;
  if (!requested) return scope;
  const allow = new Set(scope);
  return requested.filter((a) => allow.has(a));
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
    audience: input.audience ?? DEFAULT_AUDIENCE,
    kind: input.kind ?? DEFAULT_DOCS_KIND,
    last_modified_at: input.lastModifiedAt ?? null,
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
    audience: str(payload['audience'], DEFAULT_AUDIENCE),
    chunkIndex: num(payload['chunk_index']),
    content: str(payload['content']),
    startLine: num(payload['startLine']),
    endLine: num(payload['endLine']),
    score,
    // Filled in by mergeNeighbours, which is the only place that knows the
    // document's full extent and which chunks ended up in `content`.
    docChunkCount: 0,
    includedChunks: [num(payload['chunk_index'])],
    kind: payload['kind'] === 'code' ? 'code' : DEFAULT_DOCS_KIND,
    lastModifiedAt:
      typeof payload['last_modified_at'] === 'number' ? payload['last_modified_at'] : null,
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
