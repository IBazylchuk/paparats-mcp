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

  // ── Symbol edge tests ───────────────────────────────────────────────────

  it('stores and retrieves symbol edges', () => {
    store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p//caller.ts//1-5//h1',
        to_chunk_id: 'g//p//def.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'greet',
      },
    ]);

    const from = store.getEdgesFrom('g//p//caller.ts//1-5//h1');
    expect(from).toHaveLength(1);
    expect(from[0]!.symbol_name).toBe('greet');
    expect(from[0]!.to_chunk_id).toBe('g//p//def.ts//1-5//h2');

    const to = store.getEdgesTo('g//p//def.ts//1-5//h2');
    expect(to).toHaveLength(1);
    expect(to[0]!.from_chunk_id).toBe('g//p//caller.ts//1-5//h1');
  });

  it('returns empty for unknown chunk edges', () => {
    expect(store.getEdgesFrom('nonexistent')).toEqual([]);
    expect(store.getEdgesTo('nonexistent')).toEqual([]);
  });

  it('deleteEdgesForChunk removes edges in both directions', () => {
    store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p//a.ts//1-5//h1',
        to_chunk_id: 'g//p//b.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'foo',
      },
      {
        from_chunk_id: 'g//p//c.ts//1-5//h3',
        to_chunk_id: 'g//p//a.ts//1-5//h1',
        relation_type: 'calls',
        symbol_name: 'bar',
      },
    ]);

    store.deleteEdgesForChunk('g//p//a.ts//1-5//h1');

    // Both directions should be cleared
    expect(store.getEdgesFrom('g//p//a.ts//1-5//h1')).toHaveLength(0);
    expect(store.getEdgesTo('g//p//a.ts//1-5//h1')).toHaveLength(0);
  });

  it('deleteChunk cascades to symbol edges', () => {
    const chunkId = 'g//p//file.ts//1-10//h1';

    store.upsertCommits(chunkId, [
      {
        commit_hash: 'abc',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'test',
      },
    ]);
    store.upsertSymbolEdges([
      {
        from_chunk_id: chunkId,
        to_chunk_id: 'g//p//other.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'greet',
      },
    ]);

    store.deleteChunk(chunkId);

    expect(store.getCommits(chunkId)).toHaveLength(0);
    expect(store.getEdgesFrom(chunkId)).toHaveLength(0);
  });

  it('deleteByProject cascades to symbol edges', () => {
    store.upsertSymbolEdges([
      {
        from_chunk_id: 'mygroup//proj1//a.ts//1-5//h1',
        to_chunk_id: 'mygroup//proj1//b.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'foo',
      },
      {
        from_chunk_id: 'mygroup//proj2//c.ts//1-5//h3',
        to_chunk_id: 'mygroup//proj2//d.ts//1-5//h4',
        relation_type: 'calls',
        symbol_name: 'bar',
      },
    ]);

    store.deleteByProject('mygroup', 'proj1');

    expect(store.getEdgesFrom('mygroup//proj1//a.ts//1-5//h1')).toHaveLength(0);
    // proj2 should be untouched
    expect(store.getEdgesFrom('mygroup//proj2//c.ts//1-5//h3')).toHaveLength(1);
  });

  it('deleteEdgesByProject removes only target project edges', () => {
    store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p1//a.ts//1-5//h1',
        to_chunk_id: 'g//p1//b.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'foo',
      },
      {
        from_chunk_id: 'g//p2//c.ts//1-5//h3',
        to_chunk_id: 'g//p2//d.ts//1-5//h4',
        relation_type: 'calls',
        symbol_name: 'bar',
      },
    ]);

    store.deleteEdgesByProject('g', 'p1');

    expect(store.getEdgesFrom('g//p1//a.ts//1-5//h1')).toHaveLength(0);
    expect(store.getEdgesFrom('g//p2//c.ts//1-5//h3')).toHaveLength(1);
  });

  it('deleteByFile removes commits, tickets, and edges for a specific file', () => {
    // Two files in same project
    store.upsertCommits('g//proj//src/keep.ts//1-5//h1', [
      {
        commit_hash: 'c1',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'keep commit',
      },
    ]);
    store.upsertCommits('g//proj//src/remove.ts//1-5//h2', [
      {
        commit_hash: 'c2',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'remove commit',
      },
    ]);
    store.upsertTickets('g//proj//src/remove.ts//1-5//h2', [
      { ticket_key: 'PROJ-123', source: 'jira' },
    ]);
    store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//proj//src/remove.ts//1-5//h2',
        to_chunk_id: 'g//proj//src/keep.ts//1-5//h1',
        relation_type: 'calls',
        symbol_name: 'foo',
      },
    ]);

    store.deleteByFile('g', 'proj', 'src/remove.ts');

    // remove.ts data should be gone
    expect(store.getCommits('g//proj//src/remove.ts//1-5//h2')).toHaveLength(0);
    expect(store.getTickets('g//proj//src/remove.ts//1-5//h2')).toHaveLength(0);
    expect(store.getEdgesFrom('g//proj//src/remove.ts//1-5//h2')).toHaveLength(0);

    // keep.ts data should remain
    expect(store.getCommits('g//proj//src/keep.ts//1-5//h1')).toHaveLength(1);
  });

  it('deleteByFile escapes LIKE wildcards in file paths', () => {
    // File with SQL LIKE wildcards in the name
    store.upsertCommits('g//proj//src/file_100%.ts//1-5//h1', [
      {
        commit_hash: 'c1',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'wildcard file',
      },
    ]);
    // A different file that would match an unescaped "file_100%" LIKE pattern
    store.upsertCommits('g//proj//src/file_1009.ts//1-5//h2', [
      {
        commit_hash: 'c2',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'should survive',
      },
    ]);

    store.deleteByFile('g', 'proj', 'src/file_100%.ts');

    // Wildcard file data should be gone
    expect(store.getCommits('g//proj//src/file_100%.ts//1-5//h1')).toHaveLength(0);
    // Other file should survive (would be deleted without proper escaping)
    expect(store.getCommits('g//proj//src/file_1009.ts//1-5//h2')).toHaveLength(1);
  });

  it('upsertSymbolEdges handles empty array', () => {
    expect(() => store.upsertSymbolEdges([])).not.toThrow();
  });
});
