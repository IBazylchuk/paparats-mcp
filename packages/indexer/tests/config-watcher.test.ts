import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigWatcher, diff, type MinimalWatcher } from '../src/config-watcher.js';
import type { RepoConfig } from '../src/types.js';

function repo(name: string, extra: Partial<RepoConfig> = {}): RepoConfig {
  return {
    url: extra.url ?? `https://github.com/org/${name}.git`,
    owner: extra.owner ?? 'org',
    name,
    fullName: extra.fullName ?? `org/${name}`,
    ...(extra.localPath !== undefined ? { localPath: extra.localPath } : {}),
    ...(extra.overrides !== undefined ? { overrides: extra.overrides } : {}),
  };
}

describe('diff', () => {
  it('reports added entries', () => {
    const result = diff([repo('a')], [repo('a'), repo('b')]);
    expect(result.added.map((r) => r.name)).toEqual(['b']);
    expect(result.removed).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('reports removed entries', () => {
    const result = diff([repo('a'), repo('b')], [repo('a')]);
    expect(result.removed.map((r) => r.name)).toEqual(['b']);
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('reports modified when overrides change', () => {
    const before = repo('a', { overrides: { group: 'one' } });
    const after = repo('a', { overrides: { group: 'two' } });
    const result = diff([before], [after]);
    expect(result.modified.map((m) => m.next.name)).toEqual(['a']);
    expect(result.modified[0]!.prior).toEqual(before);
    expect(result.modified[0]!.next).toEqual(after);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('treats identical entries as no-op', () => {
    const r = repo('a', { overrides: { group: 'g' } });
    const result = diff([r], [r]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('reports modified when localPath changes', () => {
    const before = repo('a', { localPath: '/projects/old' });
    const after = repo('a', { localPath: '/projects/new' });
    const result = diff([before], [after]);
    expect(result.modified.map((m) => m.next.name)).toEqual(['a']);
  });

  it('reports modified with both prior and next when fullName changes', () => {
    // Repointing the same name from oldOwner/repo to newOwner/repo: the
    // indexer keys bookkeeping by fullName and would otherwise dereference
    // a stale key; the diff carries `prior` so the caller can re-key.
    const before = repo('app', { url: 'https://github.com/old/app.git', fullName: 'old/app' });
    const after = repo('app', { url: 'https://github.com/new/app.git', fullName: 'new/app' });
    const result = diff([before], [after]);
    expect(result.modified).toHaveLength(1);
    expect(result.modified[0]!.prior.fullName).toBe('old/app');
    expect(result.modified[0]!.next.fullName).toBe('new/app');
  });
});

describe('ConfigWatcher', () => {
  let tmpDir: string;
  let configPath: string;
  let triggerChange: () => void;
  let triggerError: (err: Error) => void;
  let closeWatcher: ReturnType<typeof vi.fn>;
  let stubWatcher: MinimalWatcher;
  let listeners: { change: (() => void) | null; error: ((err: Error) => void) | null };

  function makeWatcher(): MinimalWatcher {
    listeners = { change: null, error: null };
    closeWatcher = vi.fn();
    stubWatcher = {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'change') listeners.change = cb as () => void;
        if (event === 'error') listeners.error = cb as (err: Error) => void;
        return stubWatcher;
      },
      close: closeWatcher,
    } as MinimalWatcher;
    triggerChange = () => listeners.change?.();
    triggerError = (err) => listeners.error?.(err);
    return stubWatcher;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-watcher-'));
    configPath = path.join(tmpDir, 'projects.yml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(content: string): void {
    fs.writeFileSync(configPath, content);
  }

  it('emits change with added entry when YAML grows', () => {
    writeYaml('repos:\n  - url: org/a\n');
    const onChange = vi.fn();
    const watcher = new ConfigWatcher(
      { configPath, onChange, debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a')]
    );
    writeYaml('repos:\n  - url: org/a\n  - url: org/b\n');
    watcher.triggerReloadNowForTest();
    expect(onChange).toHaveBeenCalledTimes(1);
    const change = onChange.mock.calls[0]![0]!;
    expect(change.added.map((r: RepoConfig) => r.name)).toEqual(['b']);
    expect(change.removed).toEqual([]);
  });

  it('emits change with removed entry when YAML shrinks', () => {
    writeYaml('repos:\n  - url: org/a\n  - url: org/b\n');
    const onChange = vi.fn();
    const watcher = new ConfigWatcher(
      { configPath, onChange, debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a'), repo('b')]
    );
    writeYaml('repos:\n  - url: org/a\n');
    watcher.triggerReloadNowForTest();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]!.removed.map((r: RepoConfig) => r.name)).toEqual(['b']);
  });

  it('emits modified when overrides change', () => {
    writeYaml('repos:\n  - url: org/a\n    group: one\n');
    const onChange = vi.fn();
    const watcher = new ConfigWatcher(
      { configPath, onChange, debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a', { overrides: { group: 'one' } })]
    );
    writeYaml('repos:\n  - url: org/a\n    group: two\n');
    watcher.triggerReloadNowForTest();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      onChange.mock.calls[0]![0]!.modified.map((m: { next: RepoConfig }) => m.next.name)
    ).toEqual(['a']);
  });

  it('does not emit when nothing changed', () => {
    writeYaml('repos:\n  - url: org/a\n');
    const onChange = vi.fn();
    const watcher = new ConfigWatcher(
      { configPath, onChange, debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a')]
    );
    // file untouched
    watcher.triggerReloadNowForTest();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps prior state and notifies onError when YAML becomes invalid', () => {
    writeYaml('repos:\n  - url: org/a\n');
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new ConfigWatcher(
      { configPath, onChange, onError, debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a')]
    );
    writeYaml('not valid yaml: : :');
    watcher.triggerReloadNowForTest();
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid changes into a single reload', async () => {
    writeYaml('repos:\n  - url: org/a\n');
    const onChange = vi.fn();
    new ConfigWatcher({ configPath, onChange, debounceMs: 50, spawnWatcher: makeWatcher }, [
      repo('a'),
    ]);
    writeYaml('repos:\n  - url: org/a\n  - url: org/b\n');
    triggerChange();
    triggerChange();
    triggerChange();
    await new Promise((r) => setTimeout(r, 80));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('forwards watcher errors to onError', () => {
    writeYaml('repos:\n  - url: org/a\n');
    const onError = vi.fn();
    new ConfigWatcher(
      { configPath, onChange: vi.fn(), onError, debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a')]
    );
    triggerError(new Error('boom'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]!.message).toBe('boom');
  });

  it('close() clears pending timer and closes underlying watcher', async () => {
    writeYaml('repos:\n  - url: org/a\n');
    const w = new ConfigWatcher(
      { configPath, onChange: vi.fn(), debounceMs: 0, spawnWatcher: makeWatcher },
      [repo('a')]
    );
    await w.close();
    expect(closeWatcher).toHaveBeenCalledTimes(1);
  });
});
