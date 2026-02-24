import Parser from 'web-tree-sitter';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export interface ParsedFile {
  tree: Parser.Tree;
  language: Parser.Language;
}

export interface TreeSitterManager {
  parseFile(content: string, language: string): Promise<ParsedFile | null>;
  isAvailable(language: string): boolean;
  close(): void;
}

/**
 * Map from our language identifiers to tree-sitter-wasms grammar file names.
 * `null` means the language has no WASM grammar available (symbol extraction skipped).
 */
const LANGUAGE_GRAMMAR_MAP: Record<string, string | null> = {
  typescript: 'typescript',
  javascript: 'javascript',
  tsx: 'tsx',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  ruby: 'ruby',
  c: 'c',
  cpp: 'cpp',
  csharp: 'c_sharp',
  terraform: null,
};

export async function createTreeSitterManager(): Promise<TreeSitterManager> {
  await Parser.init();

  const languageCache = new Map<string, Parser.Language>();
  const failedLanguages = new Set<string>();
  const parser = new Parser();

  async function loadLanguage(language: string): Promise<Parser.Language | null> {
    if (languageCache.has(language)) return languageCache.get(language)!;
    if (failedLanguages.has(language)) return null;

    const grammarName = LANGUAGE_GRAMMAR_MAP[language];
    if (grammarName === undefined || grammarName === null) {
      failedLanguages.add(language);
      return null;
    }

    try {
      const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`);
      const lang = await Parser.Language.load(wasmPath);
      languageCache.set(language, lang);
      return lang;
    } catch (err) {
      console.warn(
        `[tree-sitter] Failed to load grammar for ${language}: ${(err as Error).message}`
      );
      failedLanguages.add(language);
      return null;
    }
  }

  return {
    async parseFile(content: string, language: string): Promise<ParsedFile | null> {
      const lang = await loadLanguage(language);
      if (!lang) return null;

      try {
        parser.setLanguage(lang);
        const tree = parser.parse(content);
        return { tree, language: lang };
      } catch (err) {
        console.warn(
          `[tree-sitter] Failed to parse file as ${language}: ${(err as Error).message}`
        );
        return null;
      }
    },

    isAvailable(language: string): boolean {
      const grammarName = LANGUAGE_GRAMMAR_MAP[language];
      return grammarName !== undefined && grammarName !== null;
    },

    close(): void {
      parser.delete();
    },
  };
}
