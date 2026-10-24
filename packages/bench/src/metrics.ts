import type { ExpectedLocation, Hit, LatencyStats, MetricSet } from './types.js';

/**
 * Pure retrieval metrics. Everything here works on a ranked hit list (what the
 * agent sees, in order) and a set of targets, with binary relevance.
 *
 * Two levels of strictness:
 * - `file`: the targets are the distinct expected files; a hit is relevant
 *   when its file is one of them.
 * - `chunk`: the targets are the expected spans; a hit is relevant when it is
 *   in the span's file and its lines overlap the span. A target without lines
 *   accepts any chunk of its file.
 *
 * Ranks are result positions, not distinct files: Recall@5 means "found in the
 * first five results the agent reads". A second hit on an already-found target
 * is not relevant again, so duplicates neither raise recall nor nDCG.
 */

export const K_VALUES = [1, 5, 10] as const;
export const MAX_K = 10;

export type Level = 'file' | 'chunk';

/** Whether two inclusive line ranges share at least one line. */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Whether `hit` satisfies `target` at chunk level. */
export function hitMatchesSpan(hit: Hit, target: ExpectedLocation): boolean {
  if (normalizePath(hit.file) !== normalizePath(target.file)) return false;
  if (target.startLine === undefined || target.endLine === undefined) return true;
  return rangesOverlap(hit.startLine, hit.endLine, target.startLine, target.endLine);
}

/** Map a search result to a hit with 1-indexed lines (the Qdrant payload is 0-indexed). */
export function toHit(r: {
  file: string;
  startLine: number;
  endLine: number;
  score?: number;
}): Hit {
  return { file: r.file, startLine: r.startLine + 1, endLine: r.endLine + 1, score: r.score };
}

/** Forward slashes, no leading `./`, so labels and payload paths compare equal. */
export function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Per-rank judgement: `gains[i]` is 1 when hit `i` finds at least one target
 * not found by an earlier hit, `foundAt[i]` the cumulative number of targets
 * found through rank `i`.
 */
export interface Judgement {
  gains: number[];
  foundAt: number[];
  targetCount: number;
}

export function judge(hits: Hit[], expected: ExpectedLocation[], level: Level): Judgement {
  const targets: ExpectedLocation[] =
    level === 'file'
      ? [...new Set(expected.map((e) => normalizePath(e.file)))].map((file) => ({ file }))
      : expected;
  const found = new Array<boolean>(targets.length).fill(false);
  const gains: number[] = [];
  const foundAt: number[] = [];
  let total = 0;
  for (const hit of hits) {
    let gained = false;
    targets.forEach((target, t) => {
      if (!found[t] && hitMatchesSpan(hit, target)) {
        found[t] = true;
        total++;
        gained = true;
      }
    });
    gains.push(gained ? 1 : 0);
    foundAt.push(total);
  }
  return { gains, foundAt, targetCount: targets.length };
}

/** Fraction of targets found in the first `k` hits. */
export function recallAtK(j: Judgement, k: number): number {
  if (j.targetCount === 0) return 0;
  const n = Math.min(k, j.foundAt.length);
  const found = n > 0 ? (j.foundAt[n - 1] ?? 0) : 0;
  return found / j.targetCount;
}

/** 1 / rank of the first relevant hit within the first `k`, else 0. */
export function reciprocalRank(j: Judgement, k: number): number {
  const n = Math.min(k, j.gains.length);
  for (let i = 0; i < n; i++) {
    if (j.gains[i] === 1) return 1 / (i + 1);
  }
  return 0;
}

/** Binary-relevance nDCG over the first `k` hits; the ideal list finds one target per rank. */
export function ndcgAtK(j: Judgement, k: number): number {
  const ideal = Math.min(k, j.targetCount);
  if (ideal === 0) return 0;
  let dcg = 0;
  const n = Math.min(k, j.gains.length);
  for (let i = 0; i < n; i++) {
    dcg += (j.gains[i] ?? 0) / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return dcg / idcg;
}

/** All metrics for one query at one level. */
export function scoreQuery(hits: Hit[], expected: ExpectedLocation[], level: Level): MetricSet {
  const j = judge(hits, expected, level);
  return {
    'recall@1': recallAtK(j, 1),
    'recall@5': recallAtK(j, 5),
    'recall@10': recallAtK(j, 10),
    'mrr@10': reciprocalRank(j, MAX_K),
    'ndcg@10': ndcgAtK(j, MAX_K),
  };
}

export const METRIC_KEYS: ReadonlyArray<keyof MetricSet> = [
  'recall@1',
  'recall@5',
  'recall@10',
  'mrr@10',
  'ndcg@10',
];

/** Arithmetic mean of each metric over queries (macro average). Empty input → zeros. */
export function meanMetrics(sets: MetricSet[]): MetricSet {
  const out = emptyMetrics();
  if (sets.length === 0) return out;
  for (const key of METRIC_KEYS) {
    out[key] = sets.reduce((sum, s) => sum + s[key], 0) / sets.length;
  }
  return out;
}

export function emptyMetrics(): MetricSet {
  return { 'recall@1': 0, 'recall@5': 0, 'recall@10': 0, 'mrr@10': 0, 'ndcg@10': 0 };
}

/** Nearest-rank percentile (`p` in 0..100). Empty input → 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function latencyStats(values: number[]): LatencyStats {
  const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  return { p50: percentile(values, 50), p95: percentile(values, 95), mean };
}
