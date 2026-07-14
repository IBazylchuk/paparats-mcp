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
import type { EmbeddingProvider, EmbedMode, InstallMode } from '../docker-compose-generator.js';
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
const EMBED_CONFIG_FILE = path.join(PAPARATS_HOME, 'llama-swap.yaml');
// Native embed setup: llama.cpp (llama-server) + llama-swap, mirroring the
// ibaz/paparats-embed docker image but with Metal on macOS. Both models are
// downloaded and served through one llama-swap config, routed by model name.
const CODE_MODEL_NAME = 'jina-code-embeddings';
const CODE_GGUF_URL =
  'https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf';
const CODE_GGUF_FILE = path.join(MODELS_DIR, 'jina-code-embeddings-1.5b-Q8_0.gguf');
const TEXT_MODEL_NAME = 'bge-m3';
const TEXT_GGUF_URL = 'https://huggingface.co/KimChen/bge-m3-GGUF/resolve/main/bge-m3-q8_0.gguf';
const TEXT_GGUF_FILE = path.join(MODELS_DIR, 'bge-m3-Q8_0.gguf');

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

export async function isEmbedServerRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/health', {
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
  embedMode?: EmbedMode;
  /** External embed server URL — bypasses native and docker embed server */
  embedUrl?: string;
  /** Embedding backend. 'openai' / 'voyage' skip the local embed server entirely. */
  embeddings?: EmbeddingProvider;
  /** API key for the cloud embedding provider (only used when embeddings is 'openai' or 'voyage'). */
  embeddingApiKey?: string;
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
  isEmbedServerRunning?: () => Promise<boolean>;
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
  promptEmbedChoiceMacOs?: () => Promise<'brew' | 'docker' | 'remote'>;
  promptRemoteEmbedUrl?: () => Promise<string>;
  promptOverwriteCompose?: () => Promise<boolean>;
  promptMigrate?: () => Promise<boolean>;
  promptEmbeddingProvider?: () => Promise<EmbeddingProvider>;
  promptEmbeddingApiKey?: (provider: EmbeddingProvider) => Promise<string>;
  /** Read env vars (defaults to process.env). Injected for tests. */
  env?: NodeJS.ProcessEnv;
  platform?: () => NodeJS.Platform;
  execSync?: (cmd: string, opts?: object) => Buffer | string;
}

// ── Shared native embed setup (llama.cpp + llama-swap) ──────────────────────

interface EmbedSetupDeps {
  commandExists: (cmd: string) => boolean;
  isEmbedServerRunning: () => Promise<boolean>;
  downloadFile: (url: string, dest: string, signal?: AbortSignal) => Promise<void>;
  mkdirSync: (dir: string) => void;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
  execSync: (cmd: string, opts?: object) => Buffer | string;
  signal?: AbortSignal;
}

/** Render the native llama-swap config \u2014 mirrors the docker image's template
 *  (per-model pooling: jina-code -> last, bge-m3 -> cls). */
function renderLlamaSwapConfig(): string {
  return `# paparats-embed \u2014 native llama-swap config (generated by paparats install)
healthCheckTimeout: 300
startPort: 10001

macros:
  llama-embed: >
    llama-server
    --host 127.0.0.1 --port \${PORT}
    --embeddings --ctx-size 8192 --batch-size 8192 --ubatch-size 8192

models:
  ${CODE_MODEL_NAME}:
    cmd: |
      \${llama-embed}
      --model ${CODE_GGUF_FILE}
      --pooling last
    ttl: 300

  ${TEXT_MODEL_NAME}:
    cmd: |
      \${llama-embed}
      --model ${TEXT_GGUF_FILE}
      --pooling cls
    ttl: 300
`;
}

async function downloadModelIfNeeded(
  deps: EmbedSetupDeps,
  cleanupTasks: Array<() => void>,
  label: string,
  url: string,
  dest: string
): Promise<void> {
  if (deps.existsSync(dest)) {
    console.log(chalk.dim(`${label} GGUF already downloaded at ${dest}`));
    return;
  }
  console.log(chalk.bold(`Downloading ${label}...`));
  deps.mkdirSync(MODELS_DIR);
  cleanupTasks.push(() => {
    if (deps.existsSync(dest)) deps.unlinkSync(dest);
  });
  await deps.downloadFile(url, dest, deps.signal);
  cleanupTasks.pop();
  console.log(chalk.green(`\u2713 ${label} downloaded`));
}

async function brewInstall(
  deps: EmbedSetupDeps,
  binary: string,
  formula: string,
  timeoutMs: number
): Promise<void> {
  if (deps.commandExists(binary)) return;
  if (!deps.commandExists('brew')) {
    throw new Error(
      `${binary} not found and Homebrew is unavailable. Install it (brew install ${formula}) ` +
        'or use --embed-mode docker / --embed-url <url>.'
    );
  }
  const s = ora(`Installing ${formula} via brew...`).start();
  try {
    deps.execSync(`brew install ${formula}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    s.succeed(`${formula} installed`);
  } catch (err) {
    s.fail(`brew install ${formula} failed`);
    throw err;
  }
}

/**
 * Ensure a native embedding server (llama.cpp + llama-swap) is installed,
 * configured, and running. Mirrors the ibaz/paparats-embed docker image but uses
 * Metal on macOS. Used by developer/server install when embedMode is 'native'.
 */
async function ensureLocalEmbed(
  deps: EmbedSetupDeps,
  cleanupTasks: Array<() => void>
): Promise<void> {
  await brewInstall(deps, 'llama-server', 'llama.cpp', 300_000);
  await brewInstall(deps, 'llama-swap', 'mostlygeek/tap/llama-swap', 180_000);

  await downloadModelIfNeeded(
    deps,
    cleanupTasks,
    'jina-code-embeddings (~1.65 GB)',
    CODE_GGUF_URL,
    CODE_GGUF_FILE
  );
  await downloadModelIfNeeded(
    deps,
    cleanupTasks,
    'bge-m3 (~600 MB)',
    TEXT_GGUF_URL,
    TEXT_GGUF_FILE
  );

  deps.writeFileSync(EMBED_CONFIG_FILE, renderLlamaSwapConfig());
  console.log(chalk.dim(`Wrote llama-swap config to ${EMBED_CONFIG_FILE}`));

  const spinner = ora('Starting native embedding server (llama-swap)...').start();
  try {
    if (await deps.isEmbedServerRunning()) {
      spinner.succeed('Embedding server already running');
      return;
    }
    // Detached llama-swap on the Ollama-compatible host port so the EMBED_URL
    // default (http://127.0.0.1:11434) resolves without extra config.
    spawn('llama-swap', ['--config', EMBED_CONFIG_FILE, '--listen', '127.0.0.1:11434'], {
      stdio: 'ignore',
      detached: true,
    }).unref();
    await new Promise((r) => setTimeout(r, 3000));
    if (!(await deps.isEmbedServerRunning())) {
      throw new Error(
        `Failed to start llama-swap. Start it manually: llama-swap --config ${EMBED_CONFIG_FILE} --listen 127.0.0.1:11434`
      );
    }
    spinner.succeed(
      `Native embedding server running (models: ${CODE_MODEL_NAME}, ${TEXT_MODEL_NAME})`
    );
  } catch (err) {
    spinner.fail('Failed to start native embedding server');
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
  isEmbedServerRunning: () => Promise<boolean>;
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
  promptEmbedChoiceMacOs?: () => Promise<'brew' | 'docker' | 'remote'>;
  promptRemoteEmbedUrl?: () => Promise<string>;
  promptOverwriteCompose?: () => Promise<boolean>;
  promptMigrate?: () => Promise<boolean>;
  promptEmbeddingProvider?: () => Promise<EmbeddingProvider>;
  promptEmbeddingApiKey?: (provider: EmbeddingProvider) => Promise<string>;
  env: NodeJS.ProcessEnv;
  platform: () => NodeJS.Platform;
  execSync: (cmd: string, opts?: object) => Buffer | string;
  signal?: AbortSignal;
}

// ── Decide embed mode ───────────────────────────────────────────────────────

export interface EmbedDecision {
  mode: EmbedMode;
  embedUrl?: string;
  /** Should the host-side `ensureLocalEmbed` (install + download + serve) run? */
  setupHostEmbed: boolean;
}

export async function decideEmbedMode(
  opts: InstallOptions,
  deps: ResolvedDeps
): Promise<EmbedDecision> {
  if (opts.embedUrl) {
    return { mode: 'external', embedUrl: opts.embedUrl, setupHostEmbed: false };
  }
  if (opts.embedMode === 'docker') {
    return { mode: 'docker', setupHostEmbed: false };
  }
  if (opts.embedMode === 'native') {
    return { mode: 'native', setupHostEmbed: true };
  }

  const platform = deps.platform();
  if (platform === 'darwin') {
    if (deps.commandExists('llama-server') && deps.commandExists('llama-swap')) {
      console.log(chalk.green('✓ Native llama-server + llama-swap detected on macOS\n'));
      return { mode: 'native', setupHostEmbed: true };
    }
    console.log(
      chalk.yellow('Native embedding server (llama.cpp + llama-swap) is not installed.\n') +
        chalk.dim(
          'Recommendation for macOS: install natively. Running the embed server in Docker on\n' +
            'macOS is slower because the Docker VM cannot use Apple Silicon GPU acceleration.\n' +
            'Native llama-server uses Metal directly.\n'
        )
    );
    if (opts.nonInteractive) {
      throw new Error(
        'Native embed server not found. Install with `brew install llama.cpp mostlygeek/tap/llama-swap`, ' +
          'or pass --embed-mode docker / --embed-url <url>.'
      );
    }
    const choice = deps.promptEmbedChoiceMacOs
      ? await deps.promptEmbedChoiceMacOs()
      : await select({
          message: 'How should Paparats reach the embedding server?',
          choices: [
            {
              name: 'Install natively via brew (llama.cpp + llama-swap, recommended)',
              value: 'brew',
            },
            { name: 'Use a remote embed server URL', value: 'remote' },
            { name: 'Run the embed server in Docker (slower on macOS)', value: 'docker' },
          ],
          default: 'brew',
        });
    if (choice === 'brew') {
      // Actual brew install happens in ensureLocalEmbed (it also downloads models
      // and starts llama-swap), so just select native here.
      return { mode: 'native', setupHostEmbed: true };
    }
    if (choice === 'remote') {
      const url = deps.promptRemoteEmbedUrl
        ? await deps.promptRemoteEmbedUrl()
        : await input({ message: 'Remote embed server URL:' });
      return { mode: 'external', embedUrl: url, setupHostEmbed: false };
    }
    return { mode: 'docker', setupHostEmbed: false };
  }

  return { mode: 'docker', setupHostEmbed: false };
}

// ── Decide embedding provider ───────────────────────────────────────────────

export interface EmbeddingDecision {
  provider: EmbeddingProvider;
  /** Cloud API key. Persisted to ~/.paparats/.env so the compose substitution resolves. */
  apiKey?: string;
}

const EMBEDDING_KEY_VAR: Record<Exclude<EmbeddingProvider, 'llama'>, string> = {
  openai: 'OPENAI_API_KEY',
  voyage: 'VOYAGE_API_KEY',
};

export async function decideEmbeddingProvider(
  opts: InstallOptions,
  deps: ResolvedDeps
): Promise<EmbeddingDecision> {
  let provider: EmbeddingProvider;

  if (opts.embeddings) {
    provider = opts.embeddings;
  } else if (opts.nonInteractive) {
    provider = 'llama';
  } else {
    provider = deps.promptEmbeddingProvider
      ? await deps.promptEmbeddingProvider()
      : await select({
          message: 'Which embedding provider should Paparats use?',
          choices: [
            {
              name: 'Local llama.cpp (private, free, ~2.3 GB image, fast; Metal on macOS)',
              value: 'llama' as EmbeddingProvider,
            },
            {
              name: 'OpenAI text-embedding-3-small (fast, paid, requires API key)',
              value: 'openai' as EmbeddingProvider,
            },
            {
              name: 'Voyage voyage-code-3 (code-tuned, paid, requires API key)',
              value: 'voyage' as EmbeddingProvider,
            },
          ],
          default: 'llama',
        });
  }

  if (provider === 'llama') {
    return { provider };
  }

  // Cloud — need an API key. Precedence: explicit flag → env var → prompt.
  const envVar = EMBEDDING_KEY_VAR[provider];
  let apiKey = opts.embeddingApiKey?.trim();
  if (!apiKey) {
    apiKey = deps.env[envVar]?.trim();
  }
  if (!apiKey) {
    if (opts.nonInteractive) {
      throw new Error(
        `--embeddings ${provider} requires an API key. ` +
          `Pass --embedding-api-key <key> or set ${envVar}.`
      );
    }
    apiKey = deps.promptEmbeddingApiKey
      ? await deps.promptEmbeddingApiKey(provider)
      : await input({
          message: `${envVar}:`,
          validate: (v: string) => v.trim().length > 0 || 'Key cannot be empty',
        });
    apiKey = apiKey.trim();
  }

  return { provider, apiKey };
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

  // 3. Embedding provider decision (asked first — cloud providers short-circuit local embed)
  const embeddingDecision = await decideEmbeddingProvider(opts, deps);
  if (embeddingDecision.provider !== 'llama') {
    console.log(
      chalk.green(
        `✓ Embeddings: ${embeddingDecision.provider} (cloud) — local embed service skipped\n`
      )
    );
  }

  // 4. Embed-server decision (only if we need it). Cloud providers get a dummy
  //    decision so downstream code that reads embedMode still works; the compose
  //    generator drops the embed service either way.
  const embedDecision =
    embeddingDecision.provider === 'llama'
      ? await decideEmbedMode(opts, deps)
      : ({ mode: 'docker', setupHostEmbed: false } as EmbedDecision);

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
    embedMode: embedDecision.mode,
    ...(embedDecision.embedUrl !== undefined ? { embedUrl: embedDecision.embedUrl } : {}),
    embeddingProvider: embeddingDecision.provider,
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
  //     regenerate compose later with the same flags (embed mode, qdrant
  //     credentials, cron). Without this, those commands have no idea which
  //     services should be in the compose.
  writeInstallState(
    {
      embedMode: embedDecision.mode,
      ...(embedDecision.embedUrl !== undefined ? { embedUrl: embedDecision.embedUrl } : {}),
      embeddingProvider: embeddingDecision.provider,
      ...(opts.qdrantUrl !== undefined ? { qdrantUrl: opts.qdrantUrl } : {}),
      ...(opts.qdrantApiKey !== undefined ? { qdrantApiKey: opts.qdrantApiKey } : {}),
    },
    PAPARATS_HOME
  );

  // 8. .env file — merge our keys into any existing file so user-added entries
  //    (HTTP_PROXY, custom compose substitutions, …) survive re-runs of install.
  const updates: Record<string, string> = {};
  if (opts.qdrantApiKey) updates['QDRANT_API_KEY'] = opts.qdrantApiKey;
  if (embeddingDecision.apiKey && embeddingDecision.provider !== 'llama') {
    updates[EMBEDDING_KEY_VAR[embeddingDecision.provider]] = embeddingDecision.apiKey;
  }
  if (Object.keys(updates).length > 0) {
    const existing = deps.existsSync(envPath) ? deps.readFileSync(envPath, 'utf8') : '';
    const merged = mergeDotenv(existing, updates);
    deps.writeFileSync(envPath, merged);
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

  // 10. Native embed server setup on host (when native)
  if (embedDecision.setupHostEmbed) {
    await ensureLocalEmbed(deps, cleanupTasks);
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

/**
 * Merge `updates` into an existing dotenv file content. Preserves order,
 * comments, and blank lines for keys we don't touch; updates matching keys
 * in place; appends new keys at the end. Quoting follows the input style:
 * values are written raw (no quoting), matching how the rest of the codebase
 * reads .env via shell substitution.
 */
export function mergeDotenv(existing: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = existing === '' ? [] : existing.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && remaining.has(match[1]!)) {
      const key = match[1]!;
      out.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }
  // Drop a trailing empty line so we don't accumulate blank lines on re-runs.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of remaining) {
    out.push(`${key}=${value}`);
  }
  return out.join('\n') + '\n';
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
    isEmbedServerRunning: deps?.isEmbedServerRunning ?? isEmbedServerRunning,
    waitForHealth: deps?.waitForHealth ?? waitForHealth,
    downloadFile: deps?.downloadFile ?? downloadFile,
    generateCompose: deps?.generateCompose ?? generateCompose,
    mkdirSync: deps?.mkdirSync ?? ((p: string) => fs.mkdirSync(p, { recursive: true })),
    readFileSync: deps?.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf8')),
    writeFileSync: deps?.writeFileSync ?? fs.writeFileSync.bind(fs),
    existsSync: deps?.existsSync ?? fs.existsSync.bind(fs),
    unlinkSync: deps?.unlinkSync ?? fs.unlinkSync.bind(fs),
    renameSync: deps?.renameSync ?? fs.renameSync.bind(fs),
    env: deps?.env ?? process.env,
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
    ...(deps?.promptEmbedChoiceMacOs !== undefined
      ? { promptEmbedChoiceMacOs: deps.promptEmbedChoiceMacOs }
      : {}),
    ...(deps?.promptRemoteEmbedUrl !== undefined
      ? { promptRemoteEmbedUrl: deps.promptRemoteEmbedUrl }
      : {}),
    ...(deps?.promptOverwriteCompose !== undefined
      ? { promptOverwriteCompose: deps.promptOverwriteCompose }
      : {}),
    ...(deps?.promptMigrate !== undefined ? { promptMigrate: deps.promptMigrate } : {}),
    ...(deps?.promptEmbeddingProvider !== undefined
      ? { promptEmbeddingProvider: deps.promptEmbeddingProvider }
      : {}),
    ...(deps?.promptEmbeddingApiKey !== undefined
      ? { promptEmbeddingApiKey: deps.promptEmbeddingApiKey }
      : {}),
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
  .description('Set up Paparats — Docker stack, embedding server, MCP wiring')
  .option(
    '--mode <mode>',
    'support to wire up an MCP client only; otherwise the unified install runs',
    'developer'
  )
  .option(
    '--embed-mode <mode>',
    'Force embed-server mode: native | docker (default: native on macOS, docker elsewhere)'
  )
  .option('--embed-url <url>', 'External embed server URL (skips both native and docker embed)')
  .option(
    '--embeddings <provider>',
    'Embedding backend: llama | openai | voyage (default: llama). ' +
      'openai/voyage skip the local embed service entirely.'
  )
  .option(
    '--embedding-api-key <key>',
    'API key for the chosen cloud embedding provider. ' +
      'Alternatively set OPENAI_API_KEY / VOYAGE_API_KEY.'
  )
  .option('--qdrant-url <url>', 'External Qdrant URL (skips Qdrant Docker container)')
  .option('--qdrant-api-key <key>', 'Qdrant API key for authenticated access')
  .option('--server <url>', 'Server URL to connect to (support mode)', 'http://localhost:9876')
  .option('--force', 'Skip overwrite/migration prompts (always overwrite)')
  .option('--non-interactive', 'Fail on any prompt instead of asking')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: InstallOptions & { embedMode?: string; embeddings?: string }) => {
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    if (opts.embeddings && !['llama', 'openai', 'voyage'].includes(opts.embeddings)) {
      console.error(
        chalk.red(
          `Invalid --embeddings value "${opts.embeddings}". Expected: llama | openai | voyage.`
        )
      );
      process.exit(1);
    }

    try {
      await runInstall(
        {
          ...opts,
          embedMode: opts.embedMode as EmbedMode | undefined,
          embeddings: opts.embeddings as EmbeddingProvider | undefined,
        },
        { signal: controller.signal }
      );
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
