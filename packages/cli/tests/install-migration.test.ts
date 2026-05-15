import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  tearDownAndBackupLegacy,
  type ResolvedDeps,
  type InstallOptions,
} from '../src/commands/install.js';

let tmpHome: string;
let composePath: string;
let envPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-migrate-'));
  composePath = path.join(tmpHome, 'docker-compose.yml');
  envPath = path.join(tmpHome, '.env');
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<ResolvedDeps> = {}): ResolvedDeps {
  return {
    commandExists: () => true,
    getDockerComposeCommand: () => 'docker compose',
    ollamaModelExists: () => true,
    isOllamaRunning: async () => true,
    waitForHealth: async () => true,
    downloadFile: async () => undefined,
    generateCompose: () => 'services: {}\n',
    mkdirSync: (p: string) => fs.mkdirSync(p, { recursive: true }),
    readFileSync: (p: string) => fs.readFileSync(p, 'utf8'),
    writeFileSync: (p: string, d: string) => fs.writeFileSync(p, d),
    existsSync: (p: string) => fs.existsSync(p),
    unlinkSync: (p: string) => fs.unlinkSync(p),
    renameSync: (a: string, b: string) => fs.renameSync(a, b),
    platform: () => 'linux',
    execSync: () => Buffer.from(''),
    ...overrides,
  };
}

const opts: InstallOptions = { force: true };

describe('tearDownAndBackupLegacy', () => {
  it('renames compose to compose.legacy.bak and .env to .env.legacy.bak', () => {
    fs.writeFileSync(composePath, 'services:\n  paparats-mcp: {}\n');
    fs.writeFileSync(envPath, 'GITHUB_TOKEN=foo\n');
    const deps = makeDeps();

    const result = tearDownAndBackupLegacy(composePath, envPath, deps, opts);

    expect(result.composeBak).toBe(`${composePath}.legacy.bak`);
    expect(result.envBak).toBe(`${envPath}.legacy.bak`);
    // Originals are gone, backups are present with the original content.
    expect(fs.existsSync(composePath)).toBe(false);
    expect(fs.existsSync(envPath)).toBe(false);
    expect(fs.readFileSync(result.composeBak!, 'utf8')).toBe('services:\n  paparats-mcp: {}\n');
    expect(fs.readFileSync(result.envBak!, 'utf8')).toBe('GITHUB_TOKEN=foo\n');
  });

  it('handles a missing .env file (only compose existed)', () => {
    fs.writeFileSync(composePath, 'services:\n  paparats-mcp: {}\n');
    const deps = makeDeps();

    const result = tearDownAndBackupLegacy(composePath, envPath, deps, opts);

    expect(result.composeBak).toBe(`${composePath}.legacy.bak`);
    expect(result.envBak).toBeNull();
  });

  it('survives `docker compose down` failure and still moves files', () => {
    fs.writeFileSync(composePath, 'services:\n  paparats-mcp: {}\n');
    fs.writeFileSync(envPath, 'X=1\n');
    const execSync = vi.fn(() => {
      throw new Error('docker daemon unreachable');
    });
    const deps = makeDeps({ execSync });

    const result = tearDownAndBackupLegacy(composePath, envPath, deps, opts);

    expect(execSync).toHaveBeenCalled();
    // Backup still happens — `down` is best-effort.
    expect(fs.existsSync(result.composeBak!)).toBe(true);
    expect(fs.existsSync(result.envBak!)).toBe(true);
  });

  it('returns nulls and writes nothing when neither file exists', () => {
    const deps = makeDeps();
    const result = tearDownAndBackupLegacy(composePath, envPath, deps, opts);
    expect(result).toEqual({ composeBak: null, envBak: null });
    expect(fs.existsSync(`${composePath}.legacy.bak`)).toBe(false);
  });
});
