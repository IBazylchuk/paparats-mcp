import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MtimeDetector, GitDetector, parseLsRemoteHead } from '../src/change-detector.js';
import type { ProjectConfig } from '@paparats/server';
import type { RepoConfig } from '../src/types.js';

function makeProject(root: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: 'test',
    group: 'g',
    path: root,
    languages: ['typescript'],
    patterns: ['**/*.ts'],
    exclude: ['**/node_modules/**'],
    indexing: {
      paths: ['.'],
      exclude: ['**/node_modules/**'],
      respectGitignore: false,
      extensions: ['.ts'],
      chunkSize: 100,
      overlap: 0,
      concurrency: 1,
      batchSize: 1,
    },
    watcher: { enabled: false, debounceMs: 0 },
    embeddings: { provider: 'ollama', model: 'm', dimensions: 1 },
    metadata: {
      service: '',
      bounded_context: '',
      tags: [],
      directory_tags: {},
      git: { enabled: false, maxCommitsPerFile: 0, ticketPatterns: [] },
    },
    ...overrides,
  } as ProjectConfig;
}

describe('parseLsRemoteHead', () => {
  it('parses plain ls-remote HEAD line', () => {
    const out = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD';
    expect(parseLsRemoteHead(out)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('parses --symref output, skipping the ref: line', () => {
    const out = [
      'ref: refs/heads/main\tHEAD',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tHEAD',
    ].join('\n');
    expect(parseLsRemoteHead(out)).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('returns null on empty input', () => {
    expect(parseLsRemoteHead('')).toBeNull();
  });

  it('returns null when no valid sha line present', () => {
    expect(parseLsRemoteHead('garbage\tHEAD')).toBeNull();
  });

  it('ignores non-HEAD refs', () => {
    const out = 'cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1';
    expect(parseLsRemoteHead(out)).toBeNull();
  });
});

describe('MtimeDetector', () => {
  let dir: string;
  let detector: MtimeDetector;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-mtime-'));
    detector = new MtimeDetector();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('produces same fingerprint for unchanged tree', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'const b = 2;');
    const project = makeProject(dir);

    const fp1 = await detector.fingerprint(dir, project);
    const fp2 = await detector.fingerprint(dir, project);
    expect(fp1.value).toBe(fp2.value);
    expect(fp1.kind).toBe('mtime');
  });

  it('changes fingerprint when a file is added', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;');
    const project = makeProject(dir);
    const fp1 = await detector.fingerprint(dir, project);

    fs.writeFileSync(path.join(dir, 'b.ts'), 'const b = 2;');
    const fp2 = await detector.fingerprint(dir, project);
    expect(fp1.value).not.toBe(fp2.value);
  });

  it('changes fingerprint when a file is removed', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'b');
    const project = makeProject(dir);
    const fp1 = await detector.fingerprint(dir, project);

    fs.rmSync(path.join(dir, 'b.ts'));
    const fp2 = await detector.fingerprint(dir, project);
    expect(fp1.value).not.toBe(fp2.value);
  });

  it('changes fingerprint when content changes (size differs)', async () => {
    const f = path.join(dir, 'a.ts');
    fs.writeFileSync(f, 'short');
    const project = makeProject(dir);
    const fp1 = await detector.fingerprint(dir, project);

    fs.writeFileSync(f, 'a much longer body of code');
    const fp2 = await detector.fingerprint(dir, project);
    expect(fp1.value).not.toBe(fp2.value);
  });

  it('ignores files outside patterns', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;');
    const project = makeProject(dir);
    const fp1 = await detector.fingerprint(dir, project);

    fs.writeFileSync(path.join(dir, 'readme.md'), '# hi');
    const fp2 = await detector.fingerprint(dir, project);
    expect(fp1.value).toBe(fp2.value);
  });

  it('ignores files matched by exclude patterns', async () => {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;');
    const project = makeProject(dir);
    const fp1 = await detector.fingerprint(dir, project);

    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.ts'), 'noise');
    const fp2 = await detector.fingerprint(dir, project);
    expect(fp1.value).toBe(fp2.value);
  });

  it('throws when path does not exist', async () => {
    const project = makeProject(path.join(dir, 'missing'));
    await expect(detector.fingerprint(path.join(dir, 'missing'), project)).rejects.toThrow();
  });
});

describe('GitDetector', () => {
  it('throws when repo has no url', async () => {
    const detector = new GitDetector();
    const repo: RepoConfig = { url: '', owner: 'foo', name: 'bar', fullName: 'foo/bar' };
    await expect(detector.fingerprint(repo)).rejects.toThrow(/remote url/);
  });
});
