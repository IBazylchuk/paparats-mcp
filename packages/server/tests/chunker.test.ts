import { describe, it, expect } from 'vitest';
import { Chunker } from '../src/chunker.js';

const chunker = new Chunker({ chunkSize: 1024, overlap: 128 });

describe('Chunker', () => {
  describe('chunk routing', () => {
    it('returns empty for blank content', () => {
      expect(chunker.chunk('', 'typescript')).toEqual([]);
      expect(chunker.chunk('   \n\n  ', 'ruby')).toEqual([]);
    });

    it('routes languages to correct strategy', () => {
      const ts = 'export function foo() {\n  return 1;\n}';
      const rb = 'def foo\n  1\nend';

      const tsChunks = chunker.chunk(ts, 'typescript');
      const rbChunks = chunker.chunk(rb, 'ruby');

      expect(tsChunks.length).toBeGreaterThan(0);
      expect(rbChunks.length).toBeGreaterThan(0);
      expect(tsChunks[0]!.content).toContain('export function foo');
      expect(rbChunks[0]!.content).toContain('def foo');
    });

    it('falls back to chunkFixed for unknown language', () => {
      const content = 'line1\nline2\nline3';
      const chunks = chunker.chunk(content, 'brainfuck');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]!.content).toBe(content);
    });

    it('routes TSX to chunkByBraces', () => {
      const tsx = 'export function App() {\n  return <div>Hello</div>;\n}';
      const chunks = chunker.chunk(tsx, 'tsx');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]!.content).toContain('function App');
    });
  });

  describe('chunkByBlocks (Ruby)', () => {
    it('splits Ruby methods into separate chunks', () => {
      const rb = [
        'def method_a',
        '  puts "a"',
        'end',
        '',
        'def method_b',
        '  puts "b"',
        'end',
      ].join('\n');

      const chunks = chunker.chunk(rb, 'ruby');
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.content).toContain('method_a');
      expect(chunks[1]!.content).toContain('method_b');
    });

    it('keeps nested blocks together', () => {
      const rb = [
        'class MyClass',
        '  def method_a',
        '    puts "a"',
        '  end',
        '',
        '  def method_b',
        '    puts "b"',
        '  end',
        'end',
      ].join('\n');

      const chunks = chunker.chunk(rb, 'ruby');
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toContain('class MyClass');
      expect(chunks[0]!.content).toContain('method_a');
      expect(chunks[0]!.content).toContain('method_b');
    });
  });

  describe('chunkByBraces (TypeScript)', () => {
    it('splits top-level declarations', () => {
      const ts = [
        'export function foo() {',
        '  return 1;',
        '}',
        '',
        'export function bar() {',
        '  return 2;',
        '}',
      ].join('\n');

      const chunks = chunker.chunk(ts, 'typescript');
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.content).toContain('foo');
      expect(chunks[1]!.content).toContain('bar');
    });

    it('keeps class with methods as one chunk', () => {
      const ts = ['export class Foo {', '  method() {', '    return 1;', '  }', '}'].join('\n');

      const chunks = chunker.chunk(ts, 'typescript');
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toContain('class Foo');
    });

    it('handles braces in strings/comments', () => {
      const ts = [
        'export function foo() {',
        '  const s = "{ not a brace }";',
        '  // } also not',
        '  return s;',
        '}',
      ].join('\n');

      const chunks = chunker.chunk(ts, 'typescript');
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.content).toContain('return s');
    });
  });

  describe('chunkByIndent (Python)', () => {
    it('splits top-level functions', () => {
      const py = ['def foo():', '    return 1', '', 'def bar():', '    return 2'].join('\n');

      const chunks = chunker.chunk(py, 'python');
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.content).toContain('foo');
      expect(chunks[1]!.content).toContain('bar');
    });
  });

  describe('chunkFixed', () => {
    it('produces overlapping chunks for large content', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(50)}`);
      const content = lines.join('\n');

      const chunks = chunker.chunk(content, 'unknown');
      expect(chunks.length).toBeGreaterThan(1);

      // Verify overlap: last lines of chunk N appear in chunk N+1
      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i + 1]!.startLine).toBeLessThan(chunks[i]!.endLine + 1);
      }
    });
  });

  describe('force split', () => {
    it('splits oversized Ruby methods', () => {
      const body = Array.from({ length: 500 }, (_, i) => `  line_${i} = ${i}`).join('\n');
      const rb = `def monster\n${body}\nend`;

      const small = new Chunker({ chunkSize: 512, overlap: 64 });
      const chunks = small.chunk(rb, 'ruby');

      // maxChunkSize = 512 * 3 = 1536 chars; the method is ~5000+ chars
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.content.length).toBeLessThanOrEqual(512 * 3 + 100); // small margin for split rounding
      }
    });

    it('splits oversized TypeScript functions', () => {
      const body = Array.from({ length: 500 }, (_, i) => `  const v${i} = ${i};`).join('\n');
      const ts = `export function huge() {\n${body}\n}`;

      const small = new Chunker({ chunkSize: 512, overlap: 64 });
      const chunks = small.chunk(ts, 'typescript');

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('splits single very long line without stack overflow', () => {
      const small = new Chunker({ chunkSize: 512, overlap: 64 });
      // TS/JS triggers chunkByBraces -> flushBuffer; single line exceeds maxChunkSize
      const hugeLine = 'export const x = "' + 'a'.repeat(10_000) + '";';
      const chunks = small.chunk(hugeLine, 'typescript');

      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.content.length).toBeLessThanOrEqual(512 * 3 + 1);
      }
    });
  });

  describe('hash', () => {
    it('returns consistent 16-char hex', () => {
      const h1 = chunker.hash('hello');
      const h2 = chunker.hash('hello');
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns different hashes for different content', () => {
      expect(chunker.hash('a')).not.toBe(chunker.hash('b'));
    });
  });

  describe('chunk metadata', () => {
    it('returns correct startLine/endLine', () => {
      const ts = ['// header', '', 'export function foo() {', '  return 1;', '}'].join('\n');

      const chunks = chunker.chunk(ts, 'typescript');
      // First chunk is the header comment, second is the function
      const fnChunk = chunks.find((c) => c.content.includes('function foo'));
      expect(fnChunk).toBeDefined();
      expect(fnChunk!.startLine).toBeGreaterThanOrEqual(0);
      expect(fnChunk!.endLine).toBeGreaterThanOrEqual(fnChunk!.startLine);
    });

    it('every chunk has a hash', () => {
      const content = 'def a\n  1\nend\ndef b\n  2\nend';
      const chunks = chunker.chunk(content, 'ruby');
      for (const c of chunks) {
        expect(c.hash).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  });
});
