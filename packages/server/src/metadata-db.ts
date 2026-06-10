import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { ChunkCommit, ChunkTicket, SymbolEdge } from './types.js';

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const DEFAULT_DB_PATH = path.join(PAPARATS_DIR, 'metadata.db');

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
  private deleteEdgesFromStmt: Database.Statement;
  private deleteEdgesToStmt: Database.Statement;
  private getEdgesFromStmt: Database.Statement;
  private getEdgesToStmt: Database.Statement;
  private deleteChunkEdgesStmt: Database.Statement;
  private deleteProjectCommitsStmt: Database.Statement;
  private deleteProjectTicketsStmt: Database.Statement;
  private deleteProjectEdgesStmt: Database.Statement;
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
    this.db.pragma('busy_timeout = 5000');

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
        PRIMARY KEY (from_chunk_id, to_chunk_id, symbol_name)
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_from ON symbol_edges(from_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_to ON symbol_edges(to_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_symbol ON symbol_edges(symbol_name);

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
      'INSERT OR REPLACE INTO symbol_edges (from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence) VALUES (?, ?, ?, ?, ?)'
    );
    this.deleteEdgesFromStmt = this.db.prepare('DELETE FROM symbol_edges WHERE from_chunk_id = ?');
    this.deleteEdgesToStmt = this.db.prepare('DELETE FROM symbol_edges WHERE to_chunk_id = ?');
    this.getEdgesFromStmt = this.db.prepare(
      'SELECT from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence FROM symbol_edges WHERE from_chunk_id = ?'
    );
    this.getEdgesToStmt = this.db.prepare(
      'SELECT from_chunk_id, to_chunk_id, relation_type, symbol_name, confidence FROM symbol_edges WHERE to_chunk_id = ?'
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
    this.deleteProjectEdgesStmt = this.db.prepare(
      "DELETE FROM symbol_edges WHERE from_chunk_id LIKE ? ESCAPE '\\' OR to_chunk_id LIKE ? ESCAPE '\\'"
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
      | { commit_hash: string; committed_at: string; author_email: string }
      | undefined;
    return row ?? null;
  }

  deleteChunk(chunkId: string): void {
    const tx = this.db.transaction(() => {
      this.deleteChunkCommitsStmt.run(chunkId);
      this.deleteChunkTicketsStmt.run(chunkId);
      this.deleteChunkEdgesStmt.run(chunkId, chunkId);
    });
    tx();
  }

  deleteByProject(group: string, project: string): void {
    const prefix = `${escapeLike(group)}//${escapeLike(project)}//`;
    const pattern = `${prefix}%`;
    const tx = this.db.transaction(() => {
      this.deleteProjectCommitsStmt.run(pattern);
      this.deleteProjectTicketsStmt.run(pattern);
      this.deleteProjectEdgesStmt.run(pattern, pattern);
      this.deleteProjectGitCacheStmt.run(group, project);
    });
    tx();
  }

  // ── Git file cache (parsed `git log` output keyed by repo HEAD) ──────────

  getGitFileCache(
    group: string,
    project: string,
    file: string,
    head: string
  ): GitFileCacheData | null {
    const row = this.getGitFileCacheStmt.get(group, project, file, head) as
      | { data: string }
      | undefined;
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

  upsertSymbolEdges(edges: SymbolEdge[]): void {
    const tx = this.db.transaction(() => {
      for (const e of edges) {
        this.insertEdgeStmt.run(
          e.from_chunk_id,
          e.to_chunk_id,
          e.relation_type,
          e.symbol_name,
          e.confidence ?? 'INFERRED'
        );
      }
    });
    tx();
    // Edges changed → drop the degree cache for affected groups only. The
    // group is the first `//`-delimited segment of a chunk_id; touching one
    // project must not invalidate cached stats for unrelated groups.
    const affected = new Set<string>();
    for (const e of edges) {
      const g = e.from_chunk_id.split('//')[0];
      if (g) affected.add(g);
      const g2 = e.to_chunk_id.split('//')[0];
      if (g2) affected.add(g2);
    }
    for (const g of affected) this.invalidateDegreeCache(g);
  }

  getEdgesFrom(chunkId: string): SymbolEdge[] {
    return this.getEdgesFromStmt.all(chunkId) as SymbolEdge[];
  }

  getEdgesTo(chunkId: string): SymbolEdge[] {
    return this.getEdgesToStmt.all(chunkId) as SymbolEdge[];
  }

  deleteEdgesForChunk(chunkId: string): void {
    this.deleteChunkEdgesStmt.run(chunkId, chunkId);
  }

  /** Delete all metadata (commits, tickets, edges) for a specific file within a project */
  deleteByFile(group: string, project: string, file: string): void {
    const prefix = `${escapeLike(group)}//${escapeLike(project)}//${escapeLike(file)}//`;
    const pattern = `${prefix}%`;
    const tx = this.db.transaction(() => {
      this.deleteProjectCommitsStmt.run(pattern);
      this.deleteProjectTicketsStmt.run(pattern);
      this.deleteProjectEdgesStmt.run(pattern, pattern);
    });
    tx();
  }

  deleteEdgesByProject(group: string, project: string): void {
    const prefix = `${escapeLike(group)}//${escapeLike(project)}//`;
    const pattern = `${prefix}%`;
    this.deleteProjectEdgesStmt.run(pattern, pattern);
    // Edges changed → drop the group's degree cache (per-group scope, since
    // hub thresholds are computed across the whole group, not per-project).
    this.invalidateDegreeCache(group);
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
    }
  >();
  private static readonly DEGREE_CACHE_TTL_MS = 5 * 60 * 1000;

  invalidateDegreeCache(group?: string): void {
    if (group === undefined) {
      this.degreeCache.clear();
      return;
    }
    this.degreeCache.delete(group);
  }

  private computeGroupDegreeStats(group: string): {
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
  } {
    const pattern = `${escapeLike(group)}//%`;
    const inRows = this.db
      .prepare(
        "SELECT to_chunk_id AS chunkId, COUNT(*) AS degree FROM symbol_edges WHERE to_chunk_id LIKE ? ESCAPE '\\' GROUP BY to_chunk_id ORDER BY degree DESC"
      )
      .all(pattern) as Array<{ chunkId: string; degree: number }>;
    const outRows = this.db
      .prepare(
        "SELECT from_chunk_id AS chunkId, COUNT(*) AS degree FROM symbol_edges WHERE from_chunk_id LIKE ? ESCAPE '\\' GROUP BY from_chunk_id ORDER BY degree DESC"
      )
      .all(pattern) as Array<{ chunkId: string; degree: number }>;
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

  private getGroupDegreeStats(group: string): {
    inDegreeP95: number;
    outDegreeP95: number;
    topInDegree: Array<{ chunkId: string; degree: number }>;
    topOutDegree: Array<{ chunkId: string; degree: number }>;
    hubChunkIds: Set<string>;
  } {
    const cached = this.degreeCache.get(group);
    if (cached && Date.now() - cached.computedAt < MetadataStore.DEGREE_CACHE_TTL_MS) {
      return cached;
    }
    const stats = this.computeGroupDegreeStats(group);
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
    for (const r of stats.topOutDegree) {
      if (r.degree >= outFloor) hubChunkIds.add(r.chunkId);
    }
    this.degreeCache.set(group, { ...stats, hubChunkIds, computedAt: Date.now() });
    return { ...stats, hubChunkIds };
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
  } {
    const stats = this.getGroupDegreeStats(group);
    return {
      inDegreeP95: Math.max(5, stats.inDegreeP95),
      outDegreeP95: Math.max(5, stats.outDegreeP95),
      topInDegree: stats.topInDegree,
      topOutDegree: stats.topOutDegree,
      hubChunkIds: stats.hubChunkIds,
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
function percentile(sortedDesc: number[], p: number): number {
  const len = sortedDesc.length;
  if (len === 0) return 0;
  const ascIdx = Math.min(len - 1, Math.floor(p * len));
  return sortedDesc[len - 1 - ascIdx] ?? 0;
}
