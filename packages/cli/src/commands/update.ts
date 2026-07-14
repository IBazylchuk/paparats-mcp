import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { getDockerComposeCommand } from './install.js';
import { waitForHealth } from './install.js';
import {
  readInstallState,
  regenerateCompose,
  type RegenerateOptions,
  type RegenerateResult,
} from '../projects-yml.js';

const PAPARATS_HOME = path.join(os.homedir(), '.paparats');
const COMPOSE_FILE = path.join(PAPARATS_HOME, 'docker-compose.yml');
const NPM_PACKAGE = '@paparats/cli';

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
  readFileSync?: (path: string, encoding: BufferEncoding) => string;
  readInstallState?: typeof readInstallState;
  regenerateCompose?: (opts: RegenerateOptions) => RegenerateResult;
}

/** Check if a service is defined in the compose file */
function composeHasService(composeContent: string, service: string): boolean {
  // Simple YAML check: service name at indent level 2 under services
  const pattern = new RegExp(`^  ${service}:`, 'm');
  return pattern.test(composeContent);
}

export async function runUpdate(opts: UpdateOptions, deps?: UpdateDeps): Promise<void> {
  const exec = deps?.execSync ?? execSync;
  const getCompose = deps?.getDockerComposeCommand ?? getDockerComposeCommand;
  const waitHealth = deps?.waitForHealth ?? waitForHealth;
  const exists = deps?.existsSync ?? fs.existsSync.bind(fs);
  const readFile = deps?.readFileSync ?? fs.readFileSync.bind(fs);
  const readInstall = deps?.readInstallState ?? readInstallState;
  const regenerate = deps?.regenerateCompose ?? regenerateCompose;

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
      // Regenerate compose from install.json + projects.yml so any new service
      // fields shipped with this CLI version land in the on-disk file. Without
      // this, `docker compose up -d` runs against the previous template and
      // can collide on container names or miss new env/volume settings.
      const regenSpinner = ora('Refreshing docker-compose.yml...').start();
      const state = readInstall(PAPARATS_HOME);
      if (!state) {
        regenSpinner.warn(
          `install.json missing — skipping compose refresh. Run \`paparats install\` to record install settings.`
        );
      } else {
        try {
          const result = regenerate({
            embedMode: state.embedMode,
            ...(state.embedUrl !== undefined ? { embedUrl: state.embedUrl } : {}),
            ...(state.embeddingProvider !== undefined
              ? { embeddingProvider: state.embeddingProvider }
              : {}),
            ...(state.qdrantUrl !== undefined ? { qdrantUrl: state.qdrantUrl } : {}),
            ...(state.qdrantApiKey !== undefined ? { qdrantApiKey: state.qdrantApiKey } : {}),
            ...(state.cron !== undefined ? { cron: state.cron } : {}),
            paparatsHome: PAPARATS_HOME,
            backupOnChange: true,
          });
          if (result.changed) {
            regenSpinner.succeed('docker-compose.yml refreshed');
            if (result.backupPath) {
              console.log(
                chalk.dim(
                  `  Previous compose backed up to ${result.backupPath} (hand-edits, if any, are preserved there).`
                )
              );
            }
          } else {
            regenSpinner.succeed('docker-compose.yml already up to date');
          }
        } catch (err) {
          regenSpinner.fail('Failed to refresh docker-compose.yml');
          throw err;
        }
      }

      const composeContent = readFile(COMPOSE_FILE, 'utf8');
      const hasQdrant = composeHasService(composeContent, 'qdrant');
      const composeCmd = getCompose();
      const composeArg = `-f "${COMPOSE_FILE}"`;

      const pullSpinner = ora('Pulling latest Docker images...').start();
      try {
        exec(`${composeCmd} ${composeArg} pull`, {
          stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          timeout: 300_000,
        });
        pullSpinner.succeed('Docker images pulled');
      } catch (err) {
        pullSpinner.fail('Failed to pull Docker images');
        throw err;
      }

      const upSpinner = ora('Restarting Docker containers...').start();
      try {
        exec(`${composeCmd} ${composeArg} up -d --remove-orphans`, {
          stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          timeout: 120_000,
        });
        upSpinner.succeed('Docker containers restarted');
      } catch (err) {
        upSpinner.fail('Failed to restart Docker containers');
        throw err;
      }

      if (hasQdrant) {
        const qdrantReady = await waitHealth('http://localhost:6333/healthz', 'Qdrant');
        if (!qdrantReady) throw new Error('Qdrant failed to start');
      }

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
