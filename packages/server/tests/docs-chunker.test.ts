import { describe, it, expect } from 'vitest';
import {
  detectMarkdown,
  chunkMarkdown,
  elideOpaqueRuns,
  estimateTokens,
  NotMarkdownError,
} from '../src/docs/chunker.js';

describe('detectMarkdown', () => {
  it('accepts content with an ATX heading', () => {
    expect(detectMarkdown('# Title\n\nsome text')).toBe(true);
  });

  it('accepts a fenced code block', () => {
    expect(detectMarkdown('here is code\n\n```js\nconst x = 1;\n```\n')).toBe(true);
  });

  it('accepts a table', () => {
    expect(detectMarkdown('col a | col b\n| a | b |\n')).toBe(true);
  });

  it('accepts two distinct weak signals (list + link)', () => {
    expect(detectMarkdown('- item one\n\nsee [docs](http://x)')).toBe(true);
  });

  it('rejects plain prose with no markdown structure', () => {
    expect(detectMarkdown('This is just a paragraph of plain text with no structure at all.')).toBe(
      false
    );
  });

  it('rejects prose with a single weak signal (a lone URL is not enough)', () => {
    // A parenthesised URL alone must not be mistaken for markdown.
    expect(detectMarkdown('Visit our site [here](http://example.com) for details.')).toBe(false);
  });

  it('rejects prose with a lone hyphen bullet (single weak signal)', () => {
    expect(detectMarkdown('Shopping list\n- milk')).toBe(false);
  });

  it('rejects empty content', () => {
    expect(detectMarkdown('')).toBe(false);
  });

  it('rejects binary content (NUL byte)', () => {
    expect(detectMarkdown('# looks like md\x00but has a nul')).toBe(false);
  });

  it('does not treat a # inside a fenced code block as a heading-only signal', () => {
    // The fence itself is the strong signal here; ensure fenced content passes.
    const md = 'intro\n\n```python\n# a comment\nprint(1)\n```\n';
    expect(detectMarkdown(md)).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('approximates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('chunkMarkdown', () => {
  it('throws NotMarkdownError on plain text', () => {
    expect(() => chunkMarkdown('just plain prose, nothing markdown here')).toThrow(
      NotMarkdownError
    );
  });

  it('splits by heading into sections', () => {
    const md = [
      '# Doc',
      '',
      'intro para',
      '',
      '## Section A',
      '',
      'body a',
      '',
      '## Section B',
      '',
      'body b',
    ].join('\n');
    const chunks = chunkMarkdown(md);
    // Preamble under H1 + Section A + Section B → at least 3 chunks with distinct paths.
    const paths = chunks.map((c) => c.headingPath.join(' > '));
    expect(paths).toContain('Doc');
    expect(paths).toContain('Doc > Section A');
    expect(paths).toContain('Doc > Section B');
  });

  it('prepends the heading breadcrumb to chunk content', () => {
    const md = '# Runbook\n\n## Deploy\n\n### Rollback\n\nrun the rollback script';
    const chunks = chunkMarkdown(md, { docTitle: 'Ops Guide' });
    const rollback = chunks.find(
      (c) => c.headingPath.join(' > ') === 'Runbook > Deploy > Rollback'
    );
    expect(rollback).toBeDefined();
    expect(rollback!.content.startsWith('Ops Guide > Runbook > Deploy > Rollback')).toBe(true);
    expect(rollback!.content).toContain('run the rollback script');
  });

  it('computes ancestor heading paths correctly (skips sibling headings)', () => {
    const md = ['# A', '', '## B1', '', 'b1 body', '', '## B2', '', '### C', '', 'c body'].join(
      '\n'
    );
    const chunks = chunkMarkdown(md);
    const c = chunks.find((x) => x.content.includes('c body'));
    expect(c!.headingPath).toEqual(['A', 'B2', 'C']);
  });

  it('sub-splits an oversized section into multiple chunks (overlap 0)', () => {
    const para = 'word '.repeat(200).trim(); // ~1000 chars ≈ 250 tokens per paragraph
    const md = `# Big\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, { targetTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    // chunkIndex is monotonic and contiguous from 0.
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    // Line ranges must not overlap (overlap 0): each chunk starts after the previous ends.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.endLine);
    }
  });

  it('keeps a normally-sized fenced code block intact (one block, not split)', () => {
    // ~10 short lines ≈ well under a default-target chunk → must stay one piece.
    const code = '```js\n' + 'const x = 1;\n'.repeat(10) + '```';
    const md = `# Code\n\n${code}`;
    const chunks = chunkMarkdown(md);
    const codeChunk = chunks.find((c) => c.content.includes('```js'));
    expect(codeChunk).toBeDefined();
    // The opening and closing fences live in the SAME chunk — no mid-code split.
    expect(codeChunk!.content).toContain('```js');
    expect(codeChunk!.content.trimEnd().endsWith('```')).toBe(true);
  });

  it('force-splits a monster code block that alone exceeds maxTokens (bounded chunks)', () => {
    // A single fenced block far larger than maxTokens must not produce one
    // unbounded chunk — it is force-split by lines (the embedding token limit
    // guard). Fence-integrity is sacrificed only in this degenerate case.
    const code = '```js\n' + 'const x = 1;\n'.repeat(500) + '```';
    const md = `# Code\n\n${code}`;
    const chunks = chunkMarkdown(md, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('reports 0-indexed line numbers into the original source', () => {
    const md = '# T\n\nfirst\n\nsecond';
    const chunks = chunkMarkdown(md);
    const c = chunks[0]!;
    expect(c.startLine).toBeGreaterThanOrEqual(0);
    expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
  });

  it('handles a document with no headings (preamble only) when it has other md structure', () => {
    const md = '- one\n- two\n\nsee [x](http://y)';
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.headingPath).toEqual([]);
  });
});

describe('elideOpaqueRuns', () => {
  // The shape this exists for: an API example embedding a base64 file upload on
  // a single line, where the payload is the overwhelming majority of the file.
  const payload = 'JVBERi0xLjMKJcTl8uXr' + 'aGVsbG8gd29ybGQ'.repeat(200);

  it('replaces a long base64 run with a length-bearing placeholder', () => {
    const out = elideOpaqueRuns(`"data": "${payload}"`);
    expect(out).not.toContain(payload);
    expect(out).toMatch(/\[binary data elided, \d+ chars\]/);
    // Surrounding context survives, so the chunk still says what was there.
    expect(out).toContain('"data"');
  });

  it('leaves short unbroken tokens alone (hashes, ids, ordinary URLs)', () => {
    const sha = 'a'.repeat(40);
    const url = 'https://example.com/' + 'p'.repeat(120);
    const text = `commit ${sha} at ${url}`;
    expect(elideOpaqueRuns(text)).toBe(text);
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(60);
    expect(elideOpaqueRuns(prose)).toBe(prose);
  });

  it('introduces no newline, so source line numbers cannot shift', () => {
    const before = `a\n"x": "${payload}"\nb`;
    const after = elideOpaqueRuns(before);
    expect(after.split('\n').length).toBe(before.split('\n').length);
  });
});

describe('chunkMarkdown with embedded payloads', () => {
  const payload = 'JVBERi0xLjMKJcTl8uXr' + 'aGVsbG8gd29ybGQ'.repeat(300);

  it('never emits a chunk containing the raw payload', () => {
    const md = `# Onboarding\n\n## Testing environment\n\n{\n"file_name": "cv.pdf",\n"data": "${payload}"\n}`;
    for (const chunk of chunkMarkdown(md)) {
      expect(chunk.content).not.toContain(payload);
    }
  });

  it('keeps the payload chunk within the token bound', () => {
    // Before elision this produced ONE ~4.2k-token chunk from a single line,
    // which the by-line force-split could not cut and which crowded the page's
    // real prose out of the index.
    const md = `# Onboarding\n\n## Testing environment\n\n"data": "${payload}"`;
    const maxTokens = Math.ceil(320 * 1.5);
    for (const chunk of chunkMarkdown(md)) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(maxTokens * 1.1);
    }
  });

  it('still indexes the prose around a payload', () => {
    const md = `# Onboarding\n\n## Testing environment\n\nPost the applicant payload to the sandbox endpoint.\n\n"data": "${payload}"`;
    const text = chunkMarkdown(md)
      .map((c) => c.content)
      .join('\n');
    expect(text).toContain('sandbox endpoint');
  });

  it('reports line numbers that still point into the original source', () => {
    const md = `# T\n\nintro line\n\n"data": "${payload}"\n\ntail line`;
    const sourceLines = md.split('\n').length;
    for (const chunk of chunkMarkdown(md)) {
      expect(chunk.endLine).toBeLessThan(sourceLines);
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });

  it('bounds a single line too long to fit even after elision', () => {
    // No payload here — one enormous prose line (a one-line table, a minified
    // asset). Splitting by line has nothing to cut, so it must fall back to a
    // character split rather than emit an unbounded chunk.
    const oneLine = 'word '.repeat(4000).trim();
    const md = `# T\n\n${oneLine}`;
    const chunks = chunkMarkdown(md, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(200);
    }
  });
});
