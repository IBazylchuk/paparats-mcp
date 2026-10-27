import { describe, it, expect, afterAll } from 'vitest';
import { Parser, Language } from 'web-tree-sitter';
import { createRequire } from 'module';
import { extractSymbolsForChunks } from '../src/ast-symbol-extractor.js';

const require = createRequire(import.meta.url);

let parser: Parser;
const languages = new Map<string, Language>();

const GRAMMAR_MAP: Record<string, string> = {
  typescript: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
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
    languages.set(lang, await Language.load(wasmPath));
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

  // ── Scope filter (only top-level / class-method declarations) ─────────

  it('filters out locals declared inside function bodies (TypeScript)', async () => {
    const code = `export function outer() {
  const innerConst = 1;
  function innerFn() {}
  const handleClick = () => {};
}
export const topLevelConst = 2;
function topLevelFn() {
  let result = 0;
  const merged = {};
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 9 }],
      'typescript'
    );
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('outer');
    expect(names).toContain('topLevelConst');
    expect(names).toContain('topLevelFn');
    // Locals must NOT appear — these are scope-blindness false positives
    // that show up as fake "dead code" if we leak them through.
    expect(names).not.toContain('innerConst');
    expect(names).not.toContain('innerFn');
    expect(names).not.toContain('handleClick');
    expect(names).not.toContain('result');
    expect(names).not.toContain('merged');
  });

  it('keeps methods on top-level classes (TypeScript)', async () => {
    const code = `export class Service {
  doWork() {
    const localVar = 1;
    return localVar;
  }
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 5 }],
      'typescript'
    );
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('Service');
    expect(names).toContain('doWork');
    expect(names).not.toContain('localVar');
  });

  // Multi-language scope-filter: each test asserts top-level declarations
  // stay in defines_symbols and locals declared inside function bodies do
  // not. Catches silent regressions if a tree-sitter grammar bump renames
  // a function-body node type.

  it('filters function-body locals (Python)', async () => {
    const code = `def outer():
    inner_local = 1
    def inner_fn():
        pass
    return inner_local

class Service:
    def method(self):
        method_local = 2
        return method_local

top_level_const = 3`;
    const { tree, language } = parse('python', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 11 }],
      'python'
    );
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('outer');
    expect(names).toContain('Service');
    expect(names).toContain('method');
    expect(names).not.toContain('inner_local');
    expect(names).not.toContain('inner_fn');
    expect(names).not.toContain('method_local');
  });

  it('filters function-body locals (Go)', async () => {
    const code = `package main

func outer() {
    innerVar := 1
    closure := func() {}
    _ = innerVar
    _ = closure
}

type MyStruct struct{}

func (s MyStruct) Method() {
    methodLocal := 2
    _ = methodLocal
}`;
    const { tree, language } = parse('go', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 13 }], 'go');
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('outer');
    expect(names).toContain('MyStruct');
    expect(names).toContain('Method');
    expect(names).not.toContain('innerVar');
    expect(names).not.toContain('closure');
    expect(names).not.toContain('methodLocal');
  });

  it('filters function-body locals (Rust)', async () => {
    const code = `fn outer() {
    let inner_var = 1;
    fn inner_fn() {}
    let closure = || {};
}

struct Service;

impl Service {
    fn method(&self) {
        let method_local = 2;
    }
}`;
    const { tree, language } = parse('rust', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 12 }],
      'rust'
    );
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('outer');
    expect(names).toContain('Service');
    expect(names).toContain('method');
    expect(names).not.toContain('inner_var');
    expect(names).not.toContain('inner_fn');
    expect(names).not.toContain('closure');
    expect(names).not.toContain('method_local');
  });

  it('filters function-body locals (Java)', async () => {
    const code = `public class Service {
    public void doWork() {
        int methodLocal = 1;
        String another = "x";
    }
    public Service() {
        int ctorLocal = 2;
    }
}`;
    const { tree, language } = parse('java', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 8 }], 'java');
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('Service');
    expect(names).toContain('doWork');
    expect(names).not.toContain('methodLocal');
    expect(names).not.toContain('another');
    expect(names).not.toContain('ctorLocal');
  });

  it('filters function-body locals (Ruby)', async () => {
    const code = `class Service
  def do_work
    method_local = 1
    do_other do |arg|
      block_local = 2
      block_local
    end
  end
end

module MyModule
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 11 }],
      'ruby'
    );
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('Service');
    expect(names).toContain('do_work');
    expect(names).toContain('MyModule');
    expect(names).not.toContain('method_local');
    expect(names).not.toContain('block_local');
  });

  it('filters function-body locals (C)', async () => {
    const code = `void greet(void) {
    int local_var = 1;
    int another = 2;
}

struct Point { int x; };`;
    const { tree, language } = parse('c', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 5 }], 'c');
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('greet');
    expect(names).toContain('Point');
    expect(names).not.toContain('local_var');
    expect(names).not.toContain('another');
  });

  it('filters function-body locals (C++)', async () => {
    // Note: the cpp definitions query catches free functions and class /
    // struct names. It does NOT capture in-class member-function names — a
    // pre-existing limitation of the query, not the scope filter.
    const code = `class Service {};

void freeFn() {
    int freeLocal = 3;
    auto closure = []() { int innermost = 2; return innermost; };
}`;
    const { tree, language } = parse('cpp', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 5 }], 'cpp');
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('Service');
    expect(names).toContain('freeFn');
    expect(names).not.toContain('freeLocal');
    expect(names).not.toContain('closure');
    expect(names).not.toContain('innermost');
  });

  it('filters function-body locals (C#)', async () => {
    const code = `class Service {
    public void DoWork() {
        int methodLocal = 1;
        var another = "x";
    }
    public Service() {
        int ctorLocal = 2;
    }
}`;
    const { tree, language } = parse('csharp', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 8 }],
      'csharp'
    );
    tree.delete();
    const names = results[0]!.defines_symbols;
    expect(names).toContain('Service');
    expect(names).toContain('DoWork');
    expect(names).not.toContain('methodLocal');
    expect(names).not.toContain('another');
    expect(names).not.toContain('ctorLocal');
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

  it('defines Ruby class methods and classes named with a namespace', async () => {
    const code = `class Billing::Invoice < Base
  def self.overdue(days)
  end
  class << self
    def open; end
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 6 }], 'ruby');
    tree.delete();

    const byName = new Map(results[0]!.defined_symbols.map((s) => [s.name, s.kind]));
    expect(byName.get('Invoice')).toBe('class');
    expect(byName.get('overdue')).toBe('method');
    expect(byName.get('open')).toBe('method');
    expect(byName.has('Billing')).toBe(false);
  });

  it('keeps a name the chunk defines when it is called on another object (Ruby)', async () => {
    const code = `class Quota
  def self.claim(user)
    Ledger.claim(user)
  end
end
class Retry
  def self.run(n)
    self.run(n - 1) if n > 0
    run(0)
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [
        { startLine: 0, endLine: 4 },
        { startLine: 5, endLine: 10 },
      ],
      'ruby'
    );
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('claim');
    expect(results[0]!.uses_symbols).toEqual(expect.arrayContaining(['Ledger', 'claim']));
    // Recursion through self or a bare call is not a use.
    expect(results[1]!.uses_symbols).not.toContain('run');
  });

  it('keeps a name the chunk defines when it is called on another object (TypeScript)', async () => {
    const code = `class Cache {
  get(k: string) {
    if (!this.has(k)) return this.get('x');
    return this.store.get(k);
  }
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 5 }],
      'typescript'
    );
    tree.delete();

    expect(results[0]!.defines_symbols).toContain('get');
    expect(results[0]!.uses_symbols).toContain('get');
  });

  it('drops a recursive this-call on a name the chunk defines (TypeScript)', async () => {
    const code = `class Walker {
  walk(n: number): void {
    if (n > 0) this.walk(n - 1);
  }
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 4 }],
      'typescript'
    );
    tree.delete();

    expect(results[0]!.uses_symbols).not.toContain('walk');
  });

  it('records the method each use is made from, also in a later chunk of that method (Ruby)', async () => {
    const code = `class Quota
  has_many :limits
  def first
    Ledger.post
  end
  def second
    Ledger.post
    Audit.record
    Notifier.ping
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [
        { startLine: 0, endLine: 6 },
        { startLine: 7, endLine: 10 },
      ],
      'ruby'
    );
    tree.delete();

    const sites = (i: number, name: string) =>
      results[i]!.use_sites!.filter((u) => u.name === name).map((u) => u.from);
    expect(sites(0, 'post').sort()).toEqual(['first', 'second']);
    expect(sites(0, 'has_many')).toEqual(['']);
    // `second` started in the first chunk; its tail still comes from it.
    expect(sites(1, 'record')).toEqual(['second']);
    expect(sites(1, 'ping')).toEqual(['second']);
  });

  it('records the class a use is called on, and the class of each method (Ruby)', async () => {
    const code = `module Billing
  class Usage
    def self.claim(user)
      Billing::Ledger.claim(user)
      ::Wallet.claim(user)
      self.remaining(user)
      remaining(user)
      user.claim
    end
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 10 }],
      'ruby'
    );
    tree.delete();

    const r = results[0]!;
    expect(r.defined_symbols.find((d) => d.name === 'claim')?.owner).toBe('Billing::Usage');
    expect(r.defined_symbols.find((d) => d.name === 'Usage')?.owner).toBeUndefined();
    const on = (name: string) =>
      r.use_sites!.filter((u) => u.name === name).map((u) => [u.on ?? null, u.in ?? null]);
    // A relative name keeps the namespace it is resolved from; `::` and self are full paths.
    // `user.claim`: called on something that is not a class, so no class.
    expect(on('claim')).toEqual([
      ['Billing::Ledger', 'Billing::Usage'],
      ['::Wallet', null],
      [null, null],
    ]);
    expect(on('remaining')).toEqual([['::Billing::Usage', null]]);
    // A constant is not tied to the class it is mentioned in.
    expect(on('Wallet')).toEqual([[null, null]]);
  });

  it('treats a call on a new object as a call on its class', async () => {
    const ruby = `module Reports
  class Rebuild
    def self.all
      new(ids).call
    end
    def run
      Reports::Rebuild.new(ids).call
      Other.new(ids).call
    end
  end
end`;
    let { tree, language } = parse('ruby', ruby);
    let results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 10 }], 'ruby');
    tree.delete();
    const calls = results[0]!.use_sites!.filter((u) => u.name === 'call' && !u.through);
    expect(calls).toEqual(
      expect.arrayContaining([
        { name: 'call', from: 'run', on: 'Reports::Rebuild', in: 'Reports::Rebuild' },
        { name: 'call', from: 'run', on: 'Other', in: 'Reports::Rebuild' },
      ])
    );

    ({ tree, language } = parse('typescript', 'function go() { new Queue(1).flush(); }'));
    results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 0 }], 'typescript');
    tree.delete();
    expect(results[0]!.use_sites).toContainEqual({ name: 'flush', from: 'go', on: 'Queue' });
  });

  it('records a use also from the methods that reach it through the chunk’s own calls (Ruby)', async () => {
    const code = `class Refund
  def self.preview(**args)
    new(**args).preview
  end
  def preview
    log = receipt
    log && summary
  end
  def call
    return unless receipt
    Notifier.deliver
  end
  def summary(receipt = nil)
    receipt
  end
  private
  def receipt
    Receipt.find_by(id: 1).signature_valid?(token)
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 19 }],
      'ruby'
    );
    tree.delete();

    const from = (name: string, through?: boolean) =>
      results[0]!
        .use_sites!.filter((u) => u.name === name && !!u.through === !!through)
        .map((u) => u.from)
        .sort();
    // `receipt` is called bare, without arguments: `preview` and `call` reach the
    // call through it, `self.preview` through `preview`. `summary` only has a parameter
    // of that name.
    expect(from('signature_valid?')).toEqual(['receipt']);
    expect(from('signature_valid?', true)).toEqual(['call', 'preview']);
    expect(from('deliver', true)).toEqual([]);
    // Own methods stay out of the uses: they link to nothing outside the chunk.
    expect(results[0]!.uses_symbols).not.toContain('receipt');
  });

  it('marks a Ruby class used as a value, not one called on or included', async () => {
    const code = `class Dispatcher
  include Retryable
  def workers
    { url => ImportWorker, other => [Billing::SyncWorker] }
  end
  def run
    dispatch(queue, Fallback)
    keep = Holder.new(1)
    Invoice.overdue
    Rebuild.new(ids).call
    raise Failed unless keep.is_a?(Holder)
  end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 12 }],
      'ruby'
    );
    tree.delete();

    const values = results[0]!
      .use_sites!.filter((u) => u.value)
      .map((u) => u.name)
      .sort();
    expect(values).toEqual(['Fallback', 'Holder', 'ImportWorker', 'SyncWorker']);
  });

  it('records the class for this-calls and Class.method calls, not for bare calls (TypeScript)', async () => {
    const code = `export class Queue {
  flush(): void {
    this.drain();
    Store.save();
    drain();
  }
}`;
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 6 }],
      'typescript'
    );
    tree.delete();

    const r = results[0]!;
    expect(r.defined_symbols.find((d) => d.name === 'flush')?.owner).toBe('Queue');
    const sites = r.use_sites!.filter((u) => u.name === 'drain' || u.name === 'save');
    expect(sites).toEqual(
      expect.arrayContaining([
        { name: 'drain', from: 'flush', on: '::Queue' },
        { name: 'drain', from: 'flush' },
        { name: 'save', from: 'flush', on: 'Store', in: 'Queue' },
      ])
    );
  });

  it('does not count a Ruby module that only wraps classes as a definition', async () => {
    const code = `module Billing
  module Reports
    class Monthly
      def self.build; end
    end
  end
end
module Pricing
  def self.round(x); end
end`;
    const { tree, language } = parse('ruby', code);
    const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 9 }], 'ruby');
    tree.delete();

    const defs = results[0]!.defines_symbols;
    expect(defs).toEqual(expect.arrayContaining(['Monthly', 'build', 'Pricing', 'round']));
    expect(defs).not.toContain('Billing');
    expect(defs).not.toContain('Reports');
  });

  it('records JSX components as uses in tsx and javascript, not HTML tags', async () => {
    const code = `export const Page = () => (
  <div>
    <PriceBadge id={1} />
    <Ui.Button>go</Ui.Button>
  </div>
);`;
    for (const lang of ['tsx', 'javascript']) {
      const { tree, language } = parse(lang, code);
      const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 5 }], lang);
      tree.delete();

      const uses = results[0]!.uses_symbols;
      expect(uses).toEqual(expect.arrayContaining(['PriceBadge', 'Button']));
      expect(uses).not.toContain('div');
    }
  });

  it('records re-exported names as uses made from the name they are exported as', async () => {
    const code = `export { toName, fromName as parseName } from './names.js';
export type { NameConfig } from './names.js';
export function helper() { toName(); }`;
    for (const lang of ['typescript', 'javascript']) {
      const { tree, language } = parse(lang, code);
      const results = extractSymbolsForChunks(tree, language, [{ startLine: 0, endLine: 2 }], lang);
      tree.delete();

      const sites = results[0]!.use_sites!;
      expect(sites).toEqual(
        expect.arrayContaining([
          { name: 'toName', from: 'toName', reexport: true },
          { name: 'fromName', from: 'parseName', reexport: true },
          { name: 'toName', from: 'helper' },
        ])
      );
      // The javascript grammar does not parse `export type`; TypeScript records it.
      if (lang === 'typescript') {
        expect(sites).toContainEqual({
          name: 'NameConfig',
          from: 'NameConfig',
          reexport: true,
        });
      }
    }
  });

  it('extracts JavaScript definitions (its grammar has no type nodes)', async () => {
    const code = 'class Cart {\n  add(x) { save(x); }\n}\nfunction save(x) {}';
    const { tree, language } = parse('javascript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 3 }],
      'javascript'
    );
    tree.delete();
    expect(results[0]!.defines_symbols).toEqual(expect.arrayContaining(['Cart', 'add', 'save']));
  });

  it('keeps TypeScript usages working (the JSX patterns are not in its query)', async () => {
    const code = 'const a = foo();';
    const { tree, language } = parse('typescript', code);
    const results = extractSymbolsForChunks(
      tree,
      language,
      [{ startLine: 0, endLine: 0 }],
      'typescript'
    );
    tree.delete();
    expect(results[0]!.uses_symbols).toContain('foo');
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
