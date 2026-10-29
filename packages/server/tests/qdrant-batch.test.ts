import { describe, it, expect, vi } from 'vitest';
import { upsertWithRetry } from '../src/qdrant-batch.js';

const point = (id: number) => ({ id, vector: [0], payload: {} });

describe('upsertWithRetry', () => {
  it('writes in batches of 128 and tries a failed batch again', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(undefined);
    const points = Array.from({ length: 200 }, (_, i) => point(i));
    await upsertWithRetry({ upsert } as never, 'c', points, [0, 0]);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert.mock.calls[0]?.[1]?.points).toHaveLength(128);
    expect(upsert.mock.calls[2]?.[1]?.points).toHaveLength(72);
  });

  it('gives up after the last retry', async () => {
    const upsert = vi.fn().mockRejectedValue(new Error('down'));
    await expect(upsertWithRetry({ upsert } as never, 'c', [point(1)], [0, 0])).rejects.toThrow(
      'down'
    );
    expect(upsert).toHaveBeenCalledTimes(3);
  });
});
