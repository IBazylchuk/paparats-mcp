import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWatch, WatchDeps } from '../src/commands/watch.js';

vi.mock('glob', () => ({
  globSync: vi.fn().mockReturnValue(['src/index.ts', 'src/utils.ts']),
}));

const mockConfig = {
  config: {
    group: 'test-group',
    language: 'typescript',
    indexing: {
      paths: ['./'],
      exclude: ['**/node_modules/**'],
    },
    watcher: { debounce: 500, stabilityThreshold: 200 },
  },
  projectDir: '/tmp/test-project',
};

describe('watch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runWatch', () => {
    it('dry-run returns early without starting watcher', async () => {
      const readConfigFn = vi.fn().mockReturnValue(mockConfig);
      const createWatcher = vi.fn();
      const apiClient = {
        health: vi.fn(),
        fileChanged: vi.fn(),
        fileDeleted: vi.fn(),
      };

      const deps: WatchDeps = {
        readConfigFn,
        createWatcher,
        apiClient,
      };

      const cleanup = await runWatch({ dryRun: true }, deps);

      expect(readConfigFn).toHaveBeenCalled();
      expect(createWatcher).not.toHaveBeenCalled();
      expect(apiClient.health).not.toHaveBeenCalled();

      await cleanup();
    });

    it('throws when server unreachable', async () => {
      const readConfigFn = vi.fn().mockReturnValue(mockConfig);
      const apiClient = {
        health: vi.fn().mockRejectedValue(new Error('Connection refused')),
        fileChanged: vi.fn(),
        fileDeleted: vi.fn(),
      };

      const deps: WatchDeps = {
        readConfigFn,
        apiClient,
      };

      await expect(runWatch({ server: 'http://localhost:9999' }, deps)).rejects.toThrow(
        /Cannot connect to server/
      );
    });

    it('throws when server returns non-200', async () => {
      const readConfigFn = vi.fn().mockReturnValue(mockConfig);
      const apiClient = {
        health: vi.fn().mockResolvedValue({ status: 503 }),
        fileChanged: vi.fn(),
        fileDeleted: vi.fn(),
      };

      const deps: WatchDeps = {
        readConfigFn,
        apiClient,
      };

      await expect(runWatch({}, deps)).rejects.toThrow(/Cannot connect to server/);
    });

    it('returns cleanup function when server is healthy', async () => {
      const closeFn = vi.fn();
      const createWatcher = vi.fn().mockReturnValue({
        on: vi.fn(),
        close: closeFn,
        getWatched: () => ({ '/tmp/test-project': ['a.ts', 'b.ts'] }),
      });

      const readConfigFn = vi.fn().mockReturnValue(mockConfig);
      const apiClient = {
        health: vi.fn().mockResolvedValue({ status: 200 }),
        fileChanged: vi.fn(),
        fileDeleted: vi.fn(),
      };

      const deps: WatchDeps = {
        readConfigFn,
        createWatcher,
        apiClient,
      };

      const cleanup = await runWatch({}, deps);

      expect(typeof cleanup).toBe('function');
      expect(createWatcher).toHaveBeenCalled();

      await cleanup();

      expect(closeFn).toHaveBeenCalled();
    });

    it('throws when readConfig fails', async () => {
      const readConfigFn = vi.fn().mockImplementation(() => {
        throw new Error('No .paparats.yml found');
      });

      const deps: WatchDeps = { readConfigFn };

      await expect(runWatch({}, deps)).rejects.toThrow('No .paparats.yml found');
    });

    it('suppresses human output when json mode', async () => {
      const closeFn = vi.fn();
      const createWatcher = vi.fn().mockReturnValue({
        on: vi.fn(),
        close: closeFn,
        getWatched: () => ({ '/tmp/test-project': [] }),
      });

      const readConfigFn = vi.fn().mockReturnValue(mockConfig);
      const apiClient = {
        health: vi.fn().mockResolvedValue({ status: 200 }),
        fileChanged: vi.fn(),
        fileDeleted: vi.fn(),
      };

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const deps: WatchDeps = {
        readConfigFn,
        createWatcher,
        apiClient,
      };

      const cleanup = await runWatch({ json: true }, deps);

      expect(createWatcher).toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Watching'));

      await cleanup();
      logSpy.mockRestore();
    });
  });
});
