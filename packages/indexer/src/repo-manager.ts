import { simpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import type { RepoConfig } from './types.js';

/**
 * Parse comma-separated repos env into RepoConfig[].
 * Accepts formats: "org/repo", "org/repo,org/other"
 */
export function parseReposEnv(repos: string, token?: string): RepoConfig[] {
  if (!repos.trim()) return [];

  const parsed = repos
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((fullName) => {
      const parts = fullName.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format: "${fullName}". Expected "owner/repo".`);
      }
      const [owner, name] = parts as [string, string];
      const host = token ? `${token}@github.com` : 'github.com';
      const url = `https://${host}/${owner}/${name}.git`;
      return { url, owner, name, fullName };
    });

  // The project name is the repo name, so `org1/api,org2/api` would put two
  // projects called `api` into one group, each overwriting the other's chunks.
  const seen = new Map<string, string>();
  for (const repo of parsed) {
    const prior = seen.get(repo.name);
    if (prior !== undefined) {
      throw new Error(
        `Duplicate project name "${repo.name}" in REPOS ("${prior}" and "${repo.fullName}"). ` +
          'Use projects.yml with a `name:` override to index both.'
      );
    }
    seen.set(repo.name, repo.fullName);
  }
  return parsed;
}

/** Mask credentials embedded in URLs (`https://<token>@host/...`) for logs and errors. */
export function redactCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
}

/**
 * Clone a repo if it doesn't exist locally, otherwise bring the clone to the
 * remote's current default branch. No-op for local-path projects (the
 * bind-mount provides the files).
 *
 * Clones under `reposDir` are a managed cache, never edited by hand, so the
 * update is a forced sync rather than a merge: it re-points origin at the
 * configured URL (a rotated token or a moved repo would otherwise fail
 * forever), fetches with prune, follows a renamed default branch, and
 * hard-resets onto it (survives upstream force-pushes). Any failure — or a
 * leftover directory from an interrupted clone — falls back to deleting the
 * directory and cloning fresh.
 *
 * Errors are rethrown with credentials masked: the URL carries the token.
 */
export async function cloneOrPull(repo: RepoConfig, reposDir: string): Promise<void> {
  if (repo.localPath) {
    console.log(`[repo-manager] Local project ${repo.name} at ${repo.localPath} (bind-mounted)`);
    return;
  }

  const dest = path.join(reposDir, repo.owner, repo.name);

  if (fs.existsSync(path.join(dest, '.git'))) {
    console.log(`[repo-manager] Updating ${repo.fullName}...`);
    try {
      await syncClone(dest, repo.url);
      return;
    } catch (err) {
      console.warn(
        `[repo-manager] ${repo.fullName}: update failed (${redactCredentials((err as Error).message)}), re-cloning`
      );
    }
  }

  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  console.log(`[repo-manager] Cloning ${repo.fullName}...`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await simpleGit().clone(repo.url, dest);
  } catch (err) {
    // Don't leave a half-written clone behind for the next run to trip over.
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error(
      `git clone failed for ${repo.fullName}: ${redactCredentials((err as Error).message)}`,
      { cause: err }
    );
  }
}

/** Force an existing clone onto origin's default branch. Throws on any git failure. */
async function syncClone(dest: string, url: string): Promise<void> {
  const git = simpleGit(dest);
  await git.remote(['set-url', 'origin', url]);
  await git.fetch(['--prune', 'origin']);
  // Re-resolve origin/HEAD from the remote so a renamed default branch is followed.
  await git.remote(['set-head', 'origin', '--auto']);
  await git.reset(['--hard', 'origin/HEAD']);
  await git.raw(['clean', '--force', '-d', '-x']);
}

/**
 * Get the local path for a repo. Returns the bind-mounted path for local projects.
 */
export function repoPath(repo: RepoConfig, reposDir: string): string {
  if (repo.localPath) return repo.localPath;
  return path.join(reposDir, repo.owner, repo.name);
}
