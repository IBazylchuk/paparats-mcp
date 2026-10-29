import { describe, it, expect } from 'vitest';
import { parseApiKeysEnv } from '../src/api-key-auth.js';

describe('parseApiKeysEnv', () => {
  it('is off when unset or empty', () => {
    expect(parseApiKeysEnv({})).toBeNull();
    expect(parseApiKeysEnv({ PAPARATS_API_KEY: '' })).toBeNull();
    expect(parseApiKeysEnv({ PAPARATS_API_KEY: '  ' })).toBeNull();
  });

  it('reads one key or a comma-separated list, without duplicates', () => {
    const a = 'a'.repeat(16);
    const b = 'b'.repeat(32);
    expect(parseApiKeysEnv({ PAPARATS_API_KEY: a })).toEqual([a]);
    expect(parseApiKeysEnv({ PAPARATS_API_KEY: ` ${a}, ${b},${a}, ` })).toEqual([a, b]);
  });

  it('refuses a key that is too short or not a bearer token, without naming it', () => {
    expect(() => parseApiKeysEnv({ PAPARATS_API_KEY: 'short' })).toThrow(/key #1 is not usable/);
    const bad = 'x'.repeat(16) + ' y';
    expect(() => parseApiKeysEnv({ PAPARATS_API_KEY: `${'a'.repeat(16)},${bad}` })).toThrow(
      /key #2/
    );
    try {
      parseApiKeysEnv({ PAPARATS_API_KEY: 'secretvalue' });
    } catch (err) {
      expect((err as Error).message).not.toContain('secretvalue');
    }
  });
});
