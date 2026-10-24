import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'module';
import { chunkByAst, mergeSmallChunks } from '../src/ast-chunker.js';
import type { ChunkResult } from '../src/types.js';

const require = createRequire(import.meta.url);

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(
    await Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'))
  );
});

afterAll(() => parser?.delete());

const config = { chunkSize: 400, maxChunkSize: 1200 };

/** A class too big for one chunk: one-line fields, a few methods, a closing brace. */
function oversizedClass(): string {
  const fields = Array.from({ length: 30 }, (_, i) => `  private field${i}: number = ${i};`);
  const methods = Array.from({ length: 14 }, (_, i) =>
    [
      `  method${i}(input: string): string {`,
      `    const trimmed = input.trim();`,
      `    return trimmed.length > ${i} ? trimmed.slice(${i}) : trimmed;`,
      `  }`,
      '',
    ].join('\n')
  );
  return ['export class Store {', ...fields, '', ...methods, '}', ''].join('\n');
}

function chunk(code: string): ChunkResult[] {
  const tree = parser.parse(code)!;
  try {
    return chunkByAst(tree, code, config);
  } finally {
    tree.delete();
  }
}

describe('chunkByAst: small pieces of a split node are merged', () => {
  it('emits no one-line field or lone closing-brace chunk', () => {
    const chunks = chunk(oversizedClass());

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.trim(), `trivial chunk at line ${c.startLine}`).not.toMatch(/^[\s})\];,]*$/);
      expect(c.content.trim().length, `tiny chunk at line ${c.startLine}`).toBeGreaterThan(64);
    }
  });

  it('keeps every non-blank line, in order, without overlap or oversized chunks', () => {
    const code = oversizedClass();
    const lines = code.split('\n');
    const chunks = chunk(code);

    const covered = new Set<number>();
    for (const [i, c] of chunks.entries()) {
      expect(c.content.length).toBeLessThanOrEqual(config.maxChunkSize);
      expect(c.content).toBe(lines.slice(c.startLine, c.endLine + 1).join('\n'));
      if (i > 0) expect(c.startLine).toBeGreaterThan(chunks[i - 1]!.endLine);
      for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    }
    lines.forEach((line, l) => {
      if (line.trim()) expect(covered.has(l), `line ${l} lost`).toBe(true);
    });
  });
});

describe('mergeSmallChunks', () => {
  const lines = [
    'const a = 1;', // 0
    '', // 1
    'const b = 2;', // 2
    '// a comment that stays between the two', // 3
    'const c = 3;', // 4
    '}', // 5
  ];
  const at = (start: number, end: number): ChunkResult => ({
    content: lines.slice(start, end + 1).join('\n'),
    startLine: start,
    endLine: end,
    hash: `h${start}-${end}`,
  });

  it('merges neighbours separated only by blank lines', () => {
    const merged = mergeSmallChunks([at(0, 0), at(2, 2)], lines, config);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startLine: 0, endLine: 2 });
    expect(merged[0]!.content).toBe('const a = 1;\n\nconst b = 2;');
  });

  it('does not merge across lines that belong to no chunk', () => {
    // Line 3 is not in either chunk; joining would silently index it twice or not at all.
    const merged = mergeSmallChunks([at(2, 2), at(4, 4)], lines, config);
    expect(merged).toHaveLength(2);
  });

  it('keeps two ordinary chunks apart when together they exceed chunkSize', () => {
    const big = Array.from({ length: 10 }, (_, i) => `const value${i} = compute(${i}, 'x');`);
    const half = (start: number): ChunkResult => ({
      content: big.slice(start, start + 5).join('\n'),
      startLine: start,
      endLine: start + 4,
      hash: `b${start}`,
    });
    const merged = mergeSmallChunks([half(0), half(5)], big, {
      chunkSize: 250,
      maxChunkSize: 1200,
    });
    expect(merged).toHaveLength(2);
  });

  it('lets a trivial chunk join past chunkSize, but never past maxChunkSize', () => {
    const body = Array.from({ length: 8 }, (_, i) => `  statement${i}(alpha, beta, gamma);`);
    const file = ['function run() {', ...body, '}'];
    const fn: ChunkResult = {
      content: file.slice(0, 9).join('\n'),
      startLine: 0,
      endLine: 8,
      hash: 'fn',
    };
    const brace: ChunkResult = { content: '}', startLine: 9, endLine: 9, hash: 'brace' };

    const roomy = mergeSmallChunks([fn, brace], file, { chunkSize: 100, maxChunkSize: 1200 });
    expect(roomy).toHaveLength(1);
    expect(roomy[0]!.endLine).toBe(9);

    const tight = mergeSmallChunks([fn, brace], file, { chunkSize: 100, maxChunkSize: 200 });
    expect(tight).toHaveLength(2);
  });
});
