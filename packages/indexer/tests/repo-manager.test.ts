import { describe, it, expect } from 'vitest';
import { parseReposEnv } from '../src/repo-manager.js';

describe('parseReposEnv', () => {
  it('parses single repo', () => {
    const repos = parseReposEnv('org/repo');
    expect(repos).toHaveLength(1);
    expect(repos[0]!.owner).toBe('org');
    expect(repos[0]!.name).toBe('repo');
    expect(repos[0]!.fullName).toBe('org/repo');
    expect(repos[0]!.url).toBe('https://github.com/org/repo.git');
  });

  it('parses multiple repos', () => {
    const repos = parseReposEnv('org/a,org/b,other/c');
    expect(repos).toHaveLength(3);
    expect(repos[0]!.fullName).toBe('org/a');
    expect(repos[1]!.fullName).toBe('org/b');
    expect(repos[2]!.fullName).toBe('other/c');
  });

  it('trims whitespace', () => {
    const repos = parseReposEnv(' org/a , org/b ');
    expect(repos).toHaveLength(2);
    expect(repos[0]!.fullName).toBe('org/a');
    expect(repos[1]!.fullName).toBe('org/b');
  });

  it('returns empty array for empty string', () => {
    expect(parseReposEnv('')).toHaveLength(0);
    expect(parseReposEnv('  ')).toHaveLength(0);
  });

  it('includes token in URL when provided', () => {
    const repos = parseReposEnv('org/repo', 'ghp_abc123');
    expect(repos[0]!.url).toBe('https://ghp_abc123@github.com/org/repo.git');
  });

  it('does not include token when not provided', () => {
    const repos = parseReposEnv('org/repo');
    expect(repos[0]!.url).toBe('https://github.com/org/repo.git');
  });

  it('throws for invalid repo format', () => {
    expect(() => parseReposEnv('just-a-name')).toThrow(/Invalid repo format/);
  });

  it('throws for too many slashes', () => {
    expect(() => parseReposEnv('a/b/c')).toThrow(/Invalid repo format/);
  });

  it('skips empty entries from trailing comma', () => {
    const repos = parseReposEnv('org/a,');
    expect(repos).toHaveLength(1);
    expect(repos[0]!.fullName).toBe('org/a');
  });
});
