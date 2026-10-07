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
