import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROJECTS_YML,
  LEGACY_PROJECTS_YML,
  migrateLegacyProjectsFile,
  resolveProjectsFilePath,
  readProjectsFile,
  writeProjectsFile,
} from '../src/projects-yml.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-migrate-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('migrateLegacyProjectsFile', () => {
  it('renames paparats-indexer.yml → projects.yml when only the legacy file exists', () => {
    const legacy = path.join(tmpHome, LEGACY_PROJECTS_YML);
    const next = path.join(tmpHome, PROJECTS_YML);
    fs.writeFileSync(legacy, 'repos:\n  - url: org/foo\n');

    const renamed = migrateLegacyProjectsFile(tmpHome);

    expect(renamed).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(next)).toBe(true);
    expect(fs.readFileSync(next, 'utf8')).toBe('repos:\n  - url: org/foo\n');
  });

  it('is a no-op when projects.yml already exists', () => {
    const legacy = path.join(tmpHome, LEGACY_PROJECTS_YML);
    const next = path.join(tmpHome, PROJECTS_YML);
    fs.writeFileSync(next, 'repos: []\n');
    fs.writeFileSync(legacy, 'repos:\n  - url: org/foo\n');

    const renamed = migrateLegacyProjectsFile(tmpHome);

    expect(renamed).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(next)).toBe(true);
    expect(fs.readFileSync(next, 'utf8')).toBe('repos: []\n');
  });

  it('is a no-op when neither file exists', () => {
    const renamed = migrateLegacyProjectsFile(tmpHome);
    expect(renamed).toBe(false);
  });
});

describe('resolveProjectsFilePath', () => {
  it('prefers projects.yml when both files exist', () => {
    fs.writeFileSync(path.join(tmpHome, LEGACY_PROJECTS_YML), 'repos: []\n');
    fs.writeFileSync(path.join(tmpHome, PROJECTS_YML), 'repos: []\n');

    expect(resolveProjectsFilePath(tmpHome)).toBe(path.join(tmpHome, PROJECTS_YML));
  });

  it('falls back to paparats-indexer.yml when projects.yml is absent', () => {
    fs.writeFileSync(path.join(tmpHome, LEGACY_PROJECTS_YML), 'repos: []\n');

    expect(resolveProjectsFilePath(tmpHome)).toBe(path.join(tmpHome, LEGACY_PROJECTS_YML));
  });

  it('returns null when neither file exists', () => {
    expect(resolveProjectsFilePath(tmpHome)).toBeNull();
  });
});

describe('readProjectsFile (fallback to legacy)', () => {
  it('reads from paparats-indexer.yml when projects.yml is absent', () => {
    fs.writeFileSync(path.join(tmpHome, LEGACY_PROJECTS_YML), 'repos:\n  - url: legacy/repo\n');

    const file = readProjectsFile(tmpHome);

    expect(file.repos).toHaveLength(1);
    expect(file.repos[0]?.url).toBe('legacy/repo');
  });

  it('prefers projects.yml content when both exist', () => {
    fs.writeFileSync(path.join(tmpHome, LEGACY_PROJECTS_YML), 'repos:\n  - url: legacy/repo\n');
    fs.writeFileSync(path.join(tmpHome, PROJECTS_YML), 'repos:\n  - url: new/repo\n');

    const file = readProjectsFile(tmpHome);

    expect(file.repos).toHaveLength(1);
    expect(file.repos[0]?.url).toBe('new/repo');
  });
});

describe('writeProjectsFile', () => {
  it('always writes to projects.yml — never to the legacy name', () => {
    writeProjectsFile({ repos: [{ url: 'a/b' }] }, tmpHome);

    expect(fs.existsSync(path.join(tmpHome, PROJECTS_YML))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, LEGACY_PROJECTS_YML))).toBe(false);
  });
});
