import { describe, it, expect } from 'vitest';
import { getLanguageProfile, getSupportedLanguages } from '../src/config.js';

describe('terraform language profile', () => {
  it('exposes terraform patterns and extensions', () => {
    const p = getLanguageProfile('terraform');
    expect(p.patterns).toContain('**/*.tf');
    expect(p.extensions).toContain('.tf');
    expect(p.extensions).toContain('.hcl');
  });

  it('lists terraform as a supported language', () => {
    expect(getSupportedLanguages()).toContain('terraform');
  });
});
