import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseReposEnv, cloneOrPull, repoPath } from '../src/repo-manager.js';
import type { RepoConfig } from '../src/types.js';

// Spy-able simple-git mock that records pull/clone calls.
const pullCalls: string[] = [];
const cloneCalls: Array<{ url: string; dest: string }> = [];
let activeRepoPath: string | undefined;

vi.mock('simple-git', () => ({
  simpleGit: (cwd?: string) => {
    activeRepoPath = cwd;
    return {
      pull: vi.fn().mockImplementation(async () => {
        if (activeRepoPath) pullCalls.push(activeRepoPath);
      }),
      clone: vi.fn().mockImplementation(async (url: string, dest: string) => {
        cloneCalls.push({ url, dest });
      }),
    };
  },
}));

describe('parseReposEnv', () => {
  it('parses single repo', () => {
    const repos = parseReposEnv('org/repo');
    expect(repos).toHaveLength(1);
    expect(repos[0]!.owner).toBe('org');
    expect(repos[0]!.name).toBe('repo');
    expect(repos[0]!.fullName).toBe('org/repo');
    expect(repos[0]!.url).toBe('https://github.com/org/repo.git');
  });

  it('parses multiple repos', () => {
    const repos = parseReposEnv('org/a,org/b,other/c');
    expect(repos).toHaveLength(3);
    expect(repos[0]!.fullName).toBe('org/a');
    expect(repos[1]!.fullName).toBe('org/b');
    expect(repos[2]!.fullName).toBe('other/c');
  });

  it('trims whitespace', () => {
    const repos = parseReposEnv(' org/a , org/b ');
    expect(repos).toHaveLength(2);
    expect(repos[0]!.fullName).toBe('org/a');
    expect(repos[1]!.fullName).toBe('org/b');
  });

  it('returns empty array for empty string', () => {
    expect(parseReposEnv('')).toHaveLength(0);
    expect(parseReposEnv('  ')).toHaveLength(0);
  });

  it('includes token in URL when provided', () => {
    const repos = parseReposEnv('org/repo', 'ghp_abc123');
    expect(repos[0]!.url).toBe('https://ghp_abc123@github.com/org/repo.git');
  });

  it('does not include token when not provided', () => {
    const repos = parseReposEnv('org/repo');
    expect(repos[0]!.url).toBe('https://github.com/org/repo.git');
  });

  it('throws for invalid repo format', () => {
    expect(() => parseReposEnv('just-a-name')).toThrow(/Invalid repo format/);
  });

  it('throws for too many slashes', () => {
    expect(() => parseReposEnv('a/b/c')).toThrow(/Invalid repo format/);
  });

  it('skips empty entries from trailing comma', () => {
    const repos = parseReposEnv('org/a,');
    expect(repos).toHaveLength(1);
    expect(repos[0]!.fullName).toBe('org/a');
  });
});

describe('repoPath', () => {
  it('returns bind-mount path for local projects', () => {
    const repo: RepoConfig = {
      url: '',
      owner: '_local',
      name: 'billing',
      fullName: 'billing',
      localPath: '/projects/billing',
    };
    expect(repoPath(repo, '/data/repos')).toBe('/projects/billing');
  });

  it('returns reposDir/owner/name for remote projects', () => {
    const repo: RepoConfig = {
      url: 'https://github.com/org/repo.git',
      owner: 'org',
      name: 'repo',
      fullName: 'org/repo',
    };
    expect(repoPath(repo, '/data/repos')).toBe(path.join('/data/repos', 'org', 'repo'));
  });
});

describe('cloneOrPull', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-repo-mgr-'));
    pullCalls.length = 0;
    cloneCalls.length = 0;
    activeRepoPath = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op for local projects (no git operations)', async () => {
    const repo: RepoConfig = {
      url: '',
      owner: '_local',
      name: 'billing',
      fullName: 'billing',
      localPath: '/projects/billing',
    };
    await cloneOrPull(repo, tmpDir);
    expect(pullCalls).toHaveLength(0);
    expect(cloneCalls).toHaveLength(0);
  });

  it('clones remote repo when destination missing', async () => {
    const repo: RepoConfig = {
      url: 'https://github.com/org/repo.git',
      owner: 'org',
      name: 'repo',
      fullName: 'org/repo',
    };
    await cloneOrPull(repo, tmpDir);
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]!.url).toBe('https://github.com/org/repo.git');
    expect(cloneCalls[0]!.dest).toBe(path.join(tmpDir, 'org', 'repo'));
    expect(pullCalls).toHaveLength(0);
  });

  it('pulls remote repo when .git directory exists', async () => {
    const repo: RepoConfig = {
      url: 'https://github.com/org/repo.git',
      owner: 'org',
      name: 'repo',
      fullName: 'org/repo',
    };
    const dest = path.join(tmpDir, 'org', 'repo', '.git');
    fs.mkdirSync(dest, { recursive: true });
    await cloneOrPull(repo, tmpDir);
    expect(pullCalls).toHaveLength(1);
    expect(pullCalls[0]).toBe(path.join(tmpDir, 'org', 'repo'));
    expect(cloneCalls).toHaveLength(0);
  });
});
