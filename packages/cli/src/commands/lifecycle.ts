import { Command } from 'commander';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { PAPARATS_HOME, COMPOSE_YML } from '../projects-yml.js';
import { getDockerComposeCommand } from './install.js';

export interface LifecycleDeps {
  composeCmd?: () => string;
  exists?: (p: string) => boolean;
  runCommand?: (cmd: string) => void;
  paparatsHome?: string;
}

function composePath(home: string): string {
  return path.join(home, COMPOSE_YML);
}

function ensureCompose(home: string, exists: (p: string) => boolean): string {
  const file = composePath(home);
  if (!exists(file)) {
    throw new Error(`${file} not found. Run \`paparats install\` first to bootstrap the stack.`);
  }
  return file;
}

const defaultRunCommand = (cmd: string): void => {
  execSync(cmd, { stdio: 'inherit', timeout: 180_000 });
};

export interface StartOptions {
  logs?: boolean;
}

export async function runStart(opts: StartOptions = {}, deps: LifecycleDeps = {}): Promise<void> {
  const home = deps.paparatsHome ?? PAPARATS_HOME;
  const exists = deps.exists ?? fs.existsSync.bind(fs);
  const file = ensureCompose(home, exists);
  const cmd = (deps.composeCmd ?? getDockerComposeCommand)();
  const run = deps.runCommand ?? defaultRunCommand;
  run(`${cmd} -f "${file}" up -d`);
  if (opts.logs) {
    spawn(cmd.split(' ')[0]!, [...cmd.split(' ').slice(1), '-f', file, 'logs', '-f'], {
      stdio: 'inherit',
    });
  }
}

export async function runStop(deps: LifecycleDeps = {}): Promise<void> {
  const home = deps.paparatsHome ?? PAPARATS_HOME;
  const exists = deps.exists ?? fs.existsSync.bind(fs);
  const file = ensureCompose(home, exists);
  const cmd = (deps.composeCmd ?? getDockerComposeCommand)();
  const run = deps.runCommand ?? defaultRunCommand;
  run(`${cmd} -f "${file}" down`);
}

export async function runRestart(deps: LifecycleDeps = {}): Promise<void> {
  // Use `up -d` rather than `restart`: applies new bind-mounts/services
  // after `paparats add` of a local path, or after edit projects.
  const home = deps.paparatsHome ?? PAPARATS_HOME;
  const exists = deps.exists ?? fs.existsSync.bind(fs);
  const file = ensureCompose(home, exists);
  const cmd = (deps.composeCmd ?? getDockerComposeCommand)();
  const run = deps.runCommand ?? defaultRunCommand;
  run(`${cmd} -f "${file}" up -d`);
}

export const startCommand = new Command('start')
  .description('Start the Paparats Docker stack')
  .option('--logs', 'Follow logs after starting')
  .action(async (opts: StartOptions) => {
    try {
      await runStart(opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

export const stopCommand = new Command('stop')
  .description('Stop the Paparats Docker stack (preserves volumes)')
  .action(async () => {
    try {
      await runStop();
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

export const restartCommand = new Command('restart')
  .description('Recreate the stack with the current docker-compose.yml (applies new mounts)')
  .action(async () => {
    try {
      await runRestart();
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
