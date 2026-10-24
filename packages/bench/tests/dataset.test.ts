import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLabels, DatasetError, loadDataset, parseDataset } from '../src/dataset.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    commit: SHA,
    projects: [{ name: 'app' }],
    queries: [
      {
        id: 'q-1',
        type: 'nl',
        query: 'where is it',
        project: 'app',
        expected: [{ file: 'src/a.ts', startLine: 2, endLine: 3, symbol: 'foo' }],
      },
    ],
    ...overrides,
  };
}

function problemsOf(raw: unknown): string[] {
  try {
    parseDataset(raw);
  } catch (err) {
    if (err instanceof DatasetError) return err.problems;
    throw err;
  }
  return [];
}

describe('parseDataset', () => {
  it('accepts a minimal dataset', () => {
    const ds = parseDataset(minimal());
    expect(ds.queries).toHaveLength(1);
    expect(ds.queries[0]?.expected[0]).toEqual({
      file: 'src/a.ts',
      startLine: 2,
      endLine: 3,
      symbol: 'foo',
    });
  });

  it('requires a full commit sha', () => {
    expect(problemsOf(minimal({ commit: 'abc123' }))).toEqual([
      'commit: expected a full 40-character lower-case commit SHA',
    ]);
  });

  it('rejects unknown projects, duplicate ids and bad line ranges', () => {
    const q = (id: string, extra: Record<string, unknown>) => ({
      id,
      type: 'nl',
      query: 'x',
      project: 'app',
      expected: [{ file: 'a.ts' }],
      ...extra,
    });
    const problems = problemsOf(
      minimal({
        queries: [
          q('a', { project: 'other' }),
          q('b', {}),
          q('b', {}),
          q('c', { expected: [{ file: 'a.ts', startLine: 5, endLine: 2 }] }),
          q('d', { expected: [{ file: 'a.ts', startLine: 5 }] }),
          q('e', { expected: [{ file: '../outside.ts' }] }),
          q('f', { expected: [] }),
        ],
      })
    );
    expect(problems).toEqual([
      "queries[0].project: must name one of the dataset's projects",
      'queries[2].id: duplicate id "b"',
      'queries[3].expected[0]: endLine 2 is before startLine 5',
      'queries[4].expected[0]: startLine and endLine must both be positive integers',
      'queries[5].expected[0].file: must be relative to the project root, got "../outside.ts"',
      'queries[6].expected: expected a non-empty array',
    ]);
  });
});

describe('checkLabels', () => {
  const ds = parseDataset(minimal());

  it('passes when the symbol is inside the labelled lines', () => {
    expect(checkLabels(ds, () => 'line1\nfunction foo() {\n}\n')).toEqual([]);
  });

  it('reports missing files, out-of-range lines and misplaced symbols', () => {
    expect(checkLabels(ds, () => null)).toEqual(['q-1 expected[0] src/a.ts: file not found']);
    expect(checkLabels(ds, () => 'only one line')).toEqual([
      'q-1 expected[0] src/a.ts: endLine 3 is past the end (1 lines)',
    ]);
    expect(checkLabels(ds, () => 'foo\nbar\nbaz\n')).toEqual([
      'q-1 expected[0] src/a.ts: symbol "foo" does not appear in the labelled lines',
    ]);
  });
});

describe('shipped dataset', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ds = loadDataset(path.join(here, '..', 'datasets', 'paparats.json'));

  it('is valid and large enough to be worth running', () => {
    expect(ds.queries.length).toBeGreaterThanOrEqual(40);
  });

  it('covers every query type the bench reports on', () => {
    const types = new Set(ds.queries.map((q) => q.type));
    for (const t of ['nl', 'identifier', 'error', 'config', 'where', 'code', 'cross-package']) {
      expect(types.has(t), `missing type ${t}`).toBe(true);
    }
  });

  it('labels only files the code index covers', () => {
    for (const q of ds.queries) {
      for (const e of q.expected) {
        expect(e.file, q.id).toMatch(/\.(ts|tsx|js|jsx)$/);
        expect(e.file.startsWith('packages/bench/'), q.id).toBe(false);
      }
    }
  });
});
