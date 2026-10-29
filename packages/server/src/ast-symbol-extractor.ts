import { Parser, Query } from 'web-tree-sitter';
import type { Node, Tree, Language } from 'web-tree-sitter';
import { LANGUAGE_QUERIES } from './ast-queries.js';
import {
  CONSTANT_PATH,
  RubyReceiverTypes,
  TsReceiverTypes,
  constantPath,
  enclosingClass,
  type ReceiverClass,
} from './receiver-types.js';
import type { LocalModules } from './local-modules.js';
import type { ChunkKind } from './types.js';

export interface DefinedSymbol {
  name: string;
  kind: ChunkKind;
  /**
   * The class or module a method is declared in, with its namespaces:
   * `Orchard::Grove` for a method of `class Grove` inside `module Orchard`.
   */
  owner?: string;
  /**
   * A top-level declaration a TypeScript or JavaScript module does not
   * export: nothing outside its file can call it, so only uses in that file
   * link to it.
   */
  local?: true;
  /**
   * A Ruby class method (`def self.batch`), with no instance method of that
   * name in the chunk: callable on the class, not on an object.
   */
  classMethod?: true;
  /**
   * A class, module or interface: what it inherits from or mixes in, as
   * written (`class A < Base`, `include Billable`, `extends Base`,
   * `implements Store`). Each is resolved like a constant written inside it.
   */
  parents?: ClassParent[];
}

/** A superclass, mixin or interface as written; `module` is the import it comes from (TypeScript, JavaScript). */
export interface ClassParent {
  name: string;
  module?: string;
}

/** One use of a name, with where it is made from and what it is called on. */
export interface UseSite {
  name: string;
  /**
   * The function or method the use sits in, also when that method started in
   * an earlier chunk. Empty for code in a class body or at the top of a file.
   */
  from: string;
  /**
   * The class it is called on, as written: `Grove` for `Grove.water`,
   * `Orchard::Grove` for `Orchard::Grove.water`. A leading `::` marks a full
   * path: `::Orchard::Grove` as written, or the enclosing class for
   * `self.water` / `this.water` (and a bare `water` in Ruby).
   */
  on?: string;
  /** For an `on` without `::`, the namespace the call is made in, to resolve it from. */
  in?: string;
  /**
   * A bare Ruby constant (`Base`, not `Orbit::Base`): it means the class of
   * that name in the nearest namespace around it (`in`, then its parents),
   * else the top-level one, as Ruby looks it up.
   */
  lexical?: true;
  /** A Ruby constant (class or module name): linked only where the lookup finds it. */
  constant?: true;
  /**
   * Ruby: called on an object rather than on a class or self (`input.batch`,
   * `pages.size`, `@queue.add`), so not a call to a class method.
   */
  onObject?: true;
  /** A re-export (`export { x } from`), not a call: linked as `reexports`. */
  reexport?: true;
  /**
   * A Ruby class used as a value rather than called on: passed, stored in a
   * hash or variable, `Foo.new` kept for later. Linked as `references`.
   */
  value?: true;
  /**
   * TypeScript and JavaScript: the module the name is imported from, or the
   * class or module it is called on (`./store.js`), as the import writes it.
   */
  module?: string;
  /**
   * Called on a value of a class outside the project: a literal, a builtin
   * (`JSON.parse`, a `Map`'s `get`), a Node module (`fs.readFileSync`). It
   * links to nothing.
   */
  external?: true;
  /**
   * `from` does not make the call itself but reaches it through the chunk's
   * own calls. Written by format 4–6 extractions (copies of a use per method
   * reaching it); format 7 records `inner_calls` instead. Read so a graph
   * built from older stored symbols still follows them.
   */
  through?: true;
}

export interface SymbolExtractionResult {
  defines_symbols: string[];
  uses_symbols: string[];
  defined_symbols: DefinedSymbol[];
  /** Absent where the language has no methods to attribute uses to (Terraform). */
  use_sites?: UseSite[];
  /**
   * Calls between the chunk's own methods: each method with the methods of the
   * chunk calling it (`ledger_entry` → `call`, `preview`). Bare and self calls only.
   * `change_impact` counts steps through them; omitted when there are none.
   */
  inner_calls?: Record<string, string[]>;
  /** TS/JS: the name its module exports by default, when the chunk holds that `export default`. */
  default_export?: string;
}

/**
 * Stored in each code point as `symbol_format`. Indexing compares it with the
 * stored value, like `embed_format`, so bumping it after a query change
 * rewrites unchanged files with their symbols extracted again (vectors come
 * from the embedding cache). Points without it were extracted as format 1.
 *
 *  2 — Ruby `def self.x` and `class A::B`, JSX component uses, namespace-only
 *      Ruby modules define nothing.
 *  3 — a name the chunk defines stays a use when called on another object;
 *      uses record the method they are made from and the class they are
 *      called on, and methods record their class.
 *  4 — TypeScript and JavaScript re-exports (`export { x } from`) are uses;
 *      a use is also made from the chunk's methods that reach it through
 *      the chunk's own calls; `X.new(...).m` and `new X().m()` are calls on X;
 *      a TS/JS definition not exported is file-local; Ruby `def self.x` is a
 *      class method, a call on an object is marked; a reopened library class
 *      (`Time`, `ActiveSupport::...`) defines nothing; a Ruby constant records
 *      its lexical scope and the namespace part of a path is not a use
 *      (the class a value constant is read from is); Ruby code in a `RUBY`
 *      heredoc is read for uses.
 *  5 — a call records the class of its receiver when the file says (`x =
 *      Foo.new`, `x: Foo`, a field, a value constant) or that it is a builtin
 *      or a package's (`external`); TypeScript and JavaScript uses record the
 *      import they come from (`module`), and names read as values are uses;
 *      classes record what they inherit and mix in (`parents`).
 *  6 — a Ruby call on `connection` (ActiveRecord's adapter) is `external`; a
 *      Ruby constant path through a class alias (`Saplings = A::Saplings`) is
 *      read through that class.
 *  7 — calls between a chunk's own methods are recorded (`inner_calls`), not
 *      copied onto every use as `through` sites, so steps can be counted per
 *      method; `export * from` is a `*` re-export of its module, and a TS/JS
 *      chunk records the name its module exports by default.
 *  8 — a Ruby `Foo.new` is a value only when passed or stored, not when a
 *      method returns it; a Ruby key without a value (`f(total:)`) calls
 *      the method of its name like a bare call.
 */
export const SYMBOL_FORMAT = 8;

/** Map tree-sitter parent node type → ChunkKind */
const NODE_TYPE_TO_KIND: Record<string, ChunkKind> = {
  // TypeScript / JavaScript
  function_declaration: 'function',
  class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  lexical_declaration: 'variable',
  variable_declarator: 'variable',
  method_definition: 'method',
  // Python
  function_definition: 'function',
  class_definition: 'class',
  assignment: 'variable',
  // Go
  // function_declaration: already mapped
  method_declaration: 'method',
  type_spec: 'type',
  // Rust
  function_item: 'function',
  struct_item: 'class',
  enum_item: 'enum',
  trait_item: 'interface',
  impl_item: 'class',
  type_item: 'type',
  const_item: 'constant',
  // Java
  // class_declaration: already mapped
  // interface_declaration: already mapped
  // method_declaration: already mapped (Go takes precedence, same value 'method')
  // Ruby
  class: 'class',
  module: 'module',
  method: 'method',
  singleton_method: 'method',
  // C/C++
  // function_definition: already mapped (Python takes precedence, same value 'function')
  struct_specifier: 'class',
  enum_specifier: 'enum',
  class_specifier: 'class',
  // C#
  struct_declaration: 'class',
};

/** Keywords and noise tokens to filter out of symbol lists */
const NOISE_KEYWORDS = new Set([
  'this',
  'self',
  'null',
  'nil',
  'None',
  'true',
  'false',
  'undefined',
  'void',
  'int',
  'float',
  'double',
  'bool',
  'boolean',
  'string',
  'String',
  'number',
  'char',
  'byte',
  'long',
  'short',
  'var',
  'let',
  'const',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'delete',
  'throw',
  'try',
  'catch',
  'finally',
  'class',
  'struct',
  'enum',
  'interface',
  'type',
  'import',
  'export',
  'from',
  'as',
  'async',
  'await',
  'yield',
  'static',
  'public',
  'private',
  'protected',
  'override',
  'abstract',
  'final',
  'virtual',
  'super',
  'extends',
  'implements',
  'package',
  'module',
  'require',
  'fn',
  'func',
  'def',
  'lambda',
  'println',
  'printf',
  'print',
  'fmt',
  'log',
  'console',
  'main',
  'init',
  'err',
  'error',
  'ok',
  'Ok',
  'Err',
  'Some',
  'Object',
  'Array',
  'Map',
  'Set',
  'List',
  'Dict',
  'Tuple',
]);

function isNoise(symbol: string): boolean {
  return symbol.length < 2 || NOISE_KEYWORDS.has(symbol);
}

const TERRAFORM_BLOCK_KIND: Record<string, ChunkKind> = {
  resource: 'resource',
  data: 'data',
  module: 'module',
  variable: 'variable',
  output: 'output',
  provider: 'provider',
};

// Block types whose definition name carries a scope prefix, matching how they
// are referenced (`var.region`, `module.network`). resource/data blocks are
// referenced bare as `<type>.<name>`, so they carry no prefix.
const TERRAFORM_DEF_PREFIX: Record<string, string> = {
  variable: 'var',
  module: 'module',
  output: 'output',
  provider: 'provider',
};

// Reference scope prefixes that address a resource/data block by `<type>.<name>`
// and so must be stripped for the usage to match the bare definition name.
const TERRAFORM_STRIP_PREFIXES = new Set(['data', 'resource']);

function firstIdentifier(node: Node): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === 'identifier') return c;
  }
  return null;
}

// Block labels are usually string literals (`resource "aws_instance" "web"`)
// but HCL also allows bare identifier labels (`resource aws_instance web`).
// The first identifier is the block type itself, so it's skipped.
function blockLabels(node: Node): string[] {
  const labels: string[] = [];
  let skippedBlockType = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === 'identifier') {
      if (!skippedBlockType) {
        skippedBlockType = true;
      } else {
        labels.push(c.text);
      }
    } else if (c.type === 'string_lit') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const t = c.namedChild(j);
        if (t && t.type === 'template_literal') labels.push(t.text);
      }
    }
  }
  return labels;
}

interface TerraformDef {
  name: string;
  kind: ChunkKind;
  row: number;
}

function collectTerraformDefs(root: Node): TerraformDef[] {
  const defs: TerraformDef[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'block') {
      const typeId = firstIdentifier(node);
      const blockType = typeId?.text ?? '';
      const kind = TERRAFORM_BLOCK_KIND[blockType];
      if (kind) {
        const labels = blockLabels(node);
        const bare = labels.length > 0 ? labels.join('.') : blockType;
        const prefix = TERRAFORM_DEF_PREFIX[blockType];
        const name = prefix ? `${prefix}.${bare}` : bare;
        if (bare) {
          defs.push({ name, kind, row: node.startPosition.row });
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c);
    }
  };
  walk(root);
  return defs;
}

interface TerraformUse {
  name: string;
  row: number;
}

function collectTerraformUses(root: Node): TerraformUse[] {
  const uses: TerraformUse[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'variable_expr') {
      const rootId = firstIdentifier(node);
      const prefix = rootId?.text ?? '';
      // The reference is variable_expr followed by consecutive get_attr siblings
      // forming the chain (`var.foo.bar`). Stop at the first non-get_attr sibling
      // so unrelated expressions under the same parent (e.g. `concat(var.x, local.y)`)
      // aren't collected.
      const attrs: string[] = [];
      let sibling = node.nextNamedSibling;
      while (sibling && sibling.type === 'get_attr') {
        const id = firstIdentifier(sibling);
        if (id) attrs.push(id.text);
        sibling = sibling.nextNamedSibling;
      }
      // `data.<type>.<name>` / `resource.<type>.<name>` address a bare
      // `<type>.<name>` definition — strip the scope prefix. Everything else
      // (`var.x`, `module.x`) or a bare `<type>.<name>` resource reference keeps
      // `<prefix>.<firstAttr>`.
      let name = '';
      if (TERRAFORM_STRIP_PREFIXES.has(prefix) && attrs.length >= 2) {
        name = `${attrs[0]}.${attrs[1]}`;
      } else if (prefix && attrs.length >= 1) {
        name = `${prefix}.${attrs[0]}`;
      }
      if (name) {
        uses.push({ name, row: node.startPosition.row });
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) walk(c);
    }
  };
  walk(root);
  return uses;
}

function extractTerraformSymbols(
  tree: Tree,
  chunks: Array<{ startLine: number; endLine: number }>
): SymbolExtractionResult[] {
  const defs = collectTerraformDefs(tree.rootNode);
  const uses = collectTerraformUses(tree.rootNode);
  return chunks.map((chunk) => {
    const defines = new Map<string, ChunkKind>();
    for (const d of defs) {
      if (d.row >= chunk.startLine && d.row <= chunk.endLine && !defines.has(d.name)) {
        defines.set(d.name, d.kind);
      }
    }
    const usesSet = new Set<string>();
    for (const u of uses) {
      if (u.row >= chunk.startLine && u.row <= chunk.endLine) usesSet.add(u.name);
    }
    for (const name of defines.keys()) usesSet.delete(name);
    const defined_symbols: DefinedSymbol[] = Array.from(defines.entries()).map(([name, kind]) => ({
      name,
      kind,
    }));
    return {
      defines_symbols: defined_symbols.map((d) => d.name),
      uses_symbols: Array.from(usesSet),
      defined_symbols,
    };
  });
}

/**
 * Resolve ChunkKind from a tree-sitter capture node by walking up to find a known parent type.
 */
function resolveKind(node: Node): ChunkKind {
  let current: Node | null = node.parent;
  // Walk up at most 3 levels to find a recognized node type
  for (let depth = 0; current && depth < 3; depth++) {
    const kind = NODE_TYPE_TO_KIND[current.type];
    if (kind) return kind;
    current = current.parent;
  }
  return 'unknown';
}

/**
 * Tree-sitter node types that introduce a "function-like scope" — anything
 * declared inside one of these (apart from the declaration the node itself
 * names) is local and must not appear in defines_symbols. Local symbols
 * aren't addressable from other chunks and leaking them poisons cross-chunk
 * reference analysis.
 *
 * Class / module / interface / namespace / impl / struct bodies are
 * intentionally NOT in any of these sets: methods declared inside them are
 * top-level in our model and stay in the graph.
 *
 * Per-language because different grammars reuse the same node names for
 * unrelated concepts. Python's `block` is the body of any compound
 * statement (class OR function); Ruby's `block` is a brace-syntax call
 * argument. Mixing the two breaks methods on Python classes.
 */
const FUNCTION_LIKE_SCOPE_NODES_PER_LANG: Record<string, Set<string>> = {
  typescript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  tsx: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  javascript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function',
    'generator_function_declaration',
    'method_definition',
  ]),
  python: new Set(['function_definition', 'lambda']),
  go: new Set(['function_declaration', 'func_literal', 'method_declaration']),
  rust: new Set(['function_item', 'closure_expression']),
  ruby: new Set(['method', 'singleton_method', 'do_block', 'block']),
  java: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
  c: new Set(['function_definition']),
  cpp: new Set(['function_definition', 'lambda_expression']),
  csharp: new Set([
    'method_declaration',
    'constructor_declaration',
    'local_function_statement',
    'lambda_expression',
    'anonymous_method_expression',
  ]),
};

/**
 * Returns true iff the captured identifier represents a module-level or
 * class-member declaration (and so may legitimately participate in the
 * cross-chunk symbol graph). Returns false for symbols introduced inside a
 * function body, lambda, or block — those are local-scope and not visible
 * to other chunks.
 *
 * Algorithm:
 *   1. Walk up from the identifier. The first function-like-scope ancestor
 *      we encounter is the symbol's OWN home (e.g. the `function_definition`
 *      that the identifier names). Skip past it.
 *   2. Continue walking. If we encounter a SECOND function-like-scope
 *      ancestor before reaching the file root, this declaration lives
 *      inside another function — i.e. it's a local. Return false.
 *   3. Otherwise return true.
 *
 * Edge case: variable declarations (e.g. TS `lexical_declaration`,
 * Python `assignment`) are not themselves function-like scopes, so step 1
 * doesn't consume anything for them — the very first function-like
 * ancestor already disqualifies them.
 */
function isTopLevelDeclaration(identifierNode: Node, scopeNodes: Set<string>): boolean {
  let ancestor: Node | null = identifierNode.parent;
  let seenSelfScope = false;
  // For declarations whose own type is a function-like scope (functions,
  // methods, lambdas, …) we need to consume that one before we start
  // counting enclosing scopes. Detect this by looking up the identifier's
  // ancestor chain for a NODE_TYPE_TO_KIND match — if that match is
  // function-like, the first function-like-scope hit is the symbol's home.
  let decl: Node | null = identifierNode.parent;
  for (let depth = 0; decl && depth < 4; depth++) {
    if (NODE_TYPE_TO_KIND[decl.type]) break;
    decl = decl.parent;
  }
  const declIsFunctionLike = decl !== null && scopeNodes.has(decl.type);

  while (ancestor) {
    if (scopeNodes.has(ancestor.type)) {
      if (declIsFunctionLike && !seenSelfScope) {
        seenSelfScope = true;
      } else {
        return false;
      }
    }
    ancestor = ancestor.parent;
  }
  return true;
}

/** The field naming a call's receiver, per grammar: `obj` in `obj.name`. */
const RECEIVER_FIELDS = ['receiver', 'object', 'operand', 'value', 'argument', 'expression'];

/** What a used name is called on: nothing (`charge`), the current object, or something else. */
type Receiver = { kind: 'none' } | { kind: 'self' } | { kind: 'other'; text: string; node: Node };

function receiverOf(nameNode: Node): Receiver {
  const parent = nameNode.parent;
  if (!parent) return { kind: 'none' };
  for (const field of RECEIVER_FIELDS) {
    const receiver = parent.childForFieldName(field);
    if (!receiver || receiver.id === nameNode.id) continue;
    const made = constructed(receiver);
    if (made) return made;
    const self =
      receiver.type === 'self' ||
      receiver.type === 'this' ||
      (receiver.type === 'identifier' && receiver.text === 'self');
    return self ? { kind: 'self' } : { kind: 'other', text: receiver.text, node: receiver };
  }
  return { kind: 'none' };
}

/**
 * A receiver that makes a new object: `Rebuild.new(ids)` in Ruby or `new
 * Rebuild(ids)`, so `Rebuild.new(ids).call` is a call on a `Rebuild`. A bare
 * `new(ids)` inside a Ruby class makes one of that class. The usual way to run a
 * Ruby service object, and its method name (`call`) is too common to link by
 * name alone.
 */
function constructed(receiver: Node): Receiver | undefined {
  let node = receiver;
  while (node.type === 'parenthesized_expression' && node.namedChildCount === 1) {
    node = node.namedChild(0)!;
  }
  if (node.type === 'new_expression') {
    const ctor = node.childForFieldName('constructor');
    return ctor ? { kind: 'other', text: ctor.text, node } : undefined;
  }
  if (node.type === 'call' && node.childForFieldName('method')?.text === 'new') {
    const cls = node.childForFieldName('receiver');
    return cls ? { kind: 'other', text: cls.text, node: cls } : { kind: 'self' };
  }
  return undefined;
}

const RUBY_MIXIN_CALLS = new Set(['include', 'extend', 'prepend']);

/**
 * What a class, module or interface inherits from or mixes in: Ruby's
 * superclass and `include` / `extend` / `prepend` in its body, TypeScript's
 * `extends` and `implements`. Empty when it has none.
 */
function classParents(nameNode: Node, ts: TsReceiverTypes | null): ClassParent[] {
  const decl = declarationOf(nameNode);
  if (!decl) return [];
  const parents: ClassParent[] = [];
  const add = (node: Node | null | undefined) => {
    if (!node) return;
    const named = node.type === 'generic_type' ? node.childForFieldName('name') : node;
    if (!named || !CONSTANT_PATH.test(named.text)) return;
    const name = constantPath(named.text);
    const spec = ts?.importOf(named, name.split('::')[0])?.spec;
    parents.push(spec !== undefined ? { name, module: spec } : { name });
  };
  if (decl.type === 'class' || decl.type === 'module') {
    add(decl.childForFieldName('superclass')?.namedChild(0));
    for (const stmt of decl.childForFieldName('body')?.namedChildren ?? []) {
      if (stmt?.type !== 'call' || stmt.childForFieldName('receiver')) continue;
      if (!RUBY_MIXIN_CALLS.has(stmt.childForFieldName('method')?.text ?? '')) continue;
      for (const arg of stmt.childForFieldName('arguments')?.namedChildren ?? []) add(arg);
    }
    return parents;
  }
  for (const part of decl.namedChildren) {
    if (part?.type !== 'class_heritage' && part?.type !== 'extends_type_clause') continue;
    const clauses = part.type === 'class_heritage' ? part.namedChildren : [part];
    for (const clause of clauses) {
      if (!clause) continue;
      if (clause.type === 'extends_clause') add(clause.childForFieldName('value'));
      else for (const type of clause.namedChildren) add(type);
    }
  }
  return parents;
}

/** Kinds whose body holds methods rather than being one. */
const CONTAINER_KINDS = new Set<ChunkKind>(['class', 'module', 'interface', 'enum']);

/** The declaration node a definition capture names, as `resolveKind` finds it. */
function declarationOf(captureNode: Node): Node | null {
  let current: Node | null = captureNode.parent;
  for (let depth = 0; current && depth < 3; depth++) {
    if (NODE_TYPE_TO_KIND[current.type]) return current;
    current = current.parent;
  }
  return null;
}

/**
 * The function or method a use sits in: the nearest enclosing declaration
 * among `callers` (declaration node id → name). Empty when the nearest one is
 * a class or module body, or there is none.
 */
function callerOf(node: Node, callers: Map<number, string | null>): string {
  for (let current = node.parent; current; current = current.parent) {
    const name = callers.get(current.id);
    if (name !== undefined) return name ?? '';
  }
  return '';
}

/** Heredoc tags whose body is Ruby code: `RUBY`, `RUBY_SOURCE`, `SEED_RUBY`, `RB`. */
const RUBY_HEREDOC_TAG = /(^|_)(RUBY|RB)(_|$)/;

/**
 * Uses in Ruby code kept as a heredoc string (`SCRIPT = <<~'RUBY_SOURCE'`, run
 * later by a data migration or a script runner): grep sees the calls there, the
 * parser saw text. The body is parsed as Ruby and its uses join the chunks
 * holding those lines, made from the method around the heredoc. Names the
 * heredoc itself defines stay inside it.
 */
function addRubyHeredocUses(
  tree: Tree,
  language: Language,
  chunks: Array<{ startLine: number; endLine: number }>,
  results: SymbolExtractionResult[],
  callers: Map<number, string | null>
): void {
  const bodies = tree.rootNode
    .descendantsOfType('heredoc_body')
    .filter((b): b is Node => b !== null && RUBY_HEREDOC_TAG.test(b.lastChild?.text.trim() ?? ''));
  if (bodies.length === 0) return;
  const source = tree.rootNode.text;
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    for (const body of bodies) {
      const end = body.lastChild;
      const first = body.firstChild;
      if (!end || !first || end.type !== 'heredoc_end' || first.id === end.id) continue;
      // The body's text with each interpolation blanked, rows kept, so a row in
      // it plus `row0` is a row of the file.
      let text = source.slice(first.startIndex, end.startIndex);
      for (const part of body.namedChildren) {
        if (part?.type !== 'interpolation') continue;
        const from = part.startIndex - first.startIndex;
        const to = part.endIndex - first.startIndex;
        text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to);
      }
      const row0 = first.startPosition.row;
      text = ' '.repeat(first.startPosition.column) + text;
      const sub = parser.parse(text);
      if (!sub) continue;
      try {
        const lastRow = end.startPosition.row - 1;
        const inside = chunks
          .map((c, i) => ({
            i,
            startLine: Math.max(c.startLine, row0),
            endLine: Math.min(c.endLine, lastRow),
          }))
          .filter((c) => c.startLine <= c.endLine);
        if (inside.length === 0) continue;
        const shifted = inside.map((c) => ({
          startLine: c.startLine - row0,
          endLine: c.endLine - row0,
        }));
        const whole = extractSymbolsForChunks(
          sub,
          language,
          [{ startLine: 0, endLine: lastRow - row0 }],
          'ruby',
          true
        )[0];
        const ownNames = new Set(whole?.defines_symbols ?? []);
        const from = callerOf(body, callers);
        const found = extractSymbolsForChunks(sub, language, shifted, 'ruby', true);
        inside.forEach(({ i }, k) => {
          const target = results[i];
          const extra = found[k];
          if (!target || !extra) return;
          const uses = new Set(target.uses_symbols);
          const sites = new Map((target.use_sites ?? []).map((site) => [siteKey(site), site]));
          for (const site of extra.use_sites ?? []) {
            if (ownNames.has(site.name)) continue;
            const moved: UseSite = { ...site, from };
            delete moved.through;
            uses.add(site.name);
            const key = siteKey(moved);
            if (!sites.has(key)) sites.set(key, moved);
          }
          target.uses_symbols = [...uses];
          target.use_sites = [...sites.values()];
        });
      } finally {
        sub.delete();
      }
    }
  } finally {
    parser.delete();
  }
}

/**
 * The name a re-export makes public: `parseName` for `export { fromName as
 * parseName } from './names.js'`. The use is made from that name rather than
 * from the whole chunk, so `change_impact` stops at a barrel file instead of
 * passing the change on to callers of whatever else the chunk defines. Its
 * edge is a `reexports` one, which the module map leaves out: a barrel
 * re-exporting every module would otherwise pull them all together.
 */
function exportedAs(node: Node): string | undefined {
  const parent = node.parent;
  if (parent?.type !== 'export_specifier') return undefined;
  return (parent.childForFieldName('alias') ?? node).text;
}

/**
 * Where a use points, as far as the code says: the class for `Grove.water`
 * (with the namespace the call is in, to resolve a relative name), the
 * enclosing class for `self.water` and `this.water`, and in Ruby for a bare
 * `water` too (a bare call there is a call on self). Lowercase names only for
 * the implicit cases, so a constant like `Invoice` is not tied to the class
 * it is mentioned in.
 */
function calledOn(
  node: Node,
  receiver: Receiver,
  lang: string
): Pick<UseSite, 'on' | 'in'> | undefined {
  if (receiver.kind === 'other') {
    if (!CONSTANT_PATH.test(receiver.text)) return undefined;
    const path = constantPath(receiver.text);
    if (path.startsWith('::')) return { on: path };
    const scope = enclosingClass(node);
    return scope ? { on: path, in: scope } : { on: path };
  }
  if (receiver.kind === 'none' && lang !== 'ruby') return undefined;
  if (!/^[a-z_]/.test(node.text)) return undefined;
  const own = enclosingClass(node);
  return own ? { on: `::${own}` } : undefined;
}

/**
 * The namespace a Ruby class or module is declared in, with the path written
 * in its name: `Billing` for `class Invoice` inside `module Billing`, and for
 * `class Billing::Invoice`. Undefined at the top level.
 */
function rubyNamespaceOf(nameNode: Node): string | undefined {
  const path = nameNode.parent?.type === 'scope_resolution' ? nameNode.parent : null;
  const declaration = (path ?? nameNode).parent;
  const outer = declaration ? enclosingClass(declaration) : undefined;
  const written = path?.childForFieldName('scope')?.text;
  if (written !== undefined && written.startsWith('::'))
    return constantPath(written).slice(2) || undefined;
  if (path && !path.childForFieldName('scope')) return undefined; // `class ::Invoice`
  const parts = [outer, written].filter((p): p is string => p !== undefined && p !== '');
  return parts.length > 0 ? parts.join('::') : undefined;
}

/** A Ruby constant holding a value (`MAX_DEPTH`, `MAX_RETRIES`), not a class. */
const RUBY_VALUE_CONSTANT_RE = /^[A-Z][A-Z0-9_]+$/;

/**
 * How a Ruby constant use is resolved: `Orbit::Base` as `Base` in `Orbit`
 * (from the namespace around it), a bare `Base` lexically. Null for the
 * namespace part of a path (`Orbit` in `Orbit::Base`): naming a namespace
 * uses nothing of the file that defines it, and counting it linked every
 * `Seedbed::X` to whichever file gives `module Seedbed` a method. A class
 * a value constant is read from (`Lexer` in `Lexer::MAX_DEPTH`) is used,
 * and resolved like a bare constant: Ruby constants holding values are not
 * definitions in the graph, so the class is what links. A path through a
 * constant the file sets to a class (`Saplings = ::Vendors::Acme::Saplings`)
 * is read through that class.
 */
function rubyConstant(
  node: Node,
  types: RubyReceiverTypes
): Pick<UseSite, 'on' | 'in' | 'lexical' | 'constant'> | null {
  const parent = node.parent;
  const scope = enclosingClass(node);
  if (parent?.type === 'scope_resolution') {
    const name = parent.childForFieldName('name');
    if (name?.id !== node.id) {
      // `Vendor::Sdk::Types`: an upper-case namespace, not a value.
      const isScope =
        parent.parent?.type === 'scope_resolution' &&
        parent.parent.childForFieldName('scope')?.id === parent.id;
      if (!name || isScope || !RUBY_VALUE_CONSTANT_RE.test(name.text)) return null;
      return scope
        ? { lexical: true, in: scope, constant: true }
        : { lexical: true, constant: true };
    }
    const written = parent.childForFieldName('scope');
    if (!written) return { lexical: true, constant: true }; // `::Base`: the top-level one
    const on = constantPath(written.text);
    // `Saplings::Shears` after `Saplings = ::Vendors::Acme::Saplings`: the alias's class.
    const [head, ...rest] = on.split('::');
    const alias = head ? types.constantClass(head) : undefined;
    if (alias?.classValue) {
      const path = [alias.on, ...rest].join('::');
      return path.startsWith('::') || !alias.in
        ? { on: path, constant: true }
        : { on: path, in: alias.in, constant: true };
    }
    return on.startsWith('::') || !scope
      ? { on, constant: true }
      : { on, in: scope, constant: true };
  }
  return scope ? { lexical: true, in: scope, constant: true } : { lexical: true, constant: true };
}

/**
 * A Ruby `module` that only wraps classes and modules (`module Billing; class
 * Invoice; ...`). Every file under a namespace reopens it, so counting each
 * one as a definition of `Billing` linked every `Billing::X` in the codebase
 * to all of those files.
 */
function isRubyNamespaceModule(nameNode: Node): boolean {
  const owner =
    nameNode.parent?.type === 'scope_resolution' ? nameNode.parent.parent : nameNode.parent;
  if (owner?.type !== 'module') return false;
  const body = owner.childForFieldName('body');
  if (!body) return false;
  return body.namedChildren.every(
    (c) => c !== null && (c.type === 'class' || c.type === 'module' || c.type === 'comment')
  );
}

/** Calls whose arguments name a class without holding an object of it. */
const RUBY_NON_VALUE_CALLS = new Set([
  'include',
  'extend',
  'prepend',
  'raise',
  'fail',
  'rescue_from',
  'is_a?',
  'kind_of?',
  'instance_of?',
]);

/**
 * A Ruby constant used as a value: passed (`dispatch(queue, Worker)`), stored
 * in a hash, array or variable, or `Worker.new` passed or stored in a hash or
 * array (one stored in a variable is typed: its calls link one by one). The code
 * holding it may call any of its methods, which the graph cannot see, so
 * `change_impact` follows such a link whatever method of the class changed.
 * Not a namespace (`Billing` in `Billing::Invoice`), not a class called on at
 * once (`Invoice.overdue`, `Rebuild.new(ids).call`), not `include`, `raise` or
 * a superclass.
 */
function isRubyValue(node: Node): boolean {
  if (node.type !== 'constant') return false;
  let expr = node;
  while (expr.parent?.type === 'scope_resolution') {
    if (expr.parent.childForFieldName('name')?.id !== expr.id) return false;
    expr = expr.parent;
  }
  const parent = expr.parent;
  if (!parent) return false;
  if (parent.type === 'call' && parent.childForFieldName('receiver')?.id === expr.id) {
    if (parent.childForFieldName('method')?.text !== 'new') return false;
    const outer = parent.parent;
    // `@store = Store.new(...)`: the variable's calls are typed one by one (`receiver-types.ts`).
    if (
      (outer?.type === 'assignment' || outer?.type === 'operator_assignment') &&
      outer.childForFieldName('right')?.id === parent.id &&
      /^(?:identifier|instance_variable)$/.test(outer.childForFieldName('left')?.type ?? '')
    ) {
      return false;
    }
    // Passed or stored only: a new object a method returns (a factory) is not
    // held by it, and its callers' calls on it link by themselves.
    if (outer?.type === 'argument_list' || outer?.type === 'array') return true;
    if (outer?.type === 'pair') return outer.childForFieldName('value')?.id === parent.id;
    return (
      (outer?.type === 'assignment' || outer?.type === 'operator_assignment') &&
      outer.childForFieldName('right')?.id === parent.id
    );
  }
  if (parent.type === 'argument_list') {
    const call = parent.parent;
    const method = call?.type === 'call' ? call.childForFieldName('method')?.text : undefined;
    return method !== undefined && !RUBY_NON_VALUE_CALLS.has(method);
  }
  if (parent.type === 'pair') return parent.childForFieldName('value')?.id === expr.id;
  if (parent.type === 'assignment' || parent.type === 'operator_assignment') {
    return parent.childForFieldName('right')?.id === expr.id;
  }
  return parent.type === 'array';
}

const ES_MODULE_LANGS = new Set(['typescript', 'tsx', 'javascript']);

/**
 * The names an ES module exports by name (`export { a, b as c }`, `export
 * default a`, `export = a`), or null when the file is not one: no `import` or
 * `export` statement (a script, whose top-level names are global), or a
 * CommonJS `module.exports` / `exports.x`. Declarations written under `export`
 * are told apart by `isExported`.
 */
function moduleExports(root: Node): Set<string> | null {
  let module = false;
  const names = new Set<string>();
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === 'import_statement') module = true;
    if (stmt.type !== 'export_statement') continue;
    module = true;
    if (stmt.childForFieldName('source')) continue;
    for (const child of stmt.namedChildren) {
      if (child?.type === 'identifier') names.add(child.text);
      // `export default memo(Card)`: `Card` is what the module exports.
      if (child?.type === 'call_expression') {
        const wrapped = wrappedName(child);
        if (wrapped) names.add(wrapped);
      }
      if (child?.type !== 'export_clause') continue;
      for (const spec of child.namedChildren) {
        const name = spec?.childForFieldName('name')?.text;
        if (name) names.add(name);
      }
    }
  }
  if (!module || /\b(?:module\.exports|exports\.[A-Za-z_$])/.test(root.text)) return null;
  return names;
}

/** Whether a top-level declaration is exported: written under `export`, or named in an export list. */
function isExported(nameNode: Node, exports: Set<string>): boolean {
  if (exports.has(nameNode.text)) return true;
  let statement: Node | null = nameNode;
  while (statement?.parent && statement.parent.type !== 'program') statement = statement.parent;
  return statement?.type === 'export_statement';
}

/**
 * Classes of Ruby, its standard library and Rails that a project reopens to
 * add a method (`class Time; def id`, `class ActiveSupport::TimeWithZone`).
 * Counting such a file as the definition of `Time` linked every `Time.current`
 * in the codebase to it and listed it as shared code. Its methods still count.
 */
const RUBY_LIBRARY_CLASSES = new Set([
  'Object',
  'BasicObject',
  'Kernel',
  'Module',
  'Class',
  'Comparable',
  'Enumerable',
  'String',
  'Symbol',
  'Integer',
  'Float',
  'Numeric',
  'Rational',
  'Complex',
  'BigDecimal',
  'Array',
  'Hash',
  'Range',
  'Regexp',
  'Set',
  'Struct',
  'Data',
  'Proc',
  'Method',
  'NilClass',
  'TrueClass',
  'FalseClass',
  'Time',
  'Date',
  'DateTime',
  'Exception',
  'StandardError',
  'IO',
  'File',
  'Dir',
  'Pathname',
  'URI',
  'JSON',
  'Thread',
  'Logger',
]);
const RUBY_LIBRARY_NAMESPACES = new Set([
  'ActiveSupport',
  'ActiveRecord',
  'ActiveModel',
  'ActiveJob',
  'ActiveStorage',
  'ActionController',
  'ActionDispatch',
  'ActionView',
  'ActionMailer',
  'ActionCable',
  'Rails',
  'Arel',
  'GlobalID',
]);

/** A `class` or `module` naming one of {@link RUBY_LIBRARY_CLASSES}, or a path under a Rails namespace. */
function isRubyLibraryClass(nameNode: Node): boolean {
  const path = nameNode.parent?.type === 'scope_resolution' ? nameNode.parent : nameNode;
  const owner = path.parent;
  if (owner?.type !== 'class' && owner?.type !== 'module') return false;
  if (owner.childForFieldName('name')?.id !== path.id) return false;
  const full = path.text.replace(/^::/, '');
  if (enclosingClass(owner) !== undefined) return false;
  const first = full.split('::')[0] ?? '';
  return full.includes('::') ? RUBY_LIBRARY_NAMESPACES.has(first) : RUBY_LIBRARY_CLASSES.has(full);
}

/** Ruby nodes whose identifiers name a parameter, not a call. */
const RUBY_PARAMETER_NODES = new Set([
  'method_parameters',
  'block_parameters',
  'lambda_parameters',
  'optional_parameter',
  'keyword_parameter',
  'splat_parameter',
  'hash_splat_parameter',
  'block_parameter',
]);

/** The methods a Ruby file defines, per class or module they are in (`''` at the top level). */
function rubyMethodsByClass(tree: Tree): Map<string, Set<string>> {
  const byClass = new Map<string, Set<string>>();
  for (const method of tree.rootNode.descendantsOfType('method')) {
    const name = method?.childForFieldName('name')?.text;
    if (!method || !name) continue;
    const owner = enclosingClass(method) ?? '';
    let names = byClass.get(owner);
    if (!names) byClass.set(owner, (names = new Set()));
    names.add(name);
  }
  return byClass;
}

/**
 * Ruby calls a method without arguments by its bare name (`log = ledger_entry`),
 * which parses as an identifier, not a call, so the usage query misses it.
 * Here such a name counts as a call on self when the class around it defines
 * a method of that name in this file and the method using it has no parameter
 * or local of that name. Not to another file: there a bare name is as likely
 * a local variable or an attribute.
 */
function addBareRubyCalls(
  tree: Tree,
  chunk: { startLine: number; endLine: number },
  fileMethods: Map<string, Set<string>>,
  callers: Map<number, string | null>,
  sites: Map<string, UseSite>
): void {
  if (fileMethods.size === 0) return;
  const locals = new Map<number, Set<string>>();
  const assignedIn = (method: Node): Set<string> => {
    let names = locals.get(method.id);
    if (!names) {
      names = new Set();
      for (const id of method.childForFieldName('parameters')?.descendantsOfType('identifier') ??
        []) {
        if (id) names.add(id.text);
      }
      for (const a of method.descendantsOfType('assignment')) {
        const left = a?.childForFieldName('left');
        if (left?.type === 'identifier') names.add(left.text);
      }
      locals.set(method.id, names);
    }
    return names;
  };
  const ids = tree.rootNode.descendantsOfType(
    ['identifier', 'hash_key_symbol'],
    { row: chunk.startLine, column: 0 },
    { row: chunk.endLine + 1, column: 0 }
  );
  for (const node of ids) {
    if (!node) continue;
    const parent = node.parent;
    if (!parent) continue;
    // `f(total:)`: a key without a value reads the local or calls the method of its name.
    if (
      node.type === 'hash_key_symbol' &&
      (parent.type !== 'pair' || parent.childForFieldName('value') !== null)
    ) {
      continue;
    }
    const own = enclosingClass(node) ?? '';
    if (!fileMethods.get(own)?.has(node.text)) continue;
    if (RUBY_PARAMETER_NODES.has(parent.type)) continue;
    if (parent.childForFieldName('name')?.id === node.id) continue;
    if (parent.type === 'call' && parent.childForFieldName('method')?.id === node.id) continue;
    if (parent.type === 'assignment' && parent.childForFieldName('left')?.id === node.id) continue;
    let method: Node | null = parent;
    while (method && method.type !== 'method' && method.type !== 'singleton_method') {
      method = method.parent;
    }
    if (!method || assignedIn(method).has(node.text)) continue;
    const site: UseSite = {
      name: node.text,
      from: callerOf(node, callers),
      ...(own !== '' ? { on: `::${own}` } : {}),
    };
    if (!sites.has(siteKey(site))) sites.set(siteKey(site), site);
  }
}

/** Where an identifier is not a value read: a declaration, a parameter, an import, a label, a callee captured as a call. */
const TS_NOT_VALUE_PARENTS = new Set([
  // `export default Name;`: recorded as the module's default export, not a use.
  'export_statement',
  'import_specifier',
  'import_clause',
  'namespace_import',
  'export_specifier',
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'class_declaration',
  'labeled_statement',
  'break_statement',
  'continue_statement',
  'required_parameter',
  'optional_parameter',
  'jsx_opening_element',
  'jsx_closing_element',
  'jsx_self_closing_element',
  'nested_identifier',
]);

/**
 * TypeScript and JavaScript names read as values rather than called: a
 * function passed on (`retry(fetchPage)`), a constant (`PAPARATS_HOME`), an
 * object (`{ handler }`), a class (`instanceof Store`). Only names the file
 * imports or declares at its top level count, so a local or a parameter of
 * the same name is not taken for them.
 */
function addTsValueUses(
  tree: Tree,
  chunk: { startLine: number; endLine: number },
  ts: TsReceiverTypes,
  callers: Map<number, string | null>,
  sites: Map<string, UseSite>,
  uses: Set<string>
): void {
  const ids = tree.rootNode.descendantsOfType(
    ['identifier', 'shorthand_property_identifier'],
    { row: chunk.startLine, column: 0 },
    { row: chunk.endLine + 1, column: 0 }
  );
  for (const node of ids) {
    if (!node || node.startPosition.row > chunk.endLine) continue;
    const parent = node.parent;
    if (!parent || TS_NOT_VALUE_PARENTS.has(parent.type)) continue;
    const field = (name: string) => parent.childForFieldName(name)?.id === node.id;
    if (parent.type === 'call_expression' && field('function')) continue;
    if (parent.type === 'new_expression' && field('constructor')) continue;
    if (parent.type === 'variable_declarator' && field('name')) continue;
    if (parent.type === 'arrow_function' && field('parameter')) continue;
    if (parent.type === 'await_expression' && parent.parent?.type === 'call_expression') continue;
    if (
      (parent.type === 'assignment_pattern' || parent.type === 'object_assignment_pattern') &&
      field('left')
    ) {
      continue;
    }
    if (parent.type === 'catch_clause' || parent.type === 'for_in_statement') {
      if (field('parameter') || field('left')) continue;
    }
    if (isNoise(node.text)) continue;
    const bound = ts.valueBinding(node);
    if (!bound) continue;
    const site: UseSite = {
      name: bound.name,
      from: callerOf(node, callers),
      ...(bound.module !== undefined ? { module: bound.module } : {}),
    };
    uses.add(bound.name);
    if (!sites.has(siteKey(site))) sites.set(siteKey(site), site);
  }
  // `export * from './names.js'`: every name of that module, re-exported. Kept
  // as a `*` re-export so the graph can follow an import of the barrel there.
  for (const stmt of tree.rootNode.namedChildren) {
    if (!stmt || stmt.type !== 'export_statement') continue;
    if (stmt.startPosition.row < chunk.startLine || stmt.startPosition.row > chunk.endLine)
      continue;
    const source = stmt.childForFieldName('source');
    if (source?.type !== 'string' || stmt.namedChildren.some((c) => c?.type === 'export_clause')) {
      continue;
    }
    if (!/^export\s+\*\s+from\b/.test(stmt.text)) continue;
    const spec = source.text.slice(1, -1);
    if (ts.isPackage(spec)) continue;
    const site: UseSite = { name: '*', from: '*', reexport: true, module: spec };
    if (!sites.has(siteKey(site))) sites.set(siteKey(site), site);
  }
}

/**
 * The name a module exports by default, when the statement is in the chunk:
 * `export default function parse`, `export default class Parser`, `export
 * default parse`. Undefined for an anonymous default or none.
 */
function defaultExportIn(
  tree: Tree,
  chunk: { startLine: number; endLine: number }
): string | undefined {
  for (const stmt of tree.rootNode.namedChildren) {
    if (!stmt || stmt.type !== 'export_statement') continue;
    if (stmt.startPosition.row < chunk.startLine || stmt.startPosition.row > chunk.endLine)
      continue;
    if (!/^export\s+default\b/.test(stmt.text)) continue;
    const declaration = stmt.childForFieldName('declaration');
    const named = declaration?.childForFieldName('name')?.text;
    if (named) return named;
    const value =
      stmt.childForFieldName('value') ?? stmt.namedChildren.find((c) => c?.type === 'identifier');
    const name = value ? wrappedName(value) : undefined;
    if (name) return name;
  }
  return undefined;
}

/**
 * The declaration an exported value is: a name, or the one a wrapper is called
 * with (`memo(Card)`, `forwardRef(Field)`, `withAuth(withLayout(Page))`,
 * `connect(mapState)(List)`).
 */
function wrappedName(node: Node): string | undefined {
  let current: Node | null = node;
  for (let depth = 0; current && depth < 6; depth++) {
    if (current.type === 'identifier') return current.text;
    if (
      current.type === 'parenthesized_expression' ||
      current.type === 'as_expression' ||
      current.type === 'satisfies_expression'
    ) {
      current = current.namedChildren[0] ?? null;
      continue;
    }
    if (current.type !== 'call_expression') return undefined;
    current = current.childForFieldName('arguments')?.namedChildren[0] ?? null;
  }
  return undefined;
}

/**
 * Calls between a chunk's own methods, per method: the methods of the chunk
 * that call it (`ledger_entry` → `call`, `preview`). Bare and self calls only, and
 * none from the class body or from a method to itself.
 */
function innerCalls(
  sites: Map<string, UseSite>,
  defines: Map<string, DefinedSymbol>,
  otherSites: Set<string>
): Map<string, Set<string>> {
  const calledFrom = new Map<string, Set<string>>();
  for (const [key, site] of sites) {
    if (!callsOwnDefinition(key, site, defines, otherSites)) continue;
    if (site.from === '' || site.from === site.name) continue;
    let from = calledFrom.get(site.name);
    if (!from) calledFrom.set(site.name, (from = new Set()));
    from.add(site.from);
  }
  return calledFrom;
}

/**
 * A use of a name its own chunk defines: not called on another object, and not
 * imported (`import { Drawer as Trapdoor }` in a file declaring its own `Drawer`).
 */
function callsOwnDefinition(
  key: string,
  site: UseSite,
  defines: Map<string, DefinedSymbol>,
  otherSites: Set<string>
): boolean {
  return defines.has(site.name) && !otherSites.has(key) && site.module === undefined;
}

function siteKey(site: UseSite): string {
  return `${site.name}\0${site.from}\0${site.on ?? ''}\0${site.in ?? ''}\0${site.lexical ?? ''}\0${site.constant ?? ''}\0${site.reexport ?? ''}\0${site.value ?? ''}\0${site.onObject ?? ''}\0${site.through ?? ''}\0${site.module ?? ''}\0${site.external ?? ''}`;
}

/**
 * What a use is called on when its file tells more than the receiver as
 * written: the class of a variable or field (`x = Foo.new; x.bar`, `x: Foo`,
 * `this.store.get()` with `private store: Store`), a module imported whole, a
 * builtin; in TypeScript and JavaScript also the import a name comes from.
 * Undefined keeps {@link calledOn}; in TypeScript and JavaScript an empty
 * object drops it, as a receiver the file cannot type says nothing about the
 * class (`Foo.bar()` on an object constant `Foo`).
 */
function typedSite(
  node: Node,
  receiver: Receiver,
  ruby: RubyReceiverTypes | null,
  ts: TsReceiverTypes | null
): Pick<UseSite, 'on' | 'in' | 'module' | 'external' | 'onObject'> | undefined {
  if (receiver.kind === 'self') return undefined;
  if (ruby) {
    if (receiver.kind !== 'other') return undefined;
    let typed: ReturnType<RubyReceiverTypes['classOf']>;
    if (CONSTANT_PATH.test(receiver.text)) {
      // `RATES.lookup(...)` after `RATES = Rates.new`: a constant holding an
      // object, not a class. Assigned elsewhere, it is read as a class.
      const last = constantPath(receiver.text).split('::').pop()!;
      if (!RUBY_VALUE_CONSTANT_RE.test(last)) return undefined;
      const held = ruby.constantClass(last);
      if (held === undefined) return undefined;
      typed = held ?? undefined;
    } else {
      typed = ruby.classOf(receiver.node);
      // `connection.select_rows`, `Model.connection.execute`: ActiveRecord's
      // adapter (or an HTTP client's), not a namesake method of the project.
      if (!typed && isRubyConnection(receiver.node)) return { external: true };
    }
    if (!typed) return { onObject: true };
    const { classValue, ...on } = typed;
    return classValue ? on : { ...on, onObject: true };
  }
  if (!ts) return undefined;
  if (receiver.kind === 'none') {
    const source = node.parent?.type === 'export_specifier' ? reexportSource(node) : undefined;
    const spec = source ?? ts.importOf(node)?.spec;
    if (spec === undefined) return {};
    return ts.isPackage(spec) ? { external: true } : { module: spec };
  }
  const statically = CONSTANT_PATH.test(receiver.text) && receiver.node.type !== 'new_expression';
  const typed: ReceiverClass | undefined = statically
    ? ts.staticReceiver(receiver.node)
    : ts.classOf(receiver.node);
  // `store.getNameUsage()` on an object of unknown class: a method call, not a bare name.
  if (!typed) return statically ? {} : { onObject: true };
  if ('external' in typed) return { external: true };
  if (typed.on === undefined) return { module: typed.module };
  return {
    on: typed.on,
    ...(typed.module !== undefined ? { module: typed.module } : {}),
    ...(statically ? {} : { onObject: true as const }),
  };
}

/** `connection` or `x.connection`, read without arguments. */
function isRubyConnection(node: Node): boolean {
  if (node.type === 'identifier') return node.text === 'connection';
  return (
    node.type === 'call' &&
    node.childForFieldName('method')?.text === 'connection' &&
    !node.childForFieldName('arguments') &&
    !node.childForFieldName('block')
  );
}

/** `./names.js` for a name in `export { x } from './names.js'`. */
function reexportSource(node: Node): string | undefined {
  let statement: Node | null = node.parent;
  while (statement && statement.type !== 'export_statement') statement = statement.parent;
  const source = statement?.childForFieldName('source');
  return source?.type === 'string' ? source.text.slice(1, -1) : undefined;
}

/**
 * Extract defines_symbols, uses_symbols, and defined_symbols (with kind) for each chunk
 * from a parsed AST tree.
 *
 * @param tree - Parsed tree-sitter tree
 * @param language - tree-sitter Language object (for creating queries)
 * @param chunks - Array of chunk ranges (0-indexed startLine/endLine)
 * @param lang - Language identifier (e.g. 'typescript', 'python')
 * @param nested - Ruby code read from a heredoc of the file (no heredocs read again)
 * @param modules - The project's own packages and path aliases: another bare import is a package
 * @returns Array of SymbolExtractionResult parallel to chunks
 */
export function extractSymbolsForChunks(
  tree: Tree,
  language: Language,
  chunks: Array<{ startLine: number; endLine: number }>,
  lang: string,
  nested = false,
  modules: LocalModules | null = null
): SymbolExtractionResult[] {
  const querySet = LANGUAGE_QUERIES[lang];
  if (!querySet) {
    return chunks.map(() => ({ defines_symbols: [], uses_symbols: [], defined_symbols: [] }));
  }

  if (lang === 'terraform') {
    return extractTerraformSymbols(tree, chunks);
  }
  // Empty set = no scope filtering (legitimate for languages we haven't
  // mapped yet — better to over-emit than to silently drop top-level decls).
  const scopeNodes = FUNCTION_LIKE_SCOPE_NODES_PER_LANG[lang] ?? new Set<string>();

  let defQuery: Query | null = null;
  let useQuery: Query | null = null;
  let rubyMethods: Map<string, Set<string>> | undefined;

  try {
    try {
      defQuery = new Query(language, querySet.definitions);
    } catch {
      // Query compilation failed — skip definitions
    }

    try {
      useQuery = new Query(language, querySet.usages);
    } catch {
      // Query compilation failed — skip usages
    }

    // Collect all captures once, sorted by row (tree-sitter returns them in order)
    const defCaptures = defQuery ? defQuery.captures(tree.rootNode) : [];
    const useCaptures = useQuery ? useQuery.captures(tree.rootNode) : [];

    // In an ES module, the names it exports; null when every top-level name is
    // visible elsewhere (a script, CommonJS, another language).
    const exports = ES_MODULE_LANGS.has(lang) ? moduleExports(tree.rootNode) : null;
    const rubyTypes = lang === 'ruby' ? new RubyReceiverTypes(tree.rootNode) : null;
    const tsTypes = ES_MODULE_LANGS.has(lang) ? new TsReceiverTypes(tree.rootNode, modules) : null;

    // Declarations a use can be made from, across the whole file: a method
    // split over several chunks still owns the uses in its later chunks.
    // Classes and modules map to null — a use in their body comes from no method.
    const callers = new Map<number, string | null>();
    for (const capture of defCaptures) {
      const decl = declarationOf(capture.node);
      if (!decl || callers.has(decl.id)) continue;
      if (!isTopLevelDeclaration(capture.node, scopeNodes)) continue;
      const kind = NODE_TYPE_TO_KIND[decl.type];
      callers.set(decl.id, kind && CONTAINER_KINDS.has(kind) ? null : capture.node.text);
    }

    // Two-pointer approach: captures and chunks are both sorted by line number,
    // so we advance pointers instead of scanning all captures for every chunk.
    const results: SymbolExtractionResult[] = [];
    let defIdx = 0;
    let useIdx = 0;

    for (const chunk of chunks) {
      const defines = new Map<string, DefinedSymbol>();
      const uses = new Set<string>();
      const sites = new Map<string, UseSite>();
      const otherSites = new Set<string>();

      // Advance defIdx past captures before this chunk
      while (
        defIdx < defCaptures.length &&
        defCaptures[defIdx]!.node.startPosition.row < chunk.startLine
      ) {
        defIdx++;
      }
      // Collect def captures within this chunk. Module-level only — locals
      // (vars/functions inside a function body, callback args, hook closures,
      // etc.) are not addressable from other files and reporting them as
      // "dead code" is just scope-blindness. Their dead-or-alive status is
      // determined by the enclosing function, not by cross-file references.
      for (let d = defIdx; d < defCaptures.length; d++) {
        const row = defCaptures[d]!.node.startPosition.row;
        if (row > chunk.endLine) break;
        const captureNode = defCaptures[d]!.node;
        const text = captureNode.text;
        if (isNoise(text)) continue;
        const known = defines.get(text);
        if (known) {
          // An instance method next to a class method of the same name: callable on objects.
          if (known.classMethod && captureNode.parent?.type !== 'singleton_method') {
            delete known.classMethod;
          }
          continue;
        }
        if (!isTopLevelDeclaration(captureNode, scopeNodes)) continue;
        if (lang === 'ruby' && isRubyNamespaceModule(captureNode)) continue;
        if (lang === 'ruby' && isRubyLibraryClass(captureNode)) continue;
        const kind = resolveKind(captureNode);
        const owner = CONTAINER_KINDS.has(kind)
          ? lang === 'ruby'
            ? rubyNamespaceOf(captureNode)
            : undefined
          : enclosingClass(captureNode);
        const local =
          exports !== null && !owner && kind !== 'method' && !isExported(captureNode, exports);
        const parents = CONTAINER_KINDS.has(kind) ? classParents(captureNode, tsTypes) : undefined;
        defines.set(text, {
          name: text,
          kind,
          ...(owner ? { owner } : {}),
          ...(parents ? { parents } : {}),
          ...(local ? { local: true as const } : {}),
          ...(lang === 'ruby' && captureNode.parent?.type === 'singleton_method'
            ? { classMethod: true as const }
            : {}),
        });
      }

      // Advance useIdx past captures before this chunk
      while (
        useIdx < useCaptures.length &&
        useCaptures[useIdx]!.node.startPosition.row < chunk.startLine
      ) {
        useIdx++;
      }
      // Collect use captures within this chunk
      const calledOnOther = new Set<string>();
      for (let u = useIdx; u < useCaptures.length; u++) {
        const node = useCaptures[u]!.node;
        if (node.startPosition.row > chunk.endLine) break;
        const text = node.text;
        const constant =
          lang === 'ruby' && node.type === 'constant' ? rubyConstant(node, rubyTypes!) : undefined;
        if (constant === null) continue;
        if (!isNoise(text)) {
          uses.add(text);
          const receiver = receiverOf(node);
          if (receiver.kind === 'other') calledOnOther.add(text);
          const exported = exportedAs(node);
          // `import { parse as parseName }`: a call of `parseName` uses `parse`.
          const importedName =
            tsTypes && receiver.kind === 'none' && exported === undefined
              ? tsTypes.importOf(node)?.name
              : undefined;
          const site: UseSite = {
            name: importedName ?? text,
            from: exported ?? callerOf(node, callers),
            ...(typedSite(node, receiver, rubyTypes, tsTypes) ?? calledOn(node, receiver, lang)),
            ...constant,
            ...(exported !== undefined ? { reexport: true as const } : {}),
            ...(lang === 'ruby' && isRubyValue(node) ? { value: true as const } : {}),
          };
          const key = siteKey(site);
          if (!sites.has(key)) sites.set(key, site);
          if (receiver.kind === 'other') otherSites.add(key);
        }
      }

      // Remove self-references: a name both defined and used in the chunk is
      // usually a recursive call or a type annotation on its own definition.
      // Not when it is called on another object: `def self.water` calling
      // `Planter.water(...)` delegates to a different class's method.
      for (const sym of defines.keys()) {
        if (!calledOnOther.has(sym)) uses.delete(sym);
      }
      if (lang === 'ruby') {
        rubyMethods ??= rubyMethodsByClass(tree);
        addBareRubyCalls(tree, chunk, rubyMethods, callers, sites);
      }
      if (tsTypes) addTsValueUses(tree, chunk, tsTypes, callers, sites, uses);
      const outside = [...sites.entries()]
        .filter(([key, site]) => !callsOwnDefinition(key, site, defines, otherSites))
        .map(([, site]) => site);
      const inner = innerCalls(sites, defines, otherSites);
      const defaultExport = tsTypes ? defaultExportIn(tree, chunk) : undefined;

      const defined_symbols = Array.from(defines.values());

      results.push({
        defines_symbols: defined_symbols.map((d) => d.name),
        uses_symbols: Array.from(uses),
        defined_symbols,
        use_sites: outside,
        ...(defaultExport !== undefined ? { default_export: defaultExport } : {}),
        ...(inner.size > 0
          ? {
              inner_calls: Object.fromEntries(
                [...inner].map(([callee, callers]) => [callee, [...callers].sort()])
              ),
            }
          : {}),
      });
    }

    if (lang === 'ruby' && !nested) addRubyHeredocUses(tree, language, chunks, results, callers);
    return results;
  } finally {
    defQuery?.delete();
    useQuery?.delete();
  }
}
