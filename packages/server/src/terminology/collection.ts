import type { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Terminology collection lifecycle — mirrors arch/collection.ts. Single dense
 * vector (qwen3 1024d); no sparse — the glossary is small and looked up by
 * semantic similarity plus exact term/alias match, not BM25 ranking.
 */

const TERMS_SUFFIX = '_terms';
const CODE_PREFIX = 'paparats_';

export function toTermsCollectionName(group: string): string {
  return `${CODE_PREFIX}${group}${TERMS_SUFFIX}`;
}

export function fromTermsCollectionName(collection: string): string | null {
  if (!collection.startsWith(CODE_PREFIX) || !collection.endsWith(TERMS_SUFFIX)) {
    return null;
  }
  return collection.slice(CODE_PREFIX.length, -TERMS_SUFFIX.length);
}

export function isTermsCollection(collection: string): boolean {
  return fromTermsCollectionName(collection) !== null;
}

export interface TermsCollectionMeta {
  model: string;
  dimensions: number;
}

/** Deterministic sentinel id — distinct from code/arch/docs sentinels. */
const TERMS_META_SENTINEL_ID = '00000000-0000-7000-8000-0000000d7e12';
export const TERMS_META_ID = TERMS_META_SENTINEL_ID;

export async function readTermsCollectionMeta(
  qdrant: QdrantClient,
  group: string
): Promise<TermsCollectionMeta | null> {
  try {
    const result = await qdrant.retrieve(toTermsCollectionName(group), {
      ids: [TERMS_META_SENTINEL_ID],
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

export async function writeTermsCollectionMeta(
  qdrant: QdrantClient,
  group: string,
  meta: TermsCollectionMeta
): Promise<void> {
  await qdrant.upsert(toTermsCollectionName(group), {
    wait: true,
    points: [
      {
        id: TERMS_META_SENTINEL_ID,
        vector: new Array(meta.dimensions).fill(0),
        payload: { __meta: true, model: meta.model, dimensions: meta.dimensions },
      },
    ],
  });
}

const PAYLOAD_INDEXES = ['term', 'project'] as const;

export async function ensureTermsCollection(
  qdrant: QdrantClient,
  group: string,
  dimensions: number,
  model?: string
): Promise<void> {
  const name = toTermsCollectionName(group);
  try {
    await qdrant.getCollection(name);
    return;
  } catch {
    // missing — create below
  }
  await qdrant.createCollection(name, {
    vectors: { size: dimensions, distance: 'Cosine' },
  });
  for (const field of PAYLOAD_INDEXES) {
    await qdrant.createPayloadIndex(name, {
      field_name: field,
      field_schema: 'keyword',
      wait: true,
    });
  }
  if (model) {
    await writeTermsCollectionMeta(qdrant, group, { model, dimensions });
  }
}

export async function dropTermsCollection(qdrant: QdrantClient, group: string): Promise<void> {
  await qdrant.deleteCollection(toTermsCollectionName(group));
}
