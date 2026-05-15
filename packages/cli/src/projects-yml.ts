import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import {
  generateCompose,
  type LocalProjectMount,
  type OllamaMode,
} from './docker-compose-generator.js';

export const PAPARATS_HOME = path.join(os.homedir(), '.paparats');
export const INDEXER_YML = 'paparats-indexer.yml';
export const COMPOSE_YML = 'docker-compose.yml';
export const INSTALL_STATE = 'install.json';

export interface InstallState {
  ollamaMode: OllamaMode;
  ollamaUrl?: string;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  cron?: string;
}

/** Read ~/.paparats/install.json — captured by `paparats install` so that
 *  `add`/`remove`/`edit projects` can regenerate compose with the same flags. */
export function readInstallState(home: string = PAPARATS_HOME): InstallState | null {
  const file = path.join(home, INSTALL_STATE);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as InstallState;
  } catch {
    return null;
  }
}

export function writeInstallState(state: InstallState, home: string = PAPARATS_HOME): void {
  const file = path.join(home, INSTALL_STATE);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

export interface ProjectEntry {
  /** Mutually exclusive with `path`. */
  url?: string;
  /** Mutually exclusive with `url`. */
  path?: string;
  /** Optional override for the project name. */
  name?: string;
  group?: string;
  language?: string | string[];
  // Pass-through for any indexer-supported override field; we don't enumerate them.
  [key: string]: unknown;
}

export interface ProjectsFile {
  defaults?: {
    cron?: string;
    group?: string;
    language?: string | string[];
    [key: string]: unknown;
  };
  repos: ProjectEntry[];
}

/** Read paparats-indexer.yml from disk. Returns an empty file shape if missing. */
export function readProjectsFile(home: string = PAPARATS_HOME): ProjectsFile {
  const file = path.join(home, INDEXER_YML);
  if (!fs.existsSync(file)) return { repos: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid ${file}: expected a YAML object`);
  }
  const obj = parsed as Record<string, unknown>;
  const repos = Array.isArray(obj['repos']) ? (obj['repos'] as ProjectEntry[]) : [];
  const defaults = obj['defaults'] as ProjectsFile['defaults'];
  return defaults ? { defaults, repos } : { repos };
}

/** Atomically write paparats-indexer.yml. */
export function writeProjectsFile(file: ProjectsFile, home: string = PAPARATS_HOME): void {
  const target = path.join(home, INDEXER_YML);
  const tmp = `${target}.tmp`;
  const out =
    HEADER +
    yaml.dump(file, { lineWidth: 120, noRefs: true, quotingType: "'", forceQuotes: false });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, target);
}

const HEADER = `# paparats-mcp — project list (read by indexer at /config/paparats-indexer.yml)
# Edit this file or use: paparats add | paparats remove | paparats edit projects
# The indexer hot-reloads on save; saves trigger reindex.
`;

/** Resolve the project name from an entry (basename(path) or repo of url, override wins). */
export function resolveProjectName(entry: ProjectEntry): string {
  if (entry.name && entry.name.trim()) return entry.name.trim();
  if (entry.path) return path.basename(entry.path);
  if (entry.url) {
    // url is "owner/repo"
    const parts = entry.url.split('/');
    const last = parts[parts.length - 1] ?? '';
    return last.replace(/\.git$/, '');
  }
  throw new Error('Project entry has neither path nor url');
}

/** Extract local-path projects in the order the compose generator expects. */
export function localProjectsFor(file: ProjectsFile): LocalProjectMount[] {
  const result: LocalProjectMount[] = [];
  for (const entry of file.repos) {
    if (!entry.path) continue;
    result.push({ name: resolveProjectName(entry), hostPath: entry.path });
  }
  return result;
}

export interface RegenerateOptions {
  ollamaMode: OllamaMode;
  ollamaUrl?: string;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  cron?: string;
  paparatsHome?: string;
}

export interface RegenerateResult {
  /** True iff the on-disk compose changed. */
  changed: boolean;
  /** The new compose contents (whether or not the file changed). */
  composeYaml: string;
}

/**
 * Read paparats-indexer.yml, regenerate the compose, and rewrite docker-compose.yml
 * if (and only if) the contents differ.
 */
export function regenerateCompose(opts: RegenerateOptions): RegenerateResult {
  const home = opts.paparatsHome ?? PAPARATS_HOME;
  const file = readProjectsFile(home);
  const composeYaml = generateCompose({
    ollamaMode: opts.ollamaMode,
    ...(opts.ollamaUrl !== undefined ? { ollamaUrl: opts.ollamaUrl } : {}),
    ...(opts.qdrantUrl !== undefined ? { qdrantUrl: opts.qdrantUrl } : {}),
    ...(opts.qdrantApiKey !== undefined ? { qdrantApiKey: opts.qdrantApiKey } : {}),
    ...(opts.cron !== undefined ? { cron: opts.cron } : {}),
    paparatsHome: home,
    localProjects: localProjectsFor(file),
  });
  const composePath = path.join(home, COMPOSE_YML);
  const prior = fs.existsSync(composePath) ? fs.readFileSync(composePath, 'utf8') : null;
  if (prior === composeYaml) return { changed: false, composeYaml };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(composePath, composeYaml);
  return { changed: true, composeYaml };
}
