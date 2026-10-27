import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';

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
  let sawPackage = false;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (path.basename(file) === 'package.json') {
      sawPackage = true;
      const name = /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (name) packages.push(name);
      continue;
    }
    aliases.push(...pathAliases(text));
  }
  return sawPackage ? { packages, aliases } : null;
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
