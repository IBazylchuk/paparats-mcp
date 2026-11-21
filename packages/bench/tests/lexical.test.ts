import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/bm25.js';
import {
  lineCount,
  projectDocuments,
  readIndexable,
  runLexicalBench,
  searchFiles,
} from '../src/lexical.js';
import { compareReports, renderComparison, renderSummary } from '../src/report.js';
import type { Dataset } from '../src/types.js';

describe('lineCount', () => {
  it('counts lines as an editor does', () => {
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('a\nb\n')).toBe(2);
  });
});

describe('readIndexable', () => {
  it('keeps source text and drops what the indexer skips', () => {
    expect(readIndexable(Buffer.from('export const a = 1;\n'))).toBe('export const a = 1;\n');
    expect(readIndexable(Buffer.from('   \n\n'))).toBeNull();
    expect(readIndexable(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(readIndexable(Buffer.from([0x61, 0xff, 0xfe]))).toBeNull();
  });
});

describe('searchFiles', () => {
  it('returns whole-file hits', () => {
    const index = new Bm25Index([
      { id: 'a.ts', text: 'needle\nhay' },
      { id: 'b.ts', text: 'hay' },
    ]);
    const hits = searchFiles(index, new Map([['a.ts', 2]]), 'needle', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'a.ts', startLine: 1, endLine: 2 });
    expect(hits[0]?.score).toBeGreaterThan(0);
  });
});

describe('the lexical arm on a small project', () => {
  let root: string;
  const write = (rel: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-lexical-'));
    write('package.json', '{"name":"demo"}\n');
    write('.gitignore', 'ignored.ts\n');
    write(
      'src/collections.ts',
      'export function toCollectionName(group: string) {\n  return group;\n}\n'
    );
    write('src/retry.ts', 'export function retryQdrant() {\n  // exponential backoff\n}\n');
    write('src/other.ts', 'export const unrelated = 1;\n');
    write('src/collections.test.ts', "import { toCollectionName } from './collections';\n");
    write('ignored.ts', 'export const toCollectionName = 1;\n');
    write('node_modules/dep/index.ts', 'export const toCollectionName = 2;\n');
    write('packages/bench/src/self.ts', 'export const toCollectionName = 3;\n');
    write('empty.ts', '\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const dataset = (): Dataset => ({
    name: 'demo',
    commit: 'a'.repeat(40),
    projects: [{ name: 'demo', path: '.' }],
    queries: [
      {
        id: 'id-01',
        type: 'identifier',
        query: 'toCollectionName',
        project: 'demo',
        expected: [{ file: 'src/collections.ts', startLine: 1, endLine: 3 }],
      },
      {
        id: 'nl-01',
        type: 'nl',
        query: 'exponential backoff when qdrant fails',
        project: 'demo',
        expected: [{ file: 'src/retry.ts' }],
      },
      {
        id: 'nl-02',
        type: 'nl',
        query: 'something the corpus never says',
        project: 'demo',
        expected: [{ file: 'src/other.ts' }],
      },
    ],
  });

  it('indexes the files the indexer would: excludes, gitignore, the bench itself, empty files', async () => {
    const docs = await projectDocuments(root, 'demo', 'bench-demo');
    expect(docs.map((d) => d.id)).toEqual([
      'src/collections.test.ts',
      'src/collections.ts',
      'src/other.ts',
      'src/retry.ts',
    ]);
    expect(docs.find((d) => d.id === 'src/collections.ts')?.lines).toBe(3);
  });

  it('scores a run at file level only, with the fixed parameters in the report', async () => {
    const report = await runLexicalBench({
      dataset: dataset(),
      limit: 10,
      source: root,
      repoRoot: root,
      cacheDir: root,
      label: 'test',
      log: () => {},
    });
    expect(report.config.mode).toBe('bm25-files');
    expect(report.config.lexical).toEqual({ k1: 1.2, b: 0.75, files: { demo: 4 } });
    expect(report.overall.chunk).toBeUndefined();
    expect(report.queries.every((q) => q.chunk === undefined)).toBe(true);

    const byId = Object.fromEntries(report.queries.map((q) => [q.id, q]));
    expect(byId['id-01']?.hits[0]?.file).toMatch(/^src\/collections(\.test)?\.ts$/);
    expect(byId['id-01']?.file['recall@10']).toBe(1);
    expect(byId['nl-01']?.file['recall@1']).toBe(1);
    expect(byId['nl-02']?.hits).toEqual([]);
    expect(byId['nl-02']?.file['recall@10']).toBe(0);
    expect(report.byType['nl']?.count).toBe(2);
    expect(report.byType['nl']?.chunk).toBeUndefined();
  });

  it('renders a summary without a chunk row', async () => {
    const report = await runLexicalBench({
      dataset: dataset(),
      limit: 10,
      source: root,
      repoRoot: root,
      cacheDir: root,
      log: () => {},
    });
    const md = renderSummary(report);
    expect(md).toContain('Okapi BM25 k1=1.2 b=0.75');
    expect(md).toContain('| file |');
    expect(md).not.toContain('| chunk |');
    expect(md).toContain('Chunk-level metrics do not apply');
    expect(md).toContain('| nl-02 |');
  });

  it('only runs the selected query types', async () => {
    const report = await runLexicalBench({
      dataset: dataset(),
      limit: 10,
      source: root,
      repoRoot: root,
      cacheDir: root,
      types: ['identifier'],
      log: () => {},
    });
    expect(report.queries.map((q) => q.id)).toEqual(['id-01']);
  });

  it('reports a query naming an unknown project as an error, scored zero', async () => {
    const ds = dataset();
    ds.queries[0] = { ...ds.queries[0]!, project: 'missing' };
    const report = await runLexicalBench({
      dataset: ds,
      limit: 10,
      source: root,
      repoRoot: root,
      cacheDir: root,
      log: () => {},
    });
    expect(report.queries[0]?.error).toMatch(/missing/);
    expect(report.overall.errors).toBe(1);
  });

  it('compares with a dense report at file level and says so', async () => {
    const lexical = await runLexicalBench({
      dataset: dataset(),
      limit: 10,
      source: root,
      repoRoot: root,
      cacheDir: root,
      log: () => {},
    });
    const dense = structuredClone(lexical);
    dense.config = { ...dense.config, mode: 'search_code', embedModel: 'm', group: 'g' };
    delete dense.config.lexical;
    const metrics = { 'recall@1': 1, 'recall@5': 1, 'recall@10': 1, 'mrr@10': 1, 'ndcg@10': 1 };
    dense.overall.chunk = metrics;
    for (const q of dense.queries) q.chunk = metrics;
    for (const a of Object.values(dense.byType)) a.chunk = metrics;
    // A dense miss that the lexical arm finds, and the reverse.
    const nl02 = dense.queries.find((q) => q.id === 'nl-02')!;
    nl02.file = { ...metrics };
    const id01 = dense.queries.find((q) => q.id === 'id-01')!;
    id01.file = { 'recall@1': 0, 'recall@5': 0, 'recall@10': 0, 'mrr@10': 0, 'ndcg@10': 0 };

    const cmp = compareReports(dense, lexical);
    expect(cmp.chunkLevel).toBe(false);
    expect(cmp.warnings.join(' ')).toMatch(/file level only/);
    expect(cmp.changed.map((d) => d.id).sort()).toEqual(['id-01', 'nl-02']);

    const md = renderComparison(dense, lexical);
    expect(md).toContain('| file R@10 |');
    expect(md).not.toContain('chunk R@10');
    expect(md).toContain('## Regressed (1)');
    expect(md).toContain('## Improved (1)');
  });
});
