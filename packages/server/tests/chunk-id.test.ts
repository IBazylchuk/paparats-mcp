import { describe, it, expect } from 'vitest';
import {
  buildChunkId,
  parseChunkId,
  applyProjectSuffix,
  stripProjectSuffix,
} from '../src/indexer.js';

describe('buildChunkId', () => {
  it('builds a deterministic chunk_id', () => {
    const id = buildChunkId(
      'backend',
      'paparats-mcp',
      'src/indexer.ts',
      42,
      68,
      'a1b2c3d4e5f6g7h8'
    );
    expect(id).toBe('backend//paparats-mcp//src/indexer.ts//42-68//a1b2c3d4e5f6g7h8');
  });

  it('same inputs produce same output', () => {
    const a = buildChunkId('g', 'p', 'f.ts', 1, 10, 'hash1');
    const b = buildChunkId('g', 'p', 'f.ts', 1, 10, 'hash1');
    expect(a).toBe(b);
  });

  it('different inputs produce different output', () => {
    const a = buildChunkId('g', 'p', 'f.ts', 1, 10, 'hash1');
    const b = buildChunkId('g', 'p', 'f.ts', 1, 10, 'hash2');
    expect(a).not.toBe(b);
  });
});

describe('parseChunkId', () => {
  it('parses a valid chunk_id', () => {
    const result = parseChunkId('backend//paparats-mcp//src/indexer.ts//42-68//a1b2c3d4');
    expect(result).toEqual({
      group: 'backend',
      project: 'paparats-mcp',
      file: 'src/indexer.ts',
      startLine: 42,
      endLine: 68,
      hash: 'a1b2c3d4',
    });
  });

  it('returns null for invalid format (too few parts)', () => {
    expect(parseChunkId('backend//paparats-mcp//src/indexer.ts')).toBeNull();
  });

  it('returns null for invalid format (too many parts)', () => {
    expect(parseChunkId('a//b//c//1-2//hash//extra')).toBeNull();
  });

  it('returns null for invalid line range', () => {
    expect(parseChunkId('g//p//f//abc//hash')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseChunkId('')).toBeNull();
  });

  it('roundtrips with buildChunkId', () => {
    const id = buildChunkId('mygroup', 'myproject', 'src/deep/path.ts', 100, 200, 'abc123');
    const parsed = parseChunkId(id);
    expect(parsed).toEqual({
      group: 'mygroup',
      project: 'myproject',
      file: 'src/deep/path.ts',
      startLine: 100,
      endLine: 200,
      hash: 'abc123',
    });
  });
});

describe('applyProjectSuffix', () => {
  it('is a no-op when the suffix is empty (upstream behavior)', () => {
    expect(applyProjectSuffix('feed-poster', '')).toBe('feed-poster');
  });

  it('appends the suffix when set', () => {
    expect(applyProjectSuffix('feed-poster', '-v3')).toBe('feed-poster-v3');
  });

  it('is idempotent — never double-appends', () => {
    const once = applyProjectSuffix('feed-poster', '-v3');
    const twice = applyProjectSuffix(once, '-v3');
    expect(twice).toBe('feed-poster-v3');
  });

  it('applying three times is still single-suffixed (eviction path safety)', () => {
    // deleteProjectChunks may be reached via the eviction path (already
    // suffixed) or directly (clean) — idempotency must survive repeated calls.
    let n = 'billing';
    n = applyProjectSuffix(n, '-v3');
    n = applyProjectSuffix(n, '-v3');
    n = applyProjectSuffix(n, '-v3');
    expect(n).toBe('billing-v3');
  });

  it('leaves an empty project name empty when suffix is empty', () => {
    expect(applyProjectSuffix('', '')).toBe('');
  });

  it('suffixes an empty project name when a suffix is set (degenerate but defined)', () => {
    // Real projects are never empty, but the function must stay total.
    expect(applyProjectSuffix('', '-v3')).toBe('-v3');
  });

  it('treats the suffix as a literal substring, not a separator', () => {
    // No implicit dash handling — whatever the operator sets is appended as-is.
    expect(applyProjectSuffix('billing', '_staging')).toBe('billing_staging');
  });

  it('does not re-append when the name merely contains (not ends with) the suffix', () => {
    // "-v3" appears mid-string but not at the end → suffix must still append.
    expect(applyProjectSuffix('v3-service', '-v3')).toBe('v3-service-v3');
  });

  it('is case-sensitive (endsWith is case-sensitive)', () => {
    // "billing-V3" does not end with "-v3", so the suffix is appended.
    expect(applyProjectSuffix('billing-V3', '-v3')).toBe('billing-V3-v3');
  });

  it('KNOWN LIMITATION: a name that already ends with the suffix is not doubled', () => {
    // A real project literally named "foo-v3" collides with suffix "-v3": it is
    // stored un-doubled. Documented in applyProjectSuffix — do not name projects
    // with the active suffix.
    expect(applyProjectSuffix('foo-v3', '-v3')).toBe('foo-v3');
  });
});

describe('stripProjectSuffix', () => {
  it('is a no-op when the suffix is empty', () => {
    expect(stripProjectSuffix('feed-poster', '')).toBe('feed-poster');
  });

  it('strips the suffix when present', () => {
    expect(stripProjectSuffix('feed-poster-v3', '-v3')).toBe('feed-poster');
  });

  it('leaves names that do not carry the suffix untouched', () => {
    // e.g. a chunk written by the OLD stand (no suffix) surfacing on the new one
    expect(stripProjectSuffix('feed-poster', '-v3')).toBe('feed-poster');
  });

  it('round-trips with applyProjectSuffix', () => {
    const stored = applyProjectSuffix('billing', '-v3');
    expect(stripProjectSuffix(stored, '-v3')).toBe('billing');
  });

  it('only strips a trailing occurrence, not a mid-string one', () => {
    // "-v3" in the middle must be preserved; only a trailing match is stripped.
    expect(stripProjectSuffix('v3-service', '-v3')).toBe('v3-service');
  });

  it('strips only one suffix occurrence when the name ends with two', () => {
    // Defensive: a hypothetical double-suffixed name loses exactly one suffix,
    // mirroring the single append applyProjectSuffix would have done.
    expect(stripProjectSuffix('billing-v3-v3', '-v3')).toBe('billing-v3');
  });

  it('is case-sensitive — a differently-cased tail is preserved', () => {
    expect(stripProjectSuffix('billing-V3', '-v3')).toBe('billing-V3');
  });

  it('returns empty string when the name equals the suffix exactly', () => {
    expect(stripProjectSuffix('-v3', '-v3')).toBe('');
  });

  it('KNOWN LIMITATION: over-strips a real name that ends with the suffix', () => {
    // Mirror of the applyProjectSuffix collision: "foo-v3" strips to "foo".
    expect(stripProjectSuffix('foo-v3', '-v3')).toBe('foo');
  });

  it('empty suffix never strips even from an empty name', () => {
    expect(stripProjectSuffix('', '')).toBe('');
  });
});
