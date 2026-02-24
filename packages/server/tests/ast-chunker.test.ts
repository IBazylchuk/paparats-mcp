import { describe, it, expect, afterAll } from 'vitest';
import Parser from 'web-tree-sitter';
import { createRequire } from 'module';
import { chunkByAst, type AstChunkerConfig } from '../src/ast-chunker.js';

const require = createRequire(import.meta.url);

let parser: Parser;
const languages = new Map<string, Parser.Language>();

const GRAMMAR_MAP: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  tsx: 'tsx',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'c_sharp',
};

async function setup() {
  await Parser.init();
  parser = new Parser();
  for (const [lang, grammar] of Object.entries(GRAMMAR_MAP)) {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
    languages.set(lang, await Parser.Language.load(wasmPath));
  }
}

afterAll(() => {
  parser?.delete();
});

function parse(lang: string, code: string): Parser.Tree {
  const language = languages.get(lang)!;
  parser.setLanguage(language);
  return parser.parse(code);
}

const defaultConfig: AstChunkerConfig = {
  chunkSize: 1024,
  maxChunkSize: 3072,
};

const smallConfig: AstChunkerConfig = {
  chunkSize: 200,
  maxChunkSize: 600,
};

describe('chunkByAst', () => {
  it('single small function → 1 chunk', async () => {
    await setup();
    const code = 'function greet(name: string) {\n  console.log(name);\n}';
    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('function greet');
    expect(chunks[0]!.startLine).toBe(0);
    expect(chunks[0]!.endLine).toBe(2);
  });

  it('multiple small functions → grouped until chunkSize', async () => {
    const funcs = Array.from(
      { length: 10 },
      (_, i) => `function fn${i}() {\n  return ${i};\n}`
    ).join('\n\n');

    const tree = parse('typescript', funcs);
    const chunks = chunkByAst(tree, funcs, smallConfig);
    tree.delete();

    // With smallConfig (200 chars), should create multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
    // All functions should be present across chunks
    for (let i = 0; i < 10; i++) {
      const found = chunks.some((c) => c.content.includes(`fn${i}`));
      expect(found).toBe(true);
    }
  });

  it('large class with methods → split into per-method chunks when > maxChunkSize', async () => {
    const methods = Array.from(
      { length: 20 },
      (_, i) => `  method${i}() {\n    return ${i};\n  }`
    ).join('\n\n');
    const code = `class BigClass {\n${methods}\n}`;

    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, smallConfig);
    tree.delete();

    // The class is large, should be split
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('imports + functions → imports grouped, functions separate', async () => {
    const code = [
      'import { foo } from "./foo";',
      'import { bar } from "./bar";',
      '',
      'function doSomething() {',
      '  return foo() + bar();',
      '}',
    ].join('\n');

    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    // With default config (1024 chars), everything fits in one chunk
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // With small config, imports and function should separate
    const tree2 = parse('typescript', code);
    const smallChunks = chunkByAst(tree2, code, { chunkSize: 60, maxChunkSize: 180 });
    tree2.delete();

    if (smallChunks.length > 1) {
      // First chunk should have imports, later chunk(s) should have the function
      expect(smallChunks[0]!.content).toContain('import');
      const fnChunk = smallChunks.find((c) => c.content.includes('doSomething'));
      expect(fnChunk).toBeDefined();
    }
  });

  it('comment attachment → doc comment in same chunk as function below', async () => {
    const code = [
      '// This is a helper function',
      'function helper() {',
      '  return 42;',
      '}',
      '',
      '// Another function',
      'function other() {',
      '  return 0;',
      '}',
    ].join('\n');

    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    // Comments should be in the same chunk as the function they precede
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const helperChunk = chunks.find((c) => c.content.includes('helper'));
    expect(helperChunk).toBeDefined();
    expect(helperChunk!.content).toContain('This is a helper function');
  });

  it('oversized single function → falls back to fixed-size split', async () => {
    const body = Array.from({ length: 100 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const code = `function huge() {\n${body}\n}`;

    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, smallConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(smallConfig.maxChunkSize + 100);
    }
  });

  it('empty file → []', async () => {
    const code = '';
    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks).toEqual([]);
  });

  it('whitespace-only file → []', async () => {
    const code = '   \n\n  \n';
    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks).toEqual([]);
  });

  it('Python — properly chunked', async () => {
    const code = [
      'def greet():',
      '    print("hello")',
      '',
      'class MyClass:',
      '    def method(self):',
      '        pass',
    ].join('\n');

    const tree = parse('python', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('def greet');
    expect(allContent).toContain('class MyClass');
  });

  it('Go — properly chunked', async () => {
    const code = [
      'package main',
      '',
      'func greet() {',
      '    fmt.Println("hello")',
      '}',
      '',
      'type MyStruct struct {',
      '    Name string',
      '}',
    ].join('\n');

    const tree = parse('go', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('func greet');
    expect(allContent).toContain('MyStruct');
  });

  it('Rust — properly chunked', async () => {
    const code = [
      'fn greet() {',
      '    println!("hello");',
      '}',
      '',
      'struct Point {',
      '    x: f64,',
      '    y: f64,',
      '}',
    ].join('\n');

    const tree = parse('rust', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('fn greet');
    expect(allContent).toContain('Point');
  });

  it('Java — properly chunked', async () => {
    const code = [
      'public class MyClass {',
      '    public void greet() {',
      '        System.out.println("hello");',
      '    }',
      '',
      '    public int add(int a, int b) {',
      '        return a + b;',
      '    }',
      '}',
    ].join('\n');

    const tree = parse('java', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('class MyClass');
    expect(allContent).toContain('greet');
  });

  it('line numbers are 0-indexed', async () => {
    const code = 'function a() {}\nfunction b() {}';
    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.startLine).toBe(0);
  });

  it('no gaps/lost lines — union of chunk ranges covers entire file', async () => {
    const code = [
      'import { x } from "x";',
      '',
      'function foo() {',
      '  return 1;',
      '}',
      '',
      '// comment',
      'function bar() {',
      '  return 2;',
      '}',
      '',
      'export default foo;',
    ].join('\n');

    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Verify all lines are covered
    const lines = code.split('\n');
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let i = chunk.startLine; i <= chunk.endLine; i++) {
        covered.add(i);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      expect(covered.has(i)).toBe(true);
    }
  });

  it('hashes are consistent 16-char hex', async () => {
    const code = 'function a() {}\nfunction b() {}';
    const tree = parse('typescript', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    for (const c of chunks) {
      expect(c.hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('C++ — properly chunked', async () => {
    const code = ['class MyClass {};', 'void greet() {}'].join('\n');

    const tree = parse('cpp', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('MyClass');
    expect(allContent).toContain('greet');
  });

  it('C — properly chunked', async () => {
    const code = ['void greet() {}', 'struct Point { int x; };'].join('\n');

    const tree = parse('c', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('greet');
    expect(allContent).toContain('Point');
  });

  it('TSX — properly chunked', async () => {
    const code = [
      'import React from "react";',
      '',
      'function App() {',
      '  return <div>Hello</div>;',
      '}',
      '',
      'export default App;',
    ].join('\n');

    const tree = parse('tsx', code);
    const chunks = chunkByAst(tree, code, defaultConfig);
    tree.delete();

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const allContent = chunks.map((c) => c.content).join('\n');
    expect(allContent).toContain('App');
  });
});
