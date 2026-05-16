import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export interface StoredFingerprint {
  fingerprint: string;
  kind: string;
  lastIndexedAt: string;
  lastChunks: number | null;
}

/**
 * Persistent store of per-repo fingerprints used by the change-detection
 * cycle. One row per repo `fullName`. Lives at a configurable SQLite path
 * (typically /data/indexer-state.db inside the container).
 */
export class StateStore {
  private db: Database.Database;
  private closed = false;
  private getStmt: Database.Statement;
  private upsertStmt: Database.Statement;
  private deleteStmt: Database.Statement;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_fingerprints (
        full_name        TEXT PRIMARY KEY,
        fingerprint      TEXT NOT NULL,
        kind             TEXT NOT NULL,
        last_indexed_at  TEXT NOT NULL,
        last_chunks      INTEGER
      )
    `);

    this.getStmt = this.db.prepare(
      'SELECT fingerprint, kind, last_indexed_at AS lastIndexedAt, last_chunks AS lastChunks FROM repo_fingerprints WHERE full_name = ?'
    );
    this.upsertStmt = this.db.prepare(
      `INSERT INTO repo_fingerprints (full_name, fingerprint, kind, last_indexed_at, last_chunks)
       VALUES (@fullName, @fingerprint, @kind, @lastIndexedAt, @lastChunks)
       ON CONFLICT(full_name) DO UPDATE SET
         fingerprint     = excluded.fingerprint,
         kind            = excluded.kind,
         last_indexed_at = excluded.last_indexed_at,
         last_chunks     = excluded.last_chunks`
    );
    this.deleteStmt = this.db.prepare('DELETE FROM repo_fingerprints WHERE full_name = ?');
  }

  get(fullName: string): StoredFingerprint | undefined {
    const row = this.getStmt.get(fullName) as
      | { fingerprint: string; kind: string; lastIndexedAt: string; lastChunks: number | null }
      | undefined;
    return row;
  }

  set(fullName: string, fingerprint: string, kind: string, chunks: number | undefined): void {
    this.upsertStmt.run({
      fullName,
      fingerprint,
      kind,
      lastIndexedAt: new Date().toISOString(),
      lastChunks: chunks ?? null,
    });
  }

  delete(fullName: string): void {
    this.deleteStmt.run(fullName);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
