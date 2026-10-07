import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cloneOrPull } from '../src/repo-manager.js';
import type { RepoConfig } from '../src/types.js';

// Runs real git against local bare repositories: the recovery paths (force
// push, default-branch rename, moved origin, broken clone) are git behaviour,
// which a mock cannot vouch for.

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

describe('cloneOrPull against a real git remote', () => {
  let base: string;
  let remote: string;
  let work: string;
  let reposDir: string;
  let repo: RepoConfig;

  const clonePath = () => path.join(reposDir, 'org', 'widgets');
  const read = (rel: string) => fs.readFileSync(path.join(clonePath(), rel), 'utf8');

  function commitFile(rel: string, content: string, message: string): void {
    fs.writeFileSync(path.join(work, rel), content);
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--message', message);
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-git-'));
    remote = path.join(base, 'remote.git');
    work = path.join(base, 'work');
    reposDir = path.join(base, 'repos');
    git(base, 'init', '--quiet', '--bare', remote);
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(base, 'init', '--quiet', work);
    git(work, 'checkout', '--quiet', '-b', 'main');
    commitFile('a.ts', 'v1', 'first');
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'push', '--quiet', 'origin', 'main');
    repo = { url: remote, owner: 'org', name: 'widgets', fullName: 'org/widgets' };
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('clones, then follows new commits', async () => {
    await cloneOrPull(repo, reposDir);
    expect(read('a.ts')).toBe('v1');

    commitFile('a.ts', 'v2', 'second');
    git(work, 'push', '--quiet', 'origin', 'main');
    await cloneOrPull(repo, reposDir);
    expect(read('a.ts')).toBe('v2');
  });

  it('survives an upstream force-push', async () => {
    await cloneOrPull(repo, reposDir);
    fs.writeFileSync(path.join(work, 'a.ts'), 'rewritten');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--amend', '--no-edit');
    git(work, 'push', '--quiet', '--force', 'origin', 'main');

    await cloneOrPull(repo, reposDir);
    expect(read('a.ts')).toBe('rewritten');
  });

  it('follows a renamed default branch', async () => {
    await cloneOrPull(repo, reposDir);
    git(work, 'checkout', '--quiet', '-b', 'trunk');
    commitFile('a.ts', 'on-trunk', 'trunk commit');
    git(work, 'push', '--quiet', 'origin', 'trunk');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    git(work, 'push', '--quiet', 'origin', '--delete', 'main');

    await cloneOrPull(repo, reposDir);
    expect(read('a.ts')).toBe('on-trunk');
  });

  it('re-points origin when the configured URL changes', async () => {
    await cloneOrPull(repo, reposDir);
    const moved = path.join(base, 'moved.git');
    fs.renameSync(remote, moved);
    git(work, 'remote', 'set-url', 'origin', moved);
    commitFile('a.ts', 'after-move', 'moved');
    git(work, 'push', '--quiet', 'origin', 'main');

    await cloneOrPull({ ...repo, url: moved }, reposDir);
    expect(read('a.ts')).toBe('after-move');
    expect(git(clonePath(), 'remote', 'get-url', 'origin').trim()).toBe(moved);
  });

  it('drops local modifications and untracked files', async () => {
    await cloneOrPull(repo, reposDir);
    fs.writeFileSync(path.join(clonePath(), 'a.ts'), 'tampered');
    fs.writeFileSync(path.join(clonePath(), 'stray.ts'), 'stray');

    await cloneOrPull(repo, reposDir);
    expect(read('a.ts')).toBe('v1');
    expect(fs.existsSync(path.join(clonePath(), 'stray.ts'))).toBe(false);
  });

  it('re-clones a corrupted clone', async () => {
    await cloneOrPull(repo, reposDir);
    fs.writeFileSync(path.join(clonePath(), '.git', 'HEAD'), 'garbage');
    const warn = console.warn;
    console.warn = () => {};
    try {
      await cloneOrPull(repo, reposDir);
    } finally {
      console.warn = warn;
    }
    expect(read('a.ts')).toBe('v1');
    expect(git(clonePath(), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });
});
