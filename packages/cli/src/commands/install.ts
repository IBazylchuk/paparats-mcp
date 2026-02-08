import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { createTimeoutSignal } from '../abort.js';

const PAPARATS_HOME = path.join(os.homedir(), '.paparats');
const MODELS_DIR = path.join(PAPARATS_HOME, 'models');
const OLLAMA_MODEL_NAME = 'jina-code-embeddings';
const GGUF_URL =
  'https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf';
const GGUF_FILE = path.join(MODELS_DIR, 'jina-code-embeddings-1.5b-Q8_0.gguf');

export function commandExists(cmd: string): boolean {
  try {
    const command = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(command, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function getDockerComposeCommand(): string {
  try {
    execSync('docker compose version', { stdio: 'ignore', timeout: 3000 });
    return 'docker compose';
  } catch {
    try {
      execSync('docker-compose version', { stdio: 'ignore', timeout: 3000 });
      return 'docker-compose';
    } catch {
      throw new Error(
        'Docker Compose not found. ' +
          'Install Docker Desktop or docker-compose: https://docs.docker.com/compose/install/'
      );
    }
  }
}

function execCmd(cmd: string, options?: { timeout?: number }): string {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options?.timeout ?? 30_000,
  }).trim();
}

export function ollamaModelExists(modelName: string): boolean {
  try {
    const output = execCmd('ollama list', { timeout: 10_000 });
    return output.includes(modelName);
  } catch {
    return false;
  }
}

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: createTimeoutSignal(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(
  url: string,
  label: string,
  maxRetries = 30,
  delayMs = 1000
): Promise<boolean> {
  const spinner = ora(`Waiting for ${label}...`).start();
  for (let i = 0; i < maxRetries; i++) {
    try {
      const ok = await fetch(url).then((r) => r.ok);
      if (ok) {
        spinner.succeed(`${label} is ready`);
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  spinner.fail(`${label} failed to start within ${maxRetries}s`);
  return false;
}

function downloadWithCurl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', ['-L', '--progress-bar', '-o', dest, url], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl exited with code ${code}`));
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn curl: ${(err as Error).message}`));
    });
  });
}

async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  if (commandExists('curl')) {
    return downloadWithCurl(url, dest);
  }
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
}

function findTemplatePath(): string {
  const templateLocations = [
    path.join(
      import.meta.dirname,
      '../../node_modules/@paparats/server/docker-compose.template.yml'
    ),
    path.join(import.meta.dirname, '../../../server/docker-compose.template.yml'),
    path.join(import.meta.dirname, '../../../../packages/server/docker-compose.template.yml'),
  ];

  for (const loc of templateLocations) {
    if (fs.existsSync(loc)) return loc;
  }

  throw new Error(
    'Could not find docker-compose.template.yml. ' + 'Looked in: ' + templateLocations.join(', ')
  );
}

export interface InstallOptions {
  skipDocker?: boolean;
  skipOllama?: boolean;
  verbose?: boolean;
}

export interface InstallDeps {
  commandExists?: (cmd: string) => boolean;
  getDockerComposeCommand?: () => string;
  exec?: (cmd: string, opts?: { timeout?: number }) => string;
  ollamaModelExists?: (modelName: string) => boolean;
  isOllamaRunning?: () => Promise<boolean>;
  waitForHealth?: (url: string, label: string) => Promise<boolean>;
  downloadFile?: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  findTemplatePath?: () => string;
  mkdirSync?: (dir: string) => void;
  copyFileSync?: (src: string, dest: string) => void;
  writeFileSync?: (path: string, data: string) => void;
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
}

export async function runInstall(
  opts: InstallOptions,
  deps?: InstallDeps & { signal?: AbortSignal }
): Promise<void> {
  const cmdExists = deps?.commandExists ?? commandExists;
  const getCompose = deps?.getDockerComposeCommand ?? getDockerComposeCommand;
  const modelExists = deps?.ollamaModelExists ?? ollamaModelExists;
  const ollamaRunning = deps?.isOllamaRunning ?? isOllamaRunning;
  const waitHealth = deps?.waitForHealth ?? waitForHealth;
  const download = deps?.downloadFile ?? downloadFile;
  const findTemplate = deps?.findTemplatePath ?? findTemplatePath;
  const mkdir = deps?.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));
  const copyFile = deps?.copyFileSync ?? fs.copyFileSync.bind(fs);
  const writeFile = deps?.writeFileSync ?? fs.writeFileSync.bind(fs);
  const exists = deps?.existsSync ?? fs.existsSync.bind(fs);
  const unlink = deps?.unlinkSync ?? fs.unlinkSync.bind(fs);
  const signal = deps?.signal;

  const cleanupTasks: Array<() => void> = [];

  if (signal) {
    signal.addEventListener('abort', () => {
      console.log(chalk.yellow('\nInstallation cancelled'));
      for (const task of cleanupTasks) {
        try {
          task();
        } catch {
          // ignore
        }
      }
      process.exit(130);
    });
  }

  console.log(chalk.bold('\npaparats install\n'));

  const checks = [
    { cmd: 'docker', name: 'Docker', install: 'https://docker.com' },
    { cmd: 'ollama', name: 'Ollama', install: 'https://ollama.com' },
  ];

  for (const check of checks) {
    if (!cmdExists(check.cmd)) {
      throw new Error(`${check.name} not found. Install from ${check.install}`);
    }
  }
  console.log(chalk.green('✓ Prerequisites found (Docker, Ollama)\n'));

  if (!opts.skipDocker) {
    const spinner = ora('Setting up Docker containers...').start();

    mkdir(PAPARATS_HOME);

    const templatePath = findTemplate();
    const composeDest = path.join(PAPARATS_HOME, 'docker-compose.yml');
    copyFile(templatePath, composeDest);
    spinner.text = 'Starting Docker containers...';

    const composeCmd = getCompose();
    const fullCmd = `${composeCmd} -f "${composeDest}" up -d`;
    try {
      execSync(fullCmd, {
        stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      });
      spinner.succeed('Docker containers started');
    } catch (err) {
      spinner.fail('Failed to start Docker containers');
      throw err;
    }

    const qdrantReady = await waitHealth('http://localhost:6333/healthz', 'Qdrant');
    if (!qdrantReady) throw new Error('Qdrant failed to start');

    const mcpReady = await waitHealth('http://localhost:9876/health', 'MCP server');
    if (!mcpReady) throw new Error('MCP server failed to start');
  }

  if (!opts.skipOllama) {
    if (modelExists(OLLAMA_MODEL_NAME)) {
      console.log(chalk.green(`✓ Ollama model ${OLLAMA_MODEL_NAME} already exists\n`));
    } else {
      if (!(await ollamaRunning())) {
        console.log(chalk.dim('Starting Ollama...'));
        spawn('ollama', ['serve'], { stdio: 'ignore', detached: true }).unref();
        await new Promise((r) => setTimeout(r, 3000));
        if (!(await ollamaRunning())) {
          throw new Error('Failed to start Ollama. Please start it manually: ollama serve');
        }
      }

      if (exists(GGUF_FILE)) {
        console.log(chalk.dim(`GGUF already downloaded at ${GGUF_FILE}`));
      } else {
        if (!cmdExists('curl')) {
          console.log(
            chalk.yellow(
              'Note: curl not found. Using Node fetch (slower for large files). Install curl for better download performance.'
            )
          );
        }
        console.log(chalk.bold('Downloading jina-code-embeddings (~1.65 GB)...'));
        mkdir(MODELS_DIR);
        cleanupTasks.push(() => {
          if (exists(GGUF_FILE)) unlink(GGUF_FILE);
        });
        await download(GGUF_URL, GGUF_FILE, signal);
        cleanupTasks.pop();
        console.log(chalk.green('✓ Download complete'));
      }

      const modelfilePath = path.join(MODELS_DIR, 'Modelfile');
      writeFile(modelfilePath, `FROM ${GGUF_FILE}\n`);

      const spinner = ora('Registering model in Ollama...').start();
      try {
        execSync(`ollama create ${OLLAMA_MODEL_NAME} -f "${modelfilePath}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60_000,
        });
        spinner.succeed(`Ollama model ${OLLAMA_MODEL_NAME} registered`);
      } catch (err) {
        spinner.fail('Failed to register model');
        throw err;
      }
    }
  }

  console.log(chalk.bold.green('\n✓ Installation complete!\n'));
  console.log('Next steps:');
  console.log(chalk.dim('  1. cd <your-project>'));
  console.log(chalk.dim('  2. paparats init'));
  console.log(chalk.dim('  3. paparats index'));
  console.log(chalk.dim('  4. Connect your IDE (see README)\n'));
}

export const installCommand = new Command('install')
  .description('Set up Docker containers (Qdrant + MCP server) and Ollama embedding model')
  .option('--skip-docker', 'Skip Docker setup')
  .option('--skip-ollama', 'Skip Ollama model setup')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: InstallOptions) => {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    try {
      await runInstall(opts, { signal: controller.signal });
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
