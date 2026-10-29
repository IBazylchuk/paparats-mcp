import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { ChunkCommit, ChunkTicket, GraphChanges, NameUsage, SymbolEdge } from './types.js';

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const DEFAULT_DB_PATH = path.join(PAPARATS_DIR, 'metadata.db');

/**
 * Symbol-edge inserts are chunked into transactions of this size. better-sqlite3
 * is synchronous, so a single transaction over a very large edge set blocks the
 * Node event loop for its whole duration — long enough on big repos to trip the
 * indexer's health probe. Committing in batches with a yield (`setImmediate`)
 * between them lets pending I/O (health checks, HTTP requests) run in the gaps.
 */
const EDGE_INSERT_BATCH_SIZE = 5000;

const EDGE_COLUMNS =
  'from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence, from_symbols, reach_symbols, reach_steps';

type EdgeRow = Omit<SymbolEdge, 'from_symbols' | 'reach_symbols' | 'reach_steps'> & {
  from_symbols: string;
  reach_symbols: string;
  reach_steps: string;
};

/**
 * `from_symbols` is stored as a JSON array, or '' when the whole chunk is the
 * caller; `reach_symbols` and `reach_steps` as JSON arrays, or '' when there
 * are none (steps also on edges built before they were recorded).
 */
function toEdge(row: EdgeRow): SymbolEdge {
  const { from_symbols, reach_symbols, reach_steps, ...edge } = row;
  return {
    ...edge,
    from_symbols: from_symbols ? (JSON.parse(from_symbols) as string[]) : [],
    ...(reach_symbols ? { reach_symbols: JSON.parse(reach_symbols) as string[] } : {}),
    ...(reach_steps ? { reach_steps: JSON.parse(reach_steps) as number[] } : {}),
  };
}

const jsonList = (names: string[] | undefined): string =>
  names && names.length > 0 ? JSON.stringify(names) : '';

/**
 * The chunk ids starting with `prefix` (which ends in `//`): they sort at or
 * after it and before it with its last '/' raised to '0'. A range uses the
 * id indexes, which a LIKE pattern does not.
 */
function idRange(prefix: string): [string, string] {
  return [prefix, `${prefix.slice(0, -1)}0`];
}

/** Escape SQLite LIKE wildcards (% and _) so they match literally */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

export interface GitCachedCommit {
  hash: string;
  date: string;
  email: string;
  subject: string;
}

export interface GitCachedHunk {
  commitHash: string;
  startLine: number;
  endLine: number;
}

export interface GitFileCacheData {
  commits: GitCachedCommit[];
  hunks: GitCachedHunk[];
}

export class MetadataStore {
  private db: Database.Database;
  private closed = false;

  // Prepared statements
  private insertCommitStmt: Database.Statement;
  private deleteCommitsStmt: Database.Statement;
  private getCommitsStmt: Database.Statement;
  private getLatestCommitStmt: Database.Statement;
  private insertTicketStmt: Database.Statement;
  private deleteTicketsStmt: Database.Statement;
  private getTicketsStmt: Database.Statement;
  private deleteChunkCommitsStmt: Database.Statement;
  private deleteChunkTicketsStmt: Database.Statement;
  private insertEdgeStmt: Database.Statement;
  private bumpEdgeVersionStmt: Database.Statement;
  private deleteEdgesFromStmt: Database.Statement;
  private deleteEdgesToStmt: Database.Statement;
  private getEdgesFromStmt: Database.Statement;
  private getEdgesToStmt: Database.Statement;
  private deleteChunkEdgesStmt: Database.Statement;
  private deleteProjectCommitsStmt: Database.Statement;
  private deleteProjectTicketsStmt: Database.Statement;
  private deleteEdgesFromRangeStmt: Database.Statement;
  private deleteEdgesToRangeStmt: Database.Statement;
  private deleteSymbolEdgesInRangeStmt: Database.Statement;
  private hasEdgesInRangeStmt: Database.Statement;
  private insertGraphChangeStmt: Database.Statement;
  private deleteGraphChangesStmt: Database.Statement;
  private getGitFileCacheStmt: Database.Statement;
  private setGitFileCacheStmt: Database.Statement;
  private deleteProjectGitCacheStmt: Database.Statement;

  constructor(dbPath?: string) {
    const p = dbPath ?? DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(p), { recursive: true });

    this.db = new Database(p);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    } catch {
      // WAL not supported, continue with default
    }
    // The server and indexer processes open this same file (shared volume) and
    // both write to it — the indexer during indexing, the server on-demand for
    // git history. WAL lets readers run during a write, but two writers still
    // serialise. With a short timeout a contended write (e.g. the startup
    // symbol_edges migration racing the indexer) fails immediately with
    // SQLite "database is locked". Wait for the lock instead of erroring —
    // 30s comfortably covers a full-table migration or a batch upsert.
    this.db.pragma('busy_timeout = 30000');

    // One-time purge of edges produced before the AMBIGUOUS fan-out cap. Pre-cap
    // indexes accumulated millions of quadratic high-fanout edges (e.g. every
    // caller of `Business` linked to all ~600 definitions) — tables that grew to
    // many gigabytes. Gated on user_version so it runs exactly once; the CREATE
    // TABLE IF NOT EXISTS below then recreates the table empty, and the indexer's
    // reindex epoch (see StateStore) rebuilds every project's edges with the cap.
    //
    // MUST use DROP TABLE, never DELETE. `DELETE FROM symbol_edges` logs every
    // row to the WAL/journal — on a multi-gigabyte table that inflates the WAL
    // past the table's own size (14 GB observed), never commits, and crashes
    // startup with SQLITE_BUSY. DROP TABLE deallocates pages in bulk instead.
    //
    // Best-effort, NOT a startup precondition: the server and indexer share this
    // file, so the DROP can still lose a lock race. On any failure we leave
    // user_version at 0 (retry next boot) and never let it crash startup.
    if ((this.db.pragma('user_version', { simple: true }) as number) < 1) {
      try {
        // Detect a non-empty table before dropping, purely so the log is honest
        // — an existing-but-empty table (e.g. a prior interrupted purge) should
        // not report that rows were dropped, so check for at least one row.
        const tableExists = this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'symbol_edges'")
          .get();
        const hadEdges = tableExists && this.db.prepare('SELECT 1 FROM symbol_edges LIMIT 1').get();
        this.db.exec('DROP TABLE IF EXISTS symbol_edges');
        this.db.pragma('user_version = 1');
        if (hadEdges) {
          console.log(
            '[metadata] dropped pre-cap symbol_edges table; it will be recreated empty and rebuilt on next reindex'
          );
        }
      } catch (err) {
        // Do NOT bump user_version — the purge is retried on the next open.
        console.warn(
          `[metadata] deferred pre-cap edge purge (will retry on next start): ${(err as Error).message}`
        );
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_commits (
        chunk_id TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        author_email TEXT NOT NULL,
        message_summary TEXT NOT NULL,
        PRIMARY KEY (chunk_id, commit_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_commits_chunk_id ON chunk_commits(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_chunk_commits_committed_at ON chunk_commits(committed_at);

      CREATE TABLE IF NOT EXISTS chunk_tickets (
        chunk_id TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (chunk_id, ticket_key)
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_tickets_chunk_id ON chunk_tickets(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_chunk_tickets_ticket_key ON chunk_tickets(ticket_key);

      CREATE TABLE IF NOT EXISTS symbol_edges (
        from_chunk_id TEXT NOT NULL,
        to_chunk_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'INFERRED',
        grp TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (from_chunk_id, to_chunk_id, symbol_name)
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_from ON symbol_edges(from_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_to ON symbol_edges(to_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_symbol ON symbol_edges(symbol_name);
      -- NOTE: the composite (grp, ...) indexes are created AFTER the grp-column
      -- migration below, not here. On a legacy database symbol_edges already
      -- exists without grp, so CREATE TABLE IF NOT EXISTS is a no-op and the
      -- column is only added by the migration — creating a (grp, ...) index here
      -- would throw "no such column: grp" and crash startup.

      CREATE TABLE IF NOT EXISTS git_file_cache (
        grp TEXT NOT NULL,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        head TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (grp, project, file_path)
      );
    `);

    // Migrate legacy databases pre-dating the confidence column. Older installs
    // have a `symbol_edges` table without it; tag existing rows as INFERRED
    // (the conservative legacy default) so find_usages keeps working until
    // the next reindex labels edges precisely.
    const cols = this.db.prepare("PRAGMA table_info('symbol_edges')").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'confidence')) {
      this.db.exec(
        "ALTER TABLE symbol_edges ADD COLUMN confidence TEXT NOT NULL DEFAULT 'INFERRED'"
      );
    }

    // Migrate legacy databases pre-dating the `grp` column. It denormalises the
    // group (first `//`-delimited segment of a chunk_id) so degree stats can be
    // aggregated with an indexed `WHERE grp = ?` instead of a full-table
    // `LIKE 'group//%'` scan. Backfill from existing rows; the composite
    // indexes above are created regardless, and new/reindexed edges populate
    // the column directly via upsertSymbolEdges.
    if (!cols.some((c) => c.name === 'grp')) {
      this.db.exec("ALTER TABLE symbol_edges ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
      // substr up to the first '//' — SQLite instr() returns 1-based position.
      this.db.exec(
        'UPDATE symbol_edges SET grp = CASE ' +
          "WHEN instr(from_chunk_id, '//') > 0 " +
          "THEN substr(from_chunk_id, 1, instr(from_chunk_id, '//') - 1) " +
          'ELSE from_chunk_id END ' +
          "WHERE grp = ''"
      );
    }

    // Migrate databases pre-dating `from_symbols`: rows keep '' (the whole chunk
    // is the caller) until the next reindex records the calling methods.
    if (!cols.some((c) => c.name === 'from_symbols')) {
      this.db.exec("ALTER TABLE symbol_edges ADD COLUMN from_symbols TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.some((c) => c.name === 'reach_symbols')) {
      this.db.exec("ALTER TABLE symbol_edges ADD COLUMN reach_symbols TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.some((c) => c.name === 'reach_steps')) {
      this.db.exec("ALTER TABLE symbol_edges ADD COLUMN reach_steps TEXT NOT NULL DEFAULT ''");
    }

    // Edge versions live in the file, not in memory: the indexer is another
    // process writing to it, and the server's derived maps must see its writes.
    const hadVersions = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edge_versions'")
      .get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edge_versions (
        grp TEXT NOT NULL,
        project TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (grp, project)
      )
    `);
    if (!hadVersions) {
      // Projects that already have edges must be listed, or a group's map
      // would be empty until each of them is indexed again.
      this.db.exec(
        'INSERT OR IGNORE INTO edge_versions (grp, project, version) ' +
          "SELECT grp, substr(rest, 1, instr(rest, '//') - 1), 1 FROM (" +
          'SELECT DISTINCT grp, substr(from_chunk_id, length(grp) + 3) AS rest FROM symbol_edges' +
          ") WHERE instr(rest, '//') > 1"
      );
    }

    // Files written or removed since their project's graph was last updated.
    // In the file, not in memory, so a change is not lost when the process
    // stops before the graph catches up, and either process can apply it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        grp TEXT NOT NULL,
        project TEXT NOT NULL,
        file TEXT NOT NULL,
        names TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_changes_project ON graph_changes(grp, project, id);
    `);

    // Per file, the names its code uses that may be common (single lowercase
    // words): how common a name is counts every file using it, also where the
    // graph links the use nowhere (`Map#get`, `ActiveRecord`'s `connection`).
    // Per project, its test files by path, also those the index leaves out
    // (Ruby specs): `change_impact` names the ones named after a change.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS test_files (
        grp TEXT NOT NULL,
        project TEXT NOT NULL,
        files TEXT NOT NULL,
        PRIMARY KEY (grp, project)
      );
    `);

    // Per project, the rules its edges were built with (`GRAPH_FORMAT` in
    // symbol-graph.ts): an older format has the whole graph built again.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_formats (
        grp TEXT NOT NULL,
        project TEXT NOT NULL,
        format INTEGER NOT NULL,
        PRIMARY KEY (grp, project)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_names (
        grp TEXT NOT NULL,
        project TEXT NOT NULL,
        file TEXT NOT NULL,
        names TEXT NOT NULL,
        PRIMARY KEY (grp, project, file)
      );
    `);

    // Composite (grp, …) indexes for degree aggregation. Created here — after
    // the migration guarantees the `grp` column exists on both fresh and legacy
    // databases — so degree stats aggregate via an index range scan instead of
    // a full-table LIKE scan.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_symbol_edges_grp_to ON symbol_edges(grp, to_chunk_id)'
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_symbol_edges_grp_from ON symbol_edges(grp, from_chunk_id)'
    );

    this.insertCommitStmt = this.db.prepare(
      'INSERT OR REPLACE INTO chunk_commits (chunk_id, commit_hash, committed_at, author_email, message_summary) VALUES (?, ?, ?, ?, ?)'
    );
    this.deleteCommitsStmt = this.db.prepare('DELETE FROM chunk_commits WHERE chunk_id = ?');
    this.getCommitsStmt = this.db.prepare(
      'SELECT chunk_id, commit_hash, committed_at, author_email, message_summary FROM chunk_commits WHERE chunk_id = ? ORDER BY committed_at DESC LIMIT ?'
    );
    this.getLatestCommitStmt = this.db.prepare(
      'SELECT commit_hash, committed_at, author_email FROM chunk_commits WHERE chunk_id = ? ORDER BY committed_at DESC LIMIT 1'
    );

    this.insertTicketStmt = this.db.prepare(
      'INSERT OR REPLACE INTO chunk_tickets (chunk_id, ticket_key, source) VALUES (?, ?, ?)'
    );
    this.deleteTicketsStmt = this.db.prepare('DELETE FROM chunk_tickets WHERE chunk_id = ?');
    this.getTicketsStmt = this.db.prepare(
      'SELECT chunk_id, ticket_key, source FROM chunk_tickets WHERE chunk_id = ?'
    );

    this.deleteChunkCommitsStmt = this.db.prepare('DELETE FROM chunk_commits WHERE chunk_id = ?');
    this.deleteChunkTicketsStmt = this.db.prepare('DELETE FROM chunk_tickets WHERE chunk_id = ?');

    this.insertEdgeStmt = this.db.prepare(
      'INSERT OR REPLACE INTO symbol_edges (from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence, grp, from_symbols, reach_symbols, reach_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.bumpEdgeVersionStmt = this.db.prepare(
      'INSERT INTO edge_versions (grp, project, version) VALUES (?, ?, 1) ON CONFLICT (grp, project) DO UPDATE SET version = version + 1'
    );
    this.deleteEdgesFromStmt = this.db.prepare('DELETE FROM symbol_edges WHERE from_chunk_id = ?');
    this.deleteEdgesToStmt = this.db.prepare('DELETE FROM symbol_edges WHERE to_chunk_id = ?');
    this.getEdgesFromStmt = this.db.prepare(
      'SELECT ' + EDGE_COLUMNS + ' FROM symbol_edges WHERE from_chunk_id = ?'
    );
    this.getEdgesToStmt = this.db.prepare(
      'SELECT ' + EDGE_COLUMNS + ' FROM symbol_edges WHERE to_chunk_id = ?'
    );
    this.deleteChunkEdgesStmt = this.db.prepare(
      'DELETE FROM symbol_edges WHERE from_chunk_id = ? OR to_chunk_id = ?'
    );
    this.deleteProjectCommitsStmt = this.db.prepare(
      "DELETE FROM chunk_commits WHERE chunk_id LIKE ? ESCAPE '\\'"
    );
    this.deleteProjectTicketsStmt = this.db.prepare(
      "DELETE FROM chunk_tickets WHERE chunk_id LIKE ? ESCAPE '\\'"
    );
    this.deleteEdgesFromRangeStmt = this.db.prepare(
      'DELETE FROM symbol_edges WHERE from_chunk_id >= ? AND from_chunk_id < ?'
    );
    this.deleteEdgesToRangeStmt = this.db.prepare(
      'DELETE FROM symbol_edges WHERE to_chunk_id >= ? AND to_chunk_id < ?'
    );
    this.deleteSymbolEdgesInRangeStmt = this.db.prepare(
      'DELETE FROM symbol_edges WHERE symbol_name = ? AND from_chunk_id >= ? AND from_chunk_id < ?'
    );
    this.hasEdgesInRangeStmt = this.db.prepare(
      'SELECT 1 FROM symbol_edges WHERE from_chunk_id >= ? AND from_chunk_id < ? LIMIT 1'
    );
    this.insertGraphChangeStmt = this.db.prepare(
      'INSERT INTO graph_changes (grp, project, file, names) VALUES (?, ?, ?, ?)'
    );
    this.deleteGraphChangesStmt = this.db.prepare(
      'DELETE FROM graph_changes WHERE grp = ? AND project = ? AND id <= ?'
    );

    this.getGitFileCacheStmt = this.db.prepare(
      'SELECT data FROM git_file_cache WHERE grp = ? AND project = ? AND file_path = ? AND head = ?'
    );
    this.setGitFileCacheStmt = this.db.prepare(
      'INSERT OR REPLACE INTO git_file_cache (grp, project, file_path, head, data) VALUES (?, ?, ?, ?, ?)'
    );
    this.deleteProjectGitCacheStmt = this.db.prepare(
      'DELETE FROM git_file_cache WHERE grp = ? AND project = ?'
    );
  }

  upsertCommits(chunkId: string, commits: Omit<ChunkCommit, 'chunk_id'>[]): void {
    const tx = this.db.transaction(() => {
      this.deleteCommitsStmt.run(chunkId);
      for (const c of commits) {
        this.insertCommitStmt.run(
          chunkId,
          c.commit_hash,
          c.committed_at,
          c.author_email,
          c.message_summary
        );
      }
    });
    tx();
  }

  upsertTickets(chunkId: string, tickets: Omit<ChunkTicket, 'chunk_id'>[]): void {
    const tx = this.db.transaction(() => {
      this.deleteTicketsStmt.run(chunkId);
      for (const t of tickets) {
        this.insertTicketStmt.run(chunkId, t.ticket_key, t.source);
      }
    });
    tx();
  }

  getCommits(chunkId: string, limit = 10): ChunkCommit[] {
    return this.getCommitsStmt.all(chunkId, limit) as ChunkCommit[];
  }

  getTickets(chunkId: string): ChunkTicket[] {
    return this.getTicketsStmt.all(chunkId) as ChunkTicket[];
  }

  getLatestCommit(
    chunkId: string
  ): { commit_hash: string; committed_at: string; author_email: string } | null {
    const row = this.getLatestCommitStmt.get(chunkId) as
      { commit_hash: string; committed_at: string; author_email: string } | undefined;
    return row ?? null;
  }

  deleteChunk(chunkId: string): void {
    const tx = this.db.transaction(() => {
      this.deleteChunkCommitsStmt.run(chunkId);
      this.deleteChunkTicketsStmt.run(chunkId);
      this.deleteChunkEdgesStmt.run(chunkId, chunkId);
    });
    tx();
    const [group, project] = chunkId.split('//');
    if (group && project !== undefined) this.bumpEdgeVersion(group, project);
  }

  deleteByProject(group: string, project: string): void {
    const prefix = `${escapeLike(group)}//${escapeLike(project)}//`;
    const pattern = `${prefix}%`;
    const tx = this.db.transaction(() => {
      this.deleteProjectCommitsStmt.run(pattern);
      this.deleteProjectTicketsStmt.run(pattern);
      this.deleteEdgesUnder(`${group}//${project}//`);
      this.deleteGraphChangesStmt.run(group, project, Number.MAX_SAFE_INTEGER);
      this.deleteProjectGitCacheStmt.run(group, project);
      this.db.prepare('DELETE FROM file_names WHERE grp = ? AND project = ?').run(group, project);
      this.db.prepare('DELETE FROM test_files WHERE grp = ? AND project = ?').run(group, project);
      this.db
        .prepare('DELETE FROM graph_formats WHERE grp = ? AND project = ?')
        .run(group, project);
    });
    tx();
    // The in-degree cache would otherwise keep ranking the deleted chunks.
    this.invalidateDegreeCache(group);
    this.bumpEdgeVersion(group, project);
  }

  // ── Git file cache (parsed `git log` output keyed by repo HEAD) ──────────

  getGitFileCache(
    group: string,
    project: string,
    file: string,
    head: string
  ): GitFileCacheData | null {
    const row = this.getGitFileCacheStmt.get(group, project, file, head) as
      { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as GitFileCacheData;
    } catch {
      return null;
    }
  }

  setGitFileCache(
    group: string,
    project: string,
    file: string,
    head: string,
    commits: GitCachedCommit[],
    hunks: GitCachedHunk[]
  ): void {
    this.setGitFileCacheStmt.run(group, project, file, head, JSON.stringify({ commits, hunks }));
  }

  // ── Symbol edge methods ─────────────────────────────────────────────────

  private insertEdge(e: SymbolEdge): void {
    // Denormalise the group (first `//` segment of the source chunk_id) so
    // degree stats aggregate on an indexed column, not a LIKE scan.
    const grp = e.from_chunk_id.split('//')[0] ?? '';
    this.insertEdgeStmt.run(
      e.from_chunk_id,
      e.to_chunk_id,
      e.relation_type,
      e.symbol_name,
      e.confidence ?? 'INFERRED',
      grp,
      jsonList(e.from_symbols),
      jsonList(e.reach_symbols),
      e.reach_steps && e.reach_steps.length > 0 ? JSON.stringify(e.reach_steps) : ''
    );
  }

  async upsertSymbolEdges(edges: SymbolEdge[]): Promise<void> {
    const insertBatch = this.db.transaction((batch: SymbolEdge[]) => {
      for (const e of batch) this.insertEdge(e);
    });
    // Commit in bounded transactions, yielding between them so the synchronous
    // SQLite work never monopolises the event loop for the whole edge set.
    for (let i = 0; i < edges.length; i += EDGE_INSERT_BATCH_SIZE) {
      insertBatch(edges.slice(i, i + EDGE_INSERT_BATCH_SIZE));
      if (i + EDGE_INSERT_BATCH_SIZE < edges.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    // Edges changed → mark the degree cache stale for affected groups only. The
    // group is the first `//`-delimited segment of a chunk_id; touching one
    // project must not invalidate cached stats for unrelated groups.
    const affected = new Map<string, Set<string>>();
    for (const e of edges) {
      for (const id of [e.from_chunk_id, e.to_chunk_id]) {
        const [g, project] = id.split('//');
        if (!g) continue;
        let projects = affected.get(g);
        if (!projects) affected.set(g, (projects = new Set()));
        if (project !== undefined) projects.add(project);
      }
    }
    for (const [g, projects] of affected) {
      this.invalidateDegreeCache(g);
      for (const project of projects) this.bumpEdgeVersion(g, project);
    }
  }

  getEdgesFrom(chunkId: string): SymbolEdge[] {
    return this.getEdgesFromStmt.all(chunkId).map((row) => toEdge(row as EdgeRow));
  }

  getEdgesTo(chunkId: string): SymbolEdge[] {
    return this.getEdgesToStmt.all(chunkId).map((row) => toEdge(row as EdgeRow));
  }

  deleteEdgesForChunk(chunkId: string): void {
    this.deleteChunkEdgesStmt.run(chunkId, chunkId);
    const [group, project] = chunkId.split('//');
    if (group && project !== undefined) this.bumpEdgeVersion(group, project);
  }

  // ── Graph changes (files the symbol graph has not caught up with) ───────

  /**
   * Record that a file's chunks were written or removed, with the names its old
   * and new chunks define: until {@link applyGraphChanges} the graph is behind
   * for the edges leaving the file and for every use of those names.
   */
  markGraphChanged(group: string, project: string, file: string, names: Iterable<string>): void {
    this.insertGraphChangeStmt.run(group, project, file, JSON.stringify([...new Set(names)]));
  }

  /** The project's changes not yet applied to its graph, or null when there are none. */
  graphChanges(group: string, project: string): GraphChanges | null {
    const rows = this.db
      .prepare(
        'SELECT id, file, names FROM graph_changes WHERE grp = ? AND project = ? ORDER BY id'
      )
      .all(group, project) as Array<{ id: number; file: string; names: string }>;
    if (rows.length === 0) return null;
    const changes: GraphChanges = { upTo: 0, files: new Set(), names: new Set() };
    for (const row of rows) {
      changes.upTo = row.id;
      changes.files.add(row.file);
      for (const name of JSON.parse(row.names) as string[]) changes.names.add(name);
    }
    return changes;
  }

  /** Drop the project's changes up to `upTo` (all of them without it). */
  clearGraphChanges(group: string, project: string, upTo = Number.MAX_SAFE_INTEGER): void {
    this.deleteGraphChangesStmt.run(group, project, upTo);
  }

  /**
   * Bring the graph up to date with `changes` in one transaction: drop the edges
   * they touch — leaving or entering a changed file, or through a changed name
   * — write `edges` (those same edges as they are now) and drop the changes. A
   * reader sees the old edges or the new ones, never a graph half rebuilt.
   */
  applyGraphChanges(
    group: string,
    project: string,
    changes: GraphChanges,
    edges: SymbolEdge[]
  ): void {
    const projectRange = idRange(`${group}//${project}//`);
    this.db.transaction(() => {
      for (const file of changes.files) this.deleteEdgesUnder(`${group}//${project}//${file}//`);
      for (const name of changes.names)
        this.deleteSymbolEdgesInRangeStmt.run(name, ...projectRange);
      for (const e of edges) this.insertEdge(e);
      this.deleteGraphChangesStmt.run(group, project, changes.upTo);
    })();
    this.invalidateDegreeCache(group);
    this.bumpEdgeVersion(group, project);
  }

  /** Delete all metadata (commits, tickets, edges) for a specific file within a project */
  deleteByFile(group: string, project: string, file: string): void {
    const prefix = `${escapeLike(group)}//${escapeLike(project)}//${escapeLike(file)}//`;
    const pattern = `${prefix}%`;
    const tx = this.db.transaction(() => {
      this.deleteProjectCommitsStmt.run(pattern);
      this.deleteProjectTicketsStmt.run(pattern);
      this.deleteEdgesUnder(`${group}//${project}//${file}//`);
      this.db
        .prepare('DELETE FROM file_names WHERE grp = ? AND project = ? AND file = ?')
        .run(group, project, file);
    });
    tx();
    this.invalidateDegreeCache(group);
    this.bumpEdgeVersion(group, project);
  }

  /** Record a project's test files (see `test_files`), replacing those recorded before. */
  setTestFiles(group: string, project: string, files: string[]): void {
    this.db
      .prepare('INSERT OR REPLACE INTO test_files (grp, project, files) VALUES (?, ?, ?)')
      .run(group, project, JSON.stringify(files));
  }

  /** A project's test files; null when none were recorded (its directory was never read). */
  getTestFiles(group: string, project: string): string[] | null {
    const row = this.db
      .prepare('SELECT files FROM test_files WHERE grp = ? AND project = ?')
      .get(group, project) as { files: string } | undefined;
    return row ? (JSON.parse(row.files) as string[]) : null;
  }

  /** The format a project's graph was last built in (see `graph_formats`); null when never recorded. */
  getGraphFormat(group: string, project: string): number | null {
    const row = this.db
      .prepare('SELECT format FROM graph_formats WHERE grp = ? AND project = ?')
      .get(group, project) as { format: number } | undefined;
    return row ? row.format : null;
  }

  setGraphFormat(group: string, project: string, format: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO graph_formats (grp, project, format) VALUES (?, ?, ?)')
      .run(group, project, format);
  }

  /** Record the names a file's code uses that may be common (see `file_names`). */
  setFileNames(group: string, project: string, file: string, names: Iterable<string>): void {
    this.db
      .prepare('INSERT OR REPLACE INTO file_names (grp, project, file, names) VALUES (?, ?, ?, ?)')
      .run(group, project, file, JSON.stringify([...new Set(names)].sort()));
    const usage = this.nameUsageCache.get(group);
    if (usage) usage.stale = true;
  }

  /** Every edge leaving any chunk of one file. */
  getEdgesFromFile(group: string, project: string, file: string): SymbolEdge[] {
    const pattern = `${escapeLike(group)}//${escapeLike(project)}//${escapeLike(file)}//%`;
    return this.db
      .prepare(
        'SELECT ' +
          EDGE_COLUMNS +
          " FROM symbol_edges WHERE grp = ? AND from_chunk_id LIKE ? ESCAPE '\\'"
      )
      .all(group, pattern)
      .map((row) => toEdge(row as EdgeRow));
  }

  /** Whether any symbol edge originates in this project. */
  hasEdgesForProject(group: string, project: string): boolean {
    return this.hasEdgesInRangeStmt.get(...idRange(`${group}//${project}//`)) !== undefined;
  }

  /** Edges leaving or entering chunks whose ids start with `prefix`. */
  private deleteEdgesUnder(prefix: string): void {
    const range = idRange(prefix);
    this.deleteEdgesFromRangeStmt.run(...range);
    this.deleteEdgesToRangeStmt.run(...range);
  }

  deleteEdgesByProject(group: string, project: string): void {
    this.deleteEdgesUnder(`${group}//${project}//`);
    // Edges changed → drop the group's degree cache (per-group scope, since
    // hub thresholds are computed across the whole group, not per-project).
    this.invalidateDegreeCache(group);
    this.bumpEdgeVersion(group, project);
  }

  // ── Degree analytics (for hub-threshold filtering + arch suggestions) ─────

  /**
   * Per-group degree stats. Recomputing scans the whole subgraph, so we
   * memoise behind a 5-minute TTL and invalidate when the caller writes or
   * deletes edges in the same group. graphify uses an analogous trick:
   * compute p99 once per BFS and reuse it. Our threshold is p95 to be a touch
   * more aggressive — find_usages is a 1-hop tool, not a full traversal.
   */
  private degreeCache = new Map<
    string,
    {
      computedAt: number;
      inDegreeP95: number;
      outDegreeP95: number;
      topInDegree: Array<{ chunkId: string; degree: number }>;
      topOutDegree: Array<{ chunkId: string; degree: number }>;
      /**
       * Pre-computed set of chunks whose in- OR out-degree exceeds the
       * group p95. Built once when the snapshot is computed and reused for
       * every `find_usages` call until invalidation, so we don't allocate
       * fresh Sets per tool invocation.
       */
      hubChunkIds: Set<string>;
      /** The hubs by in-degree only: called from many places (see `change_impact`). */
      calledHubChunkIds: Set<string>;
      /**
       * Marked true when edges are written/deleted for the group. A stale
       * snapshot is still served immediately (stale-while-revalidate) while a
       * fresh one is recomputed in the background — a read must never block on
       * the full-graph scan, which is what caused `find_usages` to hang while
       * indexing kept invalidating the cache.
       */
      stale: boolean;
    }
  >();
  private static readonly DEGREE_CACHE_TTL_MS = 5 * 60 * 1000;
  /** Groups with an in-flight background degree recompute — dedupes concurrent refreshes. */
  private degreeRefreshInFlight = new Set<string>();

  /**
   * Invalidate the degree cache. During indexing this is called on every edge
   * write, so it must be cheap and must NOT drop the snapshot — otherwise the
   * next `find_usages` blocks on a full-graph rescan. Instead we mark the
   * entry stale; the next read serves it immediately and refreshes in the
   * background. Passing no group clears everything (used by tests / shutdown).
   */
  invalidateDegreeCache(group?: string): void {
    if (group === undefined) {
      this.degreeCache.clear();
      this.nameUsageCache.clear();
      this.edgeEpoch++;
      return;
    }
    const entry = this.degreeCache.get(group);
    if (entry) entry.stale = true;
    const names = this.nameUsageCache.get(group);
    if (names) names.stale = true;
  }

  private edgeEpoch = 0;

  private bumpEdgeVersion(group: string, project: string): void {
    this.bumpEdgeVersionStmt.run(group, project);
  }

  /**
   * Changes on every edge write or delete in a project (or, without `project`,
   * in any project of the group), by this process or another one sharing the
   * file, so maps derived from the edges know they are behind.
   */
  edgesVersion(group: string, project?: string): string {
    const row =
      project === undefined
        ? this.db.prepare('SELECT SUM(version) AS v FROM edge_versions WHERE grp = ?').get(group)
        : this.db
            .prepare('SELECT version AS v FROM edge_versions WHERE grp = ? AND project = ?')
            .get(group, project);
    return `${this.edgeEpoch}:${(row as { v: number | null } | undefined)?.v ?? 0}`;
  }

  /** Projects of a group that have had edges written or deleted. */
  edgeProjects(group: string): string[] {
    return (
      this.db.prepare('SELECT project FROM edge_versions WHERE grp = ?').all(group) as Array<{
        project: string;
      }>
    ).map((r) => r.project);
  }

  /** Every edge leaving a project's chunks, streamed. */
  iterateProjectEdges(group: string, project: string): Iterable<SymbolEdge> {
    // A range on the from_chunk_id index: ids starting with `g//p//` sort at or
    // after it and before `g//p/0` ('0' follows '/').
    const prefix = `${group}//${project}//`;
    return this.db
      .prepare(
        'SELECT from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence FROM symbol_edges WHERE from_chunk_id >= ? AND from_chunk_id < ?'
      )
      .iterate(prefix, `${prefix.slice(0, -1)}0`) as Iterable<SymbolEdge>;
  }

  // ── Name usage (how common a linked name is) ─────────────────────────────

  /**
   * Per-group name usage, cached and refreshed exactly like the degree stats
   * (stale-while-revalidate, invalidated with them): one full scan of the
   * group's edges, too slow to repeat per tool call on a large group.
   */
  private nameUsageCache = new Map<
    string,
    { usage: NameUsage; computedAt: number; stale: boolean }
  >();
  private nameUsageRefreshInFlight = new Set<string>();

  private computeNameUsage(group: string): NameUsage {
    const users = new Map<string, Set<string>>();
    const callers = new Set<string>();
    const use = (name: string, file: string) => {
      let set = users.get(name);
      if (!set) users.set(name, (set = new Set()));
      set.add(file);
    };
    // Projects whose files recorded their names count those; others (indexed
    // before `file_names`) count the files their edges link from.
    const recorded = new Set<string>();
    const named = this.db
      .prepare('SELECT project, file, names FROM file_names WHERE grp = ?')
      .iterate(group) as Iterable<{ project: string; file: string; names: string }>;
    for (const row of named) {
      recorded.add(row.project);
      const file = `${group}//${row.project}//${row.file}`;
      for (const name of JSON.parse(row.names) as string[]) use(name, file);
    }
    const rows = this.db
      .prepare('SELECT from_chunk_id, symbol_name FROM symbol_edges WHERE grp = ?')
      .iterate(group) as Iterable<{ from_chunk_id: string; symbol_name: string }>;
    for (const row of rows) {
      const file = chunkFileKey(row.from_chunk_id);
      callers.add(file);
      if (!recorded.has(row.from_chunk_id.split('//')[1] ?? '')) use(row.symbol_name, file);
    }
    const filesUsing = new Map<string, number>();
    for (const [name, set] of users) filesUsing.set(name, set.size);
    return { callerFiles: callers.size, filesUsing };
  }

  /**
   * For every name the group's edges link through: how many files use it, and
   * how many files use any linked name at all. A name used from most files
   * (`get`, `add`, `close`) is mostly calls on other objects that happen to
   * share it, since edges are matched by name — see `isCommonName`.
   */
  getNameUsage(group: string): NameUsage {
    const cached = this.nameUsageCache.get(group);
    if (cached) {
      const expired = Date.now() - cached.computedAt >= MetadataStore.DEGREE_CACHE_TTL_MS;
      if ((cached.stale || expired) && !this.nameUsageRefreshInFlight.has(group)) {
        this.nameUsageRefreshInFlight.add(group);
        setImmediate(() => {
          try {
            this.nameUsageCache.set(group, {
              usage: this.computeNameUsage(group),
              computedAt: Date.now(),
              stale: false,
            });
          } catch {
            // Keep serving the previous entry; a later read retries.
          } finally {
            this.nameUsageRefreshInFlight.delete(group);
          }
        });
      }
      return cached.usage;
    }
    const usage = this.computeNameUsage(group);
    this.nameUsageCache.set(group, { usage, computedAt: Date.now(), stale: false });
    return usage;
  }

  private computeGroupDegreeStats(group: string): {
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
  } {
    // Aggregate on the indexed `grp` column instead of a `LIKE 'group//%'`
    // scan — the composite indexes (grp, to/from_chunk_id) turn each of these
    // into an index range scan + grouping rather than a full-table scan.
    const inRows = this.db
      .prepare(
        'SELECT to_chunk_id AS chunkId, COUNT(*) AS degree FROM symbol_edges WHERE grp = ? GROUP BY to_chunk_id ORDER BY degree DESC'
      )
      .all(group) as Array<{ chunkId: string; degree: number }>;
    const outRows = this.db
      .prepare(
        'SELECT from_chunk_id AS chunkId, COUNT(*) AS degree FROM symbol_edges WHERE grp = ? GROUP BY from_chunk_id ORDER BY degree DESC'
      )
      .all(group) as Array<{ chunkId: string; degree: number }>;
    return {
      inDegreeP95: percentile(
        inRows.map((r) => r.degree),
        0.95
      ),
      outDegreeP95: percentile(
        outRows.map((r) => r.degree),
        0.95
      ),
      topInDegree: inRows,
      topOutDegree: outRows,
    };
  }

  /** Build a cache entry from raw stats. Extracted so both the synchronous
   * first-computation path and the background refresh share hub-set logic. */
  private buildDegreeEntry(stats: {
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
  }): {
    computedAt: number;
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
    hubChunkIds: Set<string>;
    calledHubChunkIds: Set<string>;
    stale: boolean;
  } {
    // Threshold is `>= max(5, p95)`. Using `>` would never match anything
    // when p95 sits on the top-degree node itself (which happens often in
    // small graphs); `>=` reads as "in the top-percentile band". Floor at 5
    // so a tiny graph doesn't classify every node as a hub.
    const inFloor = Math.max(5, stats.inDegreeP95);
    const outFloor = Math.max(5, stats.outDegreeP95);
    const hubChunkIds = new Set<string>();
    for (const r of stats.topInDegree) {
      if (r.degree >= inFloor) hubChunkIds.add(r.chunkId);
    }
    const calledHubChunkIds = new Set(hubChunkIds);
    for (const r of stats.topOutDegree) {
      if (r.degree >= outFloor) hubChunkIds.add(r.chunkId);
    }
    return { ...stats, hubChunkIds, calledHubChunkIds, computedAt: Date.now(), stale: false };
  }

  /** Recompute degree stats off the request path and store them. Deduped per
   * group so concurrent reads don't kick off redundant full-graph scans. */
  private scheduleDegreeRefresh(group: string): void {
    if (this.degreeRefreshInFlight.has(group)) return;
    this.degreeRefreshInFlight.add(group);
    setImmediate(() => {
      try {
        const stats = this.computeGroupDegreeStats(group);
        this.degreeCache.set(group, this.buildDegreeEntry(stats));
      } catch {
        // Leave the previous (stale) entry in place; a later read retries.
      } finally {
        this.degreeRefreshInFlight.delete(group);
      }
    });
  }

  private getGroupDegreeStats(group: string): {
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
    hubChunkIds: Set<string>;
    calledHubChunkIds: Set<string>;
  } {
    const cached = this.degreeCache.get(group);
    if (cached) {
      const expired = Date.now() - cached.computedAt >= MetadataStore.DEGREE_CACHE_TTL_MS;
      // Stale-while-revalidate: never block a read on the full-graph scan.
      // Serve the existing snapshot immediately and refresh in the background
      // if it's been invalidated by an edge write or has aged out.
      if (cached.stale || expired) this.scheduleDegreeRefresh(group);
      return cached;
    }
    // Cold start: no snapshot exists yet. Compute once synchronously so the
    // first caller gets real data (there's nothing to serve otherwise).
    const stats = this.computeGroupDegreeStats(group);
    const entry = this.buildDegreeEntry(stats);
    this.degreeCache.set(group, entry);
    return entry;
  }

  /**
   * Snapshot of per-group degree stats. Returns the top-degree lists, p95
   * thresholds (floored at 5), and a pre-built `hubChunkIds` Set so callers
   * (e.g. find_usages) can decide hub membership in O(1) without rebuilding
   * sets on every tool invocation.
   */
  getGroupDegreeSnapshot(group: string): {
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
    hubChunkIds: Set<string>;
    calledHubChunkIds: Set<string>;
  } {
    const stats = this.getGroupDegreeStats(group);
    return {
      inDegreeP95: Math.max(5, stats.inDegreeP95),
      outDegreeP95: Math.max(5, stats.outDegreeP95),
      topInDegree: stats.topInDegree,
      topOutDegree: stats.topOutDegree,
      hubChunkIds: stats.hubChunkIds,
      calledHubChunkIds: stats.calledHubChunkIds,
    };
  }

  /**
   * p95 in-degree across all chunks in `group`, floored at 5 so a tiny graph
   * doesn't flag every node as a hub. `find_usages` uses this to mark or
   * suppress callers whose own in-degree is above the threshold.
   */
  getInDegreeP95(group: string): number {
    return Math.max(5, this.getGroupDegreeStats(group).inDegreeP95);
  }

  getOutDegreeP95(group: string): number {
    return Math.max(5, this.getGroupDegreeStats(group).outDegreeP95);
  }

  /** Top-N chunks by in-degree across `group`. Optional `project` post-filter. */
  getTopByInDegree(
    group: string,
    limit: number,
    project?: string
  ): Array<{ chunkId: string; degree: number }> {
    const all = this.getGroupDegreeStats(group).topInDegree;
    if (project === undefined) return all.slice(0, limit);
    const wanted = `${group}//${project}//`;
    return all.filter((r) => r.chunkId.startsWith(wanted)).slice(0, limit);
  }

  /** In-degree for one specific chunk in `group`. */
  getInDegree(group: string, chunkId: string): number {
    const entry = this.getGroupDegreeStats(group).topInDegree.find((r) => r.chunkId === chunkId);
    return entry?.degree ?? 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Nearest-rank percentile on an array that is already sorted descending.
 * The SQL queries in `computeGroupDegreeStats` emit `ORDER BY degree DESC`,
 * so we skip the O(N log N) re-sort and index directly. The mapping from
 * the prior ascending implementation (`asc[floor(p*len)]`) to the
 * descending one is `desc[len - 1 - floor(p*len)]` — preserves identical
 * output for every length, including the boundary cases where p*len is an
 * integer. Returns 0 for empty input.
 */
/** `<group>//<project>//<file>` of a chunk id. */
function chunkFileKey(chunkId: string): string {
  const parts = chunkId.split('//');
  return parts.slice(0, 3).join('//');
}

function percentile(sortedDesc: number[], p: number): number {
  const len = sortedDesc.length;
  if (len === 0) return 0;
  const ascIdx = Math.min(len - 1, Math.floor(p * len));
  return sortedDesc[len - 1 - ascIdx] ?? 0;
}
