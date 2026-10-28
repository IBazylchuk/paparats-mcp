import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTestFiles, testsNamedAfter } from '../src/test-files.js';

describe('testsNamedAfter', () => {
  it('finds the namesake test sharing most directories with the file', () => {
    const tests = [
      'spec/app/services/billing/invoice_spec.rb',
      'spec/app/models/invoice_spec.rb',
      'spec/app/services/billing/invoice_job_spec.rb',
    ];
    expect(testsNamedAfter('app/services/billing/invoice.rb', tests)).toEqual([
      'spec/app/services/billing/invoice_spec.rb',
    ]);
    expect(testsNamedAfter('app/models/invoice.rb', tests)).toEqual([
      'spec/app/models/invoice_spec.rb',
    ]);
  });

  it('knows TypeScript, Python and Go names, and an index file by its folder', () => {
    expect(testsNamedAfter('src/queue.ts', ['tests/queue.test.ts', 'tests/other.test.ts'])).toEqual(
      ['tests/queue.test.ts']
    );
    expect(testsNamedAfter('src/parser/index.ts', ['tests/parser.spec.tsx'])).toEqual([
      'tests/parser.spec.tsx',
    ]);
    expect(testsNamedAfter('pkg/rates.py', ['tests/test_rates.py'])).toEqual([
      'tests/test_rates.py',
    ]);
    expect(testsNamedAfter('pkg/rates.go', ['pkg/rates_test.go'])).toEqual(['pkg/rates_test.go']);
  });

  it('finds nothing for a test file itself or a file without namesake', () => {
    expect(testsNamedAfter('spec/a_spec.rb', ['spec/a_spec.rb'])).toEqual([]);
    expect(testsNamedAfter('db/migrate/1_add.rb', ['spec/models/add_column_spec.rb'])).toEqual([]);
  });
});

describe('readTestFiles', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists test files by name, skipping dependencies and ignored files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-files-'));
    const write = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(dir!, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir!, rel), '');
    };
    write('spec/app/models/user_spec.rb');
    write('src/queue.test.ts');
    write('src/queue.ts');
    write('node_modules/pkg/index.test.js');
    write('tmp/cache_spec.rb');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'tmp/\n');
    expect(readTestFiles(dir)).toEqual(['spec/app/models/user_spec.rb', 'src/queue.test.ts']);
  });

  it('is null without a directory', () => {
    expect(readTestFiles('/nonexistent/project/dir')).toBeNull();
  });
});
