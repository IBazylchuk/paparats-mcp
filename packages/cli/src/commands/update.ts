import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { getDockerComposeCommand } from './install.js';
import { waitForHealth } from './install.js';

const PAPARATS_HOME = path.join(os.homedir(), '.paparats');
const COMPOSE_FILE = path.join(PAPARATS_HOME, 'docker-compose.yml');
const NPM_PACKAGE = 'paparats-mcp';

export interface UpdateOptions {
  skipCli?: boolean;
  skipDocker?: boolean;
  verbose?: boolean;
}

export interface UpdateDeps {
  execSync?: (cmd: string, opts?: { stdio?: unknown; timeout?: number }) => void;
  getDockerComposeCommand?: () => string;
  waitForHealth?: (url: string, label: string) => Promise<boolean>;
  existsSync?: (path: string) => boolean;
}

export async function runUpdate(opts: UpdateOptions, deps?: UpdateDeps): Promise<void> {
  const exec = deps?.execSync ?? execSync;
  const getCompose = deps?.getDockerComposeCommand ?? getDockerComposeCommand;
  const waitHealth = deps?.waitForHealth ?? waitForHealth;
  const exists = deps?.existsSync ?? fs.existsSync.bind(fs);

  console.log(chalk.bold('\npaparats update\n'));

  if (!opts.skipCli) {
    const spinner = ora(`Updating CLI from npm (${NPM_PACKAGE}@latest)...`).start();
    try {
      exec(`npm install -g ${NPM_PACKAGE}@latest`, {
        stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      spinner.succeed('CLI updated');
    } catch (err) {
      spinner.fail('Failed to update CLI');
      const msg = (err as Error).message;
      if (msg.includes('404') || msg.includes('not found')) {
        console.log(
          chalk.dim(`  Package not yet published to npm. Run without --skip-cli after publish.`)
        );
      } else {
        throw err;
      }
    }
  }

  if (!opts.skipDocker) {
    if (!exists(COMPOSE_FILE)) {
      console.log(chalk.yellow(`  Docker compose not found at ${COMPOSE_FILE}`));
      console.log(chalk.dim('  Run `paparats install` first to set up Docker.'));
    } else {
      const composeCmd = getCompose();
      const composeArg = `-f "${COMPOSE_FILE}"`;

      const pullSpinner = ora('Pulling latest server image...').start();
      try {
        exec(`${composeCmd} ${composeArg} pull`, {
          stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          timeout: 300_000,
        });
        pullSpinner.succeed('Server image pulled');
      } catch (err) {
        pullSpinner.fail('Failed to pull server image');
        throw err;
      }

      const upSpinner = ora('Restarting Docker containers...').start();
      try {
        exec(`${composeCmd} ${composeArg} up -d`, {
          stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
        upSpinner.succeed('Docker containers restarted');
      } catch (err) {
        upSpinner.fail('Failed to restart Docker containers');
        throw err;
      }

      const qdrantReady = await waitHealth('http://localhost:6333/healthz', 'Qdrant');
      if (!qdrantReady) throw new Error('Qdrant failed to start');

      const mcpReady = await waitHealth('http://localhost:9876/health', 'MCP server');
      if (!mcpReady) throw new Error('MCP server failed to start');
    }
  }

  console.log(chalk.bold.green('\n✓ Update complete!\n'));
}

export const updateCommand = new Command('update')
  .description('Update CLI from npm and pull/restart latest server Docker image')
  .option('--skip-cli', 'Skip CLI update (only update Docker)')
  .option('--skip-docker', 'Skip Docker update (only update CLI)')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: UpdateOptions) => {
    try {
      await runUpdate(opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
