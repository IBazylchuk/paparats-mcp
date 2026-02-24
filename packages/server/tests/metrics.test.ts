import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NoOpMetrics, createMetrics } from '../src/metrics.js';
import type { MetricsRegistry } from '../src/metrics.js';

describe('NoOpMetrics', () => {
  it('all methods are callable without errors', () => {
    const noop = new NoOpMetrics();
    expect(noop.enabled).toBe(false);

    // All methods should be callable without throwing
    noop.incSearchTotal('group', 'search');
    noop.observeSearchDuration('group', 'search', 0.5);
    noop.incIndexFilesTotal('group', 5);
    noop.incIndexChunksTotal('group', 10);
    noop.incIndexErrorsTotal('group', 1);
    noop.observeEmbeddingDuration(0.1);
    noop.incWatcherEventsTotal('group', 'changed');
    noop.setEmbeddingCacheSize(100);
    noop.setEmbeddingCacheHitRate(0.5);
    noop.setQueryCacheSize(50);
    noop.setQueryCacheHitRate(0.8);
    noop.setQdrantCollections(3);
  });

  it('handler returns 404', async () => {
    const noop = new NoOpMetrics();
    const handler = noop.getMetricsHandler();

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    handler({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('not enabled') })
    );
  });
});

describe('createMetrics', () => {
  beforeEach(() => {
    vi.stubEnv('PAPARATS_METRICS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns NoOpMetrics when PAPARATS_METRICS is not set', async () => {
    const metrics = await createMetrics();
    expect(metrics.enabled).toBe(false);
  });

  it('returns PrometheusMetrics when PAPARATS_METRICS=true', async () => {
    vi.stubEnv('PAPARATS_METRICS', 'true');
    const metrics = await createMetrics();
    expect(metrics.enabled).toBe(true);
  });
});

describe('PrometheusMetrics', () => {
  let metrics: MetricsRegistry;

  beforeEach(async () => {
    vi.stubEnv('PAPARATS_METRICS', 'true');
    metrics = await createMetrics();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('counters and histograms work without throwing', () => {
    metrics.incSearchTotal('test-group', 'search');
    metrics.observeSearchDuration('test-group', 'search', 0.123);
    metrics.incIndexFilesTotal('test-group', 5);
    metrics.incIndexChunksTotal('test-group', 20);
    metrics.incIndexErrorsTotal('test-group');
    metrics.observeEmbeddingDuration(0.05);
    metrics.incWatcherEventsTotal('test-group', 'changed');
  });

  it('gauges work without throwing', () => {
    metrics.setEmbeddingCacheSize(1000);
    metrics.setEmbeddingCacheHitRate(0.85);
    metrics.setQueryCacheSize(50);
    metrics.setQueryCacheHitRate(0.6);
    metrics.setQdrantCollections(3);
  });

  it('handler returns Prometheus text format', async () => {
    metrics.incSearchTotal('test-group', 'search');

    const handler = metrics.getMetricsHandler();

    let responseBody = '';
    let contentType = '';
    const res = {
      set: vi.fn((key: string, value: string) => {
        if (key === 'Content-Type') contentType = value;
      }),
      end: vi.fn((body: string) => {
        responseBody = body;
      }),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await handler({} as never, res as never, vi.fn());

    expect(contentType).toContain('text/plain');
    expect(responseBody).toContain('paparats_search_total');
    expect(responseBody).toContain('test-group');
  });
});
