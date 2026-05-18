import os from 'os';
import { Router, type Request, type Response } from 'express';
import type { Indexer } from './indexer.js';
import type { AnalyticsStore } from './telemetry/analytics-store.js';
import {
  tokenSavingsReport,
  topQueries,
  slowestSearches,
  failedChunks,
  type TopQueryRow,
  type TokenSavingsRow,
  type SlowestSearchRow,
  type FailedChunkRow,
} from './telemetry/queries.js';
import { buildDemoAnalytics, isDemoRequested } from './analytics-demo.js';

export interface BuildAnalyticsRouterOptions {
  indexer: Indexer;
  analytics?: AnalyticsStore;
  /** Defaults to env PAPARATS_INDEXER_URL or http://localhost:9877 */
  indexerHealthUrl?: string;
  /** Override for tests */
  now?: () => number;
}

type PeriodLabel = '24h' | '7d' | '30d';

const PERIOD_MS: Record<PeriodLabel, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface OverviewSection {
  uptimeSec: number;
  memPct: number;
  /** UNIX load average over 1 / 5 / 15 minutes, normalized to per-core. */
  cpuLoad: { '1m': number; '5m': number; '15m': number; perCore1m: number };
  groups: number;
  projects: number;
  chunksTotal: number;
  searchesInPeriod: number;
  /** chunk_fetches in period (LLM actually opened the result). */
  fetchesInPeriod: number;
  /** fetchesInPeriod / searchesInPeriod when searches > 0, else null. */
  fetchRate: number | null;
}

interface TopQueryWithZeroClick extends TopQueryRow {
  zero_click_rate: number;
}

interface SearchTimePoint {
  /** Bucket start (unix ms). */
  bucket: number;
  searches: number;
  fetches: number;
  errors: number;
}

interface FailedSearchRow {
  ts: number;
  user: string;
  group_name: string | null;
  query_example: string | null;
  error: string;
}

interface EmbeddingHealthSection {
  /** Calls in window. */
  total: number;
  /** p50 / p95 / p99 latency in ms (NaN-safe). */
  p50: number;
  p95: number;
  p99: number;
  /** Total cache hits / misses across calls. */
  cacheHits: number;
  cacheMisses: number;
  /** Errors observed (non-null `error` column). */
  errors: number;
  /** Timeouts observed. */
  timeouts: number;
}

interface UserRow {
  user: string;
  searches: number;
  fetches: number;
  /** Unix ms of the most recent search by this user in window. */
  last_active_ts: number;
  /** Anchor project with the most searches from this user (or null). */
  top_anchor_project: string | null;
  /** Distinct sessions observed in window. */
  sessions: number;
}

interface CrossProjectAnchorRow {
  anchor_project: string;
  searches: number;
  /** Average share of off-anchor results across the period (0..1). */
  off_anchor_share: number;
  /** chunk_fetches whose preceding search came from `anchor_project` AND whose
   * chunk lived in a different project. Signals real cross-project usefulness. */
  off_anchor_fetches: number;
}

interface CrossProjectPairRow {
  anchor_project: string;
  result_project: string;
  results_count: number;
  fetches: number;
}

interface RepoStatusEntry {
  repo: string;
  status: string;
  lastRun?: string;
  lastError?: string;
  chunksIndexed?: number;
}

interface IndexerSection {
  reachable: boolean;
  url: string;
  globalStatus?: string;
  lastRunAt?: string;
  repos: RepoStatusEntry[];
  error?: string;
}

interface AnalyticsResponse {
  period: { label: PeriodLabel; since: number; until: number };
  analyticsEnabled: boolean;
  overview: OverviewSection;
  tokenSavings: TokenSavingsRow | null;
  slowestSearches: SlowestSearchRow[];
  topQueries: TopQueryWithZeroClick[];
  recentErrors: FailedChunkRow[];
  crossProjects: {
    anchors: CrossProjectAnchorRow[];
    topPairs: CrossProjectPairRow[];
    /** No anchored results crossed projects in window — likely anchor-scoped search. */
    scopeLikelyAnchored: boolean;
  };
  users: {
    /** Distinct user identifiers seen in the window. */
    distinctCount: number;
    /** Top users by search volume in the window. */
    rows: UserRow[];
  };
  /** Sparkline-friendly time-series. */
  timeseries: SearchTimePoint[];
  failedSearches: FailedSearchRow[];
  embedding: EmbeddingHealthSection;
  indexer: IndexerSection;
}

function parsePeriod(raw: unknown): PeriodLabel {
  const s = typeof raw === 'string' ? raw : '24h';
  if (s === '7d' || s === '30d') return s;
  return '24h';
}

async function fetchIndexerHealth(url: string, timeoutMs = 1500): Promise<IndexerSection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: controller.signal });
    if (!res.ok) {
      return { reachable: false, url, repos: [], error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      status?: string;
      lastRunAt?: string;
      repos?: RepoStatusEntry[];
    };
    return {
      reachable: true,
      url,
      globalStatus: body.status,
      lastRunAt: body.lastRunAt,
      repos: Array.isArray(body.repos) ? body.repos : [],
    };
  } catch (err) {
    // node fetch() under AbortController throws DOMException with name="AbortError"
    // and a noisy default message — surface a clear timeout message instead.
    const e = err as Error;
    const message = e.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : e.message;
    return {
      reachable: false,
      url,
      repos: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-query zero-click rate: a "click" = at least one chunk_fetch tied to a
 * search via preceding_search_id. We compute it per query_hash so the column
 * lines up with topQueries() rows.
 */
function zeroClickByQueryHash(
  store: AnalyticsStore,
  since: number,
  until: number,
  limit: number
): Map<string, number> {
  const sql = `
    SELECT se.query_hash AS query_hash,
           AVG(CASE WHEN fetched.search_id IS NULL THEN 1.0 ELSE 0.0 END) AS rate
    FROM search_events se
    LEFT JOIN (
      SELECT DISTINCT preceding_search_id AS search_id
      FROM chunk_fetches
      WHERE preceding_search_id IS NOT NULL
    ) fetched ON fetched.search_id = se.id
    WHERE se.ts BETWEEN @since AND @until
    GROUP BY se.query_hash
    ORDER BY COUNT(*) DESC
    LIMIT @limit;
  `;
  const rows = store.database.prepare(sql).all({ since, until, limit }) as Array<{
    query_hash: string;
    rate: number | null;
  }>;
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.query_hash, r.rate ?? 0);
  }
  return map;
}

/**
 * Per-anchor cross-project numbers. Aggregates across users so an operator
 * sees one row per anchor project (the original crossProjectShare splits by
 * user, which is noisy on a single-tenant install). Pairs `off_anchor_share`
 * with `off_anchor_fetches` so you can tell "results often come from other
 * projects" apart from "results from other projects are actually opened".
 */
function crossProjectByAnchor(
  store: AnalyticsStore,
  since: number,
  until: number
): CrossProjectAnchorRow[] {
  const sql = `
    WITH off_anchor AS (
      SELECT sr.search_id, COUNT(*) AS cnt
      FROM search_results sr
      JOIN search_events e ON e.id = sr.search_id
      WHERE e.anchor_project IS NOT NULL
        AND sr.project != e.anchor_project
      GROUP BY sr.search_id
    ),
    off_anchor_fetched AS (
      SELECT cf.preceding_search_id AS search_id, COUNT(*) AS cnt
      FROM chunk_fetches cf
      JOIN search_results sr ON sr.search_id = cf.preceding_search_id AND sr.chunk_id = cf.chunk_id
      JOIN search_events e ON e.id = cf.preceding_search_id
      WHERE e.anchor_project IS NOT NULL
        AND sr.project != e.anchor_project
      GROUP BY cf.preceding_search_id
    )
    SELECT
      se.anchor_project,
      COUNT(*) AS searches,
      AVG(COALESCE(off_anchor.cnt, 0) * 1.0 / NULLIF(se.result_count, 0)) AS off_anchor_share,
      COALESCE(SUM(off_anchor_fetched.cnt), 0) AS off_anchor_fetches
    FROM search_events se
    LEFT JOIN off_anchor          ON off_anchor.search_id          = se.id
    LEFT JOIN off_anchor_fetched  ON off_anchor_fetched.search_id  = se.id
    WHERE se.anchor_project IS NOT NULL
      AND se.ts BETWEEN @since AND @until
    GROUP BY se.anchor_project
    ORDER BY searches DESC
    LIMIT 20;
  `;
  const rows = store.database.prepare(sql).all({ since, until }) as Array<{
    anchor_project: string;
    searches: number;
    off_anchor_share: number | null;
    off_anchor_fetches: number;
  }>;
  return rows.map((r) => ({
    anchor_project: r.anchor_project,
    searches: r.searches,
    off_anchor_share: r.off_anchor_share ?? 0,
    off_anchor_fetches: r.off_anchor_fetches,
  }));
}

/**
 * "Knowledge bridges": top (anchor → result-project) pairs by appearance in
 * search_results, with the matching fetch count so we can rank by useful
 * crossings rather than just frequent ones.
 */
function crossProjectTopPairs(
  store: AnalyticsStore,
  since: number,
  until: number,
  limit: number
): CrossProjectPairRow[] {
  const sql = `
    SELECT
      e.anchor_project,
      sr.project AS result_project,
      COUNT(*) AS results_count,
      SUM(CASE WHEN cf.id IS NOT NULL THEN 1 ELSE 0 END) AS fetches
    FROM search_events e
    JOIN search_results sr ON sr.search_id = e.id
    LEFT JOIN chunk_fetches cf
      ON cf.preceding_search_id = e.id
     AND cf.chunk_id = sr.chunk_id
    WHERE e.anchor_project IS NOT NULL
      AND sr.project != e.anchor_project
      AND e.ts BETWEEN @since AND @until
    GROUP BY e.anchor_project, sr.project
    ORDER BY results_count DESC
    LIMIT @limit;
  `;
  return store.database.prepare(sql).all({ since, until, limit }) as CrossProjectPairRow[];
}

/**
 * Per-user activity in the window. `fetches` joins on user via the preceding
 * search (chunk_fetches doesn't store user directly — it carries the search id,
 * which carries the user). top_anchor_project is the mode anchor per user.
 */
function userActivity(
  store: AnalyticsStore,
  since: number,
  until: number,
  limit: number
): { distinctCount: number; rows: UserRow[] } {
  const countRow = store.database
    .prepare('SELECT COUNT(DISTINCT user) AS n FROM search_events WHERE ts BETWEEN ? AND ?')
    .get(since, until) as { n: number } | undefined;

  const sql = `
    WITH base AS (
      SELECT id, user, session, anchor_project, ts
      FROM search_events
      WHERE ts BETWEEN @since AND @until
    ),
    fetches AS (
      SELECT se.user AS user, COUNT(*) AS cnt
      FROM chunk_fetches cf
      JOIN search_events se ON se.id = cf.preceding_search_id
      WHERE se.ts BETWEEN @since AND @until
      GROUP BY se.user
    ),
    anchor_mode AS (
      SELECT user, anchor_project, cnt,
             ROW_NUMBER() OVER (PARTITION BY user ORDER BY cnt DESC) AS rn
      FROM (
        SELECT user, anchor_project, COUNT(*) AS cnt
        FROM base
        WHERE anchor_project IS NOT NULL
        GROUP BY user, anchor_project
      )
    )
    SELECT
      b.user,
      COUNT(*) AS searches,
      COALESCE(f.cnt, 0) AS fetches,
      MAX(b.ts) AS last_active_ts,
      (SELECT anchor_project FROM anchor_mode am WHERE am.user = b.user AND am.rn = 1) AS top_anchor_project,
      COUNT(DISTINCT b.session) AS sessions
    FROM base b
    LEFT JOIN fetches f ON f.user = b.user
    GROUP BY b.user
    ORDER BY searches DESC
    LIMIT @limit;
  `;
  const rows = store.database.prepare(sql).all({ since, until, limit }) as UserRow[];

  return { distinctCount: countRow?.n ?? 0, rows };
}

/**
 * Searches/fetches/errors bucketed by time. Bucket width follows the period:
 * 24h → 1h buckets (24 points), 7d → 6h buckets (28 points), 30d → 1d buckets
 * (30 points). Empty buckets are filled with zeros so the sparkline doesn't
 * lie about gaps.
 */
function searchesOverTime(
  store: AnalyticsStore,
  since: number,
  until: number,
  bucketMs: number
): SearchTimePoint[] {
  // CAST AS INTEGER on the divisor is load-bearing: better-sqlite3 binds JS
  // numbers as REAL when they look fractional in any way, which would turn
  // the integer-division-then-multiply into a near-identity (ts/86400000.0 *
  // 86400000.0 ≈ ts) and explode every row into its own bucket.
  const sql = `
    SELECT
      (ts / CAST(@bucketMs AS INTEGER)) * CAST(@bucketMs AS INTEGER) AS bucket,
      COUNT(*) AS searches,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
    FROM search_events
    WHERE ts BETWEEN @since AND @until
    GROUP BY bucket
    ORDER BY bucket ASC;
  `;
  // better-sqlite3 returns INTEGER columns as JS number, but expression
  // results that overflow 32-bit can come back as BigInt. The bucket value
  // (~1.7e12) sits well inside Number range — but if better-sqlite3 ever
  // surfaces it as BigInt, Map lookups against a Number key would silently
  // miss. Normalize defensively.
  const toNum = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number));

  const searchRowsRaw = store.database.prepare(sql).all({ since, until, bucketMs }) as Array<{
    bucket: number | bigint;
    searches: number | bigint;
    errors: number | bigint;
  }>;
  const searchRows = searchRowsRaw.map((r) => ({
    bucket: toNum(r.bucket),
    searches: toNum(r.searches),
    errors: toNum(r.errors),
  }));

  const fetchSql = `
    SELECT
      (ts / CAST(@bucketMs AS INTEGER)) * CAST(@bucketMs AS INTEGER) AS bucket,
      COUNT(*) AS fetches
    FROM chunk_fetches
    WHERE ts BETWEEN @since AND @until
    GROUP BY bucket;
  `;
  const fetchRowsRaw = store.database.prepare(fetchSql).all({ since, until, bucketMs }) as Array<{
    bucket: number | bigint;
    fetches: number | bigint;
  }>;
  const fetchMap = new Map(fetchRowsRaw.map((r) => [toNum(r.bucket), toNum(r.fetches)]));

  const firstBucket = Math.floor(since / bucketMs) * bucketMs;
  const lastBucket = Math.floor(until / bucketMs) * bucketMs;
  const dataMap = new Map(searchRows.map((r) => [r.bucket, r]));

  const points: SearchTimePoint[] = [];
  for (let b = firstBucket; b <= lastBucket; b += bucketMs) {
    const row = dataMap.get(b);
    points.push({
      bucket: b,
      searches: row?.searches ?? 0,
      fetches: fetchMap.get(b) ?? 0,
      errors: row?.errors ?? 0,
    });
  }
  return points;
}

function bucketForPeriod(label: PeriodLabel): number {
  switch (label) {
    case '24h':
      return 60 * 60 * 1000; // 1h
    case '7d':
      return 6 * 60 * 60 * 1000; // 6h
    case '30d':
      return 24 * 60 * 60 * 1000; // 1d
  }
}

function recentFailedSearches(
  store: AnalyticsStore,
  since: number,
  until: number,
  limit: number
): FailedSearchRow[] {
  const sql = `
    SELECT ts, user, group_name, query_text AS query_example, error
    FROM search_events
    WHERE ts BETWEEN @since AND @until
      AND error IS NOT NULL
    ORDER BY ts DESC
    LIMIT @limit;
  `;
  return store.database.prepare(sql).all({ since, until, limit }) as FailedSearchRow[];
}

/**
 * Embedding-call health: latency percentiles plus aggregate cache + error
 * counts. SQLite has no PERCENTILE_CONT — we pull the row at the ordinal
 * position. Cheap enough for windows up to ~1M rows.
 */
function embeddingHealth(
  store: AnalyticsStore,
  since: number,
  until: number
): EmbeddingHealthSection {
  const agg = store.database
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(cache_hits), 0) AS cacheHits,
         COALESCE(SUM(cache_miss), 0) AS cacheMisses,
         COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
         COALESCE(SUM(timeout), 0) AS timeouts
       FROM embedding_calls
       WHERE ts BETWEEN ? AND ?`
    )
    .get(since, until) as
    | { total: number; cacheHits: number; cacheMisses: number; errors: number; timeouts: number }
    | undefined;

  const total = agg?.total ?? 0;
  if (total === 0) {
    return {
      total: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      timeouts: 0,
    };
  }

  function percentile(p: number): number {
    const offset = Math.max(0, Math.min(total - 1, Math.floor(total * p)));
    const row = store.database
      .prepare(
        `SELECT duration_ms FROM embedding_calls
         WHERE ts BETWEEN ? AND ?
         ORDER BY duration_ms ASC
         LIMIT 1 OFFSET ?`
      )
      .get(since, until, offset) as { duration_ms: number } | undefined;
    return row?.duration_ms ?? 0;
  }

  return {
    total,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    cacheHits: agg?.cacheHits ?? 0,
    cacheMisses: agg?.cacheMisses ?? 0,
    errors: agg?.errors ?? 0,
    timeouts: agg?.timeouts ?? 0,
  };
}

function countSearches(store: AnalyticsStore, since: number, until: number): number {
  const row = store.database
    .prepare('SELECT COUNT(*) AS n FROM search_events WHERE ts BETWEEN ? AND ?')
    .get(since, until) as { n: number } | undefined;
  return row?.n ?? 0;
}

function countFetches(store: AnalyticsStore, since: number, until: number): number {
  const row = store.database
    .prepare('SELECT COUNT(*) AS n FROM chunk_fetches WHERE ts BETWEEN ? AND ?')
    .get(since, until) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function buildAnalyticsRouter(options: BuildAnalyticsRouterOptions): Router {
  const router = Router();
  const indexerUrl =
    options.indexerHealthUrl ?? process.env['PAPARATS_INDEXER_URL'] ?? 'http://localhost:9877';
  const now = options.now ?? Date.now;

  router.get('/', async (req: Request, res: Response) => {
    try {
      const label = parsePeriod(req.query['period']);

      if (isDemoRequested(req)) {
        res.json(buildDemoAnalytics(label, now));
        return;
      }

      const until = now();
      const since = until - PERIOD_MS[label];

      const [qdrantGroups, indexerHealth] = await Promise.all([
        options.indexer.listGroups().catch(() => ({}) as Record<string, number>),
        fetchIndexerHealth(indexerUrl),
      ]);

      const chunksTotal = Object.values(qdrantGroups).reduce((a, b) => a + b, 0);
      const groupCount = Object.keys(qdrantGroups).length;
      // We don't have an authoritative projects-per-group count without the
      // app's projectsByGroup map; the indexer reports repos, which is the
      // closest signal for "what's being indexed". Approximate projects as
      // indexer repo count when available, else fall back to group count.
      const projectsCount = indexerHealth.reachable ? indexerHealth.repos.length : groupCount;

      const mem = process.memoryUsage();
      const memPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

      const [load1, load5, load15] = os.loadavg();
      const cores = Math.max(os.cpus().length, 1);
      const cpuLoad = {
        '1m': Number((load1 ?? 0).toFixed(2)),
        '5m': Number((load5 ?? 0).toFixed(2)),
        '15m': Number((load15 ?? 0).toFixed(2)),
        perCore1m: Number((((load1 ?? 0) / cores) * 100).toFixed(0)),
      };

      const store = options.analytics;
      const enabled = !!store;
      const searches = enabled ? countSearches(store!, since, until) : 0;
      const fetches = enabled ? countFetches(store!, since, until) : 0;

      const overview: OverviewSection = {
        uptimeSec: Math.round(process.uptime()),
        memPct,
        cpuLoad,
        groups: groupCount,
        projects: projectsCount,
        chunksTotal,
        searchesInPeriod: searches,
        fetchesInPeriod: fetches,
        fetchRate: searches > 0 ? fetches / searches : null,
      };

      let tokenSavings: TokenSavingsRow | null = null;
      let slow: SlowestSearchRow[] = [];
      let top: TopQueryWithZeroClick[] = [];
      let errors: FailedChunkRow[] = [];
      let crossAnchors: CrossProjectAnchorRow[] = [];
      let crossPairs: CrossProjectPairRow[] = [];
      let usersOut: { distinctCount: number; rows: UserRow[] } = { distinctCount: 0, rows: [] };
      let timeseries: SearchTimePoint[] = [];
      let failed: FailedSearchRow[] = [];
      let embedding: EmbeddingHealthSection = {
        total: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        cacheHits: 0,
        cacheMisses: 0,
        errors: 0,
        timeouts: 0,
      };

      if (store) {
        tokenSavings = tokenSavingsReport(store, { since, until });
        slow = slowestSearches(store, { since, until }, 10);
        const baseTop = topQueries(store, { since, until }, 10);
        const zeroClick = zeroClickByQueryHash(store, since, until, 50);
        top = baseTop.map((q) => ({
          ...q,
          zero_click_rate: zeroClick.get(q.query_hash) ?? 0,
        }));
        errors = failedChunks(store, { since, until });
        crossAnchors = crossProjectByAnchor(store, since, until);
        crossPairs = crossProjectTopPairs(store, since, until, 10);
        usersOut = userActivity(store, since, until, 20);
        timeseries = searchesOverTime(store, since, until, bucketForPeriod(label));
        failed = recentFailedSearches(store, since, until, 10);
        embedding = embeddingHealth(store, since, until);
      }

      // Anchor scope detection: searches with an anchor exist, no off-anchor
      // results materialized — searcher is almost certainly filtering by
      // anchor (projectScope: 'anchor' or equivalent). Surface this so the
      // 0% cross-share reads as a config signal, not as a metric bug.
      const anchoredSearches = crossAnchors.reduce((a, b) => a + b.searches, 0);
      const anyOffAnchor = crossAnchors.some((a) => a.off_anchor_share > 0);
      const scopeLikelyAnchored = anchoredSearches > 0 && !anyOffAnchor;

      const response: AnalyticsResponse = {
        period: { label, since, until },
        analyticsEnabled: enabled,
        overview,
        tokenSavings,
        slowestSearches: slow,
        topQueries: top,
        recentErrors: errors,
        crossProjects: { anchors: crossAnchors, topPairs: crossPairs, scopeLikelyAnchored },
        users: usersOut,
        timeseries,
        failedSearches: failed,
        embedding,
        indexer: indexerHealth,
      };

      res.json(response);
    } catch (err) {
      console.error('[analytics-api] error:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
