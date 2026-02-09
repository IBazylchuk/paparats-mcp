import { describe, it, expect } from 'vitest';
import {
  getDefaultExcludeForLanguages,
  LANGUAGE_EXCLUDE_DEFAULTS,
  COMMON_EXCLUDE,
  DEFAULT_EXCLUDE_BARE,
} from './language-excludes.js';

describe('getDefaultExcludeForLanguages', () => {
  it('returns COMMON_EXCLUDE for empty languages', () => {
    const result = getDefaultExcludeForLanguages([]);
    expect(result).toEqual(COMMON_EXCLUDE);
  });

  it('merges COMMON_EXCLUDE with language-specific excludes for single language', () => {
    const result = getDefaultExcludeForLanguages(['ruby']);
    expect(result).toContain('.git');
    expect(result).toContain('vendor');
    expect(result).toContain('tmp');
    expect(result).toContain('spec');
    expect(result).not.toContain('.next');
  });

  it('merges multiple languages', () => {
    const result = getDefaultExcludeForLanguages(['ruby', 'typescript']);
    expect(result).toContain('.git');
    expect(result).toContain('vendor');
    expect(result).toContain('tmp');
    expect(result).toContain('.next');
    expect(result).toContain('.turbo');
  });

  it('deduplicates when languages overlap', () => {
    const result = getDefaultExcludeForLanguages(['typescript', 'javascript']);
    expect(result.filter((e) => e === 'node_modules')).toHaveLength(1);
  });

  it('falls back to typescript for unknown language', () => {
    const result = getDefaultExcludeForLanguages(['unknown-lang']);
    expect(result).toContain('node_modules');
    expect(result).toContain('dist');
    expect(result).toContain('.next');
  });
});

describe('LANGUAGE_EXCLUDE_DEFAULTS', () => {
  it('has generic entry for server fallback', () => {
    expect(LANGUAGE_EXCLUDE_DEFAULTS.generic).toBeDefined();
    expect(LANGUAGE_EXCLUDE_DEFAULTS.generic).toContain('node_modules');
    expect(LANGUAGE_EXCLUDE_DEFAULTS.generic).toContain('.git');
  });

  it('has typescript as default fallback', () => {
    expect(LANGUAGE_EXCLUDE_DEFAULTS.typescript).toBeDefined();
    expect(LANGUAGE_EXCLUDE_DEFAULTS.typescript).toContain('node_modules');
  });
});

describe('DEFAULT_EXCLUDE_BARE', () => {
  it('includes EMFILE-critical paths', () => {
    expect(DEFAULT_EXCLUDE_BARE).toContain('node_modules');
    expect(DEFAULT_EXCLUDE_BARE).toContain('dist');
    expect(DEFAULT_EXCLUDE_BARE).toContain('.git');
    expect(DEFAULT_EXCLUDE_BARE).toContain('.next');
    expect(DEFAULT_EXCLUDE_BARE).toContain('__pycache__');
  });
});
