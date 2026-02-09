/**
 * Jina Code Embeddings task-specific prefixes.
 *
 * Jina models are trained with task prefixes that significantly improve
 * embedding quality (+15-20% accuracy). Each task type has a query prefix
 * and a passage prefix.
 *
 * @see https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF
 */

export type QueryType = 'nl2code' | 'code2code' | 'techqa';

interface TaskPrefixes {
  query: string;
  passage: string;
}

const TASK_PREFIXES: Record<QueryType, TaskPrefixes> = {
  nl2code: {
    query: 'Find the most relevant code snippet given the following query:\n',
    passage: 'Candidate code snippet:\n',
  },
  code2code: {
    query: 'Find an equivalent code snippet given the following code snippet:\n',
    passage: 'Candidate code snippet:\n',
  },
  techqa: {
    query: 'Find the most relevant technical answer given the following technical question:\n',
    passage: 'Candidate technical answer:\n',
  },
};

/** Configuration for task-specific prefixes */
export interface TaskPrefixConfig {
  /** Enable task-specific prefixes (default: false) */
  enabled: boolean;
}

const CODE_INDICATORS = [
  /\bfunction\s+\w/,
  /\bconst\s+\w/,
  /\blet\s+\w/,
  /\bvar\s+\w/,
  /\bclass\s+\w/,
  /\bdef\s+\w/,
  /\bimport\s+/,
  /\brequire\s*\(/,
  /=>/,
  /[{};]\s*$/m,
  /^\s*#\s*include/m,
  /\bfunc\s+\w/,
  /\bpub\s+fn\s/,
];

const QUESTION_INDICATORS = [/^(how|what|why|where|when|which|can|does|is|are)\b/i, /\?$/];

/**
 * Detect the query type from the raw query text.
 *
 * - If the query looks like code → `code2code`
 * - If the query looks like a question → `techqa`
 * - Otherwise → `nl2code` (natural language to code, the most common case)
 */
export function detectQueryType(query: string): QueryType {
  const trimmed = query.trim();

  // Check for code patterns first (more specific)
  for (const pattern of CODE_INDICATORS) {
    if (pattern.test(trimmed)) return 'code2code';
  }

  // Check for question patterns
  for (const pattern of QUESTION_INDICATORS) {
    if (pattern.test(trimmed)) return 'techqa';
  }

  // Default: natural language searching for code
  return 'nl2code';
}

/** Get the query prefix for a detected query type */
export function getQueryPrefix(queryType: QueryType): string {
  return TASK_PREFIXES[queryType].query;
}

/** Get the passage prefix (used at indexing time) */
export function getPassagePrefix(): string {
  // All task types use the same passage prefix for code snippets
  return TASK_PREFIXES.nl2code.passage;
}

/** Prepend the appropriate query prefix based on auto-detected query type */
export function prefixQuery(query: string): string {
  const queryType = detectQueryType(query);
  return getQueryPrefix(queryType) + query;
}

/** Prepend the passage prefix to a code chunk */
export function prefixPassage(passage: string): string {
  return getPassagePrefix() + passage;
}
