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

  return repos
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
}

/**
 * Clone a repo if it doesn't exist locally, or pull latest changes.
 * No-op for local-path projects (the bind-mount provides the files).
 */
export async function cloneOrPull(repo: RepoConfig, reposDir: string): Promise<void> {
  if (repo.localPath) {
    console.log(`[repo-manager] Local project ${repo.name} at ${repo.localPath} (bind-mounted)`);
    return;
  }

  const dest = path.join(reposDir, repo.owner, repo.name);

  if (fs.existsSync(path.join(dest, '.git'))) {
    console.log(`[repo-manager] Pulling latest for ${repo.fullName}...`);
    const git = simpleGit(dest);
    await git.pull();
  } else {
    console.log(`[repo-manager] Cloning ${repo.fullName}...`);
    fs.mkdirSync(path.join(reposDir, repo.owner), { recursive: true });
    const git = simpleGit();
    await git.clone(repo.url, dest);
  }
}

/**
 * Get the local path for a repo. Returns the bind-mounted path for local projects.
 */
export function repoPath(repo: RepoConfig, reposDir: string): string {
  if (repo.localPath) return repo.localPath;
  return path.join(reposDir, repo.owner, repo.name);
}
