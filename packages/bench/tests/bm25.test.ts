import { describe, expect, it } from 'vitest';
import { BM25_B, BM25_K1, Bm25Index, tokenize } from '../src/bm25.js';

describe('tokenize', () => {
  it('gives a camelCase identifier itself and its parts', () => {
    expect(tokenize('toCollectionName')).toEqual(['tocollectionname', 'to', 'collection', 'name']);
  });

  it('gives a snake_case identifier the same tokens as its camelCase form', () => {
    expect(tokenize('to_collection_name')).toEqual(tokenize('toCollectionName'));
  });

  it('splits acronyms from the word after them', () => {
    expect(tokenize('HTTPServer')).toEqual(['httpserver', 'http', 'server']);
    expect(tokenize('getHTTPResponse')).toEqual(['gethttpresponse', 'get', 'http', 'response']);
  });

  it('keeps digits with the letters before them', () => {
    expect(tokenize('utf8Decode')).toEqual(['utf8decode', 'utf8', 'decode']);
    expect(tokenize('v7')).toEqual(['v7']);
  });

  it('emits a one-part identifier once', () => {
    expect(tokenize('Collection')).toEqual(['collection']);
    expect(tokenize('CRON_FAST')).toEqual(['cronfast', 'cron', 'fast']);
    expect(tokenize('__init__')).toEqual(['init']);
  });

  it('treats everything but letters, digits and underscore as a separator', () => {
    expect(tokenize('packages/server/src/indexer.ts')).toEqual([
      'packages',
      'server',
      'src',
      'indexer',
      'ts',
    ]);
    expect(tokenize('indexing.respectGitignore')).toEqual([
      'indexing',
      'respectgitignore',
      'respect',
      'gitignore',
    ]);
  });

  it('does not stem or drop stop words', () => {
    expect(tokenize('the Indexing of files')).toEqual(['the', 'indexing', 'of', 'files']);
  });

  it('counts repeats', () => {
    expect(tokenize('a a A')).toEqual(['a', 'a', 'a']);
  });

  it('handles empty and symbol-only text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('--- ** //')).toEqual([]);
  });
});

describe('Bm25Index', () => {
  const docs = [
    { id: 'a.ts', text: 'alpha alpha alpha beta' },
    { id: 'b.ts', text: 'alpha gamma' },
    { id: 'c.ts', text: 'delta epsilon zeta eta theta' },
  ];

  it('uses the fixed parameters', () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
  });

  it('scores a single term like the Okapi formula with the non-negative idf', () => {
    // N = 3, n(beta) = 1, tf = 1, |a| = 4, avgdl = (4 + 2 + 5) / 3
    const idf = Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5));
    const avg = 11 / 3;
    const expected = (idf * 1 * 2.2) / (1 + 1.2 * (1 - 0.75 + 0.75 * (4 / avg)));
    const [hit, ...rest] = new Bm25Index(docs).search('beta', 10);
    expect(rest).toEqual([]);
    expect(hit?.id).toBe('a.ts');
    expect(hit?.score).toBeCloseTo(expected, 12);
  });

  it('ranks the file with more occurrences first and skips files with no query term', () => {
    const hits = new Bm25Index(docs).search('alpha', 10);
    expect(hits.map((h) => h.id)).toEqual(['a.ts', 'b.ts']);
  });

  it('saturates term frequency: three occurrences score less than three times one', () => {
    const idx = new Bm25Index([
      { id: 'one', text: 'x y z' },
      { id: 'three', text: 'x x x' },
      { id: 'none', text: 'q r s' },
    ]);
    const hits = idx.search('x', 10);
    const one = hits.find((h) => h.id === 'one')?.score ?? 0;
    const three = hits.find((h) => h.id === 'three')?.score ?? 0;
    expect(three).toBeGreaterThan(one);
    expect(three).toBeLessThan(3 * one);
  });

  it('prefers the shorter file at equal term frequency (length normalisation)', () => {
    const idx = new Bm25Index([
      { id: 'short', text: 'needle hay' },
      { id: 'long', text: `needle ${'hay '.repeat(40)}` },
      { id: 'other', text: 'unrelated words only' },
    ]);
    expect(idx.search('needle', 10).map((h) => h.id)).toEqual(['short', 'long']);
  });

  it('weights a rare term above a common one', () => {
    const idx = new Bm25Index([
      { id: 'rare', text: 'common rare' },
      { id: 'c1', text: 'common one' },
      { id: 'c2', text: 'common two' },
      { id: 'c3', text: 'common three' },
    ]);
    const hits = idx.search('common rare', 10);
    expect(hits[0]?.id).toBe('rare');
  });

  it('counts a repeated query term once', () => {
    const idx = new Bm25Index(docs);
    expect(idx.search('alpha alpha alpha', 10)).toEqual(idx.search('alpha', 10));
  });

  it('matches an identifier query through its parts and through the whole identifier', () => {
    const idx = new Bm25Index([
      { id: 'defines', text: 'export function toCollectionName(group) {}' },
      { id: 'snake', text: 'def to_collection_name(group)' },
      { id: 'words', text: 'the name of a collection' },
      { id: 'noise', text: 'nothing here' },
    ]);
    const ids = idx.search('toCollectionName', 10).map((h) => h.id);
    // Both spellings match on the whole identifier; the prose only on two parts.
    expect(ids).toHaveLength(3);
    expect(ids.slice(0, 2).sort()).toEqual(['defines', 'snake']);
    expect(ids[2]).toBe('words');
  });

  it('breaks ties by id and honours the limit', () => {
    const idx = new Bm25Index([
      { id: 'b', text: 'same' },
      { id: 'a', text: 'same' },
      { id: 'c', text: 'same' },
      { id: 'd', text: 'other' },
    ]);
    expect(idx.search('same', 2).map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty index, an empty query or an unknown term', () => {
    expect(new Bm25Index([]).search('x', 10)).toEqual([]);
    expect(new Bm25Index(docs).search('', 10)).toEqual([]);
    expect(new Bm25Index(docs).search('unseen', 10)).toEqual([]);
  });
});
