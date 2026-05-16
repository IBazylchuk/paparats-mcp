import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateStore } from '../src/state-store.js';

describe('StateStore', () => {
  let dir: string;
  let dbPath: string;
  let store: StateStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paparats-state-'));
    dbPath = path.join(dir, 'state.db');
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined for unknown repo', () => {
    expect(store.get('foo/bar')).toBeUndefined();
  });

  it('upserts and retrieves a fingerprint', () => {
    store.set('foo/bar', 'abc123', 'git', 42);
    const got = store.get('foo/bar');
    expect(got?.fingerprint).toBe('abc123');
    expect(got?.kind).toBe('git');
    expect(got?.lastChunks).toBe(42);
    expect(got?.lastIndexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('overwrites on re-set', () => {
    store.set('foo/bar', 'abc', 'git', 10);
    store.set('foo/bar', 'def', 'git', 20);
    expect(store.get('foo/bar')?.fingerprint).toBe('def');
    expect(store.get('foo/bar')?.lastChunks).toBe(20);
  });

  it('handles undefined chunks as null', () => {
    store.set('foo/bar', 'abc', 'git', undefined);
    expect(store.get('foo/bar')?.lastChunks).toBeNull();
  });

  it('deletes an entry', () => {
    store.set('foo/bar', 'abc', 'git', 1);
    store.delete('foo/bar');
    expect(store.get('foo/bar')).toBeUndefined();
  });

  it('delete is a no-op for unknown keys', () => {
    expect(() => store.delete('does/not-exist')).not.toThrow();
  });

  it('persists across reopen', () => {
    store.set('foo/bar', 'abc', 'mtime', 7);
    store.close();
    const reopened = new StateStore(dbPath);
    try {
      expect(reopened.get('foo/bar')?.fingerprint).toBe('abc');
      expect(reopened.get('foo/bar')?.kind).toBe('mtime');
    } finally {
      reopened.close();
    }
  });

  it('creates parent directory if missing', () => {
    const nested = path.join(dir, 'deeply', 'nested', 'state.db');
    const s = new StateStore(nested);
    try {
      s.set('a/b', 'x', 'git', 0);
      expect(s.get('a/b')?.fingerprint).toBe('x');
    } finally {
      s.close();
    }
  });

  it('close is idempotent', () => {
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
