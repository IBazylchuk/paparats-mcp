import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'module';
import { chunkByAst, dedupeContainedChunks } from '../src/ast-chunker.js';
import type { ChunkResult } from '../src/types.js';

const require = createRequire(import.meta.url);

let parser: Parser;
let typescript: Language;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  typescript = await Language.load(
    require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm')
  );
  parser.setLanguage(typescript);
});

afterAll(() => parser?.delete());

describe('chunkByAst: no overlapping chunks for a single declaration', () => {
  it('a single large export const declaration produces non-overlapping chunks', () => {
    // Build a markdown-content-style file: one big `export const X = \`...\``
    // The string body is 80 lines long to exceed maxChunkSize.
    const body = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const code = `export const homeMarkdown = \`\n${body}\n\`;\n`;
    const tree = parser.parse(code);
    const chunks = chunkByAst(tree, code, { chunkSize: 400, maxChunkSize: 800 });
    tree.delete();

    // Sanity: at least one chunk
    expect(chunks.length).toBeGreaterThan(0);

    // No two chunks should overlap line ranges
    for (let i = 0; i < chunks.length; i++) {
      for (let j = i + 1; j < chunks.length; j++) {
        const a = chunks[i]!;
        const b = chunks[j]!;
        const overlap = !(a.endLine < b.startLine || b.endLine < a.startLine);
        if (overlap) {
          throw new Error(
            `Chunks overlap: [${a.startLine}-${a.endLine}] vs [${b.startLine}-${b.endLine}]`
          );
        }
      }
    }
  });

  it('does NOT emit zero-content single-line preamble chunks before a declaration', () => {
    // A declaration that starts on line 0 — there should not be a (0-0) wrapper
    // before the (0-N) body.
    const body = Array.from({ length: 80 }, () => 'a'.repeat(20)).join('\n');
    const code = `export const homeMarkdown = \`\n${body}\n\`;\n`;
    const tree = parser.parse(code);
    const chunks = chunkByAst(tree, code, { chunkSize: 400, maxChunkSize: 800 });
    tree.delete();
    // Diagnostic — visible on failure
    const summary = chunks.map(
      (c) => `(${c.startLine}-${c.endLine} :: ${c.content.slice(0, 30).replace(/\n/g, '\\n')}...)`
    );
    // Find chunks both starting at line 0
    const startingAt0 = chunks.filter((c) => c.startLine === 0);
    if (startingAt0.length > 1) {
      throw new Error(`Multiple chunks start at line 0: ${summary.join('\n  ')}`);
    }
    expect(startingAt0.length).toBeLessThanOrEqual(1);
  });
});

describe('dedupeContainedChunks (direct unit tests)', () => {
  const mk = (startLine: number, endLine: number, tag = ''): ChunkResult => ({
    content: tag || `${startLine}-${endLine}`,
    startLine,
    endLine,
    hash: `${startLine}-${endLine}-${tag}`,
  });

  it('drops chunks fully contained in another chunk', () => {
    const input = [mk(0, 0, 'inner'), mk(0, 62, 'outer')];
    const result = dedupeContainedChunks(input);
    expect(result.map((c) => c.content)).toEqual(['outer']);
  });

  it('keeps the first chunk on identical ranges (tie-break by emission order)', () => {
    const input = [mk(5, 10, 'first'), mk(5, 10, 'second')];
    const result = dedupeContainedChunks(input);
    expect(result.map((c) => c.content)).toEqual(['first']);
  });

  it('keeps partially overlapping chunks (only strict containment drops)', () => {
    // (0,10) and (5,15) overlap but neither contains the other
    const input = [mk(0, 10, 'a'), mk(5, 15, 'b')];
    const result = dedupeContainedChunks(input);
    expect(result.map((c) => c.content)).toEqual(['a', 'b']);
  });

  it('keeps disjoint chunks', () => {
    const input = [mk(0, 5, 'a'), mk(10, 20, 'b'), mk(25, 30, 'c')];
    const result = dedupeContainedChunks(input);
    expect(result.map((c) => c.content)).toEqual(['a', 'b', 'c']);
  });

  it('preserves original emission order of survivors', () => {
    // Emit out of sort-order: big outer comes last, two inners first
    const input = [mk(5, 10, 'inner1'), mk(20, 25, 'inner2'), mk(0, 100, 'outer')];
    const result = dedupeContainedChunks(input);
    expect(result.map((c) => c.content)).toEqual(['outer']);
  });

  it('handles empty and single-chunk inputs', () => {
    expect(dedupeContainedChunks([])).toEqual([]);
    const single = [mk(0, 10, 'only')];
    expect(dedupeContainedChunks(single)).toEqual(single);
  });

  it('drops multiple contained chunks under one outer', () => {
    const input = [mk(0, 100, 'outer'), mk(5, 10, 'inner1'), mk(20, 30, 'inner2')];
    const result = dedupeContainedChunks(input);
    expect(result.map((c) => c.content)).toEqual(['outer']);
  });
});
