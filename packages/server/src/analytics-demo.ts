/**
 * Synthetic analytics payload for screenshots and demos.
 *
 * Triggered by `?demo=1` on `/api/analytics` or `PAPARATS_UI_DEMO=true`.
 * All values are fabricated — no real users, queries, or projects leak.
 *
 * Numbers are tuned so every tile renders a non-trivial state (no zeros,
 * no empty tables), so a screenshot shows the full dashboard surface.
 */

export type DemoPeriodLabel = '24h' | '7d' | '30d';

const PERIOD_MS: Record<DemoPeriodLabel, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const FAKE_PROJECTS = ['atlas-api', 'atlas-web', 'sirius-mobile', 'sirius-docs'];
const FAKE_USERS = [
  'dev-anchor-7f3a',
  'dev-orbit-12bc',
  'dev-quasar-9d4e',
  'dev-pulsar-5a8f',
  'dev-nova-3c2b',
];

const FAKE_QUERIES = [
  'pagination cursor stability across page reloads',
  'how does the auth middleware handle expired refresh tokens',
  'where do we serialize webhook payloads before persisting',
  'shared types between billing engine and frontend cart',
  'graceful shutdown for queue workers on SIGTERM',
  'tracing context propagation through axios interceptors',
  'database migration rollback strategy for partial failures',
  'feature flag fallback when remote config is unreachable',
];

function fakeQueryHash(q: string): string {
  // Stable deterministic hash without exposing real query_hash format.
  let h = 0;
  for (let i = 0; i < q.length; i++) {
    h = ((h << 5) - h + q.charCodeAt(i)) | 0;
  }
  return `qh_${Math.abs(h).toString(16).padStart(8, '0')}`;
}

function bucketForPeriod(label: DemoPeriodLabel): number {
  if (label === '30d') return 6 * 60 * 60 * 1000;
  if (label === '7d') return 2 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

interface DemoResponse {
  period: { label: DemoPeriodLabel; since: number; until: number };
  analyticsEnabled: true;
  demo: true;
  headline: {
    projects: number;
    documents: number;
    definitions: number;
    architectureNotes: number;
    questionsAnswered: number;
    people: number;
    documentationShare: number;
    medianAnswerMs: number;
  };
  overview: {
    uptimeSec: number;
    memPct: number;
    cpuLoad: { '1m': number; '5m': number; '15m': number; perCore1m: number };
    groups: number;
    projects: number;
    chunksTotal: number;
    searchesInPeriod: number;
    fetchesInPeriod: number;
    fetchRate: number;
  };
  tokenSavings: {
    searches: number;
    naive_baseline: number;
    search_only: number;
    actually_consumed: number;
    savings_vs_naive: number;
    savings_realized: number;
    measured_results: number;
    total_results: number;
  };
  slowestSearches: Array<{
    id: string;
    ts: number;
    user: string;
    group_name: string;
    query_example: string;
    duration_ms: number;
    result_count: number;
  }>;
  topQueries: Array<{
    query_hash: string;
    example: string;
    count: number;
    avg_duration_ms: number;
    result_count_avg: number;
    zero_click_rate: number;
  }>;
  recentErrors: Array<{
    error_class: string;
    language: string;
    count: number;
    example_file: string;
  }>;
  crossProjects: {
    anchors: Array<{
      anchor_project: string;
      searches: number;
      off_anchor_share: number;
      off_anchor_fetches: number;
    }>;
    topPairs: Array<{
      anchor_project: string;
      result_project: string;
      results_count: number;
      fetches: number;
    }>;
    scopeLikelyAnchored: false;
  };
  users: {
    distinctCount: number;
    rows: Array<{
      user: string;
      searches: number;
      fetches: number;
      last_active_ts: number;
      top_anchor_project: string;
      sessions: number;
    }>;
  };
  timeseries: Array<{
    bucket: number;
    searches: number;
    fetches: number;
    errors: number;
  }>;
  failedSearches: Array<{
    ts: number;
    user: string;
    group_name: string;
    query_example: string;
    error: string;
  }>;
  embedding: {
    total: number;
    p50: number;
    p95: number;
    p99: number;
    cacheHits: number;
    cacheMisses: number;
    errors: number;
    timeouts: number;
  };
  indexer: {
    reachable: true;
    url: string;
    globalStatus: 'ok';
    lastRunAt: string;
    repos: Array<{
      repo: string;
      status: string;
      lastRun: string;
      chunksIndexed: number;
    }>;
  };
  tools: {
    rows: Array<{
      tool: string;
      title: string;
      calls: number;
      errors: number;
      avg_duration_ms: number;
      p95_duration_ms: number;
      distinct_users: number;
      last_used_ts: number;
    }>;
    totalCalls: number;
    byDay: Array<{ day: number; tool: string; calls: number }>;
  };
  corpus: {
    code: { chunks: number; groups: Record<string, number> };
    docs: { chunks: number; documents: number; exact: boolean; groups: Record<string, number> };
    terms: { total: number; groups: Record<string, number> };
    arch: {
      total: number;
      byKind: { component: number; decision: number; lesson: number };
      groups: Record<string, number>;
    };
  };
}

export function buildDemoAnalytics(
  label: DemoPeriodLabel,
  nowFn: () => number = Date.now
): DemoResponse {
  const until = nowFn();
  const since = until - PERIOD_MS[label];
  const bucketMs = bucketForPeriod(label);
  const bucketCount = Math.min(96, Math.floor((until - since) / bucketMs));
  const startBucket = Math.floor(since / bucketMs) * bucketMs;

  // Smooth sinusoidal traffic shape with a midday peak and a quiet overnight stretch.
  const timeseries = Array.from({ length: bucketCount }, (_, i) => {
    const bucket = startBucket + i * bucketMs;
    const t = i / bucketCount;
    const wave = Math.sin(t * Math.PI * 2 + 0.6) * 0.5 + 0.5;
    const base = label === '30d' ? 14 : label === '7d' ? 9 : 4;
    const noise = ((i * 7) % 5) - 2;
    const searches = Math.max(0, Math.round(base + wave * base * 1.6 + noise));
    const fetches = Math.max(0, Math.round(searches * (0.35 + wave * 0.25)));
    const errors = i % 23 === 0 ? 1 : 0;
    return { bucket, searches, fetches, errors };
  });

  const totalSearches = timeseries.reduce((a, b) => a + b.searches, 0);
  const totalFetches = timeseries.reduce((a, b) => a + b.fetches, 0);
  const fetchRate = totalSearches > 0 ? totalFetches / totalSearches : 0;

  const avgNaive = 18420;
  const avgActual = 1980;
  const totalNaive = avgNaive * totalSearches;
  const totalActual = avgActual * totalSearches;

  const topQueries = FAKE_QUERIES.slice(0, 7).map((q, i) => ({
    query_hash: fakeQueryHash(q),
    example: q,
    count: 64 - i * 7,
    avg_duration_ms: 180 + i * 95 + (i === 3 ? 420 : 0),
    result_count_avg: 8 + (i % 4),
    zero_click_rate: i === 0 ? 0.05 : i === 1 ? 0.32 : 0.08 + (i % 3) * 0.07,
  }));

  const slowestSearches = [
    { duration_ms: 4280, result_count: 12, query_example: FAKE_QUERIES[2]! },
    { duration_ms: 3110, result_count: 8, query_example: FAKE_QUERIES[5]! },
    { duration_ms: 2870, result_count: 14, query_example: FAKE_QUERIES[1]! },
    { duration_ms: 2410, result_count: 6, query_example: FAKE_QUERIES[6]! },
    { duration_ms: 1980, result_count: 10, query_example: FAKE_QUERIES[3]! },
    { duration_ms: 1740, result_count: 7, query_example: FAKE_QUERIES[0]! },
    { duration_ms: 1505, result_count: 11, query_example: FAKE_QUERIES[7]! },
  ].map((row, i) => ({
    id: `ev_${(i + 1).toString().padStart(4, '0')}`,
    ts: until - (i + 1) * 11 * 60 * 1000,
    user: FAKE_USERS[i % FAKE_USERS.length]!,
    group_name: i % 2 === 0 ? 'atlas' : 'sirius',
    ...row,
  }));

  const crossAnchors = FAKE_PROJECTS.slice(0, 3).map((project, i) => ({
    anchor_project: project,
    searches: [78, 51, 23][i]!,
    off_anchor_share: [0.34, 0.21, 0.12][i]!,
    off_anchor_fetches: [18, 9, 3][i]!,
  }));

  const topPairs = [
    { anchor_project: 'atlas-api', result_project: 'atlas-web', results_count: 142, fetches: 41 },
    { anchor_project: 'atlas-web', result_project: 'atlas-api', results_count: 118, fetches: 32 },
    {
      anchor_project: 'sirius-mobile',
      result_project: 'sirius-docs',
      results_count: 73,
      fetches: 19,
    },
    { anchor_project: 'atlas-api', result_project: 'sirius-mobile', results_count: 41, fetches: 6 },
    { anchor_project: 'atlas-web', result_project: 'sirius-docs', results_count: 28, fetches: 4 },
  ];

  const users = {
    distinctCount: FAKE_USERS.length,
    rows: FAKE_USERS.map((u, i) => ({
      user: u,
      searches: [124, 88, 61, 37, 14][i]!,
      fetches: [44, 31, 19, 12, 4][i]!,
      last_active_ts: until - (i + 1) * 7 * 60 * 1000,
      top_anchor_project: FAKE_PROJECTS[i % FAKE_PROJECTS.length]!,
      sessions: [9, 7, 5, 3, 2][i]!,
    })),
  };

  const recentErrors = [
    {
      error_class: 'tree-sitter parse exceeded budget',
      language: 'typescript',
      count: 3,
      example_file: 'apps/web/src/legacy/migration-runner.ts',
    },
    {
      error_class: 'unsupported syntax (flow type stripped)',
      language: 'javascript',
      count: 1,
      example_file: 'packages/native/scripts/bundle-icons.js',
    },
  ];

  const failedSearches = [
    {
      ts: until - 22 * 60 * 1000,
      user: FAKE_USERS[3]!,
      group_name: 'sirius',
      query_example: 'why does the payment retry loop never terminate',
      error: 'embedding provider timeout (>5000ms)',
    },
    {
      ts: until - 71 * 60 * 1000,
      user: FAKE_USERS[1]!,
      group_name: 'atlas',
      query_example: 'lookup user role hierarchy resolution order',
      error: 'qdrant collection missing — reindex pending',
    },
  ];

  return {
    period: { label, since, until },
    analyticsEnabled: true,
    demo: true,
    overview: {
      uptimeSec: 9 * 24 * 60 * 60 + 4 * 60 * 60 + 17 * 60,
      memPct: 38,
      cpuLoad: { '1m': 0.42, '5m': 0.51, '15m': 0.48, perCore1m: 5 },
      groups: 2,
      projects: FAKE_PROJECTS.length,
      chunksTotal: 184_320,
      searchesInPeriod: totalSearches,
      fetchesInPeriod: totalFetches,
      fetchRate,
    },
    headline: {
      projects: FAKE_PROJECTS.length,
      documents: 529,
      definitions: 142,
      architectureNotes: 87,
      questionsAnswered: Math.round(totalSearches * 1.9),
      people: FAKE_USERS.length,
      documentationShare: 0.31,
      medianAnswerMs: 165,
    },
    tokenSavings: {
      searches: totalSearches,
      naive_baseline: totalNaive,
      // search_only ≈ what the LLM saw after our chunking (vs full files).
      search_only: Math.round(totalNaive * 0.11),
      actually_consumed: totalActual,
      savings_vs_naive: 1 - 0.11,
      savings_realized: 1 - totalActual / totalNaive,
      measured_results: totalSearches * 4,
      total_results: totalSearches * 5,
    },
    slowestSearches,
    topQueries,
    recentErrors,
    crossProjects: { anchors: crossAnchors, topPairs, scopeLikelyAnchored: false },
    users,
    timeseries,
    failedSearches,
    embedding: {
      total: Math.round(totalSearches * 1.4),
      p50: 84,
      p95: 312,
      p99: 540,
      cacheHits: Math.round(totalSearches * 1.05),
      cacheMisses: Math.round(totalSearches * 0.35),
      errors: 0,
      timeouts: 1,
    },
    indexer: {
      reachable: true,
      url: 'http://paparats-indexer:9877',
      globalStatus: 'ok',
      lastRunAt: new Date(until - 6 * 60 * 1000).toISOString(),
      repos: FAKE_PROJECTS.map((repo, i) => ({
        repo,
        status: i === 3 ? 'idle' : 'ok',
        lastRun: new Date(until - (i + 1) * 8 * 60 * 1000).toISOString(),
        chunksIndexed: [62140, 48910, 41230, 32040][i]!,
      })),
    },
    tools: {
      rows: DEMO_TOOL_MIX.map(([tool, share, title], i) => ({
        tool,
        title,
        calls: Math.max(1, Math.round(totalSearches * share)),
        errors: i === 2 ? 3 : 0,
        avg_duration_ms: [180, 220, 95, 340, 60, 410, 120, 75][i] ?? 150,
        p95_duration_ms: [520, 610, 240, 880, 130, 1020, 300, 190][i] ?? 400,
        distinct_users: Math.max(1, FAKE_USERS.length - i),
        last_used_ts: until - (i + 1) * 4 * 60 * 1000,
      })),
      totalCalls: Math.round(totalSearches * 1.9),
      byDay: DEMO_TOOL_MIX.flatMap(([tool, share]) =>
        Array.from({ length: 7 }, (_, d) => ({
          day: dayStart(until - (6 - d) * 24 * 60 * 60 * 1000),
          tool,
          calls: Math.max(1, Math.round(((totalSearches * share) / 7) * (0.7 + (d % 3) * 0.2))),
        }))
      ),
    },
    corpus: {
      code: {
        chunks: 184320,
        groups: Object.fromEntries(
          FAKE_PROJECTS.map((p, i) => [p, [62140, 48910, 41230, 32040][i]!])
        ),
      },
      docs: {
        chunks: 8460,
        documents: 529,
        exact: true,
        groups: { 'main-stand': 431, handbook: 98 },
      },
      terms: { total: 142, groups: { 'main-stand': 118, handbook: 24 } },
      arch: {
        total: 87,
        byKind: { component: 41, decision: 29, lesson: 17 },
        groups: { 'main-stand': 63, handbook: 24 },
      },
    },
  };
}

/**
 * Tool mix for the demo: id, share of search volume, and the display title the
 * real endpoint resolves from the tool registrations. Ordered busiest first.
 */
const DEMO_TOOL_MIX: Array<[string, number, string]> = [
  ['search_code', 1.0, 'Search Code'],
  ['search_docs', 0.42, 'Search Documentation'],
  ['get_chunk', 0.31, 'Get Chunk'],
  ['explain_feature', 0.18, 'Explain Feature'],
  ['term_search', 0.14, 'Search Glossary'],
  ['impact_analysis', 0.09, 'Impact Analysis'],
  ['arch_context', 0.07, 'Architecture Context'],
  ['health_check', 0.04, 'Health Check'],
];

/** UTC midnight of the day containing `ms`. */
function dayStart(ms: number): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.floor(ms / day) * day;
}

export function isDemoRequested(req: { query: Record<string, unknown> }): boolean {
  if (process.env['PAPARATS_UI_DEMO'] === 'true') return true;
  const q = req.query['demo'];
  return q === '1' || q === 'true';
}
