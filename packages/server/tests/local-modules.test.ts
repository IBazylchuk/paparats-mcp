import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isLocalModule,
  readLocalModules,
  resolveAlias,
  resolveAliasImports,
  hasBareImports,
} from '../src/local-modules.js';
import type { ChunkSymbols } from '../src/symbol-graph.js';

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

  it('resolves an alias by the nearest config above the file', () => {
    write('package.json', '{ "name": "site" }');
    write(
      'tsconfig.json',
      '{\n  /* "paths": in a comment */\n  "compilerOptions": { "paths": { "~/*": ["./src/*"], }, },\n}'
    );
    // A nested app: its own paths replace the inherited ones; one of them points into the site.
    write(
      'apps/ext/.wxt/tsconfig.json',
      '{ "compilerOptions": { "paths": { "~/*": ["../src/*"] } } }'
    );
    write(
      'apps/ext/tsconfig.json',
      '{ "extends": "./.wxt/tsconfig.json", "compilerOptions": { "paths": { "~/lib/dates": ["../../src/lib/dates.ts"], "~/ui/*": ["./src/ui/*"], "~/*": ["./src/*"] } } }'
    );
    const local = readLocalModules(dir)!;

    expect(resolveAlias('~/contexts/auth', 'src/app/page.tsx', local)).toBe('../contexts/auth');
    expect(resolveAlias('~/lib/dates', 'src/lib/x.ts', local)).toBe('./dates');
    expect(resolveAlias('~/lib/dates', 'apps/ext/src/popup.tsx', local)).toBe(
      '../../../src/lib/dates.ts'
    );
    expect(resolveAlias('~/ui/button', 'apps/ext/src/a/b.tsx', local)).toBe('../ui/button');
    expect(resolveAlias('~/hooks/x', 'apps/ext/src/a.ts', local)).toBe('./hooks/x');
    expect(resolveAlias('./store.js', 'src/a.ts', local)).toBeNull();
    expect(resolveAlias('react', 'src/a.ts', local)).toBeNull();
  });

  it('reads paths through extends, baseUrl and a solution config', () => {
    write('package.json', '{ "name": "app" }');
    write(
      'config/base.json',
      '{ "compilerOptions": { "baseUrl": "..", "paths": { "@/*": ["src/*"] } } }'
    );
    write('web/tsconfig.json', '{ "extends": "../config/base" }');
    write('tsconfig.json', '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }');
    write(
      'tsconfig.app.json',
      '{ "compilerOptions": { "paths": { "#lib": ["./lib/index.ts"], "^/*": ["../outside/*"] } } }'
    );
    const local = readLocalModules(dir)!;

    expect(resolveAlias('@/a', 'web/x.ts', local)).toBe('../src/a');
    expect(resolveAlias('#lib', 'src/x.ts', local)).toBe('../lib/index.ts');
    expect(resolveAlias('^/y', 'src/x.ts', local)).toBeNull();
  });

  it('reads a bare import of a folder or file under baseUrl as the project’s own', () => {
    write('package.json', '{ "name": "admin" }');
    write('tsconfig.json', '// tools\n{ "compilerOptions": { "baseUrl": "src" /* no paths */ } }');
    write('src/core/hooks/index.ts', 'export {};');
    write('src/config.ts', 'export {};');
    const local = readLocalModules(dir)!;

    expect(resolveAlias('core/hooks', 'src/common/nav.tsx', local)).toBe('../core/hooks');
    expect(resolveAlias('config', 'src/common/nav.tsx', local)).toBe('../config.ts');
    expect(resolveAlias('react', 'src/common/nav.tsx', local)).toBeNull();
    expect(isLocalModule('core/hooks', local)).toBe(true);
    expect(isLocalModule('react', local)).toBe(false);
  });

  it('rewrites the alias imports of stored uses and class parents', () => {
    const local = {
      packages: ['app'],
      aliases: ['~/*'],
      scopes: [{ dir: '', paths: [{ key: '~/*', target: 'src/*' }] }],
    };
    const chunks: ChunkSymbols[] = [
      {
        chunk_id: 'g//app//src/app/page.tsx//0-20//abc',
        defines_symbols: ['Page'],
        uses_symbols: ['useAuth', 'useState', 'x'],
        use_sites: [
          { name: 'useAuth', module: '~/contexts/auth' },
          { name: 'useState', external: true },
          { name: 'x', module: 'react' },
          { name: 'y', module: './y' },
        ],
        def_classes: { Page: [{ name: 'Base', module: '~/ui/base' }] },
      },
    ];
    expect(hasBareImports(chunks)).toBe(true);
    resolveAliasImports(chunks, local);
    expect(chunks[0]!.use_sites!.map((s) => s.module)).toEqual([
      '../contexts/auth',
      undefined,
      'react',
      './y',
    ]);
    expect(chunks[0]!.def_classes!['Page']![0]!.module).toBe('../ui/base');
  });

  it('knows nothing without a package.json or a directory', () => {
    write('src/a.ts', 'export {};');
    expect(readLocalModules(dir)).toBeNull();
    expect(readLocalModules(path.join(dir, 'missing'))).toBeNull();
  });
});
