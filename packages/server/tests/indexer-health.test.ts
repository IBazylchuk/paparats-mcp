import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { fetchIndexerHealth, indexerUrlFromEnv } from '../src/indexer-health.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  delete process.env['PAPARATS_API_KEY'];
});

function serve(handler: express.RequestHandler): string {
  const app = express();
  app.get('/health', handler);
  server = app.listen(0);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('fetchIndexerHealth', () => {
  it('reads the status, last run and repos, sending the API key when one is set', async () => {
    process.env['PAPARATS_API_KEY'] = 'k'.repeat(16);
    let auth: string | undefined;
    const url = serve((req, res) => {
      auth = req.headers.authorization;
      res.json({
        status: 'idle',
        lastRunAt: 't',
        repoCount: 1,
        repos: [{ repo: 'a', status: 'success' }],
      });
    });
    expect(await fetchIndexerHealth(url)).toEqual({
      reachable: true,
      url,
      globalStatus: 'idle',
      lastRunAt: 't',
      repos: [{ repo: 'a', status: 'success' }],
    });
    expect(auth).toBe(`Bearer ${'k'.repeat(16)}`);
  });

  it('reports an indexer that is down instead of throwing', async () => {
    const url = serve((_req, res) => {
      res.status(503).end();
    });
    expect(await fetchIndexerHealth(url)).toMatchObject({ reachable: false, error: 'HTTP 503' });
    const closed = await fetchIndexerHealth('http://127.0.0.1:1', 1000);
    expect(closed.reachable).toBe(false);
  });

  it('finds the indexer through PAPARATS_INDEXER_URL, else on its default port', () => {
    expect(indexerUrlFromEnv({ PAPARATS_INDEXER_URL: 'http://paparats-indexer:9877' })).toBe(
      'http://paparats-indexer:9877'
    );
    expect(indexerUrlFromEnv({})).toBe('http://localhost:9877');
  });
});
