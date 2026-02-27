/**
 * Language-specific default exclude patterns (bare format).
 * Best practices and language-specific build/cache artifacts.
 * Single source of truth for init, CLI config, and server config.
 */
export const LANGUAGE_EXCLUDE_DEFAULTS: Record<string, string[]> = {
  ruby: [
    'vendor',
    'tmp',
    'log',
    'spec',
    'test',
    'node_modules',
    '.bundle',
    'coverage',
    'public/packs',
    'public/assets',
    'storage',
    '.byebug_history',
    'sig',
    'sorbet',
    '**/*.rbi',
  ],
  typescript: [
    'node_modules',
    'dist',
    '.next',
    'coverage',
    'build',
    '.turbo',
    'out',
    '.cache',
    '.vercel',
    '.swc',
    '*.tsbuildinfo',
  ],
  javascript: [
    'node_modules',
    'dist',
    'coverage',
    'build',
    '.cache',
    '.parcel-cache',
    'out',
    '.nuxt',
    '.output',
  ],
  python: [
    'venv',
    '__pycache__',
    '.venv',
    '.mypy_cache',
    '*.egg-info',
    '.pytest_cache',
    '.tox',
    '.coverage',
    'htmlcov',
    'dist',
    'build',
    '.ruff_cache',
    '.pytype',
  ],
  go: ['vendor', 'bin', '.idea', '*.test', '*.out'],
  rust: ['target', 'Cargo.lock', '**/*.rs.bk', '.cargo'],
  java: [
    'build',
    '.gradle',
    'target',
    'bin',
    '.idea',
    '.classpath',
    '.project',
    '.settings',
    '*.class',
    '*.jar',
    '*.war',
  ],
  c: ['build', 'cmake-build-*', '*.o', '*.so', '*.a', '*.exe', '*.out', 'compile_commands.json'],
  cpp: [
    'build',
    'cmake-build-*',
    '*.o',
    '*.so',
    '*.a',
    '*.exe',
    '*.out',
    'compile_commands.json',
    '.ccls-cache',
    '.clangd',
  ],
  csharp: ['bin', 'obj', '.vs', '*.user', '*.suo', 'packages', '.vscode', '*.cache'],
  php: [
    'vendor',
    'node_modules',
    '.phpunit.cache',
    'storage/framework/cache',
    'storage/logs',
    'bootstrap/cache',
    '.env',
  ],
  elixir: ['_build', 'deps', '.elixir_ls', 'cover', 'doc', '*.beam', '.fetch'],
  scala: ['target', '.bsp', '.metals', '.bloop', 'project/target', 'project/project'],
  kotlin: ['build', '.gradle', '.idea', '*.iml', 'out', 'bin'],
  swift: ['.build', '.swiftpm', 'DerivedData', '*.xcodeproj', '*.xcworkspace', 'Pods'],
  generic: ['node_modules', 'vendor', 'target', '.git', 'build', 'dist'],
};

export const COMMON_EXCLUDE = ['.git'];

/**
 * Bare names for generic fallback (EMFILE-critical paths).
 * Includes explicit globs for patterns that must not be normalized.
 */
export const DEFAULT_EXCLUDE_BARE = [
  'node_modules',
  '**/node_modules',
  'dist',
  '.git',
  'build',
  'vendor',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '**/.pnp.*',
  '.yarn/cache',
  '.yarn/unplugged',
];

export function getDefaultExcludeForLanguages(languages: string[]): string[] {
  const merged = new Set<string>(COMMON_EXCLUDE);
  for (const lang of languages) {
    const excludes =
      LANGUAGE_EXCLUDE_DEFAULTS[lang] ??
      LANGUAGE_EXCLUDE_DEFAULTS.typescript ??
      LANGUAGE_EXCLUDE_DEFAULTS.generic ??
      [];
    excludes.forEach((e) => merged.add(e));
  }
  return Array.from(merged);
}
