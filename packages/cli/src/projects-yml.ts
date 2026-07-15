import fs from 'fs';
import path from 'path';
import os from 'os';
import * as yaml from 'js-yaml';
import { DEFAULT_GROUP, LANGUAGE_EXCLUDE_DEFAULTS } from '@paparats/shared';
import {
  generateCompose,
  type EmbeddingProvider,
  type LocalProjectMount,
  type EmbedMode,
} from './docker-compose-generator.js';

export const PAPARATS_HOME = path.join(os.homedir(), '.paparats');
/** Current name. Used by all reads after install. */
export const PROJECTS_YML = 'projects.yml';
/** Legacy name from paparats < 0.4. Read as fallback; auto-renamed by `paparats install`. */
export const LEGACY_PROJECTS_YML = 'paparats-indexer.yml';
export const COMPOSE_YML = 'docker-compose.yml';
export const INSTALL_STATE = 'install.json';

/**
 * Migrate the legacy projects file to the new name if needed. Returns true iff
 * the rename actually happened. Idempotent: no-op when projects.yml already
 * exists or the legacy file doesn't.
 */
export function migrateLegacyProjectsFile(home: string = PAPARATS_HOME): boolean {
  const next = path.join(home, PROJECTS_YML);
  const legacy = path.join(home, LEGACY_PROJECTS_YML);
  if (fs.existsSync(next)) return false;
  if (!fs.existsSync(legacy)) return false;
  fs.renameSync(legacy, next);
  return true;
}

/**
 * Resolve the current projects file path, preferring the new name and falling
 * back to the legacy one. Returns null if neither exists.
 */
export function resolveProjectsFilePath(home: string = PAPARATS_HOME): string | null {
  const next = path.join(home, PROJECTS_YML);
  if (fs.existsSync(next)) return next;
  const legacy = path.join(home, LEGACY_PROJECTS_YML);
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

export interface InstallState {
  embedMode: EmbedMode;
  embedUrl?: string;
  /** Embedding provider chosen at install time. Absent on legacy installs (treated as 'llama'). */
  embeddingProvider?: EmbeddingProvider;
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

/**
 * Read the projects file from disk. Prefers the new name (projects.yml);
 * falls back to the legacy paparats-indexer.yml if only that exists.
 * Returns an empty file shape if neither is present.
 */
export function readProjectsFile(home: string = PAPARATS_HOME): ProjectsFile {
  const file = resolveProjectsFilePath(home);
  if (!file) return { repos: [] };
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

export interface WriteProjectsOptions {
  /**
   * Splice a commented hint block after the given entry index (0-based).
   * Used by `paparats add` to render a per-language `exclude_extra` starter
   * next to the freshly added entry. No-op if the entry can't be located.
   */
  hint?: { entryIndex: number; block: string };
}

/**
 * Atomically write the projects file. Always writes to the new name —
 * callers that want to migrate a legacy file should call
 * `migrateLegacyProjectsFile` first.
 */
export function writeProjectsFile(
  file: ProjectsFile,
  home: string = PAPARATS_HOME,
  opts: WriteProjectsOptions = {}
): void {
  const target = path.join(home, PROJECTS_YML);
  const tmp = `${target}.tmp`;
  let body = yaml.dump(file, {
    lineWidth: 120,
    noRefs: true,
    quoteStyle: 'single',
    forceQuotes: false,
  });
  if (opts.hint) {
    body = spliceHintAfterEntry(body, opts.hint.entryIndex, opts.hint.block);
  }
  const out = HEADER + body;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, target);
}

const HEADER = `# paparats-mcp — project list (read by indexer at /config/projects.yml)
# Edit this file or use: paparats add | paparats remove | paparats edit projects
# The indexer hot-reloads on save; saves trigger reindex.
#
# Per-entry fields (path OR url required; everything else optional):
#   path: /absolute/host/path         # local bind-mount  (mutex with url)
#   url:  owner/repo                  # remote git repo   (mutex with path)
#   name: my-project                  # override derived name
#   group: my-team                    # Qdrant collection bucket (default: defaults.group → 'default')
#   language: ruby                    # or [ruby, javascript]; auto-detected on \`paparats add\` from marker files
#   indexing:
#     paths: ['app/**', 'lib/**']     # restrict to subtrees           (default: whole repo)
#     exclude: ['vendor', 'tmp']      # REPLACES per-language defaults (use only to opt out of defaults)
#     exclude_extra: ['fixtures']     # ADDS to per-language defaults  (preferred — purely additive)
#     extensions: ['.rb', '.erb']     # restrict file extensions
#   metadata:
#     git: { enabled: true, lookbackDays: 365 }
#
# Built-in per-language exclude defaults (node_modules, vendor, tmp, …) are applied automatically
# based on \`language:\`. New entries added via \`paparats add\` include a commented \`exclude_extra:\`
# starter showing those defaults, so you can see what's already in effect and uncomment to add more.
# Note: \`paparats add/remove/edit\` re-serialises this file and may strip comments you added by hand.
`;

/**
 * Render a commented `exclude_extra` starter block for a language.
 *
 * The block is inert (every line is `#`-prefixed) — the user uncomments + edits
 * to opt in. Each default exclude is annotated so it's clear the value is already
 * applied by the server even without uncommenting. Returns null when the language
 * has no defaults worth showing (e.g. 'generic' or unknown languages).
 *
 * `indent` is the per-entry indentation (e.g. '  ' for `repos:` children).
 */
export function renderExcludeHintComment(language: string, indent: string): string | null {
  const defaults = LANGUAGE_EXCLUDE_DEFAULTS[language];
  if (!defaults || defaults.length === 0) return null;
  if (language === 'generic') return null;

  const lines: string[] = [];
  lines.push(`${indent}# indexing:`);
  lines.push(
    `${indent}#   exclude_extra:    # additive — added on top of the built-in ${language} defaults`
  );
  for (const pat of defaults) {
    lines.push(`${indent}#     - ${pat}    # (already excluded by default for ${language})`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Splice a commented hint block into a freshly-dumped projects.yml after the
 * last property of the entry at `entryIndex` (0-based, in document order).
 *
 * Implementation: walk the YAML line-by-line, count list items at the `repos:`
 * indent (each list item starts with `- `), and when we reach the next item
 * (or EOF) splice the hint just before it. The hint must already be indented
 * to match the entry's property indent.
 *
 * Returns the input unchanged if the entry can't be located (defensive — the
 * file is still valid YAML, only the comment is missing).
 */
export function spliceHintAfterEntry(yamlText: string, entryIndex: number, hint: string): string {
  if (!hint) return yamlText;
  const lines = yamlText.split('\n');

  // Find the start of `repos:` (top-level key, no indent).
  const reposLineIdx = lines.findIndex((l) => /^repos:\s*$/.test(l));
  if (reposLineIdx === -1) return yamlText;

  let currentItem = -1;
  let insertBefore = -1;
  for (let i = reposLineIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // List-item start: exactly two-space indent + `- `. Anchored at the
    // `repos:` child indent so nested `- vendor` lines inside an entry's
    // own `exclude_extra:` don't get counted as new entries.
    if (/^ {2}- /.test(line)) {
      currentItem++;
      if (currentItem === entryIndex + 1) {
        insertBefore = i;
        break;
      }
      continue;
    }
    // Bound the search to the `repos:` block. Today our writer emits `repos:`
    // last so this branch is unreachable in practice, but the helper is
    // exported — if a future caller serialises top-level keys after `repos:`,
    // we still splice inside the block rather than after the trailing key.
    if (currentItem >= entryIndex && /^\S/.test(line)) {
      insertBefore = i;
      break;
    }
  }

  if (currentItem < entryIndex) return yamlText; // entry not found
  const idx = insertBefore === -1 ? lines.length : insertBefore;
  const before = lines.slice(0, idx).join('\n');
  const after = lines.slice(idx).join('\n');
  // Ensure the previous chunk ends with a newline before the hint.
  const sep = before.endsWith('\n') || before === '' ? '' : '\n';
  return before + sep + hint + after;
}

/**
 * Resolve the effective group for a project entry. Per-entry `group` wins,
 * then `defaults.group` from the projects file, then DEFAULT_GROUP. The
 * fallback intentionally is NOT the project's own name — that would silo
 * each project in its own Qdrant collection and break the multi-project
 * model (one group = one collection, projects share via the `project`
 * payload filter).
 */
export function resolveEntryGroup(entry: ProjectEntry, file: ProjectsFile): string {
  return entry.group ?? file.defaults?.group ?? DEFAULT_GROUP;
}

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
  embedMode: EmbedMode;
  embedUrl?: string;
  embeddingProvider?: EmbeddingProvider;
  qdrantUrl?: string;
  qdrantApiKey?: string;
  cron?: string;
  paparatsHome?: string;
  /**
   * When true, the existing compose is copied to docker-compose.yml.bak before
   * being overwritten — but only if its contents actually change. Used by
   * `paparats update` so hand-edits aren't silently lost across CLI upgrades.
   */
  backupOnChange?: boolean;
}

export interface RegenerateResult {
  /** True iff the on-disk compose changed. */
  changed: boolean;
  /** The new compose contents (whether or not the file changed). */
  composeYaml: string;
  /** Absolute path to the backup written when `backupOnChange` is set and contents changed. */
  backupPath?: string;
}

/**
 * Read the projects file, regenerate the compose, and rewrite docker-compose.yml
 * if (and only if) the contents differ.
 */
export function regenerateCompose(opts: RegenerateOptions): RegenerateResult {
  const home = opts.paparatsHome ?? PAPARATS_HOME;
  const file = readProjectsFile(home);
  const composeYaml = generateCompose({
    embedMode: opts.embedMode,
    ...(opts.embedUrl !== undefined ? { embedUrl: opts.embedUrl } : {}),
    ...(opts.embeddingProvider !== undefined ? { embeddingProvider: opts.embeddingProvider } : {}),
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
  let backupPath: string | undefined;
  if (opts.backupOnChange && prior !== null) {
    backupPath = `${composePath}.bak`;
    fs.writeFileSync(backupPath, prior);
  }
  fs.writeFileSync(composePath, composeYaml);
  return backupPath ? { changed: true, composeYaml, backupPath } : { changed: true, composeYaml };
}

/**
 * Find an `http(s)` value for an environment key, scoped to the top-level
 * `services:` block. A whole-file regex would also match a same-named key
 * under `volumes:`/`networks:`/`x-*` anchors; we enter the block on
 * `services:` and stop at the next column-0 key (`/^\S/`). Matches both YAML
 * map (`KEY: value`) and list (`- KEY=value`) env styles.
 */
function findEnvUrlInServices(composeContent: string, key: string): string | undefined {
  const pattern = new RegExp(`${key}[:=]\\s*['"]?(https?://[^\\s'"]+)`);
  let inServices = false;
  for (const raw of composeContent.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices) {
      if (/^\S/.test(line)) break; // next top-level key → out of services
      const m = line.match(pattern);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * Derive {@link RegenerateOptions} by parsing an existing docker-compose.yml.
 *
 * The fallback for installs that predate `install.json` (the Ollama-era
 * developer setups). Those compose files were generated by a CLI old enough to
 * omit the `EMBED_URL`/`OLLAMA_URL` env entirely, so we can't just read a URL
 * back out — we infer the mode from structural signals:
 *   - a `container_name: paparats-embed`  → embed runs in Docker  → `docker`
 *   - an explicit external `EMBED_URL`     → points off-box        → `external`
 *   - neither                              → embed runs natively on the host,
 *     which is exactly the legacy case that was left with no EMBED_URL at all
 *                                          → `native`
 *
 * Returning `native` here is what lets `paparats update` heal a legacy compose:
 * regeneration then writes the `EMBED_URL: http://host.docker.internal:18434`
 * that the Dockerised server/indexer need to reach the host embed server.
 */
export function deriveRegenerateOptsFromCompose(
  composeContent: string,
  paparatsHome: string = PAPARATS_HOME
): RegenerateOptions {
  const externalEmbedUrl = findEnvUrlInServices(composeContent, 'EMBED_URL');
  const isHostGateway = externalEmbedUrl?.includes('host.docker.internal');

  let embedMode: EmbedMode;
  let embedUrl: string | undefined;
  if (composeContent.includes('container_name: paparats-embed')) {
    embedMode = 'docker';
  } else if (externalEmbedUrl && !isHostGateway) {
    embedMode = 'external';
    embedUrl = externalEmbedUrl;
  } else {
    // No embed service and no off-box URL (incl. a legacy file with no
    // EMBED_URL at all) → embed is native on the host.
    embedMode = 'native';
  }

  const externalQdrant = !composeContent.includes('container_name: paparats-qdrant');
  const qdrantUrl = externalQdrant ? findEnvUrlInServices(composeContent, 'QDRANT_URL') : undefined;

  return {
    embedMode,
    ...(embedUrl !== undefined ? { embedUrl } : {}),
    ...(qdrantUrl !== undefined ? { qdrantUrl } : {}),
    paparatsHome,
  };
}
