import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../src/docs/frontmatter.js';

/**
 * The two frontmatter shapes export tooling produces: a wiki page and an
 * office-document link. The `> Source:` line is kept because exporters
 * duplicate the link into the body, and the parser must not depend on it.
 */
const WIKI_EXPORT = `---
source: wiki
page_id: "1234567890"
title: "Billing Reporting"
source_url: "https://wiki.example.com/wiki/pages/1234567890"
space_id: "222333"
last_modified: "2026-02-04T16:05:12.015Z"
status: "up_to_date"
---

# Billing Reporting

> Source: https://wiki.example.com/wiki/pages/1234567890

## Overview

Some prose.
`;

const DOC_EXPORT = `---
source: docstore
title: "Billing Reporting.docx"
source_url: "https://docs.example.com/sites/product/Doc.aspx?sourcedoc=%7B29E0%7D"
site: "product"
last_modified: "2025-11-12T14:30:31Z"
status: "unknown"
---

# Billing Reporting

Release notes.
`;

describe('parseFrontmatter', () => {
  it('reads link, title and date from a wiki export', () => {
    const r = parseFrontmatter(WIKI_EXPORT);
    expect(r.sourceUrl).toBe('https://wiki.example.com/wiki/pages/1234567890');
    expect(r.title).toBe('Billing Reporting');
    expect(r.lastModifiedAt).toBe(Date.parse('2026-02-04T16:05:12.015Z'));
    expect(r.fields['source']).toBe('wiki');
    expect(r.fields['page_id']).toBe('1234567890');
  });

  it('reads the same fields from a document-store export', () => {
    const r = parseFrontmatter(DOC_EXPORT);
    expect(r.sourceUrl).toContain('docs.example.com');
    expect(r.title).toBe('Billing Reporting.docx');
    expect(r.lastModifiedAt).toBe(Date.parse('2025-11-12T14:30:31Z'));
  });

  it('strips the block so YAML is never chunked as prose', () => {
    const r = parseFrontmatter(WIKI_EXPORT);
    expect(r.content).not.toContain('source_url:');
    expect(r.content).not.toContain('space_id:');
    expect(r.content.trimStart().startsWith('# Billing Reporting')).toBe(true);
  });

  it('leaves a document without frontmatter untouched', () => {
    const raw = '# Title\n\nBody text.\n';
    const r = parseFrontmatter(raw);
    expect(r.content).toBe(raw);
    expect(r.sourceUrl).toBeNull();
    expect(r.title).toBeNull();
    expect(r.lastModifiedAt).toBeNull();
  });

  it('ignores a thematic break that is not a frontmatter block', () => {
    // `---` mid-document is a horizontal rule; only a block on line 1 counts.
    const raw = '# Title\n\n---\n\ntitle: not metadata\n\n---\n\nBody.\n';
    const r = parseFrontmatter(raw);
    expect(r.content).toBe(raw);
    expect(r.title).toBeNull();
  });

  it('treats an unterminated block as prose rather than truncating the document', () => {
    const raw = '---\ntitle: "Half a block"\n\n# Body that never closes the fence\n';
    const r = parseFrontmatter(raw);
    expect(r.content).toBe(raw);
    expect(r.title).toBeNull();
  });

  it('survives malformed YAML without losing the document', () => {
    const raw = '---\ntitle: "unclosed\n  bad: [\n---\n\n# Body\n';
    const r = parseFrontmatter(raw);
    expect(r.content).toBe(raw);
    expect(r.sourceUrl).toBeNull();
  });

  it('rejects a non-http link', () => {
    // A relative path is not a canonical link — citing it would produce a
    // dead reference in the client.
    const r = parseFrontmatter('---\nsource_url: "../other/page.md"\n---\n\n# Body\n');
    expect(r.sourceUrl).toBeNull();
  });

  it('accepts alternative key spellings', () => {
    const r = parseFrontmatter('---\nurl: "https://example.com/p"\npage_title: "P"\n---\n\n# B\n');
    expect(r.sourceUrl).toBe('https://example.com/p');
    expect(r.title).toBe('P');
  });

  it('ignores an unparseable date instead of inventing one', () => {
    const r = parseFrontmatter('---\nlast_modified: "not a date"\n---\n\n# B\n');
    expect(r.lastModifiedAt).toBeNull();
  });

  it('drops non-scalar values but keeps the rest of the block', () => {
    const raw = '---\ntitle: "T"\nlabels:\n  - a\n  - b\n---\n\n# B\n';
    const r = parseFrontmatter(raw);
    expect(r.title).toBe('T');
    expect(r.fields['labels']).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    const raw = '---\r\ntitle: "T"\r\nsource_url: "https://example.com/x"\r\n---\r\n\r\n# B\r\n';
    const r = parseFrontmatter(raw);
    expect(r.title).toBe('T');
    expect(r.sourceUrl).toBe('https://example.com/x');
    expect(r.content).not.toContain('title:');
  });
});
