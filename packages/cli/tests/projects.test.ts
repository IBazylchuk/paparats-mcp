import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import {
  detectKind,
  runAdd,
  runList,
  runRemove,
  type ListedProject,
} from '../src/commands/projects.js';
import { writeInstallState, type ProjectsFile } from '../src/projects-yml.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-projects-'));
  // Most tests assume `paparats install` already ran — without install.json
  // add/remove skip compose regen and never restart, breaking restart-related
  // expectations. Record a minimal install state.
  writeInstallState({ ollamaMode: 'native' }, tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readYml(): ProjectsFile {
  const file = path.join(tmpHome, 'paparats-indexer.yml');
  if (!fs.existsSync(file)) return { repos: [] };
  const parsed = yaml.load(fs.readFileSync(file, 'utf8')) as ProjectsFile;
  return parsed ?? { repos: [] };
}

describe('detectKind', () => {
  it.each([
    ['/Users/alice/code/billing', 'local'],
    ['git@github.com:org/repo.git', 'remote'],
    ['https://github.com/org/repo.git', 'remote'],
    ['org/repo', 'remote'],
    // Disambiguate locals: anything that LOOKS like owner/repo we treat as remote.
    // The user must pass an absolute path for local projects.
    ['/var/log/billing', 'local'],
  ])('detects %s as %s', (input, expected) => {
    expect(detectKind(input)).toBe(expected);
  });
});

describe('runAdd', () => {
  it('adds a local-path entry, restarts and triggers reindex', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-'));
    const restart = vi.fn().mockResolvedValue(undefined);
    const trigger = vi.fn().mockResolvedValue(undefined);

    const result = await runAdd(
      dir,
      { paparatsHome: tmpHome },
      { restartStack: restart, triggerReindex: trigger }
    );

    expect(result.kind).toBe('local');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(path.basename(dir));
    const file = readYml();
    expect(file.repos).toHaveLength(1);
    expect(file.repos[0]!.path).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds a remote shorthand without restart, but triggers reindex', async () => {
    const restart = vi.fn();
    const trigger = vi.fn().mockResolvedValue(undefined);

    const result = await runAdd(
      'org/repo',
      { paparatsHome: tmpHome },
      { restartStack: restart, triggerReindex: trigger }
    );

    expect(result.kind).toBe('remote');
    expect(restart).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith('repo');
    const file = readYml();
    expect(file.repos[0]!.url).toBe('org/repo');
  });

  it('extracts owner/repo from a full git URL', async () => {
    await runAdd(
      'https://github.com/acme/widgets.git',
      { paparatsHome: tmpHome },
      { restartStack: vi.fn(), triggerReindex: vi.fn().mockResolvedValue(undefined) }
    );
    const file = readYml();
    expect(file.repos[0]!.url).toBe('acme/widgets');
  });

  it('--no-restart skips restart on local add', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-'));
    const restart = vi.fn();
    await runAdd(
      dir,
      { paparatsHome: tmpHome, noRestart: true },
      { restartStack: restart, triggerReindex: vi.fn().mockResolvedValue(undefined) }
    );
    expect(restart).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--no-reindex skips trigger', async () => {
    const trigger = vi.fn();
    await runAdd(
      'org/repo',
      { paparatsHome: tmpHome, noReindex: true },
      { restartStack: vi.fn(), triggerReindex: trigger }
    );
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects local path that does not exist', async () => {
    await expect(runAdd('/nonexistent/billing', { paparatsHome: tmpHome })).rejects.toThrow(
      /does not exist/
    );
  });

  it('rejects duplicate name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-'));
    await runAdd(
      dir,
      { paparatsHome: tmpHome },
      { restartStack: vi.fn(), triggerReindex: vi.fn().mockResolvedValue(undefined) }
    );
    await expect(
      runAdd(
        dir,
        { paparatsHome: tmpHome },
        { restartStack: vi.fn(), triggerReindex: vi.fn().mockResolvedValue(undefined) }
      )
    ).rejects.toThrow(/already exists/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives indexer-trigger failure with a warning (project still added)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-'));
    const result = await runAdd(
      dir,
      { paparatsHome: tmpHome },
      {
        restartStack: vi.fn(),
        triggerReindex: vi.fn().mockRejectedValue(new Error('connect refused')),
      }
    );
    expect(result.reindexed).toBe(false);
    expect(readYml().repos).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runList', () => {
  it('returns rows for configured projects with health status', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'paparats-indexer.yml'),
      'repos:\n  - path: /Users/x/foo\n    group: dev\n  - url: org/bar\n'
    );
    const fetchHealth = vi.fn().mockResolvedValue({
      repos: [
        { repo: 'foo', status: 'success', chunksIndexed: 42, lastRun: '2026-05-14T12:00:00Z' },
      ],
    });
    const rows = await runList({ paparatsHome: tmpHome }, { fetchHealth });
    expect(rows).toHaveLength(2);
    const foo = rows.find((r) => r.name === 'foo')!;
    expect(foo.kind).toBe('local');
    expect(foo.status).toBe('success');
    expect(foo.chunks).toBe(42);
    const bar = rows.find((r) => r.name === 'bar')!;
    expect(bar.kind).toBe('remote');
    expect(bar.status).toBe('?');
  });

  it('returns rows even when indexer is unreachable', async () => {
    fs.writeFileSync(path.join(tmpHome, 'paparats-indexer.yml'), 'repos:\n  - url: org/foo\n');
    const fetchHealth = vi.fn().mockResolvedValue(null);
    const rows = await runList({ paparatsHome: tmpHome }, { fetchHealth });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('?');
  });

  it('--group filters', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'paparats-indexer.yml'),
      'repos:\n  - url: org/a\n    group: g1\n  - url: org/b\n    group: g2\n'
    );
    const fetchHealth = vi.fn().mockResolvedValue({ repos: [] });
    const rows: ListedProject[] = await runList(
      { paparatsHome: tmpHome, group: 'g1' },
      { fetchHealth }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('a');
  });
});

describe('runRemove', () => {
  it('removes entry and calls server delete', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'paparats-indexer.yml'),
      'repos:\n  - url: org/foo\n    group: dev\n'
    );
    const del = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();
    const result = await runRemove(
      'foo',
      { paparatsHome: tmpHome, yes: true },
      { deleteServerData: del, restartStack: restart }
    );
    expect(result.removed).toBe(true);
    expect(del).toHaveBeenCalledWith('dev', 'foo');
    expect(restart).not.toHaveBeenCalled(); // remote, no restart
    expect(readYml().repos).toHaveLength(0);
  });

  it('restarts on local-path removal', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'paparats-indexer.yml'),
      'repos:\n  - path: /Users/x/foo\n    group: dev\n'
    );
    const del = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();
    await runRemove(
      'foo',
      { paparatsHome: tmpHome, yes: true },
      { deleteServerData: del, restartStack: restart }
    );
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('promptConfirm=false → no changes', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'paparats-indexer.yml'),
      'repos:\n  - url: org/foo\n    group: dev\n'
    );
    const result = await runRemove(
      'foo',
      { paparatsHome: tmpHome },
      {
        promptConfirm: vi.fn().mockResolvedValue(false),
        deleteServerData: vi.fn(),
        restartStack: vi.fn(),
      }
    );
    expect(result.removed).toBe(false);
    expect(readYml().repos).toHaveLength(1);
  });

  it('throws on missing project', async () => {
    fs.writeFileSync(path.join(tmpHome, 'paparats-indexer.yml'), 'repos: []\n');
    await expect(runRemove('foo', { paparatsHome: tmpHome, yes: true })).rejects.toThrow(
      /not found/
    );
  });

  it('still removes from YAML if server delete fails', async () => {
    fs.writeFileSync(
      path.join(tmpHome, 'paparats-indexer.yml'),
      'repos:\n  - url: org/foo\n    group: dev\n'
    );
    const result = await runRemove(
      'foo',
      { paparatsHome: tmpHome, yes: true },
      {
        deleteServerData: vi.fn().mockRejectedValue(new Error('404')),
        restartStack: vi.fn(),
      }
    );
    expect(result.removed).toBe(true);
    expect(result.serverDeleteOk).toBe(false);
    expect(readYml().repos).toHaveLength(0);
  });
});
