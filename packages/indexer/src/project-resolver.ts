import fs from 'fs';
import path from 'path';
import { readConfig, resolveProject, detectLanguages, CONFIG_FILE } from '@paparats/server';
import type { PaparatsConfig, ProjectConfig } from '@paparats/server';
import { DEFAULT_GROUP } from '@paparats/shared';
import type { RepoConfig, RepoOverrides } from './types.js';

export interface ResolveRepoOptions {
  /** `PAPARATS_GROUP`: when set, every repo lands in this group, whatever its config says. */
  sharedGroup?: string;
}

/** Which inputs produced a resolved project — for the indexer's log line. */
export type ProjectSource = 'repo-config' | 'repo-config+overrides' | 'overrides' | 'auto';

export interface ResolvedRepoProject {
  project: ProjectConfig;
  source: ProjectSource;
}

/**
 * Resolve a `ProjectConfig` for a repo already on disk from whichever sources
 * apply: `.paparats.yml` in the repo, projects.yml overrides, auto-detection.
 *
 * Every path builds a raw `PaparatsConfig` and runs it through the server's
 * `resolveProject`, so excludes are normalized, glob patterns are derived from
 * `indexing.paths`, and paths are validated the same way however the config
 * was assembled. Group precedence is `sharedGroup` > override > `.paparats.yml`
 * > DEFAULT_GROUP.
 */
export function resolveRepoProject(
  repo: RepoConfig,
  localPath: string,
  opts: ResolveRepoOptions = {}
): ResolvedRepoProject {
  const overrides = repo.overrides;
  const hasRepoConfig = fs.existsSync(path.join(localPath, CONFIG_FILE));

  let raw: PaparatsConfig;
  let source: ProjectSource;
  if (hasRepoConfig) {
    raw = mergeOverrides(readConfig(localPath), overrides);
    source = overrides ? 'repo-config+overrides' : 'repo-config';
  } else {
    raw = {
      group: overrides?.group ?? DEFAULT_GROUP,
      language: overrides?.language ?? detectLanguages(localPath),
    };
    if (overrides?.indexing) raw.indexing = overrides.indexing;
    if (overrides?.metadata) raw.metadata = overrides.metadata;
    if (overrides?.docs) raw.docs = overrides.docs;
    source = overrides ? 'overrides' : 'auto';
  }
  if (opts.sharedGroup) raw.group = opts.sharedGroup;

  const project = resolveProject(localPath, raw);
  // The indexer runs on cron, not filesystem events.
  project.watcher.enabled = false;
  return { project, source };
}

/**
 * Layer projects.yml overrides onto a repo's own `.paparats.yml` (overrides
 * win). Only the fields the indexer has always applied on top of a repo config
 * are merged: `group`, `docs.kind` and `indexing.*`. `exclude` replaces the
 * repo's list; `exclude_extra` is appended to the repo's own extras.
 */
function mergeOverrides(raw: PaparatsConfig, overrides: RepoOverrides | undefined): PaparatsConfig {
  if (!overrides) return raw;
  const merged: PaparatsConfig = { ...raw };
  if (overrides.group) merged.group = overrides.group;

  // An explicit kind wins over auto-detection, which keys off whether the repo
  // contains code and so misreads a docs repo that ships its own tooling.
  if (overrides.docs?.kind !== undefined) {
    merged.docs = { ...raw.docs, kind: overrides.docs.kind };
  }

  const o = overrides.indexing;
  if (o) {
    const indexing = { ...raw.indexing };
    if (o.exclude) indexing.exclude = o.exclude;
    if (o.exclude_extra)
      indexing.exclude_extra = [...(indexing.exclude_extra ?? []), ...o.exclude_extra];
    if (o.paths) indexing.paths = o.paths;
    if (o.extensions) indexing.extensions = o.extensions;
    if (o.respectGitignore !== undefined) indexing.respectGitignore = o.respectGitignore;
    if (o.chunkSize !== undefined) indexing.chunkSize = o.chunkSize;
    if (o.overlap !== undefined) indexing.overlap = o.overlap;
    if (o.concurrency !== undefined) indexing.concurrency = o.concurrency;
    if (o.batchSize !== undefined) indexing.batchSize = o.batchSize;
    merged.indexing = indexing;
  }
  return merged;
}
