import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
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

  it('stores and retrieves symbol edges', async () => {
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p//caller.ts//1-5//h1',
        to_chunk_id: 'g//p//def.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'greet',
        confidence: 'INFERRED',
      },
    ]);

    const from = store.getEdgesFrom('g//p//caller.ts//1-5//h1');
    expect(from).toHaveLength(1);
    expect(from[0]!.symbol_name).toBe('greet');
    expect(from[0]!.to_chunk_id).toBe('g//p//def.ts//1-5//h2');
    expect(from[0]!.confidence).toBe('INFERRED');

    const to = store.getEdgesTo('g//p//def.ts//1-5//h2');
    expect(to).toHaveLength(1);
    expect(to[0]!.from_chunk_id).toBe('g//p//caller.ts//1-5//h1');
  });

  it('round-trips EXTRACTED/INFERRED/AMBIGUOUS confidence values', async () => {
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p//a.ts//1-5//h1',
        to_chunk_id: 'g//p//a.ts//6-10//h2',
        relation_type: 'calls',
        symbol_name: 'localCall',
        confidence: 'EXTRACTED',
      },
      {
        from_chunk_id: 'g//p//a.ts//1-5//h1',
        to_chunk_id: 'g//p//b.ts//1-5//h3',
        relation_type: 'calls',
        symbol_name: 'crossFile',
        confidence: 'INFERRED',
      },
      {
        from_chunk_id: 'g//p//a.ts//1-5//h1',
        to_chunk_id: 'g//p//c.ts//1-5//h4',
        relation_type: 'calls',
        symbol_name: 'multiDef',
        confidence: 'AMBIGUOUS',
      },
    ]);

    const all = store.getEdgesFrom('g//p//a.ts//1-5//h1');
    const byConfidence = Object.fromEntries(all.map((e) => [e.symbol_name, e.confidence]));
    expect(byConfidence).toEqual({
      localCall: 'EXTRACTED',
      crossFile: 'INFERRED',
      multiDef: 'AMBIGUOUS',
    });
  });

  it('defaults legacy edges (written without confidence) to INFERRED', async () => {
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p//caller.ts//1-5//h1',
        to_chunk_id: 'g//p//def.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'greet',
      },
    ]);

    const [edge] = store.getEdgesFrom('g//p//caller.ts//1-5//h1');
    expect(edge?.confidence).toBe('INFERRED');
  });

  // ── Degree analytics ────────────────────────────────────────────────────

  it('getGroupDegreeSnapshot ranks chunks by incoming degree', async () => {
    const hub = 'g//p//hub.ts//1-5//hub';
    const edges = [];
    for (let i = 0; i < 12; i++) {
      edges.push({
        from_chunk_id: `g//p//caller${i}.ts//1-5//c${i}`,
        to_chunk_id: hub,
        relation_type: 'calls' as const,
        symbol_name: `s${i}`,
        confidence: 'INFERRED' as const,
      });
    }
    // One non-hub callee with only 1 incoming edge.
    edges.push({
      from_chunk_id: 'g//p//caller0.ts//1-5//c0',
      to_chunk_id: 'g//p//cold.ts//1-5//cold',
      relation_type: 'calls',
      symbol_name: 'rare',
      confidence: 'INFERRED',
    });
    await store.upsertSymbolEdges(edges);

    const snap = store.getGroupDegreeSnapshot('g');
    expect(snap.topInDegree[0]?.chunkId).toBe(hub);
    expect(snap.topInDegree[0]?.degree).toBe(12);
    // p95 is floored at 5 so a small graph isn't classified entirely as hubs.
    expect(snap.inDegreeP95).toBeGreaterThanOrEqual(5);
  });

  it('getTopByInDegree honors an optional project filter', async () => {
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p1//a.ts//1-5//h1',
        to_chunk_id: 'g//p1//x.ts//1-5//hx',
        relation_type: 'calls',
        symbol_name: 'foo',
        confidence: 'INFERRED',
      },
      {
        from_chunk_id: 'g//p2//b.ts//1-5//h2',
        to_chunk_id: 'g//p2//y.ts//1-5//hy',
        relation_type: 'calls',
        symbol_name: 'bar',
        confidence: 'INFERRED',
      },
    ]);

    const p1 = store.getTopByInDegree('g', 10, 'p1');
    expect(p1.map((r) => r.chunkId)).toEqual(['g//p1//x.ts//1-5//hx']);
  });

  it('refreshes degree cache after deleteEdgesByProject (stale-while-revalidate)', async () => {
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'g//p1//a.ts//1-5//h1',
        to_chunk_id: 'g//p1//x.ts//1-5//hx',
        relation_type: 'calls',
        symbol_name: 'foo',
        confidence: 'INFERRED',
      },
    ]);
    // Warm the cache.
    expect(store.getGroupDegreeSnapshot('g').topInDegree).toHaveLength(1);

    store.deleteEdgesByProject('g', 'p1');
    // The read is non-blocking: it serves the stale snapshot immediately and
    // schedules a background recompute, so the edge is still visible right after
    // the delete.
    expect(store.getGroupDegreeSnapshot('g').topInDegree).toHaveLength(1);

    // After the background refresh runs, the snapshot reflects the deletion.
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getGroupDegreeSnapshot('g').topInDegree).toHaveLength(0);
  });

  // Per-PR-89 review (Gemini): upsertSymbolEdges used to clear the entire
  // degree cache via invalidateDegreeCache(). It must now only drop entries
  // for groups touched by the incoming edges, so an index pass on one group
  // doesn't blow away unrelated groups' cached stats.
  it('upsertSymbolEdges only invalidates the cache of groups touched by the edges', async () => {
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'groupA//p//a.ts//1-5//h1',
        to_chunk_id: 'groupA//p//b.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'foo',
        confidence: 'INFERRED',
      },
      {
        from_chunk_id: 'groupB//p//c.ts//1-5//h3',
        to_chunk_id: 'groupB//p//d.ts//1-5//h4',
        relation_type: 'calls',
        symbol_name: 'bar',
        confidence: 'INFERRED',
      },
    ]);
    // Warm the cache for both groups.
    const beforeB = store.getGroupDegreeSnapshot('groupB');
    expect(beforeB.topInDegree).toHaveLength(1);

    // Add an edge in groupA only.
    await store.upsertSymbolEdges([
      {
        from_chunk_id: 'groupA//p//e.ts//1-5//h5',
        to_chunk_id: 'groupA//p//b.ts//1-5//h2',
        relation_type: 'calls',
        symbol_name: 'foo2',
        confidence: 'INFERRED',
      },
    ]);

    // Reading groupA serves the stale snapshot immediately and schedules a
    // background refresh; after it runs, the stats reflect the new edge
    // (b.ts now has in-degree 2).
    store.getGroupDegreeSnapshot('groupA');
    await new Promise((resolve) => setImmediate(resolve));
    const afterA = store.getGroupDegreeSnapshot('groupA');
    expect(afterA.topInDegree[0]?.degree).toBe(2);
    // groupB cache survived the unrelated write untouched — it was never marked
    // stale, so no refresh was scheduled and the cached hubChunkIds Set is the
    // same object.
    const afterB = store.getGroupDegreeSnapshot('groupB');
    expect(afterB.hubChunkIds).toBe(beforeB.hubChunkIds);
  });

  it('exposes a pre-computed hubChunkIds set so find_usages avoids per-call Set construction', async () => {
    const hub = 'g//p//hub.ts//1-5//hub';
    const edges = [];
    // 12 callers of `hub` → in-degree 12, well above the floor of 5.
    for (let i = 0; i < 12; i++) {
      edges.push({
        from_chunk_id: `g//p//caller${i}.ts//1-5//c${i}`,
        to_chunk_id: hub,
        relation_type: 'calls' as const,
        symbol_name: `s${i}`,
        confidence: 'INFERRED' as const,
      });
    }
    // One cold callee that should NOT be in the hub set.
    edges.push({
      from_chunk_id: 'g//p//caller0.ts//1-5//c0',
      to_chunk_id: 'g//p//cold.ts//1-5//cold',
      relation_type: 'calls',
      symbol_name: 'rare',
      confidence: 'INFERRED',
    });
    await store.upsertSymbolEdges(edges);

    const snap = store.getGroupDegreeSnapshot('g');
    expect(snap.hubChunkIds.has(hub)).toBe(true);
    expect(snap.hubChunkIds.has('g//p//cold.ts//1-5//cold')).toBe(false);
    // Cached: second call returns the SAME Set reference (object identity).
    const snap2 = store.getGroupDegreeSnapshot('g');
    expect(snap2.hubChunkIds).toBe(snap.hubChunkIds);
  });

  it('returns empty for unknown chunk edges', () => {
    expect(store.getEdgesFrom('nonexistent')).toEqual([]);
    expect(store.getEdgesTo('nonexistent')).toEqual([]);
  });

  it('deleteEdgesForChunk removes edges in both directions', async () => {
    await store.upsertSymbolEdges([
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

  it('deleteChunk cascades to symbol edges', async () => {
    const chunkId = 'g//p//file.ts//1-10//h1';

    store.upsertCommits(chunkId, [
      {
        commit_hash: 'abc',
        committed_at: '2024-01-15T10:00:00Z',
        author_email: 'a@b.com',
        message_summary: 'test',
      },
    ]);
    await store.upsertSymbolEdges([
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

  it('deleteByProject cascades to symbol edges', async () => {
    await store.upsertSymbolEdges([
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

  it('deleteEdgesByProject removes only target project edges', async () => {
    await store.upsertSymbolEdges([
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

  it('deleteByFile removes commits, tickets, and edges for a specific file', async () => {
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
    await store.upsertSymbolEdges([
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

  it('upsertSymbolEdges handles empty array', async () => {
    await expect(store.upsertSymbolEdges([])).resolves.toBeUndefined();
  });
});

describe('MetadataStore git file cache', () => {
  let tmpDir: string;
  let store: MetadataStore;

  const commits = [
    {
      hash: 'abc123',
      date: '2024-01-15T10:00:00Z',
      email: 'dev@test.com',
      subject: 'fix: bug PROJ-1',
    },
  ];
  const hunks = [{ commitHash: 'abc123', startLine: 1, endLine: 5 }];

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new MetadataStore(path.join(tmpDir, 'test-metadata.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('roundtrips cached git data for a matching head', () => {
    store.setGitFileCache('g', 'p', 'src/a.ts', 'head1', commits, hunks);
    const cached = store.getGitFileCache('g', 'p', 'src/a.ts', 'head1');
    expect(cached).toEqual({ commits, hunks });
  });

  it('returns null when head does not match', () => {
    store.setGitFileCache('g', 'p', 'src/a.ts', 'head1', commits, hunks);
    expect(store.getGitFileCache('g', 'p', 'src/a.ts', 'head2')).toBeNull();
  });

  it('returns null for unknown file', () => {
    expect(store.getGitFileCache('g', 'p', 'src/missing.ts', 'head1')).toBeNull();
  });

  it('replaces the entry on a new head', () => {
    store.setGitFileCache('g', 'p', 'src/a.ts', 'head1', commits, hunks);
    store.setGitFileCache('g', 'p', 'src/a.ts', 'head2', [], []);
    expect(store.getGitFileCache('g', 'p', 'src/a.ts', 'head1')).toBeNull();
    expect(store.getGitFileCache('g', 'p', 'src/a.ts', 'head2')).toEqual({
      commits: [],
      hunks: [],
    });
  });

  it('deleteByProject clears the cache for that project only', () => {
    store.setGitFileCache('g', 'p', 'src/a.ts', 'head1', commits, hunks);
    store.setGitFileCache('g', 'other', 'src/a.ts', 'head1', commits, hunks);
    store.deleteByProject('g', 'p');
    expect(store.getGitFileCache('g', 'p', 'src/a.ts', 'head1')).toBeNull();
    expect(store.getGitFileCache('g', 'other', 'src/a.ts', 'head1')).not.toBeNull();
  });

  // Regression: the composite (grp, …) indexes must be created AFTER the grp
  // migration, not in the initial CREATE block. On a legacy DB the table
  // already exists without `grp`, so creating a (grp, …) index up front throws
  // `no such column: grp` and crashes startup.
  it('opens a legacy database (symbol_edges without grp) without crashing and migrates it', () => {
    const legacyPath = path.join(tmpDir, 'legacy-metadata.db');
    // Build a pre-`grp` schema by hand and seed an edge.
    const raw = new Database(legacyPath);
    raw.exec(
      'CREATE TABLE symbol_edges (' +
        'from_chunk_id TEXT NOT NULL, to_chunk_id TEXT NOT NULL, ' +
        'relation_type TEXT NOT NULL, symbol_name TEXT NOT NULL, ' +
        "confidence TEXT NOT NULL DEFAULT 'INFERRED', " +
        'PRIMARY KEY (from_chunk_id, to_chunk_id, symbol_name))'
    );
    raw
      .prepare(
        'INSERT INTO symbol_edges (from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence) VALUES (?, ?, ?, ?, ?)'
      )
      .run('leg//p//a.ts//1-5//h1', 'leg//p//b.ts//1-5//h2', 'calls', 'foo', 'INFERRED');
    raw.close();

    // Opening the store runs the migration; this must not throw.
    const legacyStore = new MetadataStore(legacyPath);
    try {
      // The grp column was added and the composite index created — verify via
      // schema, not via a surviving edge (the one-time cap purge wipes pre-cap
      // rows; see the dedicated purge test below).
      const cols = (legacyStore as unknown as { db: Database.Database }).db
        .prepare("PRAGMA table_info('symbol_edges')")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('grp');
      const indexes = (legacyStore as unknown as { db: Database.Database }).db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='symbol_edges'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain('idx_symbol_edges_grp_to');
    } finally {
      legacyStore.close();
    }
  });

  it('purges pre-cap symbol edges once on first open, then leaves the table alone', async () => {
    const legacyPath = path.join(tmpDir, 'pre-cap-metadata.db');
    // A pre-cap database: symbol_edges populated, user_version still 0.
    const raw = new Database(legacyPath);
    raw.exec(
      'CREATE TABLE symbol_edges (' +
        'from_chunk_id TEXT NOT NULL, to_chunk_id TEXT NOT NULL, ' +
        'relation_type TEXT NOT NULL, symbol_name TEXT NOT NULL, ' +
        "confidence TEXT NOT NULL DEFAULT 'INFERRED', grp TEXT NOT NULL DEFAULT '', " +
        'PRIMARY KEY (from_chunk_id, to_chunk_id, symbol_name))'
    );
    raw
      .prepare(
        'INSERT INTO symbol_edges (from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence, grp) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('g//p//a.ts//1-5//h1', 'g//p//b.ts//1-5//h2', 'calls', 'foo', 'INFERRED', 'g');
    raw.close();

    // First open purges the stale edge and bumps user_version to 1.
    const first = new MetadataStore(legacyPath);
    try {
      expect(first.getEdgesFrom('g//p//a.ts//1-5//h1')).toHaveLength(0);
      // Fresh edges written after the purge survive.
      await first.upsertSymbolEdges([
        {
          from_chunk_id: 'g//p//c.ts//1-5//h3',
          to_chunk_id: 'g//p//d.ts//1-5//h4',
          relation_type: 'calls',
          symbol_name: 'bar',
          confidence: 'INFERRED',
        },
      ]);
    } finally {
      first.close();
    }

    // Second open must NOT purge again (user_version already 1).
    const second = new MetadataStore(legacyPath);
    try {
      expect(second.getEdgesFrom('g//p//c.ts//1-5//h3')).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  // The server and indexer share this DB file and both write to it. A short
  // busy_timeout makes a contended write fail with "database is locked" instead
  // of waiting; guard against regressing the value back down.
  it('sets a generous busy_timeout so concurrent writers wait for the lock', () => {
    const timeout = (store as unknown as { db: Database.Database }).db.pragma('busy_timeout', {
      simple: true,
    });
    expect(timeout).toBeGreaterThanOrEqual(30000);
  });
});
