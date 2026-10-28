import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { filterFilesByGitignore } from '@paparats/shared';

/** Test files by name, whatever the index leaves out: Ruby specs are often not indexed. */
const TEST_FILE_GLOBS = [
  '**/*_spec.rb',
  '**/*_test.rb',
  '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
];

const IGNORED = ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**'];

/**
 * The project's test files, relative to its root, found by name and
 * gitignore-filtered. Null when the directory is not there (content sent by
 * a client): then nothing is known about its tests.
 */
export function readTestFiles(root: string): string[] | null {
  if (!fs.existsSync(root)) return null;
  const found = globSync(TEST_FILE_GLOBS, {
    cwd: root,
    ignore: IGNORED,
    nodir: true,
    absolute: true,
  });
  return filterFilesByGitignore(found, root)
    .map((file) => path.relative(root, file))
    .sort();
}

const SCRIPT_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;

/** The file names a test of `file` would have, by each language's convention. */
function testNamesOf(file: string): Set<string> {
  const base = path.basename(file);
  const names = new Set<string>();
  const add = (stem: string) => {
    if (base.endsWith('.rb')) names.add(`${stem}_spec.rb`).add(`${stem}_test.rb`);
    else if (base.endsWith('.py')) names.add(`test_${stem}.py`).add(`${stem}_test.py`);
    else if (base.endsWith('.go')) names.add(`${stem}_test.go`);
    else if (SCRIPT_EXT.test(base)) {
      for (const kind of ['test', 'spec']) {
        for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])
          names.add(`${stem}.${kind}.${ext}`);
      }
    }
  };
  const stem = base.replace(/\.[^.]+$/, '');
  add(stem);
  // `parser/index.ts` is tested as `parser.test.ts`.
  if (stem === 'index') add(path.basename(path.dirname(file)));
  return names;
}

/**
 * The test files named after `file` (`invoice.rb` → `invoice_spec.rb`,
 * `queue.ts` → `queue.test.ts`); of several, those sharing the most directory
 * names with it, so `spec/app/services/billing/invoice_spec.rb` is picked for
 * `app/services/billing/invoice.rb` over another `invoice_spec.rb`.
 */
export function testsNamedAfter(file: string, testFiles: readonly string[]): string[] {
  if (testFiles.includes(file)) return [];
  const names = testNamesOf(file);
  if (names.size === 0) return [];
  const dirs = new Set(path.dirname(file).split('/'));
  let best = -1;
  let found: string[] = [];
  for (const test of testFiles) {
    if (!names.has(path.basename(test))) continue;
    const shared = path
      .dirname(test)
      .split('/')
      .filter((d) => dirs.has(d)).length;
    if (shared > best) {
      best = shared;
      found = [test];
    } else if (shared === best) {
      found.push(test);
    }
  }
  return found;
}
