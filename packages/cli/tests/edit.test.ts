import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runEdit, defaultResolveEditor } from '../src/commands/edit.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-edit-'));
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  delete process.env['VISUAL'];
  delete process.env['EDITOR'];
});

describe('defaultResolveEditor', () => {
  it('prefers $VISUAL', () => {
    process.env['VISUAL'] = 'subl -w';
    const r = defaultResolveEditor('darwin');
    expect(r.cmd).toBe('subl');
    expect(r.args).toEqual(['-w']);
  });

  it('falls back to $EDITOR', () => {
    process.env['EDITOR'] = 'nano';
    const r = defaultResolveEditor('darwin');
    expect(r.cmd).toBe('nano');
  });

  it('darwin default opens with `open -t -W`', () => {
    const r = defaultResolveEditor('darwin');
    expect(r.cmd).toBe('open');
    expect(r.args).toContain('-W');
  });

  it('linux default uses xdg-open', () => {
    const r = defaultResolveEditor('linux');
    expect(r.cmd).toBe('xdg-open');
  });

  it('windows default uses notepad', () => {
    const r = defaultResolveEditor('win32');
    expect(r.cmd).toBe('notepad');
  });
});

describe('runEdit', () => {
  it('errors when target file missing', async () => {
    await expect(
      runEdit('compose', {
        paparatsHome: tmpHome,
        spawnEditor: vi.fn().mockReturnValue({ status: 0 }),
      })
    ).rejects.toThrow(/Run `paparats install`/);
  });

  it('compose target spawns editor and exits without restart', async () => {
    fs.writeFileSync(path.join(tmpHome, 'docker-compose.yml'), 'services: {}\n');
    const spawnEditor = vi.fn().mockReturnValue({ status: 0 });
    const result = await runEdit('compose', { paparatsHome: tmpHome, spawnEditor });
    expect(result.edited).toBe(true);
    expect(spawnEditor).toHaveBeenCalledTimes(1);
  });

  it('projects target validates and triggers regenerate+reindex when valid', async () => {
    fs.writeFileSync(path.join(tmpHome, 'projects.yml'), 'repos:\n  - url: org/foo\n');
    const regen = vi.fn().mockResolvedValue({ composeChanged: true });
    const trigger = vi.fn().mockResolvedValue(undefined);
    const result = await runEdit('projects', {
      paparatsHome: tmpHome,
      spawnEditor: () => ({ status: 0 }),
      regenerateAndRestart: regen,
      triggerFullReindex: trigger,
    });
    expect(result.validated).toBe(true);
    expect(result.composeChanged).toBe(true);
    expect(regen).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalled();
  });

  it('projects target validation failure: no regenerate, no trigger', async () => {
    fs.writeFileSync(path.join(tmpHome, 'projects.yml'), 'not valid: : :');
    const regen = vi.fn();
    const trigger = vi.fn();
    const result = await runEdit('projects', {
      paparatsHome: tmpHome,
      spawnEditor: () => ({ status: 0 }),
      regenerateAndRestart: regen,
      triggerFullReindex: trigger,
    });
    expect(result.validated).toBe(false);
    expect(regen).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('errors when editor exits non-zero', async () => {
    fs.writeFileSync(path.join(tmpHome, 'docker-compose.yml'), 'services: {}\n');
    await expect(
      runEdit('compose', {
        paparatsHome: tmpHome,
        spawnEditor: () => ({ status: 1 }),
      })
    ).rejects.toThrow(/status 1/);
  });
});
