import { describe, it, expect } from 'vitest';
import { detectLanguageByPath } from './language-detect.js';

describe('detectLanguageByPath', () => {
  it('detects common extensions', () => {
    expect(detectLanguageByPath('app/models/user.rb')).toBe('ruby');
    expect(detectLanguageByPath('Rakefile.rake')).toBe('ruby');
    expect(detectLanguageByPath('sig/user.rbs')).toBe('ruby');
    expect(detectLanguageByPath('src/index.ts')).toBe('typescript');
    expect(detectLanguageByPath('src/App.tsx')).toBe('typescript');
    expect(detectLanguageByPath('script.js')).toBe('typescript');
    expect(detectLanguageByPath('module.mjs')).toBe('typescript');
    expect(detectLanguageByPath('main.py')).toBe('python');
    expect(detectLanguageByPath('main.go')).toBe('go');
    expect(detectLanguageByPath('lib.rs')).toBe('rust');
    expect(detectLanguageByPath('App.java')).toBe('java');
    expect(detectLanguageByPath('Program.cs')).toBe('csharp');
  });

  it('maps C/C++ extensions conservatively', () => {
    expect(detectLanguageByPath('foo.c')).toBe('c');
    expect(detectLanguageByPath('foo.h')).toBe('c');
    expect(detectLanguageByPath('foo.cpp')).toBe('cpp');
    expect(detectLanguageByPath('foo.hpp')).toBe('cpp');
    expect(detectLanguageByPath('foo.cc')).toBe('cpp');
  });

  it('is case-insensitive on extension', () => {
    expect(detectLanguageByPath('Foo.RB')).toBe('ruby');
    expect(detectLanguageByPath('Main.JAVA')).toBe('java');
  });

  it('returns null for unknown extensions without content', () => {
    expect(detectLanguageByPath('README.md')).toBeNull();
    expect(detectLanguageByPath('config.yaml')).toBeNull();
    expect(detectLanguageByPath('Dockerfile')).toBeNull();
  });

  it('detects language from shebang when extension is unknown', () => {
    expect(detectLanguageByPath('bin/console', '#!/usr/bin/env ruby\nputs :hi\n')).toBe('ruby');
    expect(detectLanguageByPath('bin/tool', '#!/usr/bin/python3\nprint(1)\n')).toBe('python');
    expect(detectLanguageByPath('bin/run', '#!/usr/bin/env node\nconsole.log(1)\n')).toBe(
      'typescript'
    );
  });

  it('prefers extension over shebang when both are present', () => {
    expect(detectLanguageByPath('app.rb', '#!/usr/bin/env python3\nputs :hi\n')).toBe('ruby');
  });

  it('returns null when content has no shebang and no extension', () => {
    expect(detectLanguageByPath('LICENSE', 'MIT License\nCopyright ...\n')).toBeNull();
  });

  it('handles single-line content without newline', () => {
    expect(detectLanguageByPath('bin/run', '#!/usr/bin/env ruby')).toBe('ruby');
  });
});
