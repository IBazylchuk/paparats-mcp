import type { AnalyticsStore } from './analytics-store.js';

const DEFAULT_REFORMULATION_WINDOW_MS = parseInt(
  process.env.PAPARATS_REFORMULATION_WINDOW_MS ?? '90000',
  10
);

export interface PeriodFilter {
  /** Lower bound (unix ms). Defaults to 7 days ago. */
  since?: number;
  /** Upper bound (unix ms). Defaults to now. */
  until?: number;
  /** Optional user filter. */
  user?: string;
  /** Optional group filter. */
  group?: string;
}

function resolvePeriod(p: PeriodFilter): { since: number; until: number } {
  const until = p.until ?? Date.now();
  const since = p.since ?? until - 7 * 24 * 60 * 60 * 1000;
  return { since, until };
}

export interface TokenSavingsRow {
  searches: number;
  naive_baseline: number;
  search_only: number;
  actually_consumed: number;
  savings_vs_naive: number | null;
  savings_realized: number | null;
  /** Result rows whose file size is known, so the baseline is measured. */
  measured_results: number;
  /** All result rows in the period, measured or not. */
  total_results: number;
}

export function tokenSavingsReport(store: AnalyticsStore, filter: PeriodFilter): TokenSavingsRow {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND se.user = @user' : '';
  const groupClause = filter.group ? 'AND se.group_name = @group' : '';
  const sql = `
    WITH per_search AS (
      SELECT
        se.id,
        SUM(CASE WHEN sr.file_total_lines IS NOT NULL
          THEN sr.chunk_lines * COALESCE(tpl.tokens_per_line,
            (SELECT tokens_per_line FROM tokens_per_language WHERE language = 'generic'))
          ELSE 0 END) AS tokens_search_only,
        SUM(CASE WHEN sr.file_total_lines IS NOT NULL
          THEN sr.file_total_lines
            * COALESCE(tpl.tokens_per_line,
              (SELECT tokens_per_line FROM tokens_per_language WHERE language = 'generic'))
          ELSE 0 END) AS tokens_whole_file,
        SUM(CASE WHEN cf.id IS NOT NULL AND sr.file_total_lines IS NOT NULL
          THEN sr.chunk_lines * COALESCE(tpl.tokens_per_line,
            (SELECT tokens_per_line FROM tokens_per_language WHERE language = 'generic'))
          ELSE 0 END) AS tokens_actually_consumed,
        SUM(CASE WHEN sr.file_total_lines IS NOT NULL THEN 1 ELSE 0 END) AS measured_results,
        COUNT(*) AS total_results
      FROM search_events se
      JOIN search_results sr ON sr.search_id = se.id
      LEFT JOIN tokens_per_language tpl ON tpl.language = sr.language
      LEFT JOIN chunk_fetches cf ON cf.preceding_search_id = se.id AND cf.chunk_id = sr.chunk_id
      WHERE se.ts BETWEEN @since AND @until
        ${userClause}
        ${groupClause}
      GROUP BY se.id
    )
    SELECT
      COUNT(*) AS searches,
      COALESCE(SUM(tokens_whole_file), 0) AS naive_baseline,
      COALESCE(SUM(tokens_search_only), 0) AS search_only,
      COALESCE(SUM(tokens_actually_consumed), 0) AS actually_consumed,
      CASE WHEN SUM(tokens_whole_file) > 0
        THEN 1.0 - 1.0 * SUM(tokens_search_only) / SUM(tokens_whole_file)
        ELSE NULL END AS savings_vs_naive,
      CASE WHEN SUM(tokens_whole_file) > 0
        THEN 1.0 - 1.0 * SUM(tokens_actually_consumed) / SUM(tokens_whole_file)
        ELSE NULL END AS savings_realized,
      COALESCE(SUM(measured_results), 0) AS measured_results,
      COALESCE(SUM(total_results), 0) AS total_results
    FROM per_search;
  `;
  const row = store.database
    .prepare(sql)
    .get({ since, until, user: filter.user, group: filter.group }) as TokenSavingsRow | undefined;
  return (
    row ?? {
      searches: 0,
      naive_baseline: 0,
      search_only: 0,
      actually_consumed: 0,
      savings_vs_naive: null,
      savings_realized: null,
      measured_results: 0,
      total_results: 0,
    }
  );
}

export interface TopQueryRow {
  query_hash: string;
  example: string | null;
  count: number;
  avg_duration_ms: number;
  result_count_avg: number;
}

export function topQueries(store: AnalyticsStore, filter: PeriodFilter, limit = 20): TopQueryRow[] {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND user = @user' : '';
  const groupClause = filter.group ? 'AND group_name = @group' : '';
  const sql = `
    SELECT
      query_hash,
      MAX(query_text) AS example,
      COUNT(*) AS count,
      ROUND(AVG(duration_ms)) AS avg_duration_ms,
      ROUND(AVG(result_count)) AS result_count_avg
    FROM search_events
    WHERE ts BETWEEN @since AND @until
      ${userClause}
      ${groupClause}
    GROUP BY query_hash
    ORDER BY count DESC
    LIMIT @limit;
  `;
  return store.database
    .prepare(sql)
    .all({ since, until, user: filter.user, group: filter.group, limit }) as TopQueryRow[];
}

export interface SlowestSearchRow {
  id: string;
  ts: number;
  user: string;
  group_name: string | null;
  query_example: string | null;
  duration_ms: number;
  result_count: number;
}

export function slowestSearches(
  store: AnalyticsStore,
  filter: PeriodFilter,
  limit = 20
): SlowestSearchRow[] {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND user = @user' : '';
  const groupClause = filter.group ? 'AND group_name = @group' : '';
  const sql = `
    SELECT id, ts, user, group_name,
           query_text AS query_example,
           duration_ms, result_count
    FROM search_events
    WHERE ts BETWEEN @since AND @until
      ${userClause}
      ${groupClause}
    ORDER BY duration_ms DESC
    LIMIT @limit;
  `;
  return store.database
    .prepare(sql)
    .all({ since, until, user: filter.user, group: filter.group, limit }) as SlowestSearchRow[];
}

export interface CrossProjectRow {
  user: string;
  anchor_project: string;
  searches: number;
  share: number;
}

export function crossProjectShare(store: AnalyticsStore, filter: PeriodFilter): CrossProjectRow[] {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND se.user = @user' : '';
  const groupClause = filter.group ? 'AND se.group_name = @group' : '';
  const sql = `
    SELECT
      se.user, se.anchor_project,
      COUNT(*) AS searches,
      AVG(off_anchor.cnt * 1.0 / NULLIF(se.result_count, 0)) AS share
    FROM search_events se
    LEFT JOIN (
      SELECT sr.search_id, COUNT(*) AS cnt
      FROM search_results sr
      JOIN search_events e ON e.id = sr.search_id
      WHERE sr.project != e.anchor_project AND e.anchor_project IS NOT NULL
      GROUP BY sr.search_id
    ) off_anchor ON off_anchor.search_id = se.id
    WHERE se.anchor_project IS NOT NULL
      AND se.ts BETWEEN @since AND @until
      ${userClause}
      ${groupClause}
    GROUP BY se.user, se.anchor_project
    ORDER BY searches DESC;
  `;
  return store.database
    .prepare(sql)
    .all({ since, until, user: filter.user, group: filter.group }) as CrossProjectRow[];
}

export interface RetryRateRow {
  user: string;
  total_searches: number;
  reformulations: number;
  rate: number;
}

export function retryRate(
  store: AnalyticsStore,
  filter: PeriodFilter,
  windowMs: number = DEFAULT_REFORMULATION_WINDOW_MS
): RetryRateRow[] {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND user = @user' : '';
  const groupClause = filter.group ? 'AND group_name = @group' : '';
  const sql = `
    WITH base AS (
      SELECT id, ts, user, session, group_name, query_tokens
      FROM search_events
      WHERE ts BETWEEN @since AND @until
        ${userClause}
        ${groupClause}
    ),
    pairs AS (
      SELECT s1.id AS prev_id, s2.id AS next_id, s1.user, s1.query_tokens AS t1, s2.query_tokens AS t2
      FROM base s1
      JOIN base s2
        ON s1.user = s2.user
       AND s1.session IS s2.session
       AND s2.ts > s1.ts
       AND s2.ts - s1.ts <= @windowMs
       AND NOT EXISTS (
         SELECT 1 FROM chunk_fetches cf
         WHERE cf.preceding_search_id = s1.id AND cf.ts < s2.ts
       )
    ),
    classified AS (
      SELECT prev_id, user,
        CASE WHEN t1 = t2 THEN 1.0 ELSE
          CAST((SELECT COUNT(*) FROM json_each(t1) WHERE value IN (SELECT value FROM json_each(t2))) AS REAL)
          /
          NULLIF((SELECT COUNT(*) FROM (
            SELECT value FROM json_each(t1) UNION SELECT value FROM json_each(t2)
          )), 0)
        END AS jaccard
      FROM pairs
    ),
    reformulated AS (
      SELECT user, COUNT(DISTINCT prev_id) AS n
      FROM classified
      WHERE jaccard >= 0.3
      GROUP BY user
    ),
    totals AS (
      SELECT user, COUNT(*) AS total FROM base GROUP BY user
    )
    SELECT
      t.user,
      t.total AS total_searches,
      COALESCE(r.n, 0) AS reformulations,
      CASE WHEN t.total > 0 THEN 1.0 * COALESCE(r.n, 0) / t.total ELSE 0 END AS rate
    FROM totals t
    LEFT JOIN reformulated r ON r.user = t.user
    ORDER BY total_searches DESC;
  `;
  return store.database
    .prepare(sql)
    .all({ since, until, user: filter.user, group: filter.group, windowMs }) as RetryRateRow[];
}

export interface FailedChunkRow {
  error_class: string;
  language: string | null;
  count: number;
  example_file: string;
}

export function failedChunks(store: AnalyticsStore, filter: PeriodFilter): FailedChunkRow[] {
  const { since, until } = resolvePeriod(filter);
  const groupClause = filter.group ? 'AND group_name = @group' : '';
  const sql = `
    SELECT error_class, language, COUNT(*) AS count, MAX(file) AS example_file
    FROM chunking_errors
    WHERE ts BETWEEN @since AND @until
      ${groupClause}
    GROUP BY error_class, language
    ORDER BY count DESC;
  `;
  return store.database.prepare(sql).all({ since, until, group: filter.group }) as FailedChunkRow[];
}

export interface ToolUsageRow {
  tool: string;
  calls: number;
  /** Calls that threw. */
  errors: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
  distinct_users: number;
  last_used_ts: number;
}

/**
 * Per-tool call counts over a period, from `tool_calls`.
 *
 * This is the only table that records the MCP tool name as the client asked for
 * it. `search_events.tool` cannot answer the same question: several MCP tools
 * share one Searcher method, and the tools that never search (`health_check`,
 * the `arch_*`/`term_*` readers, docs search) write no search event at all.
 *
 * p95 is taken with an OFFSET into the ordered rows, since SQLite has no
 * percentile aggregate.
 */
export function toolUsage(store: AnalyticsStore, filter: PeriodFilter): ToolUsageRow[] {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND user = @user' : '';
  const rows = store.database
    .prepare(
      `SELECT
         tool,
         COUNT(*)                                  AS calls,
         SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)   AS errors,
         AVG(duration_ms)                          AS avg_duration_ms,
         COUNT(DISTINCT user)                      AS distinct_users,
         MAX(ts)                                   AS last_used_ts
       FROM tool_calls
       WHERE ts BETWEEN @since AND @until
         ${userClause}
       GROUP BY tool
       ORDER BY calls DESC`
    )
    .all({ since, until, user: filter.user }) as Array<Omit<ToolUsageRow, 'p95_duration_ms'>>;

  const p95stmt = store.database.prepare(
    `SELECT duration_ms AS v
       FROM tool_calls
      WHERE tool = @tool AND ts BETWEEN @since AND @until
      ORDER BY duration_ms
      LIMIT 1 OFFSET @off`
  );

  return rows.map((r) => {
    const off = Math.max(0, Math.floor(r.calls * 0.95) - 1);
    const hit = p95stmt.get({ tool: r.tool, since, until, off }) as { v: number } | undefined;
    return {
      ...r,
      avg_duration_ms: Math.round(r.avg_duration_ms),
      p95_duration_ms: hit?.v ?? 0,
    };
  });
}

export interface ToolUsageByDayRow {
  /** Bucket start (unix ms, UTC midnight). */
  day: number;
  tool: string;
  calls: number;
}

/** Daily per-tool call counts, for a stacked trend of what people reach for. */
export function toolUsageByDay(store: AnalyticsStore, filter: PeriodFilter): ToolUsageByDayRow[] {
  const { since, until } = resolvePeriod(filter);
  const day = 24 * 60 * 60 * 1000;
  return store.database
    .prepare(
      `SELECT (ts / CAST(@day AS INTEGER)) * CAST(@day AS INTEGER) AS day,
              tool,
              COUNT(*) AS calls
         FROM tool_calls
        WHERE ts BETWEEN @since AND @until
        GROUP BY day, tool
        ORDER BY day ASC, calls DESC`
    )
    .all({ since, until, day }) as ToolUsageByDayRow[];
}
