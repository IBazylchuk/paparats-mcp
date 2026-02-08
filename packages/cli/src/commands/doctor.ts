import { Command } from 'commander';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import ora from 'ora';
import { findConfigDir, readConfig, CONFIG_FILE } from '../config.js';
import { ApiClient } from '../api-client.js';

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

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if ('timeout' in AbortSignal && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
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
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  let ollamaModel = process.env.EMBEDDING_MODEL ?? 'jina-code-embeddings';

  const configDir = findConfigDir();
  if (configDir) {
    try {
      const { config } = readConfig(configDir);
      ollamaModel = config.embeddings?.model ?? ollamaModel;
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

  // 5. Ollama
  onCheckStart?.('Ollama');
  if (commandExists('ollama')) {
    try {
      const ollamaTagsUrl = new URL('/api/tags', ollamaUrl).href;
      const res = await fetch(ollamaTagsUrl, {
        signal: createTimeoutSignal(3000),
      });

      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        const models = data.models ?? [];
        const hasModel = models.some((m) => m.name.includes(ollamaModel));

        if (hasModel) {
          results.push({ name: 'Ollama', ok: true, message: `model ${ollamaModel} ready` });
        } else {
          const available = models.map((m) => m.name).join(', ') || 'none';
          results.push({
            name: 'Ollama',
            ok: false,
            message: `running but ${ollamaModel} model not found`,
            details: verbose ? `Available: ${available}` : undefined,
          });
        }
      } else {
        const output = execSync('ollama list', { encoding: 'utf8', timeout: 5_000 });
        if (output.includes(ollamaModel)) {
          results.push({ name: 'Ollama', ok: true, message: `model ${ollamaModel} ready` });
        } else {
          results.push({
            name: 'Ollama',
            ok: false,
            message: `running but ${ollamaModel} model not found`,
          });
        }
      }
    } catch (err) {
      results.push({
        name: 'Ollama',
        ok: false,
        message: 'installed but not running',
        details: verbose ? (err as Error).message : undefined,
      });
    }
  } else {
    results.push({ name: 'Ollama', ok: false, message: 'not installed' });
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
