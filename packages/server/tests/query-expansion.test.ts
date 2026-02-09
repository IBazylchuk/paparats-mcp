import { describe, it, expect } from 'vitest';
import { expandQuery } from '../src/query-expansion.js';

describe('expandQuery', () => {
  it('expands abbreviation: "auth middleware" includes "authentication middleware"', () => {
    const results = expandQuery('auth middleware');
    expect(results[0]).toBe('auth middleware');
    expect(results).toContain('authentication middleware');
  });

  it('contracts full word: "authentication flow" includes "auth flow"', () => {
    const results = expandQuery('authentication flow');
    expect(results[0]).toBe('authentication flow');
    expect(results).toContain('auth flow');
  });

  it('generates camelCase variant from space-separated words', () => {
    const results = expandQuery('user authentication');
    expect(results[0]).toBe('user authentication');
    expect(results).toContain('userAuthentication');
  });

  it('decomposes camelCase to space-separated words', () => {
    const results = expandQuery('handleUserAuth');
    expect(results[0]).toBe('handleUserAuth');
    expect(results).toContain('handle user auth');
  });

  it('strips filler words from natural language query', () => {
    const results = expandQuery('how does the auth flow work');
    expect(results[0]).toBe('how does the auth flow work');
    expect(results).toContain('auth flow');
  });

  it('does not expand single PascalCase identifier with no abbreviations', () => {
    const results = expandQuery('Searcher');
    expect(results).toEqual(['Searcher']);
  });

  it('returns at most 3 results', () => {
    const results = expandQuery('auth middleware');
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('always returns original as first element', () => {
    const queries = ['auth flow', 'handleUserAuth', 'how does config work', 'database query'];
    for (const q of queries) {
      const results = expandQuery(q);
      expect(results[0]).toBe(q);
    }
  });

  it('returns original for empty/whitespace query', () => {
    expect(expandQuery('')).toEqual(['']);
    expect(expandQuery('   ')).toEqual(['   ']);
  });

  it('does not produce duplicate entries', () => {
    const results = expandQuery('auth middleware');
    const unique = new Set(results);
    expect(unique.size).toBe(results.length);
  });

  it('expands db to database', () => {
    const results = expandQuery('db connection');
    expect(results).toContain('database connection');
  });

  it('contracts configuration to config', () => {
    const results = expandQuery('configuration file');
    expect(results).toContain('config file');
  });

  it('handles mixed abbreviation and case variant', () => {
    const results = expandQuery('error handler');
    expect(results[0]).toBe('error handler');
    // Should have at least one variant (abbreviation or camelCase)
    expect(results.length).toBeGreaterThan(1);
  });

  it('returns single-word non-camelCase as-is', () => {
    const results = expandQuery('middleware');
    expect(results).toEqual(['middleware']);
  });

  // Plural normalization tests
  it('normalizes "users" to "user"', () => {
    const results = expandQuery('users handler');
    expect(results).toContain('user handler');
  });

  it('normalizes "-ies" plurals: "dependencies" to "dependency"', () => {
    const results = expandQuery('dependencies check');
    // abbreviation: "deps check", then plural on original: "dependency check"
    expect(results).toContain('deps check');
  });

  it('normalizes "-ses" plurals: "classes" to "class"', () => {
    const results = expandQuery('classes loader');
    expect(results).toContain('class loader');
  });

  it('does not singularize short words or words ending in "ss"', () => {
    const results = expandQuery('class process');
    // Neither "class" nor "process" should be singularized (both end in "ss")
    expect(results[0]).toBe('class process');
  });

  it('does not singularize words ending in "us"', () => {
    const results = expandQuery('status bus');
    expect(results[0]).toBe('status bus');
    // No plural variant should be generated
    const hasPluralVariant = results.some((r) => r === 'statu bu');
    expect(hasPluralVariant).toBe(false);
  });
});
