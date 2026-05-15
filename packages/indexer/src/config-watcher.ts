import chokidar, { type FSWatcher } from 'chokidar';
import type { RepoConfig } from './types.js';
import type { LoadConfigResult } from './config-loader.js';
import { loadIndexerConfig } from './config-loader.js';

const DEFAULT_DEBOUNCE_MS = 500;

export interface ModifiedRepo {
  prior: RepoConfig;
  next: RepoConfig;
}

export interface ConfigChange {
  added: RepoConfig[];
  removed: RepoConfig[];
  /**
   * Each modified entry carries both the prior and the next snapshot so the
   * caller can detect identity changes — most importantly when `fullName`
   * changed (e.g. the user re-pointed an entry from `oldOwner/repo` to
   * `newOwner/repo`). The bookkeeping in the indexer is keyed by `fullName`,
   * so the prior key has to be removed and a fresh one inserted.
   */
  modified: ModifiedRepo[];
  next: RepoConfig[];
}

export interface ConfigWatcherOptions {
  configPath: string;
  token?: string;
  debounceMs?: number;
  /** Override for tests: synchronous trigger of the underlying watcher. */
  spawnWatcher?: (path: string) => MinimalWatcher;
  onChange: (change: ConfigChange) => void;
  onError?: (err: Error) => void;
}

/** Minimal subset of chokidar's FSWatcher we depend on, so tests can stub it. */
export interface MinimalWatcher {
  on(event: 'change', listener: (path: string) => void): MinimalWatcher;
  on(event: 'error', listener: (err: Error) => void): MinimalWatcher;
  close(): Promise<void> | void;
}

/**
 * Watches projects.yml on disk. On debounced change events, reparses
 * and emits a diff (added / removed / modified) against the prior in-memory state.
 */
export class ConfigWatcher {
  private readonly configPath: string;
  private readonly token?: string;
  private readonly debounceMs: number;
  private readonly onChange: (change: ConfigChange) => void;
  private readonly onError: (err: Error) => void;
  private readonly watcher: MinimalWatcher;
  private timer: NodeJS.Timeout | null = null;
  private current: RepoConfig[] = [];

  constructor(opts: ConfigWatcherOptions, initial: RepoConfig[]) {
    this.configPath = opts.configPath;
    this.token = opts.token;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onChange = opts.onChange;
    this.onError = opts.onError ?? ((err) => console.error('[config-watcher]', err.message));
    this.current = [...initial];

    const spawn = opts.spawnWatcher ?? defaultSpawner;
    this.watcher = spawn(this.configPath);
    this.watcher.on('change', () => this.scheduleReload());
    this.watcher.on('error', (err) => this.onError(err));
  }

  /** Test seam: trigger a reload synchronously, bypassing the debounce timer. */
  triggerReloadNowForTest(): void {
    this.reloadNow();
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reloadNow();
    }, this.debounceMs);
  }

  private reloadNow(): void {
    let next: LoadConfigResult;
    try {
      next = loadIndexerConfig(this.configPath, this.token);
    } catch (err) {
      this.onError(err as Error);
      return;
    }

    const change = diff(this.current, next.repos);
    this.current = next.repos;
    if (change.added.length === 0 && change.removed.length === 0 && change.modified.length === 0) {
      return;
    }
    this.onChange(change);
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher.close();
  }
}

/** Build the diff between prior and next repo lists keyed by `name`. */
export function diff(prior: RepoConfig[], next: RepoConfig[]): ConfigChange {
  const priorByName = new Map(prior.map((r) => [r.name, r]));
  const nextByName = new Map(next.map((r) => [r.name, r]));

  const added: RepoConfig[] = [];
  const modified: ModifiedRepo[] = [];
  for (const repo of next) {
    const prev = priorByName.get(repo.name);
    if (!prev) {
      added.push(repo);
      continue;
    }
    if (!sameRepo(prev, repo)) {
      modified.push({ prior: prev, next: repo });
    }
  }

  const removed: RepoConfig[] = [];
  for (const repo of prior) {
    if (!nextByName.has(repo.name)) removed.push(repo);
  }

  return { added, removed, modified, next };
}

function sameRepo(a: RepoConfig, b: RepoConfig): boolean {
  if (a.url !== b.url) return false;
  if (a.localPath !== b.localPath) return false;
  if (a.fullName !== b.fullName) return false;
  return JSON.stringify(a.overrides ?? {}) === JSON.stringify(b.overrides ?? {});
}

function defaultSpawner(configPath: string): MinimalWatcher {
  const watcher: FSWatcher = chokidar.watch(configPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  return watcher as unknown as MinimalWatcher;
}
