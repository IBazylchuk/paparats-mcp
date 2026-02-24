import crypto from 'crypto';
import type { ChunkResult } from './types.js';

export interface ChunkerConfig {
  chunkSize: number;
  overlap: number;
}

// Pre-compiled patterns — avoid regex recompilation per call
const PATTERNS = {
  ruby: {
    start: /^\s*(def|class|module)\s/,
    end: /^\s*end\s*$/,
  },
  terraform: {
    start: /^\s*(resource|data|module|variable|output|locals)\s/,
    end: /^\s*}\s*$/,
  },
  brace: {
    topLevel:
      /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\s/,
    arrowOrAssign: /=\s*(async\s*)?\(/,
    stripComments: /\/\*[\s\S]*?\*\/|\/\/.*$/g,
    stripStrings: /'[^']*'|"[^"]*"|`[^`]*`/g,
  },
  python: {
    topLevel: /^(def |class |async def )/,
  },
} as const;

export class Chunker {
  private chunkSize: number;
  private overlap: number;
  private maxChunkSize: number;

  constructor(config: ChunkerConfig) {
    this.chunkSize = config.chunkSize || 1024;
    this.overlap = config.overlap || 128;
    this.maxChunkSize = this.chunkSize * 3;
  }

  chunk(content: string, language: string): ChunkResult[] {
    if (!content.trim()) return [];

    let chunks: ChunkResult[];
    switch (language) {
      case 'ruby':
        chunks = this.chunkByBlocks(content, PATTERNS.ruby.start, PATTERNS.ruby.end);
        break;
      case 'typescript':
      case 'javascript':
      case 'tsx':
        chunks = this.chunkByBraces(content);
        break;
      case 'terraform':
        chunks = this.chunkByBlocks(content, PATTERNS.terraform.start, PATTERNS.terraform.end);
        break;
      case 'python':
        chunks = this.chunkByIndent(content);
        break;
      case 'go':
      case 'rust':
      case 'java':
      case 'c':
      case 'cpp':
      case 'csharp':
        chunks = this.chunkByBraces(content);
        break;
      default:
        chunks = this.chunkFixed(content);
        break;
    }

    return chunks;
  }

  /** For Ruby, Terraform — languages with keyword-delimited blocks */
  chunkByBlocks(content: string, startPattern: RegExp, endPattern: RegExp): ChunkResult[] {
    const lines = content.split('\n');
    const chunks: ChunkResult[] = [];
    let buffer: string[] = [];
    let bufferSize = 0;
    let bufferHasContent = false;
    let blockStartIndent = -1;
    let inBlock = false;

    const flush = (endLine: number): void => {
      if (buffer.length === 0) return;
      this.flushBuffer(buffer, bufferSize, endLine, chunks);
      buffer = [];
      bufferSize = 0;
      bufferHasContent = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const indent = this.getIndent(line);

      if (startPattern.test(line) && !inBlock) {
        if (buffer.length > 0 && bufferHasContent) {
          flush(i - 1);
        } else {
          buffer = [];
          bufferSize = 0;
          bufferHasContent = false;
        }
        inBlock = true;
        blockStartIndent = indent;
      }

      buffer.push(line);
      bufferSize += line.length + 1;
      if (!bufferHasContent && line.trim()) bufferHasContent = true;

      if (inBlock && endPattern.test(line)) {
        if (indent <= blockStartIndent) {
          flush(i);
          inBlock = false;
          blockStartIndent = -1;
        }
      }

      if (bufferSize > this.chunkSize * 2) {
        flush(i);
        inBlock = false;
        blockStartIndent = -1;
      }
    }

    flush(lines.length - 1);
    return chunks;
  }

  /** For TypeScript/JavaScript — brace-delimited blocks */
  chunkByBraces(content: string): ChunkResult[] {
    const lines = content.split('\n');
    const chunks: ChunkResult[] = [];
    let buffer: string[] = [];
    let bufferSize = 0;
    let bufferHasContent = false;
    let braceDepth = 0;
    let inBlock = false;

    const flush = (endLine: number): void => {
      if (buffer.length === 0) return;
      this.flushBuffer(buffer, bufferSize, endLine, chunks);
      buffer = [];
      bufferSize = 0;
      bufferHasContent = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (
        braceDepth === 0 &&
        (PATTERNS.brace.topLevel.test(line) || PATTERNS.brace.arrowOrAssign.test(line))
      ) {
        if (buffer.length > 0 && bufferHasContent) {
          flush(i - 1);
        } else {
          buffer = [];
          bufferSize = 0;
          bufferHasContent = false;
        }
        inBlock = true;
      }

      buffer.push(line);
      bufferSize += line.length + 1;
      if (!bufferHasContent && line.trim()) bufferHasContent = true;

      // Track braces (skip strings/comments — simplified)
      const stripped = line
        .replace(PATTERNS.brace.stripComments, '')
        .replace(PATTERNS.brace.stripStrings, '');

      // Count braces with a loop instead of regex match + array allocation
      for (let c = 0; c < stripped.length; c++) {
        const ch = stripped[c];
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
      if (braceDepth < 0) braceDepth = 0;

      if (inBlock && braceDepth === 0 && stripped.includes('}')) {
        flush(i);
        inBlock = false;
      }

      if (bufferSize > this.chunkSize * 2) {
        flush(i);
        inBlock = false;
        braceDepth = 0;
      }
    }

    flush(lines.length - 1);
    return chunks;
  }

  /** For Python — indentation-based blocks */
  chunkByIndent(content: string): ChunkResult[] {
    const lines = content.split('\n');
    const chunks: ChunkResult[] = [];
    let buffer: string[] = [];
    let bufferSize = 0;
    let bufferHasContent = false;

    const flush = (endLine: number): void => {
      if (buffer.length === 0) return;
      this.flushBuffer(buffer, bufferSize, endLine, chunks);
      buffer = [];
      bufferSize = 0;
      bufferHasContent = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (PATTERNS.python.topLevel.test(line)) {
        if (buffer.length > 0 && bufferHasContent) {
          flush(i - 1);
        } else {
          buffer = [];
          bufferSize = 0;
          bufferHasContent = false;
        }
      }

      buffer.push(line);
      bufferSize += line.length + 1;
      if (!bufferHasContent && line.trim()) bufferHasContent = true;

      if (bufferSize > this.chunkSize * 2) {
        flush(i);
      }
    }

    flush(lines.length - 1);
    return chunks;
  }

  /** Fixed-size chunking with overlap — fallback */
  chunkFixed(content: string): ChunkResult[] {
    const lines = content.split('\n');
    const chunks: ChunkResult[] = [];
    let start = 0;

    while (start < lines.length) {
      let end = start;
      let size = 0;
      while (end < lines.length && size < this.chunkSize) {
        size += (lines[end] ?? '').length + 1;
        end++;
      }

      const slice = lines.slice(start, end);
      const text = slice.join('\n');
      if (text.trim()) {
        chunks.push({
          content: text,
          startLine: start,
          endLine: end - 1,
          hash: this.hash(text),
        });
      }

      // Character-based overlap instead of magic number conversion
      let overlapSize = 0;
      let overlapLines = 0;
      while (overlapSize < this.overlap && end - overlapLines - 1 >= start) {
        overlapLines++;
        overlapSize += (lines[end - overlapLines] ?? '').length + 1;
      }

      start = Math.max(start + 1, end - overlapLines);
    }

    return chunks;
  }

  /** Flush buffer to chunks, force-splitting if oversized */
  private flushBuffer(
    buffer: string[],
    _bufferSize: number,
    endLine: number,
    chunks: ChunkResult[]
  ): void {
    const text = buffer.join('\n');
    if (!text.trim()) return;

    if (text.length > this.maxChunkSize) {
      const startLine = endLine - buffer.length + 1;

      // If single line too long, split by character (avoids infinite recursion)
      if (buffer.length === 1) {
        const line = buffer[0] ?? '';
        let pos = 0;
        while (pos < line.length) {
          const chunk = line.slice(pos, pos + this.maxChunkSize);
          if (chunk.trim()) {
            chunks.push({
              content: chunk,
              startLine,
              endLine: startLine,
              hash: this.hash(chunk),
            });
          }
          pos += this.maxChunkSize;
        }
        return;
      }

      const mid = Math.floor(buffer.length / 2);
      const firstHalf = buffer.slice(0, mid);
      const secondHalf = buffer.slice(mid);
      const firstText = firstHalf.join('\n');

      if (firstText.trim()) {
        chunks.push({
          content: firstText,
          startLine,
          endLine: startLine + firstHalf.length - 1,
          hash: this.hash(firstText),
        });
      }

      if (secondHalf.length > 0) {
        const secondSize = secondHalf.reduce((s, l) => s + (l ?? '').length + 1, 0);
        this.flushBuffer(secondHalf, secondSize, endLine, chunks);
      }
      return;
    }

    chunks.push({
      content: text,
      startLine: endLine - buffer.length + 1,
      endLine,
      hash: this.hash(text),
    });
  }

  /** Returns leading whitespace count; 0 for empty/whitespace-only lines */
  private getIndent(line: string): number {
    const idx = line.search(/\S/);
    return idx === -1 ? 0 : idx;
  }

  hash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
}
