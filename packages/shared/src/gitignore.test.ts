import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createGitignoreFilter, filterFilesByGitignore } from './gitignore.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-gitignore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

describe('createGitignoreFilter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .gitignore does not exist', () => {
    expect(createGitignoreFilter(tmpDir)).toBeNull();
  });

  it('ignores files matching .gitignore patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules\n*.log\n');
    const filter = createGitignoreFilter(tmpDir);
    expect(filter).not.toBeNull();
    const ig = filter!;
    expect(ig(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(ig(path.join(tmpDir, 'foo.log'))).toBe(true);
    expect(ig(path.join(tmpDir, 'src', 'index.ts'))).toBe(false);
  });

  it('respects negation patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.log\n!important.log\n');
    const filter = createGitignoreFilter(tmpDir);
    expect(filter).not.toBeNull();
    const ig = filter!;
    expect(ig(path.join(tmpDir, 'foo.log'))).toBe(true);
    expect(ig(path.join(tmpDir, 'important.log'))).toBe(false);
  });

  it('ignores directory when pattern ends with slash', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'build/\n');
    const filter = createGitignoreFilter(tmpDir);
    expect(filter).not.toBeNull();
    const ig = filter!;
    expect(ig(path.join(tmpDir, 'build', 'output.js'))).toBe(true);
  });
});

describe('filterFilesByGitignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns files unchanged when .gitignore does not exist', () => {
    const files = [path.join(tmpDir, 'src', 'a.ts'), path.join(tmpDir, 'src', 'b.ts')];
    expect(filterFilesByGitignore(files, tmpDir)).toEqual(files);
  });

  it('filters out gitignored files', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'secrets/\n');
    const files = [path.join(tmpDir, 'src', 'index.ts'), path.join(tmpDir, 'secrets', 'key.ts')];
    const result = filterFilesByGitignore(files, tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('src/index.ts');
  });
});
