import { describe, it, expect } from 'vitest';
import { buildChunkId, parseChunkId } from '../src/indexer.js';

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
