// Normalize exclude patterns into globs usable as glob's `ignore` option.
//
// glob matches an ignore pattern against the whole relative path, so a raw
// `spec/fixtures` only drops a file literally named `spec/fixtures` and keeps
// everything inside it. Semantics follow .gitignore:
//
// - patterns containing `**` are left unchanged: the author spelled out depth;
// - a pattern with a `/` (or `./`) at the start or in the middle is anchored
//   to the project root: `spec/fixtures` -> `spec/fixtures` + `spec/fixtures/**`;
// - anything else matches at any depth: `node_modules` -> `**/node_modules` +
//   `**/node_modules/**`, `*.class` -> `**/*.class` + `**/*.class/**`.
//
// Leading `./` and trailing `/` are dropped. Output is de-duplicated, and
// normalizing it again changes nothing — except a root-anchored single name
// (`/tmp` -> `tmp`), which a second pass widens to any depth: more excluded,
// never less.
export function normalizeExcludePatterns(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.includes('**')) {
      out.add(pattern);
      continue;
    }
    const body = pattern
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!body) continue;
    const anchored = /^\.?\//.test(pattern) || body.includes('/');
    const base = anchored ? body : `**/${body}`;
    out.add(base);
    out.add(`${base}/**`);
  }
  return Array.from(out);
}

/**
 * Folder names a build or a framework writes output into, which a project's
 * own source also uses as folder names (`src/app/build/page.tsx`,
 * `lib/storage/blob.rb`). Excluded at any depth, they drop that source; see
 * {@link anchorBuildOutputExcludes}.
 */
export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  'build',
  'out',
  'dist',
  'coverage',
  'cover',
  'tmp',
  'log',
  'storage',
  'bin',
  'obj',
  'target',
  'doc',
  'deps',
]);

/** Files that mark the root of a package: where its build output folders sit. */
export const PACKAGE_MANIFESTS = [
  'package.json',
  'Gemfile',
  '*.gemspec',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'build.sbt',
  'mix.exs',
  'composer.json',
  'Package.swift',
  '*.csproj',
];

/**
 * Narrow the any-depth exclusion of build output folders (`**\/build`,
 * `**\/build/**`, from {@link normalizeExcludePatterns}) to the folders of that
 * name at the project root and at each package root (`packageDirs`, relative,
 * `''` for the root): `build/**`, `packages/api/build/**`. A `build` folder
 * deeper in a package's source is kept. Other patterns pass through.
 */
export function anchorBuildOutputExcludes(patterns: string[], packageDirs: string[]): string[] {
  const names = new Set<string>();
  const out: string[] = [];
  for (const pattern of patterns) {
    const match = /^\*\*\/([^/*?[\]{}]+)(\/\*\*)?$/.exec(pattern);
    if (match && BUILD_OUTPUT_DIRS.has(match[1]!)) {
      names.add(match[1]!);
      continue;
    }
    out.push(pattern);
  }
  const dirs = new Set(['', ...packageDirs.map((d) => d.replace(/^\.?\/+|\/+$/g, ''))]);
  for (const name of names) {
    for (const dir of dirs) out.push(dir ? `${dir}/${name}/**` : `${name}/**`);
  }
  return Array.from(new Set(out));
}
