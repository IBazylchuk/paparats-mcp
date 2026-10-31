import path from 'node:path';
import {
  Kind,
  parse,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import type { MetadataStore } from './metadata-db.js';
import {
  camelField,
  defaultGraphqlName,
  FILE_USE,
  type GraphqlFacts,
  type GraphqlSchemaTable,
  type OperationUse,
  type RubyGraphqlClass,
  type SchemaField,
} from './graphql-contracts.js';
import { isTestPath } from './ranking.js';

/** An operation a project sends. */
export interface ApiOperation {
  project: string;
  name: string;
  kind: 'query' | 'mutation' | 'subscription';
  file: string;
  /** 0-indexed. */
  line: number;
  test: boolean;
  /** Where the project's code uses it, its own file left out. */
  usedIn: OperationUse[];
}

/** The code answering a field of the API. */
export interface ApiProvider {
  project: string;
  file: string;
  /** 0-indexed line of what answers the field: a resolver's `resolve`, the field's method or its declaration. */
  line: number;
  /** `Mutations::Books::Lend#resolve`, `Types::Book#author`; the schema's own line has none. */
  symbol?: string;
  /** Method answering the field, for matching what a change reaches. */
  method?: string;
  /** Where the field is declared, when elsewhere (`field :lend, mutation: Lend`). */
  declaredAt?: { file: string; line: number };
}

/** An operation selecting a field of the API, and the code answering it. */
export interface ApiLink {
  operation: ApiOperation;
  /** `Type.field`. */
  field: string;
  provider: ApiProvider;
  /** False when part of the operation did not fit the schema it was read against. */
  certain: boolean;
}

export interface GroupContracts {
  links: ApiLink[];
  /** Operations no schema of the group fits. */
  unmatched: ApiOperation[];
  /** Selected fields no code was found for. */
  fieldsWithoutCode: string[];
}

interface Walked {
  fields: Set<string>;
  missing: number;
}

const ROOT_OF = { query: 'query', mutation: 'mutation', subscription: 'subscription' } as const;

/** The `Type.field`s an operation selects under a schema, through fragments and unions. */
function walkOperation(
  root: string,
  selection: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  schema: GraphqlSchemaTable
): Walked {
  const fields = new Set<string>();
  let missing = 0;
  const seen = new Set<string>();
  const fieldOn = (type: string, name: string): [string, SchemaField] | null => {
    const own = schema.types[type]?.[name];
    if (own) return [type, own];
    for (const object of schema.possible[type] ?? []) {
      const held = schema.types[object]?.[name];
      if (held) return [object, held];
    }
    return null;
  };
  const visit = (set: SelectionSetNode, type: string) => {
    for (const s of set.selections) {
      if (s.kind === Kind.FIELD) {
        const name = s.name.value;
        if (name.startsWith('__')) continue;
        const found = fieldOn(type, name);
        if (!found) {
          missing++;
          continue;
        }
        const args = found[1][2];
        for (const a of s.arguments ?? []) if (!args.includes(a.name.value)) missing++;
        fields.add(`${found[0]}.${name}`);
        if (s.selectionSet) visit(s.selectionSet, found[1][0]);
      } else if (s.kind === Kind.INLINE_FRAGMENT) {
        visit(s.selectionSet, s.typeCondition?.name.value ?? type);
      } else {
        const fragment = fragments.get(s.name.value);
        if (!fragment) {
          missing++;
          continue;
        }
        const on = fragment.typeCondition.name.value;
        const key = `${fragment.name.value}\0${on}`;
        if (seen.has(key)) continue;
        seen.add(key);
        visit(fragment.selectionSet, on);
      }
    }
  };
  visit(selection, root);
  return { fields, missing };
}

/**
 * The code answering each field of the API, per project: a class named as the
 * schema names the type, the field found on it or up its parents. `field :x,
 * resolver: R` is answered by `R#resolve`, else by the method named after the
 * field, else by its declaration.
 */
class RubyProviders {
  /** Per full path, the class in each file that opens it. */
  private byPath = new Map<string, RubyGraphqlClass[]>();
  private byName = new Map<string, RubyGraphqlClass[]>();

  constructor(
    private readonly project: string,
    classes: readonly RubyGraphqlClass[]
  ) {
    for (const c of classes) {
      const opened = this.byPath.get(c.name) ?? [];
      opened.push(c);
      this.byPath.set(c.name, opened);
    }
    for (const c of classes) {
      if (c.graphqlName === undefined && this.byPath.get(c.name)![0] !== c) continue;
      const name = c.graphqlName ?? defaultGraphqlName(c.name);
      const list = this.byName.get(name) ?? [];
      list.push(c);
      this.byName.set(name, list);
    }
  }

  /** Ruby's lookup of a constant written in `from`: its namespaces inside out, then the top. */
  private resolve(name: string, from: string): RubyGraphqlClass | undefined {
    if (name.startsWith('::')) return this.byPath.get(name.slice(2))?.[0];
    const parts = from.split('::');
    for (let i = parts.length; i >= 0; i--) {
      const found = this.byPath.get([...parts.slice(0, i), name].join('::'));
      if (found) return found[0];
    }
    return undefined;
  }

  /** Ruby's method lookup: a class, wherever opened, its mixins from the last one up, then its superclass. */
  private ancestry(c: RubyGraphqlClass): RubyGraphqlClass[] {
    const out: RubyGraphqlClass[] = [];
    const seen = new Set<string>();
    const visit = (at: RubyGraphqlClass) => {
      if (seen.has(at.name)) return;
      seen.add(at.name);
      const opened = this.byPath.get(at.name) ?? [at];
      out.push(...opened);
      for (const o of opened) {
        for (const m of [...o.mixins].reverse()) {
          const mixin = this.resolve(m, o.name);
          if (mixin) visit(mixin);
        }
      }
      for (const o of opened) {
        const parent = o.superclass && this.resolve(o.superclass, o.name);
        if (parent) visit(parent);
      }
    };
    visit(c);
    return out;
  }

  /** The fields a class has, inherited and mixed in. */
  private fieldNames(c: RubyGraphqlClass): Set<string> {
    return new Set(this.ancestry(c).flatMap((at) => at.fields.map((f) => f.name)));
  }

  /**
   * The class of a schema type. Classes of two schemas may share a type name
   * (each nested in its own namespace, unnamed): the one whose fields are most
   * like the type's in the schema read.
   */
  private classesOf(type: string, schemaFields: readonly string[]): RubyGraphqlClass[] {
    // A mutation's own fields live on the payload type graphql-ruby makes for it.
    const named =
      this.byName.get(type) ??
      (type.endsWith('Payload') ? this.byName.get(type.slice(0, -'Payload'.length)) : undefined) ??
      [];
    if (named.length < 2) return named;
    const likeness = (c: RubyGraphqlClass): number => {
      const own = this.fieldNames(c);
      const shared = schemaFields.filter((f) => own.has(f)).length;
      return shared / (own.size + schemaFields.length - shared || 1);
    };
    return named
      .map((c) => ({ c, score: likeness(c) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }

  private methodLine(c: RubyGraphqlClass, method: string): [RubyGraphqlClass, number] | null {
    for (const at of this.ancestry(c)) {
      const line = at.methods[method];
      if (line !== undefined) return [at, line];
    }
    return null;
  }

  find(type: string, field: string, schemaFields: readonly string[]): ApiProvider | null {
    for (const c of this.classesOf(type, schemaFields)) {
      for (const at of this.ancestry(c)) {
        const declared = at.fields.find((f) => f.name === field);
        if (!declared) continue;
        const declaredAt = { file: at.file, line: declared.line };
        if (declared.target) {
          const target = this.resolve(declared.target, at.name);
          const resolved = target && this.methodLine(target, 'resolve');
          if (target && resolved) {
            return {
              project: this.project,
              file: resolved[0].file,
              line: resolved[1],
              symbol: `${resolved[0].name}#resolve`,
              method: 'resolve',
              declaredAt,
            };
          }
          if (target) {
            return {
              project: this.project,
              file: target.file,
              line: target.line,
              symbol: target.name,
              declaredAt,
            };
          }
        }
        const method = declared.method && this.methodLine(c, declared.method);
        if (method) {
          return {
            project: this.project,
            file: method[0].file,
            line: method[1],
            symbol: `${method[0].name}#${declared.method}`,
            method: declared.method!,
            declaredAt,
          };
        }
        return { project: this.project, ...declaredAt, symbol: `${at.name}.${field}` };
      }
    }
    return null;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const FIELDS_SHOWN = 10;
const OPERATIONS_SHOWN = 6;
const USES_SHOWN = 3;
const TEST_FILES_SHOWN = 12;

/** Code a question is about: lines of a file, and the methods there when known. */
export interface CodeSpot {
  project: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Only fields answered by these methods; unset for a whole chunk, declarations included. */
  methods?: string[];
  /** Steps from the change; 0 for the changed chunk itself. */
  step: number;
  /** Only this name: the method answering a field, or the field. */
  name?: string;
}

const spotHolds = (spot: CodeSpot, link: ApiLink): boolean => {
  const p = link.provider;
  if (p.project !== spot.project) return false;
  if (spot.name !== undefined) {
    const field = link.field.split('.')[1];
    if (p.method !== spot.name && field !== camelField(spot.name)) return false;
  }
  const inside = (at: { file: string; line: number }) =>
    at.file === spot.file && at.line >= spot.startLine && at.line <= spot.endLine;
  if (spot.methods) return inside(p) && p.method !== undefined && spot.methods.includes(p.method);
  return inside(p) || (p.declaredAt !== undefined && inside(p.declaredAt));
};

export interface ApiImpact {
  /** The section on operations reaching the code; empty when there are none. */
  text: string;
  /** The section on tests reaching it through the API; empty when there are none. */
  tests: string;
}

const usesText = (op: ApiOperation): string => {
  const shown = op.usedIn
    .slice(0, USES_SHOWN)
    .map((u) => `\`${u.file}:${u.line + 1}\``)
    .join(', ');
  const more = op.usedIn.length > USES_SHOWN ? ` (+${op.usedIn.length - USES_SHOWN} more)` : '';
  return shown !== '' ? `; used in ${shown}${more}` : '';
};

/** What `change_impact` and `find_usages` add: the operations reaching code through the API. */
export function apiImpact(contracts: GroupContracts, spots: readonly CodeSpot[]): ApiImpact {
  const empty = { text: '', tests: '' };
  if (contracts.links.length === 0 || spots.length === 0) return empty;
  interface Reached {
    field: string;
    provider: ApiProvider;
    step: number;
    ops: Map<string, { op: ApiOperation; certain: boolean }>;
  }
  const reached = new Map<string, Reached>();
  const tests = new Set<string>();
  for (const link of contracts.links) {
    const spot = spots.filter((s) => spotHolds(s, link)).sort((a, b) => a.step - b.step)[0];
    if (!spot) continue;
    if (link.operation.test) {
      tests.add(`[${link.operation.project}] ${link.operation.file}`);
      continue;
    }
    const key = `${link.field}\0${link.provider.file}\0${link.provider.line}`;
    const entry = reached.get(key) ?? {
      field: link.field,
      provider: link.provider,
      step: spot.step,
      ops: new Map(),
    };
    entry.ops.set(`${link.operation.project}\0${link.operation.file}\0${link.operation.name}`, {
      op: link.operation,
      certain: link.certain,
    });
    reached.set(key, entry);
  }
  let testsText = '';
  if (tests.size > 0) {
    const files = [...tests].sort();
    testsText = `\n### Tests through the API (${plural(files.length, 'file', 'files')}) — they send an operation reaching it\n\n`;
    testsText += files
      .slice(0, TEST_FILES_SHOWN)
      .map((t) => `- ${t}\n`)
      .join('');
    if (files.length > TEST_FILES_SHOWN)
      testsText += `- … and ${files.length - TEST_FILES_SHOWN} more\n`;
  }
  if (reached.size === 0) return { text: '', tests: testsText };

  const allOps = new Map<string, ApiOperation>();
  for (const r of reached.values()) for (const [k, v] of r.ops) allOps.set(k, v.op);
  const files = new Set([...allOps.values()].map((o) => `${o.project}\0${o.file}`));
  const projects = new Set([...allOps.values()].map((o) => o.project));
  let text = `\n### Through the API (${plural(allOps.size, 'operation', 'operations')} in ${plural(files.size, 'file', 'files')} of ${[...projects].map((p) => `\`${p}\``).join(', ')}) — these send requests reaching it; the call graph does not show them\n\n`;
  // Resolvers first: a change there is what the operation asks for, not one field of its answer.
  const order = [...reached.values()].sort(
    (a, b) =>
      Number(b.provider.method === 'resolve') - Number(a.provider.method === 'resolve') ||
      a.step - b.step ||
      b.ops.size - a.ops.size ||
      a.field.localeCompare(b.field)
  );
  for (const r of order.slice(0, FIELDS_SHOWN)) {
    const by = r.provider.symbol ? `, answered by \`${r.provider.symbol}\`` : '';
    const away = r.step === 0 ? '' : `, ${plural(r.step, 'step', 'steps')} from the change`;
    text += `GraphQL \`${r.field}\`${by}${away}:\n`;
    const ops = [...r.ops.values()].sort(
      (a, b) => a.op.project.localeCompare(b.op.project) || a.op.file.localeCompare(b.op.file)
    );
    for (const { op, certain } of ops.slice(0, OPERATIONS_SHOWN)) {
      text += `- **[${op.project}] ${op.file}:${op.line + 1}** ${op.kind} \`${op.name}\`${usesText(op)}${certain ? '' : ' [maybe]'}\n`;
    }
    if (ops.length > OPERATIONS_SHOWN) {
      text += `- … and ${ops.length - OPERATIONS_SHOWN} more operations\n`;
    }
    text += '\n';
  }
  if (order.length > FIELDS_SHOWN) {
    text += `… and ${plural(order.length - FIELDS_SHOWN, 'more field', 'more fields')}. Pass \`symbol\` to ask about one.\n`;
  }
  if (order.some((r) => [...r.ops.values()].some((o) => !o.certain))) {
    text +=
      '_`[maybe]` — part of the operation does not fit the schema, or several schemas fit it equally and name different code._\n';
  }
  return { text, tests: testsText };
}

const FIELDS_PER_CALL = 8;

/** What `find_usages` adds for a chunk sending an operation: the server code answering it. */
export function apiCalls(
  contracts: GroupContracts,
  chunk: { project: string; file: string; startLine: number; endLine: number; content: string }
): string {
  const sends = (op: ApiOperation): boolean => {
    if (op.project !== chunk.project) return false;
    if (op.file === chunk.file) return op.line >= chunk.startLine && op.line <= chunk.endLine;
    return op.usedIn.some((u) => u.file === chunk.file) && chunk.content.includes(op.name);
  };
  const byOperation = new Map<string, { op: ApiOperation; links: ApiLink[] }>();
  for (const link of contracts.links) {
    if (link.provider.method === undefined || !sends(link.operation)) continue;
    const key = `${link.operation.file}\0${link.operation.name}`;
    const entry = byOperation.get(key) ?? { op: link.operation, links: [] };
    entry.links.push(link);
    byOperation.set(key, entry);
  }
  if (byOperation.size === 0) return '';
  let text = `### Through the API (${plural(byOperation.size, 'operation', 'operations')}) — the server code answering what this chunk sends\n\n`;
  for (const { op, links } of byOperation.values()) {
    text += `${op.kind} \`${op.name}\` (${op.file}:${op.line + 1}):\n`;
    const order = links.sort(
      (a, b) =>
        Number(b.provider.method === 'resolve') - Number(a.provider.method === 'resolve') ||
        a.field.localeCompare(b.field)
    );
    for (const l of order.slice(0, FIELDS_PER_CALL)) {
      const p = l.provider;
      text += `- \`${l.field}\` — **[${p.project}] ${p.file}:${p.line + 1}** \`${p.symbol ?? ''}\`${l.certain ? '' : ' [maybe]'}\n`;
    }
    if (order.length > FIELDS_PER_CALL) text += `- … and ${order.length - FIELDS_PER_CALL} more\n`;
    text += '\n';
  }
  return text;
}

/** Wrappers every operation under a namespace passes through say nothing about what it does. */
const isNamespaceRoot = (symbol: string | undefined): boolean =>
  symbol !== undefined && /(?:^|::)Root#resolve$/.test(symbol);

const TOP_ANSWERS = 5;

/**
 * What `module_map` adds: which project calls whose API, through what. `project`
 * keeps only the links of that project; `show` is how a project is named.
 */
export function repositoryLinks(
  contracts: GroupContracts,
  opts: { project?: string | undefined; show: (project: string) => string; diagram: boolean }
): string {
  interface Pair {
    from: string;
    to: string;
    ops: Set<string>;
    files: Set<string>;
    fields: Set<string>;
    answers: Map<string, Set<string>>;
  }
  const pairs = new Map<string, Pair>();
  for (const l of contracts.links) {
    const from = l.operation.project;
    const to = l.provider.project;
    if (from === to || l.operation.test) continue;
    if (opts.project !== undefined && from !== opts.project && to !== opts.project) continue;
    const key = `${from}\0${to}`;
    const pair = pairs.get(key) ?? {
      from,
      to,
      ops: new Set(),
      files: new Set(),
      fields: new Set(),
      answers: new Map(),
    };
    const op = `${l.operation.file}\0${l.operation.name}`;
    pair.ops.add(op);
    pair.files.add(l.operation.file);
    pair.fields.add(l.field);
    if (l.certain && l.provider.method === 'resolve' && !isNamespaceRoot(l.provider.symbol)) {
      const name = l.provider.symbol!;
      const held = pair.answers.get(name) ?? new Set<string>();
      held.add(op);
      pair.answers.set(name, held);
    }
    pairs.set(key, pair);
  }
  if (pairs.size === 0) return '';
  let text =
    '\n### Repositories — who calls whose API\n\nFrom the GraphQL operations each project sends, read against the schemas and matched to the code answering them. REST, queues and shared configuration are not in this list.\n\n';
  const order = [...pairs.values()].sort((a, b) => b.ops.size - a.ops.size);
  for (const p of order) {
    text += `- **\`${opts.show(p.from)}\` → \`${opts.show(p.to)}\`**: GraphQL, ${plural(p.ops.size, 'operation', 'operations')} in ${plural(p.files.size, 'file', 'files')}, ${plural(p.fields.size, 'field', 'fields')}.`;
    const top = [...p.answers]
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
      .slice(0, TOP_ANSWERS)
      .map(([name, ops]) => `\`${name}\` (${ops.size})`);
    if (top.length > 0) text += ` Most used: ${top.join(', ')}.`;
    text += '\n';
  }
  const unmatched = contracts.unmatched.filter(
    (o) => !o.test && (opts.project === undefined || o.project === opts.project)
  );
  if (unmatched.length > 0) {
    text += `\n${plural(unmatched.length, 'operation fits', 'operations fit')} no schema indexed here: they go to an outside API, or are out of date.\n`;
  }
  if (opts.diagram) {
    const ids = new Map<string, string>();
    const id = (name: string) => {
      if (!ids.has(name)) ids.set(name, `r${ids.size + 1}`);
      return ids.get(name)!;
    };
    const lines = order.map((p) => `  ${id(p.from)} -->|GraphQL| ${id(p.to)}`);
    const nodes = [...ids].map(([name, r]) => `  ${r}["${opts.show(name)}"]`);
    text += `\n\`\`\`mermaid\nflowchart LR\n${[...nodes, ...lines].join('\n')}\n\`\`\`\n`;
  }
  return text;
}

type ApiFactsStore = Pick<MetadataStore, 'apiFactsVersion' | 'getApiFacts'>;

/** A group's links between projects, worked out again when a project records something new. */
export class ApiContractsService {
  private cache = new Map<string, { version: string; contracts: GroupContracts }>();

  constructor(private readonly store: ApiFactsStore) {}

  get(group: string): GroupContracts {
    const version = this.store.apiFactsVersion(group);
    const cached = this.cache.get(group);
    if (cached && cached.version === version) return cached.contracts;
    const contracts = linkContracts(this.store.getApiFacts(group));
    this.cache.set(group, { version, contracts });
    return contracts;
  }
}

/** The links between projects a server scoped to some projects may show. */
export function visibleContracts(
  contracts: GroupContracts,
  allows: (project: string) => boolean
): GroupContracts {
  return {
    links: contracts.links.filter((l) => allows(l.operation.project) && allows(l.provider.project)),
    unmatched: contracts.unmatched.filter((o) => allows(o.project)),
    fieldsWithoutCode: contracts.fieldsWithoutCode,
  };
}

const parseDocument = (source: string): DocumentNode | null => {
  try {
    return parse(source);
  } catch {
    return null;
  }
};

/**
 * Who calls whom across a group's projects: each project's operations read
 * against the group's schemas, and each selected field joined to the code
 * answering it. Worked out from what the projects recorded, so a pass over one
 * project never leaves links to another out of date.
 */
export function linkContracts(projects: ReadonlyArray<[string, GraphqlFacts]>): GroupContracts {
  const schemas: Array<{
    project: string;
    table: GraphqlSchemaTable;
    /** Per project holding a copy, the copy's file. */
    holders: Map<string, string>;
  }> = [];
  const seenSchemas = new Map<string, (typeof schemas)[number]>();
  for (const [project, facts] of projects) {
    for (const table of facts.schemas) {
      const key = JSON.stringify([table.query, table.mutation, table.types]);
      // Copies of a schema in client and server count once.
      const known = seenSchemas.get(key);
      if (known) {
        known.holders.set(project, table.file);
        continue;
      }
      const schema = { project, table, holders: new Map([[project, table.file]]) };
      seenSchemas.set(key, schema);
      schemas.push(schema);
    }
  }
  const providers = projects
    .filter(([, facts]) => facts.classes.length > 0)
    .map(([project, facts]) => new RubyProviders(project, facts.classes));

  const links: ApiLink[] = [];
  const unmatched: ApiOperation[] = [];
  const without = new Set<string>();
  const found = new Map<string, ApiProvider[]>();
  const answering = (
    field: string,
    schema: { project: string; table: GraphqlSchemaTable },
    consumer: string
  ): ApiProvider[] => {
    const key = `${schema.table.file}\0${schema.project}\0${field}`;
    const known = found.get(key);
    if (known) return known;
    const [type = '', name = ''] = field.split('.');
    const schemaFields = Object.keys(schema.table.types[type] ?? {});
    const answers = providers
      .map((p) => p.find(type, name, schemaFields))
      .filter((p): p is ApiProvider => p !== null);
    if (answers.length === 0) {
      // No code of the field found: the schema of a project serving it says where it is.
      const at = schema.table.types[type]?.[name];
      if (at && schema.project !== consumer) {
        answers.push({ project: schema.project, file: schema.table.file, line: at[1] });
      }
    }
    found.set(key, answers);
    return answers;
  };

  for (const [project, facts] of projects) {
    const parsed = facts.documents
      .map((d) => ({ d, doc: parseDocument(d.source) }))
      .filter((p): p is { d: (typeof p)['d']; doc: DocumentNode } => p.doc !== null);
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const { doc } of parsed) {
      for (const def of doc.definitions) {
        if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
      }
    }
    for (const { d, doc } of parsed) {
      for (const def of doc.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        const name = def.name?.value ?? path.basename(d.file);
        const byName = def.name ? (facts.uses[name] ?? []) : [];
        const byFile = facts.uses[`${FILE_USE}${d.file}`] ?? [];
        const usedIn = [...byName, ...byFile].filter((u) => u.file !== d.file);
        const operation: ApiOperation = {
          project,
          name,
          kind: def.operation as ApiOperation['kind'],
          file: d.file,
          line: d.line + (def.loc?.startToken.line ?? 1) - 1,
          test: isTestPath(d.file),
          usedIn: [...new Map(usedIn.map((u) => [u.file, u])).values()],
        };
        // The schemas the operation fits best: more than one when nothing in it tells them apart.
        let best: Array<{ schema: (typeof schemas)[number]; walked: Walked }> = [];
        // The schema the project's code generator reads this file against, when it says.
        const stated = facts.documentSchemas?.[d.file];
        const named = schemas.filter((s) => stated && s.holders.get(project) === stated);
        for (const schema of named.length > 0 ? named : schemas) {
          const root = schema.table[ROOT_OF[operation.kind]];
          if (!schema.table.types[root]) continue;
          const walked = walkOperation(root, def.selectionSet, fragments, schema.table);
          const top = best[0]?.walked;
          if (
            !top ||
            walked.missing < top.missing ||
            (walked.missing === top.missing && walked.fields.size > top.fields.size)
          ) {
            best = [{ schema, walked }];
          } else if (walked.missing === top.missing && walked.fields.size === top.fields.size) {
            best.push({ schema, walked });
          }
        }
        // Of schemas fitting alike, a client generates its code from those it holds a copy of.
        const held = best.filter((b) => b.schema.holders.has(project));
        if (held.length > 0) best = held;
        const top = best[0]?.walked;
        // Of an operation mostly outside a schema, what fits is chance.
        if (!top || top.fields.size === 0 || top.missing > top.fields.size) {
          unmatched.push(operation);
          continue;
        }
        const perField = new Map<string, Map<string, ApiProvider>>();
        for (const { schema, walked } of best) {
          for (const field of walked.fields) {
            const answers = answering(field, schema, project);
            if (answers.length === 0) without.add(field);
            const held = perField.get(field) ?? new Map<string, ApiProvider>();
            for (const a of answers) held.set(`${a.project}\0${a.file}\0${a.line}`, a);
            perField.set(field, held);
          }
        }
        for (const [field, held] of perField) {
          for (const provider of held.values()) {
            links.push({
              operation,
              field,
              provider,
              certain: top.missing === 0 && held.size === 1,
            });
          }
        }
      }
    }
  }
  return { links, unmatched, fieldsWithoutCode: [...without].sort() };
}
