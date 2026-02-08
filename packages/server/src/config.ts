import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { validateIndexingPaths } from '@paparats/shared';
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
  return (LANGUAGE_PROFILES[language] ?? LANGUAGE_PROFILES.generic)!;
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
  stabilityThreshold: 1000,
};

// Default model: jinaai/jina-code-embeddings-1.5b-GGUF (HuggingFace)
// Not in Ollama registry — registered as local alias via Modelfile.
// See README.md "Embedding model setup" for one-time setup instructions.
const DEFAULT_EMBEDDINGS: Required<EmbeddingsConfig> = {
  provider: 'ollama',
  model: 'jina-code-embeddings', // Ollama alias for jina-code-embeddings-1.5b
  dimensions: 1536,
};

// ── Config file name ───────────────────────────────────────────────────────

export const CONFIG_FILE = '.paparats.yml';

const VALID_EMBEDDING_PROVIDERS = ['ollama', 'openai'] as const;

// Known embedding model dimensions (for validation warning)
const MODEL_DIMENSIONS: Record<string, number> = {
  'jina-code-embeddings': 1536,
  'all-minilm-l6-v2': 384,
  'bge-base-en-v1.5': 768,
};

/**
 * Validate indexing config numeric ranges.
 */
function validateIndexingConfig(config: Partial<ResolvedIndexingConfig>): void {
  if (config.chunkSize !== undefined) {
    if (!Number.isInteger(config.chunkSize) || config.chunkSize < 128 || config.chunkSize > 8192) {
      throw new Error(`chunkSize must be between 128 and 8192, got ${config.chunkSize}`);
    }
  }
  if (config.overlap !== undefined) {
    const chunkSize = config.chunkSize ?? DEFAULT_INDEXING.chunkSize;
    if (!Number.isInteger(config.overlap) || config.overlap < 0 || config.overlap >= chunkSize) {
      throw new Error(
        `overlap must be between 0 and chunkSize (${chunkSize}), got ${config.overlap}`
      );
    }
  }
  if (config.concurrency !== undefined) {
    if (
      !Number.isInteger(config.concurrency) ||
      config.concurrency < 1 ||
      config.concurrency > 20
    ) {
      throw new Error(`concurrency must be between 1 and 20, got ${config.concurrency}`);
    }
  }
  if (config.batchSize !== undefined) {
    if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 1000) {
      throw new Error(`batchSize must be between 1 and 1000, got ${config.batchSize}`);
    }
  }
}

// ── Read & resolve ─────────────────────────────────────────────────────────

/**
 * Read config from disk (synchronous, intended for startup only).
 * Do not call in request handlers.
 */
export function readConfig(projectDir: string): PaparatsConfig {
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }
  const stat = fs.statSync(projectDir);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${projectDir}`);
  }

  const configPath = path.join(projectDir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as PaparatsConfig;

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
  const languages = Array.isArray(raw.language) ? [...new Set(raw.language)] : [raw.language];
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
  validateIndexingPaths(paths, projectDir);

  const exclude = userIndexing.exclude ?? Array.from(new Set(mergedExclude));
  // Empty extensions = index all files matching patterns
  const extensions = userIndexing.extensions ?? Array.from(new Set(mergedExtensions));

  validateIndexingConfig(userIndexing);

  // Build final glob patterns from paths + language patterns
  // Use posix for glob patterns (even on Windows)
  let patterns: string[];
  if (userIndexing.paths) {
    patterns = [];
    for (const p of userIndexing.paths) {
      for (const lang of languages) {
        const profile = getLanguageProfile(lang);
        for (const pat of profile.patterns) {
          const normalized = path.posix.join(p, pat).replace(/\\/g, '/');
          patterns.push(normalized);
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

  if (raw.watcher?.debounce !== undefined) {
    const d = raw.watcher.debounce;
    if (!Number.isInteger(d) || d < 100 || d > 10000) {
      throw new Error(`watcher.debounce must be between 100 and 10000ms, got ${d}`);
    }
  }

  if (raw.embeddings?.provider !== undefined) {
    const provider = raw.embeddings.provider;
    if (!VALID_EMBEDDING_PROVIDERS.includes(provider)) {
      throw new Error(
        `Invalid embeddings.provider: ${provider}. ` +
          `Valid options: ${VALID_EMBEDDING_PROVIDERS.join(', ')}`
      );
    }
  }

  if (raw.watcher?.stabilityThreshold !== undefined) {
    const s = raw.watcher.stabilityThreshold;
    if (!Number.isInteger(s) || s < 100 || s > 10000) {
      throw new Error(`watcher.stabilityThreshold must be between 100 and 10000ms, got ${s}`);
    }
  }

  const watcher: Required<WatcherConfig> = {
    enabled: raw.watcher?.enabled ?? DEFAULT_WATCHER.enabled,
    debounce: raw.watcher?.debounce ?? DEFAULT_WATCHER.debounce,
    stabilityThreshold: raw.watcher?.stabilityThreshold ?? DEFAULT_WATCHER.stabilityThreshold,
  };

  const embeddings: Required<EmbeddingsConfig> = {
    provider: raw.embeddings?.provider ?? DEFAULT_EMBEDDINGS.provider,
    model: raw.embeddings?.model ?? DEFAULT_EMBEDDINGS.model,
    dimensions: raw.embeddings?.dimensions ?? DEFAULT_EMBEDDINGS.dimensions,
  };

  const expectedDims = MODEL_DIMENSIONS[embeddings.model];
  if (expectedDims !== undefined && embeddings.dimensions !== expectedDims) {
    console.warn(
      `[paparats] Warning: Model ${embeddings.model} expects ${expectedDims} dimensions, ` +
        `but config specifies ${embeddings.dimensions}. This may cause errors.`
    );
  }

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

/** Build minimal ProjectConfig from content-based API request (no filesystem) */
export interface ContentIndexConfig {
  chunkSize?: number;
  overlap?: number;
  batchSize?: number;
  concurrency?: number;
  languages?: string[];
}

export function buildProjectConfigFromContent(
  projectName: string,
  group: string,
  apiConfig?: ContentIndexConfig
): ProjectConfig {
  const cfg = apiConfig ?? {};
  const languages = cfg.languages ?? ['generic'];
  const indexing: ResolvedIndexingConfig = {
    paths: [],
    exclude: [],
    extensions: [],
    chunkSize: cfg.chunkSize ?? DEFAULT_INDEXING.chunkSize,
    overlap: cfg.overlap ?? DEFAULT_INDEXING.overlap,
    concurrency: cfg.concurrency ?? DEFAULT_INDEXING.concurrency,
    batchSize: cfg.batchSize ?? DEFAULT_INDEXING.batchSize,
  };
  if (apiConfig?.chunkSize !== undefined || apiConfig?.overlap !== undefined) {
    validateIndexingConfig(apiConfig);
  }
  return {
    name: projectName,
    path: '',
    group,
    languages,
    patterns: [],
    exclude: [],
    indexing,
    watcher: DEFAULT_WATCHER,
    embeddings: DEFAULT_EMBEDDINGS,
  };
}
