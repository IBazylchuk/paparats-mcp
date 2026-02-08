import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runStatus,
  validateHealthResponse,
  dockerStatus,
  ollamaStatus,
  StatusDeps,
} from '../src/commands/status.js';
import { execSync } from 'child_process';

vi.mock('child_process');

const mockedExecSync = vi.mocked(execSync);

describe('status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateHealthResponse', () => {
    it('returns true for valid response', () => {
      const data = {
        status: 'ok',
        groups: { default: 100 },
        uptime: 3600,
        memory: { heapUsed: '256', percent: 12 },
      };
      expect(validateHealthResponse(data)).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateHealthResponse(null)).toBe(false);
    });

    it('returns false for non-object', () => {
      expect(validateHealthResponse('string')).toBe(false);
      expect(validateHealthResponse(123)).toBe(false);
    });

    it('returns false for missing required fields', () => {
      expect(validateHealthResponse({})).toBe(false);
      expect(validateHealthResponse({ status: 'ok' })).toBe(false);
      expect(validateHealthResponse({ status: 'ok', groups: {} })).toBe(false);
    });

    it('returns false for wrong types', () => {
      expect(
        validateHealthResponse({
          status: 123,
          groups: {},
          uptime: 100,
          memory: {},
        })
      ).toBe(false);
    });
  });

  describe('dockerStatus', () => {
    it('returns running when containers found', () => {
      mockedExecSync.mockReturnValue('paparats-qdrant|Up 2 hours\npaparats-mcp|Up 2 hours\n');

      const result = dockerStatus();

      expect(result.qdrant).toBe('Up 2 hours');
      expect(result.mcp).toBe('Up 2 hours');
    });

    it('returns not running when no containers', () => {
      mockedExecSync.mockReturnValue('');

      const result = dockerStatus();

      expect(result.qdrant).toBe('not running');
      expect(result.mcp).toBe('not running');
    });

    it('handles name with qdrant substring', () => {
      mockedExecSync.mockReturnValue('my-paparats-qdrant|Up 1 hour\n');

      const result = dockerStatus();

      expect(result.qdrant).toBe('Up 1 hour');
    });

    it('returns not running when docker throws', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('Docker not available');
      });

      const result = dockerStatus();

      expect(result.qdrant).toBe('not running');
      expect(result.mcp).toBe('not running');
    });
  });

  describe('ollamaStatus', () => {
    it('returns model ready when model found', () => {
      mockedExecSync.mockReturnValue('NAME\njina-code-embeddings\n');

      const result = ollamaStatus();

      expect(result).toBe('model ready');
    });

    it('returns running (model not found) when ollama runs but model missing', () => {
      mockedExecSync.mockReturnValue('NAME\nllama3\n');

      const result = ollamaStatus();

      expect(result).toBe('running (model not found)');
    });

    it('uses custom model name', () => {
      mockedExecSync.mockReturnValue('NAME\ncustom-embeddings\n');

      const result = ollamaStatus('custom-embeddings');

      expect(result).toBe('model ready');
    });

    it('returns not running when ollama throws', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('ollama not found');
      });

      const result = ollamaStatus();

      expect(result).toBe('not running');
    });
  });

  describe('runStatus', () => {
    it('returns full status with mocked deps', async () => {
      const healthCheck = vi.fn().mockResolvedValue({
        status: 200,
        data: {
          status: 'ok',
          groups: { default: 50 },
          uptime: 7200,
          memory: { heapUsed: '128', percent: 8 },
        },
      });

      const deps: StatusDeps = {
        dockerStatus: () => ({ qdrant: 'Up 1h', mcp: 'Up 1h' }),
        ollamaStatus: () => 'model ready',
        findConfigDir: () => '/tmp/project',
        readConfig: () => ({
          config: {
            group: 'my-group',
            language: 'typescript',
            embeddings: { model: 'jina-code-embeddings' },
          },
          projectDir: '/tmp/project',
        }),
        healthCheck,
      };

      const result = await runStatus({ server: 'http://localhost:9876' }, deps);

      expect(result.docker).toEqual({ qdrant: 'Up 1h', mcp: 'Up 1h' });
      expect(result.ollama).toBe('model ready');
      expect(result.config.found).toBe(true);
      expect(result.config.group).toBe('my-group');
      expect(result.config.language).toBe('typescript');
      expect(result.server.ok).toBe(true);
      expect(result.server.status).toBe('ok');
      expect(result.server.uptime).toBe(7200);
      expect(result.server.groups).toEqual({ default: 50 });
      expect(healthCheck).toHaveBeenCalledWith('http://localhost:9876', 5_000);
    });

    it('uses model from config when embeddings.model set', async () => {
      const ollamaStatusMock = vi.fn().mockReturnValue('model ready');

      const deps: StatusDeps = {
        dockerStatus: () => ({ qdrant: 'running', mcp: 'running' }),
        ollamaStatus: ollamaStatusMock,
        findConfigDir: () => '/tmp/project',
        readConfig: () => ({
          config: {
            group: 'g',
            language: 'go',
            embeddings: { model: 'custom-model' },
          },
          projectDir: '/tmp/project',
        }),
        healthCheck: vi.fn().mockResolvedValue({
          status: 200,
          data: {
            status: 'ok',
            groups: {},
            uptime: 0,
            memory: { heapUsed: '0', percent: 0 },
          },
        }),
      };

      await runStatus({}, deps);

      expect(ollamaStatusMock).toHaveBeenCalledWith('custom-model');
    });

    it('handles invalid health response', async () => {
      const healthCheck = vi.fn().mockResolvedValue({
        status: 200,
        data: { invalid: 'structure' },
      });

      const deps: StatusDeps = {
        dockerStatus: () => ({ qdrant: 'running', mcp: 'running' }),
        ollamaStatus: () => 'model ready',
        findConfigDir: () => null,
        readConfig: () => ({ config: { group: 'g', language: 'ts' }, projectDir: '/' }),
        healthCheck,
      };

      const result = await runStatus({}, deps);

      expect(result.server.ok).toBe(true);
      expect(result.server.error).toBe('invalid response');
    });

    it('handles server unreachable', async () => {
      const healthCheck = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const deps: StatusDeps = {
        dockerStatus: () => ({ qdrant: 'not running', mcp: 'not running' }),
        ollamaStatus: () => 'not running',
        findConfigDir: () => null,
        healthCheck,
      };

      const result = await runStatus({}, deps);

      expect(result.server.ok).toBe(false);
      expect(result.server.error).toBe('unreachable');
    });

    it('uses custom timeout', async () => {
      const healthCheck = vi.fn().mockResolvedValue({
        status: 200,
        data: {
          status: 'ok',
          groups: {},
          uptime: 0,
          memory: { heapUsed: '0', percent: 0 },
        },
      });

      const deps: StatusDeps = {
        dockerStatus: () => ({ qdrant: 'running', mcp: 'running' }),
        ollamaStatus: () => 'model ready',
        findConfigDir: () => null,
        healthCheck,
      };

      await runStatus({ timeout: 10_000, server: 'http://test:9876' }, deps);

      expect(healthCheck).toHaveBeenCalledWith('http://test:9876', 10_000);
    });

    it('handles config read error', async () => {
      const deps: StatusDeps = {
        dockerStatus: () => ({ qdrant: 'running', mcp: 'running' }),
        ollamaStatus: () => 'model ready',
        findConfigDir: () => '/tmp/project',
        readConfig: () => {
          throw new Error('Invalid YAML');
        },
        healthCheck: vi.fn().mockResolvedValue({
          status: 200,
          data: {
            status: 'ok',
            groups: {},
            uptime: 0,
            memory: { heapUsed: '0', percent: 0 },
          },
        }),
      };

      const result = await runStatus({}, deps);

      expect(result.config.found).toBe(true);
      expect(result.config.error).toBe('Invalid YAML');
    });
  });
});
