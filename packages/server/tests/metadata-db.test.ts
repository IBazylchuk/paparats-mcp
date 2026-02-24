import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MetadataStore } from '../src/metadata-db.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-metadb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

describe('MetadataStore', () => {
  let tmpDir: string;
  let store: MetadataStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new MetadataStore(path.join(tmpDir, 'test-metadata.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores and retrieves commits', () => {
    store.upsertCommits('g//p//file.ts//1-10//h1', [
      {
        commit_hash: 'abc123',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'dev@test.com',
        message_summary: 'fix: login bug',
      },
      {
        commit_hash: 'def456',
        committed_at: '2024-01-14T10:00:00Z',
        author_email: 'dev2@test.com',
        message_summary: 'feat: add auth',
      },
    ]);

    const commits = store.getCommits('g//p//file.ts//1-10//h1');
    expect(commits).toHaveLength(2);
    // Sorted by committed_at DESC
    expect(commits[0]!.commit_hash).toBe('abc123');
    expect(commits[1]!.commit_hash).toBe('def456');
  });

  it('stores and retrieves tickets', () => {
    store.upsertTickets('g//p//file.ts//1-10//h1', [
      { ticket_key: 'PROJ-123', source: 'jira' },
      { ticket_key: '#42', source: 'github' },
    ]);

    const tickets = store.getTickets('g//p//file.ts//1-10//h1');
    expect(tickets).toHaveLength(2);
    const keys = tickets.map((t) => t.ticket_key);
    expect(keys).toContain('PROJ-123');
    expect(keys).toContain('#42');
  });

  it('upsert replaces existing commits', () => {
    const chunkId = 'g//p//file.ts//1-10//h1';

    store.upsertCommits(chunkId, [
      {
        commit_hash: 'old1',
        committed_at: '2024-01-10T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'old commit',
      },
    ]);
    expect(store.getCommits(chunkId)).toHaveLength(1);

    store.upsertCommits(chunkId, [
      {
        commit_hash: 'new1',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'c@d.com',
        message_summary: 'new commit 1',
      },
      {
        commit_hash: 'new2',
        committed_at: '2024-01-14T10:00:00Z',
        author_email: 'c@d.com',
        message_summary: 'new commit 2',
      },
    ]);

    const commits = store.getCommits(chunkId);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.commit_hash).toBe('new1');
    expect(commits[1]!.commit_hash).toBe('new2');
  });

  it('upsert replaces existing tickets', () => {
    const chunkId = 'g//p//file.ts//1-10//h1';

    store.upsertTickets(chunkId, [{ ticket_key: 'OLD-1', source: 'jira' }]);
    expect(store.getTickets(chunkId)).toHaveLength(1);

    store.upsertTickets(chunkId, [
      { ticket_key: 'NEW-1', source: 'jira' },
      { ticket_key: '#99', source: 'github' },
    ]);

    const tickets = store.getTickets(chunkId);
    expect(tickets).toHaveLength(2);
    const keys = tickets.map((t) => t.ticket_key);
    expect(keys).toContain('NEW-1');
    expect(keys).toContain('#99');
    expect(keys).not.toContain('OLD-1');
  });

  it('getLatestCommit returns most recent commit', () => {
    store.upsertCommits('g//p//file.ts//1-10//h1', [
      {
        commit_hash: 'older',
        committed_at: '2024-01-10T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'old',
      },
      {
        commit_hash: 'newer',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'c@d.com',
        message_summary: 'new',
      },
    ]);

    const latest = store.getLatestCommit('g//p//file.ts//1-10//h1');
    expect(latest).not.toBeNull();
    expect(latest!.commit_hash).toBe('newer');
    expect(latest!.author_email).toBe('c@d.com');
  });

  it('getLatestCommit returns null for unknown chunk', () => {
    const latest = store.getLatestCommit('nonexistent');
    expect(latest).toBeNull();
  });

  it('getCommits respects limit parameter', () => {
    store.upsertCommits('g//p//file.ts//1-10//h1', [
      {
        commit_hash: 'c1',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'commit 1',
      },
      {
        commit_hash: 'c2',
        committed_at: '2024-01-14T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'commit 2',
      },
      {
        commit_hash: 'c3',
        committed_at: '2024-01-13T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'commit 3',
      },
    ]);

    const commits = store.getCommits('g//p//file.ts//1-10//h1', 2);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.commit_hash).toBe('c1');
    expect(commits[1]!.commit_hash).toBe('c2');
  });

  it('deleteChunk removes all data for a chunk', () => {
    const chunkId = 'g//p//file.ts//1-10//h1';

    store.upsertCommits(chunkId, [
      {
        commit_hash: 'abc',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'test',
      },
    ]);
    store.upsertTickets(chunkId, [{ ticket_key: 'PROJ-1', source: 'jira' }]);

    expect(store.getCommits(chunkId)).toHaveLength(1);
    expect(store.getTickets(chunkId)).toHaveLength(1);

    store.deleteChunk(chunkId);

    expect(store.getCommits(chunkId)).toHaveLength(0);
    expect(store.getTickets(chunkId)).toHaveLength(0);
  });

  it('deleteByProject removes all data for a project prefix', () => {
    store.upsertCommits('mygroup//proj1//a.ts//1-5//h1', [
      {
        commit_hash: 'c1',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'first',
      },
    ]);
    store.upsertCommits('mygroup//proj1//b.ts//1-5//h2', [
      {
        commit_hash: 'c2',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'second',
      },
    ]);
    store.upsertCommits('mygroup//proj2//c.ts//1-5//h3', [
      {
        commit_hash: 'c3',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'third',
      },
    ]);
    store.upsertTickets('mygroup//proj1//a.ts//1-5//h1', [{ ticket_key: 'T-1', source: 'jira' }]);

    store.deleteByProject('mygroup', 'proj1');

    // proj1 data should be gone
    expect(store.getCommits('mygroup//proj1//a.ts//1-5//h1')).toHaveLength(0);
    expect(store.getCommits('mygroup//proj1//b.ts//1-5//h2')).toHaveLength(0);
    expect(store.getTickets('mygroup//proj1//a.ts//1-5//h1')).toHaveLength(0);

    // proj2 data should remain
    expect(store.getCommits('mygroup//proj2//c.ts//1-5//h3')).toHaveLength(1);
  });

  it('close is idempotent', () => {
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it('returns empty arrays for unknown chunks', () => {
    expect(store.getCommits('nonexistent')).toEqual([]);
    expect(store.getTickets('nonexistent')).toEqual([]);
  });
});
