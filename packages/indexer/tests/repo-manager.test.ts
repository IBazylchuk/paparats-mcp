import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseReposEnv, cloneOrPull, repoPath, redactCredentials } from '../src/repo-manager.js';
import type { RepoConfig } from '../src/types.js';

// Spy-able simple-git mock that records every git call as `cwd: args`.
const gitCalls: string[] = [];
const cloneCalls: Array<{ url: string; dest: string }> = [];
let failSync = false;
let failClone = false;

vi.mock('simple-git', () => ({
  simpleGit: (cwd?: string) => {
    const record = (args: string[]) => {
      gitCalls.push(`${cwd ?? ''}: ${args.join(' ')}`);
      if (failSync)
        throw new Error('fatal: unable to access https://ghp_secret@github.com/org/repo.git');
    };
    return {
      remote: vi.fn().mockImplementation(async (args: string[]) => record(['remote', ...args])),
      fetch: vi.fn().mockImplementation(async (args: string[]) => record(['fetch', ...args])),
      reset: vi.fn().mockImplementation(async (args: string[]) => record(['reset', ...args])),
      raw: vi.fn().mockImplementation(async (args: string[]) => record(args)),
      clone: vi.fn().mockImplementation(async (url: string, dest: string) => {
        if (failClone) throw new Error(`fatal: repository '${url}' not found`);
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

  it('rejects two repos that resolve to the same project name', () => {
    expect(() => parseReposEnv('org1/api,org2/api')).toThrow(/Duplicate project name "api"/);
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
  const repo: RepoConfig = {
    url: 'https://ghp_secret@github.com/org/repo.git',
    owner: 'org',
    name: 'repo',
    fullName: 'org/repo',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-repo-mgr-'));
    gitCalls.length = 0;
    cloneCalls.length = 0;
    failSync = false;
    failClone = false;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op for local projects (no git operations)', async () => {
    const local: RepoConfig = {
      url: '',
      owner: '_local',
      name: 'billing',
      fullName: 'billing',
      localPath: '/projects/billing',
    };
    await cloneOrPull(local, tmpDir);
    expect(gitCalls).toHaveLength(0);
    expect(cloneCalls).toHaveLength(0);
  });

  it('clones remote repo when destination missing', async () => {
    await cloneOrPull(repo, tmpDir);
    expect(cloneCalls).toEqual([{ url: repo.url, dest: path.join(tmpDir, 'org', 'repo') }]);
    expect(gitCalls).toHaveLength(0);
  });

  it('force-syncs an existing clone onto the current origin URL and default branch', async () => {
    const dest = path.join(tmpDir, 'org', 'repo');
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
    await cloneOrPull(repo, tmpDir);
    expect(gitCalls).toEqual([
      `${dest}: remote set-url origin ${repo.url}`,
      `${dest}: fetch --prune origin`,
      `${dest}: remote set-head origin --auto`,
      `${dest}: reset --hard origin/HEAD`,
      `${dest}: clean --force -d -x`,
    ]);
    expect(cloneCalls).toHaveLength(0);
  });

  it('re-clones from scratch when the sync fails, without logging the token', async () => {
    const dest = path.join(tmpDir, 'org', 'repo');
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'stale.txt'), 'x');
    failSync = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await cloneOrPull(repo, tmpDir);
      expect(fs.existsSync(path.join(dest, 'stale.txt'))).toBe(false);
      expect(cloneCalls).toEqual([{ url: repo.url, dest }]);
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('re-cloning');
      expect(logged).not.toContain('ghp_secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('replaces a leftover directory from an interrupted clone', async () => {
    const dest = path.join(tmpDir, 'org', 'repo');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'partial.pack'), 'x');
    await cloneOrPull(repo, tmpDir);
    expect(fs.existsSync(path.join(dest, 'partial.pack'))).toBe(false);
    expect(cloneCalls).toHaveLength(1);
  });

  it('masks the token in clone errors and removes the partial clone', async () => {
    failClone = true;
    const err = await cloneOrPull(repo, tmpDir).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('https://***@github.com/org/repo.git');
    expect((err as Error).message).not.toContain('ghp_secret');
    expect(fs.existsSync(path.join(tmpDir, 'org', 'repo'))).toBe(false);
  });
});

describe('redactCredentials', () => {
  it('masks userinfo in URLs and leaves other text alone', () => {
    expect(redactCredentials("fatal: 'https://tok@github.com/o/r.git' and http://u:p@host/x")).toBe(
      "fatal: 'https://***@github.com/o/r.git' and http://***@host/x"
    );
    expect(redactCredentials('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
});
