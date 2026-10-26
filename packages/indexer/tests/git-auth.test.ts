import { describe, it, expect } from 'vitest';
import { createGit, gitAuthEnv } from '../src/git-auth.js';

describe('gitAuthEnv', () => {
  it('returns nothing without a token', () => {
    expect(gitAuthEnv(undefined, {})).toEqual({});
    expect(gitAuthEnv('', {})).toEqual({});
  });

  it('sends the token as a basic auth header scoped to github.com', () => {
    const env = gitAuthEnv('ghp_abc123', {});
    expect(env['GIT_CONFIG_COUNT']).toBe('1');
    expect(env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraHeader');
    const value = env['GIT_CONFIG_VALUE_0']!;
    expect(value.startsWith('Authorization: Basic ')).toBe(true);
    const decoded = Buffer.from(value.slice('Authorization: Basic '.length), 'base64').toString();
    expect(decoded).toBe('x-access-token:ghp_abc123');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('appends after config entries already set through the environment', () => {
    const env = gitAuthEnv('tok', { GIT_CONFIG_COUNT: '2' });
    expect(env['GIT_CONFIG_COUNT']).toBe('3');
    expect(env['GIT_CONFIG_KEY_2']).toBe('http.https://github.com/.extraHeader');
    expect(env['GIT_CONFIG_KEY_0']).toBeUndefined();
  });

  it('starts from zero when the existing count is not a number', () => {
    const env = gitAuthEnv('tok', { GIT_CONFIG_COUNT: 'x' });
    expect(env['GIT_CONFIG_COUNT']).toBe('1');
    expect(env['GIT_CONFIG_KEY_0']).toBeDefined();
  });
});

describe('createGit', () => {
  it('lets the auth variables through simple-git to git', async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, gitAuthEnv('tok', {}), { GIT_DIR: '/elsewhere' });
      // A spawned git sees only what simple-git passes on: the header survives, GIT_DIR does not.
      const out = await createGit().raw([
        'config',
        '--get',
        'http.https://github.com/.extraheader',
      ]);
      expect(out.trim()).toBe(process.env['GIT_CONFIG_VALUE_0']);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
