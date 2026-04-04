import fs from 'fs';
import yaml from 'js-yaml';
import type { RepoConfig, IndexerFileConfig, RepoOverrides } from './types.js';

const CONFIG_FILE = 'paparats-indexer.yml';

/**
 * Deep-merge repo overrides with defaults. Repo-level values win.
 */
function mergeOverrides(
  defaults: IndexerFileConfig['defaults'],
  repo: RepoOverrides
): RepoOverrides {
  if (!defaults) return repo;

  const merged: RepoOverrides = {};

  // Simple scalar fields: repo wins over defaults
  merged.group = repo.group ?? defaults.group;
  merged.language = repo.language ?? defaults.language;

  // indexing: merge objects, repo wins per-field
  if (defaults.indexing || repo.indexing) {
    merged.indexing = {
      ...defaults.indexing,
      ...repo.indexing,
    };
    // For array fields, repo replaces entirely (not concatenated)
    if (repo.indexing?.exclude) merged.indexing.exclude = repo.indexing.exclude;
    if (repo.indexing?.paths) merged.indexing.paths = repo.indexing.paths;
    if (repo.indexing?.extensions) merged.indexing.extensions = repo.indexing.extensions;
  }

  // metadata: merge objects, repo wins per-field
  if (defaults.metadata || repo.metadata) {
    merged.metadata = {
      ...defaults.metadata,
      ...repo.metadata,
    };
    if (defaults.metadata?.git || repo.metadata?.git) {
      merged.metadata.git = {
        ...defaults.metadata?.git,
        ...repo.metadata?.git,
      };
    }
  }

  return merged;
}

/**
 * Parse a single repo entry from the config file into a RepoConfig.
 */
function parseRepoEntry(
  entry: IndexerFileConfig['repos'][number],
  defaults: IndexerFileConfig['defaults'],
  token?: string
): RepoConfig {
  const fullName = entry.url.trim();
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${fullName}". Expected "owner/repo".`);
  }
  const [owner, name] = parts as [string, string];
  const host = token ? `${token}@github.com` : 'github.com';
  const url = `https://${host}/${owner}/${name}.git`;

  // Extract overrides (everything except `url`)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { url: _url, ...repoOverrides } = entry;
  const overrides = mergeOverrides(defaults, repoOverrides);

  return {
    url,
    owner,
    name,
    fullName,
    overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
  };
}

/**
 * Validate the parsed config structure.
 */
function validateConfig(config: unknown): asserts config is IndexerFileConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid indexer config: expected YAML object');
  }

  const c = config as Record<string, unknown>;
  if (!Array.isArray(c['repos'])) {
    throw new Error('Invalid indexer config: "repos" must be an array');
  }

  for (const entry of c['repos'] as unknown[]) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Invalid indexer config: each repo entry must be an object');
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['url'] !== 'string' || !e['url']) {
      throw new Error('Invalid indexer config: each repo entry must have a "url" field');
    }
  }
}

export interface LoadConfigResult {
  repos: RepoConfig[];
  cron?: string;
}

/**
 * Load indexer config from YAML file.
 * Returns parsed repos with per-project overrides and optional cron.
 */
export function loadIndexerConfig(configPath: string, token?: string): LoadConfigResult {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  validateConfig(parsed);

  const repos = parsed.repos.map((entry) => parseRepoEntry(entry, parsed.defaults, token));
  const cron = parsed.defaults?.cron;

  return { repos, cron };
}

/**
 * Try to load indexer config from standard paths.
 * Returns null if no config file found.
 */
export function tryLoadIndexerConfig(configDir: string, token?: string): LoadConfigResult | null {
  const configPath = `${configDir}/${CONFIG_FILE}`;
  if (!fs.existsSync(configPath)) return null;

  console.log(`[indexer] Loading config from ${configPath}`);
  return loadIndexerConfig(configPath, token);
}

export { CONFIG_FILE };
