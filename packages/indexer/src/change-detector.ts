import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { simpleGit } from 'simple-git';
import { glob } from 'glob';
import { filterFilesByGitignore } from '@paparats/shared';
import type { ProjectConfig } from '@paparats/server';
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
    const result = await git.listRemote(['--symref', repo.url, 'HEAD']);
    const sha = parseLsRemoteHead(result);
    if (!sha) {
      throw new Error(`Could not parse HEAD sha from ls-remote output for ${repo.fullName}`);
    }
    return { kind: 'git', value: sha };
  }
}

/**
 * Local-path detector. Hashes (relPath, mtime_ms, size) across the same set
 * of files indexProject() would walk. Catches uncommitted edits, additions,
 * and removals. False positives (touch without content change) are safe —
 * indexProject's per-file hash check will skip unchanged chunks anyway.
 */
export class MtimeDetector {
  async fingerprint(localPath: string, project: ProjectConfig): Promise<Fingerprint> {
    if (!fs.existsSync(localPath)) {
      throw new Error(`Project path not found: ${localPath}`);
    }

    const fileSet = new Set<string>();
    for (const pattern of project.patterns) {
      const found = await glob(pattern, {
        cwd: localPath,
        absolute: true,
        ignore: project.exclude,
        nodir: true,
      });
      found.forEach((f) => fileSet.add(f));
    }
    let files = Array.from(fileSet);
    if (project.indexing.respectGitignore) {
      files = filterFilesByGitignore(files, localPath);
    }
    files.sort();

    const hash = crypto.createHash('sha256');
    hash.update(`count=${files.length}\n`);
    for (const file of files) {
      const rel = path.relative(localPath, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      hash.update(`${rel}\0${stat.mtimeMs}\0${stat.size}\n`);
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
