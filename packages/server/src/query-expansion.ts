/** Bidirectional abbreviation map for common code terms */
const ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ['auth', 'authentication'],
  ['authn', 'authentication'],
  ['authz', 'authorization'],
  ['config', 'configuration'],
  ['cfg', 'configuration'],
  ['env', 'environment'],
  ['err', 'error'],
  ['fn', 'function'],
  ['func', 'function'],
  ['impl', 'implementation'],
  ['init', 'initialization'],
  ['msg', 'message'],
  ['param', 'parameter'],
  ['params', 'parameters'],
  ['req', 'request'],
  ['res', 'response'],
  ['repo', 'repository'],
  ['db', 'database'],
  ['str', 'string'],
  ['num', 'number'],
  ['ctx', 'context'],
  ['util', 'utility'],
  ['utils', 'utilities'],
  ['srv', 'server'],
  ['cli', 'client'],
  ['dir', 'directory'],
  ['doc', 'document'],
  ['docs', 'documents'],
  ['dep', 'dependency'],
  ['deps', 'dependencies'],
]);

/** Reverse map: full word -> preferred abbreviation (first entry wins — most common) */
const REVERSE_ABBREVIATIONS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [abbr, full] of ABBREVIATIONS) {
    if (!map.has(full)) {
      map.set(full, abbr);
    }
  }
  return map;
})();

/** Filler words to strip from natural language queries */
const FILLER_WORDS = new Set([
  'how',
  'does',
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'do',
  'what',
  'where',
  'when',
  'which',
  'who',
  'why',
  'can',
  'could',
  'would',
  'should',
  'will',
  'work',
  'works',
  'working',
  'this',
  'that',
  'these',
  'those',
  'in',
  'of',
  'for',
  'to',
  'with',
  'from',
  'by',
  'about',
  'it',
  'its',
  'my',
  'our',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'get',
  'gets',
  'getting',
  'find',
  'show',
  'me',
  'please',
  'i',
]);

/** Split camelCase/PascalCase into words */
function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** Check if a string is camelCase or PascalCase */
function isCamelOrPascalCase(str: string): boolean {
  return /^[a-z][a-zA-Z0-9]*$/.test(str) || /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/** Convert space-separated words to camelCase */
function toCamelCase(words: string[]): string {
  if (words.length === 0) return '';
  return (
    words[0]!.toLowerCase() +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('')
  );
}

/** Try to produce an abbreviation variant by expanding or contracting terms */
function addAbbreviationVariant(words: string[]): string | null {
  let changed = false;
  const result = words.map((w) => {
    const lower = w.toLowerCase();
    const expansion = ABBREVIATIONS.get(lower);
    if (expansion) {
      changed = true;
      return expansion;
    }
    const contraction = REVERSE_ABBREVIATIONS.get(lower);
    if (contraction) {
      changed = true;
      return contraction;
    }
    return w;
  });
  return changed ? result.join(' ') : null;
}

/** Generate a case variant: space-separated -> camelCase, or camelCase -> space-separated */
function addCaseVariant(query: string): string | null {
  const trimmed = query.trim();
  const words = trimmed.split(/\s+/);

  // Multi-word query -> camelCase
  if (words.length >= 2 && words.every((w) => /^[a-zA-Z]+$/.test(w))) {
    return toCamelCase(words);
  }

  // Single camelCase/PascalCase token -> space-separated lowercase
  if (words.length === 1 && isCamelOrPascalCase(trimmed)) {
    const parts = splitCamelCase(trimmed);
    if (parts.length >= 2) {
      return parts.join(' ');
    }
  }

  return null;
}

/** Normalize a word from plural to singular */
function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length <= 3) return word;
  if (lower.endsWith('ies') && lower.length > 4) {
    return word.slice(0, -3) + (word[0] === word[0]!.toUpperCase() ? 'Y' : 'y');
  }
  if (lower.endsWith('ses') || lower.endsWith('xes') || lower.endsWith('zes')) {
    return word.slice(0, -2);
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

/** Try to produce a variant by singularizing plural words */
function addPluralVariant(words: string[]): string | null {
  let changed = false;
  const result = words.map((w) => {
    const singular = singularize(w);
    if (singular !== w) {
      changed = true;
      return singular;
    }
    return w;
  });
  return changed ? result.join(' ') : null;
}

/** Strip filler words from a natural-language query */
function addKeywordVariant(query: string): string | null {
  const words = query.trim().split(/\s+/);
  const keywords = words.filter((w) => !FILLER_WORDS.has(w.toLowerCase()));

  // Only useful if we actually removed something and have at least 2 keywords left
  if (keywords.length < words.length && keywords.length >= 2) {
    return keywords.join(' ');
  }
  return null;
}

/**
 * Expand a search query into variations for broader semantic coverage.
 *
 * Returns `[originalQuery, ...variations]` with at most 3 total entries.
 * The original query is always first. Uses only programmatic heuristics
 * (no LLM calls).
 */
export function expandQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [query];

  const results = new Set<string>([trimmed]);
  const words = trimmed.split(/\s+/);

  // 1. Abbreviation expansion/contraction
  const abbrVariant = addAbbreviationVariant(words);
  if (abbrVariant && !results.has(abbrVariant)) {
    results.add(abbrVariant);
  }

  // 2. Filler word stripping (high priority for NL queries)
  if (results.size < 3) {
    const keywordVariant = addKeywordVariant(trimmed);
    if (keywordVariant && !results.has(keywordVariant)) {
      results.add(keywordVariant);
    }
  }

  // 3. Case variant
  if (results.size < 3) {
    const caseVariant = addCaseVariant(trimmed);
    if (caseVariant && !results.has(caseVariant)) {
      results.add(caseVariant);
    }
  }

  // 4. Plural normalization
  if (results.size < 3) {
    const pluralVariant = addPluralVariant(words);
    if (pluralVariant && !results.has(pluralVariant)) {
      results.add(pluralVariant);
    }
  }

  return Array.from(results).slice(0, 3);
}
