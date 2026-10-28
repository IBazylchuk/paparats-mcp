import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { TOKENIZER_VERSION, type CorpusStats } from './bm25.js';

/**
 * Per-group corpus statistics (document frequencies + length totals) for BM25.
 *
 * Deliberately a SEPARATE SQLite file from metadata.db. metadata.db already
 * carries the multi-GB symbol_edges table; mixing a high-churn term-frequency
 * table into it repeats that bloat/contention mistake. This store is small,
 * self-contained, and owns its own file (`~/.paparats/docs-idf.db`).
 *
 * Schema:
 *   - doc_freq(group, term, df)        — how many chunks in the group contain term
 *   - corpus(group, doc_count, total_length) — running totals for avgDocLength
 *   - tokenizer(group, version)        — the `TOKENIZER_VERSION` the counts were made with
 *
 * Frequencies are maintained incrementally: indexing a chunk's term set bumps df
 * and the corpus totals; re-indexing a file first decrements the old chunks'
 * contribution (see removeDocument) so counts stay exact across updates.
 * That decrement tokenises the stored chunk again, so it is exact only while the
 * tokeniser is the one the counts were made with: a group counted with another
 * one is stale (`isCurrent()`) and rebuilt from its chunks (`replaceGroup()`).
 */

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const DEFAULT_DB_PATH = path.join(PAPARATS_DIR, 'docs-idf.db');

const CREATE_DOC_FREQ =
  `CREATE TABLE IF NOT EXISTS doc_freq (` +
  `"group" TEXT NOT NULL, term TEXT NOT NULL, df INTEGER NOT NULL, ` +
  `PRIMARY KEY ("group", term))`;
const CREATE_CORPUS =
  `CREATE TABLE IF NOT EXISTS corpus (` +
  `"group" TEXT PRIMARY KEY, doc_count INTEGER NOT NULL, total_length INTEGER NOT NULL)`;
const CREATE_TOKENIZER =
  `CREATE TABLE IF NOT EXISTS tokenizer (` + `"group" TEXT PRIMARY KEY, version INTEGER NOT NULL)`;

export class DocsIdfStore {
  private db: Database.Database;
  private closed = false;

  private bumpDfStmt: Database.Statement;
  private lowerDfStmt: Database.Statement;
  private getDfStmt: Database.Statement;
  private deleteZeroDfStmt: Database.Statement;
  private addCorpusStmt: Database.Statement;
  private getCorpusStmt: Database.Statement;
  private setCorpusStmt: Database.Statement;
  private deleteGroupDfStmt: Database.Statement;
  private deleteGroupCorpusStmt: Database.Statement;
  private getTokenizerStmt: Database.Statement;
  private setTokenizerStmt: Database.Statement;
  private deleteGroupTokenizerStmt: Database.Statement;

  constructor(dbPath?: string) {
    const p = dbPath ?? DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    } catch {
      // WAL unsupported — continue with defaults.
    }
    this.db.pragma('busy_timeout = 30000');

    this.db.prepare(CREATE_DOC_FREQ).run();
    this.db.prepare(CREATE_CORPUS).run();
    this.db.prepare(CREATE_TOKENIZER).run();

    this.bumpDfStmt = this.db.prepare(
      `INSERT INTO doc_freq ("group", term, df) VALUES (?, ?, 1)
       ON CONFLICT("group", term) DO UPDATE SET df = df + 1`
    );
    this.lowerDfStmt = this.db.prepare(
      `UPDATE doc_freq SET df = df - 1 WHERE "group" = ? AND term = ?`
    );
    this.getDfStmt = this.db.prepare(`SELECT df FROM doc_freq WHERE "group" = ? AND term = ?`);
    this.deleteZeroDfStmt = this.db.prepare(`DELETE FROM doc_freq WHERE "group" = ? AND df <= 0`);
    this.addCorpusStmt = this.db.prepare(
      `INSERT INTO corpus ("group", doc_count, total_length) VALUES (?, ?, ?)
       ON CONFLICT("group") DO UPDATE
         SET doc_count = doc_count + excluded.doc_count,
             total_length = total_length + excluded.total_length`
    );
    this.getCorpusStmt = this.db.prepare(
      `SELECT doc_count, total_length FROM corpus WHERE "group" = ?`
    );
    this.setCorpusStmt = this.db.prepare(
      `UPDATE corpus SET doc_count = ?, total_length = ? WHERE "group" = ?`
    );
    this.deleteGroupDfStmt = this.db.prepare(`DELETE FROM doc_freq WHERE "group" = ?`);
    this.deleteGroupCorpusStmt = this.db.prepare(`DELETE FROM corpus WHERE "group" = ?`);
    this.getTokenizerStmt = this.db.prepare(`SELECT version FROM tokenizer WHERE "group" = ?`);
    this.setTokenizerStmt = this.db.prepare(
      `INSERT INTO tokenizer ("group", version) VALUES (?, ?)
       ON CONFLICT("group") DO UPDATE SET version = excluded.version`
    );
    this.deleteGroupTokenizerStmt = this.db.prepare(`DELETE FROM tokenizer WHERE "group" = ?`);
  }

  /**
   * Record one document (chunk) into the corpus: bump df for each DISTINCT term,
   * add its token length to the running total, increment doc_count by 1.
   * `terms` should be the deduplicated token set; `length` the raw token count.
   */
  addDocument(group: string, terms: Set<string>, length: number): void {
    const tx = this.db.transaction(() => {
      // A group's first document starts its counts with the current tokeniser.
      if (this.getCorpusStmt.get(group) === undefined) {
        this.setTokenizerStmt.run(group, TOKENIZER_VERSION);
      }
      for (const term of terms) this.bumpDfStmt.run(group, term);
      this.addCorpusStmt.run(group, 1, length);
    });
    tx();
  }

  /**
   * Remove one document's contribution before re-indexing it. Decrements df for
   * each distinct term (pruning any that hit zero) and subtracts from the corpus
   * totals. Clamps doc_count/total_length at zero defensively.
   */
  removeDocument(group: string, terms: Set<string>, length: number): void {
    const tx = this.db.transaction(() => {
      for (const term of terms) this.lowerDfStmt.run(group, term);
      this.deleteZeroDfStmt.run(group);
      const cur = this.getCorpusStmt.get(group) as
        { doc_count: number; total_length: number } | undefined;
      if (cur) {
        const docCount = Math.max(0, cur.doc_count - 1);
        const totalLength = Math.max(0, cur.total_length - length);
        this.setCorpusStmt.run(docCount, totalLength, group);
      }
    });
    tx();
  }

  /** Drop all stats for a group — used when a docs collection is dropped/reindexed. */
  clearGroup(group: string): void {
    const tx = this.db.transaction(() => {
      this.deleteGroupDfStmt.run(group);
      this.deleteGroupCorpusStmt.run(group);
      this.deleteGroupTokenizerStmt.run(group);
    });
    tx();
  }

  /**
   * Whether the group has counts made with the current tokeniser. False for a
   * group with no documents, and for one counted before `TOKENIZER_VERSION`
   * changed (or before it was recorded).
   */
  isCurrent(group: string): boolean {
    const corpus = this.getCorpusStmt.get(group) as { doc_count: number } | undefined;
    if (!corpus || corpus.doc_count <= 0) return false;
    const row = this.getTokenizerStmt.get(group) as { version: number } | undefined;
    return row?.version === TOKENIZER_VERSION;
  }

  /**
   * Replace the group's counts with these documents in one transaction, unless
   * another process sharing this file has made them current meanwhile (the
   * server and the indexer both rebuild at startup). `current` false keeps the
   * group stale, for a partial set, so the next start rebuilds it again.
   *
   * @returns whether the counts were replaced.
   */
  replaceGroup(
    group: string,
    docs: Array<{ terms: Set<string>; length: number }>,
    current = true
  ): boolean {
    const tx = this.db.transaction((): boolean => {
      if (this.isCurrent(group)) return false;
      this.deleteGroupDfStmt.run(group);
      this.deleteGroupCorpusStmt.run(group);
      this.deleteGroupTokenizerStmt.run(group);
      for (const d of docs) {
        for (const term of d.terms) this.bumpDfStmt.run(group, term);
        this.addCorpusStmt.run(group, 1, d.length);
      }
      if (current) this.setTokenizerStmt.run(group, TOKENIZER_VERSION);
      return true;
    });
    return tx.immediate();
  }

  /**
   * Snapshot the group's corpus stats as a {@link CorpusStats} usable by the
   * BM25 builders. Reads doc_count/avg once; df is looked up per term lazily via
   * a prepared statement (cheap, and query/index only touch a handful of terms).
   */
  getCorpusStats(group: string): CorpusStats {
    const row = this.getCorpusStmt.get(group) as
      { doc_count: number; total_length: number } | undefined;
    const docCount = row?.doc_count ?? 0;
    const totalLength = row?.total_length ?? 0;
    const avgDocLength = docCount > 0 ? totalLength / docCount : 0;
    const getDf = this.getDfStmt;
    return {
      docCount,
      avgDocLength,
      docFreq(term: string): number {
        const r = getDf.get(group, term) as { df: number } | undefined;
        return r?.df ?? 0;
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
