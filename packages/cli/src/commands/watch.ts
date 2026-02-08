import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import pLimit from 'p-limit';
import { watch } from 'chokidar';
import { minimatch } from 'minimatch';
import { globSync } from 'glob';
import { readConfig, CONFIG_FILE, getLanguageFromPath } from '../config.js';
import { ApiClient } from '../api-client.js';

export interface WatchOptions {
  server?: string;
  verbose?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

const CONCURRENT_REINDEX_LIMIT = 5;

export interface WatchDeps {
  readConfigFn?: () => {
    config: Awaited<ReturnType<typeof readConfig>>['config'];
    projectDir: string;
  };
  createWatcher?: typeof watch;
  apiClient?: {
    fileChanged: (
      group: string,
      project: string,
      path: string,
      content: string,
      opts?: { language?: string }
    ) => Promise<unknown>;
    fileDeleted: (group: string, project: string, path: string) => Promise<unknown>;
    health: (opts?: { timeout?: number }) => Promise<{ status: number }>;
  };
}

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**'];
const MAX_RETRIES = 3;

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

/** Run watch command. Returns async cleanup function to stop watcher and drain pending. */
export async function runWatch(opts: WatchOptions, deps?: WatchDeps): Promise<() => Promise<void>> {
  const readCfg = deps?.readConfigFn ?? readConfig;
  const createWatch = deps?.createWatcher ?? watch;

  let config: { config: Awaited<ReturnType<typeof readConfig>>['config']; projectDir: string };
  try {
    config = readCfg();
  } catch (err) {
    throw new Error((err as Error).message, { cause: err });
  }

  const { config: cfg, projectDir } = config;
  const projectName = path.basename(projectDir);
  const group = cfg.group;
  const client = deps?.apiClient ?? new ApiClient(opts.server ?? 'http://localhost:9876');

  const exclude = cfg.indexing?.exclude ?? DEFAULT_EXCLUDE;
  const indexPaths = cfg.indexing?.paths ?? ['./'];
  const watchPaths = indexPaths.map((p) => path.resolve(projectDir, p));
  const debounceMs = cfg.watcher?.debounce ?? 1000;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const limit = pLimit(CONCURRENT_REINDEX_LIMIT);

  const stats = {
    filesWatched: 0,
    changesProcessed: 0,
    errors: 0,
    startTime: Date.now(),
  };

  function shouldIgnore(filePath: string): boolean {
    const rel = path.relative(projectDir, filePath);
    return exclude.some((pattern) => minimatch(rel, pattern, { dot: true }));
  }

  if (opts.dryRun) {
    console.log(chalk.bold('\nDry run - showing what would be watched:\n'));
    console.log(chalk.dim(`  Project: ${projectName}`));
    console.log(chalk.dim(`  Group: ${group}`));
    console.log(chalk.dim(`  Paths: ${watchPaths.join(', ')}`));
    console.log(chalk.dim(`  Exclude patterns:`));
    exclude.forEach((pattern) => {
      console.log(chalk.dim(`    - ${pattern}`));
    });

    let totalFiles = 0;
    for (const watchPath of watchPaths) {
      const files = globSync('**/*', {
        cwd: watchPath,
        ignore: exclude,
        nodir: true,
      });
      totalFiles += files.length;
    }
    console.log(chalk.dim(`\n  Total files: ${totalFiles}`));
    return async () => {};
  }

  // Validate server before starting
  if (!opts.json) {
    console.log(chalk.dim('Checking server connection...'));
  }
  try {
    const res = await client.health({ timeout: 5000 });
    if (res.status !== 200) {
      throw new Error('Server not healthy');
    }
    if (!opts.json) {
      console.log(chalk.green('✓ Server connected'));
    }
  } catch (err) {
    throw new Error(
      `Cannot connect to server at ${opts.server ?? 'http://localhost:9876'}\n` +
        `Make sure the server is running: docker compose up -d`,
      { cause: err }
    );
  }

  function emitEvent(type: string, file: string, extra?: Record<string, unknown>): void {
    if (opts.json) {
      console.log(
        JSON.stringify({
          type,
          file: path.relative(projectDir, file),
          timestamp: new Date().toISOString(),
          ...extra,
        })
      );
    }
  }

  async function reindexWithRetry(filePath: string): Promise<void> {
    const rel = path.relative(projectDir, filePath);
    const start = opts.verbose ? Date.now() : 0;
    let content: string;
    try {
      const buffer = await fs.promises.readFile(filePath);
      if (buffer.includes(0)) return; // Skip binary
      content = buffer.toString('utf8');
      if (content.includes('\uFFFD')) return; // Invalid UTF-8
    } catch (err) {
      if (opts.json) {
        emitEvent('error', filePath, { error: (err as Error).message });
      } else {
        console.error(chalk.red(`  failed to read ${rel}: ${(err as Error).message}`));
      }
      stats.errors++;
      return;
    }
    const language = getLanguageFromPath(filePath);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.fileChanged(group, projectName, rel, content, { language });
        stats.changesProcessed++;
        const elapsed = opts.verbose ? Date.now() - start : 0;
        if (opts.json) {
          emitEvent('reindexed', filePath, { elapsed, attempt });
        } else {
          console.log(
            chalk.dim(opts.verbose ? `  reindexed: ${rel} (${elapsed}ms)` : `  reindexed: ${rel}`)
          );
        }
        return;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          stats.errors++;
          if (opts.json) {
            emitEvent('error', filePath, { error: (err as Error).message, attempt });
          } else {
            console.error(chalk.red(`  failed after ${MAX_RETRIES} attempts: ${rel}`));
          }
        } else if (opts.verbose && !opts.json) {
          console.log(chalk.yellow(`  retry ${attempt}/${MAX_RETRIES}: ${rel}`));
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async function onFileDeleted(filePath: string): Promise<void> {
    if (shouldIgnore(filePath)) return;
    const rel = path.relative(projectDir, filePath);
    try {
      await client.fileDeleted(group, projectName, rel);
      stats.changesProcessed++;
      if (opts.json) {
        emitEvent('removed', filePath);
      } else {
        console.log(chalk.dim(`  removed: ${rel}`));
      }
    } catch (err) {
      stats.errors++;
      if (opts.json) {
        emitEvent('error', filePath, { error: (err as Error).message, action: 'remove' });
      } else {
        console.error(chalk.red(`  failed to remove: ${rel} — ${(err as Error).message}`));
      }
    }
  }

  function onFileChange(filePath: string): void {
    if (shouldIgnore(filePath)) return;

    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);

    pending.set(
      filePath,
      setTimeout(async () => {
        pending.delete(filePath);
        await limit(async () => reindexWithRetry(filePath));
      }, debounceMs)
    );
  }

  if (!opts.json) {
    console.log(chalk.bold(`\nWatching ${projectName} (group: ${group})\n`));
    console.log(chalk.dim(`  Paths: ${watchPaths.join(', ')}`));
    console.log(chalk.dim(`  Debounce: ${debounceMs}ms`));
    console.log(chalk.dim(`  Press Ctrl+C to stop\n`));
  }

  const watcher = createWatch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: cfg.watcher?.stabilityThreshold ?? 1000,
    },
  });

  watcher.on('error', (err: unknown) => {
    stats.errors++;
    const e = err as Error;
    if (opts.json) {
      console.log(
        JSON.stringify({
          type: 'watcher_error',
          error: e.message,
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      console.error(chalk.red(`Watcher error: ${e.message}`));
      if (opts.verbose && e.stack) {
        console.error(chalk.dim(e.stack));
      }
    }
  });

  watcher.on('ready', () => {
    const watched = watcher.getWatched();
    stats.filesWatched = Object.values(watched).reduce((sum, files) => sum + files.length, 0);
    if (!opts.json) {
      console.log(chalk.green(`✓ Watcher ready (${stats.filesWatched} paths)`));
    }
  });

  const configPath = path.join(projectDir, CONFIG_FILE);
  watcher.on('change', (p) => {
    if (p === configPath) {
      if (opts.json) {
        emitEvent('config_changed', configPath, { message: 'Restart watcher to apply' });
      } else {
        console.log(chalk.yellow('\nConfig file changed. Please restart watcher.'));
      }
      return;
    }
    onFileChange(p);
  });
  watcher.on('add', (p) => onFileChange(p));
  watcher.on('unlink', (p) => void limit(() => onFileDeleted(p)));
  watcher.on('addDir', (dirPath) => {
    if (shouldIgnore(dirPath)) return;
    const rel = path.relative(projectDir, dirPath);
    if (opts.json) {
      emitEvent('addDir', dirPath);
    } else if (opts.verbose) {
      console.log(chalk.dim(`  directory added: ${rel}`));
    }
  });
  watcher.on('unlinkDir', (dirPath) => {
    if (shouldIgnore(dirPath)) return;
    const rel = path.relative(projectDir, dirPath);
    if (opts.json) {
      emitEvent('unlinkDir', dirPath);
    } else if (opts.verbose) {
      console.log(chalk.dim(`  directory removed: ${rel}`));
    }
  });

  return async () => {
    watcher.close();
    if (pending.size > 0 && !opts.json) {
      console.log(chalk.dim(`Waiting for ${pending.size} pending changes...`));
    }
    if (pending.size > 0) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (pending.size === 0) {
            clearInterval(check);
            resolve();
          }
        }, 100);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 10_000);
      });
    }
    for (const timeout of pending.values()) {
      clearTimeout(timeout);
    }
    pending.clear();

    if (opts.json) {
      const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
      console.log(
        JSON.stringify({
          type: 'stopped',
          changesProcessed: stats.changesProcessed,
          errors: stats.errors,
          uptimeSeconds: uptime,
          timestamp: new Date().toISOString(),
        })
      );
    } else if (stats.changesProcessed > 0 || stats.errors > 0) {
      const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
      console.log(chalk.dim('\nStats:'));
      console.log(chalk.dim(`  Changes processed: ${stats.changesProcessed}`));
      console.log(chalk.dim(`  Errors: ${stats.errors}`));
      console.log(chalk.dim(`  Uptime: ${formatUptime(uptime)}`));
    }
  };
}

export const watchCommand = new Command('watch')
  .description('Watch for file changes and reindex automatically')
  .option('--server <url>', 'MCP server URL', 'http://localhost:9876')
  .option('-v, --verbose', 'Show detailed output')
  .option('--dry-run', 'Show what would be watched without actually watching')
  .option('--json', 'Output events as JSON lines for piping')
  .action(async (opts: WatchOptions) => {
    try {
      const cleanup = await runWatch(opts);

      process.on('SIGINT', async () => {
        console.log(chalk.dim('\nStopping watcher...'));
        await cleanup();
        console.log(chalk.green('✓ Watcher stopped'));
        process.exit(0);
      });
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
