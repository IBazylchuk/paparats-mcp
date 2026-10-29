import type { QdrantClient } from '@qdrant/js-client-rest';

/**
 * Upsert points in batches of 128, each tried up to three times. Used where the
 * points exist nowhere else (a reindex after the collection was dropped).
 */
export async function upsertWithRetry(
  qdrant: Pick<QdrantClient, 'upsert'>,
  collection: string,
  points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }>,
  delaysMs: number[] = [500, 2000]
): Promise<void> {
  const BATCH = 128;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    for (let attempt = 0; ; attempt++) {
      try {
        await qdrant.upsert(collection, { wait: true, points: batch });
        break;
      } catch (err) {
        const delay = delaysMs[attempt];
        if (delay === undefined) throw err;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
