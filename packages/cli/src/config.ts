import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import yaml from 'js-yaml';

export const CONFIG_FILE = '.paparats.yml';

const LANGUAGE_PATTERNS: Record<string, string[]> = {
  ruby: ['**/*.rb', '**/*.rake'],
  typescript: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  javascript: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
  python: ['**/*.py'],
  go: ['**/*.go'],
  rust: ['**/*.rs'],
  java: ['**/*.java'],
  terraform: ['**/*.tf', '**/*.tfvars'],
  c: ['**/*.c', '**/*.h'],
  cpp: ['**/*.cpp', '**/*.hpp', '**/*.cc', '**/*.hh', '**/*.cxx', '**/*.h'],
  csharp: ['**/*.cs'],
  generic: ['**/*'],
};

const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/build/**',
  '**/vendor/**',
  '**/target/**',
];

export interface PaparatsConfig {
  group: string;
  language: string | string[];
  indexing?: {
    paths?: string[];
    exclude?: string[];
    extensions?: string[];
    chunkSize?: number;
    overlap?: number;
    concurrency?: number;
    batchSize?: number;
  };
  watcher?: {
    enabled?: boolean;
    debounce?: number;
    stabilityThreshold?: number;
  };
  embeddings?: {
    provider?: 'ollama' | 'openai';
    model?: string;
    dimensions?: number;
  };
}

export const SUPPORTED_LANGUAGES = [
  'ruby',
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'terraform',
  'c',
  'cpp',
  'csharp',
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// Explicit priority order (most specific first)
const DETECT_PRIORITY: Array<[string, SupportedLanguage]> = [
  ['tsconfig.json', 'typescript'],
  ['package.json', 'typescript'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['setup.py', 'python'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['Gemfile', 'ruby'],
  ['Rakefile', 'ruby'],
  ['main.tf', 'terraform'],
  ['CMakeLists.txt', 'cpp'],
  ['Makefile', 'c'],
];

function hasCSharpFiles(dir: string): boolean {
  try {
    const files = fs.readdirSync(dir);
    return files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
  } catch {
    return false;
  }
}

function validateConfig(config: PaparatsConfig, configPath: string): void {
  if (!config.group || typeof config.group !== 'string') {
    throw new Error(`Invalid 'group' in ${configPath}: expected non-empty string`);
  }

  if (!config.language) {
    throw new Error(`Missing required field 'language' in ${configPath}`);
  }

  const languages = Array.isArray(config.language) ? config.language : [config.language];
  for (const lang of languages) {
    if (!SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
      throw new Error(
        `Unsupported language '${lang}' in ${configPath}.\n` +
          `Supported: ${SUPPORTED_LANGUAGES.join(', ')}`
      );
    }
  }

  if (config.indexing) {
    const idx = config.indexing;
    if (idx.chunkSize !== undefined) {
      if (typeof idx.chunkSize !== 'number' || idx.chunkSize < 100 || idx.chunkSize > 10000) {
        throw new Error(`Invalid chunkSize in ${configPath}: expected number between 100-10000`);
      }
    }
    if (idx.overlap !== undefined) {
      if (typeof idx.overlap !== 'number' || idx.overlap < 0 || idx.overlap > 1000) {
        throw new Error(`Invalid overlap in ${configPath}: expected number between 0-1000`);
      }
    }
    if (idx.concurrency !== undefined) {
      if (typeof idx.concurrency !== 'number' || idx.concurrency < 1 || idx.concurrency > 100) {
        throw new Error(`Invalid concurrency in ${configPath}: expected number between 1-100`);
      }
    }
  }

  if (config.watcher) {
    const w = config.watcher;
    if (w.enabled !== undefined && typeof w.enabled !== 'boolean') {
      throw new Error(`Invalid watcher.enabled in ${configPath}: expected boolean`);
    }
    if (w.debounce !== undefined) {
      if (typeof w.debounce !== 'number' || w.debounce < 0 || w.debounce > 10000) {
        throw new Error(`Invalid watcher.debounce in ${configPath}: expected 0-10000ms`);
      }
    }
  }

  if (config.embeddings) {
    const emb = config.embeddings;
    if (emb.provider !== undefined && emb.provider !== 'ollama' && emb.provider !== 'openai') {
      throw new Error(
        `Invalid embeddings.provider in ${configPath}: expected 'ollama' or 'openai'`
      );
    }
    if (emb.dimensions !== undefined) {
      if (typeof emb.dimensions !== 'number' || emb.dimensions < 128 || emb.dimensions > 8192) {
        throw new Error(`Invalid embeddings.dimensions in ${configPath}: expected 128-8192`);
      }
    }
  }
}

export function findConfigDir(startDir?: string): string | null {
  let dir = path.resolve(startDir ?? process.cwd());

  while (true) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readConfig(projectDir?: string): { config: PaparatsConfig; projectDir: string } {
  const dir = projectDir ?? findConfigDir();
  if (!dir) {
    throw new Error(
      `No ${CONFIG_FILE} found in current directory or any parent.\nRun \`paparats init\` to create one.`
    );
  }

  const configPath = path.join(dir, CONFIG_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`, { cause: err });
    }
    if (error.code === 'EACCES') {
      throw new Error(`Permission denied reading ${configPath}`, { cause: err });
    }
    throw new Error(`Failed to read ${configPath}: ${error.message}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${configPath}: ${(err as Error).message}\n` +
        `Check syntax at https://www.yamllint.com/`,
      { cause: err }
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid config at ${configPath}: expected YAML object`);
  }

  const config = parsed as PaparatsConfig;
  validateConfig(config, configPath);

  return { config, projectDir: path.resolve(dir) };
}

export function writeConfig(projectDir: string, config: PaparatsConfig): void {
  const configPath = path.join(projectDir, CONFIG_FILE);

  if (!fs.existsSync(projectDir)) {
    throw new Error(`Directory does not exist: ${projectDir}`);
  }

  if (fs.existsSync(configPath)) {
    try {
      fs.accessSync(configPath, fs.constants.W_OK);
    } catch (err) {
      throw new Error(`Cannot write to ${configPath}: Permission denied`, { cause: err });
    }
  }

  const content = yaml.dump(config, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });

  try {
    fs.writeFileSync(configPath, content, 'utf8');
  } catch (err) {
    throw new Error(`Failed to write config: ${(err as Error).message}`, { cause: err });
  }
}

export function detectLanguages(projectDir: string): SupportedLanguage[] {
  const detected: SupportedLanguage[] = [];
  const seen = new Set<SupportedLanguage>();

  try {
    if (!fs.existsSync(projectDir)) {
      return [];
    }

    for (const [file, lang] of DETECT_PRIORITY) {
      if (fs.existsSync(path.join(projectDir, file)) && !seen.has(lang)) {
        detected.push(lang);
        seen.add(lang);
      }
    }

    if (hasCSharpFiles(projectDir) && !seen.has('csharp')) {
      detected.push('csharp');
      seen.add('csharp');
    }
  } catch {
    return [];
  }

  return detected;
}

export function detectLanguage(projectDir: string): SupportedLanguage | null {
  const languages = detectLanguages(projectDir);
  return languages[0] ?? null;
}

/** Get glob patterns for indexing based on config */
function getIndexPatterns(config: PaparatsConfig): string[] {
  const languages = Array.isArray(config.language) ? config.language : [config.language];
  const paths = config.indexing?.paths ?? ['./'];
  const patterns: string[] = [];
  for (const p of paths) {
    const base = p.replace(/\/$/, '') || '.';
    for (const lang of languages) {
      const langPatterns = LANGUAGE_PATTERNS[lang as SupportedLanguage] ??
        LANGUAGE_PATTERNS.generic ?? ['**/*'];
      for (const pat of langPatterns) {
        patterns.push(path.posix.join(base, pat).replace(/\\/g, '/'));
      }
    }
  }
  return [...new Set(patterns)];
}

/** Collect project files for indexing (mirrors server glob logic) */
export async function collectProjectFiles(
  projectDir: string,
  config: PaparatsConfig
): Promise<string[]> {
  const patterns = getIndexPatterns(config);
  const exclude = config.indexing?.exclude ?? DEFAULT_EXCLUDE;
  const fileSet = new Set<string>();
  for (const pattern of patterns) {
    const found = await glob(pattern, {
      cwd: projectDir,
      absolute: true,
      ignore: exclude,
      nodir: true,
    });
    found.forEach((f) => fileSet.add(f));
  }
  return Array.from(fileSet);
}

/** Infer language from file extension (for content-based API) */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'csharp',
};

export function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'generic';
}
