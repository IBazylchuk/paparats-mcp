import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import type { ChunkSymbols } from './symbol-graph.js';

/**
 * The bare import specifiers that name a project's own code: the names of its
 * packages (a monorepo's workspaces import each other as `@scope/shared`) and
 * the path aliases of its tsconfig files (`@/*`, `#lib/*`). Any other bare
 * specifier is an installed package, so `app.get(...)` on an `express()` app
 * or `db.close()` on a `better-sqlite3` database calls nothing of the project.
 */
export interface LocalModules {
  packages: string[];
  aliases: string[];
  /** Per `tsconfig.json` / `jsconfig.json` with `paths`, what each alias points at (see {@link resolveAlias}). */
  scopes?: AliasScope[];
}

/** The path aliases a config gives the files below its folder. */
export interface AliasScope {
  /** The config's folder, relative to the project (`''` for the root). */
  dir: string;
  /** Each `paths` key with its first target, relative to the project (`src/*`). */
  paths: Array<{ key: string; target: string }>;
}

export function isLocalModule(spec: string, local: LocalModules): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return true;
  if (local.packages.some((p) => spec === p || spec.startsWith(`${p}/`))) return true;
  return local.aliases.some((a) =>
    a.endsWith('*') ? spec.startsWith(a.slice(0, -1)) : spec === a
  );
}

/**
 * Read from the project's `package.json` and `tsconfig*.json` files. Null when
 * the directory is not there (content sent by a client) or has no
 * `package.json`: then nothing is known to be a package.
 */
export function readLocalModules(root: string): LocalModules | null {
  if (!fs.existsSync(root)) return null;
  const files = globSync(['**/package.json', '**/tsconfig*.json', '**/jsconfig.json'], {
    cwd: root,
    ignore: ['**/node_modules/**', '**/.git/**'],
    maxDepth: 6,
    nodir: true,
  });
  const packages: string[] = [];
  const aliases: string[] = [];
  const scopes: AliasScope[] = [];
  let sawPackage = false;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const base = path.basename(file);
    if (base === 'package.json') {
      sawPackage = true;
      const name = /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (name) packages.push(name);
      continue;
    }
    aliases.push(...pathAliases(text));
    if (base === 'tsconfig.json' || base === 'jsconfig.json') {
      const scope = aliasScope(root, file);
      if (scope) {
        scopes.push(scope);
        // `core/hooks` under `baseUrl: "src"` names `src/core`, not a package.
        for (const { key } of scope.paths) if (!aliases.includes(key)) aliases.push(key);
      }
    }
  }
  return sawPackage ? { packages, aliases, scopes } : null;
}

/** The keys of `compilerOptions.paths`, read without parsing (tsconfig allows comments). */
function pathAliases(text: string): string[] {
  const start = text.search(/"paths"\s*:\s*\{/);
  if (start < 0) return [];
  const open = text.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < text.length; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}' && --depth === 0) break;
  }
  return [...text.slice(open + 1, end).matchAll(/"([^"]+)"\s*:\s*\[/g)].map((m) => m[1]!);
}

interface TsConfig {
  extends?: string | string[];
  references?: Array<{ path?: string }>;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/** A tsconfig parsed as JSON with comments and trailing commas; null when it is not one. */
function readTsConfig(file: string): TsConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  try {
    const parsed: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    return parsed && typeof parsed === 'object' ? (parsed as TsConfig) : null;
  } catch {
    return null;
  }
}

/**
 * The aliases a config's files get, as TypeScript reads them: its own `paths`
 * or the nearest ones up its `extends` chain, relative to `baseUrl` (also
 * inherited) or else to the config that sets them; a solution-style config
 * without any takes them from the first of its `references` that has some.
 */
function aliasScope(root: string, file: string): AliasScope | null {
  const found = effectivePaths(path.join(root, file), 0);
  if (!found) return null;
  const paths: AliasScope['paths'] = [];
  for (const [key, targets] of Object.entries(found.paths)) {
    const first = Array.isArray(targets) ? targets[0] : undefined;
    if (typeof first !== 'string') continue;
    const target = path.relative(root, path.resolve(found.base, first)).split(path.sep).join('/');
    if (target.startsWith('..')) continue;
    paths.push({ key, target });
  }
  if (paths.length === 0) return null;
  const dir = path.dirname(file).split(path.sep).join('/');
  return { dir: dir === '.' ? '' : dir, paths };
}

function effectivePaths(
  file: string,
  depth: number
): { paths: Record<string, string[]>; base: string } | null {
  let paths: Record<string, string[]> | undefined;
  let pathsDir = '';
  let baseUrl: string | undefined;
  const seen = new Set<string>();
  const chain = [file];
  const first = readTsConfig(file);
  for (let i = 0; i < chain.length && i < 8; i++) {
    const current = chain[i]!;
    if (seen.has(current)) continue;
    seen.add(current);
    const config = i === 0 ? first : readTsConfig(current);
    if (!config) continue;
    const options = config.compilerOptions;
    if (!paths && options?.paths && typeof options.paths === 'object') {
      paths = options.paths;
      pathsDir = path.dirname(current);
    }
    if (baseUrl === undefined && typeof options?.baseUrl === 'string') {
      baseUrl = path.resolve(path.dirname(current), options.baseUrl);
    }
    const parents = typeof config.extends === 'string' ? [config.extends] : config.extends;
    for (const parent of Array.isArray(parents) ? parents : []) {
      // A package's config (`@tsconfig/node20`) sets no project paths.
      if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(current), parent);
      chain.push(resolved.endsWith('.json') ? resolved : `${resolved}.json`);
    }
  }
  if (baseUrl !== undefined && !paths?.['*']) {
    return { paths: { ...baseUrlPaths(baseUrl), ...paths }, base: baseUrl };
  }
  if (paths) return { paths, base: pathsDir };
  if (depth > 0 || !Array.isArray(first?.references)) return null;
  for (const ref of first.references) {
    if (typeof ref?.path !== 'string') continue;
    let target = path.resolve(path.dirname(file), ref.path);
    if (!target.endsWith('.json')) target = path.join(target, 'tsconfig.json');
    const found = effectivePaths(target, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * What `baseUrl` resolves, as `paths` relative to it: TypeScript looks a bare
 * specifier up there before `node_modules`, so each folder and file it holds
 * (`core`, `config.ts`) is the project's own; any other name is still a package.
 */
function baseUrlPaths(baseUrl: string): Record<string, string[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseUrl, { withFileTypes: true });
  } catch {
    return {};
  }
  const paths: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (e.isDirectory()) {
      paths[e.name] = [e.name];
      paths[`${e.name}/*`] = [`${e.name}/*`];
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      paths[e.name.replace(/\.[^.]+$/, '')] = [e.name];
    }
  }
  return paths;
}

/**
 * What a path alias import in `file` (relative to the project) loads, as a
 * relative specifier from that file: `~/lib/dates` in `src/app/page.tsx` under
 * `"~/*": ["./src/*"]` is `../lib/dates`. The aliases are those of the nearest
 * config above the file; a key without `*` must match whole, and of several
 * matching the one with the longest part before `*` wins. Null for any other
 * specifier.
 */
export function resolveAlias(spec: string, file: string, local: LocalModules): string | null {
  if (spec.startsWith('.') || !local.scopes?.length) return null;
  let scope: AliasScope | undefined;
  for (const s of local.scopes) {
    if (s.dir !== '' && !file.startsWith(`${s.dir}/`)) continue;
    if (!scope || s.dir.length > scope.dir.length) scope = s;
  }
  if (!scope) return null;
  let target: string | undefined;
  let matched = -1;
  for (const { key, target: to } of scope.paths) {
    const star = key.indexOf('*');
    if (star < 0) {
      if (key === spec) {
        target = to;
        break;
      }
      continue;
    }
    const before = key.slice(0, star);
    const after = key.slice(star + 1);
    if (before.length <= matched) continue;
    if (spec.length < before.length + after.length) continue;
    if (!spec.startsWith(before) || !spec.endsWith(after)) continue;
    target = to.replace('*', spec.slice(before.length, spec.length - after.length));
    matched = before.length;
  }
  if (target === undefined) return null;
  const relative = path.posix.relative(path.posix.dirname(file), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Rewrite the path alias imports that chunks' uses and classes record as
 * relative specifiers, so an imported name links to its module's definition
 * as a relative import does. Done on the stored symbols when the graph is
 * built, so a change here needs no file extracted again.
 */
export function resolveAliasImports(chunks: ChunkSymbols[], local: LocalModules | null): void {
  if (!local?.scopes?.length) return;
  const cache = new Map<string, string | null>();
  const resolve = (spec: string, file: string): string | null => {
    if (spec.startsWith('.')) return null;
    const key = `${file}\0${spec}`;
    let found = cache.get(key);
    if (found === undefined) cache.set(key, (found = resolveAlias(spec, file, local)));
    return found;
  };
  for (const chunk of chunks) {
    // `<group>//<project>//<file>//<lines>//<hash>`
    const file = chunk.chunk_id.split('//').slice(2, -2).join('//');
    if (!file) continue;
    for (const site of chunk.use_sites ?? []) {
      if (site.module === undefined) continue;
      const resolved = resolve(site.module, file);
      if (resolved) site.module = resolved;
    }
    for (const parents of Object.values(chunk.def_classes ?? {})) {
      for (const parent of parents) {
        if (parent.module === undefined) continue;
        const resolved = resolve(parent.module, file);
        if (resolved) parent.module = resolved;
      }
    }
  }
}

/** Whether any chunk imports through a bare specifier, which may be an alias. */
export function hasBareImports(chunks: Iterable<ChunkSymbols>): boolean {
  for (const chunk of chunks) {
    for (const site of chunk.use_sites ?? []) {
      if (site.module !== undefined && !site.module.startsWith('.')) return true;
    }
  }
  return false;
}
