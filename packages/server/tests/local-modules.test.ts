import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLocalModule, readLocalModules } from '../src/local-modules.js';

describe('readLocalModules', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-modules-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };

  it("reads the project's package names and tsconfig path aliases, not node_modules", () => {
    write('package.json', '{ "name": "app", "private": true }');
    write('packages/shared/package.json', '{ "name": "@acme/shared" }');
    write('node_modules/left-pad/package.json', '{ "name": "left-pad" }');
    write(
      'tsconfig.json',
      '{\n  // comments are allowed\n  "compilerOptions": { "paths": { "@/*": ["src/*"], "#lib": ["lib/index.ts"] } }\n}'
    );
    const local = readLocalModules(dir)!;
    expect(local.packages.sort()).toEqual(['@acme/shared', 'app']);
    expect(local.aliases.sort()).toEqual(['#lib', '@/*']);

    expect(isLocalModule('./store.js', local)).toBe(true);
    expect(isLocalModule('@acme/shared', local)).toBe(true);
    expect(isLocalModule('@acme/shared/dist/x.js', local)).toBe(true);
    expect(isLocalModule('@/components/button', local)).toBe(true);
    expect(isLocalModule('#lib', local)).toBe(true);
    expect(isLocalModule('left-pad', local)).toBe(false);
    expect(isLocalModule('@acme/sharedx', local)).toBe(false);
  });

  it('knows nothing without a package.json or a directory', () => {
    write('src/a.ts', 'export {};');
    expect(readLocalModules(dir)).toBeNull();
    expect(readLocalModules(path.join(dir, 'missing'))).toBeNull();
  });
});
