import { createHash } from 'node:crypto';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'how',
  'what',
  'when',
  'where',
  'why',
  'who',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'shall',
  'may',
  'might',
  'must',
  'about',
  'into',
  'than',
  'then',
  'over',
  'under',
]);

export function normalizeQuery(query: string): string {
  return query.toLowerCase().trim();
}

export function tokenizeQuery(query: string): string[] {
  const normalized = normalizeQuery(query)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[^\p{L}\p{N}_]+/gu, ' ');
  const seen = new Set<string>();
  for (const tok of normalized.split(/\s+/)) {
    if (!tok) continue;
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    seen.add(tok);
  }
  return Array.from(seen).sort();
}

export function hashQuery(query: string): string {
  return createHash('sha1').update(normalizeQuery(query)).digest('hex');
}
