import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { ProjectWatcher, WatcherManager } from '../src/watcher.js';
import type { ProjectConfig } from '../src/types.js';

/** Mock chokidar - we control when events fire */
const mockEmitter = new EventEmitter();
mockEmitter.close = vi.fn().mockResolvedValue(undefined);

vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    mockEmitter.removeAllListeners();
    return mockEmitter;
  }),
}));

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function createProjectConfig(
  projectDir: string,
  overrides?: Partial<ProjectConfig>
): ProjectConfig {
  return {
    name: 'test-project',
    path: projectDir,
    group: 'test-group',
    languages: ['typescript'],
    patterns: ['**/*.ts', '**/*.js'],
    exclude: ['**/node_modules/**'],
    indexing: {
      paths: [],
      exclude: [],
      extensions: [],
      chunkSize: 1024,
      overlap: 128,
      concurrency: 2,
      batchSize: 50,
    },
    watcher: {
      enabled: true,
      debounce: 30,
      stabilityThreshold: 100,
    },
    embeddings: { provider: 'ollama', model: 'test', dimensions: 4 },
    ...overrides,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for debounce + execution */
const DEBOUNCE_WAIT_MS = 80;

describe('ProjectWatcher', () => {
  let projectDir: string;
  let onFileChanged: ReturnType<typeof vi.fn>;
  let onFileDeleted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    projectDir = createTempDir();
    onFileChanged = vi.fn().mockResolvedValue(undefined);
    onFileDeleted = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('does not start when path does not exist', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const project = createProjectConfig('/nonexistent/path');
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Path does not exist'));
    expect(watcher.getStats().eventsProcessed).toBe(0);
    consoleSpy.mockRestore();
  });

  it('fires onFileChanged when add event is emitted', async () => {
    const project = createProjectConfig(projectDir);
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();
    await wait(50);

    const filePath = path.join(projectDir, 'src', 'foo.ts');
    mockEmitter.emit('add', filePath);

    await wait(DEBOUNCE_WAIT_MS);

    expect(onFileChanged).toHaveBeenCalledWith('test-group', project, filePath);
    expect(watcher.getStats().eventsProcessed).toBe(1);

    await watcher.stop();
  });

  it('fires onFileChanged when change event is emitted', async () => {
    const project = createProjectConfig(projectDir);
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();
    await wait(50);

    const filePath = path.join(projectDir, 'src', 'bar.ts');
    mockEmitter.emit('change', filePath);

    await wait(DEBOUNCE_WAIT_MS);

    expect(onFileChanged).toHaveBeenCalledWith('test-group', project, filePath);

    await watcher.stop();
  });

  it('fires onFileDeleted when unlink event is emitted', async () => {
    const project = createProjectConfig(projectDir);
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();
    await wait(50);

    const filePath = path.join(projectDir, 'src', 'deleted.ts');
    mockEmitter.emit('unlink', filePath);

    await wait(DEBOUNCE_WAIT_MS);

    expect(onFileDeleted).toHaveBeenCalledWith('test-group', project, filePath);

    await watcher.stop();
  });

  it('debounces rapid events', async () => {
    const project = createProjectConfig(projectDir, {
      watcher: { enabled: true, debounce: 50, stabilityThreshold: 100 },
    });
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();
    await wait(50);

    const filePath = path.join(projectDir, 'rapid.ts');
    mockEmitter.emit('add', filePath);
    mockEmitter.emit('change', filePath);
    mockEmitter.emit('change', filePath);

    await wait(100);

    expect(onFileChanged).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('tracks stats correctly', async () => {
    const project = createProjectConfig(projectDir);
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    expect(watcher.getStats()).toEqual({
      eventsProcessed: 0,
      eventsInQueue: 0,
      errorCount: 0,
      inFlightCount: 0,
      failedFiles: [],
    });

    watcher.start();
    await wait(50);

    mockEmitter.emit('add', path.join(projectDir, 'stats.ts'));
    await wait(DEBOUNCE_WAIT_MS);

    const stats = watcher.getStats();
    expect(stats.eventsProcessed).toBe(1);
    expect(stats.errorCount).toBe(0);
    expect(stats.failedFiles).toEqual([]);

    await watcher.stop();
  });

  it('adds to failedFiles when callback throws', async () => {
    onFileChanged.mockRejectedValueOnce(new Error('Index error'));

    const project = createProjectConfig(projectDir);
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();
    await wait(50);

    const filePath = path.join(projectDir, 'fails.ts');
    mockEmitter.emit('add', filePath);
    await wait(DEBOUNCE_WAIT_MS);

    const stats = watcher.getStats();
    expect(stats.errorCount).toBe(1);
    expect(stats.failedFiles.length).toBe(1);
    expect(stats.failedFiles[0]).toContain('fails.ts');

    await watcher.stop();
  });

  it('uses debounce override from options', async () => {
    const project = createProjectConfig(projectDir, {
      watcher: { enabled: true, debounce: 500, stabilityThreshold: 100 },
    });
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
      debounce: 20,
    });

    watcher.start();
    await wait(50);

    mockEmitter.emit('add', path.join(projectDir, 'fast.ts'));
    await wait(50);

    expect(onFileChanged).toHaveBeenCalled();

    await watcher.stop();
  });

  it('stop clears timers and closes watcher', async () => {
    const project = createProjectConfig(projectDir);
    const watcher = new ProjectWatcher({
      project,
      callbacks: { onFileChanged, onFileDeleted },
    });

    watcher.start();
    await wait(50);

    mockEmitter.emit('add', path.join(projectDir, 'pending.ts'));
    await watcher.stop();
    await wait(100);

    expect(watcher.getStats().eventsInQueue).toBe(0);
  });
});

describe('WatcherManager', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates manager with callbacks', () => {
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    expect(manager.size).toBe(0);
  });

  it('watch starts watcher for project', async () => {
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    const project = createProjectConfig(projectDir);

    manager.watch(project);

    expect(manager.size).toBe(1);
    expect(manager.getStats()).toHaveProperty('test-group/test-project');

    await manager.stopAll();
  });

  it('does not watch when watcher.enabled is false', () => {
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    const project = createProjectConfig(projectDir, {
      watcher: { enabled: false, debounce: 50, stabilityThreshold: 100 },
    });

    manager.watch(project);

    expect(manager.size).toBe(0);
  });

  it('ignores duplicate watch for same project', () => {
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    const project = createProjectConfig(projectDir);

    manager.watch(project);
    manager.watch(project);

    expect(manager.size).toBe(1);
  });

  it('unwatch stops watcher', async () => {
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    const project = createProjectConfig(projectDir);

    manager.watch(project);
    expect(manager.size).toBe(1);

    await manager.unwatch('test-group', 'test-project');
    expect(manager.size).toBe(0);
  });

  it('stopAll clears all watchers', async () => {
    const project2Dir = createTempDir();
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    const project1 = createProjectConfig(projectDir);
    const project2 = createProjectConfig(project2Dir, { name: 'other' });

    manager.watch(project1);
    manager.watch(project2);
    expect(manager.size).toBe(2);

    await manager.stopAll();
    expect(manager.size).toBe(0);

    fs.rmSync(project2Dir, { recursive: true, force: true });
  });

  it('getStats returns stats for all watchers', async () => {
    const callbacks = {
      onFileChanged: vi.fn().mockResolvedValue(undefined),
      onFileDeleted: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new WatcherManager(callbacks);
    const project = createProjectConfig(projectDir);

    manager.watch(project);
    const stats = manager.getStats();

    expect(stats).toHaveProperty('test-group/test-project');
    expect(stats['test-group/test-project']).toMatchObject({
      eventsProcessed: expect.any(Number),
      eventsInQueue: expect.any(Number),
      errorCount: expect.any(Number),
      inFlightCount: expect.any(Number),
      failedFiles: expect.any(Array),
    });

    await manager.stopAll();
  });
});
