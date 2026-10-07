import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { glob } from 'glob';
import { normalizeExcludePatterns } from './exclude-patterns.js';
import { LANGUAGE_EXCLUDE_DEFAULTS } from './language-excludes.js';

describe('normalizeExcludePatterns', () => {
  it('matches bare names at any depth, as file or directory', () => {
    expect(normalizeExcludePatterns(['node_modules', '*.class'])).toEqual([
      '**/node_modules',
      '**/node_modules/**',
      '**/*.class',
      '**/*.class/**',
    ]);
  });

  it('anchors patterns containing a slash and also matches their contents', () => {
    expect(normalizeExcludePatterns(['spec/fixtures', 'app/assets/builds'])).toEqual([
      'spec/fixtures',
      'spec/fixtures/**',
      'app/assets/builds',
      'app/assets/builds/**',
    ]);
  });

  it('treats a trailing slash as a directory name, a leading slash as root-anchored', () => {
    expect(normalizeExcludePatterns(['vendor/', '/tmp', './log'])).toEqual([
      '**/vendor',
      '**/vendor/**',
      'tmp',
      'tmp/**',
      'log',
      'log/**',
    ]);
  });

  it('leaves explicit ** patterns unchanged and drops empties and duplicates', () => {
    expect(
      normalizeExcludePatterns(['**/*.min.js', '', ' / ', 'dist', 'dist', '**/node_modules/**'])
    ).toEqual(['**/*.min.js', '**/dist', '**/dist/**', '**/node_modules/**']);
  });

  it('is stable when applied twice (server and CLI re-normalize the built-in defaults)', () => {
    const once = normalizeExcludePatterns(['vendor', 'spec/fixtures', '*.class', '**/a/**']);
    expect(normalizeExcludePatterns(once)).toEqual(once);
    // A root-anchored single name is the exception: a second pass widens it to
    // any depth, which excludes more, never less.
    expect(normalizeExcludePatterns(normalizeExcludePatterns(['/tmp']))).toEqual(
      expect.arrayContaining(['tmp/**', '**/tmp/**'])
    );
  });

  // End-to-end against the glob version the indexers use: an ignore list that
  // looks right but matches nothing is exactly the bug this guards.
  describe('with glob ignore', () => {
    let root: string;
    const files = [
      'spec/fixtures/a.rb',
      'spec/fixtures/deep/b.rb',
      'app/assets/builds/c.rb',
      'public/packs/d.rb',
      'vendor/x/e.rb',
      'lib/vendor/f.rb',
      'tmp/g.rb',
      'lib/tmp/h.rb',
      'app/models/user.rb',
      'build/Foo.class',
      'src/Bar.class',
    ];

    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-exclude-'));
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        fs.writeFileSync(path.join(root, f), 'x');
      }
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    const run = (exclude: string[]) =>
      glob('**/*', {
        cwd: root,
        nodir: true,
        ignore: normalizeExcludePatterns(exclude),
      }).then((found) => found.map((f) => f.split(path.sep).join('/')).sort());

    it('excludes directory contents for slash-containing patterns', async () => {
      const found = await run(['spec/fixtures', 'app/assets/builds/']);
      expect(found).not.toContain('spec/fixtures/a.rb');
      expect(found).not.toContain('spec/fixtures/deep/b.rb');
      expect(found).not.toContain('app/assets/builds/c.rb');
      expect(found).toContain('app/models/user.rb');
    });

    it('anchors `/tmp` to the root but matches bare `vendor` at any depth', async () => {
      const found = await run(['/tmp', 'vendor']);
      expect(found).not.toContain('tmp/g.rb');
      expect(found).toContain('lib/tmp/h.rb');
      expect(found).not.toContain('vendor/x/e.rb');
      expect(found).not.toContain('lib/vendor/f.rb');
    });

    it('applies the built-in ruby and java defaults', async () => {
      const found = await run([
        ...LANGUAGE_EXCLUDE_DEFAULTS.ruby!,
        ...LANGUAGE_EXCLUDE_DEFAULTS.java!,
      ]);
      expect(found).not.toContain('public/packs/d.rb');
      expect(found).not.toContain('src/Bar.class');
      expect(found).not.toContain('build/Foo.class');
      expect(found).toContain('app/models/user.rb');
    });
  });
});
