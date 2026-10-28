/**
 * Rank-time adjustments for `search_code`. They change the order only: the
 * score shown to the agent (and the confidence thresholds) stay the cosine
 * similarity.
 *
 * Every factor was fixed before it was measured and kept only because it held
 * on query sets it was not chosen on (see docs/benchmarking.md).
 */

/**
 * A test that names a symbol tends to mention it more often than the code that
 * defines it, so for an identifier query the test outranked the definition. On
 * the retrieval bench a ×0.9 demotion moved file MRR 0.825 → 0.881 (R@1 0.66 →
 * 0.75) and changed nothing where tests are not indexed.
 */
export const TEST_FILE_DEMOTION = 0.9;

/**
 * A query naming a class or function (`InvoiceTotal`, `charge_card`,
 * `Billing::Invoice`) is usually after the code that defines it. Chunks whose
 * `defines_symbols` contain one of those names, and files named after one, move
 * up. Together with {@link definitionCandidatesFilter} and the change-frequency
 * prior, on real agent queries over a Ruby codebase that no setting was chosen
 * on, the right file came first for 82% of queries instead of 64%.
 */
export const DEFINES_IDENTIFIER_BOOST = 1.1;
export const FILE_NAMED_AFTER_IDENTIFIER_BOOST = 1.05;

/**
 * A query that is nothing but one identifier (`charge_card`, `Billing::Invoice`)
 * asks for its definition, yet a short chunk that only imports, re-exports or
 * explains the name can score well above it. For such a query the defining chunk
 * gets this instead of {@link DEFINES_IDENTIFIER_BOOST}. On 50 such queries built
 * from a private Ruby codebase (a name defined in one file and used in at least two
 * others) the defining file came first for 80% of them instead of 62%; on this
 * repository's query set for 79% of all queries instead of 75%; the other query
 * sets, which have no such queries, did not change.
 */
export const BARE_IDENTIFIER_DEFINES_BOOST = 1.25;

/**
 * Files that change often are where the code people ask about tends to live.
 * The key grows by up to 5% with the file's commit-count percentile in its
 * project (`file_churn`, written at index time). On the bench it put the right
 * file first for one more hold-out query (58% instead of 55%) and changed
 * nothing on the other query sets.
 */
export const CHURN_WEIGHT = 0.05;

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_(test|spec)\.[^/]+$/i;
const TEST_QUERY_RE = /(^|[^a-z])(tests?|testing|specs?|rspec|vitest|jest)([^a-z]|$)/i;
const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.|#)[A-Za-z_][A-Za-z0-9_]*)*/g;
const QUALIFIER_RE = /::|\.|#/;
const BARE_QUERY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.|#)[A-Za-z_][A-Za-z0-9_]*)*[?!]?$/;

export function isTestPath(file: string): boolean {
  return TEST_PATH_RE.test(file);
}

/**
 * Where a file's tests sit by convention, for when tests are not indexed:
 * `app/models/invoice.rb` → `spec/models/invoice_spec.rb`, `test/models/invoice_test.rb`;
 * `src/queue.ts` → `src/queue.test.ts`, `src/queue.spec.ts`. Empty for other files.
 */
export function conventionalTestPaths(file: string): string[] {
  if (isTestPath(file)) return [];
  const ruby = /^(.*)\.rb$/.exec(file);
  if (ruby) {
    const rest = ruby[1]!.replace(/^app\//, '');
    return [`spec/${rest}_spec.rb`, `test/${rest}_test.rb`];
  }
  const script = /^(.*)\.(tsx?|jsx?|mjs|cjs)$/.exec(file);
  if (script) return [`${script[1]}.test.${script[2]}`, `${script[1]}.spec.${script[2]}`];
  return [];
}

/** Whether the query asks about tests, in which case test files keep their rank. */
export function mentionsTests(query: string): boolean {
  return TEST_QUERY_RE.test(query);
}

/**
 * Query tokens shaped like code identifiers — snake_case, camelCase,
 * PascalCase compounds, `A::B`, `a.b`, `A#b` — plus the parts of qualified
 * names. Plain words ("invoice", "Invoice") are not identifiers.
 */
export function identifierTokens(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(IDENTIFIER_RE)) {
    const token = m[0];
    const shaped =
      token.includes('_') ||
      QUALIFIER_RE.test(token) ||
      /[a-z][A-Z]/.test(token) ||
      /^[A-Z][a-z]+[A-Z]/.test(token);
    if (!shaped || token.length < 3) continue;
    out.add(token);
    for (const part of token.split(QUALIFIER_RE)) {
      if (part.length >= 3) out.add(part);
    }
  }
  return [...out];
}

/** How many chunks defining a query identifier `search_code` adds to its candidates. */
export const DEFINITION_CANDIDATES = 10;

/**
 * Extra Qdrant filter for chunks that define one of `identifiers`. Dense search
 * alone can leave a definition out of the candidates it re-ranks; `search_code`
 * adds the {@link DEFINITION_CANDIDATES} closest of these.
 */
export function definitionCandidatesFilter(identifiers: string[]): {
  must: Array<Record<string, unknown>>;
} {
  return { must: [{ key: 'defines_symbols', match: { any: identifiers } }] };
}

function normaliseName(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

function fileStem(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '');
}

export interface RankedFields {
  score: number;
  file: string;
  defines_symbols?: string[];
  file_churn?: number | null;
}

/** The query-side inputs of {@link rankKey}, computed once per query. */
export interface RankQuery {
  mentionsTests: boolean;
  identifiers: Set<string>;
  identifierNames: Set<string>;
  /** The whole query is one identifier. */
  bare: boolean;
}

export function rankQuery(query: string): RankQuery {
  const identifiers = identifierTokens(query);
  return {
    mentionsTests: mentionsTests(query),
    identifiers: new Set(identifiers),
    identifierNames: new Set(identifiers.map(normaliseName)),
    bare: identifiers.length > 0 && BARE_QUERY_RE.test(query.trim()),
  };
}

/** Ordering key for a `search_code` result: the similarity with the adjustments above. */
export function rankKey(query: string | RankQuery, result: RankedFields): number {
  const q = typeof query === 'string' ? rankQuery(query) : query;
  let key = result.score;
  if (!q.mentionsTests && isTestPath(result.file)) key *= TEST_FILE_DEMOTION;
  if (q.identifiers.size > 0) {
    if (result.defines_symbols?.some((s) => q.identifiers.has(s))) {
      key *= q.bare ? BARE_IDENTIFIER_DEFINES_BOOST : DEFINES_IDENTIFIER_BOOST;
    }
    if (q.identifierNames.has(normaliseName(fileStem(result.file)))) {
      key *= FILE_NAMED_AFTER_IDENTIFIER_BOOST;
    }
  }
  key *= 1 + CHURN_WEIGHT * (result.file_churn ?? 0);
  return key;
}
