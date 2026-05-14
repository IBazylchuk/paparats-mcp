import { describe, it, expect } from 'vitest';
import { resolveAstLanguage } from '../src/ast-language.js';

describe('resolveAstLanguage', () => {
  it('upgrades typescript → tsx for .tsx files', () => {
    expect(resolveAstLanguage('typescript', 'src/components/Foo.tsx')).toBe('tsx');
  });

  it('upgrades javascript → tsx for .jsx files (TSX grammar parses JSX too)', () => {
    expect(resolveAstLanguage('javascript', 'src/Foo.jsx')).toBe('tsx');
    expect(resolveAstLanguage('typescript', 'src/Foo.jsx')).toBe('tsx');
  });

  it('leaves plain .ts files as typescript', () => {
    expect(resolveAstLanguage('typescript', 'src/util.ts')).toBe('typescript');
  });

  it('leaves non-TS languages unchanged', () => {
    expect(resolveAstLanguage('python', 'main.py')).toBe('python');
    expect(resolveAstLanguage('go', 'main.go')).toBe('go');
    expect(resolveAstLanguage('rust', 'lib.rs')).toBe('rust');
  });

  it('handles uppercase extensions', () => {
    expect(resolveAstLanguage('typescript', 'src/Foo.TSX')).toBe('tsx');
  });

  it('handles paths with no extension', () => {
    expect(resolveAstLanguage('typescript', 'Makefile')).toBe('typescript');
  });
});
