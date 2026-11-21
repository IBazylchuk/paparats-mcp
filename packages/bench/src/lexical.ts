import fs from 'node:fs';
import path from 'node:path';
import { collectProjectFiles } from '@paparats/server';
import { detectNonSource } from '@paparats/shared';
import { BM25_B, BM25_K1, Bm25Index } from './bm25.js';
import { scoreQuery } from './metrics.js';
import { buildReport } from './report.js';
import { projectConfigFor, resolveSourceRoot, type RunOptions } from './runner.js';
import type { Dataset, Hit, QueryResult, Report } from './types.js';

export type LexicalRunOptions = Pick<
  RunOptions,
  'dataset' | 'limit' | 'source' | 'repoRoot' | 'cacheDir' | 'types' | 'label' | 'log'
>;

export interface FileDocument {
  /** Path relative to the project root, forward slashes — what a dense hit's `file` is. */
  id: string;
  text: string;
  lines: number;
}

/**
 * The text of a file as the indexer would index it, or null when it would not:
 * binary or invalid UTF-8, empty, or machine-generated (`indexFile` skips the same).
 */
export function readIndexable(buffer: Buffer): string | null {
  const text = buffer.toString('utf8');
  if (buffer.includes(0) || text.includes('�')) return null;
  if (!text.trim()) return null;
  if (detectNonSource(text).isNonSource) return null;
  return text;
}

/** Number of lines of a text, as an editor counts them (a trailing newline adds none). */
export function lineCount(text: string): number {
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * One document per file the indexer would index for a project: the server's own
 * file collection (patterns, excludes, gitignore, symlink guard), then the
 * content checks of `indexFile`. The text is the file's content alone.
 */
export async function projectDocuments(
  dir: string,
  name: string,
  group: string
): Promise<FileDocument[]> {
  const project = projectConfigFor(dir, name, group);
  const files = await collectProjectFiles(project);
  const docs: FileDocument[] = [];
  for (const file of files.sort()) {
    const text = readIndexable(await fs.promises.readFile(file));
    if (text === null) continue;
    docs.push({
      id: path.relative(project.path, file).split(path.sep).join('/'),
      text,
      lines: lineCount(text),
    });
  }
  return docs;
}

/** Rank a project's files for one query: the top `limit`, each hit spanning its whole file. */
export function searchFiles(
  index: Bm25Index,
  lines: Map<string, number>,
  query: string,
  limit: number
): Hit[] {
  return index.search(query, limit).map((h) => ({
    file: h.id,
    startLine: 1,
    endLine: lines.get(h.id) ?? 1,
    score: h.score,
  }));
}

/**
 * The lexical arm: Okapi BM25 (k1 = 1.2, b = 0.75) over whole files, fixed and
 * in memory — no Qdrant, no embedding server. Each project of the dataset is its
 * own corpus, as the dense search filters by project. Scored with the dense arm's
 * file-level metrics; chunk-level metrics are left out (a hit is a whole file).
 */
export async function runLexicalBench(opts: LexicalRunOptions): Promise<Report> {
  const dataset: Dataset = opts.dataset;
  const queries = opts.types
    ? dataset.queries.filter((q) => opts.types!.includes(q.type))
    : dataset.queries;
  if (queries.length === 0) throw new Error('No queries selected.');

  const sourceRoot = await resolveSourceRoot(opts);
  const group = `bench-${dataset.name}`;
  const corpora = new Map<string, { index: Bm25Index; lines: Map<string, number> }>();
  const files: Record<string, number> = {};
  for (const p of dataset.projects) {
    const dir = path.join(sourceRoot, p.path ?? '.');
    opts.log(`Reading ${p.name} (${dir})...`);
    const docs = await projectDocuments(dir, p.name, group);
    corpora.set(p.name, {
      index: new Bm25Index(docs, BM25_K1, BM25_B),
      lines: new Map(docs.map((d) => [d.id, d.lines])),
    });
    files[p.name] = docs.length;
    opts.log(`  ${docs.length} files`);
  }

  const results: QueryResult[] = [];
  for (const [i, q] of queries.entries()) {
    const corpus = corpora.get(q.project);
    const started = performance.now();
    let hits: Hit[] = [];
    let error: string | undefined;
    if (corpus) hits = searchFiles(corpus.index, corpus.lines, q.query, opts.limit);
    else error = `project "${q.project}" is not in the dataset's projects`;
    const latencyMs = performance.now() - started;
    const result: QueryResult = {
      id: q.id,
      type: q.type,
      query: q.query,
      project: q.project,
      latencyMs,
      hits,
      file: scoreQuery(hits, q.expected, 'file'),
      ...(error ? { error } : {}),
    };
    results.push(result);
    opts.log(
      `[${i + 1}/${queries.length}] ${q.id} ${error ? `ERROR ${error}` : `file RR ${result.file['mrr@10'].toFixed(2)}`}`
    );
  }

  return buildReport(
    dataset,
    {
      mode: 'bm25-files',
      group: '',
      limit: opts.limit,
      embedModel: 'none',
      lexical: { k1: BM25_K1, b: BM25_B, files },
      ...(opts.label ? { label: opts.label } : {}),
    },
    results
  );
}
