import crypto from 'crypto';
import type { ChunkResult } from './types.js';

export interface ChunkerConfig {
  chunkSize: number;
  overlap: number;
}

export class Chunker {
  private chunkSize: number;
  private overlap: number;

  constructor(config: ChunkerConfig) {
    this.chunkSize = config.chunkSize || 1024;
    this.overlap = config.overlap || 128;
  }

  chunk(content: string, language: string): ChunkResult[] {
    if (!content.trim()) return [];

    switch (language) {
      case 'ruby':
        return this.chunkByBlocks(content, /^\s*(def|class|module)\s/, /^\s*end\s*$/);
      case 'typescript':
      case 'javascript':
        return this.chunkByBraces(content);
      case 'terraform':
        return this.chunkByBlocks(
          content,
          /^\s*(resource|data|module|variable|output|locals)\s/,
          /^\s*}\s*$/,
        );
      case 'python':
        return this.chunkByIndent(content);
      case 'go':
      case 'rust':
      case 'java':
      case 'c':
      case 'cpp':
      case 'csharp':
        return this.chunkByBraces(content);
      default:
        return this.chunkFixed(content);
    }
  }

  /** For Ruby, Terraform — languages with keyword-delimited blocks */
  chunkByBlocks(content: string, startPattern: RegExp, endPattern: RegExp): ChunkResult[] {
    const lines = content.split('\n');
    const chunks: ChunkResult[] = [];
    let buffer: string[] = [];
    let blockStartIndent = -1;
    let inBlock = false;

    const flush = (endLine: number): void => {
      if (buffer.length === 0) return;
      const text = buffer.join('\n');
      if (text.trim()) {
        chunks.push({
          content: text,
          startLine: endLine - buffer.length + 1,
          endLine,
          hash: this.hash(text),
        });
      }
      buffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const indent = line.search(/\S/);

      if (startPattern.test(line) && !inBlock) {
        if (buffer.length > 0 && buffer.some((l) => l.trim())) {
          flush(i - 1);
        } else {
          buffer = [];
        }
        inBlock = true;
        blockStartIndent = indent === -1 ? 0 : indent;
      }

      buffer.push(line);

      if (inBlock && endPattern.test(line)) {
        const endIndent = indent === -1 ? 0 : indent;
        if (endIndent <= blockStartIndent) {
          flush(i);
          inBlock = false;
          blockStartIndent = -1;
        }
      }

      if (buffer.join('\n').length > this.chunkSize * 2) {
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
    let braceDepth = 0;
    let inBlock = false;

    const topLevelPattern =
      /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\s/;
    const arrowOrAssign = /=\s*(async\s*)?\(/;

    const flush = (endLine: number): void => {
      if (buffer.length === 0) return;
      const text = buffer.join('\n');
      if (text.trim()) {
        chunks.push({
          content: text,
          startLine: endLine - buffer.length + 1,
          endLine,
          hash: this.hash(text),
        });
      }
      buffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (braceDepth === 0 && (topLevelPattern.test(line) || arrowOrAssign.test(line))) {
        if (buffer.length > 0 && buffer.some((l) => l.trim())) {
          flush(i - 1);
        } else {
          buffer = [];
        }
        inBlock = true;
      }

      buffer.push(line);

      // Track braces (skip strings/comments — simplified)
      const stripped = line
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/g, '')
        .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      braceDepth += (stripped.match(/{/g) || []).length;
      braceDepth -= (stripped.match(/}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;

      if (inBlock && braceDepth === 0 && stripped.includes('}')) {
        flush(i);
        inBlock = false;
      }

      if (buffer.join('\n').length > this.chunkSize * 2) {
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

    const topLevelDef = /^(def |class |async def )/;

    const flush = (endLine: number): void => {
      if (buffer.length === 0) return;
      const text = buffer.join('\n');
      if (text.trim()) {
        chunks.push({
          content: text,
          startLine: endLine - buffer.length + 1,
          endLine,
          hash: this.hash(text),
        });
      }
      buffer = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (topLevelDef.test(line)) {
        if (buffer.length > 0 && buffer.some((l) => l.trim())) {
          flush(i - 1);
        } else {
          buffer = [];
        }
      }

      buffer.push(line);

      if (buffer.join('\n').length > this.chunkSize * 2) {
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
        size += lines[end].length + 1;
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

      const overlapLines = Math.max(1, Math.floor(this.overlap / 80));
      start = Math.max(start + 1, end - overlapLines);
    }

    return chunks;
  }

  hash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
}
