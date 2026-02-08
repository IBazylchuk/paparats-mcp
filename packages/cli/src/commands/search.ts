import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readConfig } from '../config.js';
import { ApiClient } from '../api-client.js';

export interface SearchResultItem {
  project: string;
  file: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface SearchResponseData {
  results: SearchResultItem[];
  total: number;
  metrics: {
    tokensReturned: number;
    estimatedFullFileTokens: number;
    tokensSaved: number;
    savingsPercent: number;
  };
}

export function validateSearchResponse(data: unknown): data is SearchResponseData {
  if (!data || typeof data !== 'object') return false;

  const d = data as Partial<SearchResponseData>;

  return (
    Array.isArray(d.results) &&
    typeof d.total === 'number' &&
    typeof d.metrics === 'object' &&
    d.metrics !== null
  );
}

export interface SearchOptions {
  limit?: number;
  project?: string;
  group?: string;
  timeout?: number;
  json?: boolean;
  verbose?: boolean;
}

interface SearchClient {
  search(
    group: string,
    query: string,
    opts: { project?: string; limit?: number; timeout?: number; signal?: AbortSignal }
  ): Promise<{ status: number; data: unknown }>;
}

export interface SearchDeps {
  readConfig?: () => { config: { group: string } };
  spinner?: ReturnType<typeof ora> | null;
}

function outputError(message: string, json: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(chalk.red(message));
  }
  throw new Error('EXIT:1');
}

export async function runSearch(
  client: SearchClient,
  query: string,
  opts: SearchOptions,
  deps?: SearchDeps
): Promise<void> {
  const readCfg = deps?.readConfig ?? readConfig;
  const spinner = deps?.spinner !== undefined ? deps.spinner : ora('Searching...').start();

  let group = opts.group;
  if (!group) {
    try {
      const config = readCfg();
      group = config.config.group;
    } catch (err) {
      spinner?.stop();
      outputError((err as Error).message, opts.json ?? false);
    }
  }

  const limit = opts.limit ?? 5;
  const timeout = opts.timeout ?? 30_000;
  const project = opts.project === 'all' ? undefined : opts.project;

  try {
    const res = await client.search(group!, query, {
      project,
      limit,
      timeout,
    });

    if (res.status !== 200) {
      const data = res.data as Record<string, unknown>;
      spinner?.fail(`Search failed: ${String(data.error ?? 'Unknown error')}`);
      outputError(String(data.error ?? 'Search failed'), opts.json ?? false);
    }

    if (!validateSearchResponse(res.data)) {
      spinner?.fail('Invalid search response from server');
      outputError('Invalid search response from server', opts.json ?? false);
    }

    const data = res.data as SearchResponseData;
    spinner?.stop();

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.results.length === 0) {
      console.log(chalk.yellow('No results found. Make sure the project is indexed.'));
      return;
    }

    if (opts.verbose) {
      console.log(chalk.dim('\nSearch parameters:'));
      console.log(chalk.dim(`  Group: ${group}`));
      console.log(chalk.dim(`  Query: ${query}`));
      console.log(chalk.dim(`  Project filter: ${opts.project ?? 'all'}`));
      console.log(chalk.dim(`  Limit: ${limit}`));
      console.log();
    }

    console.log(chalk.bold(`\n${data.total} results for "${query}":\n`));

    for (const r of data.results) {
      const score = (r.score * 100).toFixed(1);
      const header = `${chalk.cyan(`[${r.project}]`)} ${chalk.bold(r.file)}:${chalk.yellow(String(r.startLine))} ${chalk.dim(`(${score}%)`)}`;
      console.log(header);
      console.log(chalk.dim('─'.repeat(60)));

      const lines = r.content.split('\n');
      let lineNum = r.startLine;
      for (const line of lines) {
        const lineNumStr = String(lineNum).padStart(4, ' ');
        console.log(chalk.dim(`  ${lineNumStr} │ `) + line);
        lineNum++;
      }
      console.log();
    }

    if (data.metrics.tokensSaved > 0) {
      console.log(
        chalk.dim(
          `Token savings: ~${data.metrics.tokensSaved} tokens saved (${data.metrics.savingsPercent}%)`
        )
      );
    }

    if (opts.verbose && data.metrics) {
      console.log(chalk.dim('\nDetailed metrics:'));
      console.log(chalk.dim(`  Tokens returned: ${data.metrics.tokensReturned}`));
      console.log(
        chalk.dim(`  Estimated full file tokens: ${data.metrics.estimatedFullFileTokens}`)
      );
      console.log(chalk.dim(`  Tokens saved: ${data.metrics.tokensSaved}`));
      console.log(chalk.dim(`  Savings: ${data.metrics.savingsPercent}%`));
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
      spinner?.fail('Search cancelled');
      process.exit(130);
    }
    spinner?.fail('Search failed');
    outputError(message, opts.json ?? false);
  }
}

export const searchCommand = new Command('search')
  .description('Search code across indexed projects')
  .argument('<query>', 'Search query')
  .option('-n, --limit <n>', 'Max results', '5')
  .option('-p, --project <name>', 'Filter by project name', 'all')
  .option('-g, --group <name>', 'Override group from config')
  .option('--server <url>', 'MCP server URL', 'http://localhost:9876')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .option('--json', 'Output as JSON')
  .option('-v, --verbose', 'Show detailed output')
  .action(
    async (
      query: string,
      opts: {
        limit: string;
        project: string;
        group?: string;
        server: string;
        timeout?: string;
        json?: boolean;
        verbose?: boolean;
      }
    ) => {
      let limit = 5;
      if (opts.limit) {
        const parsed = parseInt(opts.limit, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          const msg = `Invalid limit: ${opts.limit}. Must be a positive number.`;
          if (opts.json) {
            console.log(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(msg));
          }
          process.exit(1);
        }
        if (parsed > 100) {
          const msg = `Limit too large: ${parsed}. Maximum is 100.`;
          if (opts.json) {
            console.log(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(msg));
          }
          process.exit(1);
        }
        limit = parsed;
      }

      let timeout = 30_000;
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

      const controller = new AbortController();

      const sigintHandler = () => {
        const spinner = ora();
        spinner.stop();
        if (!opts.json) {
          console.log(chalk.yellow('\nSearch cancelled'));
        }
        controller.abort();
        process.exit(130);
      };

      process.on('SIGINT', sigintHandler);

      const client = new ApiClient(opts.server);

      const searchClient: SearchClient = {
        search: (g, q, o) => client.search(g, q, { ...o, signal: controller.signal }),
      };

      const spinner = opts.json ? null : ora('Searching...').start();

      try {
        await runSearch(
          searchClient,
          query,
          {
            limit,
            project: opts.project,
            group: opts.group,
            timeout,
            json: opts.json,
            verbose: opts.verbose,
          },
          { spinner }
        );
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
          process.exit(130);
        }
        if (opts.json) {
          console.log(JSON.stringify({ error: message }));
        } else {
          console.error(chalk.red(message));
        }
        process.exit(1);
      } finally {
        process.off('SIGINT', sigintHandler);
      }
    }
  );
