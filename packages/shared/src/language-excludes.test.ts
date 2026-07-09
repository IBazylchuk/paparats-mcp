import { describe, it, expect } from 'vitest';
import { Minimatch } from 'minimatch';
import {
  getDefaultExcludeForLanguages,
  LANGUAGE_EXCLUDE_DEFAULTS,
  COMMON_EXCLUDE,
  DEFAULT_EXCLUDE_BARE,
} from './language-excludes.js';
import { normalizeExcludePatterns } from './exclude-patterns.js';

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

describe('terraform secret/state excludes', () => {
  // Mirror the real matching path: normalizeExcludePatterns → Minimatch against
  // the relative file path (see server watcher/config).
  const matchers = normalizeExcludePatterns(LANGUAGE_EXCLUDE_DEFAULTS.terraform!).map(
    (p) => new Minimatch(p)
  );
  const isExcluded = (rel: string) => matchers.some((m) => m.match(rel));

  it('excludes secrets and state at any directory depth', () => {
    expect(isExcluded('prod.tfvars')).toBe(true);
    expect(isExcluded('environments/prod/secrets.tfvars')).toBe(true);
    expect(isExcluded('a/b/c/terraform.tfvars.json')).toBe(true);
    expect(isExcluded('env/prod.auto.tfvars')).toBe(true);
    expect(isExcluded('deep/nested/terraform.tfstate')).toBe(true);
    expect(isExcluded('x/terraform.tfstate.backup')).toBe(true);
    expect(isExcluded('modules/vpc/.terraform/plugin')).toBe(true);
  });

  it('still indexes terraform source files', () => {
    expect(isExcluded('environments/prod/main.tf')).toBe(false);
    expect(isExcluded('variables.tf')).toBe(false);
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
