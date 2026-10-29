import type { Node } from 'web-tree-sitter';
import { isLocalModule, type LocalModules } from './local-modules.js';

/** `Grove`, `Orchard::Grove`, `::Orchard::Grove`, `Orchard.Grove`: a receiver that names a class. */
export const CONSTANT_PATH = /^(?:::)?[A-Z][A-Za-z0-9_]*(?:(?:::|\.)[A-Z][A-Za-z0-9_]*)*$/;

/** `Orchard.Grove` and `Orchard::Grove` alike, as `Orchard::Grove`. */
export function constantPath(text: string): string {
  return text.replace(/\./g, '::');
}

/** Node types whose name is the class a method inside them belongs to. */
export const CLASS_LIKE_NODES = new Set([
  'class',
  'module',
  'class_declaration',
  'abstract_class_declaration',
  'class_definition',
  'interface_declaration',
  'struct_item',
  'impl_item',
  'trait_item',
  'class_specifier',
  'struct_specifier',
  'struct_declaration',
]);

/**
 * The full path of the classes and modules enclosing a node, outermost first:
 * `Orchard::Grove` inside `module Orchard; class Grove`, and for `class
 * Orchard::Grove` too. A name written with a leading `::` starts from the top.
 */
export function enclosingClass(node: Node): string | undefined {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (!CLASS_LIKE_NODES.has(current.type)) continue;
    const name = current.childForFieldName('name') ?? current.childForFieldName('type');
    if (!name) continue;
    names.push(constantPath(name.text));
    if (name.text.startsWith('::')) break;
  }
  if (names.length === 0) return undefined;
  return names.reverse().join('::').replace(/^::/, '');
}

/**
 * What the receiver of a call holds, as far as its file says:
 * - an object of a class (`on`, resolved from `in` like a written constant;
 *   `module` is the import the class comes from);
 * - a module imported whole (`import * as store from './store.js'`): only
 *   `module`;
 * - a value of a class outside the project (a string, a `Map`, `JSON`,
 *   `node:fs`): `external`.
 */
export type ReceiverClass =
  | { on: string; in?: string; module?: string }
  | { module: string; on?: undefined }
  | { external: true };

/** A class; `classValue` when the value is the class itself (`model = Invoice`), not an object of it. */
type Typed = { on: string; in?: string; classValue?: true };

// ── Ruby ──────────────────────────────────────────────────────────────────

/** Ruby literals, by node type, and the class of the value each makes. */
const RUBY_LITERAL_CLASSES: Record<string, string> = {
  string: 'String',
  chained_string: 'String',
  heredoc_beginning: 'String',
  string_array: 'Array',
  symbol_array: 'Array',
  array: 'Array',
  hash: 'Hash',
  integer: 'Integer',
  float: 'Float',
  simple_symbol: 'Symbol',
  delimited_symbol: 'Symbol',
  regex: 'Regexp',
  range: 'Range',
};

const RUBY_METHOD_NODES = new Set(['method', 'singleton_method']);
const RUBY_BLOCK_NODES = new Set(['block', 'do_block', 'lambda']);

/** Rails' finders, which return an object of the class they are called on, as `new` does. */
const RUBY_FINDERS = new Set([
  'find',
  'find_by',
  'find_by!',
  'find_or_initialize_by',
  'find_or_create_by',
  'find_or_create_by!',
  'create',
  'create!',
  'first',
  'first!',
  'last',
  'last!',
  'take',
  'take!',
]);

/**
 * The class of the object a Ruby expression makes: `Foo.new(...)`, `new(...)`
 * in a class, `Foo.find_by(...)`, a literal.
 */
function rubyMadeClass(expr: Node): Typed | undefined {
  let node = expr;
  while (node.type === 'parenthesized_statements' && node.namedChildCount === 1) {
    node = node.namedChild(0)!;
  }
  const literal = RUBY_LITERAL_CLASSES[node.type];
  if (literal) return { on: `::${literal}` };
  if (node.type === 'constant' || node.type === 'scope_resolution') {
    if (!CONSTANT_PATH.test(node.text) || /^[A-Z][A-Z0-9_]+$/.test(node.text.split('::').pop()!)) {
      return undefined;
    }
    const path = constantPath(node.text);
    const scope = enclosingClass(node);
    return path.startsWith('::') || !scope
      ? { on: path, classValue: true }
      : { on: path, in: scope, classValue: true };
  }
  if (node.type !== 'call') return undefined;
  const method = node.childForFieldName('method')?.text ?? '';
  if (method !== 'new' && !RUBY_FINDERS.has(method)) return undefined;
  const cls = node.childForFieldName('receiver');
  if (!cls) {
    if (method !== 'new') return undefined;
    const own = enclosingClass(node);
    return own ? { on: `::${own}` } : undefined;
  }
  if (!CONSTANT_PATH.test(cls.text)) return undefined;
  const path = constantPath(cls.text);
  if (path.startsWith('::')) return { on: path };
  const scope = enclosingClass(node);
  return scope ? { on: path, in: scope } : { on: path };
}

function nearest(node: Node, types: Set<string>): Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (types.has(current.type)) return current;
  }
  return null;
}

/** Per variable assigned in a scope: the class every assignment gives it, null when they differ or one is not known. */
type Assigned = Map<string, Typed | null>;

function addAssigned(found: Assigned, name: string, made: Typed | undefined): void {
  const known = found.get(name);
  if (known === null) return;
  if (!made) {
    found.set(name, null);
    return;
  }
  if (known === undefined) found.set(name, made);
  else if (known.on !== made.on || known.in !== made.in || known.classValue !== made.classValue) {
    found.set(name, null);
  }
}

/**
 * Types Ruby receivers within one file. Results are kept per scope node, so
 * one instance serves every use in the file.
 */
export class RubyReceiverTypes {
  private locals = new Map<number, Assigned>();
  private ivars = new Map<number, Assigned>();
  private readers = new Map<number, Map<string, Typed | null>>();
  private constants: Assigned | null = null;

  constructor(private readonly root: Node) {}

  /**
   * A Ruby constant holding a value (`RATES = Pricing::Rates.new`, `REGIONS =
   * Geo::Regions`), assigned in this file: the class of what it holds,
   * null when that is not known, undefined when the file assigns it nothing.
   */
  constantClass(name: string): Typed | null | undefined {
    if (!this.constants) {
      this.constants = new Map();
      for (const a of this.root.descendantsOfType('assignment')) {
        const left = a?.childForFieldName('left');
        const named = left?.type === 'scope_resolution' ? left.childForFieldName('name') : left;
        if (!a || named?.type !== 'constant') continue;
        const right = a.childForFieldName('right');
        addAssigned(this.constants, named.text, right ? rubyMadeClass(right) : undefined);
      }
    }
    return this.constants.get(name);
  }

  /**
   * The class of the object a call is made on, when the file says: `x` after
   * `x = Foo.new` in the same method (every assignment to it alike, not a
   * parameter or a block's), `@x` after `@x = Foo.new` or `@x ||= Foo.new` in
   * the class, a method of the class without arguments that returns one
   * (`def client = @client ||= Api::Client.new`, an `attr_reader` of such an
   * `@x`), a literal (`"a".strip`, `[...].each`).
   */
  classOf(receiver: Node): Typed | undefined {
    const made = rubyMadeClass(receiver);
    if (made && receiver.type !== 'call') return made;
    if (receiver.type === 'instance_variable') {
      const cls = nearest(receiver, CLASS_NODES_RUBY);
      return cls ? (this.ivarsOf(cls).get(receiver.text) ?? undefined) : undefined;
    }
    if (receiver.type !== 'identifier') return undefined;
    const name = receiver.text;
    if (this.boundByBlock(receiver, name)) return undefined;
    const method = nearest(receiver, RUBY_METHOD_NODES);
    const assigned = this.localsOf(method ?? this.root).get(name);
    if (assigned !== undefined) return assigned ?? undefined;
    if (!method || this.isParameter(method, name)) return undefined;
    const cls = nearest(method, CLASS_NODES_RUBY);
    return cls ? (this.readersOf(cls).get(name) ?? undefined) : undefined;
  }

  private boundByBlock(node: Node, name: string): boolean {
    for (let current = node.parent; current; current = current.parent) {
      if (RUBY_METHOD_NODES.has(current.type)) return false;
      if (!RUBY_BLOCK_NODES.has(current.type)) continue;
      const params = current.childForFieldName('parameters');
      if (params?.descendantsOfType('identifier').some((id) => id?.text === name)) return true;
    }
    return false;
  }

  private isParameter(method: Node, name: string): boolean {
    const params = method.childForFieldName('parameters');
    return !!params?.descendantsOfType('identifier').some((id) => id?.text === name);
  }

  private localsOf(scope: Node): Assigned {
    let found = this.locals.get(scope.id);
    if (found) return found;
    found = new Map();
    const method = RUBY_METHOD_NODES.has(scope.type) ? scope : null;
    for (const a of scope.descendantsOfType(['assignment', 'operator_assignment'])) {
      const left = a?.childForFieldName('left');
      if (!a || left?.type !== 'identifier') continue;
      if (nearest(a, RUBY_METHOD_NODES)?.id !== method?.id) continue;
      const right = a.childForFieldName('right');
      addAssigned(found, left.text, right ? rubyMadeClass(right) : undefined);
    }
    this.locals.set(scope.id, found);
    return found;
  }

  private ivarsOf(cls: Node): Assigned {
    let found = this.ivars.get(cls.id);
    if (found) return found;
    found = new Map();
    for (const a of cls.descendantsOfType(['assignment', 'operator_assignment'])) {
      const left = a?.childForFieldName('left');
      if (!a || left?.type !== 'instance_variable') continue;
      if (nearest(a, CLASS_NODES_RUBY)?.id !== cls.id) continue;
      const right = a.childForFieldName('right');
      addAssigned(found, left.text, right ? rubyMadeClass(right) : undefined);
    }
    this.ivars.set(cls.id, found);
    return found;
  }

  /** Methods of a class callable without arguments that return an object of a known class. */
  private readersOf(cls: Node): Map<string, Typed | null> {
    let found = this.readers.get(cls.id);
    if (found) return found;
    found = new Map();
    const body = cls.childForFieldName('body');
    for (const stmt of body?.namedChildren ?? []) {
      if (!stmt) continue;
      if (
        stmt.type === 'call' &&
        /^attr_(reader|accessor)$/.test(stmt.childForFieldName('method')?.text ?? '')
      ) {
        for (const arg of stmt.childForFieldName('arguments')?.namedChildren ?? []) {
          if (arg?.type !== 'simple_symbol') continue;
          const name = arg.text.slice(1);
          found.set(name, this.ivarsOf(cls).get(`@${name}`) ?? null);
        }
        continue;
      }
      if (stmt.type !== 'method' || stmt.childForFieldName('parameters')) continue;
      const name = stmt.childForFieldName('name')?.text;
      const returned = lastStatement(stmt.childForFieldName('body'));
      if (!name || !returned) continue;
      found.set(name, this.returnedClass(cls, returned) ?? null);
    }
    this.readers.set(cls.id, found);
    return found;
  }

  private returnedClass(cls: Node, expr: Node): Typed | undefined {
    if (expr.type === 'instance_variable') return this.ivarsOf(cls).get(expr.text) ?? undefined;
    if (expr.type === 'assignment' || expr.type === 'operator_assignment') {
      const left = expr.childForFieldName('left');
      if (left?.type === 'instance_variable') return this.ivarsOf(cls).get(left.text) ?? undefined;
      const right = expr.childForFieldName('right');
      return right ? rubyMadeClass(right) : undefined;
    }
    return rubyMadeClass(expr);
  }
}

const CLASS_NODES_RUBY = new Set(['class', 'module']);

function lastStatement(body: Node | null): Node | undefined {
  if (!body) return undefined;
  if (body.type !== 'body_statement') return body;
  for (let i = body.namedChildCount - 1; i >= 0; i--) {
    const stmt = body.namedChild(i);
    if (stmt && stmt.type !== 'comment') return stmt;
  }
  return undefined;
}

// ── TypeScript / JavaScript ───────────────────────────────────────────────

/** Node's built-in modules, imported bare or as `node:x`. */
const NODE_BUILTIN_MODULES = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

export function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith('node:') || NODE_BUILTIN_MODULES.has(spec);
}

/** Globals of the language and its runtimes, as receivers: `JSON.parse`, `console.log`, `document.body`. */
const TS_GLOBAL_VALUES = new Set([
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'Boolean',
  'Buffer',
  'DataView',
  'Date',
  'Error',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int32Array',
  'Intl',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'TextDecoder',
  'TextEncoder',
  'Uint8Array',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakSet',
  'console',
  'crypto',
  'document',
  'globalThis',
  'history',
  'localStorage',
  'location',
  'navigator',
  'performance',
  'process',
  'sessionStorage',
  'window',
]);

/** Generic global types whose values are objects of a builtin class. */
const TS_GLOBAL_CLASSES = new Set([
  'Array',
  'ReadonlyArray',
  'Map',
  'ReadonlyMap',
  'Set',
  'ReadonlySet',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Date',
  'RegExp',
  'Error',
  'Buffer',
  'URL',
  'URLSearchParams',
  'Uint8Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'AbortController',
  'AbortSignal',
  'Headers',
  'Request',
  'Response',
  'ReadableStream',
  'WritableStream',
  'TextDecoder',
  'TextEncoder',
  'Iterable',
  'Iterator',
  'IterableIterator',
  'AsyncIterable',
  'AsyncIterator',
  'AsyncIterableIterator',
  'Generator',
  'AsyncGenerator',
  'String',
  'Number',
  'Boolean',
]);

/** Wrappers whose value has the methods of their first type argument. */
const TS_TRANSPARENT_TYPES = new Set(['Readonly', 'Required', 'Partial', 'NonNullable']);

const TS_PREDEFINED_EXTERNAL = new Set(['string', 'number', 'boolean', 'bigint', 'symbol']);
const TS_LITERAL_VALUES = new Set(['string', 'template_string', 'number', 'array', 'regex']);
const TS_LITERAL_TYPES = new Set([
  'array_type',
  'tuple_type',
  'function_type',
  'literal_type',
  'template_literal_type',
]);
const TS_CLASS_KINDS = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'enum_declaration',
]);

const TS_FUNCTION_NODES = new Set([
  'function_declaration',
  'function_expression',
  'function',
  'arrow_function',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
]);

/** Where a name is bound in a pattern or declaration, by the parent's node type. */
const TS_BINDING_PARENTS = new Set([
  'variable_declarator',
  'required_parameter',
  'optional_parameter',
  'object_pattern',
  'array_pattern',
  'pair_pattern',
  'rest_pattern',
  'assignment_pattern',
  'object_assignment_pattern',
  'catch_clause',
  'for_in_statement',
  'arrow_function',
]);

interface TsImport {
  spec: string;
  /** The exported name it binds; null for a default or namespace import. */
  name: string | null;
  namespace: boolean;
}

const EXTERNAL = { external: true } as const;

/** A name bound by a declaration or a parameter: its annotation and its value, when written. */
interface Binding {
  type: Node | null;
  value: Node | null;
  /** A name destructured from a dynamic import (`const { x } = await import('./m')`). */
  imported?: TsImport;
}

/**
 * Types TypeScript and JavaScript receivers within one file, from its imports,
 * its top-level declarations and the annotations and `new` expressions around
 * a use.
 */
export class TsReceiverTypes {
  readonly imports = new Map<string, TsImport>();
  /** Top-level declarations: name → declaration node type. */
  private declared = new Map<string, string>();
  /** Top-level function declarations, for the class their return type names. */
  private functions = new Map<string, Node>();
  private fields = new Map<number, Map<string, ReceiverClass | undefined>>();
  private bindings = new Map<number, Map<string, Binding[]>>();
  /** Whether the file is an ES module (its names are its own) rather than a script. */
  readonly module: boolean;

  constructor(
    root: Node,
    private readonly modules: LocalModules | null = null
  ) {
    let module = false;
    for (const stmt of root.namedChildren) {
      if (!stmt) continue;
      if (stmt.type === 'import_statement') {
        module = true;
        this.addImport(stmt);
        continue;
      }
      if (stmt.type === 'export_statement') module = true;
      const decl =
        stmt.type === 'export_statement'
          ? (stmt.childForFieldName('declaration') ?? stmt.namedChild(0))
          : stmt;
      if (!decl) continue;
      const name = decl.childForFieldName('name');
      if (name) this.declared.set(name.text, decl.type);
      if (name && decl.type === 'function_declaration') this.functions.set(name.text, decl);
      if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
        for (const d of decl.namedChildren) {
          const n = d?.type === 'variable_declarator' ? d.childForFieldName('name') : null;
          const value = d?.childForFieldName('value') ?? null;
          if (n?.type === 'identifier') {
            this.declared.set(n.text, 'variable_declarator');
            const required = requiredModule(value) ?? dynamicImport(value);
            if (required) this.imports.set(n.text, { spec: required, name: null, namespace: true });
          }
          // `const { load, defaults: d } = await import('./settings')`, as tests load a module.
          const dynamic = n?.type === 'object_pattern' ? dynamicImport(value) : undefined;
          if (n && dynamic !== undefined) {
            for (const part of n.namedChildren) {
              const name = part?.type === 'pair_pattern' ? part.childForFieldName('key') : part;
              const local = part?.type === 'pair_pattern' ? part.childForFieldName('value') : part;
              if (
                !name ||
                (local?.type !== 'identifier' &&
                  local?.type !== 'shorthand_property_identifier_pattern')
              )
                continue;
              this.declared.set(local.text, 'variable_declarator');
              this.imports.set(local.text, { spec: dynamic, name: name.text, namespace: false });
            }
          }
        }
      }
    }
    this.module = module;
  }

  private addImport(stmt: Node): void {
    const spec = stringValue(stmt.childForFieldName('source'));
    const clause = stmt.namedChildren.find((c) => c?.type === 'import_clause');
    if (spec === undefined || !clause) return;
    for (const part of clause.namedChildren) {
      if (!part) continue;
      if (part.type === 'identifier')
        this.imports.set(part.text, { spec, name: null, namespace: false });
      if (part.type === 'namespace_import') {
        const local = part.namedChildren.find((c) => c?.type === 'identifier');
        if (local) this.imports.set(local.text, { spec, name: null, namespace: true });
      }
      if (part.type !== 'named_imports') continue;
      for (const specifier of part.namedChildren) {
        if (specifier?.type !== 'import_specifier') continue;
        const name = specifier.childForFieldName('name');
        const alias = specifier.childForFieldName('alias') ?? name;
        if (name && alias)
          this.imports.set(alias.text, { spec, name: name.text, namespace: false });
      }
    }
  }

  /** A module outside the project: Node's own, or an installed package when the project's packages are known. */
  isPackage(spec: string): boolean {
    return isNodeBuiltin(spec) || (this.modules !== null && !isLocalModule(spec, this.modules));
  }

  /** The import a name used in the file is bound to, unless something closer binds it. */
  importOf(node: Node, name = node.text): TsImport | undefined {
    const local = this.localBindings(node, name);
    if (local) return local.length === 1 ? local[0]!.imported : undefined;
    return this.imports.get(name);
  }

  /**
   * What a name used as a value (`retry(fetchPage)`, `PAPARATS_HOME`, `{
   * handler }`) is bound to: an import (with its module and the name it
   * exports) or a top-level declaration of the file. Null for anything a
   * function binds, a package's import, or a name the file does not bind.
   */
  valueBinding(node: Node): { name: string; module?: string } | null {
    const name = node.text;
    const local = this.localBindings(node, name);
    if (local && (local.length !== 1 || !local[0]!.imported)) return null;
    const imported = local ? local[0]!.imported : this.imports.get(name);
    if (imported) {
      if (imported.namespace || this.isPackage(imported.spec)) return null;
      return { name: imported.name ?? name, module: imported.spec };
    }
    return this.declared.has(name) ? { name } : null;
  }

  /** The class a name in a type or a `new` names: a class of this file or an import, or a builtin. */
  classNamed(node: Node, name: string): ReceiverClass | undefined {
    if (this.boundLocally(node, name)) return undefined;
    const declared = this.declared.get(name);
    if (declared !== undefined) return TS_CLASS_KINDS.has(declared) ? { on: name } : undefined;
    const imported = this.imports.get(name);
    if (imported) {
      if (this.isPackage(imported.spec)) return EXTERNAL;
      if (imported.namespace) return { module: imported.spec };
      return { on: imported.name ?? name, module: imported.spec };
    }
    if (TS_GLOBAL_CLASSES.has(name)) return EXTERNAL;
    // A script's other names are globals another script may declare.
    return this.module ? undefined : { on: name };
  }

  /** The class of the value a receiver holds, when the file says. */
  classOf(receiver: Node): ReceiverClass | undefined {
    if (TS_LITERAL_VALUES.has(receiver.type)) return EXTERNAL;
    if (receiver.type === 'new_expression' || receiver.type === 'parenthesized_expression') {
      return this.valueClass(receiver);
    }
    if (receiver.type === 'identifier') return this.identifierClass(receiver);
    if (receiver.type === 'member_expression') {
      const object = receiver.childForFieldName('object');
      const property = receiver.childForFieldName('property');
      if (object?.type !== 'this' || !property) return undefined;
      const cls = nearest(receiver, TS_CLASS_BODY_OWNERS);
      return cls ? this.fieldsOf(cls).get(property.text) : undefined;
    }
    return undefined;
  }

  /** `Foo.bar()`: a class of the project, a module imported whole, a global (`JSON`), or nothing known. */
  staticReceiver(receiver: Node): ReceiverClass | undefined {
    const first = receiver.text.split(/\.|::/)[0] ?? '';
    if (this.boundLocally(receiver, first)) return undefined;
    const declared = this.declared.get(first);
    if (declared !== undefined) {
      return TS_CLASS_KINDS.has(declared) ? { on: constantPath(receiver.text) } : undefined;
    }
    const imported = this.imports.get(first);
    if (imported) {
      if (this.isPackage(imported.spec)) return EXTERNAL;
      if (imported.namespace || first !== receiver.text) return { module: imported.spec };
      return { on: imported.name ?? first, module: imported.spec };
    }
    if (TS_GLOBAL_VALUES.has(first)) return EXTERNAL;
    return this.module ? undefined : { on: constantPath(receiver.text) };
  }

  private identifierClass(node: Node): ReceiverClass | undefined {
    const name = node.text;
    for (let fn = nearest(node, TS_FUNCTION_NODES); fn; fn = nearest(fn, TS_FUNCTION_NODES)) {
      const bound = this.bindingIn(fn, name);
      if (bound !== null) return bound;
    }
    const top = this.bindingIn(null, name, node);
    if (top !== null) return top;
    const imported = this.imports.get(name);
    if (imported) {
      if (this.isPackage(imported.spec)) return EXTERNAL;
      return imported.namespace || imported.name === null ? { module: imported.spec } : undefined;
    }
    if (this.declared.has(name)) return undefined;
    return TS_GLOBAL_VALUES.has(name) ? EXTERNAL : undefined;
  }

  /**
   * How a function (or, for null, the top level of the file) binds a name: as
   * a parameter or variable of a known class, bound otherwise (undefined), or
   * not at all (null).
   */
  private bindingIn(fn: Node | null, name: string, from?: Node): ReceiverClass | undefined | null {
    const scope = fn ?? rootOf(from!);
    const found = this.bindingsOf(scope, fn).get(name);
    if (!found) return null;
    // Blocks of one function may each declare it (`const seen = new Set()` twice): alike, or not known.
    let typed: ReceiverClass | undefined;
    for (const [i, { type, value }] of found.entries()) {
      const one = type ? this.typeClass(type) : value ? this.valueClass(value) : undefined;
      if (!one || (i > 0 && JSON.stringify(one) !== JSON.stringify(typed))) return undefined;
      typed = one;
    }
    return typed;
  }

  /** Every name a scope binds itself (not in a function inside it), with each binding's type or value. */
  private bindingsOf(scope: Node, fn: Node | null): Map<string, Binding[]> {
    let found = this.bindings.get(scope.id);
    if (found) return found;
    found = new Map();
    const bindings = found;
    const add = (name: string, type: Node | null, value: Node | null, imported?: TsImport) => {
      const binding: Binding = { type, value, ...(imported ? { imported } : {}) };
      const known = bindings.get(name);
      if (known) known.push(binding);
      else bindings.set(name, [binding]);
    };
    if (fn) {
      // `import('./m').then((m) => m.X)`: the first parameter holds the module.
      const loaded = thenOfImport(fn);
      const whole =
        loaded === undefined ? undefined : { spec: loaded, name: null, namespace: true };
      const params = fn.childForFieldName('parameters')?.namedChildren ?? [];
      params.forEach((param, i) => {
        const pattern = param?.childForFieldName('pattern');
        if (!param || pattern?.type !== 'identifier') return;
        add(pattern.text, param.childForFieldName('type'), null, i === 0 ? whole : undefined);
      });
      const single = fn.childForFieldName('parameter');
      if (single?.type === 'identifier') add(single.text, null, null, whole);
    }
    for (const id of scope.descendantsOfType([
      'identifier',
      'shorthand_property_identifier_pattern',
    ])) {
      const parent = id?.parent;
      if (!id || !parent || !TS_BINDING_PARENTS.has(parent.type)) continue;
      if ((nearest(id, TS_FUNCTION_NODES)?.id ?? null) !== (fn?.id ?? null)) continue;
      const field = (f: string) => parent.childForFieldName(f)?.id === id.id;
      switch (parent.type) {
        case 'variable_declarator':
          if (!field('name')) continue;
          add(id.text, parent.childForFieldName('type'), parent.childForFieldName('value'));
          continue;
        case 'required_parameter':
        case 'optional_parameter':
        case 'arrow_function':
          continue; // the function's own parameters, above; or a value, not a binding
        case 'assignment_pattern':
        case 'object_assignment_pattern':
          if (!field('left')) continue;
          break;
        case 'pair_pattern':
          if (!field('value')) continue;
          break;
        case 'for_in_statement':
          if (!field('left')) continue;
          break;
        case 'catch_clause':
          if (!field('parameter')) continue;
          break;
      }
      add(id.text, null, null, destructuredImport(id));
    }
    this.bindings.set(scope.id, found);
    return found;
  }

  /** Whether a function around a node binds the name (a parameter, a variable, a destructured field). */
  private boundLocally(node: Node, name: string): boolean {
    return this.localBindings(node, name) !== undefined;
  }

  /** The bindings of the name in the nearest function around a node binding it. */
  private localBindings(node: Node, name: string): Binding[] | undefined {
    for (let fn = nearest(node, TS_FUNCTION_NODES); fn; fn = nearest(fn, TS_FUNCTION_NODES)) {
      const found = this.bindingsOf(fn, fn).get(name);
      if (found) return found;
    }
    return undefined;
  }

  private typeClass(type: Node, awaited = false): ReceiverClass | undefined {
    let node = type;
    while (
      (node.type === 'type_annotation' || node.type === 'parenthesized_type') &&
      node.namedChildCount === 1
    ) {
      node = node.namedChild(0)!;
    }
    if (node.type === 'union_type') {
      const members = node.namedChildren.filter(
        (m): m is Node => m !== null && !/^(null|undefined)$/.test(m.text)
      );
      return members.length === 1 ? this.typeClass(members[0]!) : undefined;
    }
    if (node.type === 'predefined_type') {
      return TS_PREDEFINED_EXTERNAL.has(node.text) ? EXTERNAL : undefined;
    }
    if (TS_LITERAL_TYPES.has(node.type)) return EXTERNAL;
    if (node.type === 'type_identifier') return this.classNamed(node, node.text);
    if (node.type === 'generic_type') {
      const name = node.childForFieldName('name');
      if (!name) return undefined;
      if (TS_TRANSPARENT_TYPES.has(name.text) || (awaited && name.text === 'Promise')) {
        const first = node.childForFieldName('type_arguments')?.namedChild(0);
        return first ? this.typeClass(first) : undefined;
      }
      return name.type === 'type_identifier'
        ? this.classNamed(name, name.text)
        : this.nestedClass(name);
    }
    if (node.type === 'nested_type_identifier') return this.nestedClass(node);
    return undefined;
  }

  /** `store.Store` in a type: a class of a module imported whole, or of a default export's namespace. */
  private nestedClass(node: Node): ReceiverClass | undefined {
    const [first, ...rest] = node.text.split('.');
    const imported = first ? this.imports.get(first) : undefined;
    if (!imported || imported.name !== null || rest.length !== 1) return undefined;
    return this.isPackage(imported.spec) ? EXTERNAL : { on: rest[0]!, module: imported.spec };
  }

  private valueClass(value: Node): ReceiverClass | undefined {
    let node = value;
    while (node.type === 'parenthesized_expression' && node.namedChildCount === 1)
      node = node.namedChild(0)!;
    if (TS_LITERAL_VALUES.has(node.type)) return EXTERNAL;
    if (node.type === 'as_expression' || node.type === 'satisfies_expression') {
      const type = node.namedChild(1);
      return type ? this.typeClass(type) : undefined;
    }
    if (node.type === 'new_expression') {
      const ctor = node.childForFieldName('constructor');
      if (ctor?.type === 'identifier') return this.classNamed(ctor, ctor.text);
      if (ctor?.type === 'member_expression') {
        const object = ctor.childForFieldName('object');
        const property = ctor.childForFieldName('property');
        const imported = object?.type === 'identifier' ? this.importOf(object) : undefined;
        if (imported?.namespace && property) {
          return this.isPackage(imported.spec)
            ? EXTERNAL
            : { on: property.text, module: imported.spec };
        }
      }
      return undefined;
    }
    const required = requiredModule(node);
    if (required) return this.isPackage(required) ? EXTERNAL : { module: required };
    const awaited = node.type === 'await_expression';
    const call = awaited ? node.namedChild(0) : node;
    if (call?.type !== 'call_expression') return undefined;
    const fn = call.childForFieldName('function');
    if (fn?.type === 'identifier') {
      const imported = this.importOf(fn);
      if (imported && this.isPackage(imported.spec)) return EXTERNAL;
      const declared = this.functions.get(fn.text);
      const returns =
        declared && !this.boundLocally(fn, fn.text)
          ? declared.childForFieldName('return_type')
          : null;
      return returns ? this.typeClass(returns, awaited) : undefined;
    }
    return undefined;
  }

  /** A class's fields of a known class: annotated or `new` fields, constructor parameter properties, `this.x = new X()` in the constructor. */
  private fieldsOf(cls: Node): Map<string, ReceiverClass | undefined> {
    let found = this.fields.get(cls.id);
    if (found) return found;
    found = new Map();
    const conflicting = new Set<string>();
    const annotated = new Set<string>();
    const add = (name: string, typed: ReceiverClass | undefined) => {
      if (conflicting.has(name) || annotated.has(name)) return;
      if (found!.has(name) && JSON.stringify(found!.get(name)) !== JSON.stringify(typed)) {
        conflicting.add(name);
        found!.set(name, undefined);
        return;
      }
      found!.set(name, typed);
    };
    for (const member of cls.childForFieldName('body')?.namedChildren ?? []) {
      if (!member) continue;
      if (member.type === 'public_field_definition' || member.type === 'field_definition') {
        const name = member.childForFieldName('name') ?? member.childForFieldName('property');
        if (!name) continue;
        const type = member.childForFieldName('type');
        const value = member.childForFieldName('value');
        add(name.text, type ? this.typeClass(type) : value ? this.valueClass(value) : undefined);
        if (type) annotated.add(name.text);
        continue;
      }
      if (
        member.type !== 'method_definition' ||
        member.childForFieldName('name')?.text !== 'constructor'
      )
        continue;
      for (const param of member.childForFieldName('parameters')?.namedChildren ?? []) {
        if (
          !param ||
          !param.namedChildren.some(
            (c) => c?.type === 'accessibility_modifier' || c?.text === 'readonly'
          )
        )
          continue;
        const pattern = param.childForFieldName('pattern');
        const type = param.childForFieldName('type');
        if (pattern?.type !== 'identifier') continue;
        add(pattern.text, type ? this.typeClass(type) : undefined);
        if (type) annotated.add(pattern.text);
      }
      for (const a of member.descendantsOfType('assignment_expression')) {
        const left = a?.childForFieldName('left');
        if (left?.type !== 'member_expression' || left.childForFieldName('object')?.type !== 'this')
          continue;
        const property = left.childForFieldName('property');
        const right = a?.childForFieldName('right');
        if (property && right) add(property.text, this.valueClass(right));
      }
    }
    this.fields.set(cls.id, found);
    return found;
  }
}

const TS_CLASS_BODY_OWNERS = new Set(['class_declaration', 'abstract_class_declaration', 'class']);

function rootOf(node: Node): Node {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function stringValue(node: Node | null): string | undefined {
  if (!node || node.type !== 'string') return undefined;
  return node.text.slice(1, -1);
}

/** The import a name destructured from `await import('./m')` is bound to. */
function destructuredImport(id: Node): TsImport | undefined {
  const pair = id.parent?.type === 'pair_pattern' ? id.parent : null;
  const pattern = pair ? pair.parent : id.parent;
  const declarator = pattern?.parent;
  if (pattern?.type !== 'object_pattern') return undefined;
  const name = pair ? pair.childForFieldName('key')?.text : id.text;
  // `import('./m').then(({ Card }) => ...)`: fields of the module handed to `.then`.
  if (declarator?.type === 'required_parameter') {
    const params = declarator.parent;
    const fn = params?.parent;
    if (params?.namedChild(0)?.id !== declarator.id || !fn) return undefined;
    const spec = thenOfImport(fn);
    return spec === undefined || name === undefined ? undefined : { spec, name, namespace: false };
  }
  if (declarator?.type !== 'variable_declarator') return undefined;
  if (declarator.childForFieldName('name')?.id !== pattern.id) return undefined;
  const spec = dynamicImport(declarator.childForFieldName('value'));
  if (spec === undefined) return undefined;
  return name === undefined ? undefined : { spec, name, namespace: false };
}

/** `import('./m').then((m) => ...)`: the module a callback's first parameter is handed. */
function thenOfImport(fn: Node): string | undefined {
  const args = fn.parent;
  if (args?.type !== 'arguments' || args.namedChild(0)?.id !== fn.id) return undefined;
  const callee =
    args.parent?.type === 'call_expression' ? args.parent.childForFieldName('function') : null;
  if (
    callee?.type !== 'member_expression' ||
    callee.childForFieldName('property')?.text !== 'then'
  ) {
    return undefined;
  }
  return dynamicImport(callee.childForFieldName('object'));
}

/** `await import('./store')`: the module a dynamic import loads. */
function dynamicImport(node: Node | null): string | undefined {
  const call = node?.type === 'await_expression' ? node.namedChild(0) : node;
  if (call?.type !== 'call_expression') return undefined;
  if (call.childForFieldName('function')?.type !== 'import') return undefined;
  return stringValue(call.childForFieldName('arguments')?.namedChild(0) ?? null);
}

/** `require('./store')`: the module a CommonJS require loads. */
function requiredModule(node: Node | null): string | undefined {
  if (node?.type !== 'call_expression') return undefined;
  if (node.childForFieldName('function')?.text !== 'require') return undefined;
  const arg = node.childForFieldName('arguments')?.namedChild(0) ?? null;
  return stringValue(arg);
}
