import { Command, Option } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../api-client.js';

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export interface StatsResponse {
  groups: Record<string, number>;
  registeredProjects: Record<string, string[]>;
  usage: {
    searchCount: number;
    totalTokensSaved: number;
    avgTokensSavedPerSearch: number;
  };
  cache?: {
    size: number;
    hitCount: number;
    maxSize: number;
    hitRate: number;
  };
  watcher?: Record<string, { eventsProcessed: number }>;
  memory?: { heapUsed: number; heapTotal: number };
}

export function validateStatsResponse(data: unknown): data is StatsResponse {
  if (!data || typeof data !== 'object') return false;

  const d = data as Partial<StatsResponse>;

  return (
    typeof d.groups === 'object' &&
    d.groups !== null &&
    typeof d.registeredProjects === 'object' &&
    d.registeredProjects !== null &&
    typeof d.usage === 'object' &&
    d.usage !== null &&
    typeof d.usage.searchCount === 'number'
  );
}

interface GroupsOptions {
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  sort?: string;
  timeout?: number;
  groupName?: string;
}

interface StatsClient {
  stats(options?: { timeout?: number }): Promise<{ status: number; data: unknown }>;
}

function outputError(message: string, json: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(chalk.red(message));
  }
  throw new Error('EXIT:1');
}

export async function runGroups(
  client: StatsClient,
  opts: GroupsOptions,
  deps?: { spinner?: ReturnType<typeof ora> | null }
): Promise<void> {
  const spinner =
    deps?.spinner !== undefined ? deps.spinner : ora('Fetching stats from server...').start();

  try {
    const res = await client.stats({ timeout: opts.timeout ?? 10_000 });
    spinner?.stop();

    if (res.status !== 200) {
      outputError('Failed to fetch stats from server', opts.json ?? false);
    }

    const rawData = res.data;
    if (!validateStatsResponse(rawData)) {
      outputError('Invalid stats response from server', opts.json ?? false);
    }
    const data = rawData as StatsResponse;

    if (opts.json) {
      if (opts.groupName) {
        const chunks = data.groups[opts.groupName];
        if (chunks === undefined) {
          outputError(`Group not found: ${opts.groupName}`, opts.json);
        }
        const projects = data.registeredProjects[opts.groupName] ?? [];
        console.log(JSON.stringify({ group: opts.groupName, chunks, projects }, null, 2));
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      return;
    }

    let groupEntries = Object.entries(data.groups);

    if (opts.groupName) {
      const chunks = data.groups[opts.groupName];
      if (chunks === undefined) {
        outputError(`Group not found: ${opts.groupName}`, opts.json ?? false);
      }
      const projects = data.registeredProjects[opts.groupName] ?? [];
      console.log(chalk.bold(`\n${opts.groupName}\n`));
      console.log(`  ${chalk.dim('Chunks:')} ${chunks}`);
      console.log(`  ${chalk.dim('Projects:')}`);
      for (const p of projects) {
        console.log(`    • ${p}`);
      }
      return;
    }

    if (groupEntries.length === 0) {
      if (!opts.quiet) {
        console.log(chalk.yellow('No groups indexed yet. Run `paparats index` first.'));
      }
      process.exit(0);
    }

    if (opts.sort === 'size') {
      groupEntries = groupEntries.sort((a, b) => b[1] - a[1]);
    } else {
      groupEntries = groupEntries.sort((a, b) => a[0].localeCompare(b[0]));
    }

    if (opts.quiet) {
      for (const [groupName] of groupEntries) {
        console.log(groupName);
      }
      return;
    }

    console.log(chalk.bold('\nIndexed Groups:\n'));

    for (const [groupName, chunks] of groupEntries) {
      const projects = data.registeredProjects[groupName] ?? [];

      if (opts.verbose) {
        console.log(`  ${chalk.bold(groupName)}`);
        console.log(`    ${chalk.dim('Chunks:')} ${chunks}`);
        console.log(`    ${chalk.dim('Projects:')}`);
        for (const p of projects) {
          console.log(`      • ${p}`);
        }
      } else {
        console.log(`  ${chalk.bold(groupName)} ${chalk.dim(`(${chunks} chunks)`)}`);
        for (const p of projects) {
          console.log(`    ${chalk.dim('•')} ${p}`);
        }
      }
      console.log();
    }

    if (opts.verbose) {
      console.log(chalk.bold('Statistics:\n'));

      if (data.usage.searchCount > 0) {
        console.log(`  ${chalk.dim('Searches:')} ${data.usage.searchCount}`);
        console.log(
          `  ${chalk.dim('Tokens saved:')} ~${formatNumber(data.usage.totalTokensSaved)}`
        );
        console.log(`  ${chalk.dim('Avg per search:')} ~${data.usage.avgTokensSavedPerSearch}`);
      }

      if (data.cache) {
        const cache = data.cache;
        const hitRatePercent = (cache.hitRate * 100).toFixed(1);
        console.log(`  ${chalk.dim('Cache hit rate:')} ${hitRatePercent}%`);
      }

      if (data.watcher) {
        const totalEvents = Object.values(data.watcher).reduce<number>(
          (sum, w) => sum + (w?.eventsProcessed ?? 0),
          0
        );
        if (totalEvents > 0) {
          console.log(`  ${chalk.dim('File changes processed:')} ${totalEvents}`);
        }
      }

      if (data.memory) {
        const heapMB = Math.round(data.memory.heapUsed / 1024 / 1024);
        console.log(`  ${chalk.dim('Memory usage:')} ${heapMB} MB`);
      }

      console.log();
    } else if (data.usage.searchCount > 0) {
      console.log(
        chalk.dim(
          `Stats: ${data.usage.searchCount} searches, ~${formatNumber(data.usage.totalTokensSaved)} tokens saved`
        )
      );
    }
  } catch (err) {
    spinner?.stop();
    const message = (err as Error).message;
    if (message.startsWith('EXIT:')) {
      const code = parseInt(message.slice(5), 10);
      process.exit(Number.isNaN(code) ? 1 : code);
    }
    if (opts.json) {
      console.log(JSON.stringify({ error: message }));
    } else {
      console.error(chalk.red(message));
    }
    process.exit(1);
  }
}

export const groupsCommand = new Command('groups')
  .description('List all indexed groups and projects')
  .argument('[group]', 'Show details for specific group')
  .option('--server <url>', 'MCP server URL', 'http://localhost:9876')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '10000')
  .option('-v, --verbose', 'Show detailed information')
  .option('-q, --quiet', 'Show only group names')
  .option('--json', 'Output as JSON')
  .addOption(
    new Option('--sort <field>', 'Sort by field').choices(['name', 'size']).default('name')
  )
  .action(
    async (
      groupName: string | undefined,
      opts: {
        server: string;
        timeout?: string;
        verbose?: boolean;
        quiet?: boolean;
        json?: boolean;
        sort?: string;
      }
    ) => {
      if (opts.verbose && opts.quiet) {
        if (opts.json) {
          console.log(JSON.stringify({ error: 'Cannot use --verbose and --quiet together' }));
        } else {
          console.error(chalk.red('Cannot use --verbose and --quiet together'));
        }
        process.exit(1);
      }

      let timeout = 10_000;
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
      const spinner = opts.json ? null : ora('Fetching stats from server...').start();

      await runGroups(
        client,
        {
          json: opts.json,
          verbose: opts.verbose,
          quiet: opts.quiet,
          sort: opts.sort,
          timeout,
          groupName,
        },
        { spinner }
      );
    }
  );
