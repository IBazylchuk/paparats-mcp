import { describe, it, expect, afterAll } from 'vitest';
import Parser from 'web-tree-sitter';
import { createRequire } from 'module';
import { LANGUAGE_QUERIES } from '../src/ast-queries.js';

const require = createRequire(import.meta.url);

const GRAMMAR_MAP: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  tsx: 'tsx',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  ruby: 'ruby',
  c: 'c',
  cpp: 'cpp',
  csharp: 'c_sharp',
};

let parser: Parser;
const languages = new Map<string, Parser.Language>();

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

function queryCaptures(lang: string, code: string, queryStr: string): string[] {
  const language = languages.get(lang)!;
  parser.setLanguage(language);
  const tree = parser.parse(code);
  const query = language.query(queryStr);
  const captures = query.captures(tree.rootNode);
  const texts = captures.map((c) => c.node.text);
  query.delete();
  tree.delete();
  return texts;
}

describe('LANGUAGE_QUERIES', () => {
  it('covers all 10 supported languages', async () => {
    await setup();
    const supported = Object.keys(GRAMMAR_MAP);
    for (const lang of supported) {
      expect(LANGUAGE_QUERIES[lang]).toBeDefined();
    }
  });

  it('TypeScript: extracts definitions', () => {
    const defs = queryCaptures(
      'typescript',
      'function greet() {}\nclass MyClass {}\ninterface Foo {}\ntype Bar = string;\nenum Dir { Up }',
      LANGUAGE_QUERIES['typescript']!.definitions
    );
    expect(defs).toContain('greet');
    expect(defs).toContain('MyClass');
    expect(defs).toContain('Foo');
    expect(defs).toContain('Bar');
    expect(defs).toContain('Dir');
  });

  it('TypeScript: extracts usages', () => {
    const uses = queryCaptures(
      'typescript',
      'greet();\nnew MyClass();\nconsole.log("hi");',
      LANGUAGE_QUERIES['typescript']!.usages
    );
    expect(uses).toContain('greet');
    expect(uses).toContain('MyClass');
    expect(uses).toContain('log');
  });

  it('Python: extracts definitions', () => {
    const defs = queryCaptures(
      'python',
      'def greet():\n    pass\nclass MyClass:\n    pass\nx = 10',
      LANGUAGE_QUERIES['python']!.definitions
    );
    expect(defs).toContain('greet');
    expect(defs).toContain('MyClass');
    expect(defs).toContain('x');
  });

  it('Go: extracts definitions and usages', () => {
    const defs = queryCaptures(
      'go',
      'package main\nfunc greet() {}\ntype MyStruct struct {}',
      LANGUAGE_QUERIES['go']!.definitions
    );
    expect(defs).toContain('greet');
    expect(defs).toContain('MyStruct');

    const uses = queryCaptures(
      'go',
      'package main\nfunc main() { greet() }',
      LANGUAGE_QUERIES['go']!.usages
    );
    expect(uses).toContain('greet');
  });

  it('Rust: extracts definitions', () => {
    const defs = queryCaptures(
      'rust',
      'fn greet() {}\nstruct Point {}\nenum Color { Red }\ntrait Greetable {}\ntype Alias = String;\nconst MAX: u32 = 100;',
      LANGUAGE_QUERIES['rust']!.definitions
    );
    expect(defs).toContain('greet');
    expect(defs).toContain('Point');
    expect(defs).toContain('Color');
    expect(defs).toContain('Greetable');
    expect(defs).toContain('Alias');
    expect(defs).toContain('MAX');
  });

  it('Java: extracts definitions and usages', () => {
    const defs = queryCaptures(
      'java',
      'class MyClass { void method() {} }\ninterface Foo {}',
      LANGUAGE_QUERIES['java']!.definitions
    );
    expect(defs).toContain('MyClass');
    expect(defs).toContain('method');
    expect(defs).toContain('Foo');
  });

  it('Ruby: extracts definitions and usages', () => {
    const defs = queryCaptures(
      'ruby',
      'class MyClass\n  def method\n  end\nend\nmodule MyModule\nend',
      LANGUAGE_QUERIES['ruby']!.definitions
    );
    expect(defs).toContain('MyClass');
    expect(defs).toContain('method');
    expect(defs).toContain('MyModule');
  });

  it('C: extracts definitions', () => {
    const defs = queryCaptures(
      'c',
      'struct Point { int x; };\nenum Color { RED };\nvoid greet() {}',
      LANGUAGE_QUERIES['c']!.definitions
    );
    expect(defs).toContain('Point');
    expect(defs).toContain('Color');
    expect(defs).toContain('greet');
  });

  it('C++: extracts definitions', () => {
    const defs = queryCaptures(
      'cpp',
      'class MyClass {};\nstruct Point {};\nenum Color { Red };\nvoid greet() {}',
      LANGUAGE_QUERIES['cpp']!.definitions
    );
    expect(defs).toContain('MyClass');
    expect(defs).toContain('Point');
    expect(defs).toContain('Color');
    expect(defs).toContain('greet');
  });

  it('C#: extracts definitions', () => {
    const defs = queryCaptures(
      'csharp',
      'class MyClass { void Method() {} }\ninterface IFoo {}\nstruct Point {}',
      LANGUAGE_QUERIES['csharp']!.definitions
    );
    expect(defs).toContain('MyClass');
    expect(defs).toContain('Method');
    expect(defs).toContain('IFoo');
    expect(defs).toContain('Point');
  });

  it('TSX: works with JSX content', () => {
    const defs = queryCaptures(
      'tsx',
      'function App() { return <div />; }',
      LANGUAGE_QUERIES['tsx']!.definitions
    );
    expect(defs).toContain('App');
  });
});
