import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { createTimeoutSignal } from '../abort.js';
import { generateDockerCompose, generateServerCompose } from '../docker-compose-generator.js';
import type { OllamaMode, InstallMode } from '../docker-compose-generator.js';

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

export async function waitForHealth(
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

export interface UpsertMcpDeps {
  readFileSync?: (path: string, encoding: 'utf8') => string;
  writeFileSync?: (path: string, data: string) => void;
  existsSync?: (path: string) => boolean;
  mkdirSync?: (dir: string) => void;
}

export function upsertMcpServer(
  filePath: string,
  serverName: string,
  serverConfig: Record<string, unknown>,
  deps?: UpsertMcpDeps
): 'added' | 'updated' | 'unchanged' {
  const readFile = deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps?.writeFileSync ?? ((p: string, d: string) => fs.writeFileSync(p, d));
  const exists = deps?.existsSync ?? ((p: string) => fs.existsSync(p));
  const mkdir = deps?.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));

  let data: { mcpServers?: Record<string, Record<string, unknown>> };

  if (!exists(filePath)) {
    const dir = path.dirname(filePath);
    if (!exists(dir)) {
      mkdir(dir);
    }
    data = { mcpServers: { [serverName]: serverConfig } };
    writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
    return 'added';
  }

  const raw = readFile(filePath, 'utf8');
  data = JSON.parse(raw) as typeof data;

  if (!data.mcpServers) {
    data.mcpServers = {};
  }

  const existing = data.mcpServers[serverName];
  if (!existing) {
    data.mcpServers[serverName] = serverConfig;
    writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
    return 'added';
  }

  const bothHaveUrl = 'url' in existing && 'url' in serverConfig;
  const bothHaveCommand = 'command' in existing && 'command' in serverConfig;

  if (bothHaveUrl && existing['url'] === serverConfig['url']) {
    return 'unchanged';
  }
  if (bothHaveCommand && JSON.stringify(existing) === JSON.stringify(serverConfig)) {
    return 'unchanged';
  }
  if (
    !bothHaveUrl &&
    !bothHaveCommand &&
    JSON.stringify(existing) === JSON.stringify(serverConfig)
  ) {
    return 'unchanged';
  }

  data.mcpServers[serverName] = serverConfig;
  writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
  return 'updated';
}

// ── Install options & deps (testable via DI) ────────────────────────────────

export interface InstallOptions {
  mode?: InstallMode;
  ollamaMode?: OllamaMode;
  gpu?: boolean;
  skipDocker?: boolean;
  skipOllama?: boolean;
  verbose?: boolean;
  /** Server mode: comma-separated repos */
  repos?: string;
  /** Server mode: GitHub token for private repos */
  githubToken?: string;
  /** Server mode: cron expression */
  cron?: string;
  /** Support mode: server URL */
  server?: string;
}

export interface InstallDeps {
  commandExists?: (cmd: string) => boolean;
  getDockerComposeCommand?: () => string;
  exec?: (cmd: string, opts?: { timeout?: number }) => string;
  ollamaModelExists?: (modelName: string) => boolean;
  isOllamaRunning?: () => Promise<boolean>;
  waitForHealth?: (url: string, label: string) => Promise<boolean>;
  downloadFile?: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  generateDockerCompose?: typeof generateDockerCompose;
  generateServerCompose?: typeof generateServerCompose;
  mkdirSync?: (dir: string) => void;
  copyFileSync?: (src: string, dest: string) => void;
  readFileSync?: (path: string, encoding: 'utf8') => string;
  writeFileSync?: (path: string, data: string) => void;
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
}

// ── Developer mode ──────────────────────────────────────────────────────────

async function runDeveloperInstall(
  opts: InstallOptions,
  deps: Required<
    Pick<
      InstallDeps,
      | 'commandExists'
      | 'getDockerComposeCommand'
      | 'ollamaModelExists'
      | 'isOllamaRunning'
      | 'waitForHealth'
      | 'downloadFile'
      | 'generateDockerCompose'
      | 'mkdirSync'
      | 'readFileSync'
      | 'writeFileSync'
      | 'existsSync'
      | 'unlinkSync'
    >
  > & { signal?: AbortSignal }
): Promise<void> {
  const ollamaMode = opts.ollamaMode ?? 'local';
  const gpu = opts.gpu ?? false;

  const cleanupTasks: Array<() => void> = [];
  if (deps.signal) {
    deps.signal.addEventListener('abort', () => {
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

  // Check prerequisites
  const checks: Array<{ cmd: string; name: string; install: string }> = [
    { cmd: 'docker', name: 'Docker', install: 'https://docker.com' },
  ];

  if (ollamaMode === 'local') {
    checks.push({ cmd: 'ollama', name: 'Ollama', install: 'https://ollama.com' });
  }

  for (const check of checks) {
    if (!deps.commandExists(check.cmd)) {
      throw new Error(`${check.name} not found. Install from ${check.install}`);
    }
  }

  const prereqNames = checks.map((c) => c.name).join(', ');
  console.log(chalk.green(`\u2713 Prerequisites found (${prereqNames})\n`));

  // Docker setup
  if (!opts.skipDocker) {
    const spinner = ora('Setting up Docker containers...').start();

    deps.mkdirSync(PAPARATS_HOME);

    const composeContent = deps.generateDockerCompose({ ollamaMode, gpu });
    const composeDest = path.join(PAPARATS_HOME, 'docker-compose.yml');
    deps.writeFileSync(composeDest, composeContent);

    spinner.text = 'Starting Docker containers...';

    const composeCmd = deps.getDockerComposeCommand();
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

    const qdrantReady = await deps.waitForHealth('http://localhost:6333/healthz', 'Qdrant');
    if (!qdrantReady) throw new Error('Qdrant failed to start');

    const mcpReady = await deps.waitForHealth('http://localhost:9876/health', 'MCP server');
    if (!mcpReady) throw new Error('MCP server failed to start');
  }

  // Ollama setup (local mode only)
  if (!opts.skipOllama && ollamaMode === 'local') {
    if (deps.ollamaModelExists(OLLAMA_MODEL_NAME)) {
      console.log(chalk.green(`\u2713 Ollama model ${OLLAMA_MODEL_NAME} already exists\n`));
    } else {
      if (!(await deps.isOllamaRunning())) {
        console.log(chalk.dim('Starting Ollama...'));
        spawn('ollama', ['serve'], { stdio: 'ignore', detached: true }).unref();
        await new Promise((r) => setTimeout(r, 3000));
        if (!(await deps.isOllamaRunning())) {
          throw new Error('Failed to start Ollama. Please start it manually: ollama serve');
        }
      }

      if (deps.existsSync(GGUF_FILE)) {
        console.log(chalk.dim(`GGUF already downloaded at ${GGUF_FILE}`));
      } else {
        if (!deps.commandExists('curl')) {
          console.log(
            chalk.yellow(
              'Note: curl not found. Using Node fetch (slower for large files). Install curl for better download performance.'
            )
          );
        }
        console.log(chalk.bold('Downloading jina-code-embeddings (~1.65 GB)...'));
        deps.mkdirSync(MODELS_DIR);
        cleanupTasks.push(() => {
          if (deps.existsSync(GGUF_FILE)) deps.unlinkSync(GGUF_FILE);
        });
        await deps.downloadFile(GGUF_URL, GGUF_FILE, deps.signal);
        cleanupTasks.pop();
        console.log(chalk.green('\u2713 Download complete'));
      }

      const modelfilePath = path.join(MODELS_DIR, 'Modelfile');
      deps.writeFileSync(modelfilePath, `FROM ${GGUF_FILE}\n`);

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

  // Auto-configure Cursor MCP
  configureCursorMcp('http://localhost:9876/mcp', deps);

  console.log(chalk.bold.green('\n\u2713 Installation complete!\n'));
  console.log('Next steps:');
  console.log(chalk.dim('  1. cd <your-project>'));
  console.log(chalk.dim('  2. paparats init'));
  console.log(chalk.dim('  3. paparats index'));
  console.log(chalk.dim('  4. Connect your IDE (see README)\n'));
}

// ── Server mode ─────────────────────────────────────────────────────────────

async function runServerInstall(
  opts: InstallOptions,
  deps: Required<
    Pick<
      InstallDeps,
      | 'commandExists'
      | 'getDockerComposeCommand'
      | 'generateServerCompose'
      | 'waitForHealth'
      | 'mkdirSync'
      | 'writeFileSync'
      | 'existsSync'
    >
  >
): Promise<void> {
  // Check Docker only
  if (!deps.commandExists('docker')) {
    throw new Error('Docker not found. Install from https://docker.com');
  }
  console.log(chalk.green('\u2713 Prerequisites found (Docker)\n'));

  const gpu = opts.gpu ?? false;

  deps.mkdirSync(PAPARATS_HOME);

  // Generate docker-compose with all services
  const composeContent = deps.generateServerCompose({
    ollamaMode: 'docker',
    gpu,
    repos: opts.repos,
    githubToken: opts.githubToken,
    cron: opts.cron,
  });
  const composeDest = path.join(PAPARATS_HOME, 'docker-compose.yml');
  deps.writeFileSync(composeDest, composeContent);

  // Create .env file for docker-compose variable substitution
  const envLines: string[] = [];
  if (opts.repos) envLines.push(`REPOS=${opts.repos}`);
  if (opts.githubToken) envLines.push(`GITHUB_TOKEN=${opts.githubToken}`);
  if (opts.cron) envLines.push(`CRON=${opts.cron}`);
  if (envLines.length > 0) {
    const envPath = path.join(PAPARATS_HOME, '.env');
    deps.writeFileSync(envPath, envLines.join('\n') + '\n');
    console.log(chalk.dim(`Created ${envPath}`));
  }

  // Start containers
  const spinner = ora('Starting Docker containers (this may take a while on first run)...').start();
  const composeCmd = deps.getDockerComposeCommand();
  const fullCmd = `${composeCmd} -f "${composeDest}" up -d`;
  try {
    execSync(fullCmd, {
      stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    spinner.succeed('Docker containers started');
  } catch (err) {
    spinner.fail('Failed to start Docker containers');
    throw err;
  }

  const qdrantReady = await deps.waitForHealth('http://localhost:6333/healthz', 'Qdrant');
  if (!qdrantReady) throw new Error('Qdrant failed to start');

  const mcpReady = await deps.waitForHealth('http://localhost:9876/health', 'MCP server');
  if (!mcpReady) throw new Error('MCP server failed to start');

  console.log(chalk.bold.green('\n\u2713 Server installation complete!\n'));
  console.log('MCP endpoints:');
  console.log(chalk.dim('  Coding:  http://localhost:9876/mcp'));
  console.log(chalk.dim('  Support: http://localhost:9876/support/mcp'));
  console.log(chalk.dim('  Health:  http://localhost:9876/health'));
  if (opts.repos) {
    console.log(
      chalk.dim(`\nIndexer will process repos on schedule: ${opts.cron ?? '0 */6 * * *'}`)
    );
    console.log(chalk.dim('  Trigger now: curl -X POST http://localhost:9877/trigger'));
    console.log(chalk.dim('  Status:      curl http://localhost:9877/health'));
  }
  console.log('');
}

// ── Support mode ────────────────────────────────────────────────────────────

async function runSupportInstall(
  opts: InstallOptions,
  deps: Required<
    Pick<
      InstallDeps,
      'waitForHealth' | 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'
    >
  >
): Promise<void> {
  const serverUrl = opts.server ?? 'http://localhost:9876';

  // Verify server is reachable
  const healthUrl = `${serverUrl}/health`;
  console.log(chalk.dim(`Checking server at ${healthUrl}...`));
  const reachable = await deps.waitForHealth(healthUrl, 'MCP server');
  if (!reachable) {
    throw new Error(`Server not reachable at ${serverUrl}. Is the server running?`);
  }

  const mcpUrl = `${serverUrl}/support/mcp`;

  // Configure Cursor MCP (support endpoint)
  configureCursorMcp(mcpUrl, deps, 'paparats-support');

  // Configure Claude Code MCP
  const claudeConfigDir = path.join(os.homedir(), '.claude');
  if (deps.existsSync(claudeConfigDir)) {
    const claudeMcpPath = path.join(claudeConfigDir, 'mcp.json');
    const result = upsertMcpServer(
      claudeMcpPath,
      'paparats-support',
      { type: 'http', url: mcpUrl },
      {
        readFileSync: deps.readFileSync,
        writeFileSync: deps.writeFileSync,
        existsSync: deps.existsSync,
        mkdirSync: deps.mkdirSync,
      }
    );
    if (result === 'unchanged') {
      console.log(chalk.green('\u2713 Claude Code MCP already configured'));
    } else {
      console.log(chalk.green('\u2713 Claude Code MCP configured'));
    }
  }

  console.log(chalk.bold.green('\n\u2713 Support setup complete!\n'));
  console.log('Configured endpoint:');
  console.log(chalk.dim(`  Support MCP: ${mcpUrl}\n`));
  console.log('Available tools: search_code, get_chunk, find_usages, health_check,');
  console.log(
    '  get_chunk_meta, search_changes, explain_feature, recent_changes, impact_analysis\n'
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function configureCursorMcp(
  mcpUrl: string,
  deps: Pick<InstallDeps, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>,
  serverName = 'paparats'
): void {
  const exists = deps.existsSync ?? ((p: string) => fs.existsSync(p));
  const readFile = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFileSync ?? fs.writeFileSync.bind(fs);
  const mkdir = deps.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));

  const cursorDir = path.join(os.homedir(), '.cursor');
  if (exists(cursorDir)) {
    const cursorMcpPath = path.join(cursorDir, 'mcp.json');
    const result = upsertMcpServer(
      cursorMcpPath,
      serverName,
      { type: 'http', url: mcpUrl },
      { readFileSync: readFile, writeFileSync: writeFile, existsSync: exists, mkdirSync: mkdir }
    );
    if (result === 'unchanged') {
      console.log(chalk.green('\u2713 Cursor MCP already configured'));
    } else {
      console.log(chalk.green('\u2713 Cursor MCP configured'));
    }
  } else {
    console.log(chalk.dim('Cursor not detected, skipping MCP config'));
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

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
  const genCompose = deps?.generateDockerCompose ?? generateDockerCompose;
  const genServerCompose = deps?.generateServerCompose ?? generateServerCompose;
  const mkdir = deps?.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true }));
  const readFile = deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps?.writeFileSync ?? fs.writeFileSync.bind(fs);
  const exists = deps?.existsSync ?? fs.existsSync.bind(fs);
  const unlink = deps?.unlinkSync ?? fs.unlinkSync.bind(fs);
  const signal = deps?.signal;

  const mode = opts.mode ?? 'developer';
  console.log(chalk.bold(`\npaparats install --mode ${mode}\n`));

  const resolvedDeps = {
    commandExists: cmdExists,
    getDockerComposeCommand: getCompose,
    ollamaModelExists: modelExists,
    isOllamaRunning: ollamaRunning,
    waitForHealth: waitHealth,
    downloadFile: download,
    generateDockerCompose: genCompose,
    generateServerCompose: genServerCompose,
    mkdirSync: mkdir,
    readFileSync: readFile,
    writeFileSync: writeFile,
    existsSync: exists,
    unlinkSync: unlink,
    signal,
  };

  switch (mode) {
    case 'developer':
      await runDeveloperInstall(opts, resolvedDeps);
      break;
    case 'server':
      await runServerInstall(opts, resolvedDeps);
      break;
    case 'support':
      await runSupportInstall(opts, resolvedDeps);
      break;
    default:
      throw new Error(`Unknown install mode: ${mode as string}`);
  }
}

export const installCommand = new Command('install')
  .description('Set up Paparats — Docker containers, Ollama model, and MCP configuration')
  .option('--mode <mode>', 'Install mode: developer, server, or support', 'developer')
  .option('--ollama-mode <mode>', 'Ollama deployment: docker or local (developer mode)', 'local')
  .option('--gpu', 'Enable GPU support for Docker Ollama (Linux NVIDIA only)')
  .option('--skip-docker', 'Skip Docker setup (developer mode)')
  .option('--skip-ollama', 'Skip Ollama model setup (developer mode)')
  .option('--repos <repos>', 'Comma-separated repos to index (server mode)')
  .option('--github-token <token>', 'GitHub token for private repos (server mode)')
  .option('--cron <expression>', 'Cron schedule for indexing (server mode)')
  .option('--server <url>', 'Server URL to connect to (support mode)', 'http://localhost:9876')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: InstallOptions & { ollamaMode?: string }) => {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    try {
      await runInstall(
        {
          ...opts,
          ollamaMode: (opts.ollamaMode as OllamaMode) ?? 'local',
        },
        { signal: controller.signal }
      );
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
