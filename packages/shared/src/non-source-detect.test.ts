import { describe, it, expect } from 'vitest';
import { detectNonSource } from './non-source-detect.js';

// A base64-ish string of the requested length — the shape of the pptx asset
// blobs that stalled the embedder (convex/export/pptx/assets/*.data.ts).
function base64Blob(len: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[i % alphabet.length];
  return out;
}

describe('detectNonSource — flags machine/non-source content', () => {
  it('flags a single-line base64 asset blob (the .data.ts case)', () => {
    const content = `export const asset = "${base64Blob(400_000)}";`;
    const v = detectNonSource(content);
    expect(v.isNonSource).toBe(true);
    expect(v.reason).toMatch(/minified|blob|base64|structure/);
  });

  it('flags a data-URI export', () => {
    const content = `export default "data:image/png;base64,${base64Blob(50_000)}";`;
    expect(detectNonSource(content).isNonSource).toBe(true);
  });

  it('flags minified JS (one enormous line)', () => {
    const min = `!function(){var a=${base64Blob(20_000)};return a}();`;
    expect(detectNonSource(min).isNonSource).toBe(true);
  });

  it('flags a dense base64 wall even with occasional newlines', () => {
    // 200 lines of 300 base64 chars each: high base64 ratio, low whitespace,
    // but no single line trips MAX_LINE_LENGTH — the distribution pass catches it.
    const lines = Array.from({ length: 200 }, () => base64Blob(300));
    expect(detectNonSource(lines.join('\n')).isNonSource).toBe(true);
  });
});

describe('detectNonSource — passes legitimate source', () => {
  it('passes normal TypeScript', () => {
    const ts = `
import { foo } from './foo.js';

export function greet(name: string): string {
  // Return a friendly greeting.
  return \`Hello, \${name}!\`;
}

export class Service {
  constructor(private readonly deps: Deps) {}
  async run(): Promise<void> {
    for (const item of this.deps.items) {
      await this.process(item);
    }
  }
}
`.repeat(10);
    expect(detectNonSource(ts).isNonSource).toBe(false);
  });

  it('passes a large but well-structured JSON fixture', () => {
    const rows = Array.from({ length: 500 }, (_, i) => `  { "id": ${i}, "name": "item ${i}" }`);
    const json = `[\n${rows.join(',\n')}\n]`;
    expect(detectNonSource(json).isNonSource).toBe(false);
  });

  it('passes code with an embedded SVG path (long-ish but whitespaced)', () => {
    const jsx = `
export const Icon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M12 2L2 7v10l10 5 10-5V7z M12 4.3l6 3v6.4l-6 3-6-3V7.3z" />
  </svg>
);
`.repeat(20);
    expect(detectNonSource(jsx).isNonSource).toBe(false);
  });

  it('always treats short content as source (statistics unreliable below threshold)', () => {
    expect(detectNonSource('a').isNonSource).toBe(false);
    expect(detectNonSource(base64Blob(100)).isNonSource).toBe(false);
    expect(detectNonSource('').isNonSource).toBe(false);
  });
});
