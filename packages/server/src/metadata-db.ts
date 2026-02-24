import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { ChunkCommit, ChunkTicket, SymbolEdge } from './types.js';

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const DEFAULT_DB_PATH = path.join(PAPARATS_DIR, 'metadata.db');

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

  constructor(dbPath?: string) {
    const p = dbPath ?? DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(p), { recursive: true });

    this.db = new Database(p);
    try {
      this.db.pragma('journal_mode = WAL');
    } catch {
      // WAL not supported, continue with default
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
        PRIMARY KEY (from_chunk_id, to_chunk_id, symbol_name)
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_from ON symbol_edges(from_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_to ON symbol_edges(to_chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_symbol ON symbol_edges(symbol_name);
    `);

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
      'INSERT OR REPLACE INTO symbol_edges (from_chunk_id, to_chunk_id, relation_type, symbol_name) VALUES (?, ?, ?, ?)'
    );
    this.deleteEdgesFromStmt = this.db.prepare('DELETE FROM symbol_edges WHERE from_chunk_id = ?');
    this.deleteEdgesToStmt = this.db.prepare('DELETE FROM symbol_edges WHERE to_chunk_id = ?');
    this.getEdgesFromStmt = this.db.prepare(
      'SELECT from_chunk_id, to_chunk_id, relation_type, symbol_name FROM symbol_edges WHERE from_chunk_id = ?'
    );
    this.getEdgesToStmt = this.db.prepare(
      'SELECT from_chunk_id, to_chunk_id, relation_type, symbol_name FROM symbol_edges WHERE to_chunk_id = ?'
    );
    this.deleteChunkEdgesStmt = this.db.prepare(
      'DELETE FROM symbol_edges WHERE from_chunk_id = ? OR to_chunk_id = ?'
    );
    this.deleteProjectCommitsStmt = this.db.prepare(
      'DELETE FROM chunk_commits WHERE chunk_id LIKE ?'
    );
    this.deleteProjectTicketsStmt = this.db.prepare(
      'DELETE FROM chunk_tickets WHERE chunk_id LIKE ?'
    );
    this.deleteProjectEdgesStmt = this.db.prepare(
      'DELETE FROM symbol_edges WHERE from_chunk_id LIKE ? OR to_chunk_id LIKE ?'
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
    const prefix = `${group}//${project}//`;
    const pattern = `${prefix}%`;
    const tx = this.db.transaction(() => {
      this.deleteProjectCommitsStmt.run(pattern);
      this.deleteProjectTicketsStmt.run(pattern);
      this.deleteProjectEdgesStmt.run(pattern, pattern);
    });
    tx();
  }

  // ── Symbol edge methods ─────────────────────────────────────────────────

  upsertSymbolEdges(edges: SymbolEdge[]): void {
    const tx = this.db.transaction(() => {
      for (const e of edges) {
        this.insertEdgeStmt.run(e.from_chunk_id, e.to_chunk_id, e.relation_type, e.symbol_name);
      }
    });
    tx();
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

  deleteEdgesByProject(group: string, project: string): void {
    const prefix = `${group}//${project}//`;
    const pattern = `${prefix}%`;
    this.deleteProjectEdgesStmt.run(pattern, pattern);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
