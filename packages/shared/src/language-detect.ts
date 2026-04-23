import path from 'node:path';

/**
 * Per-file language detection.
 *
 * Returns a language key matching the server's LANGUAGE_PROFILES keys
 * ('ruby', 'typescript', 'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
 * 'javascript') or null if the file cannot be confidently classified.
 *
 * Strategy: extension table first, shebang fallback for files without a known
 * extension. Ambiguous extensions are resolved conservatively:
 *   - `.h` → 'c' (C++ project should carry an explicit project-level fallback)
 *   - `.js` → 'typescript' (our TS profile already covers .js; keeps tree-sitter
 *     grammar selection sane in mixed TS/JS repos)
 */

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.hh': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'csharp',
};

const SHEBANG_TO_LANGUAGE: Array<{ pattern: RegExp; language: string }> = [
  { pattern: /^#!.*\b(ruby)\b/, language: 'ruby' },
  { pattern: /^#!.*\b(python[0-9.]*)\b/, language: 'python' },
  { pattern: /^#!.*\b(node|deno|bun)\b/, language: 'typescript' },
];

/**
 * Detect language from a file path, optionally using its content for shebang
 * detection when the extension is unknown.
 */
export function detectLanguageByPath(relPath: string, content?: string): string | null {
  const ext = path.extname(relPath).toLowerCase();
  if (ext && EXT_TO_LANGUAGE[ext]) {
    return EXT_TO_LANGUAGE[ext];
  }

  if (content) {
    const nl = content.indexOf('\n');
    const firstLine = nl === -1 ? content.slice(0, 200) : content.slice(0, nl);
    for (const { pattern, language } of SHEBANG_TO_LANGUAGE) {
      if (pattern.test(firstLine)) return language;
    }
  }

  return null;
}
