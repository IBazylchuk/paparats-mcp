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
  type ProjectsFile,
} from '../projects-yml.js';

export type EditTarget = 'compose' | 'projects';

export interface EditDeps {
  spawnEditor?: (cmd: string, args: string[]) => { status: number };
  exists?: (p: string) => boolean;
  resolveEditor?: (platform: NodeJS.Platform) => { cmd: string; args: string[] };
  regenerateAndRestart?: (paparatsHome?: string) => Promise<{ composeChanged: boolean }>;
  triggerFullReindex?: () => Promise<void>;
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
    console.log(chalk.dim('Run `paparats restart` to apply compose changes.'));
    return { edited: true };
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

async function defaultRegenerateAndRestart(
  paparatsHome: string = PAPARATS_HOME
): Promise<{ composeChanged: boolean }> {
  // Lazy import to avoid pulling install.ts (and its deps) in non-edit code paths.
  const { regenerateCompose, readInstallState, deriveRegenerateOptsFromCompose } =
    await import('../projects-yml.js');
  const composePath = path.join(paparatsHome, COMPOSE_YML);
  if (!fs.existsSync(composePath)) {
    return { composeChanged: false };
  }

  // Prefer install.json — it's the source of truth for embedding provider, embed mode, etc.
  // Fall back to parsing the existing compose for installs that predate install.json.
  const state = readInstallState(paparatsHome);
  let regenerateOpts: Parameters<typeof regenerateCompose>[0];
  if (state) {
    regenerateOpts = {
      embedMode: state.embedMode,
      ...(state.embedUrl !== undefined ? { embedUrl: state.embedUrl } : {}),
      ...(state.embeddingProvider !== undefined
        ? { embeddingProvider: state.embeddingProvider }
        : {}),
      ...(state.qdrantUrl !== undefined ? { qdrantUrl: state.qdrantUrl } : {}),
      ...(state.qdrantApiKey !== undefined ? { qdrantApiKey: state.qdrantApiKey } : {}),
      ...(state.cron !== undefined ? { cron: state.cron } : {}),
      paparatsHome,
    };
  } else {
    regenerateOpts = deriveRegenerateOptsFromCompose(
      fs.readFileSync(composePath, 'utf8'),
      paparatsHome
    );
  }

  const { changed } = regenerateCompose(regenerateOpts);
  if (!changed) return { composeChanged: false };

  const { runRestart } = await import('./lifecycle.js');
  await runRestart({});
  return { composeChanged: true };
}

async function defaultTriggerFullReindex(): Promise<void> {
  const url = process.env['PAPARATS_INDEXER_URL'] ?? 'http://localhost:9877';
  const res = await fetch(`${url}/trigger`, { method: 'POST' });
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
