import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { confirm, input, select } from '@inquirer/prompts';
import { createTimeoutSignal } from '../abort.js';
import { generateCompose } from '../docker-compose-generator.js';
import type { OllamaMode, InstallMode } from '../docker-compose-generator.js';
import {
  PAPARATS_HOME,
  COMPOSE_YML,
  PROJECTS_YML,
  migrateLegacyProjectsFile,
  readProjectsFile,
  writeProjectsFile,
  writeInstallState,
  localProjectsFor,
} from '../projects-yml.js';

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
  /** External Ollama URL — bypasses native and docker Ollama */
  ollamaUrl?: string;
  /** External Qdrant URL — skip Qdrant Docker container */
  qdrantUrl?: string;
  /** Qdrant API key for authenticated access */
  qdrantApiKey?: string;
  /** Skip overwrite/migration prompts (always overwrite) */
  force?: boolean;
  /** Fail on prompts instead of asking */
  nonInteractive?: boolean;
  verbose?: boolean;
  /** Support mode: server URL */
  server?: string;
}

export interface InstallDeps {
  commandExists?: (cmd: string) => boolean;
  getDockerComposeCommand?: () => string;
  ollamaModelExists?: (modelName: string) => boolean;
  isOllamaRunning?: () => Promise<boolean>;
  waitForHealth?: (url: string, label: string) => Promise<boolean>;
  downloadFile?: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  generateCompose?: typeof generateCompose;
  mkdirSync?: (dir: string) => void;
  readFileSync?: (path: string, encoding: 'utf8') => string;
  writeFileSync?: (path: string, data: string) => void;
  existsSync?: (path: string) => boolean;
  unlinkSync?: (path: string) => void;
  renameSync?: (oldPath: string, newPath: string) => void;
  promptUseExternalQdrant?: () => Promise<boolean>;
  promptQdrantUrl?: () => Promise<string>;
  promptQdrantApiKey?: () => Promise<string>;
  promptOllamaChoiceMacOs?: () => Promise<'brew' | 'docker' | 'remote'>;
  promptRemoteOllamaUrl?: () => Promise<string>;
  promptOverwriteCompose?: () => Promise<boolean>;
  promptMigrate?: () => Promise<boolean>;
  platform?: () => NodeJS.Platform;
  execSync?: (cmd: string, opts?: object) => Buffer | string;
}

// ── Shared Ollama setup ─────────────────────────────────────────────────────

interface OllamaSetupDeps {
  commandExists: (cmd: string) => boolean;
  ollamaModelExists: (modelName: string) => boolean;
  isOllamaRunning: () => Promise<boolean>;
  downloadFile: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  mkdirSync: (dir: string) => void;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
  signal?: AbortSignal;
}

/**
 * Ensure local Ollama is running and the embedding model is registered.
 * Shared by developer and server install modes when ollamaMode is 'local'.
 */
async function ensureLocalOllama(
  deps: OllamaSetupDeps,
  cleanupTasks: Array<() => void>
): Promise<void> {
  if (deps.ollamaModelExists(OLLAMA_MODEL_NAME)) {
    console.log(chalk.green(`\u2713 Ollama model ${OLLAMA_MODEL_NAME} already exists\n`));
    return;
  }

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

// ── Migration ───────────────────────────────────────────────────────────────

/**
 * Detects a v1 install: legacy compose has `paparats-mcp` container without
 * `paparats-indexer` service.
 */
export function detectLegacyInstall(composeContent: string | null): string | null {
  if (!composeContent) return null;
  if (composeContent.includes('container_name: paparats-indexer')) return null;
  if (
    composeContent.includes('container_name: paparats-mcp') ||
    composeContent.includes("container_name: 'paparats-mcp'")
  ) {
    return 'legacy compose has paparats-mcp without paparats-indexer';
  }
  return null;
}

/**
 * Get the user's consent to migrate from a v1 install. Does NOT touch any
 * file on disk — the actual tear-down happens later, after the replacement
 * compose has been generated and written. This split prevents the
 * "interrupt-mid-install" hole where we used to delete the legacy compose
 * before knowing whether we could write a successor.
 */
async function confirmMigration(
  resolvedDeps: ResolvedDeps,
  opts: InstallOptions
): Promise<boolean> {
  console.log(
    chalk.yellow.bold('\nLegacy install detected.\n') +
      'Paparats has switched to a single global install with one docker-compose.yml and a\n' +
      'project list at ~/.paparats/projects.yml. Per-project `paparats init` and the\n' +
      '`developer` / `server` install modes are no longer used.\n\n' +
      'Existing data volumes (qdrant_data, paparats_data, indexer_repos) are\n' +
      'preserved — your indexed projects survive. The legacy compose and .env will be\n' +
      'backed up to *.legacy.bak and replaced once the new compose is ready.\n'
  );

  if (opts.force) return true;
  if (opts.nonInteractive) {
    throw new Error(
      'Migration prompt required but --non-interactive set; pass --force to proceed.'
    );
  }
  const promptMigrate =
    resolvedDeps.promptMigrate ??
    (() => confirm({ message: 'Continue migration?', default: false }));
  const proceed = await promptMigrate();
  if (!proceed) {
    console.log(chalk.dim('Migration aborted, no changes made.'));
  }
  return proceed;
}

/**
 * Tear down the legacy stack and back up its compose+env. Backups stay on
 * disk as `<name>.legacy.bak` so the user has a recovery path if anything
 * downstream goes wrong; we only clean them up after a fully successful
 * install. Returns the backup paths that were actually created.
 */
export function tearDownAndBackupLegacy(
  composePath: string,
  envPath: string,
  resolvedDeps: ResolvedDeps,
  opts: InstallOptions
): { composeBak: string | null; envBak: string | null } {
  // Best-effort: stop the legacy stack. A failure here doesn't block the
  // upgrade — the user may already have stopped it manually, or the daemon
  // may be unreachable; either way, the new compose can still be written.
  try {
    resolvedDeps.execSync(`${resolvedDeps.getDockerComposeCommand()} -f "${composePath}" down`, {
      stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch {
    // user may have already stopped it; ignore
  }

  let composeBak: string | null = null;
  let envBak: string | null = null;
  if (resolvedDeps.existsSync(composePath)) {
    composeBak = `${composePath}.legacy.bak`;
    resolvedDeps.renameSync(composePath, composeBak);
  }
  if (resolvedDeps.existsSync(envPath)) {
    envBak = `${envPath}.legacy.bak`;
    resolvedDeps.renameSync(envPath, envBak);
  }
  return { composeBak, envBak };
}

// ── Resolved deps ───────────────────────────────────────────────────────────

export interface ResolvedDeps {
  commandExists: (cmd: string) => boolean;
  getDockerComposeCommand: () => string;
  ollamaModelExists: (modelName: string) => boolean;
  isOllamaRunning: () => Promise<boolean>;
  waitForHealth: (url: string, label: string) => Promise<boolean>;
  downloadFile: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  generateCompose: typeof generateCompose;
  mkdirSync: (dir: string) => void;
  readFileSync: (path: string, encoding: 'utf8') => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  promptUseExternalQdrant?: () => Promise<boolean>;
  promptQdrantUrl?: () => Promise<string>;
  promptQdrantApiKey?: () => Promise<string>;
  promptOllamaChoiceMacOs?: () => Promise<'brew' | 'docker' | 'remote'>;
  promptRemoteOllamaUrl?: () => Promise<string>;
  promptOverwriteCompose?: () => Promise<boolean>;
  promptMigrate?: () => Promise<boolean>;
  platform: () => NodeJS.Platform;
  execSync: (cmd: string, opts?: object) => Buffer | string;
  signal?: AbortSignal;
}

// ── Decide Ollama mode ──────────────────────────────────────────────────────

export interface OllamaDecision {
  mode: OllamaMode;
  ollamaUrl?: string;
  /** Should the host-side `ensureLocalOllama` (download + register model) run? */
  setupHostOllama: boolean;
}

export async function decideOllamaMode(
  opts: InstallOptions,
  deps: ResolvedDeps
): Promise<OllamaDecision> {
  if (opts.ollamaUrl) {
    return { mode: 'external', ollamaUrl: opts.ollamaUrl, setupHostOllama: false };
  }
  if (opts.ollamaMode === 'docker') {
    return { mode: 'docker', setupHostOllama: false };
  }
  if (opts.ollamaMode === 'native') {
    return { mode: 'native', setupHostOllama: true };
  }

  const platform = deps.platform();
  if (platform === 'darwin') {
    if (deps.commandExists('ollama')) {
      console.log(chalk.green('✓ Native Ollama detected on macOS\n'));
      return { mode: 'native', setupHostOllama: true };
    }
    console.log(
      chalk.yellow('Ollama is not installed.\n') +
        chalk.dim(
          'Recommendation for macOS: install Ollama natively. Running Ollama in Docker on\n' +
            'macOS is significantly slower because the Docker VM cannot use Apple Silicon\n' +
            'GPU acceleration. Native Ollama uses Metal directly.\n'
        )
    );
    if (opts.nonInteractive) {
      throw new Error(
        'Ollama not found. Install with `brew install ollama`, or pass --ollama-mode docker / --ollama-url <url>.'
      );
    }
    const choice = deps.promptOllamaChoiceMacOs
      ? await deps.promptOllamaChoiceMacOs()
      : await select({
          message: 'How should Paparats reach Ollama?',
          choices: [
            { name: 'Install natively via brew install ollama (recommended)', value: 'brew' },
            { name: 'Use a remote Ollama URL', value: 'remote' },
            { name: 'Run Ollama in Docker (slower on macOS)', value: 'docker' },
          ],
          default: 'brew',
        });
    if (choice === 'brew') {
      if (!deps.commandExists('brew')) {
        throw new Error(
          'Homebrew not found. Install brew first (https://brew.sh) or pass --ollama-mode docker / --ollama-url.'
        );
      }
      const spinner = ora('Installing ollama via brew...').start();
      try {
        deps.execSync('brew install ollama', {
          stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
          timeout: 180_000,
        });
        spinner.succeed('ollama installed');
      } catch (err) {
        spinner.fail('brew install ollama failed');
        throw err;
      }
      return { mode: 'native', setupHostOllama: true };
    }
    if (choice === 'remote') {
      const url = deps.promptRemoteOllamaUrl
        ? await deps.promptRemoteOllamaUrl()
        : await input({ message: 'Remote Ollama URL:' });
      return { mode: 'external', ollamaUrl: url, setupHostOllama: false };
    }
    return { mode: 'docker', setupHostOllama: false };
  }

  return { mode: 'docker', setupHostOllama: false };
}

// ── Unified install ─────────────────────────────────────────────────────────

async function runUnifiedInstall(opts: InstallOptions, deps: ResolvedDeps): Promise<void> {
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

  // 1. Prerequisites
  if (!deps.commandExists('docker')) {
    throw new Error('Docker not found. Install from https://docker.com');
  }
  deps.getDockerComposeCommand();
  console.log(chalk.green('✓ Docker + docker compose found\n'));

  // 2. Migration check
  deps.mkdirSync(PAPARATS_HOME);
  const composePath = path.join(PAPARATS_HOME, COMPOSE_YML);
  const envPath = path.join(PAPARATS_HOME, '.env');
  const composeContent = deps.existsSync(composePath)
    ? deps.readFileSync(composePath, 'utf8')
    : null;
  const legacyTrigger = detectLegacyInstall(composeContent);
  let needsLegacyTeardown = false;
  if (legacyTrigger) {
    const proceeded = await confirmMigration(deps, opts);
    if (!proceeded) return;
    // Defer the actual tear-down until we have the new compose generated
    // and ready to write — see step 7c below.
    needsLegacyTeardown = true;
  }

  // 3. Ollama decision
  const ollamaDecision = await decideOllamaMode(opts, deps);

  // 4. Qdrant decision
  if (!opts.qdrantUrl && !opts.nonInteractive) {
    const promptExternal =
      deps.promptUseExternalQdrant ??
      (() =>
        confirm({
          message: 'Use an external Qdrant instance? (skip Qdrant Docker container)',
          default: false,
        }));
    const useExternal = await promptExternal();
    if (useExternal) {
      const promptUrl =
        deps.promptQdrantUrl ??
        (() =>
          input({
            message: 'Qdrant URL:',
            default: 'http://localhost:6333',
            validate: (value: string) => {
              try {
                new URL(value);
                return true;
              } catch {
                return 'Please enter a valid URL';
              }
            },
          }));
      opts.qdrantUrl = await promptUrl();
    }
  }
  if (opts.qdrantUrl && !opts.qdrantApiKey && !opts.nonInteractive) {
    const promptApiKey =
      deps.promptQdrantApiKey ??
      (() => input({ message: 'Qdrant API key (leave empty if none):', default: '' }));
    const key = await promptApiKey();
    if (key) opts.qdrantApiKey = key;
  }

  // 5. Ensure projects.yml exists. Migrate the legacy paparats-indexer.yml
  //    in place if present so users coming from paparats < 0.4 don't lose
  //    their project list.
  if (migrateLegacyProjectsFile(PAPARATS_HOME)) {
    console.log(
      chalk.yellow(`Renamed legacy paparats-indexer.yml → ${PROJECTS_YML} (one-time migration).`)
    );
  }
  const projectsYmlPath = path.join(PAPARATS_HOME, PROJECTS_YML);
  if (!deps.existsSync(projectsYmlPath)) {
    writeProjectsFile({ repos: [] }, PAPARATS_HOME);
    console.log(chalk.dim(`Created empty ${projectsYmlPath}`));
  }

  // 6. Generate compose using current projects list
  const projectsFile = readProjectsFile(PAPARATS_HOME);
  const newComposeContent = deps.generateCompose({
    ollamaMode: ollamaDecision.mode,
    ...(ollamaDecision.ollamaUrl !== undefined ? { ollamaUrl: ollamaDecision.ollamaUrl } : {}),
    ...(opts.qdrantUrl !== undefined ? { qdrantUrl: opts.qdrantUrl } : {}),
    ...(opts.qdrantApiKey !== undefined ? { qdrantApiKey: opts.qdrantApiKey } : {}),
    paparatsHome: PAPARATS_HOME,
    localProjects: localProjectsFor(projectsFile),
  });

  // 7. Tear down the legacy stack and back up its compose+env now that we
  //    have a validated replacement in memory. Backups stay on disk under
  //    *.legacy.bak so the user has a recovery path; we keep them around
  //    even after success — `paparats install` is idempotent and a stray
  //    pair of bak files is cheaper than a missed rollback opportunity.
  if (needsLegacyTeardown) {
    const { composeBak, envBak } = tearDownAndBackupLegacy(composePath, envPath, deps, opts);
    if (composeBak) {
      console.log(
        chalk.dim(
          `Backed up legacy compose to ${composeBak}` + (envBak ? ` and .env to ${envBak}` : '')
        )
      );
    }
  }

  // 7a. Compose write with overwrite confirmation (default N)
  const existingCompose = deps.existsSync(composePath)
    ? deps.readFileSync(composePath, 'utf8')
    : null;
  let writeCompose = true;
  if (existingCompose !== null && existingCompose !== newComposeContent) {
    if (opts.force) {
      writeCompose = true;
    } else if (opts.nonInteractive) {
      throw new Error(
        'docker-compose.yml differs; pass --force to overwrite or run without --non-interactive.'
      );
    } else {
      const promptOverwrite =
        deps.promptOverwriteCompose ??
        (() =>
          confirm({
            message: `${composePath} has been hand-edited. Overwrite?`,
            default: false,
          }));
      writeCompose = await promptOverwrite();
      if (!writeCompose) {
        console.log(
          chalk.dim('Existing compose preserved. Run `paparats install --force` to regenerate.\n')
        );
      }
    }
  }
  if (writeCompose) {
    deps.writeFileSync(composePath, newComposeContent);
  }

  // 7b. Persist install state so `paparats add | remove | edit projects` can
  //     regenerate compose later with the same flags (ollama mode, qdrant
  //     credentials, cron). Without this, those commands have no idea which
  //     services should be in the compose.
  writeInstallState(
    {
      ollamaMode: ollamaDecision.mode,
      ...(ollamaDecision.ollamaUrl !== undefined ? { ollamaUrl: ollamaDecision.ollamaUrl } : {}),
      ...(opts.qdrantUrl !== undefined ? { qdrantUrl: opts.qdrantUrl } : {}),
      ...(opts.qdrantApiKey !== undefined ? { qdrantApiKey: opts.qdrantApiKey } : {}),
    },
    PAPARATS_HOME
  );

  // 8. .env file
  if (opts.qdrantApiKey) {
    deps.writeFileSync(envPath, `QDRANT_API_KEY=${opts.qdrantApiKey}\n`);
  }

  // 9. Bring up the stack
  const composeCmd = deps.getDockerComposeCommand();
  const upSpinner = ora('Starting Docker containers...').start();
  try {
    execSync(`${composeCmd} -f "${composePath}" up -d`, {
      stdio: opts.verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout: 180_000,
    });
    upSpinner.succeed('Docker containers started');
  } catch (err) {
    upSpinner.fail('Failed to start Docker containers');
    throw err;
  }

  await deps.waitForHealth(qdrantHealthUrl(opts.qdrantUrl), 'Qdrant');
  await deps.waitForHealth('http://localhost:9876/health', 'MCP server');
  await deps.waitForHealth('http://localhost:9877/health', 'Indexer');

  // 10. Ollama model registration on host (when native)
  if (ollamaDecision.setupHostOllama) {
    await ensureLocalOllama(deps, cleanupTasks);
  }

  // 11. MCP-client wiring
  configureCursorMcp('http://localhost:9876/mcp', deps);

  // 12. Final summary
  console.log(chalk.bold.green('\n✓ Installation complete!\n'));
  console.log('Next steps:');
  console.log(chalk.dim(`  • Add a project:       paparats add <path-or-repo>`));
  console.log(chalk.dim(`  • List projects:       paparats list`));
  console.log(chalk.dim(`  • Edit project list:   paparats edit projects`));
  console.log(chalk.dim(`  • Edit compose:        paparats edit compose`));
  console.log(chalk.dim(`  • Stack lifecycle:     paparats start | stop | restart\n`));
  console.log(chalk.dim('MCP endpoints:'));
  console.log(chalk.dim('  http://localhost:9876/mcp'));
  console.log(chalk.dim('  http://localhost:9876/support/mcp'));
  console.log('');
}

// ── Support mode ────────────────────────────────────────────────────────────

async function runSupportInstall(
  opts: InstallOptions,
  deps: Pick<
    ResolvedDeps,
    'waitForHealth' | 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'
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
  console.log('  get_chunk_meta, search_changes, explain_feature, recent_changes, impact_analysis');
  console.log('');
  console.log(
    chalk.dim('Note: If the server uses PAPARATS_PROJECTS, searches are automatically scoped.')
  );
  console.log(
    chalk.dim('Project names are directory basenames (e.g. "billing" not "org/billing").\n')
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function qdrantHealthUrl(qdrantUrl?: string): string {
  return qdrantUrl ? `${qdrantUrl.replace(/\/$/, '')}/healthz` : 'http://localhost:6333/healthz';
}

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
  const resolved: ResolvedDeps = {
    commandExists: deps?.commandExists ?? commandExists,
    getDockerComposeCommand: deps?.getDockerComposeCommand ?? getDockerComposeCommand,
    ollamaModelExists: deps?.ollamaModelExists ?? ollamaModelExists,
    isOllamaRunning: deps?.isOllamaRunning ?? isOllamaRunning,
    waitForHealth: deps?.waitForHealth ?? waitForHealth,
    downloadFile: deps?.downloadFile ?? downloadFile,
    generateCompose: deps?.generateCompose ?? generateCompose,
    mkdirSync: deps?.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true })),
    readFileSync: deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8')),
    writeFileSync: deps?.writeFileSync ?? fs.writeFileSync.bind(fs),
    existsSync: deps?.existsSync ?? fs.existsSync.bind(fs),
    unlinkSync: deps?.unlinkSync ?? fs.unlinkSync.bind(fs),
    renameSync: deps?.renameSync ?? fs.renameSync.bind(fs),
    platform: deps?.platform ?? (() => process.platform),
    execSync: deps?.execSync ?? (execSync as unknown as ResolvedDeps['execSync']),
    ...(deps?.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps?.promptUseExternalQdrant !== undefined
      ? { promptUseExternalQdrant: deps.promptUseExternalQdrant }
      : {}),
    ...(deps?.promptQdrantUrl !== undefined ? { promptQdrantUrl: deps.promptQdrantUrl } : {}),
    ...(deps?.promptQdrantApiKey !== undefined
      ? { promptQdrantApiKey: deps.promptQdrantApiKey }
      : {}),
    ...(deps?.promptOllamaChoiceMacOs !== undefined
      ? { promptOllamaChoiceMacOs: deps.promptOllamaChoiceMacOs }
      : {}),
    ...(deps?.promptRemoteOllamaUrl !== undefined
      ? { promptRemoteOllamaUrl: deps.promptRemoteOllamaUrl }
      : {}),
    ...(deps?.promptOverwriteCompose !== undefined
      ? { promptOverwriteCompose: deps.promptOverwriteCompose }
      : {}),
    ...(deps?.promptMigrate !== undefined ? { promptMigrate: deps.promptMigrate } : {}),
  };

  const mode = opts.mode ?? 'developer';
  console.log(chalk.bold(`\npaparats install${mode === 'support' ? ' --mode support' : ''}\n`));

  if (mode === 'support') {
    await runSupportInstall(opts, resolved);
    return;
  }

  await runUnifiedInstall(opts, resolved);
}

export const installCommand = new Command('install')
  .description('Set up Paparats — Docker stack, Ollama, MCP wiring')
  .option(
    '--mode <mode>',
    'support to wire up an MCP client only; otherwise the unified install runs',
    'developer'
  )
  .option(
    '--ollama-mode <mode>',
    'Force Ollama mode: native | docker (default: native on macOS, docker elsewhere)'
  )
  .option('--ollama-url <url>', 'External Ollama URL (skips both native and docker Ollama)')
  .option('--qdrant-url <url>', 'External Qdrant URL (skips Qdrant Docker container)')
  .option('--qdrant-api-key <key>', 'Qdrant API key for authenticated access')
  .option('--server <url>', 'Server URL to connect to (support mode)', 'http://localhost:9876')
  .option('--force', 'Skip overwrite/migration prompts (always overwrite)')
  .option('--non-interactive', 'Fail on any prompt instead of asking')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: InstallOptions & { ollamaMode?: string }) => {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    try {
      await runInstall(
        { ...opts, ollamaMode: opts.ollamaMode as OllamaMode | undefined },
        { signal: controller.signal }
      );
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
