import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import {
  PAPARATS_HOME,
  COMPOSE_YML,
  PROJECTS_YML,
  readProjectsFile,
  writeProjectsFile,
  readInstallState,
  regenerateCompose,
  resolveEntryGroup,
  resolveProjectName,
  type ProjectEntry,
} from '../projects-yml.js';

const SERVER_BASE = process.env['PAPARATS_SERVER_URL'] ?? 'http://localhost:9876';
const INDEXER_BASE = process.env['PAPARATS_INDEXER_URL'] ?? 'http://localhost:9877';

// ── add ─────────────────────────────────────────────────────────────────────

export interface AddOptions {
  name?: string;
  group?: string;
  language?: string;
  noReindex?: boolean;
  noRestart?: boolean;
  /** Drop the existing chunks for this project before reindex (force fresh payload). */
  force?: boolean;
  nonInteractive?: boolean;
  paparatsHome?: string;
}

export type AddResult =
  | { kind: 'local'; entry: ProjectEntry; restarted: boolean; reindexed: boolean }
  | { kind: 'remote'; entry: ProjectEntry; reindexed: boolean };

export interface AddDeps {
  triggerReindex?: (name: string, opts?: { force?: boolean }) => Promise<void>;
  restartStack?: () => Promise<void>;
  pathExists?: (p: string) => boolean;
  isDirectory?: (p: string) => boolean;
}

const REPO_URL_RE = /^(git@|https?:\/\/).+\.git$/;
const REPO_SHORTHAND_RE = /^[^/]+\/[^/]+$/;

export function detectKind(input: string): 'local' | 'remote' {
  if (REPO_URL_RE.test(input)) return 'remote';
  if (REPO_SHORTHAND_RE.test(input)) return 'remote';
  return 'local';
}

function shorthandFromUrl(url: string): string {
  // Convert "git@github.com:org/repo.git" or "https://github.com/org/repo.git" -> "org/repo".
  const noGit = url.replace(/\.git$/, '');
  const matchSsh = noGit.match(/^git@[^:]+:(.+)$/);
  if (matchSsh) return matchSsh[1]!;
  const matchHttps = noGit.match(/^https?:\/\/[^/]+\/(.+)$/);
  if (matchHttps) return matchHttps[1]!;
  return noGit;
}

export async function runAdd(
  argument: string,
  opts: AddOptions = {},
  deps: AddDeps = {}
): Promise<AddResult> {
  const home = opts.paparatsHome ?? PAPARATS_HOME;
  const pathExists = deps.pathExists ?? fs.existsSync.bind(fs);
  const isDirectory = deps.isDirectory ?? ((p: string) => fs.statSync(p).isDirectory());

  const kind = detectKind(argument);
  const file = readProjectsFile(home);

  let entry: ProjectEntry;
  if (kind === 'local') {
    if (!path.isAbsolute(argument)) {
      throw new Error(`Local path must be absolute: ${argument}`);
    }
    if (!pathExists(argument)) {
      throw new Error(`Local path does not exist: ${argument}`);
    }
    if (!isDirectory(argument)) {
      throw new Error(`Local path is not a directory: ${argument}`);
    }
    entry = { path: argument };
  } else {
    const url = REPO_URL_RE.test(argument) ? shorthandFromUrl(argument) : argument;
    entry = { url };
  }

  if (opts.name) entry.name = opts.name;
  const name = resolveProjectName(entry);
  // Only persist `group` when explicitly provided. Omitting it lets the
  // entry inherit `defaults.group` from projects.yml (or DEFAULT_GROUP),
  // which preserves the multi-project-per-group model.
  if (opts.group) entry.group = opts.group;
  if (opts.language) entry.language = opts.language;

  const dup = file.repos.find((r) => resolveProjectName(r) === name);
  if (dup) {
    throw new Error(
      `Project "${name}" already exists. Pass --name to override, or use \`paparats remove ${name}\` first.`
    );
  }

  file.repos.push(entry);
  writeProjectsFile(file, home);
  console.log(chalk.green(`✓ Added ${kind} project "${name}"`));

  // For local projects we add a new bind-mount in compose.yml — regenerate it
  // so the next `restart` actually exposes /projects/<name> inside the indexer.
  // Remote projects don't need new mounts (cloned into the indexer_repos volume).
  let composeChanged = false;
  if (kind === 'local') {
    const state = readInstallState(home);
    if (!state) {
      console.warn(
        chalk.yellow(
          `  Skipping compose regeneration: ${home}/install.json missing. Run \`paparats install\` once to record install settings.`
        )
      );
    } else {
      const result = regenerateCompose({
        ollamaMode: state.ollamaMode,
        ...(state.ollamaUrl !== undefined ? { ollamaUrl: state.ollamaUrl } : {}),
        ...(state.qdrantUrl !== undefined ? { qdrantUrl: state.qdrantUrl } : {}),
        ...(state.qdrantApiKey !== undefined ? { qdrantApiKey: state.qdrantApiKey } : {}),
        ...(state.cron !== undefined ? { cron: state.cron } : {}),
        paparatsHome: home,
      });
      composeChanged = result.changed;
    }
  }

  let restarted = false;
  if (kind === 'local' && !opts.noRestart && composeChanged) {
    const restart = deps.restartStack ?? defaultRestart;
    await restart();
    restarted = true;
  }

  let reindexed = false;
  if (!opts.noReindex) {
    const trigger = deps.triggerReindex ?? defaultTriggerReindex;
    try {
      if (opts.force) {
        await trigger(name, { force: true });
      } else {
        await trigger(name);
      }
      reindexed = true;
      console.log(chalk.dim(`  Reindex triggered for "${name}"${opts.force ? ' (force)' : ''}`));
    } catch (err) {
      console.warn(
        chalk.yellow(
          `  Reindex trigger failed: ${(err as Error).message}. Run \`paparats list\` later.`
        )
      );
    }
  }

  return kind === 'local' ? { kind, entry, restarted, reindexed } : { kind, entry, reindexed };
}

async function defaultTriggerReindex(name: string, opts?: { force?: boolean }): Promise<void> {
  const body: { repos: string[]; force?: boolean } = { repos: [name] };
  if (opts?.force) body.force = true;
  const res = await fetch(`${INDEXER_BASE}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Indexer ${INDEXER_BASE} returned ${res.status}`);
}

async function defaultRestart(): Promise<void> {
  const { runRestart } = await import('./lifecycle.js');
  await runRestart({});
}

// ── list ────────────────────────────────────────────────────────────────────

export interface ListOptions {
  json?: boolean;
  group?: string;
  paparatsHome?: string;
}

interface IndexerHealth {
  repos: Array<{
    repo: string;
    status?: string;
    lastRun?: string;
    chunksIndexed?: number;
    lastError?: string;
  }>;
}

export interface ListDeps {
  fetchHealth?: () => Promise<IndexerHealth | null>;
}

export interface ListedProject {
  name: string;
  source: string;
  kind: 'local' | 'remote';
  group: string;
  status: string;
  chunks: number | null;
  lastRun: string | null;
}

export async function runList(
  opts: ListOptions = {},
  deps: ListDeps = {}
): Promise<ListedProject[]> {
  const home = opts.paparatsHome ?? PAPARATS_HOME;
  const file = readProjectsFile(home);
  const fetchHealth = deps.fetchHealth ?? defaultFetchHealth;
  const health = await fetchHealth().catch(() => null);
  const healthByName = new Map<string, IndexerHealth['repos'][number]>();
  for (const r of health?.repos ?? []) healthByName.set(r.repo, r);

  const rows: ListedProject[] = [];
  for (const entry of file.repos) {
    const name = resolveProjectName(entry);
    const group = resolveEntryGroup(entry, file);
    if (opts.group && group !== opts.group) continue;
    const kind: 'local' | 'remote' = entry.path ? 'local' : 'remote';
    const source = entry.path ?? entry.url ?? '';
    const h = healthByName.get(name);
    rows.push({
      name,
      source,
      kind,
      group,
      status: h?.status ?? '?',
      chunks: typeof h?.chunksIndexed === 'number' ? h.chunksIndexed : null,
      lastRun: h?.lastRun ?? null,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
  }
  return rows;
}

function printTable(rows: ListedProject[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim('No projects configured. Add one: paparats add <path-or-repo>'));
    return;
  }
  const cols = ['name', 'source', 'group', 'status', 'chunks', 'lastRun'] as const;
  const labels: Record<(typeof cols)[number], string> = {
    name: 'NAME',
    source: 'SOURCE',
    group: 'GROUP',
    status: 'STATUS',
    chunks: 'CHUNKS',
    lastRun: 'LAST RUN',
  };
  const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const display = rows.map((r) => ({
    name: r.name,
    source: truncate(r.source, 40),
    group: r.group,
    status: r.status,
    chunks: r.chunks === null ? '-' : String(r.chunks),
    lastRun: r.lastRun ?? '-',
  }));

  const widths: Record<(typeof cols)[number], number> = {
    name: labels.name.length,
    source: labels.source.length,
    group: labels.group.length,
    status: labels.status.length,
    chunks: labels.chunks.length,
    lastRun: labels.lastRun.length,
  };
  for (const row of display) {
    for (const c of cols) widths[c] = Math.max(widths[c], row[c].length);
  }
  const fmt = (vals: Record<(typeof cols)[number], string>): string =>
    cols.map((c) => vals[c].padEnd(widths[c])).join('  ');
  console.log(chalk.bold(fmt(labels)));
  for (const row of display) console.log(fmt(row));
}

async function defaultFetchHealth(): Promise<IndexerHealth | null> {
  const res = await fetch(`${INDEXER_BASE}/health`).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json()) as IndexerHealth;
}

// ── remove ──────────────────────────────────────────────────────────────────

export interface RemoveOptions {
  yes?: boolean;
  paparatsHome?: string;
}

export interface RemoveDeps {
  promptConfirm?: (msg: string) => Promise<boolean>;
  deleteServerData?: (group: string, name: string) => Promise<void>;
  restartStack?: () => Promise<void>;
}

export interface RemoveResult {
  removed: boolean;
  kind?: 'local' | 'remote';
  serverDeleteOk: boolean;
  restarted: boolean;
}

export async function runRemove(
  name: string,
  opts: RemoveOptions = {},
  deps: RemoveDeps = {}
): Promise<RemoveResult> {
  const home = opts.paparatsHome ?? PAPARATS_HOME;
  const file = readProjectsFile(home);
  const idx = file.repos.findIndex((r) => resolveProjectName(r) === name);
  if (idx < 0) {
    throw new Error(`Project "${name}" not found in ${path.join(home, PROJECTS_YML)}`);
  }
  const entry = file.repos[idx]!;
  const group = resolveEntryGroup(entry, file);
  const kind: 'local' | 'remote' = entry.path ? 'local' : 'remote';

  if (!opts.yes) {
    const promptConfirm =
      deps.promptConfirm ?? ((msg: string) => confirm({ message: msg, default: false }));
    const proceed = await promptConfirm(
      `Remove "${name}" (group=${group})? This deletes Qdrant chunks + SQLite metadata.`
    );
    if (!proceed) {
      console.log(chalk.dim('Cancelled.'));
      return { removed: false, kind, serverDeleteOk: false, restarted: false };
    }
  }

  let serverDeleteOk = false;
  const deleteServer = deps.deleteServerData ?? defaultDeleteServerData;
  try {
    await deleteServer(group, name);
    serverDeleteOk = true;
  } catch (err) {
    console.warn(
      chalk.yellow(
        `  Server delete failed: ${(err as Error).message}. Removing from project list anyway.`
      )
    );
  }

  file.repos.splice(idx, 1);
  writeProjectsFile(file, home);
  console.log(chalk.green(`✓ Removed "${name}" from project list`));

  // Drop the bind-mount from compose.yml so the next restart no longer
  // exposes /projects/<name> inside the indexer (mirrors `runAdd`).
  let composeChanged = false;
  if (kind === 'local') {
    const state = readInstallState(home);
    if (state) {
      const result = regenerateCompose({
        ollamaMode: state.ollamaMode,
        ...(state.ollamaUrl !== undefined ? { ollamaUrl: state.ollamaUrl } : {}),
        ...(state.qdrantUrl !== undefined ? { qdrantUrl: state.qdrantUrl } : {}),
        ...(state.qdrantApiKey !== undefined ? { qdrantApiKey: state.qdrantApiKey } : {}),
        ...(state.cron !== undefined ? { cron: state.cron } : {}),
        paparatsHome: home,
      });
      composeChanged = result.changed;
    }
  }

  let restarted = false;
  if (kind === 'local' && composeChanged) {
    const restart = deps.restartStack ?? defaultRestart;
    await restart();
    restarted = true;
  }

  return { removed: true, kind, serverDeleteOk, restarted };
}

async function defaultDeleteServerData(group: string, name: string): Promise<void> {
  const url = `${SERVER_BASE}/api/project/${encodeURIComponent(group)}/${encodeURIComponent(name)}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
}

// ── Commands ────────────────────────────────────────────────────────────────

export const addCommand = new Command('add')
  .description('Add a project (local path or git URL/shorthand) to the index')
  .argument(
    '<path-or-repo>',
    'Absolute local path, or git URL (git@.../foo.git, https://.../foo.git, owner/repo)'
  )
  .option('--name <name>', 'Project name override')
  .option(
    '--group <group>',
    'Qdrant collection bucket. Multiple projects in the same group share one collection. Defaults to projects.yml `defaults.group` or "default".'
  )
  .option('--language <lang>', 'Language override')
  .option('--no-reindex', 'Skip the per-project reindex trigger')
  .option('--no-restart', 'Skip the docker compose restart for local-path adds')
  .option('--force', 'Drop existing chunks for this project before reindex')
  .option('--non-interactive', 'No prompts')
  .action(async (argument: string, opts: AddOptions) => {
    try {
      await runAdd(argument, opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });

export const listCommand = new Command('list')
  .description('List configured projects with indexer status')
  .option('--json', 'Output as JSON')
  .option('--group <group>', 'Filter to one group')
  .action(async (opts: ListOptions) => {
    try {
      await runList(opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

export const removeCommand = new Command('remove')
  .description('Remove a project from the index (deletes Qdrant + SQLite data)')
  .argument('<name>', 'Project name')
  .option('--yes', 'Skip confirmation')
  .action(async (name: string, opts: RemoveOptions) => {
    try {
      await runRemove(name, opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });

// re-export so lifecycle import survives Vitest type checks
export { COMPOSE_YML };
