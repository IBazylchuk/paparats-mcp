#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkLabels, loadDataset } from './dataset.js';
import { parseReport, renderComparison, renderSummary } from './report.js';
import { runBench, type SearchMode } from './runner.js';
import { exportCommit, gitTopLevel } from './source.js';
import type { Report } from './types.js';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATASET = path.join(PACKAGE_DIR, 'datasets', 'paparats.json');
const CACHE_DIR = path.join(PACKAGE_DIR, '.cache');
const REPORTS_DIR = path.join(PACKAGE_DIR, 'reports');

/**
 * Yarn runs workspace scripts in the package dir; resolve user paths where they
 * were typed. The root `bench` script passes that directory as BENCH_CWD, since
 * the nested `yarn workspace` call resets INIT_CWD to the package.
 */
const USER_CWD = process.env['BENCH_CWD'] || process.env['INIT_CWD'] || process.cwd();

function userPath(p: string): string {
  return path.resolve(USER_CWD, p);
}

const USAGE = `Usage: yarn bench <command> [options]

Commands:
  run        Index (optionally) and run a labelled query set; writes a JSON report + markdown summary
  compare    Diff two JSON reports:      yarn bench compare <base.json> <head.json> [--out diff.md]
  summary    Re-render a report summary: yarn bench summary <report.json>
  validate   Check every label against the dataset's commit (files, line ranges, symbols)

run options:
  --dataset <file>      Dataset JSON (default: packages/bench/datasets/paparats.json)
  --group <name>        Qdrant group to search (default: bench-<dataset name>)
  --index               Index the dataset commit into the group first (group must start with "bench-")
  --reset               Drop the group's collection before indexing (implies --index)
  --source <dir>        Index this directory instead of exporting the dataset commit
  --mode <m>            search_code (default; same ranking as the MCP tool) | search (plain /api/search)
  --limit <n>           Results per query (default 10, minimum 10)
  --type <t>            Only run queries of this type (repeatable)
  --label <name>        Free-form label stored in the report (e.g. baseline, hybrid)
  --out <file>          Report path (default: packages/bench/reports/<dataset>-<timestamp>.json)
  --qdrant-url <url>    Default: $QDRANT_URL or http://localhost:6333 ($QDRANT_API_KEY is honoured)
  --embed-url <url>     Default: $EMBED_URL or http://127.0.0.1:18434
  --embed-model <name>  Default: $EMBEDDING_MODEL or bge-code-v1
  --embed-dims <n>      Default: $EMBEDDING_DIMENSIONS or 1536
  --verbose             Keep the searcher's own logging
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readReport(file: string): Report {
  const p = userPath(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    fail(`Cannot read report ${p}: ${(err as Error).message}`);
  }
  return parseReport(raw, p);
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z');
}

async function cmdRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: 'string' },
      group: { type: 'string' },
      index: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      source: { type: 'string' },
      mode: { type: 'string', default: 'search_code' },
      limit: { type: 'string', default: '10' },
      type: { type: 'string', multiple: true },
      label: { type: 'string' },
      out: { type: 'string' },
      'qdrant-url': { type: 'string' },
      'embed-url': { type: 'string' },
      'embed-model': { type: 'string' },
      'embed-dims': { type: 'string' },
      verbose: { type: 'boolean', default: false },
    },
  });

  const datasetPath = values.dataset ? userPath(values.dataset) : DEFAULT_DATASET;
  const dataset = loadDataset(datasetPath);
  const mode = values.mode as SearchMode;
  if (mode !== 'search_code' && mode !== 'search') fail(`--mode must be search_code or search`);
  const limit = parseInt(values.limit, 10);
  if (!Number.isInteger(limit) || limit < 10 || limit > 50) {
    fail('--limit must be an integer between 10 and 50 (metrics go up to @10)');
  }
  const embedDims = parseInt(
    values['embed-dims'] ?? process.env['EMBEDDING_DIMENSIONS'] ?? '1536',
    10
  );

  const report = await runBench({
    dataset,
    group: values.group ?? `bench-${dataset.name}`,
    mode,
    limit,
    qdrantUrl: values['qdrant-url'] ?? process.env['QDRANT_URL'] ?? 'http://localhost:6333',
    qdrantApiKey: process.env['QDRANT_API_KEY'] || undefined,
    embedUrl: values['embed-url'] ?? process.env['EMBED_URL'] ?? 'http://127.0.0.1:18434',
    embedModel: values['embed-model'] ?? process.env['EMBEDDING_MODEL'] ?? 'bge-code-v1',
    embedDims,
    index: values.index,
    reset: values.reset,
    ...(values.source ? { source: userPath(values.source) } : {}),
    repoRoot: gitTopLevel(PACKAGE_DIR),
    cacheDir: CACHE_DIR,
    ...(values.type ? { types: values.type } : {}),
    ...(values.label ? { label: values.label } : {}),
    verbose: values.verbose,
    log: (m) => console.error(m),
  });

  const out = values.out
    ? userPath(values.out)
    : path.join(REPORTS_DIR, `${dataset.name}-${timestamp()}.json`);
  const summary = renderSummary(report);
  writeFile(out, JSON.stringify(report, null, 2));
  const md = out.replace(/\.json$/, '') + '.md';
  writeFile(md, summary);
  console.log(summary);
  console.error(`Report: ${out}\nSummary: ${md}`);
}

function cmdCompare(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  const [baseFile, headFile] = positionals;
  if (!baseFile || !headFile) fail('Usage: yarn bench compare <base.json> <head.json>');
  const md = renderComparison(readReport(baseFile), readReport(headFile));
  if (values.out) writeFile(userPath(values.out), md);
  console.log(md);
}

function cmdSummary(argv: string[]): void {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const [file] = positionals;
  if (!file) fail('Usage: yarn bench summary <report.json>');
  console.log(renderSummary(readReport(file)));
}

async function cmdValidate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { dataset: { type: 'string' }, source: { type: 'string' } },
  });
  const datasetPath = values.dataset ? userPath(values.dataset) : DEFAULT_DATASET;
  const dataset = loadDataset(datasetPath);
  const root = values.source
    ? userPath(values.source)
    : await exportCommit(gitTopLevel(PACKAGE_DIR), dataset.commit, CACHE_DIR);
  const problems = checkLabels(dataset, (project, file) => {
    const p = path.join(root, project.path ?? '.', file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  });
  const types = new Map<string, number>();
  for (const q of dataset.queries) types.set(q.type, (types.get(q.type) ?? 0) + 1);
  console.log(
    `${dataset.name}: ${dataset.queries.length} queries (${[...types].map(([t, n]) => `${t} ${n}`).join(', ')}), checked against ${root}`
  );
  if (problems.length > 0) fail(`${problems.length} label problem(s):\n  ${problems.join('\n  ')}`);
  console.log('All labels resolve.');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'run':
      return cmdRun(rest);
    case 'compare':
      return cmdCompare(rest);
    case 'summary':
      return cmdSummary(rest);
    case 'validate':
      return cmdValidate(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      fail(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
