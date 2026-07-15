import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { getDockerComposeCommand } from './install.js';
import { waitForHealth } from './install.js';
import { setupNativeEmbed } from './install.js';
import { commandExists as realCommandExists } from './install.js';
import {
  readInstallState,
  regenerateCompose,
  type RegenerateOptions,
  type RegenerateResult,
} from '../projects-yml.js';

const PAPARATS_HOME = path.join(os.homedir(), '.paparats');
const COMPOSE_FILE = path.join(PAPARATS_HOME, 'docker-compose.yml');
const EMBED_CONFIG_FILE = path.join(PAPARATS_HOME, 'llama-swap.yaml');
const NPM_PACKAGE = '@paparats/cli';

/** Version of the *currently running* CLI, read from its own on-disk
 *  package.json by walking up from this module's location until a package.json
 *  named `@paparats/cli` is found.
 *
 *  Deliberately NOT `npm ls -g`: that resolves `npm` from PATH — the same npm
 *  the preceding `npm install -g` used — so in the exact failure this guard
 *  targets (the running `paparats` from one node/nvm prefix, `npm` in PATH from
 *  another), install lands in prefix B and `npm ls -g` cheerfully reports B as
 *  up-to-date while the running binary (prefix A) stays stale. Reading the
 *  running module's own package.json reflects the binary actually executing.
 *  Returns null if it can't be determined. */
function readInstalledCliVersion(): string | null {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (dir !== path.parse(dir).root) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === NPM_PACKAGE) return parsed.version ?? null;
      }
      dir = path.dirname(dir);
    }
  } catch {
    return null;
  }
  return null;
}

/** Latest version published to npm. Null if the registry can't be reached. */
function readNpmLatestVersion(): string | null {
  try {
    return execSync(`npm view ${NPM_PACKAGE} version`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export interface UpdateOptions {
  skipCli?: boolean;
  skipDocker?: boolean;
  skipEmbed?: boolean;
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
  setupNativeEmbed?: () => Promise<void>;
  commandExists?: (cmd: string) => boolean;
  platform?: () => NodeJS.Platform;
  readInstalledCliVersion?: () => string | null;
  readNpmLatestVersion?: () => string | null;
}

/** Check whether a service is declared under the top-level `services:` block.
 *
 *  Scoped to `services:` on purpose: a naive `^  <name>:` match on the whole
 *  file would also hit a same-name key under `volumes:`/`networks:` (both
 *  indented two spaces). We enter the block on `services:` and leave it at the
 *  next column-0 key (`/^\S/`, which also stops on a comment at column 0). */
function composeHasService(composeContent: string, service: string): boolean {
  const servicePattern = new RegExp(`^  ${service}:`);
  let inServices = false;
  for (const raw of composeContent.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices) {
      if (/^\S/.test(line)) break; // next top-level key → out of services
      if (servicePattern.test(line)) return true;
    }
  }
  return false;
}

interface EmbedRefreshDecision {
  refresh: boolean;
  reason: string;
}

/** Decide whether `update` should (re)install the native embed server.
 *
 *  The clean signal is install.json's embedMode — but only when it is actually
 *  set. Installs from before that field existed have an install.json with no
 *  embedMode (undefined); hand-rolled installs have no install.json at all. In
 *  both cases the old code silently skipped the embed step, leaving the host
 *  with no running embed backend after the Ollama→llama-server migration.
 *
 *  So embedMode decides ONLY when it is a known value:
 *    - `native`             → refresh
 *    - `docker`/`external`  → skip
 *  Otherwise (embedMode undefined, or no install.json) we fall through to
 *  detection by artifacts + compose contents:
 *    - llama-swap or llama-server already on PATH   → native embed in use
 *    - ~/.paparats/llama-swap.yaml present          → native embed configured
 *    - docker-compose.yml exists WITHOUT an `embed`
 *      service (Qdrant+server in Docker, embed on
 *      the host) → native embed is in use           → refresh
 *    - no compose at all on macOS                    → native is the default there
 *
 *  The compose-contents check is the key signal for hosts that upgraded from
 *  the Ollama era: those developer installs always wrote a docker-compose.yml
 *  (Qdrant + server) but ran embeddings natively — so "compose present" alone
 *  never meant "embed is Dockerised". We must look at whether the compose file
 *  actually declares an `embed` service. */
function decideEmbedRefresh(deps: {
  state: ReturnType<typeof readInstallState>;
  commandExists: (cmd: string) => boolean;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: 'utf8') => string;
  platform: () => NodeJS.Platform;
}): EmbedRefreshDecision {
  const { state, commandExists, existsSync, readFileSync, platform } = deps;

  // Explicit embedMode wins — but only when it is actually set. A truthy
  // `state` with `embedMode === undefined` (pre-embedMode install.json) must
  // NOT short-circuit to skip; it falls through to artifact/compose detection.
  if (state?.embedMode === 'native') {
    return { refresh: true, reason: 'install.json embedMode=native' };
  }
  if (state?.embedMode === 'docker' || state?.embedMode === 'external') {
    return { refresh: false, reason: `install.json embedMode=${state.embedMode}` };
  }

  // No decisive embedMode — detect by artifacts + compose contents.
  if (commandExists('llama-swap') || commandExists('llama-server')) {
    return { refresh: true, reason: 'no embedMode; llama-swap/llama-server on PATH' };
  }
  if (existsSync(EMBED_CONFIG_FILE)) {
    return { refresh: true, reason: 'no embedMode; llama-swap.yaml present' };
  }
  if (existsSync(COMPOSE_FILE)) {
    // A Dockerised embed (`embed` service present) is self-updated by
    // `docker compose pull` above, so never run native setup for it —
    // regardless of platform.
    let composeHasEmbed = false;
    try {
      composeHasEmbed = composeHasService(readFileSync(COMPOSE_FILE, 'utf8'), 'embed');
    } catch {
      // Unreadable compose — fall through to the platform default below.
    }
    if (composeHasEmbed) {
      return { refresh: false, reason: 'no embedMode; docker-compose.yml runs an embed service' };
    }
    // Compose without an embed service means the embed runs natively — but
    // native embed is only supported on macOS (Homebrew llama.cpp/llama-swap).
    // On Linux/Windows this configuration is external/manual, so don't try to
    // brew-install; fall through to the non-macOS default (refresh: false).
    if (platform() === 'darwin') {
      return { refresh: true, reason: 'no embedMode; docker-compose.yml has no embed service' };
    }
    return { refresh: false, reason: 'no embedMode; non-macOS compose without embed service' };
  }
  if (platform() === 'darwin') {
    return { refresh: true, reason: 'no embedMode; macOS host without docker-compose.yml' };
  }
  return { refresh: false, reason: 'no embedMode; no native-embed signals detected' };
}

export async function runUpdate(opts: UpdateOptions, deps?: UpdateDeps): Promise<void> {
  const exec = deps?.execSync ?? execSync;
  const getCompose = deps?.getDockerComposeCommand ?? getDockerComposeCommand;
  const waitHealth = deps?.waitForHealth ?? waitForHealth;
  const exists = deps?.existsSync ?? fs.existsSync.bind(fs);
  const readFile = deps?.readFileSync ?? fs.readFileSync.bind(fs);
  const readInstall = deps?.readInstallState ?? readInstallState;
  const regenerate = deps?.regenerateCompose ?? regenerateCompose;
  const setupEmbed = deps?.setupNativeEmbed ?? setupNativeEmbed;
  const commandExists = deps?.commandExists ?? realCommandExists;
  const platform = deps?.platform ?? (() => process.platform);
  const installedVersion = deps?.readInstalledCliVersion ?? readInstalledCliVersion;
  const npmLatest = deps?.readNpmLatestVersion ?? readNpmLatestVersion;

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

    // Verify the install actually took. `npm install -g` can exit 0 without
    // upgrading (a stale/parallel node context, a `paparats` on PATH from a
    // different node/nvm install, or missing global-write perms), leaving the
    // running process on old code — every step below then silently runs the old
    // logic. Fail loudly instead of reporting a false "Update complete".
    const latest = npmLatest();
    const installed = installedVersion();
    if (latest && installed && installed !== latest) {
      throw new Error(
        `CLI did not update: the running ${NPM_PACKAGE} is ${installed}, but npm latest is ${latest}.\n` +
          `  \`npm install -g\` likely wrote to a different node/nvm prefix than the one this ` +
          `\`paparats\` runs from, so the upgrade landed elsewhere.\n` +
          `  Fix: run \`which -a paparats\` and \`npm root -g\` to find the mismatch, then ` +
          `\`npm install -g ${NPM_PACKAGE}@latest\` with the node that owns your PATH \`paparats\`.\n` +
          `  Re-run \`paparats update\` afterward so the new native-embed / compose logic runs.`
      );
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

  // Native embed server lives on the host (not Docker), so `docker compose
  // pull/up` above never touches it. Re-run the embed setup here so a single
  // `paparats update` also installs/refreshes/starts llama-server + llama-swap.
  // Idempotent — no-ops when everything is current.
  if (!opts.skipEmbed) {
    const decision = decideEmbedRefresh({
      state: readInstall(PAPARATS_HOME),
      commandExists,
      existsSync: exists,
      readFileSync: readFile,
      platform,
    });
    if (decision.refresh) {
      // setupNativeEmbed prints its own spinners for each step (brew, download,
      // start), so just announce the section rather than wrapping in a spinner.
      console.log(
        chalk.dim(
          `\nEnsuring native embedding server (llama-server + llama-swap) — ${decision.reason}...`
        )
      );
      await setupEmbed();
    } else {
      // Say why we skipped so a missing embed server isn't a silent surprise.
      console.log(chalk.dim(`\nSkipping native embed refresh (${decision.reason}).`));
    }
  }

  console.log(chalk.bold.green('\n✓ Update complete!\n'));
}

export const updateCommand = new Command('update')
  .description(
    'Update CLI from npm, pull/restart latest server Docker image, and (native installs) refresh the local embed server'
  )
  .option('--skip-cli', 'Skip CLI update (only update Docker)')
  .option('--skip-docker', 'Skip Docker update (only update CLI)')
  .option('--skip-embed', 'Skip native embedding server refresh (native installs only)')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: UpdateOptions) => {
    try {
      await runUpdate(opts);
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
