import type { ChunkKind } from './types.js';

export interface ExtractedSymbol {
  name: string;
  kind: ChunkKind;
}

/** Max lines to scan from the start of a chunk for symbol declarations */
const SCAN_LINES = 5;

// ── Per-language regex patterns ──────────────────────────────────────────

interface SymbolPattern {
  pattern: RegExp;
  kind: ChunkKind;
  nameGroup: number;
}

const TS_JS_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*export\s+default\s+class\s+(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*(?:export\s+)?interface\s+(\w+)/, kind: 'interface', nameGroup: 1 },
  { pattern: /^\s*(?:export\s+)?type\s+(\w+)\s*=/, kind: 'type', nameGroup: 1 },
  { pattern: /^\s*(?:export\s+)?enum\s+(\w+)/, kind: 'enum', nameGroup: 1 },
  {
    pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    kind: 'function',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*=>/,
    kind: 'function',
    nameGroup: 1,
  },
  { pattern: /^\s*(?:export\s+)?const\s+(\w+)\s*=/, kind: 'constant', nameGroup: 1 },
  { pattern: /^\s*(?:export\s+)?let\s+(\w+)\s*=/, kind: 'variable', nameGroup: 1 },
  { pattern: /^\s*(?:export\s+)?var\s+(\w+)\s*=/, kind: 'variable', nameGroup: 1 },
  // Method inside class
  { pattern: /^\s+(?:async\s+)?(\w+)\s*\(/, kind: 'method', nameGroup: 1 },
  // Route patterns (Express)
  {
    pattern: /^\s*(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)/,
    kind: 'route',
    nameGroup: 2,
  },
];

const PYTHON_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*class\s+(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*(?:async\s+)?def\s+(\w+)/, kind: 'function', nameGroup: 1 },
  { pattern: /^(\w+)\s*=\s*/, kind: 'variable', nameGroup: 1 },
];

const GO_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*type\s+(\w+)\s+struct/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*type\s+(\w+)\s+interface/, kind: 'interface', nameGroup: 1 },
  { pattern: /^\s*type\s+(\w+)\s+/, kind: 'type', nameGroup: 1 },
  { pattern: /^\s*func\s+\(\s*\w+\s+\*?(\w+)\)\s+(\w+)\s*\(/, kind: 'method', nameGroup: 2 },
  { pattern: /^\s*func\s+(\w+)\s*\(/, kind: 'function', nameGroup: 1 },
  { pattern: /^\s*var\s+(\w+)\s+/, kind: 'variable', nameGroup: 1 },
  { pattern: /^\s*const\s+(\w+)\s*=/, kind: 'constant', nameGroup: 1 },
];

const RUST_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?enum\s+(\w+)/, kind: 'enum', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: 'interface', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?type\s+(\w+)/, kind: 'type', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?mod\s+(\w+)/, kind: 'module', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function', nameGroup: 1 },
  { pattern: /^\s*impl\s+(?:\w+\s+for\s+)?(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?const\s+(\w+)/, kind: 'constant', nameGroup: 1 },
  { pattern: /^\s*(?:pub\s+)?static\s+(\w+)/, kind: 'variable', nameGroup: 1 },
];

const JAVA_PATTERNS: SymbolPattern[] = [
  {
    pattern: /^\s*(?:public|private|protected)?\s*(?:abstract\s+)?(?:static\s+)?class\s+(\w+)/,
    kind: 'class',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:public|private|protected)?\s*interface\s+(\w+)/,
    kind: 'interface',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:public|private|protected)?\s*enum\s+(\w+)/,
    kind: 'enum',
    nameGroup: 1,
  },
  {
    pattern:
      /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/,
    kind: 'method',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?\w+\s+(\w+)\s*=/,
    kind: 'variable',
    nameGroup: 1,
  },
];

const RUBY_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*class\s+(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*module\s+(\w+)/, kind: 'module', nameGroup: 1 },
  { pattern: /^\s*def\s+(?:self\.)?(\w+[?!]?)/, kind: 'method', nameGroup: 1 },
  { pattern: /^\s*(\w+)\s*=\s*/, kind: 'variable', nameGroup: 1 },
];

const C_CPP_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*(?:class|struct)\s+(\w+)/, kind: 'class', nameGroup: 1 },
  { pattern: /^\s*enum\s+(?:class\s+)?(\w+)/, kind: 'enum', nameGroup: 1 },
  { pattern: /^\s*namespace\s+(\w+)/, kind: 'module', nameGroup: 1 },
  { pattern: /^\s*typedef\s+.+\s+(\w+)\s*;/, kind: 'type', nameGroup: 1 },
  {
    pattern: /^\s*(?:(?:static|inline|virtual|extern|const)\s+)*(?:\w+(?:::\w+)*\s+)+(\w+)\s*\(/,
    kind: 'function',
    nameGroup: 1,
  },
  { pattern: /^\s*#define\s+(\w+)/, kind: 'constant', nameGroup: 1 },
];

const CSHARP_PATTERNS: SymbolPattern[] = [
  {
    pattern:
      /^\s*(?:public|private|protected|internal)?\s*(?:abstract\s+)?(?:static\s+)?(?:partial\s+)?class\s+(\w+)/,
    kind: 'class',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:public|private|protected|internal)?\s*interface\s+(\w+)/,
    kind: 'interface',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:public|private|protected|internal)?\s*enum\s+(\w+)/,
    kind: 'enum',
    nameGroup: 1,
  },
  {
    pattern:
      /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:partial\s+)?struct\s+(\w+)/,
    kind: 'class',
    nameGroup: 1,
  },
  {
    pattern: /^\s*(?:public|private|protected|internal)?\s*namespace\s+(\w+)/,
    kind: 'module',
    nameGroup: 1,
  },
  {
    pattern:
      /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:virtual\s+)?(?:override\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/,
    kind: 'method',
    nameGroup: 1,
  },
];

const TERRAFORM_PATTERNS: SymbolPattern[] = [
  { pattern: /^\s*resource\s+"(\w+)"\s+"(\w+)"/, kind: 'resource', nameGroup: 2 },
  { pattern: /^\s*data\s+"(\w+)"\s+"(\w+)"/, kind: 'resource', nameGroup: 2 },
  { pattern: /^\s*module\s+"(\w+)"/, kind: 'module', nameGroup: 1 },
  { pattern: /^\s*variable\s+"(\w+)"/, kind: 'variable', nameGroup: 1 },
  { pattern: /^\s*output\s+"(\w+)"/, kind: 'variable', nameGroup: 1 },
  { pattern: /^\s*locals\s*\{/, kind: 'block', nameGroup: 0 },
];

const LANGUAGE_PATTERNS: Record<string, SymbolPattern[]> = {
  typescript: TS_JS_PATTERNS,
  javascript: TS_JS_PATTERNS,
  python: PYTHON_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  ruby: RUBY_PATTERNS,
  c: C_CPP_PATTERNS,
  cpp: C_CPP_PATTERNS,
  csharp: CSHARP_PATTERNS,
  terraform: TERRAFORM_PATTERNS,
};

/**
 * Extract symbol name and kind from the first few lines of a code chunk.
 * Returns null if no recognizable symbol is found.
 */
export function extractSymbol(content: string, language: string): ExtractedSymbol | null {
  const patterns = LANGUAGE_PATTERNS[language];
  if (!patterns) return null;

  const lines = content.split('\n').slice(0, SCAN_LINES);

  for (const line of lines) {
    for (const { pattern, kind, nameGroup } of patterns) {
      const match = pattern.exec(line);
      if (match) {
        const name = nameGroup === 0 ? kind : (match[nameGroup] ?? null);
        if (name) {
          return { name, kind };
        }
      }
    }
  }

  return null;
}
