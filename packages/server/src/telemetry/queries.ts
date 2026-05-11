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
}

export function tokenSavingsReport(store: AnalyticsStore, filter: PeriodFilter): TokenSavingsRow {
  const { since, until } = resolvePeriod(filter);
  const userClause = filter.user ? 'AND se.user = @user' : '';
  const groupClause = filter.group ? 'AND se.group_name = @group' : '';
  const sql = `
    WITH per_search AS (
      SELECT
        se.id,
        SUM(sr.chunk_lines * COALESCE(tpl.tokens_per_line,
          (SELECT tokens_per_line FROM tokens_per_language WHERE language = 'generic'))) AS tokens_search_only,
        SUM(COALESCE(sr.file_total_lines, sr.chunk_lines * 5)
          * COALESCE(tpl.tokens_per_line,
            (SELECT tokens_per_line FROM tokens_per_language WHERE language = 'generic'))) AS tokens_whole_file,
        SUM(CASE WHEN cf.id IS NOT NULL
          THEN sr.chunk_lines * COALESCE(tpl.tokens_per_line,
            (SELECT tokens_per_line FROM tokens_per_language WHERE language = 'generic'))
          ELSE 0 END) AS tokens_actually_consumed
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
        ELSE NULL END AS savings_realized
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
