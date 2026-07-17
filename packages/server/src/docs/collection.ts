import type { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Docs collection lifecycle — mirrors arch/collection.ts but for the docs layer.
 *
 * Two key differences from arch:
 *  - collection name suffix is `_docs` (not `_arch`)
 *  - the collection carries BOTH a named dense vector (`dense`, qwen3 1024d) AND
 *    a named sparse vector (`text`, BM25) so dense + sparse can be fused
 *    server-side via the Query API (`prefetch` + `fusion: rrf`).
 *
 * The named-vector layout is REQUIRED for hybrid search — a collection created
 * with a single unnamed dense vector cannot hold sparse vectors.
 */

const DOCS_SUFFIX = '_docs';
const CODE_PREFIX = 'paparats_';

/** Named dense vector key. Also used as the `using` field in a dense query. */
export const DOCS_DENSE_VECTOR = 'dense';
/** Named sparse vector key (BM25). Also used as the `using` field in a sparse query. */
export const DOCS_SPARSE_VECTOR = 'text';

export function toDocsCollectionName(group: string): string {
  return `${CODE_PREFIX}${group}${DOCS_SUFFIX}`;
}

export function fromDocsCollectionName(collection: string): string | null {
  if (!collection.startsWith(CODE_PREFIX) || !collection.endsWith(DOCS_SUFFIX)) {
    return null;
  }
  return collection.slice(CODE_PREFIX.length, -DOCS_SUFFIX.length);
}

export function isDocsCollection(collection: string): boolean {
  return fromDocsCollectionName(collection) !== null;
}

/** Embedding metadata stamped on a docs collection — same sentinel pattern as arch. */
export interface DocsCollectionMeta {
  model: string;
  dimensions: number;
}

/** Deterministic sentinel id for the docs metadata point — distinct from arch/code. */
const DOCS_META_SENTINEL_ID = '00000000-0000-7000-8000-0000000d0c50';

/** The sentinel id — exported so search/scroll paths can exclude it. */
export const DOCS_META_ID = DOCS_META_SENTINEL_ID;

export async function readDocsCollectionMeta(
  qdrant: QdrantClient,
  group: string
): Promise<DocsCollectionMeta | null> {
  try {
    const result = await qdrant.retrieve(toDocsCollectionName(group), {
      ids: [DOCS_META_SENTINEL_ID],
      with_payload: true,
      with_vector: false,
    });
    const p = result[0]?.payload as Record<string, unknown> | undefined;
    if (!p || p['__meta'] !== true) return null;
    const model = typeof p['model'] === 'string' ? p['model'] : null;
    const dimensions = typeof p['dimensions'] === 'number' ? p['dimensions'] : null;
    if (!model || dimensions === null) return null;
    return { model, dimensions };
  } catch {
    return null;
  }
}

/**
 * Stamp the docs collection with the current text model + dimensions. The
 * sentinel is a zero-vector point (dense only) at a fixed id, excluded from
 * every real search by the `__meta` payload flag. It carries no sparse vector —
 * a payload-only sentinel needs no BM25 weights.
 */
export async function writeDocsCollectionMeta(
  qdrant: QdrantClient,
  group: string,
  meta: DocsCollectionMeta
): Promise<void> {
  await qdrant.upsert(toDocsCollectionName(group), {
    wait: true,
    points: [
      {
        id: DOCS_META_SENTINEL_ID,
        vector: { [DOCS_DENSE_VECTOR]: new Array(meta.dimensions).fill(0) },
        payload: { __meta: true, model: meta.model, dimensions: meta.dimensions },
      },
    ],
  });
}

const PAYLOAD_INDEXES = ['project', 'file', 'doc_id'] as const;

export async function ensureDocsCollection(
  qdrant: QdrantClient,
  group: string,
  dimensions: number,
  model?: string
): Promise<void> {
  const name = toDocsCollectionName(group);
  try {
    await qdrant.getCollection(name);
    return;
  } catch {
    // collection missing — create below
  }
  await qdrant.createCollection(name, {
    vectors: { [DOCS_DENSE_VECTOR]: { size: dimensions, distance: 'Cosine' } },
    sparse_vectors: { [DOCS_SPARSE_VECTOR]: {} },
  });
  for (const field of PAYLOAD_INDEXES) {
    await qdrant.createPayloadIndex(name, {
      field_name: field,
      field_schema: 'keyword',
      wait: true,
    });
  }
  if (model) {
    await writeDocsCollectionMeta(qdrant, group, { model, dimensions });
  }
}

export async function dropDocsCollection(qdrant: QdrantClient, group: string): Promise<void> {
  await qdrant.deleteCollection(toDocsCollectionName(group));
}
