import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { simpleGit } from 'simple-git';
import { glob } from 'glob';
import { filterFilesByGitignore, filterFilesWithinRoot } from '@paparats/shared';
import type { ProjectConfig } from '@paparats/server';
import { redactCredentials } from './repo-manager.js';
import type { RepoConfig } from './types.js';

export interface Fingerprint {
  kind: 'git' | 'mtime';
  value: string;
}

/**
 * Remote-git detector. Queries `git ls-remote <url> HEAD` and uses the SHA as
 * the fingerprint. No working copy required — this is what makes the fast
 * cron cheap for cloud repos.
 *
 * Any failure to compute a fingerprint surfaces as a thrown error; callers
 * treat that as "unknown → reindex defensively, do not advance state".
 */
export class GitDetector {
  async fingerprint(repo: RepoConfig): Promise<Fingerprint> {
    if (!repo.url) {
      throw new Error(`GitDetector requires a remote url; got empty for ${repo.fullName}`);
    }
    const git = simpleGit();
    let result: string;
    try {
      result = await git.listRemote(['--symref', repo.url, 'HEAD']);
    } catch (err) {
      // git echoes the URL, which carries the token for private repos.
      throw new Error(`ls-remote failed: ${redactCredentials((err as Error).message)}`, {
        cause: err,
      });
    }
    const sha = parseLsRemoteHead(result);
    if (!sha) {
      throw new Error(`Could not parse HEAD sha from ls-remote output for ${repo.fullName}`);
    }
    return { kind: 'git', value: sha };
  }
}

/** Globs the docs pass walks (see Indexer.indexDocsProject). */
const DOCS_PATTERNS = ['**/*.md', '**/*.markdown'];

export interface MtimeDetectorOptions {
  /**
   * Also hash the markdown files the docs pass indexes. Set when docs indexing
   * is on, so an edit that only touches documentation still triggers a reindex.
   */
  includeDocs?: boolean;
}

/**
 * Local-path detector. Hashes (relPath, mtime_ms, size) across the same set
 * of files indexProject() would walk — plus the docs pass's markdown when
 * `includeDocs` is set. Catches uncommitted edits, additions, and removals.
 * False positives (touch without content change) are safe — indexProject's
 * per-file hash check will skip unchanged chunks anyway.
 */
export class MtimeDetector {
  private readonly includeDocs: boolean;

  constructor(opts: MtimeDetectorOptions = {}) {
    this.includeDocs = opts.includeDocs === true;
  }

  async fingerprint(localPath: string, project: ProjectConfig): Promise<Fingerprint> {
    if (!fs.existsSync(localPath)) {
      throw new Error(`Project path not found: ${localPath}`);
    }

    const patterns = this.includeDocs ? [...project.patterns, ...DOCS_PATTERNS] : project.patterns;
    const fileSet = new Set<string>();
    for (const pattern of patterns) {
      const found = await glob(pattern, {
        cwd: localPath,
        absolute: true,
        ignore: project.exclude,
        nodir: true,
      });
      found.forEach((f) => fileSet.add(f));
    }
    let files = filterFilesWithinRoot(Array.from(fileSet), localPath);
    if (project.indexing.respectGitignore) {
      files = filterFilesByGitignore(files, localPath);
    }
    files.sort();

    const hash = crypto.createHash('sha256');
    hash.update(`count=${files.length}\n`);

    // Stat in bounded-concurrency batches. Promise.all over every file at
    // once would open thousands of concurrent fds; a tight sync loop blocks
    // the event loop. 64 is a reasonable balance for an indexer workload.
    const BATCH = 64;
    for (let i = 0; i < files.length; i += BATCH) {
      const slice = files.slice(i, i + BATCH);
      const stats = await Promise.all(
        slice.map(async (file) => {
          try {
            return { file, stat: await fs.promises.stat(file) };
          } catch {
            return null;
          }
        })
      );
      for (const entry of stats) {
        if (!entry) continue;
        const rel = path.relative(localPath, entry.file);
        hash.update(`${rel}\0${entry.stat.mtimeMs}\0${entry.stat.size}\n`);
      }
    }

    return { kind: 'mtime', value: hash.digest('hex') };
  }
}

/**
 * Parse `git ls-remote --symref <url> HEAD`. The output looks like:
 *   ref: refs/heads/main    HEAD
 *   <sha>    HEAD
 * We want the sha on the HEAD line. Plain `ls-remote HEAD` (no --symref)
 * returns just `<sha>\tHEAD`, which also matches.
 */
export function parseLsRemoteHead(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('ref:')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'HEAD' && parts[0] && /^[0-9a-f]{40}$/.test(parts[0])) {
      return parts[0];
    }
  }
  return null;
}
