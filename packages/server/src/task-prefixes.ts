/**
 * Instruction-aware query prefixes for embedding models.
 *
 * Modern retrieval embedders are instruction-tuned: the QUERY is wrapped in a
 * short task instruction while DOCUMENTS are embedded unprefixed (asymmetric
 * retrieval). We keep the query-type detection (nl2code / code2code / techqa)
 * that meaningfully improves results, and map each detected type to the
 * instruction FORMAT of the active model family.
 *
 * Model families and their query-instruction format:
 * - `bge-code`  (BAAI/bge-code-v1)         → `<instruct>{task}\n<query>{q}`
 * - `qwen`      (Qwen/Qwen3-Embedding)      → `Instruct: {task}\nQuery:{q}`
 * - `none`      (OpenAI/Voyage/unknown)     → no prefix (provider handles task)
 *
 * Documents are always embedded WITHOUT a prefix for these families
 * (per the bge-code-v1 and Qwen3-Embedding model cards).
 *
 * @see https://huggingface.co/BAAI/bge-code-v1
 * @see https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
 */

export type QueryType = 'nl2code' | 'code2code' | 'techqa';

/** Which model family's instruction format to emit. */
export type ModelFamily = 'bge-code' | 'qwen' | 'none';

/**
 * Per-family, per-query-type task instruction text — VERBATIM from each model's
 * OWN card. These strings are NOT free-form; do not paraphrase or "clean up"
 * punctuation.
 *
 * WHY this is strict (not pedantry): bge-code-v1 and Qwen3 are decoder-based
 * embedders using LAST-TOKEN pooling — the entire text representation is read
 * off the final token, which under causal attention is the only token that has
 * "seen" the whole input. They were trained with the exact template
 * `<instruct>{task}\n<query>{q}` and these exact task phrasings, so any
 * off-distribution wording (a changed word, a missing period, an extra space)
 * shifts the last token's tokenization and attention pattern and moves the
 * output vector. Verified on a real repo: a hand-written instruction shifted
 * the entire top-5 and dropped cosine ~0.15, while the card's exact string
 * matched the production baseline. (Encoder models with mean/CLS pooling are
 * far more forgiving — but these two are decoders, so treat the strings as a
 * trained interface, not prose.)
 *
 * Rules: copy a string only from the SAME model's card; never reuse one
 * family's string for another; keep punctuation as-is. BAAI ends its strings
 * with a period, Qwen does not — that inconsistency is intentional (verbatim).
 *
 * bge-code-v1 eval-instructions dict (CosQA / CodeTrans-DL / StackOverFlow-QA):
 *   https://huggingface.co/BAAI/bge-code-v1
 * Qwen3-Embedding gives a single retrieval instruction, no per-task variants:
 *   https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
 */
const QWEN_RETRIEVAL = 'Given a web search query, retrieve relevant passages that answer the query';

const TASK_INSTRUCTION: Record<ModelFamily, Record<QueryType, string>> = {
  'bge-code': {
    // CosQA
    nl2code: 'Given a web search query, retrieve relevant code that can help answer the query.',
    // CodeTrans-DL
    code2code:
      'Given a piece of code, retrieve code that is semantically equivalent to the input code.',
    // StackOverFlow-QA
    techqa:
      'Given a question that consists of a mix of text and code snippets, retrieve relevant answers that also consist of a mix of text and code snippets, and can help answer the question.',
  },
  // Qwen3-Embedding has no per-task instructions — the card shows one retrieval
  // string; use it for every query type.
  qwen: { nl2code: QWEN_RETRIEVAL, code2code: QWEN_RETRIEVAL, techqa: QWEN_RETRIEVAL },
  // 'none' never wraps (see prefixQuery), so these are unused placeholders.
  none: { nl2code: '', code2code: '', techqa: '' },
};

/** Wrap a task instruction + query in the model family's required template. */
function formatInstruction(family: ModelFamily, task: string, query: string): string {
  switch (family) {
    case 'bge-code':
      return `<instruct>${task}\n<query>${query}`;
    case 'qwen':
      return `Instruct: ${task}\nQuery:${query}`;
    case 'none':
      return query;
  }
}

/** Resolve a model name to its instruction family. */
export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes('bge-code')) return 'bge-code';
  if (m.includes('qwen')) return 'qwen';
  return 'none';
}

/** Configuration for instruction prefixes. */
export interface TaskPrefixConfig {
  /** Enable instruction prefixes (default: false). */
  enabled: boolean;
  /** Which model family's instruction format to emit (default: 'none'). */
  family?: ModelFamily;
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

/**
 * Wrap a query in the family's instruction, choosing the task by auto-detected
 * query type. `none` family returns the query unchanged.
 */
export function prefixQuery(query: string, family: ModelFamily = 'none'): string {
  if (family === 'none') return query;
  const task = TASK_INSTRUCTION[family][detectQueryType(query)];
  return formatInstruction(family, task, query);
}

/**
 * Documents are embedded WITHOUT an instruction prefix for the supported
 * instruction-tuned families (bge-code-v1, Qwen3-Embedding). Kept as a function
 * so the call sites stay symmetric with {@link prefixQuery}.
 */
export function prefixPassage(passage: string, _family: ModelFamily = 'none'): string {
  return passage;
}
