import { emptyMetrics, latencyStats, MAX_K, meanMetrics, METRIC_KEYS } from './metrics.js';
import type { Aggregate, Dataset, MetricSet, QueryResult, Report, ReportConfig } from './types.js';

// ── Aggregation ────────────────────────────────────────────────────────────

/** Macro-average a set of query results. Failed queries count, scored zero, latency excluded. */
export function aggregate(results: QueryResult[]): Aggregate {
  const ok = results.filter((r) => r.error === undefined);
  return {
    count: results.length,
    file: meanMetrics(results.map((r) => r.file)),
    chunk: meanMetrics(results.map((r) => r.chunk)),
    latency: latencyStats(ok.map((r) => r.latencyMs)),
    errors: results.length - ok.length,
  };
}

export function buildReport(
  dataset: Dataset,
  config: ReportConfig,
  results: QueryResult[],
  createdAt: Date = new Date()
): Report {
  const types = [...new Set(results.map((r) => r.type))].sort();
  const byType: Record<string, Aggregate> = {};
  for (const type of types) byType[type] = aggregate(results.filter((r) => r.type === type));
  return {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    dataset: { name: dataset.name, commit: dataset.commit, queryCount: dataset.queries.length },
    config,
    overall: aggregate(results),
    byType,
    queries: results,
  };
}

/** Parse a report written by `run`; rejects anything else early with a clear message. */
export function parseReport(raw: unknown, source = 'report'): Report {
  const r = raw as Partial<Report> | null;
  if (
    !r ||
    r.schemaVersion !== 1 ||
    !r.dataset ||
    !r.config ||
    !r.overall ||
    !r.byType ||
    !Array.isArray(r.queries)
  ) {
    throw new Error(`${source} is not a paparats bench report (schemaVersion 1)`);
  }
  return r as Report;
}

// ── Formatting ─────────────────────────────────────────────────────────────

const METRIC_LABELS: Record<keyof MetricSet, string> = {
  'recall@1': 'R@1',
  'recall@5': 'R@5',
  'recall@10': 'R@10',
  'mrr@10': 'MRR@10',
  'ndcg@10': 'nDCG@10',
};

function f3(n: number): string {
  return n.toFixed(3);
}

function ms(n: number): string {
  return `${Math.round(n)} ms`;
}

function signed(n: number, digits = 3): string {
  const s = n.toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

/** Markdown table; the first `leftCols` columns are left-aligned, the rest (numbers) right. */
function table(header: string[], rows: string[][], leftCols = 1): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map((_, i) => (i < leftCols ? '---' : '---:')).join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function runLine(report: Report): string {
  const c = report.config;
  const parts = [
    `mode \`${c.mode}\``,
    `model \`${c.embedModel}\``,
    `group \`${c.group}\``,
    `limit ${c.limit}`,
  ];
  if (c.points !== undefined) parts.push(`${c.points} chunks`);
  if (c.label) parts.push(`label \`${c.label}\``);
  return parts.join(', ');
}

/** Markdown summary of one report: overall, per query type, and the queries that missed. */
export function renderSummary(report: Report): string {
  const o = report.overall;
  const lines: string[] = [
    `# Retrieval bench — ${report.dataset.name}`,
    '',
    `Dataset commit \`${report.dataset.commit.slice(0, 12)}\`, ${o.count} queries; ${runLine(report)}.`,
    `Run at ${report.createdAt}.`,
    '',
    '## Overall',
    '',
    ...table(
      ['Level', ...METRIC_KEYS.map((k) => METRIC_LABELS[k])],
      [
        ['file', ...METRIC_KEYS.map((k) => f3(o.file[k]))],
        ['chunk', ...METRIC_KEYS.map((k) => f3(o.chunk[k]))],
      ]
    ),
    '',
    `Latency per query: p50 ${ms(o.latency.p50)}, p95 ${ms(o.latency.p95)}, mean ${ms(o.latency.mean)}.` +
      (o.errors > 0 ? ` **${o.errors} queries failed** (scored zero).` : ''),
    '',
    '## By query type',
    '',
    ...table(
      ['Type', 'n', 'file R@1', 'file R@5', 'file MRR@10', 'chunk R@10', 'chunk nDCG@10', 'p50'],
      Object.entries(report.byType).map(([type, a]) => [
        type,
        String(a.count),
        f3(a.file['recall@1']),
        f3(a.file['recall@5']),
        f3(a.file['mrr@10']),
        f3(a.chunk['recall@10']),
        f3(a.chunk['ndcg@10']),
        ms(a.latency.p50),
      ])
    ),
    '',
  ];

  const misses = report.queries.filter((q) => q.file['recall@10'] === 0);
  lines.push(`## Misses (no expected file in the top ${MAX_K})`, '');
  if (misses.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(
      ...table(
        ['Query', 'Type', 'Text', 'Top hit'],
        misses.map((q) => [
          q.id,
          q.type,
          escapeCell(q.query.length > 70 ? `${q.query.slice(0, 67)}...` : q.query),
          q.error
            ? `error: ${escapeCell(q.error.slice(0, 60))}`
            : q.hits[0]
              ? `\`${q.hits[0].file}:${q.hits[0].startLine}\``
              : '—',
        ]),
        4
      ),
      ''
    );
  }
  return lines.join('\n');
}

// ── Comparison ─────────────────────────────────────────────────────────────

export interface QueryDelta {
  id: string;
  type: string;
  query: string;
  /** Change in file-level MRR@10 (head − base). */
  fileMrr: number;
  /** Change in chunk-level Recall@10 (head − base). */
  chunkRecall: number;
}

export interface Comparison {
  warnings: string[];
  /** Queries present in both reports whose file MRR@10 or chunk Recall@10 changed. */
  changed: QueryDelta[];
  onlyInBase: string[];
  onlyInHead: string[];
}

/** Line up two reports by query id. */
export function compareReports(base: Report, head: Report): Comparison {
  const warnings: string[] = [];
  if (base.dataset.name !== head.dataset.name) {
    warnings.push(`Different datasets: "${base.dataset.name}" vs "${head.dataset.name}".`);
  }
  if (base.dataset.commit !== head.dataset.commit) {
    warnings.push(
      `Different dataset commits (${base.dataset.commit.slice(0, 12)} vs ${head.dataset.commit.slice(0, 12)}): labels may differ.`
    );
  }
  if (base.config.limit !== head.config.limit) {
    warnings.push(`Different result limits (${base.config.limit} vs ${head.config.limit}).`);
  }
  const baseById = new Map(base.queries.map((q) => [q.id, q]));
  const headById = new Map(head.queries.map((q) => [q.id, q]));
  const changed: QueryDelta[] = [];
  for (const h of head.queries) {
    const b = baseById.get(h.id);
    if (!b) continue;
    const fileMrr = h.file['mrr@10'] - b.file['mrr@10'];
    const chunkRecall = h.chunk['recall@10'] - b.chunk['recall@10'];
    if (Math.abs(fileMrr) > 1e-9 || Math.abs(chunkRecall) > 1e-9) {
      changed.push({ id: h.id, type: h.type, query: h.query, fileMrr, chunkRecall });
    }
  }
  const onlyInBase = base.queries.filter((q) => !headById.has(q.id)).map((q) => q.id);
  const onlyInHead = head.queries.filter((q) => !baseById.has(q.id)).map((q) => q.id);
  if (onlyInBase.length > 0 || onlyInHead.length > 0) {
    warnings.push(
      `Query sets differ (${onlyInBase.length} only in base, ${onlyInHead.length} only in head): aggregates are not like for like.`
    );
  }
  return { warnings, changed, onlyInBase, onlyInHead };
}

function metricRows(base: MetricSet, head: MetricSet, level: string): string[][] {
  return METRIC_KEYS.map((k) => [
    `${level} ${METRIC_LABELS[k]}`,
    f3(base[k]),
    f3(head[k]),
    signed(head[k] - base[k]),
  ]);
}

/** Markdown diff of two reports: aggregate deltas, per-type deltas, per-query movers. */
export function renderComparison(base: Report, head: Report): string {
  const cmp = compareReports(base, head);
  const lines: string[] = [
    `# Retrieval bench comparison — ${head.dataset.name}`,
    '',
    `- **base**: ${runLine(base)} (${base.createdAt})`,
    `- **head**: ${runLine(head)} (${head.createdAt})`,
    '',
  ];
  if (cmp.warnings.length > 0) {
    lines.push(...cmp.warnings.map((w) => `> **Warning:** ${w}`), '');
  }

  lines.push(
    '## Overall',
    '',
    ...table(
      ['Metric', 'base', 'head', 'Δ'],
      [
        ...metricRows(base.overall.file, head.overall.file, 'file'),
        ...metricRows(base.overall.chunk, head.overall.chunk, 'chunk'),
        [
          'latency p50',
          ms(base.overall.latency.p50),
          ms(head.overall.latency.p50),
          `${signed(head.overall.latency.p50 - base.overall.latency.p50, 0)} ms`,
        ],
        [
          'latency p95',
          ms(base.overall.latency.p95),
          ms(head.overall.latency.p95),
          `${signed(head.overall.latency.p95 - base.overall.latency.p95, 0)} ms`,
        ],
      ]
    ),
    ''
  );

  const types = [...new Set([...Object.keys(base.byType), ...Object.keys(head.byType)])].sort();
  const zero = { count: 0, file: emptyMetrics(), chunk: emptyMetrics() };
  lines.push(
    '## By query type',
    '',
    ...table(
      ['Type', 'n', 'file MRR@10', 'Δ', 'chunk R@10', 'Δ', 'chunk nDCG@10', 'Δ'],
      types.map((t) => {
        const b = base.byType[t] ?? zero;
        const h = head.byType[t] ?? zero;
        return [
          t,
          String(h.count),
          f3(h.file['mrr@10']),
          signed(h.file['mrr@10'] - b.file['mrr@10']),
          f3(h.chunk['recall@10']),
          signed(h.chunk['recall@10'] - b.chunk['recall@10']),
          f3(h.chunk['ndcg@10']),
          signed(h.chunk['ndcg@10'] - b.chunk['ndcg@10']),
        ];
      })
    ),
    ''
  );

  const byScore = (a: QueryDelta, b: QueryDelta): number =>
    a.fileMrr + a.chunkRecall - (b.fileMrr + b.chunkRecall);
  const regressed = cmp.changed.filter((d) => d.fileMrr + d.chunkRecall < 0).sort(byScore);
  const improved = cmp.changed
    .filter((d) => d.fileMrr + d.chunkRecall > 0)
    .sort((a, b) => byScore(b, a));
  const mixed = cmp.changed.filter((d) => d.fileMrr + d.chunkRecall === 0);

  const moverTable = (rows: QueryDelta[]): string[] =>
    table(
      ['Query', 'Type', 'Text', 'Δ file MRR@10', 'Δ chunk R@10'],
      rows.map((d) => [
        d.id,
        d.type,
        escapeCell(d.query.length > 60 ? `${d.query.slice(0, 57)}...` : d.query),
        signed(d.fileMrr),
        signed(d.chunkRecall),
      ]),
      3
    );

  lines.push(`## Regressed (${regressed.length})`, '');
  lines.push(...(regressed.length > 0 ? moverTable(regressed) : ['None.']), '');
  lines.push(`## Improved (${improved.length})`, '');
  lines.push(...(improved.length > 0 ? moverTable(improved) : ['None.']), '');
  if (mixed.length > 0) {
    lines.push(`## Mixed (${mixed.length})`, '', ...moverTable(mixed), '');
  }
  return lines.join('\n');
}
