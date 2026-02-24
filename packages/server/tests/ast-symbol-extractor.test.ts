import { describe, it, expect, afterAll } from 'vitest';
import Parser from 'web-tree-sitter';
import { createRequire } from 'module';
import { extractSymbolsForChunks } from '../src/ast-symbol-extractor.js';

const require = createRequire(import.meta.url);

let parser: Parser;
const languages = new Map<string, Parser.Language>();

const GRAMMAR_MAP: Record<string, string> = {
  typescript: 'typescript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  ruby: 'ruby',
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

function parse(lang: string, code: string) {
  const language = languages.get(lang)!;
  parser.setLanguage(language);
  return { tree: parser.parse(code), language };
}

describe('extractSymbolsForChunks', () => {
  it('extracts TypeScript definitions and usages', async () => {
    await setup();
    const code = `function greet(name: string) { console.log(name); }
class MyClass {
  method() { greet('hello'); }
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 3 }],
      'typescript'
    );
    tree.delete();

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.defines_symbols).toContain('greet');
    expect(r.defines_symbols).toContain('MyClass');
    expect(r.defines_symbols).toContain('method');
    // greet is both defined and used in same chunk — should be removed from uses
    expect(r.uses_symbols).not.toContain('greet');
  });

  it('splits definitions and usages across chunks', async () => {
    const code = `function greet() {}
function callGreet() { greet(); }`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [
        { startLine: 0, endLine: 0 },
        { startLine: 1, endLine: 1 },
      ],
      'typescript'
    );
    tree.delete();

    expect(results).toHaveLength(2);
    expect(results[0]!.defines_symbols).toContain('greet');
    expect(results[1]!.defines_symbols).toContain('callGreet');
    expect(results[1]!.uses_symbols).toContain('greet');
  });

  it('filters noise keywords', async () => {
    const code = 'const myVar = true;\nconst otherVar = null;';
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 1 }],
      'typescript'
    );
    tree.delete();

    const r = results[0]!;
    // Variables with >=2 chars should be included
    expect(r.defines_symbols).toContain('myVar');
    expect(r.defines_symbols).toContain('otherVar');
    // noise keywords should not appear
    expect(r.uses_symbols).not.toContain('true');
    expect(r.uses_symbols).not.toContain('null');
  });

  it('filters single-char symbols', async () => {
    const code = 'const a = 1;';
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 0 }],
      'typescript'
    );
    tree.delete();

    // Single char 'a' should be filtered out (<2 chars)
    expect(results[0]!.defines_symbols).not.toContain('a');
  });

  it('removes self-references', async () => {
    // Recursive function: defines and uses 'factorial'
    const code =
      'function factorial(n: number): number { return n <= 1 ? 1 : n * factorial(n - 1); }';
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 0 }],
      'typescript'
    );
    tree.delete();

    const r = results[0]!;
    expect(r.defines_symbols).toContain('factorial');
    // Self-reference should be removed from uses
    expect(r.uses_symbols).not.toContain('factorial');
  });

  it('handles Python', async () => {
    const code = `def greet():
    print("hello")
class MyClass:
    pass`;
    const { tree, language } = parse('python', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 3 }],
      'python'
    );
    tree.delete();

    const r = results[0]!;
    expect(r.defines_symbols).toContain('greet');
    expect(r.defines_symbols).toContain('MyClass');
  });

  it('handles Go', async () => {
    const code = `package main
func greet() {}
type MyStruct struct {}`;
    const { tree, language } = parse('go', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 2 }], 'go');
    tree.delete();

    const r = results[0]!;
    expect(r.defines_symbols).toContain('greet');
    expect(r.defines_symbols).toContain('MyStruct');
  });

  it('handles Rust', async () => {
    const code = `fn greet() {}
struct Point {}
enum Color { Red }`;
    const { tree, language } = parse('rust', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 2 }], 'rust');
    tree.delete();

    const r = results[0]!;
    expect(r.defines_symbols).toContain('greet');
    expect(r.defines_symbols).toContain('Point');
    expect(r.defines_symbols).toContain('Color');
  });

  it('handles Java', async () => {
    const code = 'class MyClass { void method() {} }';
    const { tree, language } = parse('java', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 0 }], 'java');
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('MyClass');
    expect(results[0]!.defines_symbols).toContain('method');
  });

  it('handles Ruby', async () => {
    const code = `class MyClass
  def method
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 3 }], 'ruby');
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('MyClass');
    expect(results[0]!.defines_symbols).toContain('method');
  });

  it('handles C', async () => {
    const code = 'void greet() {}\nstruct Point { int x; };';
    const { tree, language } = parse('c', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 1 }], 'c');
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('greet');
    expect(results[0]!.defines_symbols).toContain('Point');
  });

  it('handles C++', async () => {
    const code = 'class MyClass {};\nvoid greet() {}';
    const { tree, language } = parse('cpp', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 1 }], 'cpp');
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('MyClass');
    expect(results[0]!.defines_symbols).toContain('greet');
  });

  it('handles C#', async () => {
    const code = 'class MyClass { void Method() {} }';
    const { tree, language } = parse('csharp', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 0 }],
      'csharp'
    );
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('MyClass');
    expect(results[0]!.defines_symbols).toContain('Method');
  });

  it('returns empty for unsupported language', async () => {
    const code = 'resource "aws_s3" {}';
    // Use any available tree for the test — just pass wrong lang id
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 0 }],
      'terraform'
    );
    tree.delete();

    expect(results[0]!.defines_symbols).toEqual([]);
    expect(results[0]!.uses_symbols).toEqual([]);
    expect(results[0]!.defined_symbols).toEqual([]);
  });

  it('deduplicates symbols', async () => {
    // Multiple references to same symbol
    const code = 'function foo() { bar(); bar(); bar(); }';
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 0 }],
      'typescript'
    );
    tree.delete();

    const uses = results[0]!.uses_symbols;
    const uniqueUses = [...new Set(uses)];
    expect(uses).toEqual(uniqueUses);
  });

  // ── Kind extraction tests ──────────────────────────────────────────────

  it('extracts kind for TypeScript symbols', async () => {
    const code = `function greet() {}
class MyClass {}
interface IFoo {}
type Bar = string;
enum Dir { Up }
const myVar = 1;`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 5 }],
      'typescript'
    );
    tree.delete();

    const syms = results[0]!.defined_symbols;
    const byName = new Map(syms.map((s) => [s.name, s.kind]));
    expect(byName.get('greet')).toBe('function');
    expect(byName.get('MyClass')).toBe('class');
    expect(byName.get('IFoo')).toBe('interface');
    expect(byName.get('Bar')).toBe('type');
    expect(byName.get('Dir')).toBe('enum');
    expect(byName.get('myVar')).toBe('variable');
  });

  it('extracts kind for TypeScript method', async () => {
    const code = `class Foo {
  doSomething() {}
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 2 }],
      'typescript'
    );
    tree.delete();

    const syms = results[0]!.defined_symbols;
    const method = syms.find((s) => s.name === 'doSomething');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('extracts kind for Python symbols', async () => {
    const code = `def greet():
    pass
class MyClass:
    pass`;
    const { tree, language } = parse('python', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 3 }],
      'python'
    );
    tree.delete();

    const syms = results[0]!.defined_symbols;
    const byName = new Map(syms.map((s) => [s.name, s.kind]));
    expect(byName.get('greet')).toBe('function');
    expect(byName.get('MyClass')).toBe('class');
  });

  it('extracts kind for Rust symbols', async () => {
    const code = `fn greet() {}
struct Point {}
enum Color { Red }
const MAX: u32 = 100;`;
    const { tree, language } = parse('rust', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 3 }], 'rust');
    tree.delete();

    const syms = results[0]!.defined_symbols;
    const byName = new Map(syms.map((s) => [s.name, s.kind]));
    expect(byName.get('greet')).toBe('function');
    expect(byName.get('Point')).toBe('class');
    expect(byName.get('Color')).toBe('enum');
    expect(byName.get('MAX')).toBe('constant');
  });

  it('extracts kind for Go symbols', async () => {
    const code = `package main
func greet() {}
type MyStruct struct {}`;
    const { tree, language } = parse('go', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 2 }], 'go');
    tree.delete();

    const syms = results[0]!.defined_symbols;
    const byName = new Map(syms.map((s) => [s.name, s.kind]));
    expect(byName.get('greet')).toBe('function');
    expect(byName.get('MyStruct')).toBe('type');
  });

  it('extracts kind for Ruby symbols', async () => {
    const code = `class MyClass
  def method
  end
end
module MyModule
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 5 }], 'ruby');
    tree.delete();

    const syms = results[0]!.defined_symbols;
    const byName = new Map(syms.map((s) => [s.name, s.kind]));
    expect(byName.get('MyClass')).toBe('class');
    expect(byName.get('method')).toBe('method');
    expect(byName.get('MyModule')).toBe('module');
  });

  it('defined_symbols and defines_symbols stay in sync', async () => {
    const code = 'function greet() {}\nclass MyClass {}';
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 1 }],
      'typescript'
    );
    tree.delete();

    const r = results[0]!;
    expect(r.defines_symbols).toEqual(r.defined_symbols.map((d) => d.name));
  });
});
