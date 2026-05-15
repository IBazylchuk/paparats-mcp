import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runStart, runStop, runRestart } from '../src/commands/lifecycle.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-lifecycle-'));
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const writeCompose = (): string => {
  const file = path.join(tmpHome, 'docker-compose.yml');
  fs.writeFileSync(file, 'services:\n  qdrant:\n    image: qdrant/qdrant\n');
  return file;
};

describe('runStart', () => {
  it('runs `up -d` with the compose file', async () => {
    const file = writeCompose();
    const run = vi.fn();
    await runStart(
      {},
      { paparatsHome: tmpHome, composeCmd: () => 'docker compose', runCommand: run }
    );
    expect(run).toHaveBeenCalledWith(`docker compose -f "${file}" up -d`);
  });

  it('errors when compose missing', async () => {
    await expect(
      runStart(
        {},
        { paparatsHome: tmpHome, composeCmd: () => 'docker compose', runCommand: vi.fn() }
      )
    ).rejects.toThrow(/paparats install/);
  });
});

describe('runStop', () => {
  it('runs `down` with the compose file', async () => {
    const file = writeCompose();
    const run = vi.fn();
    await runStop({ paparatsHome: tmpHome, composeCmd: () => 'docker compose', runCommand: run });
    expect(run).toHaveBeenCalledWith(`docker compose -f "${file}" down`);
  });
});

describe('runRestart', () => {
  it('runs `up -d` to apply new mounts', async () => {
    const file = writeCompose();
    const run = vi.fn();
    await runRestart({
      paparatsHome: tmpHome,
      composeCmd: () => 'docker compose',
      runCommand: run,
    });
    expect(run).toHaveBeenCalledWith(`docker compose -f "${file}" up -d`);
  });
});
