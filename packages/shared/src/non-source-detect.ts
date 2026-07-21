/**
 * Heuristic detection of non-source content — base64/data-URI blobs, minified
 * bundles, and other machine-generated text that has a source-file extension but
 * no source-file structure.
 *
 * Why this exists: files like `convex/export/pptx/assets/bg.data.ts` are `.ts`
 * by name (so language detection routes them to the AST/embedding path) but hold
 * a single multi-hundred-KB base64 string literal. Embedding that is worthless
 * for retrieval and pathological for the model — a dense wall of high-entropy
 * tokens drives llama-server into timeouts/OOM. We detect and skip such content
 * BEFORE it ever reaches the embedder.
 *
 * The signal is structural, not name-based (name globs are a separate, coarser
 * defence in language-excludes.ts): real source code has short lines, plenty of
 * whitespace, and a modest alphabet; machine blobs have enormous lines, little
 * whitespace, and a base64-dominated character distribution. Pure function so it
 * is trivially testable and identical for the file-level and chunk-level checks.
 */

/** Why a piece of content was judged non-source — surfaced in logs/telemetry. */
export interface NonSourceVerdict {
  /** True when the content looks machine-generated / non-source. */
  isNonSource: boolean;
  /** Human-readable reason (e.g. "max line 780191 chars"). Empty when source. */
  reason: string;
}

// Thresholds. Deliberately conservative: real source (even generated-but-readable
// code, long JSON fixtures, SVG paths embedded in JSX) must pass. These fire only
// on genuinely structureless blobs. Tuning notes live next to each constant.

/** A single line this long is not hand-written source — minified/one-line blob. */
const MAX_LINE_LENGTH = 5_000;
/** Average line length above this means almost no line breaks across the file. */
const MAX_AVG_LINE_LENGTH = 1_000;
/** Below this whitespace ratio, text is a dense token wall, not code. */
const MIN_WHITESPACE_RATIO = 0.02;
/** Above this base64-alphabet ratio (over a long span), it's an encoded blob. */
const MAX_BASE64_RATIO = 0.95;
/** Skip the analysis for short content — the ratios are noisy on tiny inputs. */
const MIN_LENGTH_TO_ANALYZE = 512;

// [A-Za-z0-9+/=_-] — the base64 / base64url alphabet plus padding.
const BASE64_CHAR = /[A-Za-z0-9+/=_-]/;
const WHITESPACE_CHAR = /\s/;

/**
 * Judge whether `content` is non-source machine data unsuitable for embedding.
 *
 * Applies to both a whole file (pre-chunking) and an individual chunk
 * (pre-embedding). Short inputs are always treated as source — the statistics
 * are unreliable below {@link MIN_LENGTH_TO_ANALYZE} and a false positive there
 * would drop legitimate small files.
 */
export function detectNonSource(content: string): NonSourceVerdict {
  const source = (): NonSourceVerdict => ({ isNonSource: false, reason: '' });
  if (content.length < MIN_LENGTH_TO_ANALYZE) return source();

  // Longest single line — the strongest single signal for minified/one-line blobs.
  let maxLine = 0;
  let cur = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      if (cur > maxLine) maxLine = cur;
      cur = 0;
    } else {
      cur++;
    }
  }
  if (cur > maxLine) maxLine = cur;
  if (maxLine > MAX_LINE_LENGTH) {
    return { isNonSource: true, reason: `line of ${maxLine} chars (minified/blob)` };
  }

  // Character-distribution pass: whitespace ratio + base64-alphabet dominance.
  let whitespace = 0;
  let base64 = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (WHITESPACE_CHAR.test(ch)) whitespace++;
    else if (BASE64_CHAR.test(ch)) base64++;
  }
  const len = content.length;
  const whitespaceRatio = whitespace / len;
  const base64Ratio = base64 / len;

  // Average line length: total length divided by line count.
  const lineCount = countLines(content);
  const avgLine = len / lineCount;

  if (whitespaceRatio < MIN_WHITESPACE_RATIO && base64Ratio > MAX_BASE64_RATIO) {
    return {
      isNonSource: true,
      reason: `dense base64 blob (${(base64Ratio * 100).toFixed(0)}% base64, ${(
        whitespaceRatio * 100
      ).toFixed(1)}% whitespace)`,
    };
  }
  if (avgLine > MAX_AVG_LINE_LENGTH) {
    return { isNonSource: true, reason: `avg line ${avgLine.toFixed(0)} chars (no structure)` };
  }

  return source();
}

function countLines(content: string): number {
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) n++;
  }
  return n;
}
