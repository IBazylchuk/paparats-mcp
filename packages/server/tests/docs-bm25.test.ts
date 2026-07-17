import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  tokenize,
  termToIndex,
  idf,
  buildDocumentSparseVector,
  buildQuerySparseVector,
  type CorpusStats,
} from '../src/docs/bm25.js';
import { DocsIdfStore } from '../src/docs/idf-store.js';

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Deploy the Feed-Poster service!')).toEqual([
      'deploy',
      'feed',
      'poster',
      'service',
    ]);
  });

  it('drops stop-words and single chars', () => {
    expect(tokenize('a b the cat')).toEqual(['cat']);
  });

  it('keeps underscores (identifiers)', () => {
    expect(tokenize('call index_project now')).toEqual(['call', 'index_project', 'now']);
  });
});

describe('termToIndex', () => {
  it('is deterministic and non-negative int32', () => {
    const a = termToIndex('billing');
    const b = termToIndex('billing');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0x7fffffff);
  });

  it('maps distinct terms to (almost always) distinct indices', () => {
    expect(termToIndex('deploy')).not.toBe(termToIndex('rollback'));
  });
});

describe('idf', () => {
  it('is higher for rarer terms', () => {
    const rare = idf(1, 1000);
    const common = idf(500, 1000);
    expect(rare).toBeGreaterThan(common);
  });

  it('returns 0 for an empty corpus', () => {
    expect(idf(0, 0)).toBe(0);
  });
});

describe('sparse vector builders', () => {
  const stats: CorpusStats = {
    docCount: 100,
    avgDocLength: 20,
    docFreq: (t) => (t === 'the' ? 100 : t === 'rollback' ? 2 : 10),
  };

  it('builds a document sparse vector with aligned indices/values', () => {
    const v = buildDocumentSparseVector('rollback the deploy rollback step', stats);
    expect(v.indices.length).toBe(v.values.length);
    expect(v.indices.length).toBeGreaterThan(0);
    // No NaN / negative weights.
    for (const w of v.values) expect(w).toBeGreaterThan(0);
  });

  it('weights a rare repeated term above a common one', () => {
    const v = buildDocumentSparseVector('rollback rollback deploy', stats);
    const rollbackIdx = termToIndex('rollback');
    const deployIdx = termToIndex('deploy');
    const wRollback = v.values[v.indices.indexOf(rollbackIdx)]!;
    const wDeploy = v.values[v.indices.indexOf(deployIdx)]!;
    expect(wRollback).toBeGreaterThan(wDeploy);
  });

  it('query vector weights by idf only (short-query treatment)', () => {
    const v = buildQuerySparseVector('rollback deploy', stats);
    expect(v.indices.length).toBe(2);
  });

  it('empty text yields an empty vector', () => {
    expect(buildDocumentSparseVector('', stats)).toEqual({ indices: [], values: [] });
  });
});

describe('DocsIdfStore', () => {
  const tmpFiles: string[] = [];
  const mkStore = () => {
    const p = path.join(
      os.tmpdir(),
      `docs-idf-test-${process.pid}-${tmpFiles.length}-${Math.floor(performance.now())}.db`
    );
    tmpFiles.push(p);
    return new DocsIdfStore(p);
  };

  afterEach(() => {
    for (const p of tmpFiles.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(p + suffix);
        } catch {
          // ignore
        }
      }
    }
  });

  it('accumulates doc frequencies and corpus totals', () => {
    const s = mkStore();
    s.addDocument('g', new Set(['deploy', 'rollback']), 2);
    s.addDocument('g', new Set(['deploy', 'billing']), 2);
    const stats = s.getCorpusStats('g');
    expect(stats.docCount).toBe(2);
    expect(stats.avgDocLength).toBe(2);
    expect(stats.docFreq('deploy')).toBe(2);
    expect(stats.docFreq('rollback')).toBe(1);
    expect(stats.docFreq('missing')).toBe(0);
    s.close();
  });

  it('removeDocument reverses a prior addDocument exactly', () => {
    const s = mkStore();
    s.addDocument('g', new Set(['deploy', 'rollback']), 3);
    s.addDocument('g', new Set(['deploy']), 1);
    s.removeDocument('g', new Set(['deploy', 'rollback']), 3);
    const stats = s.getCorpusStats('g');
    expect(stats.docCount).toBe(1);
    expect(stats.docFreq('deploy')).toBe(1);
    // rollback dropped to 0 → pruned.
    expect(stats.docFreq('rollback')).toBe(0);
    s.close();
  });

  it('isolates stats per group', () => {
    const s = mkStore();
    s.addDocument('a', new Set(['x']), 1);
    s.addDocument('b', new Set(['x', 'y']), 2);
    s.addDocument('b', new Set(['x']), 1);
    expect(s.getCorpusStats('a').docCount).toBe(1);
    expect(s.getCorpusStats('b').docCount).toBe(2);
    expect(s.getCorpusStats('a').docFreq('y')).toBe(0);
    expect(s.getCorpusStats('b').docFreq('x')).toBe(2);
    s.close();
  });

  it('clearGroup wipes a group without touching others', () => {
    const s = mkStore();
    s.addDocument('a', new Set(['x']), 1);
    s.addDocument('b', new Set(['y']), 1);
    s.clearGroup('a');
    expect(s.getCorpusStats('a').docCount).toBe(0);
    expect(s.getCorpusStats('b').docCount).toBe(1);
    s.close();
  });

  it('does not go negative when removing more than present', () => {
    const s = mkStore();
    s.addDocument('g', new Set(['x']), 1);
    s.removeDocument('g', new Set(['x']), 5); // over-subtract length
    const stats = s.getCorpusStats('g');
    expect(stats.docCount).toBe(0);
    expect(stats.avgDocLength).toBe(0);
    s.close();
  });
});
