import { Parser, Language, type Tree } from 'web-tree-sitter';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export interface ParsedFile {
  tree: Tree;
  language: Language;
}

export interface TreeSitterManager {
  parseFile(content: string, language: string): Promise<ParsedFile | null>;
  isAvailable(language: string): boolean;
  close(): void;
}

/**
 * Map from our language identifiers to WASM grammar sources.
 * A string resolves from tree-sitter-wasms; a `{ pkg, file }` resolves the WASM
 * from another package. `null` means no WASM grammar (symbol extraction skipped).
 */
type GrammarRef = string | { pkg: string; file: string };

const LANGUAGE_GRAMMAR_MAP: Record<string, GrammarRef | null> = {
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
  terraform: { pkg: '@tree-sitter-grammars/tree-sitter-hcl', file: 'tree-sitter-terraform.wasm' },
};

export async function createTreeSitterManager(): Promise<TreeSitterManager> {
  await Parser.init();

  const languageCache = new Map<string, Language>();
  const failedLanguages = new Set<string>();
  const parser = new Parser();

  async function loadLanguage(language: string): Promise<Language | null> {
    if (languageCache.has(language)) return languageCache.get(language)!;
    if (failedLanguages.has(language)) return null;

    const grammarName = LANGUAGE_GRAMMAR_MAP[language];
    if (grammarName === undefined || grammarName === null) {
      failedLanguages.add(language);
      return null;
    }

    try {
      const wasmPath =
        typeof grammarName === 'string'
          ? require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`)
          : require.resolve(`${grammarName.pkg}/${grammarName.file}`);
      const lang = await Language.load(wasmPath);
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
        if (!tree) return null;
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
