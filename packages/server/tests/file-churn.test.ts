import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHURN_STEPS, churnPercentiles, readFileCommitCounts } from '../src/file-churn.js';

describe('churnPercentiles', () => {
  it('ranks files by commit count, ties sharing the middle rank', () => {
    const counts = new Map([
      ['a.ts', 9],
      ['b.ts', 3],
      ['c.ts', 3],
    ]);
    const p = churnPercentiles(['a.ts', 'b.ts', 'c.ts', 'd.ts'], counts);
    expect(p.get('d.ts')).toBe(0.15); // no commits: 0.125, rounded to a step
    expect(p.get('b.ts')).toBe(0.5);
    expect(p.get('c.ts')).toBe(0.5);
    expect(p.get('a.ts')).toBe(0.9); // 0.875
  });

  it('rounds to CHURN_STEPS steps', () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const counts = new Map(files.map((f, i) => [f, i]));
    const steps = new Set(churnPercentiles(files, counts).values());
    expect(steps.size).toBeLessThanOrEqual(CHURN_STEPS + 1);
    for (const v of steps) expect(Math.round(v * CHURN_STEPS)).toBeCloseTo(v * CHURN_STEPS);
  });

  it('gives a lone file the top rank', () => {
    expect(churnPercentiles(['a.ts'], new Map()).get('a.ts')).toBe(1);
  });
});

describe('readFileCommitCounts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function tempDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'file-churn-'));
    dirs.push(d);
    return d;
  }

  function git(dir: string, ...args: string[]): void {
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      { stdio: 'ignore' }
    );
  }

  function commit(dir: string, file: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `edit ${file}`);
  }

  it('counts commits per file, relative to the directory asked about', async () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    commit(repo, 'app/a.ts', '1');
    commit(repo, 'app/a.ts', '2');
    commit(repo, 'app/b.ts', '1');
    commit(repo, 'other/c.ts', '1');

    expect(await readFileCommitCounts(repo)).toEqual(
      new Map([
        ['app/a.ts', 2],
        ['app/b.ts', 1],
        ['other/c.ts', 1],
      ])
    );
    expect(await readFileCommitCounts(path.join(repo, 'app'))).toEqual(
      new Map([
        ['a.ts', 2],
        ['b.ts', 1],
      ])
    );
  });

  it('reads the history up to a given revision', async () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    commit(repo, 'a.ts', '1');
    git(repo, 'tag', 'first');
    commit(repo, 'a.ts', '2');
    expect((await readFileCommitCounts(repo, 'first'))?.get('a.ts')).toBe(1);
  });

  it('is null outside a git repository', async () => {
    expect(await readFileCommitCounts(tempDir())).toBeNull();
  });
});
