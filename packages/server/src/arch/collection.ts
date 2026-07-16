import type { QdrantClient } from '@qdrant/js-client-rest';

const ARCH_SUFFIX = '_arch';
const CODE_PREFIX = 'paparats_';

export function toArchCollectionName(group: string): string {
  return `${CODE_PREFIX}${group}${ARCH_SUFFIX}`;
}

export function fromArchCollectionName(collection: string): string | null {
  if (!collection.startsWith(CODE_PREFIX) || !collection.endsWith(ARCH_SUFFIX)) {
    return null;
  }
  return collection.slice(CODE_PREFIX.length, -ARCH_SUFFIX.length);
}

export function isArchCollection(collection: string): boolean {
  return fromArchCollectionName(collection) !== null;
}

/** Embedding metadata stamped on an arch collection — mirrors the code layer's
 *  sentinel so a text-model swap can be detected and healed. `model` is what
 *  matters (arch always uses the text provider); dimensions guards the rebuild. */
export interface ArchCollectionMeta {
  model: string;
  dimensions: number;
}

/** Deterministic UUID for the arch metadata sentinel point (distinct from the
 *  code layer's sentinel so the two never collide even if names overlapped). */
const ARCH_META_SENTINEL_ID = '00000000-0000-7000-8000-0000000a5c11';

/** Read the arch collection's embedding metadata. Returns null when the
 *  collection or sentinel is missing (e.g. first run, or pre-sentinel data). */
export async function readArchCollectionMeta(
  qdrant: QdrantClient,
  group: string
): Promise<ArchCollectionMeta | null> {
  try {
    const result = await qdrant.retrieve(toArchCollectionName(group), {
      ids: [ARCH_META_SENTINEL_ID],
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

/** Stamp the arch collection with the current text model + dimensions. The
 *  sentinel is a zero-vector point at a fixed id, excluded from every real
 *  search by the `__meta` payload flag (same pattern as the code layer). */
export async function writeArchCollectionMeta(
  qdrant: QdrantClient,
  group: string,
  meta: ArchCollectionMeta
): Promise<void> {
  await qdrant.upsert(toArchCollectionName(group), {
    wait: true,
    points: [
      {
        id: ARCH_META_SENTINEL_ID,
        vector: new Array(meta.dimensions).fill(0),
        payload: { __meta: true, model: meta.model, dimensions: meta.dimensions },
      },
    ],
  });
}

/** The sentinel id — exported so search/scroll paths can exclude it. */
export const ARCH_META_ID = ARCH_META_SENTINEL_ID;

const PAYLOAD_INDEXES = ['arch_kind', 'name', 'status', 'scope', 'supersedes'] as const;

export async function ensureArchCollection(
  qdrant: QdrantClient,
  group: string,
  dimensions: number,
  model?: string
): Promise<void> {
  const name = toArchCollectionName(group);
  try {
    await qdrant.getCollection(name);
    return;
  } catch {
    // collection missing — create below
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
  // Stamp the embedding metadata on creation so a later model swap is detectable
  // (see healArchModel). Only when the model is known — callers that don't pass
  // it (e.g. tests) leave the collection unstamped, which is a benign no-op.
  if (model) {
    await writeArchCollectionMeta(qdrant, group, { model, dimensions });
  }
}

export async function dropArchCollection(qdrant: QdrantClient, group: string): Promise<void> {
  await qdrant.deleteCollection(toArchCollectionName(group));
}
