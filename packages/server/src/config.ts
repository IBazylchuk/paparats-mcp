import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type {
  PaparatsConfig,
  ProjectConfig,
  LanguageProfile,
  ResolvedIndexingConfig,
  WatcherConfig,
  EmbeddingsConfig,
} from './types.js';

// ── Built-in language profiles ─────────────────────────────────────────────

const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  ruby: {
    patterns: ['**/*.rb', '**/*.rake'],
    exclude: ['vendor/**', 'tmp/**', 'log/**', 'spec/**', 'node_modules/**'],
    extensions: ['.rb', '.rake'],
  },
  typescript: {
    patterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    exclude: ['node_modules/**', 'dist/**', '.next/**', 'coverage/**', 'build/**'],
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  javascript: {
    patterns: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    exclude: ['node_modules/**', 'dist/**', 'coverage/**', 'build/**'],
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  },
  python: {
    patterns: ['**/*.py'],
    exclude: ['venv/**', '__pycache__/**', '.venv/**', '.mypy_cache/**', '*.egg-info/**'],
    extensions: ['.py'],
  },
  go: {
    patterns: ['**/*.go'],
    exclude: ['vendor/**', 'bin/**'],
    extensions: ['.go'],
  },
  rust: {
    patterns: ['**/*.rs'],
    exclude: ['target/**'],
    extensions: ['.rs'],
  },
  java: {
    patterns: ['**/*.java'],
    exclude: ['build/**', '.gradle/**', 'target/**', 'bin/**'],
    extensions: ['.java'],
  },
  terraform: {
    patterns: ['**/*.tf', '**/*.tfvars'],
    exclude: ['.terraform/**', '*.tfstate*'],
    extensions: ['.tf', '.tfvars'],
  },
  c: {
    patterns: ['**/*.c', '**/*.h'],
    exclude: ['build/**', 'cmake-build-*/**'],
    extensions: ['.c', '.h'],
  },
  cpp: {
    patterns: ['**/*.cpp', '**/*.hpp', '**/*.cc', '**/*.hh', '**/*.cxx', '**/*.h'],
    exclude: ['build/**', 'cmake-build-*/**'],
    extensions: ['.cpp', '.hpp', '.cc', '.hh', '.cxx', '.h'],
  },
  csharp: {
    patterns: ['**/*.cs'],
    exclude: ['bin/**', 'obj/**', '.vs/**'],
    extensions: ['.cs'],
  },
  generic: {
    patterns: ['**/*'],
    exclude: ['node_modules/**', 'vendor/**', 'target/**', '.git/**', 'build/**', 'dist/**'],
    extensions: [],
  },
};

export function getLanguageProfile(language: string): LanguageProfile {
  return LANGUAGE_PROFILES[language] ?? LANGUAGE_PROFILES.generic;
}

export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_PROFILES).filter((l) => l !== 'generic');
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_INDEXING: ResolvedIndexingConfig = {
  paths: [],
  exclude: [],
  extensions: [],
  chunkSize: 1024,
  overlap: 128,
  concurrency: 2,
  batchSize: 50,
};

const DEFAULT_WATCHER: Required<WatcherConfig> = {
  enabled: true,
  debounce: 1000,
};

// Default model: jinaai/jina-code-embeddings-1.5b-GGUF (HuggingFace)
// Not in Ollama registry — registered as local alias via Modelfile.
// See README.md "Embedding model setup" for one-time setup instructions.
const DEFAULT_EMBEDDINGS: Required<EmbeddingsConfig> = {
  provider: 'ollama',
  model: 'jina-code-embeddings',  // Ollama alias for jina-code-embeddings-1.5b
  dimensions: 1536,
};

// ── Config file name ───────────────────────────────────────────────────────

export const CONFIG_FILE = '.paparats.yml';

// ── Read & resolve ─────────────────────────────────────────────────────────

export function readConfig(projectDir: string): PaparatsConfig {
  const configPath = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as PaparatsConfig;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid config at ${configPath}: expected YAML object`);
  }
  if (!parsed.group) {
    throw new Error(`Missing required field 'group' in ${configPath}`);
  }
  if (!parsed.language) {
    throw new Error(`Missing required field 'language' in ${configPath}`);
  }

  return parsed;
}

/**
 * Resolve a raw .paparats.yml into a fully-resolved ProjectConfig
 * by merging language profiles, defaults, and user overrides.
 */
export function resolveProject(projectDir: string, raw: PaparatsConfig): ProjectConfig {
  const languages = Array.isArray(raw.language) ? raw.language : [raw.language];
  const projectName = path.basename(projectDir);

  // Merge language profiles
  const mergedPatterns: string[] = [];
  const mergedExclude: string[] = [];
  const mergedExtensions: string[] = [];

  for (const lang of languages) {
    const profile = getLanguageProfile(lang);
    mergedPatterns.push(...profile.patterns);
    mergedExclude.push(...profile.exclude);
    mergedExtensions.push(...profile.extensions);
  }

  // User overrides win
  const userIndexing = raw.indexing ?? {};
  const paths = userIndexing.paths ?? ['./'];
  const exclude = userIndexing.exclude ?? [...new Set(mergedExclude)];
  const extensions = userIndexing.extensions ?? [...new Set(mergedExtensions)];

  // Build final glob patterns from paths + language patterns
  // If user specifies paths, scope language patterns to those paths
  let patterns: string[];
  if (userIndexing.paths) {
    patterns = [];
    for (const p of userIndexing.paths) {
      for (const lang of languages) {
        const profile = getLanguageProfile(lang);
        for (const pat of profile.patterns) {
          const base = p.endsWith('/') ? p : `${p}/`;
          patterns.push(`${base}${pat}`);
        }
      }
    }
  } else {
    patterns = [...new Set(mergedPatterns)];
  }

  const indexing: ResolvedIndexingConfig = {
    paths,
    exclude,
    extensions,
    chunkSize: userIndexing.chunkSize ?? DEFAULT_INDEXING.chunkSize,
    overlap: userIndexing.overlap ?? DEFAULT_INDEXING.overlap,
    concurrency: userIndexing.concurrency ?? DEFAULT_INDEXING.concurrency,
    batchSize: userIndexing.batchSize ?? DEFAULT_INDEXING.batchSize,
  };

  const watcher: Required<WatcherConfig> = {
    enabled: raw.watcher?.enabled ?? DEFAULT_WATCHER.enabled,
    debounce: raw.watcher?.debounce ?? DEFAULT_WATCHER.debounce,
  };

  const embeddings: Required<EmbeddingsConfig> = {
    provider: raw.embeddings?.provider ?? DEFAULT_EMBEDDINGS.provider,
    model: raw.embeddings?.model ?? DEFAULT_EMBEDDINGS.model,
    dimensions: raw.embeddings?.dimensions ?? DEFAULT_EMBEDDINGS.dimensions,
  };

  return {
    name: projectName,
    path: path.resolve(projectDir),
    group: raw.group,
    languages,
    patterns,
    exclude,
    indexing,
    watcher,
    embeddings,
  };
}

/**
 * Convenience: read + resolve in one call.
 */
export function loadProject(projectDir: string): ProjectConfig {
  const raw = readConfig(projectDir);
  return resolveProject(projectDir, raw);
}
