import { describe, it, expect } from 'vitest';
import { parseRepoSpec } from '../src/repo-url.js';

describe('parseRepoSpec', () => {
  it('reads owner/repo and github.com URLs as GitHub', () => {
    const expected = {
      url: 'https://github.com/org/app.git',
      owner: 'org',
      name: 'app',
      fullName: 'org/app',
    };
    expect(parseRepoSpec('org/app')).toEqual(expected);
    expect(parseRepoSpec('https://github.com/org/app.git')).toEqual(expected);
    expect(parseRepoSpec('https://github.com/org/app/')).toEqual(expected);
  });

  it('reads an https URL of another host, subgroups and port included', () => {
    expect(parseRepoSpec('https://gitlab.example.com/team/sub/app.git')).toEqual({
      url: 'https://gitlab.example.com/team/sub/app.git',
      owner: 'gitlab.example.com/team/sub',
      name: 'app',
      fullName: 'gitlab.example.com/team/sub/app',
    });
    expect(parseRepoSpec('https://GHE.example.com:8443/org/app')).toEqual({
      url: 'https://ghe.example.com:8443/org/app.git',
      owner: 'ghe.example.com_8443/org',
      name: 'app',
      fullName: 'ghe.example.com:8443/org/app',
    });
  });

  it.each([
    ['git@gitlab.example.com:team/app.git', /SSH addresses/],
    ['ssh://git@gitlab.example.com/team/app.git', /SSH addresses/],
    ['https://user:tok@gitlab.example.com/team/app', /credentials/],
    ['https://gitlab.example.com/app', /repository path/],
    ['https://gitlab.example.com/team/a%20b', /Invalid repository path/],
    ['https://github.com/org/sub/app', /github\.com\/owner\/repo/],
    ['org/app/extra', /Expected "owner\/repo"/],
  ])('refuses %s', (spec, error) => {
    expect(() => parseRepoSpec(spec)).toThrow(error);
  });

  it('never repeats credentials in the error', () => {
    expect(() => parseRepoSpec('https://user:secrettoken@gitlab.example.com/t/a')).toThrow(
      /^(?!.*secrettoken)/
    );
  });
});
