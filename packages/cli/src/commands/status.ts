import { Command } from 'commander';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { findConfigDir, readConfig, CONFIG_FILE } from '../config.js';
import { ApiClient } from '../api-client.js';

export interface StatusOptions {
  server?: string;
  timeout?: number;
  json?: boolean;
  verbose?: boolean;
}

export interface HealthResponseData {
  status: string;
  groups: Record<string, number>;
  uptime: number;
  memory: { heapUsed: string; percent: number };
}

export function validateHealthResponse(data: unknown): data is HealthResponseData {
  if (!data || typeof data !== 'object') return false;

  const d = data as Partial<HealthResponseData>;

  return (
    typeof d.status === 'string' &&
    typeof d.groups === 'object' &&
    d.groups !== null &&
    typeof d.uptime === 'number' &&
    typeof d.memory === 'object' &&
    d.memory !== null
  );
}

export interface StatusDeps {
  dockerStatus?: () => { qdrant: string; mcp: string };
  ollamaStatus?: (modelName: string) => string;
  findConfigDir?: (startDir?: string) => string | null;
  readConfig?: (dir?: string) => {
    config: { group: string; language: string | string[]; embeddings?: { model?: string } };
  };
  healthCheck?: (url: string, timeout: number) => Promise<{ status: number; data: unknown }>;
}

export function dockerStatus(): { qdrant: string; mcp: string } {
  const result = { qdrant: 'not running', mcp: 'not running' };
  try {
    const output = execSync('docker ps --format "{{.Names}}|{{.Status}}"', {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const line of output.split('\n')) {
      const [name, status] = line.split('|');
      if (name && name.includes('qdrant')) {
        result.qdrant = status?.trim() || 'running';
      }
      if (name && name.includes('mcp')) {
        result.mcp = status?.trim() || 'running';
      }
    }
  } catch {
    // Docker not available or error
  }
  return result;
}

export function ollamaStatus(modelName = 'jina-code-embeddings'): string {
  try {
    const output = execSync('ollama list', {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output.includes(modelName)) return 'model ready';
    return 'running (model not found)';
  } catch {
    return 'not running';
  }
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

function formatMemory(heapUsed: string): string {
  const memoryMB = parseInt(heapUsed, 10);
  if (Number.isNaN(memoryMB)) return heapUsed;
  return memoryMB > 1000 ? `${(memoryMB / 1024).toFixed(1)} GB` : `${memoryMB} MB`;
}

export interface StatusResult {
  docker: { qdrant: string; mcp: string };
  ollama: string;
  config: {
    found: boolean;
    group?: string;
    language?: string;
    error?: string;
  };
  server: {
    ok: boolean;
    status?: string;
    uptime?: number;
    memory?: string;
    percent?: number;
    groups?: Record<string, number>;
    error?: string;
  };
  timestamp: string;
}

export async function runStatus(opts: StatusOptions, deps?: StatusDeps): Promise<StatusResult> {
  const getDockerStatus = deps?.dockerStatus ?? dockerStatus;
  const getOllamaStatus = deps?.ollamaStatus ?? ollamaStatus;
  const findCfgDir = deps?.findConfigDir ?? findConfigDir;
  const readCfg = deps?.readConfig ?? readConfig;
  const healthCheck = deps?.healthCheck;

  const serverUrl = opts.server ?? 'http://localhost:9876';
  const timeout = opts.timeout ?? 5_000;

  const result: StatusResult = {
    docker: { qdrant: 'not running', mcp: 'not running' },
    ollama: 'not running',
    config: { found: false },
    server: { ok: false },
    timestamp: new Date().toISOString(),
  };

  // Docker
  const docker = getDockerStatus();
  result.docker = docker;

  // Ollama — read model from config
  let modelName = 'jina-code-embeddings';
  const configDir = findCfgDir();
  if (configDir) {
    try {
      const { config } = readCfg(configDir);
      modelName = config.embeddings?.model ?? modelName;
    } catch {
      // Use default
    }
  }
  const ollama = getOllamaStatus(modelName);
  result.ollama = ollama;

  // Config
  if (configDir) {
    try {
      const { config } = readCfg(configDir);
      result.config = {
        found: true,
        group: config.group,
        language: Array.isArray(config.language) ? config.language.join(', ') : config.language,
      };
    } catch (err) {
      result.config = { found: true, error: (err as Error).message };
    }
  }

  // Server health
  if (healthCheck) {
    try {
      const res = await healthCheck(serverUrl, timeout);
      if (res.status === 200) {
        if (validateHealthResponse(res.data)) {
          const data = res.data;
          result.server = {
            ok: true,
            status: data.status,
            uptime: data.uptime,
            memory: formatMemory(data.memory.heapUsed),
            percent: data.memory.percent,
            groups: data.groups,
          };
        } else {
          result.server = { ok: true, error: 'invalid response' };
        }
      } else {
        result.server = { ok: false, error: 'error' };
      }
    } catch {
      result.server = { ok: false, error: 'unreachable' };
    }
  } else {
    try {
      const client = new ApiClient(serverUrl);
      const res = await client.health({ timeout });
      if (res.status === 200) {
        if (validateHealthResponse(res.data)) {
          const data = res.data;
          result.server = {
            ok: true,
            status: data.status,
            uptime: data.uptime,
            memory: formatMemory(data.memory.heapUsed),
            percent: data.memory.percent,
            groups: data.groups,
          };
        } else {
          result.server = { ok: true, error: 'invalid response' };
        }
      } else {
        result.server = { ok: false, error: 'error' };
      }
    } catch {
      result.server = { ok: false, error: 'unreachable' };
    }
  }

  return result;
}

function outputStatus(result: StatusResult, opts: StatusOptions): void {
  const { docker, ollama, config, server } = result;
  const qdrantOk = docker.qdrant !== 'not running';
  const mcpOk = docker.mcp !== 'not running';
  const ollamaOk = ollama === 'model ready';

  if (opts.json) {
    const jsonData = {
      docker,
      ollama,
      config,
      server: server.ok
        ? {
            status: server.status,
            uptime: server.uptime,
            memory: server.memory,
            memoryPercent: server.percent,
            groups: server.groups,
          }
        : { error: server.error },
      timestamp: result.timestamp,
    };
    console.log(JSON.stringify(jsonData, null, 2));
    return;
  }

  console.log(chalk.bold('\npaparats status\n'));

  // Docker
  console.log(`  Qdrant:   ${qdrantOk ? chalk.green(docker.qdrant) : chalk.red(docker.qdrant)}`);
  console.log(`  MCP:      ${mcpOk ? chalk.green(docker.mcp) : chalk.red(docker.mcp)}`);

  // Ollama
  console.log(`  Ollama:   ${ollamaOk ? chalk.green(ollama) : chalk.yellow(ollama)}`);

  // Config
  if (config.found) {
    if (config.error) {
      console.log(`  Config:   ${chalk.red(`invalid: ${config.error}`)}`);
    } else {
      console.log(`  Config:   ${chalk.green(CONFIG_FILE + ' found')}`);
      console.log(`  Group:    ${chalk.bold(config.group ?? '')}`);
      console.log(`  Language: ${config.language ?? ''}`);
    }
  } else {
    console.log(`  Config:   ${chalk.dim('no ' + CONFIG_FILE + ' in current directory')}`);
  }

  // Server
  if (server.ok) {
    if (server.error === 'invalid response') {
      console.log(`  Server:   ${chalk.yellow('running (invalid response)')}`);
    } else {
      console.log(`  Server:   ${chalk.green(server.status ?? 'ok')}`);
      if (server.uptime !== undefined) {
        console.log(`  Uptime:   ${chalk.dim(formatUptime(server.uptime))}`);
      }
      if (server.memory !== undefined && server.percent !== undefined) {
        console.log(`  Memory:   ${chalk.dim(`${server.memory} (${server.percent}%)`)}`);
      }
      const groupEntries = Object.entries(server.groups ?? {});
      if (groupEntries.length > 0) {
        console.log(chalk.bold('\n  Groups:'));
        for (const [name, chunks] of groupEntries) {
          console.log(`    ${name}: ${chunks} chunks`);
        }
      }
    }
  } else {
    console.log(`  Server:   ${chalk.red(server.error ?? 'error')}`);
  }

  // Verbose
  if (opts.verbose) {
    console.log(chalk.dim('\n  Verbose:'));
    try {
      const containers = execSync('docker ps --filter name=paparats --format "{{.ID}}"', {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const ids = containers.trim().split('\n').filter(Boolean);
      if (ids.length > 0) {
        console.log(chalk.dim(`  Container IDs: ${ids.join(', ')}`));
      }
    } catch {
      // Ignore
    }
    try {
      const version = execSync('ollama --version', {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(chalk.dim(`  Ollama version: ${version.trim()}`));
    } catch {
      // Ignore
    }
  }

  console.log();
}

export const statusCommand = new Command('status')
  .description('Show system status')
  .option('--server <url>', 'MCP server URL', 'http://localhost:9876')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '5000')
  .option('--json', 'Output as JSON')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (opts: { server: string; timeout?: string; json?: boolean; verbose?: boolean }) => {
    try {
      const timeout = opts.timeout !== undefined ? parseInt(opts.timeout, 10) : 5_000;
      if (Number.isNaN(timeout) || timeout <= 0) {
        throw new Error(`Invalid timeout: ${opts.timeout}. Must be a positive number.`);
      }

      const statusOpts: StatusOptions = {
        server: opts.server,
        timeout,
        json: opts.json,
        verbose: opts.verbose,
      };

      const result = await runStatus(statusOpts);
      outputStatus(result, statusOpts);

      const qdrantOk = result.docker.qdrant !== 'not running';
      const mcpOk = result.docker.mcp !== 'not running';
      const ollamaOk = result.ollama === 'model ready';
      const criticalDown = !qdrantOk || !mcpOk || !ollamaOk;

      if (criticalDown && !opts.json) {
        console.log(chalk.yellow('\n⚠ Some critical services are not running'));
        console.log(chalk.dim('Run `paparats install` or `docker compose up -d`'));
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });
