import fs from 'fs';
import path from 'path';
import { watch, type FSWatcher } from 'chokidar';
import { Minimatch } from 'minimatch';
import type { ProjectConfig } from './types.js';

export interface WatcherCallbacks {
  onFileChanged: (groupName: string, project: ProjectConfig, filePath: string) => Promise<void>;
  onFileDeleted: (groupName: string, project: ProjectConfig, filePath: string) => Promise<void>;
}

export interface ProjectWatcherOptions {
  project: ProjectConfig;
  callbacks: WatcherCallbacks;
  /** Override debounce from project config (ms) */
  debounce?: number;
}

export interface WatcherStats {
  eventsProcessed: number;
  eventsInQueue: number;
  errorCount: number;
  inFlightCount: number;
  failedFiles: string[];
}

const CBCALL_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 60_000;
const RETRY_MAX_ATTEMPTS = 3;
const STOP_TIMEOUT_MS = 10_000;

type PendingEvent = { event: 'change' | 'add' | 'unlink'; path: string };

/** File watcher for a single project — watches for changes and triggers indexing */
export class ProjectWatcher {
  private project: ProjectConfig;
  private callbacks: WatcherCallbacks;
  private debounceMs: number;
  private includeMatchers: Minimatch[];
  private excludeMatchers: Minimatch[];
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Set<string>();
  private failedFiles = new Map<string, PendingEvent & { attempts: number; lastError: string }>();
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private ignoreCache = new Map<string, boolean>();
  private stats = { eventsProcessed: 0, errorCount: 0 };

  constructor(options: ProjectWatcherOptions) {
    this.project = options.project;
    this.callbacks = options.callbacks;
    this.debounceMs = options.debounce ?? options.project.watcher.debounce;
    this.includeMatchers = options.project.patterns.map((p) => new Minimatch(p));
    this.excludeMatchers = options.project.exclude.map((e) => new Minimatch(e));
  }

  /** Start watching the project directory */
  start(): void {
    if (this.watcher) return;

    if (!fs.existsSync(this.project.path)) {
      console.error(`[watcher] Path does not exist: ${this.project.path}`);
      return;
    }

    const stabilityThreshold = this.project.watcher.stabilityThreshold ?? 1000;

    this.watcher = watch(this.project.path, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold, pollInterval: 100 },
      ignored: (absPath: string) => this.shouldIgnore(absPath),
    });

    this.watcher.on('change', (fp) => this.handleFileEvent('change', fp));
    this.watcher.on('add', (fp) => this.handleFileEvent('add', fp));
    this.watcher.on('unlink', (fp) => this.handleFileEvent('unlink', fp));

    this.retryInterval = setInterval(() => this.retryFailedFiles(), RETRY_INTERVAL_MS);
    this.retryInterval.unref(); // Don't hold event loop open

    console.log(
      `[watcher] Watching ${this.project.group}/${this.project.name} at ${this.project.path}`
    );
  }

  /** Stop watching */
  async stop(): Promise<void> {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }

    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.failedFiles.clear();
    this.inFlight.clear();
    this.ignoreCache.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Get watcher stats */
  getStats(): WatcherStats {
    return {
      eventsProcessed: this.stats.eventsProcessed,
      eventsInQueue: this.timers.size,
      errorCount: this.stats.errorCount,
      inFlightCount: this.inFlight.size,
      failedFiles: Array.from(this.failedFiles.keys()),
    };
  }

  private shouldIgnore(absPath: string): boolean {
    const cached = this.ignoreCache.get(absPath);
    if (cached !== undefined) return cached;

    const rel = path.relative(this.project.path, absPath);
    if (rel.startsWith('..')) {
      this.ignoreCache.set(absPath, true);
      return true;
    }
    const matchesPattern = this.includeMatchers.some((m) => m.match(rel));
    const matchesExclude = this.excludeMatchers.some((m) => m.match(rel));
    const result = !matchesPattern || matchesExclude;
    this.ignoreCache.set(absPath, result);
    return result;
  }

  private handleFileEvent(event: 'change' | 'add' | 'unlink', fp: string): void {
    const key = `${this.project.name}:${fp}`;
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key)!);
      this.timers.delete(key);
    }

    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.executeDebounced(key, event, fp);
    }, this.debounceMs);

    this.timers.set(key, timer);
  }

  private async executeDebounced(
    key: string,
    event: 'change' | 'add' | 'unlink',
    fp: string
  ): Promise<void> {
    if (this.inFlight.has(key)) {
      console.warn(`[watcher] Skipping ${key} - already processing`);
      return;
    }

    this.inFlight.add(key);
    try {
      await this.executeWithTimeout(async () => {
        if (event === 'unlink') {
          await this.callbacks.onFileDeleted(this.project.group, this.project, fp);
        } else {
          await this.callbacks.onFileChanged(this.project.group, this.project, fp);
        }
      });
      this.stats.eventsProcessed++;
      this.failedFiles.delete(key);
    } catch (err) {
      this.stats.errorCount++;
      const rel = path.relative(this.project.path, fp);
      const errMsg = (err as Error).message;
      console.error(`[watcher] Error handling ${event} for ${this.project.name}/${rel}: ${errMsg}`);
      this.failedFiles.set(key, {
        event,
        path: fp,
        attempts: 0,
        lastError: errMsg,
      });
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async executeWithTimeout(
    fn: () => Promise<void>,
    timeoutMs = CBCALL_TIMEOUT_MS
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Callback timeout')), timeoutMs);
    });
    try {
      await Promise.race([fn(), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async retryFailedFiles(): Promise<void> {
    for (const [key, failed] of this.failedFiles.entries()) {
      if (failed.attempts >= RETRY_MAX_ATTEMPTS) {
        console.error(`[watcher] Giving up on ${key} after ${RETRY_MAX_ATTEMPTS} attempts`);
        this.failedFiles.delete(key);
        continue;
      }

      if (this.inFlight.has(key)) continue;

      this.inFlight.add(key);
      try {
        await this.executeWithTimeout(async () => {
          if (failed.event === 'unlink') {
            await this.callbacks.onFileDeleted(this.project.group, this.project, failed.path);
          } else {
            await this.callbacks.onFileChanged(this.project.group, this.project, failed.path);
          }
        });

        console.log(`[watcher] Retry successful for ${key}`);
        this.failedFiles.delete(key);
        this.stats.eventsProcessed++;
      } catch (err) {
        failed.attempts++;
        failed.lastError = (err as Error).message;
        console.warn(`[watcher] Retry ${failed.attempts}/${RETRY_MAX_ATTEMPTS} failed for ${key}`);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }
}

/** Manages watchers for multiple projects */
export class WatcherManager {
  private watchers = new Map<string, ProjectWatcher>();
  private callbacks: WatcherCallbacks;

  constructor(callbacks: WatcherCallbacks) {
    this.callbacks = callbacks;
  }

  /** Start watching a project */
  watch(project: ProjectConfig): void {
    const key = `${project.group}/${project.name}`;
    if (this.watchers.has(key)) return;

    if (!project.watcher.enabled) {
      console.log(`[watcher] Watcher disabled for ${key}`);
      return;
    }

    const watcher = new ProjectWatcher({
      project,
      callbacks: this.callbacks,
    });
    watcher.start();
    this.watchers.set(key, watcher);
  }

  /** Stop watching a project */
  async unwatch(groupName: string, projectName: string): Promise<void> {
    const key = `${groupName}/${projectName}`;
    const watcher = this.watchers.get(key);
    if (watcher) {
      await watcher.stop();
      this.watchers.delete(key);
    }
  }

  /** Stop all watchers */
  async stopAll(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    const stops = Array.from(this.watchers.values()).map((w) => w.stop());

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Stop timeout')), timeoutMs);
    });

    try {
      await Promise.race([Promise.all(stops), timeoutPromise]);
    } catch (err) {
      console.error('[watcher] Force closing watchers after timeout:', (err as Error).message);
    } finally {
      clearTimeout(timer);
    }

    this.watchers.clear();
  }

  /** Get stats from all watchers */
  getStats(): Record<string, WatcherStats> {
    const result: Record<string, WatcherStats> = {};
    for (const [key, w] of this.watchers.entries()) {
      result[key] = w.getStats();
    }
    return result;
  }

  /** Number of active watchers */
  get size(): number {
    return this.watchers.size;
  }
}
