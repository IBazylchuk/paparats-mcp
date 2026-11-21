import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectProjectFiles } from '../src/project-files.js';

describe('collectProjectFiles', () => {
  let root: string;
  const write = (rel: string, content = 'x\n'): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  const project = (respectGitignore: boolean) => ({
    path: root,
    patterns: ['**/*.ts'],
    exclude: ['**/node_modules/**'],
    indexing: { respectGitignore },
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-'));
    write('src/a.ts');
    write('src/b.js');
    write('ignored.ts');
    write('node_modules/dep/index.ts');
    write('.gitignore', 'ignored.ts\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('applies patterns, excludes and gitignore', async () => {
    const files = await collectProjectFiles(
      project(true) as Parameters<typeof collectProjectFiles>[0]
    );
    expect(files.map((f) => path.relative(root, f))).toEqual([path.join('src', 'a.ts')]);
  });

  it('keeps gitignored files when the project does not respect gitignore', async () => {
    const files = await collectProjectFiles(
      project(false) as Parameters<typeof collectProjectFiles>[0]
    );
    expect(files.map((f) => path.relative(root, f))).toContain('ignored.ts');
  });
});
