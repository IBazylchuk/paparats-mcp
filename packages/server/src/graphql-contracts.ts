import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import {
  Kind,
  parse,
  type DefinitionNode,
  type DocumentNode,
  type FieldDefinitionNode,
  type TypeNode,
} from 'graphql';
import { filterFilesByGitignore } from '@paparats/shared';
import { isTestPath } from './ranking.js';
import type { TreeSitterManager } from './tree-sitter-parser.js';

/** A document of a project holding operations or fragments, as written. */
export interface GraphqlDocument {
  file: string;
  /** 0-indexed line the document starts on in the file. */
  line: number;
  source: string;
}

/** A field of a schema type: the named type it returns, its line in the schema file, its arguments. */
export type SchemaField = [returns: string, line: number, args: string[]];

/** A schema read from an SDL file: what a client's selection walks over. */
export interface GraphqlSchemaTable {
  file: string;
  query: string;
  mutation: string;
  subscription: string;
  types: Record<string, Record<string, SchemaField>>;
  /** Per interface or union, the object types it may hold. */
  possible: Record<string, string[]>;
}

/** A graphql-ruby class or module: where each field it declares is and what answers it. */
export interface RubyGraphqlClass {
  /** Full path, `Mutations::Books::Lend`. */
  name: string;
  file: string;
  line: number;
  /** `graphql_name 'X'` when the class sets one. */
  graphqlName?: string;
  superclass?: string;
  /** `include`, `implements` and `Mixin.declare(self)`, as written, in order. */
  mixins: string[];
  fields: Array<{ name: string; line: number; target?: string; method?: string }>;
  /** Method name (a `def` or a `delegate`) → 0-indexed line. */
  methods: Record<string, number>;
}

export interface OperationUse {
  file: string;
  line: number;
}

/** What a project says about GraphQL, read from its files at each pass. */
export interface GraphqlFacts {
  documents: GraphqlDocument[];
  schemas: GraphqlSchemaTable[];
  classes: RubyGraphqlClass[];
  /** Words in source files that may name an operation → where first seen, per file. */
  uses: Record<string, OperationUse[]>;
  /** Per document file, the schema file the project's code generator reads it against. */
  documentSchemas?: Record<string, string>;
}

const IGNORED = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/__generated__/**',
  '**/*.generated.*',
  '**/*.d.ts',
];

const SOURCE_GLOBS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,rb,py}'];
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const namedType = (type: TypeNode): string =>
  type.kind === Kind.NAMED_TYPE ? type.name.value : namedType(type.type);

const isSchemaDefinition = (d: DefinitionNode): boolean =>
  d.kind === Kind.SCHEMA_DEFINITION ||
  d.kind === Kind.SCHEMA_EXTENSION ||
  d.kind === Kind.OBJECT_TYPE_DEFINITION ||
  d.kind === Kind.OBJECT_TYPE_EXTENSION ||
  d.kind === Kind.INTERFACE_TYPE_DEFINITION ||
  d.kind === Kind.INTERFACE_TYPE_EXTENSION ||
  d.kind === Kind.UNION_TYPE_DEFINITION ||
  d.kind === Kind.UNION_TYPE_EXTENSION ||
  d.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION ||
  d.kind === Kind.ENUM_TYPE_DEFINITION ||
  d.kind === Kind.SCALAR_TYPE_DEFINITION ||
  d.kind === Kind.DIRECTIVE_DEFINITION;

const lineOf = (node: { loc?: { startToken: { line: number } } | undefined }): number =>
  (node.loc?.startToken.line ?? 1) - 1;

/** The table of an SDL document: its object and interface types, roots and unions. */
export function schemaTable(file: string, doc: DocumentNode): GraphqlSchemaTable {
  const table: GraphqlSchemaTable = {
    file,
    query: 'Query',
    mutation: 'Mutation',
    subscription: 'Subscription',
    types: {},
    possible: {},
  };
  const addFields = (type: string, fields: readonly FieldDefinitionNode[] | undefined) => {
    const known = (table.types[type] ??= {});
    for (const f of fields ?? []) {
      known[f.name.value] = [
        namedType(f.type),
        lineOf(f),
        (f.arguments ?? []).map((a) => a.name.value),
      ];
    }
  };
  const addPossible = (holder: string, object: string) => {
    (table.possible[holder] ??= []).push(object);
  };
  for (const d of doc.definitions) {
    switch (d.kind) {
      case Kind.SCHEMA_DEFINITION:
      case Kind.SCHEMA_EXTENSION:
        for (const t of d.operationTypes ?? []) table[t.operation] = t.type.name.value;
        break;
      case Kind.OBJECT_TYPE_DEFINITION:
      case Kind.OBJECT_TYPE_EXTENSION:
        addFields(d.name.value, d.fields);
        for (const i of d.interfaces ?? []) addPossible(i.name.value, d.name.value);
        break;
      case Kind.INTERFACE_TYPE_DEFINITION:
      case Kind.INTERFACE_TYPE_EXTENSION:
        addFields(d.name.value, d.fields);
        break;
      case Kind.UNION_TYPE_DEFINITION:
      case Kind.UNION_TYPE_EXTENSION:
        for (const t of d.types ?? []) addPossible(d.name.value, t.name.value);
        break;
    }
  }
  return table;
}

/** A file's text parsed as GraphQL, or null when it is not valid. */
function parseGraphql(source: string): DocumentNode | null {
  try {
    return parse(source);
  } catch {
    return null;
  }
}

const isExecutable = (doc: DocumentNode): boolean =>
  doc.definitions.some(
    (d) => d.kind === Kind.OPERATION_DEFINITION || d.kind === Kind.FRAGMENT_DEFINITION
  );

/** The line of the file an offset is on, 0-indexed. */
const lineAt = (text: string, offset: number): number => {
  let line = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
};

/**
 * GraphQL written inside source code: template strings holding an operation or
 * a tagged fragment, Python's `gql("""...""")`, Ruby heredocs. Interpolations
 * are dropped (they name fragments, which the walk finds by spreads or misses);
 * what does not parse is not GraphQL.
 */
export function embeddedDocuments(file: string, text: string): GraphqlDocument[] {
  const found: GraphqlDocument[] = [];
  const add = (body: string, offset: number) => {
    const source = body.replace(/\$\{[^}]*\}/g, ' ');
    const doc = parseGraphql(source);
    if (doc && isExecutable(doc)) found.push({ file, line: lineAt(text, offset), source });
  };
  if (file.endsWith('.rb')) {
    for (const m of text.matchAll(
      /<<[~-]?['"]?([A-Z_]*(?:GRAPHQL|GQL|QUERY|MUTATION)[A-Z_]*)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/g
    )) {
      add(m[2]!, m.index);
    }
    return found;
  }
  if (file.endsWith('.py')) {
    for (const m of text.matchAll(/"""\s*((?:query|mutation|subscription|fragment)\b[\s\S]*?)"""/g))
      add(m[1]!, m.index);
    return found;
  }
  for (const m of text.matchAll(
    /(?:\b(gql|graphql)\s*(?:\(\s*)?)?`\s*((?:query|mutation|subscription|fragment|\{)[^`]*)`/g
  )) {
    // An untagged template is GraphQL only when it starts with an operation.
    if (!m[1] && !/^(query|mutation|subscription)\b/.test(m[2]!)) continue;
    add(m[2]!, m.index);
  }
  return found;
}

/** `tracked_jobs` → `trackedJobs`, as graphql-ruby names a field. */
export const camelField = (name: string): string =>
  name.replace(/_+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());

/** The name graphql-ruby gives a class without `graphql_name`: its last part without `Type`. */
export const defaultGraphqlName = (className: string): string =>
  (className.split('::').pop() ?? className).replace(/Type$/, '');

type RubyNode = {
  type: string;
  text: string;
  startPosition: { row: number };
  namedChildren: Array<RubyNode | null>;
  childForFieldName(name: string): RubyNode | null;
};

const symbolText = (node: RubyNode | null | undefined): string | undefined =>
  node?.type === 'simple_symbol' ? node.text.replace(/^:/, '') : undefined;

const stringText = (node: RubyNode | null | undefined): string | undefined => {
  if (node?.type !== 'string') return undefined;
  const content = node.namedChildren.filter((c) => c?.type === 'string_content');
  return content.length === 1 ? content[0]!.text : undefined;
};

/** The graphql-ruby classes and modules of a file, walked over its syntax tree. */
export function rubyGraphqlClasses(file: string, root: RubyNode): RubyGraphqlClass[] {
  const found: RubyGraphqlClass[] = [];
  const visit = (node: RubyNode, namespace: string, owner: RubyGraphqlClass | null) => {
    if (node.type === 'class' || node.type === 'module') {
      const name = node.childForFieldName('name')?.text.replace(/^::/, '') ?? '';
      const full = namespace !== '' ? `${namespace}::${name}` : name;
      const entry: RubyGraphqlClass = {
        name: full,
        file,
        line: node.startPosition.row,
        mixins: [],
        fields: [],
        methods: {},
      };
      const superclass = node.childForFieldName('superclass');
      const parent = superclass?.namedChildren.find((c) => c !== null)?.text;
      if (parent) entry.superclass = parent;
      found.push(entry);
      const body = node.childForFieldName('body');
      for (const child of body?.namedChildren ?? []) if (child) visit(child, full, entry);
      return;
    }
    if (owner && node.type === 'method') {
      const name = node.childForFieldName('name')?.text;
      if (name) owner.methods[name] = node.startPosition.row;
      return;
    }
    const receiver = node.type === 'call' ? node.childForFieldName('receiver') : null;
    if (owner && node.type === 'call') {
      const method = node.childForFieldName('method')?.text;
      const args = node.childForFieldName('arguments')?.namedChildren ?? [];
      const isConstant = (n: RubyNode | null | undefined) =>
        n?.type === 'constant' || n?.type === 'scope_resolution';
      if (receiver) {
        // `Mixin.declare(self)` hands the class to a module adding fields to it.
        if (isConstant(receiver) && args.some((a) => a?.type === 'self')) {
          owner.mixins.push(receiver.text);
        }
      } else if (method === 'graphql_name') {
        const value = stringText(args[0]);
        if (value) owner.graphqlName = value;
      } else if (method === 'include' || method === 'implements') {
        for (const a of args) if (a && isConstant(a)) owner.mixins.push(a.text);
      } else if (method === 'delegate') {
        for (const a of args) {
          const name = symbolText(a);
          if (name) owner.methods[name] = node.startPosition.row;
        }
      }
      // `base.field :x, ...` is a field a mixin adds to the class including it.
      if (method === 'field' && (!receiver || receiver.type === 'identifier')) {
        const name = symbolText(args[0]);
        if (name) {
          const field: RubyGraphqlClass['fields'][number] = {
            name: camelField(name),
            line: node.startPosition.row,
          };
          let camelize = true;
          for (const a of args) {
            if (a?.type !== 'pair') continue;
            const key = a.childForFieldName('key')?.text;
            const value = a.childForFieldName('value');
            if (key === 'resolver' || key === 'mutation' || key === 'subscription') {
              if (value) field.target = value.text;
            } else if (key === 'resolver_method') {
              const m = symbolText(value);
              if (m) field.method = m;
            } else if (key === 'camelize' && value?.text === 'false') {
              camelize = false;
            }
          }
          if (!camelize) field.name = name;
          field.method ??= name;
          owner.fields.push(field);
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child, namespace, owner);
  };
  visit(root, '', null);
  return found;
}

const USE_WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
/** An operation run by its name: `run('FindBooks')`. */
const QUOTED_WORD = /['"`]([A-Z][A-Za-z0-9_]{3,})['"`]/g;
/** A document file named from code: `import doc from './x.graphql'`, `load('operations.graphql')`. */
const QUOTED_DOCUMENT_FILE = /['"`]([\w./-]+\.(?:graphql|gql))['"`]/g;
/** Key in {@link GraphqlFacts.uses} of the code naming a document file. */
export const FILE_USE = 'file:';
/** Names the code generators give an operation: `XDocument`, `useXQuery`, `useXLazyQuery`, ... */
const GENERATED_USE =
  /^(?:use)?([A-Z][A-Za-z0-9_]*?)(?:Document|SuspenseQuery|LazyQuery|Query|Mutation|Subscription)$/;

/** The operation a generated name stands for, or null. */
export function generatedOperationName(word: string): string | null {
  return GENERATED_USE.exec(word)?.[1] ?? null;
}

/**
 * What a project says about GraphQL. A pass reads `.graphql` / `.gql` files and
 * source files apart from the index: search stays as it is, and nothing here
 * needs an embedding. Null when the directory is not there.
 */
export async function readGraphqlFacts(
  root: string,
  treeSitter: TreeSitterManager | null,
  exclude: readonly string[] = []
): Promise<GraphqlFacts | null> {
  if (!fs.existsSync(root)) return null;
  // What the project excludes stays out, except its tests: Ruby projects leave
  // `spec/` out of the index, and a spec's operations show what it reaches.
  const list = (patterns: string[]): string[] => {
    const found = (ignore: string[]) =>
      globSync(patterns, { cwd: root, ignore, nodir: true, absolute: true });
    const kept = new Set(found([...IGNORED, ...exclude]));
    for (const file of found(IGNORED)) {
      if (isTestPath(path.relative(root, file))) kept.add(file);
    }
    return filterFilesByGitignore([...kept], root).sort();
  };
  const facts: GraphqlFacts = { documents: [], schemas: [], classes: [], uses: {} };

  // Parts of one schema (no root type of their own) join every schema of the project.
  const parts: GraphqlSchemaTable[] = [];
  for (const abs of list(['**/*.{graphql,gql,graphqls}'])) {
    const file = path.relative(root, abs);
    const source = fs.readFileSync(abs, 'utf8');
    const doc = parseGraphql(source);
    if (!doc) continue;
    if (isExecutable(doc)) facts.documents.push({ file, line: 0, source });
    if (!doc.definitions.some(isSchemaDefinition)) continue;
    const table = schemaTable(file, doc);
    const hasRoot =
      table.types[table.query] !== undefined || table.types[table.mutation] !== undefined;
    (hasRoot ? facts.schemas : parts).push(table);
  }
  for (const part of parts) {
    if (facts.schemas.length === 0) {
      facts.schemas.push(part);
      continue;
    }
    for (const schema of facts.schemas) {
      for (const [type, fields] of Object.entries(part.types)) {
        schema.types[type] = { ...schema.types[type], ...fields };
      }
      for (const [holder, objects] of Object.entries(part.possible)) {
        (schema.possible[holder] ??= []).push(...objects);
      }
    }
  }

  const configs = list([
    '**/codegen*.{ts,js,mjs,cjs,yml,yaml}',
    '**/.graphqlrc*',
    '**/graphql.config.*',
  ]);
  if (configs.length > 0 && facts.documents.length > 0) {
    facts.documentSchemas = documentSchemasOf(
      root,
      configs.map((f) => ({ file: path.relative(root, f), text: fs.readFileSync(f, 'utf8') })),
      new Set(facts.documents.map((d) => d.file))
    );
  }

  const sources = list(SOURCE_GLOBS);
  const usesGraphqlRuby =
    treeSitter?.isAvailable('ruby') === true &&
    list(['**/Gemfile', '**/*.gemspec']).some((f) =>
      /\bgraphql\b/.test(fs.readFileSync(f, 'utf8'))
    );
  const readSource = (abs: string): string | null => {
    try {
      return fs.statSync(abs).size > MAX_SOURCE_BYTES ? null : fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  for (const abs of sources) {
    const text = readSource(abs);
    if (text === null) continue;
    const file = path.relative(root, abs);
    if (/query|mutation|subscription|fragment|gql/i.test(text)) {
      facts.documents.push(...embeddedDocuments(file, text));
    }
    if (
      usesGraphqlRuby &&
      file.endsWith('.rb') &&
      (file.includes('graphql') || /\b(?:field\s+:|graphql_name\b|def resolve\b)/.test(text))
    ) {
      const parsed = await treeSitter!.parseFile(text, 'ruby');
      if (parsed) {
        facts.classes.push(
          ...rubyGraphqlClasses(file, parsed.tree.rootNode as unknown as RubyNode)
        );
        parsed.tree.delete();
      }
    }
  }

  // Which files use the operations, now that their names are known.
  const operations = operationNames(facts.documents);
  if (operations.size === 0) return facts;
  const documentFiles = new Set(facts.documents.map((d) => d.file));
  for (const abs of sources) {
    const text = readSource(abs);
    if (text === null) continue;
    const file = path.relative(root, abs);
    const seen = new Set<string>();
    const note = (name: string, offset: number) => {
      if (seen.has(name)) return;
      seen.add(name);
      (facts.uses[name] ??= []).push({ file, line: lineAt(text, offset) });
    };
    if (/\.[jt]sx?$|\.[mc]js$/.test(file)) {
      for (const m of text.matchAll(USE_WORD)) {
        const name = generatedOperationName(m[0]);
        if (name !== null && operations.has(name)) note(name, m.index);
      }
    }
    for (const m of text.matchAll(QUOTED_WORD)) {
      if (operations.has(m[1]!)) note(m[1]!, m.index);
    }
    for (const m of text.matchAll(QUOTED_DOCUMENT_FILE)) {
      const ref = path.normalize(path.join(path.dirname(file), m[1]!));
      if (documentFiles.has(ref)) note(`${FILE_USE}${ref}`, m.index);
    }
  }
  return facts;
}

const QUOTED_TEXT = /['"]([^'"\n]+)['"]/g;

/**
 * Which schema each document is read against, as a graphql-codegen config says:
 * `schema` and `documents`, written as plain strings. With several configs a
 * document goes to the one listing the fewest: the narrower scope.
 */
export function documentSchemasOf(
  root: string,
  configs: ReadonlyArray<{ file: string; text: string }>,
  files: ReadonlySet<string>
): Record<string, string> {
  const scopes: Array<{ schema: string; documents: string[] }> = [];
  for (const { file, text } of configs) {
    const schema = /\bschema["']?\s*:\s*['"]([^'"\n]+\.(?:graphql|gql|graphqls))['"]/.exec(
      text
    )?.[1];
    // A list of strings, which may hold brackets themselves (`src/[(]app[)]/**`), and comments.
    const listed =
      /\bdocuments["']?\s*:\s*(\[(?:\s|,|\/\/[^\n]*|'[^'\n]*'|"[^"\n]*")*\]|['"][^'"\n]+['"])/.exec(
        text
      )?.[1];
    if (!schema || !listed) continue;
    const dir = path.dirname(file);
    const patterns = [...listed.replace(/\/\/[^\n]*/g, '').matchAll(QUOTED_TEXT)].map((m) => m[1]!);
    const within = (p: string) => path.posix.join(dir, p);
    const documents = globSync(patterns.filter((p) => !p.startsWith('!')).map(within), {
      cwd: root,
      nodir: true,
      ignore: patterns.filter((p) => p.startsWith('!')).map((p) => within(p.slice(1))),
    }).filter((f) => files.has(f));
    scopes.push({ schema: path.posix.join(dir, schema), documents });
  }
  const out: Record<string, string> = {};
  scopes.sort((a, b) => b.documents.length - a.documents.length);
  for (const { schema, documents } of scopes) {
    for (const file of documents) out[file] = schema;
  }
  return out;
}

/** The names of the operations in some documents. */
export function operationNames(documents: readonly GraphqlDocument[]): Set<string> {
  const names = new Set<string>();
  for (const d of documents) {
    const doc = parseGraphql(d.source);
    for (const def of doc?.definitions ?? []) {
      if (def.kind === Kind.OPERATION_DEFINITION && def.name) names.add(def.name.value);
    }
  }
  return names;
}
