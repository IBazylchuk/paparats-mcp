import { describe, expect, it } from 'vitest';
import {
  hitMatchesSpan,
  judge,
  latencyStats,
  meanMetrics,
  ndcgAtK,
  percentile,
  rangesOverlap,
  recallAtK,
  reciprocalRank,
  scoreQuery,
} from '../src/metrics.js';
import type { ExpectedLocation, Hit } from '../src/types.js';

function hit(file: string, startLine = 1, endLine = 10): Hit {
  return { file, startLine, endLine };
}

describe('rangesOverlap', () => {
  it('treats ranges as inclusive', () => {
    expect(rangesOverlap(1, 5, 5, 9)).toBe(true);
    expect(rangesOverlap(5, 9, 1, 5)).toBe(true);
    expect(rangesOverlap(1, 4, 5, 9)).toBe(false);
    expect(rangesOverlap(3, 3, 1, 9)).toBe(true);
  });
});

describe('hitMatchesSpan', () => {
  it('needs the same file and overlapping lines', () => {
    const target: ExpectedLocation = { file: 'src/a.ts', startLine: 20, endLine: 30 };
    expect(hitMatchesSpan(hit('src/a.ts', 25, 40), target)).toBe(true);
    expect(hitMatchesSpan(hit('src/a.ts', 31, 40), target)).toBe(false);
    expect(hitMatchesSpan(hit('src/b.ts', 25, 40), target)).toBe(false);
  });

  it('accepts any chunk of the file when the target has no lines', () => {
    expect(hitMatchesSpan(hit('src/a.ts', 500, 600), { file: 'src/a.ts' })).toBe(true);
  });

  it('normalises ./ prefixes and backslashes', () => {
    expect(hitMatchesSpan(hit('src\\a.ts'), { file: './src/a.ts' })).toBe(true);
  });
});

describe('judge', () => {
  it('counts each file once at file level', () => {
    const expected = [
      { file: 'a.ts', startLine: 1, endLine: 5 },
      { file: 'a.ts', startLine: 50, endLine: 60 },
    ];
    const j = judge([hit('a.ts'), hit('a.ts', 50, 55)], expected, 'file');
    expect(j.targetCount).toBe(1);
    expect(j.gains).toEqual([1, 0]);
    expect(j.foundAt).toEqual([1, 1]);
  });

  it('credits each span once at chunk level, and a duplicate hit gains nothing', () => {
    const expected = [
      { file: 'a.ts', startLine: 1, endLine: 5 },
      { file: 'a.ts', startLine: 50, endLine: 60 },
    ];
    const j = judge(
      [hit('a.ts', 1, 3), hit('a.ts', 2, 4), hit('b.ts'), hit('a.ts', 55, 70)],
      expected,
      'chunk'
    );
    expect(j.targetCount).toBe(2);
    expect(j.gains).toEqual([1, 0, 0, 1]);
    expect(j.foundAt).toEqual([1, 1, 1, 2]);
  });

  it('lets one large chunk find several spans', () => {
    const expected = [
      { file: 'a.ts', startLine: 1, endLine: 5 },
      { file: 'a.ts', startLine: 8, endLine: 9 },
    ];
    const j = judge([hit('a.ts', 1, 20)], expected, 'chunk');
    expect(j.foundAt).toEqual([2]);
    expect(j.gains).toEqual([1]);
  });
});

describe('recall, reciprocal rank and nDCG', () => {
  const expected = [{ file: 'a.ts' }, { file: 'b.ts' }];

  it('scores a perfect ranking as 1', () => {
    const j = judge([hit('a.ts'), hit('b.ts'), hit('c.ts')], expected, 'file');
    expect(recallAtK(j, 1)).toBe(0.5);
    expect(recallAtK(j, 5)).toBe(1);
    expect(reciprocalRank(j, 10)).toBe(1);
    expect(ndcgAtK(j, 10)).toBeCloseTo(1, 10);
  });

  it('scores a relevant hit at rank 3', () => {
    const j = judge([hit('x.ts'), hit('y.ts'), hit('a.ts')], [{ file: 'a.ts' }], 'file');
    expect(recallAtK(j, 1)).toBe(0);
    expect(recallAtK(j, 5)).toBe(1);
    expect(reciprocalRank(j, 10)).toBeCloseTo(1 / 3, 10);
    expect(ndcgAtK(j, 10)).toBeCloseTo(1 / Math.log2(4), 10);
  });

  it('ignores hits past k', () => {
    const hits = [...Array.from({ length: 10 }, (_, i) => hit(`n${i}.ts`)), hit('a.ts')];
    const j = judge(hits, [{ file: 'a.ts' }], 'file');
    expect(recallAtK(j, 10)).toBe(0);
    expect(reciprocalRank(j, 10)).toBe(0);
    expect(ndcgAtK(j, 10)).toBe(0);
  });

  it('computes nDCG against an ideal list capped at the target count', () => {
    // Targets found at ranks 1 and 3: DCG = 1 + 1/log2(4); IDCG = 1 + 1/log2(3).
    const j = judge([hit('a.ts'), hit('x.ts'), hit('b.ts')], expected, 'file');
    const dcg = 1 + 1 / Math.log2(4);
    const idcg = 1 + 1 / Math.log2(3);
    expect(ndcgAtK(j, 10)).toBeCloseTo(dcg / idcg, 10);
  });

  it('is zero for an empty hit list', () => {
    const j = judge([], expected, 'file');
    expect(recallAtK(j, 10)).toBe(0);
    expect(reciprocalRank(j, 10)).toBe(0);
    expect(ndcgAtK(j, 10)).toBe(0);
  });

  it('scoreQuery reports file and chunk strictness separately', () => {
    const target = [{ file: 'a.ts', startLine: 100, endLine: 120 }];
    const hits = [hit('a.ts', 1, 20), hit('a.ts', 110, 130)];
    expect(scoreQuery(hits, target, 'file')['mrr@10']).toBe(1);
    expect(scoreQuery(hits, target, 'chunk')['mrr@10']).toBe(0.5);
    expect(scoreQuery(hits, target, 'chunk')['recall@1']).toBe(0);
    expect(scoreQuery(hits, target, 'chunk')['recall@5']).toBe(1);
  });
});

describe('aggregation helpers', () => {
  it('macro-averages metric sets', () => {
    const a = scoreQuery([hit('a.ts')], [{ file: 'a.ts' }], 'file');
    const b = scoreQuery([hit('x.ts')], [{ file: 'a.ts' }], 'file');
    const m = meanMetrics([a, b]);
    expect(m['recall@1']).toBe(0.5);
    expect(m['mrr@10']).toBe(0.5);
    expect(meanMetrics([])['ndcg@10']).toBe(0);
  });

  it('uses nearest-rank percentiles', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
    expect(latencyStats([30, 10, 20])).toEqual({ p50: 20, p95: 30, mean: 20 });
  });
});
