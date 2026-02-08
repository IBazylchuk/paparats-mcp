import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'http';
import http from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runChecks } from '../src/commands/doctor.js';
import { ApiClient } from '../src/api-client.js';
import { findConfigDir, readConfig, CONFIG_FILE } from '../src/config.js';

vi.mock('child_process');
vi.mock('fs');
vi.mock('os');
vi.mock('../src/config.js');
vi.mock('../src/api-client.js');

const mockedExecSync = vi.mocked(execSync);
const mockedFs = vi.mocked(fs);
const mockedOs = vi.mocked(os);
const mockedFindConfigDir = vi.mocked(findConfigDir);
const mockedReadConfig = vi.mocked(readConfig);
const mockedApiClient = vi.mocked(ApiClient);

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

describe('doctor', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };

    mockedOs.homedir.mockReturnValue('/fake/home');
    mockedFs.existsSync.mockReturnValue(false);
    mockedApiClient.mockImplementation(function (this: unknown) {
      return {
        health: vi.fn().mockRejectedValue(new Error('unreachable')),
      };
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  describe('runChecks', () => {
    describe('Config check', () => {
      it('reports ok when config found and valid', async () => {
        const tmpDir = '/tmp/project';
        mockedFindConfigDir.mockReturnValue(tmpDir);
        mockedReadConfig.mockReturnValue({
          config: { group: 'g', language: 'ruby' },
          projectDir: tmpDir,
        });

        const results = await runChecks('http://localhost:9876');

        const configCheck = results.find((r) => r.name === CONFIG_FILE);
        expect(configCheck).toBeDefined();
        expect(configCheck?.ok).toBe(true);
        expect(configCheck?.message).toContain(tmpDir);
      });

      it('reports fail when config not found', async () => {
        mockedFindConfigDir.mockReturnValue(null);

        const results = await runChecks('http://localhost:9876');

        const configCheck = results.find((r) => r.name === CONFIG_FILE);
        expect(configCheck?.ok).toBe(false);
        expect(configCheck?.message).toContain('not found');
      });

      it('reports fail when config invalid', async () => {
        mockedFindConfigDir.mockReturnValue('/tmp/project');
        mockedReadConfig.mockImplementation(() => {
          throw new Error('Invalid YAML');
        });

        const results = await runChecks('http://localhost:9876');

        const configCheck = results.find((r) => r.name === CONFIG_FILE);
        expect(configCheck?.ok).toBe(false);
        expect(configCheck?.message).toBe('Invalid YAML');
      });
    });

    describe('Install check', () => {
      it('reports ok when docker-compose.yml exists', async () => {
        mockedFindConfigDir.mockReturnValue(null);
        mockedFs.existsSync.mockImplementation((p: string) => {
          return String(p).endsWith('docker-compose.yml');
        });

        const results = await runChecks('http://localhost:9876');

        const installCheck = results.find((r) => r.name === 'Install');
        expect(installCheck?.ok).toBe(true);
        expect(installCheck?.message).toContain('exists');
      });

      it('reports fail when docker-compose.yml missing', async () => {
        mockedFindConfigDir.mockReturnValue(null);
        mockedFs.existsSync.mockReturnValue(false);

        const results = await runChecks('http://localhost:9876');

        const installCheck = results.find((r) => r.name === 'Install');
        expect(installCheck?.ok).toBe(false);
        expect(installCheck?.message).toContain('paparats install');
      });

      it('uses os.homedir for path', async () => {
        mockedOs.homedir.mockReturnValue('/custom/home');
        mockedFs.existsSync.mockReturnValue(false);

        await runChecks('http://localhost:9876');

        const composePath = path.join('/custom/home', '.paparats', 'docker-compose.yml');
        expect(mockedFs.existsSync).toHaveBeenCalledWith(composePath);
      });
    });

    describe('Docker check', () => {
      it('reports ok when docker installed and running', async () => {
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const results = await runChecks('http://localhost:9876');

        const dockerCheck = results.find((r) => r.name === 'Docker');
        expect(dockerCheck?.ok).toBe(true);
      });

      it('reports fail when docker not installed', async () => {
        mockedExecSync.mockImplementation(() => {
          throw new Error('not found');
        });
        mockedFindConfigDir.mockReturnValue(null);

        const results = await runChecks('http://localhost:9876');

        const dockerCheck = results.find((r) => r.name === 'Docker');
        expect(dockerCheck?.ok).toBe(false);
        expect(dockerCheck?.message).toContain('not installed');
      });
    });

    describe('Docker Compose check', () => {
      it('reports ok when docker-compose standalone exists', async () => {
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const results = await runChecks('http://localhost:9876');

        const dcCheck = results.find((r) => r.name === 'Docker Compose');
        expect(dcCheck).toBeDefined();
      });
    });

    describe('Ollama check', () => {
      it('uses OLLAMA_URL from env', async () => {
        const customOllamaUrl = 'http://127.0.0.1:9999';
        process.env.OLLAMA_URL = customOllamaUrl;
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const mockFetch = vi.fn((url: string | URL) => {
          const urlStr = typeof url === 'string' ? url : url.href;
          if (urlStr.startsWith(customOllamaUrl)) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  models: [{ name: 'jina-code-embeddings' }],
                }),
            } as Response);
          }
          return originalFetch(url as URL);
        });
        globalThis.fetch = mockFetch;

        const results = await runChecks('http://localhost:9876');

        const ollamaCheck = results.find((r) => r.name === 'Ollama');
        expect(ollamaCheck?.ok).toBe(true);
        expect(ollamaCheck?.message).toContain('jina-code-embeddings');
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining(customOllamaUrl),
          expect.any(Object)
        );
      });

      it('reads model from config when available', async () => {
        const ollamaServer = await createTestServer((req, res) => {
          res.writeHead(200);
          res.end(JSON.stringify({ models: [{ name: 'custom-model' }] }));
        });
        const ollamaPort = getPort(ollamaServer);

        process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`;
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue('/tmp/proj');
        mockedReadConfig.mockReturnValue({
          config: {
            group: 'g',
            language: 'ruby',
            embeddings: { model: 'custom-model' },
          },
          projectDir: '/tmp/proj',
        });

        const results = await runChecks('http://localhost:9876');

        const ollamaCheck = results.find((r) => r.name === 'Ollama');
        expect(ollamaCheck?.ok).toBe(true);
        expect(ollamaCheck?.message).toContain('custom-model');

        await new Promise<void>((resolve, reject) => {
          ollamaServer.close((err) => (err ? reject(err) : resolve()));
        });
      });
    });

    describe('Qdrant check', () => {
      it('uses QDRANT_URL from env', async () => {
        const qdrantServer = await createTestServer((_req, res) => {
          res.writeHead(200);
          res.end('ok');
        });
        const qdrantPort = getPort(qdrantServer);

        process.env.QDRANT_URL = `http://127.0.0.1:${qdrantPort}`;
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const results = await runChecks('http://localhost:9876');

        const qdrantCheck = results.find((r) => r.name === 'Qdrant');
        expect(qdrantCheck?.ok).toBe(true);
        expect(qdrantCheck?.message).toContain(`127.0.0.1:${qdrantPort}`);

        await new Promise<void>((resolve, reject) => {
          qdrantServer.close((err) => (err ? reject(err) : resolve()));
        });
      });
    });

    describe('MCP Server check', () => {
      it('reports ok when server reachable', async () => {
        const mcpServer = await createTestServer((_req, res) => {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok' }));
        });
        const mcpPort = getPort(mcpServer);

        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const mockHealth = vi.fn().mockResolvedValue({ status: 200 });
        mockedApiClient.mockImplementation(function (this: unknown) {
          return { health: mockHealth };
        });

        const results = await runChecks(`http://127.0.0.1:${mcpPort}`);

        const mcpCheck = results.find((r) => r.name === 'MCP Server');
        expect(mcpCheck?.ok).toBe(true);

        await new Promise<void>((resolve, reject) => {
          mcpServer.close((err) => (err ? reject(err) : resolve()));
        });
      });

      it('reports fail when server unreachable', async () => {
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const mockHealth = vi.fn().mockRejectedValue(new Error('Connection refused'));
        mockedApiClient.mockImplementation(function (this: unknown) {
          return { health: mockHealth };
        });

        const results = await runChecks('http://127.0.0.1:19999');

        const mcpCheck = results.find((r) => r.name === 'MCP Server');
        expect(mcpCheck?.ok).toBe(false);
        expect(mcpCheck?.message).toContain('unreachable');
      });
    });

    describe('callback and verbose', () => {
      it('calls onCheckStart for each check', async () => {
        const callback = vi.fn();
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        await runChecks('http://localhost:9876', callback);

        expect(callback).toHaveBeenCalledWith('Config');
        expect(callback).toHaveBeenCalledWith('Install');
        expect(callback).toHaveBeenCalledWith('Docker');
        expect(callback).toHaveBeenCalledWith('Docker Compose');
        expect(callback).toHaveBeenCalledWith('Ollama');
        expect(callback).toHaveBeenCalledWith('Qdrant');
        expect(callback).toHaveBeenCalledWith('MCP Server');
      });

      it('returns all expected check names', async () => {
        mockedExecSync.mockReturnValue(Buffer.from(''));
        mockedFindConfigDir.mockReturnValue(null);

        const results = await runChecks('http://localhost:9876');

        const names = results.map((r) => r.name);
        expect(names).toContain(CONFIG_FILE);
        expect(names).toContain('Install');
        expect(names).toContain('Docker');
        expect(names).toContain('Docker Compose');
        expect(names).toContain('Ollama');
        expect(names).toContain('Qdrant');
        expect(names).toContain('MCP Server');
        expect(results.length).toBe(7);
      });
    });
  });
});
