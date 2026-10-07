import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateIndexingPaths, filterFilesWithinRoot } from './path-validation.js';

describe('validateIndexingPaths', () => {
  const projectDir = path.resolve('/some/project');

  it('accepts valid relative paths', () => {
    expect(() => validateIndexingPaths(['./', 'src', 'lib/'], projectDir)).not.toThrow();
  });

  it('accepts `*` wildcards, which cannot expand to a parent directory', () => {
    expect(() => validateIndexingPaths(['app/**', 'packages/*/src'], projectDir)).not.toThrow();
  });

  it('rejects absolute paths', () => {
    const absolutePath = path.sep === '\\' ? 'C:\\tmp' : '/tmp';
    expect(() => validateIndexingPaths([absolutePath], projectDir)).toThrow(
      'Absolute paths not allowed in indexing.paths'
    );
  });

  it('rejects path traversal', () => {
    expect(() => validateIndexingPaths(['../../etc'], projectDir)).toThrow(
      'Path must be inside project directory'
    );
  });

  it('rejects path traversal with single parent', () => {
    expect(() => validateIndexingPaths(['../'], projectDir)).toThrow(
      'Path must be inside project directory'
    );
  });

  it.each(['{..,src}', '[.][.]', '.\\.', '?.', '!(src)', '@(..)', 'src/{a,b}'])(
    'rejects glob syntax that can expand to a traversal: %s',
    (p) => {
      expect(() => validateIndexingPaths([p], projectDir)).toThrow(
        'Glob syntax not allowed in indexing.paths'
      );
    }
  );

  describe('on disk', () => {
    let base: string;
    let project: string;

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-paths-'));
      project = path.join(base, 'project');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      fs.mkdirSync(path.join(base, 'sibling'));
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('rejects a symlinked directory that resolves outside the project', () => {
      fs.symlinkSync(path.join(base, 'sibling'), path.join(project, 'linked'));
      expect(() => validateIndexingPaths(['linked'], project)).toThrow(
        /resolves through a symlink/
      );
    });

    it('accepts a symlinked directory that stays inside the project', () => {
      fs.symlinkSync(path.join(project, 'src'), path.join(project, 'alias'));
      expect(() => validateIndexingPaths(['alias', 'src', 'missing'], project)).not.toThrow();
    });
  });
});

describe('filterFilesWithinRoot', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-within-'));
    root = path.join(base, 'repo');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export {}');
    fs.writeFileSync(path.join(base, 'outside.ts'), 'secret');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps regular files and symlinks that stay inside the root', () => {
    fs.symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'));
    const files = [path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts')];
    expect(filterFilesWithinRoot(files, root)).toEqual(files);
  });

  it('drops a symlink resolving outside the root', () => {
    fs.symlinkSync(path.join(base, 'outside.ts'), path.join(root, 'leak.ts'));
    const kept = path.join(root, 'src', 'a.ts');
    expect(filterFilesWithinRoot([kept, path.join(root, 'leak.ts')], root)).toEqual([kept]);
  });

  it('drops a symlink into .git and files inside .git', () => {
    fs.symlinkSync(path.join(root, '.git', 'config'), path.join(root, 'leak.ts'));
    const files = [path.join(root, 'leak.ts'), path.join(root, '.git', 'config')];
    expect(filterFilesWithinRoot(files, root)).toEqual([]);
  });

  it('drops files reached through a symlinked directory pointing outside', () => {
    fs.symlinkSync(base, path.join(root, 'up'));
    expect(filterFilesWithinRoot([path.join(root, 'up', 'outside.ts')], root)).toEqual([]);
  });

  it('drops dangling links and missing files', () => {
    fs.symlinkSync(path.join(root, 'nowhere.ts'), path.join(root, 'dangling.ts'));
    const files = [path.join(root, 'dangling.ts'), path.join(root, 'gone.ts')];
    expect(filterFilesWithinRoot(files, root)).toEqual([]);
  });

  it('resolves relative entries against the root', () => {
    expect(filterFilesWithinRoot(['src/a.ts', '../outside.ts'], root)).toEqual(['src/a.ts']);
  });

  it('works when the root itself is reached through a symlink', () => {
    const viaLink = path.join(base, 'repo-link');
    fs.symlinkSync(root, viaLink);
    const file = path.join(viaLink, 'src', 'a.ts');
    expect(filterFilesWithinRoot([file], viaLink)).toEqual([file]);
  });

  it('returns nothing when the root does not exist', () => {
    expect(filterFilesWithinRoot([path.join(base, 'outside.ts')], path.join(base, 'nope'))).toEqual(
      []
    );
  });
});
