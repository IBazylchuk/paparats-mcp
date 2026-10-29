import type { NameUsage, SymbolEdge } from './types.js';
import {
  collectDependents,
  definitionLine,
  MAX_IMPACT_DEPTH,
  type Dependent,
} from './change-impact.js';
import { parseChunkId } from './indexer.js';
import { conventionalTestPaths, isTestPath } from './ranking.js';
import { innerReach, isCommonName } from './symbol-graph.js';
import { testsNamedAfter } from './test-files.js';

/** Chunks store 0-indexed lines; output shows them 1-indexed, as editors and grep do. */
export const shownLine = (line: number): number => line + 1;

/** What `changeImpactReport()` reads: the server's index and metadata store, or a graph held in memory. */
export interface ChangeImpactSource {
  /** A chunk's payload (`project`, `file`, `startLine`, `content`, `symbol_name`, ...), or null. */
  getChunk(chunkId: string): Promise<Record<string, unknown> | null>;
  /** The ids of every chunk of a file. */
  fileChunkIds(group: string, project: string, file: string): Promise<string[]>;
  /** Incoming edges of a chunk, already limited to what may be shown. */
  edgesTo(chunkId: string): SymbolEdge[];
  /** Edges made from a file's chunks. */
  edgesFromFile(group: string, project: string, file: string): SymbolEdge[];
  /** Chunks called from so many places that their callers are not followed. */
  hubs(group: string): Set<string>;
  names(group: string): NameUsage;
  /** The project's test files when recorded, else null. */
  testFiles(group: string, project: string): string[] | null;
}

export interface ChangeImpactArgs {
  chunkId: string;
  /** The changed chunk's payload. */
  payload: Record<string, unknown>;
  wholeFile: boolean;
  symbol?: string | undefined;
  depth: number;
  limit: number;
}

/**
 * How a caller is named in `find_usages` and `change_impact`: the methods that
 * make the call when the edge records them, else the chunk's first symbol.
 */
export function callerLabel(callers: string[], payload: Record<string, unknown>): string {
  if (callers.length > 0) return ` ${callers.map((n) => `\`${n}\``).join(', ')}`;
  return typeof payload['symbol_name'] === 'string' ? ` \`${payload['symbol_name']}\`` : '';
}

/**
 * Said when no indexed test reaches the change: Ruby projects leave `spec/`
 * and `test/` out of the index by default, so "no tests" there means "not
 * indexed", not "untested". Lists the project's test files named after the
 * changed file and its direct dependents (`testFiles`, recorded by the
 * indexer); when the project's test files are not known, where they would be
 * by convention.
 */
function testsByConvention(files: string[], testFiles: string[] | null): string {
  let text =
    '\n### Tests\n\nNo test in the index reaches it. That does not mean it is untested: the index may leave tests out (Ruby projects skip `spec/` and `test/` by default), and tests reaching it through routes, jobs or GraphQL are not linked.';
  if (testFiles) {
    const named = [...new Set(files.flatMap((f) => testsNamedAfter(f, testFiles)))].slice(0, 12);
    if (named.length === 0) {
      return text + ' No test file of the project is named after it or its direct callers.\n';
    }
    return (
      text +
      ' These test files of the project are named after it or its direct callers:\n\n' +
      named.map((p) => `- \`${p}\`\n`).join('')
    );
  }
  const paths = [...new Set(files.flatMap(conventionalTestPaths))].slice(0, 12);
  if (paths.length === 0) return text + '\n';
  text += ' By convention its tests would be at:\n\n';
  return (
    text +
    paths.map((p) => `- \`${p}\`\n`).join('') +
    '\nCheck which exist before relying on them.\n'
  );
}

/**
 * The chunk each method of a dependent begins in, for the methods it does not
 * define itself (a method continued from an earlier chunk): the nearest
 * earlier chunk of its file defining the name.
 */
async function methodHeads(
  src: ChangeImpactSource,
  chunkOf: (id: string) => Promise<Record<string, unknown> | null>,
  dep: Dependent
): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  const p = await chunkOf(dep.chunkId);
  const loc = parseChunkId(dep.chunkId);
  if (!p || !loc) return heads;
  const defines = Array.isArray(p['defines_symbols']) ? (p['defines_symbols'] as string[]) : [];
  const missing = dep.callers.filter((m) => m !== '' && !defines.includes(m));
  if (missing.length === 0) return heads;
  const before: Array<{ id: string; start: number; defines: string[] }> = [];
  for (const id of await src.fileChunkIds(loc.group, loc.project, loc.file)) {
    const at = parseChunkId(id);
    if (!at || at.file !== loc.file || at.startLine >= loc.startLine) continue;
    const cp = await chunkOf(id);
    const d = Array.isArray(cp?.['defines_symbols']) ? (cp['defines_symbols'] as string[]) : [];
    before.push({ id, start: at.startLine, defines: d });
  }
  before.sort((a, b) => b.start - a.start);
  for (const m of missing) {
    const head = before.find((c) => c.defines.includes(m));
    if (head) heads.set(m, head.id);
  }
  return heads;
}

const stepsAway = (dep: { step: number; exact: boolean }): string =>
  `${dep.exact ? '' : 'at least '}${dep.step} step${dep.step === 1 ? '' : 's'} away`;

/** The text `change_impact` answers with: what depends on a chunk, step by step, and the tests that reach it. */
export async function changeImpactReport(
  src: ChangeImpactSource,
  { chunkId, payload, wholeFile, symbol, depth, limit }: ChangeImpactArgs
): Promise<string> {
  const parsed = parseChunkId(chunkId);
  if (!parsed) throw new Error(`Not a chunk id: ${chunkId}`);
  const seeds = [chunkId];
  if (wholeFile) {
    for (const id of await src.fileChunkIds(parsed.group, parsed.project, parsed.file)) {
      if (!seeds.includes(id)) seeds.push(id);
    }
  }

  // A chunk that calls a lot (a large class) has few dependents; only being called from many places stops the walk.
  const hubs = src.hubs(parsed.group);
  const names = src.names(parsed.group);
  // Per caller file: the files it reaches through a specific name.
  const specificLinks = new Map<string, Set<string>>();
  const chunkFileKey = (id: string) => id.split('//').slice(0, 3).join('//');
  // Methods of the changed chunk calling `symbol` through it (a wrapper): their callers are affected too.
  const innerCalls = (p: Record<string, unknown> | null) =>
    p && p['inner_calls'] && typeof p['inner_calls'] === 'object'
      ? (p['inner_calls'] as Record<string, string[]>)
      : undefined;
  const seedSteps =
    symbol !== undefined && !wholeFile ? innerReach(innerCalls(payload), [symbol]) : new Map();
  // Payloads read once: for the rows, and to find where a long method begins.
  const loaded = new Map<string, Promise<Record<string, unknown> | null>>();
  const chunkOf = (id: string) => {
    let p = loaded.get(id);
    if (!p) loaded.set(id, (p = src.getChunk(id)));
    return p;
  };
  // Per dependent, the earlier chunk of its file where each of its calling
  // methods begins, when the method is too long for one chunk: the method's
  // callers link there.
  const heads = new Map<string, Map<string, string>>();
  const walk = () =>
    collectDependents({
      seeds,
      edgesTo: src.edgesTo,
      edgesToMethod: (id, method) => {
        const head = heads.get(id)?.get(method);
        return head ? src.edgesTo(head).filter((e) => e.symbol_name === method) : [];
      },
      depth,
      maxDependents: limit,
      symbol,
      ...(seedSteps.size > 0 ? { seedSteps } : {}),
      isHub: (id) => hubs.has(id),
      isLeaf: (id) => isTestPath(parseChunkId(id)?.file ?? ''),
      isCommonName: (name) => isCommonName(name, names),
      confirmsLink: (caller, target) => {
        const callerFile = chunkFileKey(caller);
        if (callerFile === chunkFileKey(target)) return true;
        let linked = specificLinks.get(callerFile);
        if (!linked) {
          const loc = parseChunkId(caller);
          linked = new Set(
            loc
              ? src
                  .edgesFromFile(loc.group, loc.project, loc.file)
                  .filter((e) => !isCommonName(e.symbol_name, names))
                  .map((e) => chunkFileKey(e.to_chunk_id))
              : []
          );
          specificLinks.set(callerFile, linked);
        }
        return linked.has(chunkFileKey(target));
      },
    });
  let walked = walk();
  const checked = new Set<string>();
  for (let round = 0; round < MAX_IMPACT_DEPTH; round++) {
    let more = false;
    for (const dep of walked.dependents) {
      if (checked.has(dep.chunkId)) continue;
      checked.add(dep.chunkId);
      const found = await methodHeads(src, chunkOf, dep);
      if (found.size > 0) {
        heads.set(dep.chunkId, found);
        more = true;
      }
    }
    if (!more) break;
    walked = walk();
  }
  const { dependents, truncated, deeper, viaCommonNames, viaAmbiguousNames } = walked;

  // Linked only by a name like `add` or `get`: listed by file, not followed.
  let commonSection = '';
  if (viaCommonNames.length > 0) {
    const count = viaCommonNames.reduce((n, c) => n + c.chunkIds.length, 0);
    commonSection += `\n### Linked only through a common name (${count}) — probably not dependents\n\n`;
    commonSection +=
      'The graph links by name, and these names are used all over the code, so most of these are calls on other objects (`set.add(...)`, `map.get(...)`). They were not followed further. Confirm with grep before relying on one.\n\n';
    for (const c of viaCommonNames) {
      const files = [...new Set(c.chunkIds.map((id) => parseChunkId(id)?.file ?? id))].sort();
      const shown = files.slice(0, 5).join(', ');
      const more = files.length > 5 ? ` (+${files.length - 5} more)` : '';
      const used = names.filesUsing.get(c.symbol) ?? 0;
      commonSection += `- \`${c.symbol}\` (used in ${used} files) — ${c.chunkIds.length} chunks in ${files.length} files: ${shown}${more}\n`;
    }
  }
  if (viaAmbiguousNames.length > 0) {
    const count = viaAmbiguousNames.reduce((n, c) => n + c.chunkIds.length, 0);
    commonSection += `\n### Linked only through a name defined in several places (${count}) — probably not dependents\n\n`;
    commonSection +=
      'These call a name that several classes define, on an object whose class the code does not show. Most are calls to another class of the same name. They were not followed further. Check with grep if one matters.\n\n';
    for (const c of viaAmbiguousNames) {
      const files = [...new Set(c.chunkIds.map((id) => parseChunkId(id)?.file ?? id))].sort();
      const shown = files.slice(0, 5).join(', ');
      const more = files.length > 5 ? ` (+${files.length - 5} more)` : '';
      const n = `${files.length} file${files.length === 1 ? '' : 's'}`;
      commonSection += `- \`${c.symbol}\` — ${n}: ${shown}${more}\n`;
    }
  }

  const project = typeof payload['project'] === 'string' ? payload['project'] : 'unknown';
  const file = typeof payload['file'] === 'string' ? payload['file'] : parsed.file;
  const ownSymbol =
    typeof payload['symbol_name'] === 'string' ? ` \`${payload['symbol_name']}\`` : '';
  const target = wholeFile
    ? `[${project}] ${file} (whole file, ${seeds.length} chunks)`
    : `[${project}] ${file}:${shownLine(parsed.startLine)}-${shownLine(parsed.endLine)}${ownSymbol}`;
  let text = `## Change impact of ${target}\n\n`;

  const defSymbols = Array.isArray(payload['defines_symbols'])
    ? (payload['defines_symbols'] as string[])
    : [];
  if (symbol !== undefined && !wholeFile && !defSymbols.includes(symbol)) {
    text += `This chunk does not define \`${symbol}\`${defSymbols.length > 0 ? `; it defines ${defSymbols.map((s) => `\`${s}\``).join(', ')}` : ''}.\n\n`;
  }
  if (symbol === undefined && !wholeFile && defSymbols.length > 1) {
    const shown = defSymbols.slice(0, 6).map((s) => `\`${s}\``);
    text += `Steps are counted from any of the ${defSymbols.length} names this chunk defines (${shown.join(', ')}${defSymbols.length > shown.length ? ', …' : ''}); pass \`symbol\` to count from one.\n\n`;
  }

  const caveat =
    '_The graph links code by name. Calls made dynamically — reflection, string dispatch, routes, config — are not in it._\n';

  const wrapped = [...seedSteps.values()].filter((d) => d > 0).length;
  if (dependents.length === 0 && wrapped === 0) {
    const clearly = viaCommonNames.length > 0 ? 'clearly ' : '';
    text += `Nothing in the indexed code ${clearly}depends on it${symbol !== undefined ? ` through \`${symbol}\`` : ''}.\n`;
    text += commonSection + '\n' + caveat;
    return text;
  }

  const payloads = await Promise.all(dependents.map((d) => chunkOf(d.chunkId)));
  // One row per dependent and step: a chunk whose methods are at several steps
  // (one calls the change, another calls that one) is listed under each.
  interface Row {
    dep: Dependent;
    payload: Record<string, unknown> | null;
    file: string;
    fileKey: string;
    startLine: number;
    test: boolean;
    step: number;
    exact: boolean;
    /** Methods at this step making the call themselves, or reaching it through another method of the chunk. */
    own: string[];
    through: Array<{ name: string; calls: string | undefined }>;
    /** Later chunks of the same long method, listed under its row. */
    more?: string[];
  }
  // Where a method that begins in an earlier chunk is defined.
  const headLines = new Map<string, number>();
  for (const [id, byMethod] of heads) {
    for (const [method, head] of byMethod) {
      const hp = await chunkOf(head);
      const hs = typeof hp?.['startLine'] === 'number' ? hp['startLine'] : null;
      const hc = typeof hp?.['content'] === 'string' ? hp['content'] : '';
      const hf = typeof hp?.['file'] === 'string' ? hp['file'] : '';
      if (hs !== null) headLines.set(`${id}\0${method}`, definitionLine(hc, hs, method, hf) ?? hs);
    }
  }
  const rows: Row[] = [];
  dependents.forEach((dep, i) => {
    const loc = parseChunkId(dep.chunkId);
    const ep = payloads[i] ?? null;
    const base = {
      dep,
      payload: ep,
      file: loc?.file ?? '',
      fileKey: loc ? `${loc.project}//${loc.file}` : dep.chunkId,
      startLine: loc?.startLine ?? 0,
      test: isTestPath(loc?.file ?? ''),
    };
    const inner = innerCalls(ep) ?? {};
    const stepOf = new Map(dep.methods.map((m) => [m.name, m.step]));
    const groups = new Map<string, Row>();
    const methods =
      dep.methods.length > 0 ? dep.methods : [{ name: '', step: dep.step, exact: dep.exact }];
    for (const m of methods) {
      const key = `${m.step}\0${m.exact}`;
      let row = groups.get(key);
      if (!row)
        groups.set(key, (row = { ...base, step: m.step, exact: m.exact, own: [], through: [] }));
      if (m.name === '' || dep.callers.includes(m.name) || !dep.reach.includes(m.name)) {
        if (m.name !== '') row.own.push(m.name);
      } else {
        // The method of the chunk it calls on the way, one step nearer.
        const calls = Object.keys(inner).find(
          (callee) => inner[callee]!.includes(m.name) && stepOf.get(callee) === m.step - 1
        );
        row.through.push({ name: m.name, calls });
      }
    }
    rows.push(...groups.values());
  });
  // Methods of the changed chunk calling it through the chunk (a wrapper), each at its step.
  const seedInner = innerCalls(payload) ?? {};
  const wrappers = new Map<number, Row>();
  for (const [name, step] of seedSteps) {
    if (step === 0) continue;
    let row = wrappers.get(step);
    if (!row) {
      row = {
        dep: {
          chunkId,
          hop: 0,
          step,
          exact: true,
          methods: [],
          symbols: [],
          callers: [],
          reach: [],
          certain: true,
          hub: false,
          reexport: false,
        },
        payload,
        file,
        fileKey: `${parsed.project}//${parsed.file}`,
        startLine: parsed.startLine,
        test: isTestPath(file),
        step,
        exact: true,
        own: [],
        through: [],
      };
      wrappers.set(step, row);
    }
    const calls = Object.keys(seedInner).find(
      (callee) =>
        seedInner[callee]!.includes(name) &&
        (step === 1 ? callee === symbol : seedSteps.get(callee) === step - 1)
    );
    row.through.push({ name, calls });
  }
  rows.push(...wrappers.values());
  // A long method split over chunks is one dependent: its chunks share a row.
  const byHead = new Map<string, Row>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const method = r.own.length === 1 && r.through.length === 0 ? r.own[0]! : undefined;
    const head = method !== undefined ? heads.get(r.dep.chunkId)?.get(method) : undefined;
    if (!head) continue;
    const key = `${head}\0${method}\0${r.step}\0${r.exact}`;
    const kept = byHead.get(key);
    if (!kept) {
      byHead.set(key, r);
      continue;
    }
    // Keep the earlier chunk's row, with this one's chunk under it.
    const [first, later] = r.startLine < kept.startLine ? [r, kept] : [kept, r];
    first.more = [...(first.more ?? []), later.dep.chunkId, ...(later.more ?? [])];
    for (const name of later.dep.symbols)
      if (!first.dep.symbols.includes(name)) first.dep.symbols.push(name);
    rows.splice(rows.indexOf(later), 1);
    byHead.set(key, first);
  }
  rows.sort(
    (a, b) =>
      a.step - b.step ||
      Number(b.exact) - Number(a.exact) ||
      Number(b.dep.certain) - Number(a.dep.certain) ||
      a.fileKey.localeCompare(b.fileKey) ||
      a.startLine - b.startLine
  );

  // `depth` counts steps; the walk counts chunks, and a chunk's own calls add
  // steps, so what lies further than `depth` steps is counted, not listed.
  const shown = rows.filter((r) => r.step <= depth);
  const listed = new Set(shown.filter((r) => r.dep.hop > 0).map((r) => r.dep.chunkId));
  const further = new Set(
    rows.filter((r) => r.dep.hop > 0 && !listed.has(r.dep.chunkId)).map((r) => r.dep.chunkId)
  ).size;
  const code = shown.filter((r) => !r.test);
  const tests = shown.filter((r) => r.test);
  const direct = dependents.filter((d) => d.step === 1).length;
  const files = new Set(shown.filter((r) => r.dep.hop > 0).map((r) => r.fileKey)).size;
  const testChunks = new Set(tests.filter((r) => r.dep.hop > 0).map((r) => r.dep.chunkId)).size;
  const wrappedShown = shown
    .filter((r) => r.dep.hop === 0)
    .reduce((n, r) => n + r.through.length, 0);
  text += `${listed.size} chunks in ${files} files depend on it within ${depth} step${depth === 1 ? '' : 's'}: ${direct} directly, ${listed.size - direct} through other code. ${testChunks} of them are tests.`;
  if (wrappedShown > 0) {
    text += ` ${wrappedShown} other method${wrappedShown === 1 ? '' : 's'} of the changed chunk call${wrappedShown === 1 ? 's' : ''} it through the chunk; ${wrappedShown === 1 ? 'its' : 'their'} callers count a step further.`;
  }
  if (further > 0) {
    text += ` ${further} more chunk${further === 1 ? ' is' : 's are'} further than ${depth} step${depth === 1 ? '' : 's'} away, not listed.`;
  }
  text += '\n';

  const line = (r: Row, showStep: boolean): string => {
    const ep = r.payload;
    const names = r.dep.symbols.map((s) => `\`${s}\``).join(', ');
    const uses = `${r.dep.reexport ? 're-exports' : 'uses'} ${names}`;
    const marks = `${r.dep.certain ? '' : ' [maybe]'}${r.dep.hub ? ' [hub]' : ''}`;
    const away = showStep ? `, ${stepsAway(r)}` : '';
    if (!ep) return `- chunk: \`${r.dep.chunkId}\` — ${uses}${away}${marks}\n`;
    const p = typeof ep['project'] === 'string' ? ep['project'] : 'unknown';
    const f = typeof ep['file'] === 'string' ? ep['file'] : r.file;
    const sl = typeof ep['startLine'] === 'number' ? ep['startLine'] : r.startLine;
    const content = typeof ep['content'] === 'string' ? ep['content'] : '';
    const at = (name: string, calls: string[]) =>
      definitionLine(content, sl, name, f, calls) ??
      headLines.get(`${r.dep.chunkId}\0${name}`) ??
      sl;
    let out = '';
    if (r.own.length > 0 || r.through.length === 0) {
      const first = r.own[0];
      const shownAt = first !== undefined && !r.dep.reexport ? at(first, r.dep.symbols) : sl;
      const sym = r.dep.reexport ? '' : callerLabel(r.own, ep);
      out += `- **[${p}] ${f}:${shownLine(shownAt)}**${sym} — ${uses}${away}${marks}\n`;
    }
    for (const t of r.through.slice(0, 8)) {
      const via =
        t.calls !== undefined
          ? `calls \`${t.calls}\` in this file`
          : 'reaches it through calls in this file';
      out += `- **[${p}] ${f}:${shownLine(at(t.name, t.calls ? [t.calls] : []))}** \`${t.name}\` — ${via}${away}${marks}\n`;
    }
    if (r.through.length > 8) out += `- … and ${r.through.length - 8} more methods of this chunk\n`;
    const chunks = [r.dep.chunkId, ...(r.more ?? [])].map((id) => `\`${id}\``).join(', ');
    return `${out}  chunk${r.more ? 's' : ''}: ${chunks}\n`;
  };

  // Rows are sorted by step, exact ones first: one heading per run.
  for (let i = 0; i < code.length;) {
    const { step, exact } = code[i]!;
    let j = i;
    while (j < code.length && code[j]!.step === step && code[j]!.exact === exact) j++;
    const heading = step === 1 && exact ? 'Uses it directly' : stepsAway(code[i]!);
    text += `\n### ${heading[0]!.toUpperCase()}${heading.slice(1)} (${j - i})\n\n`;
    for (const r of code.slice(i, j)) text += line(r, false);
    i = j;
  }
  if (tests.length > 0) {
    text += `\n### Tests (${testChunks}) — they call it through the code above; run them after the change\n\n`;
    for (const r of tests) text += line(r, true);
    if (tests.some((r) => r.step > 1)) {
      text +=
        '\nA test more than a step away reaches it only if the path runs: stubs, mocks or early returns on the way can skip it.\n';
    }
  } else {
    text += testsByConvention(
      [file, ...code.filter((r) => r.step === 1).map((r) => r.file)],
      src.testFiles(parsed.group, parsed.project)
    );
  }
  text += commonSection;

  const notes: string[] = [];
  if (rows.some((r) => !r.dep.certain)) {
    notes.push(
      '`[maybe]` — linked only through a common name (its file also uses something specific from the changed file), or through such a dependent; check it really uses this code.'
    );
  }
  if (rows.some((r) => r.through.length > 0)) {
    notes.push(
      'Steps count calls between methods, calls inside a file included: a method that "calls `x` in this file" is one step further than `x`.'
    );
  }
  if (rows.some((r) => !r.exact)) {
    notes.push(
      '"At least" — the path goes through calls inside a file indexed before those were recorded; reindex for exact steps.'
    );
  }
  if (rows.some((r) => r.dep.hub)) {
    notes.push('`[hub]` — called from many places; what depends on it was not followed.');
  }
  if (truncated) {
    notes.push(
      `Stopped at ${limit} dependents. Narrow with \`symbol\`, lower \`depth\`, or raise \`limit\` (max 100).`
    );
  }
  if (deeper) {
    notes.push(
      depth < MAX_IMPACT_DEPTH
        ? `More code depends on the last step; raise \`depth\` (max ${MAX_IMPACT_DEPTH}) to follow it.`
        : `More code depends on the last step; callers past ${MAX_IMPACT_DEPTH} steps are not followed.`
    );
  }
  text += '\n' + notes.map((n) => `_${n}_\n`).join('') + caveat;

  return text;
}
