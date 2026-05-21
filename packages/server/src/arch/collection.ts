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

const PAYLOAD_INDEXES = ['arch_kind', 'name', 'status', 'scope', 'supersedes'] as const;

export async function ensureArchCollection(
  qdrant: QdrantClient,
  group: string,
  dimensions: number
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
}

export async function dropArchCollection(qdrant: QdrantClient, group: string): Promise<void> {
  await qdrant.deleteCollection(toArchCollectionName(group));
}
