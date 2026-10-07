import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveRepoProject } from '../src/project-resolver.js';
import type { RepoConfig, RepoOverrides } from '../src/types.js';

function makeRepo(localPath: string, overrides?: RepoOverrides): RepoConfig {
  return {
    url: '',
    owner: '_local',
    name: path.basename(localPath),
    fullName: path.basename(localPath),
    localPath,
    ...(overrides ? { overrides } : {}),
  };
}

describe('resolveRepoProject', () => {
  let base: string;
  let dir: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-resolve-'));
    dir = path.join(base, 'billing');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Gemfile'), '');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const writeRepoConfig = (body: string) => fs.writeFileSync(path.join(dir, '.paparats.yml'), body);

  describe('with .paparats.yml and projects.yml overrides', () => {
    it('normalizes an overriding exclude list', () => {
      writeRepoConfig('group: team\nlanguage: ruby\n');
      const { project, source } = resolveRepoProject(
        makeRepo(dir, { indexing: { exclude: ['spec/fixtures', 'tmp'] } }),
        dir
      );
      expect(source).toBe('repo-config+overrides');
      expect(project.exclude).toEqual(['spec/fixtures', 'spec/fixtures/**', '**/tmp', '**/tmp/**']);
      expect(project.indexing.exclude).toEqual(project.exclude);
    });

    it('appends exclude_extra to the repo config, both normalized', () => {
      writeRepoConfig(
        'group: team\nlanguage: ruby\nindexing:\n  exclude: [vendor]\n  exclude_extra: [log]\n'
      );
      const { project } = resolveRepoProject(
        makeRepo(dir, { indexing: { exclude_extra: ['app/assets/builds'] } }),
        dir
      );
      expect(project.exclude).toEqual([
        '**/vendor',
        '**/vendor/**',
        '**/log',
        '**/log/**',
        'app/assets/builds',
        'app/assets/builds/**',
      ]);
    });

    it('rebuilds glob patterns from overriding paths', () => {
      writeRepoConfig('group: team\nlanguage: ruby\n');
      const { project } = resolveRepoProject(
        makeRepo(dir, { indexing: { paths: ['app', 'lib'] } }),
        dir
      );
      expect(project.indexing.paths).toEqual(['app', 'lib']);
      expect(project.patterns).toEqual([
        'app/**/*.rb',
        'app/**/*.rake',
        'lib/**/*.rb',
        'lib/**/*.rake',
      ]);
    });

    it('validates overriding paths like a repo config would', () => {
      writeRepoConfig('group: team\nlanguage: ruby\n');
      expect(() =>
        resolveRepoProject(makeRepo(dir, { indexing: { paths: ['{..,app}'] } }), dir)
      ).toThrow(/Glob syntax not allowed/);
    });

    it('lets an override group beat .paparats.yml, and PAPARATS_GROUP beat both', () => {
      writeRepoConfig('group: team\nlanguage: ruby\n');
      const repo = makeRepo(dir, { group: 'from-projects-yml' });
      expect(resolveRepoProject(repo, dir).project.group).toBe('from-projects-yml');
      expect(resolveRepoProject(repo, dir, { sharedGroup: 'shared' }).project.group).toBe('shared');
    });

    it('applies an explicit docs kind', () => {
      writeRepoConfig('group: team\nlanguage: ruby\n');
      const { project } = resolveRepoProject(makeRepo(dir, { docs: { kind: 'prose' } }), dir);
      expect(project.docs?.kind).toBe('prose');
    });
  });

  it('uses .paparats.yml as-is without overrides', () => {
    writeRepoConfig('group: team\nlanguage: ruby\nindexing:\n  paths: [app]\n');
    const { project, source } = resolveRepoProject(makeRepo(dir), dir);
    expect(source).toBe('repo-config');
    expect(project.group).toBe('team');
    expect(project.patterns).toEqual(['app/**/*.rb', 'app/**/*.rake']);
    expect(project.watcher.enabled).toBe(false);
  });

  it('builds from overrides alone, with PAPARATS_GROUP winning', () => {
    const repo = makeRepo(dir, { group: 'own', indexing: { paths: ['app'] } });
    const { project, source } = resolveRepoProject(repo, dir, { sharedGroup: 'shared' });
    expect(source).toBe('overrides');
    expect(project.group).toBe('shared');
    expect(project.languages).toEqual(['ruby']);
    expect(project.patterns).toEqual(['app/**/*.rb', 'app/**/*.rake']);
  });

  it('auto-detects when there is no config at all', () => {
    const { project, source } = resolveRepoProject(makeRepo(dir), dir);
    expect(source).toBe('auto');
    expect(project.group).toBe('default');
    expect(project.name).toBe('billing');
    expect(project.languages).toEqual(['ruby']);
  });
});
