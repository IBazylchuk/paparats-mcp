import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'http';
import http from 'http';
import { ApiClient } from '../src/api-client.js';

// ── Test server helper ──────────────────────────────────────────────────────

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr !== null ? addr.port : 0;
}

// ── Constructor ─────────────────────────────────────────────────────────────

describe('ApiClient', () => {
  describe('constructor', () => {
    it('accepts string baseUrl', () => {
      const client = new ApiClient('http://localhost:9000');
      expect(client).toBeInstanceOf(ApiClient);
    });

    it('accepts options object', () => {
      const client = new ApiClient({ baseUrl: 'http://127.0.0.1:8000' });
      expect(client).toBeInstanceOf(ApiClient);
    });

    it('uses default baseUrl when not provided', () => {
      const client = new ApiClient();
      expect(client).toBeInstanceOf(ApiClient);
    });

    it('throws on invalid baseUrl', () => {
      expect(() => new ApiClient('not-a-url')).toThrow('Invalid base URL');
    });
  });

  describe('HTTP requests', () => {
    let server: Server;
    let client: ApiClient;

    beforeEach(async () => {
      server = await createTestServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
        } else if (req.url === '/api/search') {
          let body = '';
          req.on('data', (chunk) => (body += chunk.toString()));
          req.on('end', () => {
            const data = JSON.parse(body || '{}');
            res.writeHead(200);
            res.end(JSON.stringify({ results: [], total: 0, query: data.query }));
          });
        } else if (req.url === '/api/index') {
          let body = '';
          req.on('data', (chunk) => (body += chunk.toString()));
          req.on('end', () => {
            const data = JSON.parse(body || '{}');
            res.writeHead(200);
            res.end(
              JSON.stringify({
                status: 'ok',
                group: data.group,
                project: data.project,
                chunks: (data.files ?? []).length,
              })
            );
          });
        } else if (req.url === '/api/file-changed') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', message: 'File reindexed' }));
        } else if (req.url === '/api/file-deleted') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', message: 'File removed from index' }));
        } else if (req.url === '/api/stats') {
          res.writeHead(200);
          res.end(JSON.stringify({ groups: {}, cache: {}, watcher: {}, usage: {} }));
        } else if (req.url === '/error-400') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Bad request' }));
        } else if (req.url === '/error-500') {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        } else if (req.url === '/invalid-json') {
          res.writeHead(200);
          res.end('not json');
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
      const port = getPort(server);
      client = new ApiClient(`http://127.0.0.1:${port}`);
    });

    afterEach(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        })
    );

    it('health returns 200 and data', async () => {
      const res = await client.health();
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ status: 'ok' });
    });

    it('search sends correct body and returns data', async () => {
      const res = await client.search('g', 'foo', { project: 'p', limit: 10 });
      expect(res.status).toBe(200);
      expect((res.data as { query?: string }).query).toBe('foo');
      expect((res.data as { results?: unknown[] }).results).toEqual([]);
    });

    it('indexContent sends group, project, files and returns data', async () => {
      const res = await client.indexContent('g', 'p', [
        { path: 'src/foo.ts', content: 'const x = 1;', language: 'typescript' },
      ]);
      expect(res.status).toBe(200);
      expect((res.data as { group?: string }).group).toBe('g');
      expect((res.data as { project?: string }).project).toBe('p');
      expect((res.data as { chunks?: number }).chunks).toBe(1);
    });

    it('fileChanged sends group, project, path, content', async () => {
      const res = await client.fileChanged('g', 'p', 'src/foo.ts', 'const x = 1;');
      expect(res.status).toBe(200);
      expect((res.data as { message?: string }).message).toBe('File reindexed');
    });

    it('fileDeleted sends group, project, path', async () => {
      const res = await client.fileDeleted('g', 'p', 'src/foo.ts');
      expect(res.status).toBe(200);
      expect((res.data as { message?: string }).message).toBe('File removed from index');
    });

    it('stats returns 200', async () => {
      const res = await client.stats();
      expect(res.status).toBe(200);
      expect((res.data as { groups?: unknown }).groups).toBeDefined();
    });

    it('rejects on 4xx with error message', async () => {
      const port = getPort(server);
      const c = new ApiClient(`http://127.0.0.1:${port}`);
      await expect(c.request({ method: 'GET', path: '/error-400' })).rejects.toThrow(
        'HTTP 400: Bad request'
      );
    });

    it('rejects on 5xx with error message', async () => {
      const port = getPort(server);
      const c = new ApiClient(`http://127.0.0.1:${port}`);
      await expect(c.request({ method: 'GET', path: '/error-500' })).rejects.toThrow(
        'HTTP 500: Internal server error'
      );
    });

    it('rejects on invalid JSON response', async () => {
      const port = getPort(server);
      const c = new ApiClient(`http://127.0.0.1:${port}`);
      await expect(c.request({ method: 'GET', path: '/invalid-json' })).rejects.toThrow(
        'Invalid JSON response'
      );
    });
  });

  describe('connection errors', () => {
    it('throws on connection refused', async () => {
      const client = new ApiClient('http://127.0.0.1:19999');
      await expect(client.health()).rejects.toThrow('Connection refused');
    });

    it('throws on invalid host', async () => {
      const client = new ApiClient('http://nonexistent-host-xyz-12345.local:9876');
      await expect(client.health({ timeout: 2000 })).rejects.toThrow();
    }, 5000);
  });

  describe('timeout', () => {
    it('rejects when request exceeds timeout', async () => {
      const server = await createTestServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        // Never respond
      });
      const port = getPort(server);
      const client = new ApiClient(`http://127.0.0.1:${port}`);

      await expect(client.health({ timeout: 100 })).rejects.toThrow('timed out');

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  describe('abort', () => {
    it('rejects when signal is aborted', async () => {
      const server = await createTestServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        // Never respond
      });
      const port = getPort(server);
      const client = new ApiClient(`http://127.0.0.1:${port}`);

      const controller = new AbortController();
      const promise = client.search('g', 'q', { signal: controller.signal });
      controller.abort();

      await expect(promise).rejects.toThrow('aborted');

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  describe('retry', () => {
    it('retries on transient error and succeeds', async () => {
      let attempt = 0;
      const server = await createTestServer((_req, res) => {
        attempt++;
        if (attempt === 1) {
          res.destroy();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', group: 'g', project: 'p', chunks: 0 }));
      });
      const port = getPort(server);
      const client = new ApiClient({
        baseUrl: `http://127.0.0.1:${port}`,
        maxRetries: 3,
      });

      const res = await client.indexContent('g', 'p', [{ path: 'a.ts', content: 'x' }]);
      expect(res.status).toBe(200);
      expect(attempt).toBe(2);

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it('does not retry on 4xx', async () => {
      let attempt = 0;
      const server = await createTestServer((_req, res) => {
        attempt++;
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Bad request' }));
      });
      const port = getPort(server);
      const client = new ApiClient({
        baseUrl: `http://127.0.0.1:${port}`,
        maxRetries: 3,
      });

      await expect(client.indexContent('g', 'p', [{ path: 'a.ts', content: 'x' }])).rejects.toThrow(
        'Bad request'
      );
      expect(attempt).toBe(1);

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  describe('HTTPS', () => {
    it('uses https module for https URLs', async () => {
      // We can't easily test real HTTPS without certs, but we can verify
      // the client doesn't crash when given https URL - it will fail with
      // connection error (no local HTTPS server)
      const client = new ApiClient('https://127.0.0.1:9876');
      await expect(client.health({ timeout: 2000 })).rejects.toThrow();
    });
  });

  describe('debug logging', () => {
    it('does not log when debug is false', async () => {
      const server = await createTestServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
      });
      const port = getPort(server);
      const client = new ApiClient(`http://127.0.0.1:${port}`);

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await client.health();
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });

    it('logs when debug is true', async () => {
      const server = await createTestServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
      });
      const port = getPort(server);
      const client = new ApiClient({ baseUrl: `http://127.0.0.1:${port}`, debug: true });

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await client.health();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[ApiClient]'), expect.anything());

      spy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    });
  });
});
