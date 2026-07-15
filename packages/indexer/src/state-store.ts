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
 * Bump this whenever a code change requires every repo to be re-indexed on the
 * next boot regardless of its content fingerprint — e.g. a symbol-graph fix
 * that must rebuild edges even for repos whose source hasn't changed. On
 * startup the store compares this against the persisted value; a mismatch wipes
 * all fingerprints so the next cron cycle performs a full pass, then records the
 * new version. Left unchanged, boots are a no-op.
 *
 * History:
 *  1 — symbol-graph AMBIGUOUS fan-out cap: rebuild edges to purge the millions
 *      of stale high-fanout edges from pre-cap indexes.
 */
const REINDEX_EPOCH = 1;

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
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
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

    this.applyReindexEpoch();
  }

  /**
   * One-time forced reindex gate. When the code's {@link REINDEX_EPOCH} is newer
   * than the value persisted in this database, drop every stored fingerprint so
   * the next cron cycle re-indexes all repos (rebuilding derived data such as
   * symbol edges), then record the new epoch. Idempotent across restarts —
   * only the first boot after an epoch bump clears state.
   */
  private applyReindexEpoch(): void {
    const stored = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (stored >= REINDEX_EPOCH) return;
    const cleared = this.db.prepare('DELETE FROM repo_fingerprints').run().changes;
    // user_version only accepts an integer literal — no bound parameters.
    this.db.pragma(`user_version = ${REINDEX_EPOCH}`);
    console.log(
      `[indexer] reindex epoch ${stored} → ${REINDEX_EPOCH}: cleared ${cleared} repo fingerprint(s); next cycle re-indexes all repos`
    );
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
