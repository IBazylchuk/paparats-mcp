import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readConfig, collectProjectFiles, getLanguageFromPath } from '../config.js';
import { ApiClient } from '../api-client.js';

const API_INDEX_BATCH_SIZE = 50;

export interface IndexResponse {
  group: string;
  project: string;
  chunks: number;
  skipped?: number;
  errors?: string[];
}

export function validateIndexResponse(data: unknown): data is IndexResponse {
  if (!data || typeof data !== 'object') return false;

  const d = data as Partial<IndexResponse>;

  return (
    typeof d.group === 'string' && typeof d.project === 'string' && typeof d.chunks === 'number'
  );
}

interface IndexOptions {
  server: string;
  timeout?: number;
  force?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

interface IndexClient {
  health(options?: { timeout?: number }): Promise<{ status: number }>;
  indexContent(
    group: string,
    project: string,
    files: Array<{ path: string; content: string; language?: string }>,
    options?: {
      config?: {
        chunkSize?: number;
        overlap?: number;
        batchSize?: number;
        concurrency?: number;
        languages?: string[];
      };
      force?: boolean;
      timeout?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ status: number; data: unknown }>;
}

interface RunIndexDeps {
  spinner?: ReturnType<typeof ora> | null;
  signal?: AbortSignal;
  collectProjectFiles?: typeof import('../config.js').collectProjectFiles;
}

function outputError(message: string, json: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(chalk.red(message));
  }
  throw new Error('EXIT:1');
}

export function printDryRun(config: {
  config: {
    group: string;
    language: string | string[];
    indexing?: { paths?: string[]; exclude?: string[] };
  };
  projectDir: string;
}): void {
  console.log(chalk.bold('\nDry run mode - no actual indexing\n'));
  console.log(`  ${chalk.dim('Group:')} ${config.config.group}`);
  console.log(`  ${chalk.dim('Project:')} ${config.projectDir}`);
  const lang = config.config.language;
  console.log(`  ${chalk.dim('Language:')} ${Array.isArray(lang) ? lang.join(', ') : lang}`);
  if (config.config.indexing?.paths?.length) {
    console.log(`  ${chalk.dim('Paths:')} ${config.config.indexing.paths.join(', ')}`);
  }
  if (config.config.indexing?.exclude?.length) {
    console.log(`  ${chalk.dim('Exclude:')} ${config.config.indexing.exclude.join(', ')}`);
  }
}

export async function runIndex(
  client: IndexClient,
  projectDir: string,
  group: string,
  config: {
    config: {
      group: string;
      language: string | string[];
      indexing?: { chunkSize?: number; overlap?: number; batchSize?: number; concurrency?: number };
    };
  },
  opts: IndexOptions,
  deps?: RunIndexDeps
): Promise<void> {
  const projectName = path.basename(projectDir);
  const spinner =
    deps?.spinner !== undefined ? deps.spinner : ora(`Indexing ${group}/${projectName}...`).start();
  const start = Date.now();

  const languages = Array.isArray(config.config.language)
    ? config.config.language
    : [config.config.language];
  const indexConfig = {
    chunkSize: config.config.indexing?.chunkSize,
    overlap: config.config.indexing?.overlap,
    batchSize: config.config.indexing?.batchSize,
    concurrency: config.config.indexing?.concurrency,
    languages,
  };

  const collectFiles = deps?.collectProjectFiles ?? collectProjectFiles;
  const files = await collectFiles(projectDir, config.config);
  const filesWithContent: Array<{ path: string; content: string; language?: string }> = [];

  for (const filePath of files) {
    try {
      const buffer = await fs.promises.readFile(filePath);
      if (buffer.includes(0)) continue; // Skip binary
      const content = buffer.toString('utf8');
      if (content.includes('\uFFFD')) continue; // Invalid UTF-8
      if (!content.trim()) continue;
      const relPath = path.relative(projectDir, filePath);
      const projectLangs = Array.isArray(config.config.language)
        ? config.config.language
        : [config.config.language];
      const language = getLanguageFromPath(filePath, projectLangs);
      filesWithContent.push({ path: relPath, content, language });
    } catch (err) {
      spinner?.warn(`  Skipped ${path.relative(projectDir, filePath)}: ${(err as Error).message}`);
    }
  }

  let totalChunks = 0;
  let lastBatchData: Record<string, unknown> = {};

  try {
    for (let i = 0; i < filesWithContent.length; i += API_INDEX_BATCH_SIZE) {
      const batch = filesWithContent.slice(i, i + API_INDEX_BATCH_SIZE);
      const res = await client.indexContent(group, projectName, batch, {
        config: indexConfig,
        force: opts.force && i === 0,
        timeout: opts.timeout ?? 300_000,
        signal: deps?.signal,
      });
      if (res.status !== 200) {
        const data = res.data as Record<string, unknown>;
        spinner?.fail(`Indexing failed: ${data.error ?? 'Unknown error'}`);
        outputError(String(data.error ?? 'Unknown error'), opts.json ?? false);
      }
      const data = res.data as { chunks?: number; skipped?: number; errors?: string[] };
      lastBatchData = data;
      totalChunks += data.chunks ?? 0;
      if (i + API_INDEX_BATCH_SIZE < filesWithContent.length && spinner) {
        spinner.text = `Indexed ${Math.min(i + API_INDEX_BATCH_SIZE, filesWithContent.length)}/${filesWithContent.length} files...`;
      }
    }

    const data = {
      group,
      project: projectName,
      chunks: totalChunks,
      skipped: lastBatchData.skipped,
      errors: lastBatchData.errors,
    };
    if (!validateIndexResponse(data)) {
      spinner?.fail('Invalid response from server');
      outputError('Expected: { group, project, chunks }', opts.json ?? false);
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (opts.json) {
      const result = {
        group: data.group,
        project: data.project,
        chunks: data.chunks,
        skipped: data.skipped,
        errors: data.errors,
        elapsed: parseFloat(elapsed),
        timestamp: new Date().toISOString(),
      };
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    spinner?.succeed(`Indexed ${chalk.bold(data.project)} in group ${chalk.bold(data.group)}`);
    console.log(chalk.dim(`  ${data.chunks} chunks indexed in ${elapsed}s`));

    if (opts.verbose && data.skipped !== undefined && data.skipped > 0) {
      console.log(chalk.dim(`  ${data.skipped} files skipped`));
    }
    if (data.errors && data.errors.length > 0) {
      console.log(chalk.yellow(`  ${data.errors.length} errors encountered`));
      if (opts.verbose) {
        data.errors.forEach((err) => console.log(chalk.yellow(`    - ${err}`)));
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    if (message.startsWith('EXIT:')) {
      const code = parseInt(message.slice(5), 10);
      process.exit(Number.isNaN(code) ? 1 : code);
    }
    if (
      message.includes('aborted') ||
      message.includes('AbortError') ||
      message.includes('Request aborted')
    ) {
      spinner?.fail('Indexing cancelled');
      process.exit(130);
    }
    if (opts.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      spinner?.fail('Indexing failed');
      console.error(chalk.red(message));
    }
    process.exit(1);
  }
}

export const indexCommand = new Command('index')
  .description('Index the current project')
  .option('--server <url>', 'MCP server URL', 'http://localhost:9876')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '300000')
  .option('-f, --force', 'Force reindex (clear existing data)')
  .option('-v, --verbose', 'Show detailed output')
  .option('--dry-run', 'Show what would be indexed without indexing')
  .option('--json', 'Output as JSON')
  .action(
    async (opts: {
      server: string;
      timeout?: string;
      force?: boolean;
      verbose?: boolean;
      dryRun?: boolean;
      json?: boolean;
    }) => {
      let config;
      try {
        config = readConfig();
      } catch (err) {
        const msg = (err as Error).message;
        if (opts.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(msg));
        }
        process.exit(1);
      }

      const { config: projectConfig, projectDir } = config;

      if (opts.dryRun) {
        printDryRun(config);
        return;
      }

      let timeout = 300_000;
      if (opts.timeout) {
        const parsed = parseInt(opts.timeout, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          const msg = `Invalid timeout: ${opts.timeout}. Must be a positive number.`;
          if (opts.json) {
            console.log(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(msg));
          }
          process.exit(1);
        }
        timeout = parsed;
      }

      const client = new ApiClient(opts.server);

      try {
        await client.health({ timeout: 3000 });
      } catch {
        const msg =
          `Cannot connect to server at ${opts.server}\n` +
          'Make sure the server is running with: docker compose up -d';
        if (opts.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(msg));
        }
        process.exit(1);
      }

      const controller = new AbortController();

      let spinner: ReturnType<typeof ora> | null = null;
      const sigintHandler = () => {
        spinner?.stop();
        if (!opts.json) {
          console.log(chalk.yellow('\nIndexing cancelled by user'));
        }
        controller.abort();
        process.exit(130);
      };

      process.on('SIGINT', sigintHandler);

      spinner = opts.json ? null : ora(`Indexing ${projectConfig.group}/${projectDir}...`).start();

      try {
        await runIndex(
          client,
          projectDir,
          projectConfig.group,
          config,
          {
            server: opts.server,
            timeout,
            force: opts.force,
            verbose: opts.verbose,
            json: opts.json,
          },
          { spinner, signal: controller.signal }
        );
      } finally {
        process.off('SIGINT', sigintHandler);
      }
    }
  );
