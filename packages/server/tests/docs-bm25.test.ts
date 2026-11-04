import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import {
  tokenize,
  termToIndex,
  buildDocumentSparseVector,
  buildQuerySparseVector,
  type CorpusStats,
} from '../src/docs/bm25.js';
import { DocsIdfStore } from '../src/docs/idf-store.js';
import { stemmer } from 'stemmer';

const termIndex = (word: string) => termToIndex(tokenize(word)[0]!);

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumeric', () => {
    expect(tokenize('Deploy the Lantern-Sync service!')).toEqual([
      'deploi',
      'lantern',
      'sync',
      'servic',
    ]);
  });

  it('drops stop-words and single chars', () => {
    expect(tokenize('a b the cat')).toEqual(['cat']);
  });

  it('drops question words', () => {
    expect(tokenize('How do I rotate what key, and why?')).toEqual(['rotat', 'kei']);
  });

  it('reduces English words to their stem', () => {
    expect(tokenize('creating created creates')).toEqual(['creat', 'creat', 'creat']);
    expect(tokenize('applies applying')).toEqual(['appli', 'appli']);
  });

  it('keeps underscores (identifiers)', () => {
    expect(tokenize('call index_project now')).toEqual(['call', 'index_project', 'now']);
  });

  it('keeps words of other scripts whole', () => {
    expect(tokenize('Как работает очередь задач?')).toEqual([
      'как',
      'работает',
      'очередь',
      'задач',
    ]);
    expect(tokenize('Ελληνικά δοκιμή')).toEqual(['ελληνικά', 'δοκιμή']);
    // Combining marks of an Indic script are part of the word, not a split.
    expect(tokenize('हिन्दी भाषा')).toEqual(['हिन्दी', 'भाषा']);
  });

  it('drops accents on Latin letters only', () => {
    expect(tokenize('Über café naïve')).toEqual(['uber', 'cafe', 'naiv']);
    expect(tokenize('ёлка')).toEqual(['ёлка']);
  });

  it('splits a CJK run into bigrams', () => {
    expect(tokenize('検索設定')).toEqual(['検索', '索設', '設定']);
    expect(tokenize('React组件 和')).toEqual(['react', '组件', '和']);
  });

  it('tokenises ASCII text as before, up to stemming', () => {
    const before = (text: string) =>
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length > 1)
        .map((t) => (/^[a-z]+$/.test(t) ? stemmer(t) : t));
    const text =
      'Deploy `lantern-sync` v2.3 (see https://example.com/a_b?x=1); ' +
      "CamelCase, snake_case & kebab-case — it's 42% done. #tag @user\n\tEND";
    const tokens = tokenize(text);
    expect(tokens.length).toBeGreaterThan(15);
    // Stop-words aside (they never were tokens), the same tokens in the same order.
    expect(tokens).toEqual(before(text).filter((t) => tokenize(t).length > 0));
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

  it('weights a repeated term above a single one', () => {
    const v = buildDocumentSparseVector('rollback rollback deploy', stats);
    const rollbackIdx = termIndex('rollback');
    const deployIdx = termIndex('deploy');
    const wRollback = v.values[v.indices.indexOf(rollbackIdx)]!;
    const wDeploy = v.values[v.indices.indexOf(deployIdx)]!;
    expect(wRollback).toBeGreaterThan(wDeploy);
  });

  it('leaves the IDF out of document weights, since Qdrant applies it', () => {
    const rareEverywhere: CorpusStats = { ...stats, docFreq: () => 1 };
    const commonEverywhere: CorpusStats = { ...stats, docFreq: () => 99 };
    expect(buildDocumentSparseVector('rollback deploy', rareEverywhere)).toEqual(
      buildDocumentSparseVector('rollback deploy', commonEverywhere)
    );
  });

  it('gives each distinct query term a weight of 1', () => {
    const v = buildQuerySparseVector('rollback the deploy rollback');
    expect(v.indices).toEqual([termIndex('rollback'), termIndex('deploy')]);
    expect(v.values).toEqual([1, 1]);
  });

  it('returns an empty query vector when only stop-words remain', () => {
    expect(buildQuerySparseVector('how do I')).toEqual({ indices: [], values: [] });
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

  it('counts a new group as made with the current tokeniser', () => {
    const s = mkStore();
    expect(s.isCurrent('g')).toBe(false);
    s.addDocument('g', new Set(['x']), 1);
    expect(s.isCurrent('g')).toBe(true);
    s.close();
  });

  it('treats counts made with another tokeniser as stale until replaced', () => {
    const s = mkStore();
    s.addDocument('g', new Set(['ber']), 1);
    s.close();
    const p = tmpFiles[tmpFiles.length - 1]!;
    // An older store: counts without a recorded version.
    const raw = new Database(p);
    raw.prepare('DELETE FROM tokenizer').run();
    raw.close();

    const reopened = new DocsIdfStore(p);
    expect(reopened.isCurrent('g')).toBe(false);
    // A document added meanwhile does not make old counts current.
    reopened.addDocument('g', new Set(['uber']), 1);
    expect(reopened.isCurrent('g')).toBe(false);

    expect(reopened.replaceGroup('g', [{ terms: new Set(['uber']), length: 1 }])).toBe(true);
    const stats = reopened.getCorpusStats('g');
    expect(stats.docCount).toBe(1);
    expect(stats.docFreq('ber')).toBe(0);
    expect(stats.docFreq('uber')).toBe(1);
    expect(reopened.isCurrent('g')).toBe(true);
    // A second process finding them current leaves them alone.
    expect(reopened.replaceGroup('g', [{ terms: new Set(['x']), length: 1 }])).toBe(false);
    expect(reopened.getCorpusStats('g').docFreq('uber')).toBe(1);
    reopened.close();
  });

  it('keeps a partial replacement stale', () => {
    const s = mkStore();
    expect(s.replaceGroup('g', [{ terms: new Set(['x']), length: 1 }], false)).toBe(true);
    expect(s.getCorpusStats('g').docCount).toBe(1);
    expect(s.isCurrent('g')).toBe(false);
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

describe('buildDocumentSparseVector — empty corpus', () => {
  it('still weights the first document written into an empty corpus', () => {
    const emptyStats: CorpusStats = { docCount: 0, avgDocLength: 0, docFreq: () => 0 };
    const v = buildDocumentSparseVector('alpha beta gamma', emptyStats);
    expect(v.indices).toHaveLength(3);
    for (const w of v.values) expect(w).toBeGreaterThan(0);
  });
});
