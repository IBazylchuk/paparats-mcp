import { Command } from 'commander';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import { findConfigDir, readConfig, CONFIG_FILE } from '../config.js';
import { ApiClient } from '../api-client.js';
import { createTimeoutSignal } from '../abort.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  details?: string;
}

function commandExists(cmd: string): boolean {
  try {
    const command = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(command, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function checkDockerCompose(): boolean {
  if (commandExists('docker-compose')) return true;
  if (commandExists('docker')) {
    try {
      execSync('docker compose version', { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function runChecks(
  serverUrl: string,
  onCheckStart?: (name: string) => void,
  verbose?: boolean
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Resolve config for URLs/models
  const qdrantUrl = process.env.QDRANT_URL ?? 'http://localhost:6333';
  const embedUrl = process.env.EMBED_URL ?? 'http://localhost:18434';
  let embedModel = process.env.EMBEDDING_MODEL ?? 'jina-code-embeddings';

  const configDir = findConfigDir();
  if (configDir) {
    try {
      const { config } = readConfig(configDir);
      embedModel = config.embeddings?.model ?? embedModel;
    } catch {
      // Config invalid, use defaults
    }
  }

  // 1. Config (instant)
  onCheckStart?.('Config');
  if (configDir) {
    try {
      readConfig(configDir);
      results.push({ name: CONFIG_FILE, ok: true, message: `found in ${configDir}` });
    } catch (err) {
      results.push({
        name: CONFIG_FILE,
        ok: false,
        message: (err as Error).message,
        details: verbose ? (err as Error).stack : undefined,
      });
    }
  } else {
    results.push({
      name: CONFIG_FILE,
      ok: false,
      message: 'not found in current directory or parents',
    });
  }

  // 2. Install (instant)
  onCheckStart?.('Install');
  const paparatsHome = path.join(os.homedir(), '.paparats');
  const composePath = path.join(paparatsHome, 'docker-compose.yml');
  if (fs.existsSync(composePath)) {
    results.push({ name: 'Install', ok: true, message: `${composePath} exists` });
  } else {
    results.push({
      name: 'Install',
      ok: false,
      message: `${composePath} missing — run \`paparats install\``,
    });
  }

  // 3. Docker
  onCheckStart?.('Docker');
  if (commandExists('docker')) {
    try {
      execSync('docker version', { stdio: 'ignore', timeout: 3_000 });
      results.push({ name: 'Docker', ok: true, message: 'installed and running' });
    } catch {
      results.push({ name: 'Docker', ok: false, message: 'installed but not running' });
    }
  } else {
    results.push({ name: 'Docker', ok: false, message: 'not installed' });
  }

  // 4. Docker Compose
  onCheckStart?.('Docker Compose');
  if (checkDockerCompose()) {
    results.push({ name: 'Docker Compose', ok: true, message: 'installed' });
  } else {
    results.push({
      name: 'Docker Compose',
      ok: false,
      message: 'not installed — run `docker compose version` to verify',
    });
  }

  // 5. Embeddings
  onCheckStart?.('Embeddings');
  try {
    const embedHealthUrl = new URL('/health', embedUrl).href;
    const healthRes = await fetch(embedHealthUrl, {
      signal: createTimeoutSignal(3000),
    });

    if (healthRes.ok) {
      let modelListed = false;
      try {
        const modelsUrl = new URL('/v1/models', embedUrl).href;
        const modelsRes = await fetch(modelsUrl, {
          signal: createTimeoutSignal(3000),
        });
        if (modelsRes.ok) {
          const data = (await modelsRes.json()) as { data?: Array<{ id: string }> };
          const models = data.data ?? [];
          modelListed = models.some((m) => m.id === embedModel);
        }
      } catch {
        // /v1/models unavailable — treat as lazy-loaded, not an error
      }

      if (modelListed) {
        results.push({ name: 'Embeddings', ok: true, message: `model ${embedModel} ready` });
      } else {
        // llama-swap lazy-loads models; a model not yet listed is not an error
        results.push({
          name: 'Embeddings',
          ok: true,
          message: `running (model ${embedModel} loads on first use)`,
        });
      }
    } else {
      results.push({
        name: 'Embeddings',
        ok: false,
        message: 'embed server not reachable at ' + embedUrl,
      });
    }
  } catch (err) {
    results.push({
      name: 'Embeddings',
      ok: false,
      message: 'embed server not reachable at ' + embedUrl,
      details: verbose ? (err as Error).message : undefined,
    });
  }

  // 6. Qdrant
  onCheckStart?.('Qdrant');
  try {
    const qdrantHealthUrl = new URL('/healthz', qdrantUrl).href;
    const res = await fetch(qdrantHealthUrl, {
      signal: createTimeoutSignal(3000),
    });
    results.push({
      name: 'Qdrant',
      ok: res.ok,
      message: res.ok ? `reachable at ${qdrantUrl}` : `status ${res.status}`,
    });
  } catch {
    results.push({
      name: 'Qdrant',
      ok: false,
      message: `unreachable at ${qdrantUrl}`,
    });
  }

  // 7. MCP Server
  onCheckStart?.('MCP Server');
  const client = new ApiClient(serverUrl);
  try {
    const res = await client.health({ timeout: 5000 });
    if (res.status === 200) {
      results.push({ name: 'MCP Server', ok: true, message: 'reachable and healthy' });
    } else {
      results.push({ name: 'MCP Server', ok: false, message: `status ${res.status}` });
    }
  } catch {
    results.push({
      name: 'MCP Server',
      ok: false,
      message: `unreachable at ${serverUrl}`,
    });
  }

  return results;
}

export const doctorCommand = new Command('doctor')
  .description('Run diagnostic checks')
  .option('--server <url>', 'MCP server URL', 'http://localhost:9876')
  .option('-v, --verbose', 'Show detailed error messages')
  .action(async (opts: { server: string; verbose?: boolean }) => {
    console.log(chalk.bold('\npaparats doctor\n'));

    const spinner = ora('Running diagnostic checks...').start();

    const results = await runChecks(
      opts.server,
      (name) => {
        if (opts.verbose) {
          spinner.text = `Checking ${name}...`;
        }
      },
      opts.verbose
    );

    spinner.stop();

    let allOk = true;
    for (const r of results) {
      const icon = r.ok ? chalk.green('✓') : chalk.red('✗');
      const msg = r.ok ? chalk.green(r.message) : chalk.red(r.message);
      console.log(`  ${icon} ${chalk.bold(r.name)}: ${msg}`);
      if (r.details) {
        console.log(chalk.gray(`    ${r.details}`));
      }
      if (!r.ok) allOk = false;
    }

    console.log();
    if (allOk) {
      console.log(chalk.green.bold('All checks passed!'));
    } else {
      console.log(chalk.yellow('Some checks failed. Fix the issues above and try again.'));
      process.exit(1);
    }
  });
