/**
 * Rank-time adjustments for `search_code`. They change the order only: the
 * score shown to the agent (and the confidence thresholds) stay the cosine
 * similarity.
 */

/**
 * A test that names a symbol tends to mention it more often than the code that
 * defines it, so for an identifier query the test outranked the definition. On
 * the retrieval bench a ×0.9 demotion moved file MRR 0.825 → 0.879 (R@1 0.66 →
 * 0.75) and changed nothing where tests are not indexed.
 */
export const TEST_FILE_DEMOTION = 0.9;

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[^/]+$|_(test|spec)\.[^/]+$/i;
const TEST_QUERY_RE = /(^|[^a-z])(tests?|testing|specs?|rspec|vitest|jest)([^a-z]|$)/i;

export function isTestPath(file: string): boolean {
  return TEST_PATH_RE.test(file);
}

/** Whether the query asks about tests, in which case test files keep their rank. */
export function mentionsTests(query: string): boolean {
  return TEST_QUERY_RE.test(query);
}

/** Ordering key for a `search_code` result: the similarity, demoted for test files. */
export function rankKey(query: string, result: { score: number; file: string }): number {
  if (isTestPath(result.file) && !mentionsTests(query)) {
    return result.score * TEST_FILE_DEMOTION;
  }
  return result.score;
}
