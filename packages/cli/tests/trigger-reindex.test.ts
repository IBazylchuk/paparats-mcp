import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultTriggerReindex } from '../src/commands/projects.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('defaultTriggerReindex', () => {
  it('retries on 404 (indexer hot-reload race) and succeeds once entry is picked up', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls < 3) return new Response('no', { status: 404 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await defaultTriggerReindex('my-repo');
    expect(calls).toBe(3);
  });

  it('does not retry on non-404 failures', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(defaultTriggerReindex('my-repo')).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the full backoff window on persistent 404', async () => {
    const fetchMock = vi.fn(async () => new Response('no', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(defaultTriggerReindex('my-repo')).rejects.toThrow(/404/);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  }, 10_000);
});
