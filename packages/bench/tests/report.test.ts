import { describe, expect, it } from 'vitest';
import { scoreQuery, toHit } from '../src/metrics.js';
import {
  aggregate,
  buildReport,
  compareReports,
  parseReport,
  renderComparison,
  renderSummary,
} from '../src/report.js';
import type { Dataset, Hit, QueryResult, Report } from '../src/types.js';

const DATASET: Dataset = {
  name: 'demo',
  commit: '0123456789abcdef0123456789abcdef01234567',
  projects: [{ name: 'app' }],
  queries: [
    { id: 'q1', type: 'nl', query: 'one', project: 'app', expected: [{ file: 'a.ts' }] },
    { id: 'q2', type: 'identifier', query: 'two', project: 'app', expected: [{ file: 'b.ts' }] },
  ],
};

function result(id: string, type: string, hits: Hit[], expectedFile: string, ms = 10): QueryResult {
  const expected = [{ file: expectedFile }];
  return {
    id,
    type,
    query: id,
    project: 'app',
    latencyMs: ms,
    hits,
    file: scoreQuery(hits, expected, 'file'),
    chunk: scoreQuery(hits, expected, 'chunk'),
  };
}

function report(results: QueryResult[], label?: string): Report {
  return buildReport(
    DATASET,
    {
      mode: 'search_code',
      group: 'bench-demo',
      limit: 10,
      embedModel: 'm',
      ...(label ? { label } : {}),
    },
    results,
    new Date('2026-01-01T00:00:00Z')
  );
}

const h = (file: string): Hit => ({ file, startLine: 1, endLine: 5 });

describe('aggregate', () => {
  it('scores failed queries as zero and leaves them out of latency', () => {
    const ok = result('q1', 'nl', [h('a.ts')], 'a.ts', 40);
    const failed: QueryResult = { ...result('q2', 'nl', [], 'b.ts', 9999), error: 'boom' };
    const a = aggregate([ok, failed]);
    expect(a.count).toBe(2);
    expect(a.errors).toBe(1);
    expect(a.file['mrr@10']).toBe(0.5);
    expect(a.latency.p50).toBe(40);
  });
});

describe('buildReport / renderSummary', () => {
  const r = report([
    result('q1', 'nl', [h('a.ts')], 'a.ts'),
    result('q2', 'identifier', [h('z.ts')], 'b.ts'),
  ]);

  it('breaks results down by type', () => {
    expect(Object.keys(r.byType)).toEqual(['identifier', 'nl']);
    expect(r.byType['nl']?.file['recall@1']).toBe(1);
    expect(r.byType['identifier']?.file['recall@1']).toBe(0);
    expect(r.overall.file['recall@1']).toBe(0.5);
  });

  it('round-trips through parseReport and lists misses in the summary', () => {
    const parsed = parseReport(JSON.parse(JSON.stringify(r)));
    const md = renderSummary(parsed);
    expect(md).toContain('| file | 0.500 |');
    expect(md).toContain('| q2 | identifier | q2 | `z.ts:1` |');
  });

  it('rejects files that are not reports', () => {
    expect(() => parseReport({ hello: 'world' }, 'x.json')).toThrow(/not a paparats bench report/);
  });
});

describe('compareReports / renderComparison', () => {
  const base = report(
    [result('q1', 'nl', [h('a.ts')], 'a.ts'), result('q2', 'identifier', [h('z.ts')], 'b.ts')],
    'base'
  );
  const head = report(
    [
      result('q1', 'nl', [h('z.ts'), h('a.ts')], 'a.ts'),
      result('q2', 'identifier', [h('b.ts')], 'b.ts'),
    ],
    'head'
  );

  it('finds per-query movers', () => {
    const cmp = compareReports(base, head);
    expect(cmp.warnings).toEqual([]);
    expect(cmp.changed.map((d) => [d.id, d.fileMrr])).toEqual([
      ['q1', -0.5],
      ['q2', 1],
    ]);
  });

  it('renders deltas and both mover lists', () => {
    const md = renderComparison(base, head);
    expect(md).toContain('| file MRR@10 | 0.500 | 0.750 | +0.250 |');
    expect(md).toContain('## Regressed (1)');
    expect(md).toContain('## Improved (1)');
  });

  it('warns when the query sets or commits differ', () => {
    const other = { ...head, dataset: { ...head.dataset, commit: 'f'.repeat(40) } };
    other.queries = head.queries.slice(0, 1);
    const cmp = compareReports(base, other);
    expect(cmp.onlyInBase).toEqual(['q2']);
    expect(cmp.warnings).toHaveLength(2);
  });
});

describe('toHit', () => {
  it('converts the 0-indexed payload lines to 1-indexed', () => {
    expect(toHit({ file: 'a.ts', startLine: 0, endLine: 9, score: 0.7 })).toEqual({
      file: 'a.ts',
      startLine: 1,
      endLine: 10,
      score: 0.7,
    });
  });
});
