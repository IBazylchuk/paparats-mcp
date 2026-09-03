/**
 * YAML frontmatter for markdown documents.
 *
 * Docs mirrored from a wiki or document store carry their provenance in a
 * leading `---` block rather than in the prose. Without parsing it three things
 * go wrong at once, all invisible at the call site because every affected field
 * is optional:
 *
 * - the canonical link is lost, so results cite no source;
 * - the title falls back to the filename, which for an export is an opaque slug
 *   (`billing-reporting-1234567890.md`) instead of the page title;
 * - the modification date falls back to the file's mtime, which in a freshly
 *   cloned mirror is the clone time, making every document look equally recent.
 *
 * The block is also stripped from the content. `---` is a valid thematic break,
 * so an unstripped block is chunked as prose: the first chunk of every document
 * becomes raw YAML with no readable text, which then gets embedded and skews the
 * BM25 corpus statistics.
 */

import * as yaml from 'js-yaml';

/** Frontmatter keys read as the canonical link, in order of preference. */
const URL_KEYS = ['source_url', 'url', 'source_link', 'link', 'canonical_url'] as const;

/** Keys read as the document title. */
const TITLE_KEYS = ['title', 'doc_title', 'page_title'] as const;

/** Keys read as the last content modification timestamp. */
const DATE_KEYS = ['last_modified', 'last_modified_at', 'updated_at', 'modified', 'date'] as const;

/**
 * A frontmatter block must open on the very first line. A `---` further down is
 * a thematic break, not metadata.
 */
const OPENING_FENCE = /^---[ \t]*\r?\n/;

export interface ParsedFrontmatter {
  /** Document body with the frontmatter block removed. */
  content: string;
  /** Canonical link, when the block carried one. */
  sourceUrl: string | null;
  /** Document title, when the block carried one. */
  title: string | null;
  /** Last modification time in unix epoch milliseconds, when parseable. */
  lastModifiedAt: number | null;
  /** Every scalar key from the block, for callers that want the raw values. */
  fields: Record<string, string>;
}

/**
 * Split a leading YAML frontmatter block off a markdown document.
 *
 * Never throws: malformed YAML, an unterminated block, or a document with no
 * block at all all yield the input content unchanged with null metadata. A
 * document that fails to parse is still worth indexing for its prose.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const empty: ParsedFrontmatter = {
    content: raw,
    sourceUrl: null,
    title: null,
    lastModifiedAt: null,
    fields: {},
  };

  const opening = OPENING_FENCE.exec(raw);
  if (!opening) return empty;

  const bodyStart = opening[0].length;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw.slice(bodyStart));
  if (!closing) return empty; // unterminated — treat the whole file as prose

  const block = raw.slice(bodyStart, bodyStart + closing.index);
  const content = raw.slice(bodyStart + closing.index + closing[0].length);

  let parsed: unknown;
  try {
    // JSON_SCHEMA to match every other yaml.load in this repo: no custom tags,
    // no timestamp/binary types, so a document cannot influence parsing beyond
    // plain JSON values.
    parsed = yaml.load(block, { schema: yaml.JSON_SCHEMA });
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const scalar = toScalar(value);
    if (scalar !== null) fields[key.toLowerCase()] = scalar;
  }

  return {
    content,
    sourceUrl: pickUrl(fields),
    title: pick(fields, TITLE_KEYS),
    lastModifiedAt: pickDate(fields),
    fields,
  };
}

/**
 * Render a scalar frontmatter value as a string. Under JSON_SCHEMA timestamps
 * stay strings and are parsed by {@link pickDate}; a bare page id still arrives
 * as a number. Non-scalars (nested maps, lists) are dropped.
 */
function toScalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function pick(fields: Record<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
}

/** Only http(s) links are accepted — a relative path is not a canonical link. */
function pickUrl(fields: Record<string, string>): string | null {
  const raw = pick(fields, URL_KEYS);
  if (raw === null) return null;
  return /^https?:\/\/\S+$/i.test(raw) ? raw : null;
}

function pickDate(fields: Record<string, string>): number | null {
  const raw = pick(fields, DATE_KEYS);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}
