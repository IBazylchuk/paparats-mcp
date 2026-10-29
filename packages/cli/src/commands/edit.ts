import { Command } from 'commander';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import {
  PAPARATS_HOME,
  COMPOSE_YML,
  PROJECTS_YML,
  resolveProjectsFilePath,
  readProjectsFile,
  readInstallState,
  regenerateCompose,
  regenerateOptsFromState,
  deriveRegenerateOptsFromCompose,
  type ProjectsFile,
} from '../projects-yml.js';
import { authHeaders, localUrls } from '../local-urls.js';
import { getDockerComposeCommand } from './install.js';

export type EditTarget = 'compose' | 'projects';

export interface EditDeps {
  spawnEditor?: (cmd: string, args: string[]) => { status: number };
  exists?: (p: string) => boolean;
  resolveEditor?: (platform: NodeJS.Platform) => { cmd: string; args: string[] };
  regenerateAndRestart?: (paparatsHome?: string) => Promise<{ composeChanged: boolean }>;
  triggerFullReindex?: () => Promise<void>;
  /** `docker compose config` over the edited file: the problem it reports, or null when valid. */
  checkCompose?: (file: string) => string | null;
  restartStack?: (paparatsHome: string) => Promise<void>;
  paparatsHome?: string;
}

export function defaultResolveEditor(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  const visual = process.env['VISUAL'];
  if (visual) return splitCmd(visual);
  const editor = process.env['EDITOR'];
  if (editor) return splitCmd(editor);
  if (platform === 'darwin') return { cmd: 'open', args: ['-t', '-W'] };
  if (platform === 'win32') return { cmd: 'notepad', args: [] };
  return { cmd: 'xdg-open', args: [] };
}

function splitCmd(value: string): { cmd: string; args: string[] } {
  const parts = value.trim().split(/\s+/);
  return { cmd: parts[0]!, args: parts.slice(1) };
}

export interface EditResult {
  edited: boolean;
  validated?: boolean;
  composeChanged?: boolean;
  reindexed?: boolean;
  restarted?: boolean;
}

export async function runEdit(target: EditTarget, deps: EditDeps = {}): Promise<EditResult> {
  const home = deps.paparatsHome ?? PAPARATS_HOME;
  const file =
    target === 'compose'
      ? path.join(home, COMPOSE_YML)
      : (resolveProjectsFilePath(home) ?? path.join(home, PROJECTS_YML));
  const exists = deps.exists ?? fs.existsSync.bind(fs);
  if (!exists(file)) {
    throw new Error(`${file} not found. Run \`paparats install\` first.`);
  }

  const resolveEditor = deps.resolveEditor ?? defaultResolveEditor;
  const editor = resolveEditor(process.platform);
  const spawn =
    deps.spawnEditor ??
    ((cmd, args) => {
      const r = spawnSync(cmd, args, { stdio: 'inherit' });
      return { status: r.status ?? 1 };
    });
  const run = spawn(editor.cmd, [...editor.args, file]);
  if (run.status !== 0) {
    throw new Error(`Editor exited with status ${run.status}`);
  }

  if (target === 'compose') {
    // Check before restarting: `up -d` on a broken file would stop nothing and
    // start nothing, and the stack would keep running the old one unnoticed.
    const problem = (deps.checkCompose ?? defaultCheckCompose)(file);
    if (problem !== null) {
      console.error(chalk.red(`${COMPOSE_YML} is not valid: ${problem}`));
      console.error(
        chalk.dim('The stack keeps running as it was. Fix it with `paparats edit compose`.')
      );
      return { edited: true, validated: false };
    }
    await (deps.restartStack ?? defaultRestartStack)(home);
    console.log(chalk.green('✓ Compose checked and stack restarted'));
    console.log(
      chalk.dim(
        '`paparats add`, `remove`, `edit projects` and `update` regenerate this file and keep ' +
          `the previous one as ${COMPOSE_YML}.bak.`
      )
    );
    return { edited: true, validated: true, restarted: true };
  }

  // target === 'projects' — validate, then regenerate compose + restart + trigger
  let parsed: ProjectsFile;
  try {
    parsed = readProjectsFile(home);
  } catch (err) {
    console.error(chalk.red(`Validation failed: ${(err as Error).message}`));
    console.error(chalk.dim('Project list left as-is, no restart, no reindex.'));
    return { edited: true, validated: false };
  }

  void parsed; // quieten unused-variable warning

  const regenerate = deps.regenerateAndRestart ?? defaultRegenerateAndRestart;
  const { composeChanged } = await regenerate(home);
  if (composeChanged) console.log(chalk.green('✓ Compose regenerated and stack restarted'));

  const triggerFull = deps.triggerFullReindex ?? defaultTriggerFullReindex;
  let reindexed = false;
  try {
    await triggerFull();
    reindexed = true;
    console.log(chalk.dim('Full reindex triggered'));
  } catch (err) {
    console.warn(chalk.yellow(`Reindex trigger failed: ${(err as Error).message}`));
  }

  return { edited: true, validated: true, composeChanged, reindexed };
}

/**
 * Regenerate docker-compose.yml from the edited project list. A compose that
 * changes is backed up to docker-compose.yml.bak first, so hand-edits survive.
 * Returns whether the compose changed; false when there is no compose yet.
 */
export function regenerateComposeAfterEdit(paparatsHome: string = PAPARATS_HOME): boolean {
  const composePath = path.join(paparatsHome, COMPOSE_YML);
  if (!fs.existsSync(composePath)) return false;

  // Prefer install.json — it's the source of truth for embedding provider, embed mode, etc.
  // Fall back to parsing the existing compose for installs that predate install.json.
  const state = readInstallState(paparatsHome);
  const regenerateOpts = state
    ? regenerateOptsFromState(state, paparatsHome)
    : {
        ...deriveRegenerateOptsFromCompose(fs.readFileSync(composePath, 'utf8'), paparatsHome),
        backupOnChange: true,
      };

  const { changed, backupPath } = regenerateCompose(regenerateOpts);
  if (backupPath) {
    console.log(chalk.dim(`Previous compose backed up to ${backupPath}`));
  }
  return changed;
}

async function defaultRegenerateAndRestart(
  paparatsHome: string = PAPARATS_HOME
): Promise<{ composeChanged: boolean }> {
  if (!regenerateComposeAfterEdit(paparatsHome)) return { composeChanged: false };
  const { runRestart } = await import('./lifecycle.js');
  await runRestart({});
  return { composeChanged: true };
}

function defaultCheckCompose(file: string): string | null {
  const [cmd, ...pre] = getDockerComposeCommand().split(' ');
  const r = spawnSync(cmd!, [...pre, '-f', file, 'config', '--quiet'], { encoding: 'utf8' });
  if (r.error) return r.error.message;
  if (r.status === 0) return null;
  return (r.stderr || r.stdout || `exit status ${r.status}`).trim();
}

async function defaultRestartStack(paparatsHome: string): Promise<void> {
  const { runRestart } = await import('./lifecycle.js');
  await runRestart({ paparatsHome });
}

async function defaultTriggerFullReindex(): Promise<void> {
  const url = localUrls().indexer;
  const res = await fetch(`${url}/trigger`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`Indexer ${url} returned ${res.status}`);
}

export const editCommand = new Command('edit')
  .description('Open ~/.paparats/docker-compose.yml or projects.yml in $EDITOR')
  .argument('<target>', 'compose | projects')
  .action(async (target: string) => {
    if (target !== 'compose' && target !== 'projects') {
      console.error(chalk.red(`Unknown target: ${target}. Use 'compose' or 'projects'.`));
      process.exit(2);
    }
    try {
      await runEdit(target);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(2);
    }
  });
