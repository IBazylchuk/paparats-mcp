import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { RepoConfig, IndexerFileConfig, RepoOverrides } from './types.js';

/** Current name. */
const CONFIG_FILE = 'projects.yml';
/** Legacy name from paparats < 0.4 — kept as fallback so indexer keeps reading
 *  pre-rename installs until they migrate via `paparats install`. */
const LEGACY_CONFIG_FILE = 'paparats-indexer.yml';

/** Container-side mount root for local-path projects. */
const LOCAL_MOUNT_ROOT = '/projects';

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
    // exclude_extra: concatenate defaults + repo (both are additive)
    if (defaults.indexing?.exclude_extra || repo.indexing?.exclude_extra) {
      merged.indexing.exclude_extra = [
        ...(defaults.indexing?.exclude_extra ?? []),
        ...(repo.indexing?.exclude_extra ?? []),
      ];
    }
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
 * Entry must have exactly one source: `url` (remote git) or `path` (local bind-mount).
 */
function parseRepoEntry(
  entry: IndexerFileConfig['repos'][number],
  defaults: IndexerFileConfig['defaults'],
  token?: string
): RepoConfig {
  const hasUrl = typeof entry.url === 'string' && entry.url.trim().length > 0;
  const hasPath = typeof entry.path === 'string' && entry.path.trim().length > 0;

  if (hasUrl && hasPath) {
    throw new Error(
      `Invalid repo entry: cannot set both "url" and "path" (got url="${entry.url}", path="${entry.path}")`
    );
  }
  if (!hasUrl && !hasPath) {
    throw new Error('Invalid repo entry: must set exactly one of "url" or "path"');
  }

  // Extract overrides (everything except `url` / `path` / `name`)
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { url: _url, path: _path, name: _name, ...repoOverrides } = entry;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  const overrides = mergeOverrides(defaults, repoOverrides);

  if (hasPath) {
    const localHostPath = entry.path!.trim();
    if (!path.isAbsolute(localHostPath)) {
      throw new Error(`Invalid local path "${localHostPath}": must be absolute`);
    }
    const name = (entry.name?.trim() || path.basename(localHostPath)).trim();
    if (!name) {
      throw new Error(`Invalid local path "${localHostPath}": cannot derive project name`);
    }
    return {
      url: '',
      owner: '_local',
      name,
      fullName: name,
      localPath: `${LOCAL_MOUNT_ROOT}/${name}`,
      overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    };
  }

  // Remote git repo path
  const fullName = entry.url!.trim();
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${fullName}". Expected "owner/repo".`);
  }
  const [owner, repoName] = parts as [string, string];
  const host = token ? `${token}@github.com` : 'github.com';
  const url = `https://${host}/${owner}/${repoName}.git`;
  const name = (entry.name?.trim() || repoName).trim();

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
    const hasUrl = typeof e['url'] === 'string' && (e['url'] as string).length > 0;
    const hasPath = typeof e['path'] === 'string' && (e['path'] as string).length > 0;
    if (!hasUrl && !hasPath) {
      throw new Error('Invalid indexer config: each repo entry must have a "url" or "path" field');
    }
  }
}

export interface LoadConfigResult {
  repos: RepoConfig[];
  cron?: string;
  cronFast?: string;
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

  // Reject duplicate project names within the file (regardless of source).
  const seen = new Map<string, number>();
  for (let i = 0; i < repos.length; i++) {
    const name = repos[i]!.name;
    const prior = seen.get(name);
    if (prior !== undefined) {
      throw new Error(
        `Duplicate project name "${name}" in indexer config (entries #${prior + 1} and #${i + 1})`
      );
    }
    seen.set(name, i);
  }

  const cron = parsed.defaults?.cron;
  const cronFast = parsed.defaults?.cron_fast;
  return { repos, cron, cronFast };
}

/**
 * Resolve which config file to load, preferring the new name and falling back
 * to the legacy paparats-indexer.yml. Returns null if neither file exists.
 */
export function resolveConfigPath(configDir: string): string | null {
  const next = `${configDir}/${CONFIG_FILE}`;
  if (fs.existsSync(next)) return next;
  const legacy = `${configDir}/${LEGACY_CONFIG_FILE}`;
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/**
 * Try to load indexer config from standard paths.
 * Returns null if no config file found.
 */
export function tryLoadIndexerConfig(configDir: string, token?: string): LoadConfigResult | null {
  const configPath = resolveConfigPath(configDir);
  if (!configPath) return null;

  if (configPath.endsWith(LEGACY_CONFIG_FILE)) {
    console.warn(
      `[indexer] Loading legacy ${LEGACY_CONFIG_FILE}. Run \`paparats install\` to rename it to ${CONFIG_FILE}.`
    );
  } else {
    console.log(`[indexer] Loading config from ${configPath}`);
  }
  return loadIndexerConfig(configPath, token);
}

export { CONFIG_FILE, LEGACY_CONFIG_FILE };
