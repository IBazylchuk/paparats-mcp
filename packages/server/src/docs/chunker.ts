import type { DocsChunk, MarkdownChunkOptions } from './types.js';

/**
 * Structural markdown chunker for the docs layer.
 *
 * Pipeline (see docs/chunking-strategy.md for the research):
 *   1. Split by markdown heading (ATX `#`..`######`) into sections.
 *   2. Sub-split oversized sections by paragraph to ~targetTokens, overlap 0.
 *   3. Prepend the heading breadcrumb (`Doc > H1 > H2`) to each chunk's text.
 *
 * Input MUST be markdown — {@link detectMarkdown} gates this. Non-markdown
 * (plain text, binary, other formats) throws {@link NotMarkdownError}; the
 * indexing walk logs and skips such files. This is a deliberate strict policy:
 * plain text is a valid-but-unwanted input, so we require a POSITIVE markdown
 * signal rather than "not binary → assume markdown".
 */

/** Thrown by {@link chunkMarkdown} when the input is not recognised as markdown. */
export class NotMarkdownError extends Error {
  constructor(reason: string) {
    super(`Input is not markdown: ${reason}`);
    this.name = 'NotMarkdownError';
  }
}

const DEFAULT_TARGET_TOKENS = 320;

// ── Markdown detection ──────────────────────────────────────────────────────

/** A NUL byte is a reliable binary marker — text files never contain one. */
// eslint-disable-next-line no-control-regex
const NUL_BYTE_RE = /\x00/;

const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/m;
const FENCED_CODE = /^ {0,3}(?:```|~~~)/m;
const UNORDERED_LIST = /^ {0,3}[-*+]\s+\S/m;
const ORDERED_LIST = /^ {0,3}\d+[.)]\s+\S/m;
const TABLE_ROW = /^ {0,3}\|.*\|/m;
const BLOCKQUOTE = /^ {0,3}>\s/m;
const LINK_OR_IMAGE = /!?\[[^\]]+\]\([^)]+\)/;
const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m;

/**
 * Positive markdown detection. Returns true only when the content carries at
 * least one unambiguous markdown construct — a heading, fenced code block, or
 * table always qualify on their own; the weaker signals (lists, blockquotes,
 * links, thematic breaks) each count once and need TWO distinct kinds to pass,
 * so a plain-text file that merely happens to contain a hyphen bullet or a
 * parenthesised URL is not mistaken for markdown.
 *
 * A NUL byte (binary) is rejected outright.
 */
export function detectMarkdown(content: string): boolean {
  if (content.length === 0) return false;
  if (NUL_BYTE_RE.test(content)) return false;

  // Strong signals — any one is sufficient.
  if (ATX_HEADING.test(content)) return true;
  if (FENCED_CODE.test(content)) return true;
  if (TABLE_ROW.test(content)) return true;

  // Weak signals — need at least two DISTINCT kinds so a stray bullet or URL in
  // prose doesn't false-positive.
  let weak = 0;
  if (UNORDERED_LIST.test(content)) weak++;
  if (ORDERED_LIST.test(content)) weak++;
  if (BLOCKQUOTE.test(content)) weak++;
  if (LINK_OR_IMAGE.test(content)) weak++;
  if (THEMATIC_BREAK.test(content)) weak++;
  return weak >= 2;
}

// ── Opaque-blob elision ─────────────────────────────────────────────────────

/**
 * Runs shorter than this are left alone: real prose never gets this long without
 * a space, but short unbroken tokens (hashes, ids, long URLs) carry real signal.
 */
const OPAQUE_RUN_MIN_CHARS = 500;

/**
 * A long unbroken run over the base64/base64url/hex alphabet — an embedded
 * payload rather than text. Both alphabets are covered by one class (base64url
 * adds `-`/`_`, and `%` catches percent-encoded blobs); `=` allows the padding.
 */
const OPAQUE_RUN_RE = new RegExp(`[A-Za-z0-9+/\\-_%]{${OPAQUE_RUN_MIN_CHARS},}={0,2}`, 'g');

/** What replaces an elided run, so the surrounding text still reads sensibly. */
function opaquePlaceholder(length: number): string {
  return `[binary data elided, ${length} chars]`;
}

/**
 * Replace embedded binary payloads with a short placeholder.
 *
 * Documentation regularly embeds base64 — an example request carrying a file
 * upload, an inline `data:` image, a certificate. Such a run is pure noise for
 * retrieval: it has no natural language to match a query, yet it dominates its
 * chunk's embedding and (before this) could produce a single 4k-token chunk that
 * crowded the page's actual prose out of the index.
 *
 * It also can't be fixed downstream: a payload is typically ONE line, and the
 * oversized-block fallback splits by lines, so it had nothing to cut.
 *
 * Elision is length-preserving at line granularity — the replacement contains no
 * newline — so every chunk's reported startLine/endLine still matches the source
 * file. The placeholder keeps the length, which is the only part a reader might
 * care about ("a PDF was attached here").
 */
export function elideOpaqueRuns(content: string): string {
  return content.replace(OPAQUE_RUN_RE, (run) => opaquePlaceholder(run.length));
}

// ── Token counting (heuristic) ──────────────────────────────────────────────

/**
 * Cheap token estimate — we do NOT run the model tokenizer at chunk time (it
 * would couple the chunker to the embedding backend and slow indexing). ~4 chars
 * per token is the well-worn rule of thumb for English prose; good enough to
 * keep chunks in the 200–400 target band without being exact.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Section model ───────────────────────────────────────────────────────────

interface Section {
  /** Heading text without the leading `#`s. Empty for the pre-first-heading preamble. */
  heading: string;
  /** Heading level 1..6. 0 for the preamble (no heading). */
  level: number;
  /** Body lines (excludes the heading line itself). */
  lines: string[];
  /** 0-indexed source line of the first body line (or the heading line for the preamble edge). */
  startLine: number;
}

const HEADING_LINE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;

/** Split raw markdown into heading-delimited sections, preserving source line offsets. */
function splitIntoSections(content: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Track fenced code so a `#` inside a code block isn't treated as a heading.
    const fenceOpen = line.match(/^ {0,3}(```+|~~~+)/);
    if (fenceOpen) {
      const marker = fenceOpen[1] ?? '';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0] ?? '`';
      } else if (marker[0] === fenceMarker) {
        inFence = false;
      }
    }

    const headingMatch = inFence ? null : line.match(HEADING_LINE);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        heading: (headingMatch[2] ?? '').trim(),
        level: (headingMatch[1] ?? '').length,
        lines: [],
        startLine: i + 1, // body starts on the next line
      };
    } else {
      if (!current) {
        // Preamble before the first heading.
        current = { heading: '', level: 0, lines: [], startLine: i };
      }
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ── Breadcrumb ──────────────────────────────────────────────────────────────

/**
 * Compute the heading trail for a section by walking previously-seen headings
 * and keeping only ancestors (strictly lower level). e.g. under H1 "Runbook" →
 * H2 "Deploy" → H3 "Rollback", the H3's path is [Runbook, Deploy, Rollback].
 */
function computeHeadingPath(sections: Section[], index: number): string[] {
  const target = sections[index];
  if (!target || target.level === 0) return [];
  const path: string[] = [target.heading];
  let level = target.level;
  for (let i = index - 1; i >= 0 && level > 1; i--) {
    const s = sections[i];
    if (!s || s.level === 0) continue;
    if (s.level < level) {
      path.unshift(s.heading);
      level = s.level;
    }
  }
  return path;
}

/** Render the breadcrumb prefix prepended to each chunk's embedded text. */
function renderBreadcrumb(docTitle: string | undefined, headingPath: string[]): string {
  const parts = [docTitle, ...headingPath].filter((p): p is string => !!p && p.length > 0);
  return parts.join(' > ');
}

// ── Paragraph sub-splitting ─────────────────────────────────────────────────

interface Block {
  text: string;
  /** 0-indexed source line offset of this block's first line. */
  startLine: number;
  endLine: number;
}

/**
 * Group section body lines into paragraph blocks (blank-line separated), keeping
 * fenced code blocks intact as single blocks so we never split mid-code.
 */
function toParagraphBlocks(lines: string[], sectionStart: number): Block[] {
  const blocks: Block[] = [];
  let buf: string[] = [];
  let bufStart = sectionStart;
  let inFence = false;
  let fenceMarker = '';

  const flush = (endLine: number) => {
    const text = buf.join('\n').trim();
    if (text.length > 0) blocks.push({ text, startLine: bufStart, endLine });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const abs = sectionStart + i;
    const fenceOpen = line.match(/^ {0,3}(```+|~~~+)/);
    if (fenceOpen) {
      const marker = (fenceOpen[1] ?? '')[0] ?? '`';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
    }
    if (!inFence && line.trim() === '') {
      flush(abs - 1);
      bufStart = abs + 1;
      continue;
    }
    if (buf.length === 0) bufStart = abs;
    buf.push(line);
  }
  flush(sectionStart + lines.length - 1);
  return blocks;
}

// ── Main entry ──────────────────────────────────────────────────────────────

/**
 * Chunk markdown into structural, breadcrumb-augmented chunks.
 *
 * @throws {NotMarkdownError} when {@link detectMarkdown} rejects the input.
 */
export function chunkMarkdown(content: string, opts: MarkdownChunkOptions = {}): DocsChunk[] {
  if (!detectMarkdown(content)) {
    throw new NotMarkdownError('no markdown structure detected');
  }
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const maxTokens = opts.maxTokens ?? Math.ceil(targetTokens * 1.5);

  // Detection runs on the raw input (elision must not change what counts as
  // markdown), but chunking runs on the elided text so embedded payloads never
  // reach an embedding. Line numbering is unaffected — see elideOpaqueRuns.
  const sections = splitIntoSections(elideOpaqueRuns(content));
  const chunks: DocsChunk[] = [];
  let chunkIndex = 0;

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s];
    if (!section) continue;
    const headingPath = computeHeadingPath(sections, s);
    const breadcrumb = renderBreadcrumb(opts.docTitle, headingPath);

    const blocks = toParagraphBlocks(section.lines, section.startLine);
    if (blocks.length === 0) continue;

    // Greedily pack paragraph blocks into chunks up to targetTokens. A single
    // block exceeding maxTokens is force-split by lines.
    let packed: Block[] = [];
    let packedTokens = 0;

    const emit = () => {
      if (packed.length === 0) return;
      const body = packed.map((b) => b.text).join('\n\n');
      const text = breadcrumb ? `${breadcrumb}\n\n${body}` : body;
      const first = packed[0];
      const last = packed[packed.length - 1];
      chunks.push({
        content: text,
        headingPath,
        startLine: first ? first.startLine : section.startLine,
        endLine: last ? last.endLine : section.startLine,
        chunkIndex: chunkIndex++,
      });
      packed = [];
      packedTokens = 0;
    };

    for (const block of blocks) {
      const blockTokens = estimateTokens(block.text);
      if (blockTokens > maxTokens) {
        // Flush what we have, then hard-split the oversized block by lines.
        emit();
        for (const piece of forceSplitBlock(block, maxTokens)) {
          const text = breadcrumb ? `${breadcrumb}\n\n${piece.text}` : piece.text;
          chunks.push({
            content: text,
            headingPath,
            startLine: piece.startLine,
            endLine: piece.endLine,
            chunkIndex: chunkIndex++,
          });
        }
        continue;
      }
      if (packedTokens + blockTokens > targetTokens && packed.length > 0) {
        emit();
      }
      packed.push(block);
      packedTokens += blockTokens;
    }
    emit();
  }

  return chunks;
}

/**
 * Hard-split a single oversized block by lines into <=maxTokens pieces (overlap 0).
 *
 * Splitting by line alone is not sufficient: a block can be a SINGLE line longer
 * than maxTokens (a one-line table, a minified asset, a payload that survived
 * elision), which leaves nothing to cut between. Such a line is therefore split
 * on character count as a last resort, preferring a whitespace boundary so words
 * stay intact where possible.
 */
function forceSplitBlock(block: Block, maxTokens: number): Block[] {
  // Each entry carries the SOURCE line it came from. One source line can yield
  // several entries, so a piece's line number cannot be derived from its index
  // in this array — deriving it would silently shift every subsequent chunk's
  // reported range.
  const units: Array<{ text: string; line: number }> = [];
  const rawLines = block.text.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const sourceLine = block.startLine + i;
    for (const part of splitLongLine(rawLines[i] ?? '', maxTokens)) {
      units.push({ text: part, line: sourceLine });
    }
  }

  const pieces: Block[] = [];
  let buf: Array<{ text: string; line: number }> = [];

  const flush = () => {
    const text = buf
      .map((u) => u.text)
      .join('\n')
      .trim();
    const first = buf[0];
    const last = buf[buf.length - 1];
    if (text.length > 0 && first && last) {
      pieces.push({ text, startLine: first.line, endLine: last.line });
    }
    buf = [];
  };

  for (const unit of units) {
    buf.push(unit);
    if (estimateTokens(buf.map((u) => u.text).join('\n')) >= maxTokens) flush();
  }
  flush();
  return pieces;
}

/**
 * Split one line into pieces of at most maxTokens, or return it as-is when it
 * already fits. Prefers cutting at the last whitespace inside the window so
 * words survive; falls back to a hard character cut when there is none (which is
 * the normal case for the opaque payloads this exists for).
 */
function splitLongLine(line: string, maxTokens: number): string[] {
  const maxChars = maxTokens * 4; // inverse of estimateTokens
  if (line.length <= maxChars) return [line];

  const parts: string[] = [];
  let rest = line;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const ws = window.lastIndexOf(' ');
    // Only honour a space that is reasonably deep into the window; a space near
    // the start would produce a long tail of tiny fragments.
    const cut = ws > maxChars / 2 ? ws : maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
