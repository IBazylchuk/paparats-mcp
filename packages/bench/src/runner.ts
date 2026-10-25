import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE,
  CachedEmbeddingProvider,
  EmbeddingCache,
  Indexer,
  LlamaServerProvider,
  Searcher,
  autoProjectConfig,
  createQdrantClient,
  createTreeSitterManager,
  loadProject,
  DEFINITION_CANDIDATES,
  definitionCandidatesFilter,
  identifierTokens,
  modelFamily,
  rankKey,
  rankQuery,
  readFileCommitCounts,
  toCollectionName,
} from '@paparats/server';
import type { ProjectConfig, SearchResult } from '@paparats/server';
import { emptyMetrics, scoreQuery, toHit } from './metrics.js';
import { buildReport } from './report.js';
import { exportCommit, gitDirty, gitHead } from './source.js';
import type { BenchQuery, Dataset, Hit, QueryResult, Report } from './types.js';

/** Groups the bench may create, index into or drop. Searching any group is allowed. */
export const BENCH_GROUP_PREFIX = 'bench-';

/**
 * Never index the bench itself: its sources and tests quote query strings and
 * file names, which would make the corpus answer its own questions.
 */
const BENCH_EXCLUDE = 'packages/bench/**';

/**
 * Stored project names carry the group, so the indexer's eviction of a project
 * from "other" groups (it moves a project between groups by name) never reaches
 * another bench group or a real index on the same Qdrant.
 */
export function benchProjectSuffix(group: string): string {
  return `@${group}`;
}

export type SearchMode = 'search_code' | 'search';

export interface RunOptions {
  dataset: Dataset;
  group: string;
  mode: SearchMode;
  limit: number;
  qdrantUrl: string;
  qdrantApiKey?: string;
  embedUrl: string;
  embedModel: string;
  embedDims: number;
  /** Index the dataset's projects into `group` before searching. */
  index: boolean;
  /** Drop the group's collection first (implies `index`). */
  reset: boolean;
  /** Directory to index instead of exporting `dataset.commit` from `repoRoot`. */
  source?: string;
  /** Git repository the dataset commit is exported from. */
  repoRoot: string;
  /**
   * Git repository whose history up to `dataset.commit` gives each file's
   * churn. Defaults to `repoRoot` when indexing an export; with `source` and
   * no `historyRoot`, files carry no churn.
   */
  historyRoot?: string;
  /** Where exports and the indexing embedding cache live (git-ignored). */
  cacheDir: string;
  /** Run only queries of these types. */
  types?: string[];
  label?: string;
  verbose?: boolean;
  log: (message: string) => void;
}

function assertBenchGroup(group: string, action: string): void {
  if (!group.startsWith(BENCH_GROUP_PREFIX)) {
    throw new Error(
      `Refusing to ${action} group "${group}": the bench only writes to groups named ` +
        `"${BENCH_GROUP_PREFIX}*", so it can never touch a real index.`
    );
  }
}

function makeProvider(opts: RunOptions, cache: EmbeddingCache): CachedEmbeddingProvider {
  const base = new LlamaServerProvider({
    url: opts.embedUrl,
    model: opts.embedModel,
    dimensions: opts.embedDims,
  });
  // Same instruction-prefix policy as createEmbeddingProvider in the server.
  const family = modelFamily(opts.embedModel);
  return new CachedEmbeddingProvider(base, cache, { enabled: family !== 'none', family });
}

/**
 * The ranking `search_code` returns: a search at twice the limit plus, for a
 * query naming identifiers, the chunks that define them; duplicates by content
 * hash dropped, ranked (test files demoted, definitions up), cut to the limit.
 * Mirrors the tool handler in mcp-handler.ts for a single group.
 */
export async function searchLikeTool(
  searcher: Searcher,
  mode: SearchMode,
  group: string,
  q: Pick<BenchQuery, 'query' | 'project'>,
  limit: number
): Promise<SearchResult[]> {
  if (mode === 'search') {
    const res = await searcher.search(group, q.query, { project: q.project, limit, tool: 'bench' });
    return res.results;
  }
  const res = await searcher.search(group, q.query, {
    project: q.project,
    limit: limit * 2,
    tool: 'bench',
  });
  const results = [...res.results];
  const identifiers = identifierTokens(q.query);
  if (identifiers.length > 0) {
    const definitions = await searcher.searchWithFilter(
      group,
      q.query,
      definitionCandidatesFilter(identifiers),
      { project: q.project, limit: DEFINITION_CANDIDATES, tool: 'bench' }
    );
    results.push(...definitions.results);
  }
  const ranked = rankQuery(q.query);
  const seen = new Set<string>();
  return results
    .filter((r) => {
      if (seen.has(r.hash)) return false;
      seen.add(r.hash);
      return true;
    })
    .sort((a, b) => rankKey(ranked, b) - rankKey(ranked, a))
    .slice(0, limit);
}

async function resolveSourceRoot(opts: RunOptions): Promise<string> {
  if (opts.source) {
    const head = gitHead(opts.source);
    if (head !== opts.dataset.commit || gitDirty(opts.source)) {
      opts.log(
        `warning: ${opts.source} is ${head ? `at ${head.slice(0, 12)}` : 'not a git checkout'}` +
          `${gitDirty(opts.source) ? ' with local changes' : ''}; the labels were taken at ` +
          `${opts.dataset.commit.slice(0, 12)} and may point at moved code.`
      );
    }
    return path.resolve(opts.source);
  }
  opts.log(`Exporting ${opts.dataset.commit.slice(0, 12)} from ${opts.repoRoot}...`);
  return exportCommit(opts.repoRoot, opts.dataset.commit, opts.cacheDir);
}

function projectConfigFor(dir: string, name: string, group: string): ProjectConfig {
  const base = fs.existsSync(path.join(dir, CONFIG_FILE))
    ? loadProject(dir)
    : autoProjectConfig(dir, { group });
  return { ...base, name, group, exclude: [...base.exclude, BENCH_EXCLUDE] };
}

async function countChunks(
  qdrant: ReturnType<typeof createQdrantClient>,
  group: string
): Promise<number | null> {
  try {
    const { count } = await qdrant.count(toCollectionName(group), {
      exact: true,
      filter: { must_not: [{ key: '__meta', match: { value: true } }] },
    });
    return count;
  } catch {
    return null;
  }
}

async function indexDataset(
  opts: RunOptions,
  qdrant: ReturnType<typeof createQdrantClient>
): Promise<void> {
  assertBenchGroup(opts.group, 'index into');
  const collection = toCollectionName(opts.group);
  if (opts.reset) {
    const { collections } = await qdrant.getCollections();
    if (collections.some((c) => c.name === collection)) {
      opts.log(`Dropping ${collection}...`);
      await qdrant.deleteCollection(collection);
    }
  }

  const sourceRoot = await resolveSourceRoot(opts);
  const provider = makeProvider(
    opts,
    new EmbeddingCache(path.join(opts.cacheDir, 'embeddings.db'))
  );
  const treeSitter = await createTreeSitterManager();
  try {
    const indexer = new Indexer({
      qdrantUrl: opts.qdrantUrl,
      qdrantApiKey: opts.qdrantApiKey,
      qdrantClient: qdrant,
      embeddingProvider: provider,
      dimensions: provider.dimensions,
      embeddingProviderId: 'llama',
      embeddingModelId: opts.embedModel,
      treeSitter,
      projectSuffix: benchProjectSuffix(opts.group),
      // The index is an export without .git: read the churn from the history.
      fileCommitCounts: async (project) => {
        const historyRoot = opts.historyRoot ?? (opts.source ? undefined : opts.repoRoot);
        const p = opts.dataset.projects.find((d) => d.name === project.name);
        if (!historyRoot || !p) return null;
        return readFileCommitCounts(path.join(historyRoot, p.path ?? '.'), opts.dataset.commit);
      },
    });
    for (const p of opts.dataset.projects) {
      const dir = path.join(sourceRoot, p.path ?? '.');
      const project = projectConfigFor(dir, p.name, opts.group);
      opts.log(`Indexing ${p.name} (${dir}) into ${collection}...`);
      const started = performance.now();
      const report = await indexer.indexProjectWithReport(project);
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      opts.log(`  ${report.chunks} chunks written, ${report.errors} file errors, ${secs}s`);
      if (report.errors > 0) {
        opts.log('  warning: some files failed to index; affected queries will under-score.');
      }
    }
  } finally {
    provider.close();
  }
}

/** Index (optionally) and run every query of the dataset; returns the report. */
export async function runBench(opts: RunOptions): Promise<Report> {
  if (opts.reset) opts.index = true;
  const qdrant = createQdrantClient({ url: opts.qdrantUrl, apiKey: opts.qdrantApiKey });

  if (opts.index) await indexDataset(opts, qdrant);

  const points = await countChunks(qdrant, opts.group);
  if (points === null || points === 0) {
    throw new Error(
      `Collection ${toCollectionName(opts.group)} is missing or empty at ${opts.qdrantUrl}. ` +
        'Run with --index first.'
    );
  }

  // A fresh in-memory cache per run: every distinct query string pays its embed call once,
  // so latency includes embedding (only exact repeats within a run are served from memory).
  const provider = makeProvider(opts, new EmbeddingCache(':memory:'));
  const searcher = new Searcher({
    qdrantUrl: opts.qdrantUrl,
    qdrantApiKey: opts.qdrantApiKey,
    qdrantClient: qdrant,
    embeddingProvider: provider,
    projectSuffix: benchProjectSuffix(opts.group),
  });

  const queries = opts.types
    ? opts.dataset.queries.filter((q) => opts.types!.includes(q.type))
    : opts.dataset.queries;
  if (queries.length === 0) throw new Error('No queries selected.');

  // The first request pays for loading the model; keep it out of the latencies.
  await provider.embedQuery('warm-up');

  const results: QueryResult[] = [];
  const consoleLog = console.log;
  if (!opts.verbose) console.log = () => {};
  try {
    for (const [i, q] of queries.entries()) {
      const started = performance.now();
      let hits: Hit[] = [];
      let error: string | undefined;
      try {
        hits = (await searchLikeTool(searcher, opts.mode, opts.group, q, opts.limit)).map(toHit);
      } catch (err) {
        error = (err as Error).message;
      }
      const latencyMs = performance.now() - started;
      const result: QueryResult = {
        id: q.id,
        type: q.type,
        query: q.query,
        project: q.project,
        latencyMs,
        hits,
        file: error ? emptyMetrics() : scoreQuery(hits, q.expected, 'file'),
        chunk: error ? emptyMetrics() : scoreQuery(hits, q.expected, 'chunk'),
        ...(error ? { error } : {}),
      };
      results.push(result);
      opts.log(
        `[${i + 1}/${queries.length}] ${q.id} ${error ? `ERROR ${error}` : `file RR ${result.file['mrr@10'].toFixed(2)}, chunk R@10 ${result.chunk['recall@10'].toFixed(2)}`} (${Math.round(latencyMs)} ms)`
      );
    }
  } finally {
    console.log = consoleLog;
    provider.close();
  }

  return buildReport(
    opts.dataset,
    {
      mode: opts.mode,
      group: opts.group,
      limit: opts.limit,
      embedModel: opts.embedModel,
      points,
      ...(opts.label ? { label: opts.label } : {}),
    },
    results
  );
}
