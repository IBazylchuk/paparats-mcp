import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import { v7 as uuidv7 } from 'uuid';
import { tctx } from './context.js';
import type { TelemetrySink } from './facade.js';
import type {
  ChunkFetchEvent,
  ChunkingErrorEvent,
  EmbeddingCallEvent,
  FileSnapshotRecord,
  IndexingRunEvent,
  SearchRecordEvent,
  ToolCallEvent,
} from './types.js';

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const DEFAULT_DB_PATH = path.join(PAPARATS_DIR, 'analytics.db');

const SCHEMA_VERSION = 1;

const TOKENS_PER_LANGUAGE_SEED: Record<string, number> = {
  ts: 5.5,
  tsx: 5.5,
  js: 5.5,
  jsx: 5.5,
  python: 4.5,
  go: 5,
  java: 4.5,
  rust: 5,
  csharp: 5,
  ruby: 4.5,
  php: 4.5,
  markdown: 3,
  yaml: 3,
  json: 3,
  generic: 4,
};

export interface AnalyticsStoreOptions {
  dbPath?: string;
  /** When false, search_results.file is stored as NULL */
  logResultFiles?: boolean;
  /** When false, search_events.query_text is stored as NULL */
  logQueryText?: boolean;
}

export class AnalyticsStore implements TelemetrySink {
  private db: Database.Database;
  private closed = false;
  private logResultFiles: boolean;
  private logQueryText: boolean;

  private insSearchEvent!: Database.Statement;
  private insSearchResult!: Database.Statement;
  private insChunkFetch!: Database.Statement;
  private insToolCall!: Database.Statement;
  private insIndexingRun!: Database.Statement;
  private upsIndexingRun!: Database.Statement;
  private insChunkingError!: Database.Statement;
  private insEmbeddingCall!: Database.Statement;
  private upsFile!: Database.Statement;
  private getFileLines!: Database.Statement;
  private resolvePrecedingStmt!: Database.Statement;
  private upsTokensPerLang!: Database.Statement;

  constructor(options: AnalyticsStoreOptions = {}) {
    const p = options.dbPath ?? DEFAULT_DB_PATH;
    this.logResultFiles = options.logResultFiles ?? true;
    this.logQueryText = options.logQueryText ?? true;

    fs.mkdirSync(path.dirname(p), { recursive: true });

    this.db = new Database(p);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    } catch {
      // continue with defaults
    }

    this.runMigrations();
    this.prepareStatements();
    this.seedTokensPerLanguage();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
      | { v: number | null }
      | undefined;
    const current = row?.v ?? 0;
    if (current >= SCHEMA_VERSION) return;

    const tx = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS search_events (
          id              TEXT PRIMARY KEY,
          request_id      TEXT,
          ts              INTEGER NOT NULL,
          user            TEXT NOT NULL,
          session         TEXT,
          client          TEXT,
          tool            TEXT NOT NULL,
          group_name      TEXT,
          anchor_project  TEXT,
          query_text      TEXT,
          query_hash      TEXT NOT NULL,
          query_tokens    TEXT NOT NULL,
          limit_param     INTEGER NOT NULL,
          duration_ms     INTEGER NOT NULL,
          result_count    INTEGER NOT NULL,
          cache_hit       INTEGER NOT NULL,
          error           TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_search_user_ts    ON search_events(user, ts);
        CREATE INDEX IF NOT EXISTS idx_search_session_ts ON search_events(session, ts);
        CREATE INDEX IF NOT EXISTS idx_search_query_hash ON search_events(query_hash);
        CREATE INDEX IF NOT EXISTS idx_search_ts         ON search_events(ts);

        CREATE TABLE IF NOT EXISTS search_results (
          search_id        TEXT NOT NULL,
          rank             INTEGER NOT NULL,
          project          TEXT NOT NULL,
          file             TEXT,
          language         TEXT,
          score            REAL NOT NULL,
          start_line       INTEGER NOT NULL,
          end_line         INTEGER NOT NULL,
          chunk_lines      INTEGER NOT NULL,
          file_total_lines INTEGER,
          chunk_id         TEXT,
          PRIMARY KEY (search_id, rank)
        );
        CREATE INDEX IF NOT EXISTS idx_search_results_project  ON search_results(project);
        CREATE INDEX IF NOT EXISTS idx_search_results_chunk_id ON search_results(chunk_id);

        CREATE TABLE IF NOT EXISTS chunk_fetches (
          id                  TEXT PRIMARY KEY,
          ts                  INTEGER NOT NULL,
          user                TEXT NOT NULL,
          session             TEXT,
          chunk_id            TEXT NOT NULL,
          preceding_search_id TEXT,
          radius_lines        INTEGER NOT NULL,
          duration_ms         INTEGER NOT NULL,
          found               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunk_fetches_search  ON chunk_fetches(preceding_search_id);
        CREATE INDEX IF NOT EXISTS idx_chunk_fetches_user_ts ON chunk_fetches(user, ts);

        CREATE TABLE IF NOT EXISTS tool_calls (
          id          TEXT PRIMARY KEY,
          ts          INTEGER NOT NULL,
          user        TEXT NOT NULL,
          session     TEXT,
          tool        TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          ok          INTEGER NOT NULL,
          error       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tool_calls_user_tool_ts ON tool_calls(user, tool, ts);

        CREATE TABLE IF NOT EXISTS indexing_runs (
          id            TEXT PRIMARY KEY,
          started_at    INTEGER NOT NULL,
          ended_at      INTEGER,
          group_name    TEXT NOT NULL,
          project_name  TEXT,
          trigger       TEXT NOT NULL,
          files_total   INTEGER NOT NULL DEFAULT 0,
          files_skipped INTEGER NOT NULL DEFAULT 0,
          chunks_total  INTEGER NOT NULL DEFAULT 0,
          errors_total  INTEGER NOT NULL DEFAULT 0,
          status        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_indexing_runs_started ON indexing_runs(started_at);

        CREATE TABLE IF NOT EXISTS chunking_errors (
          id           TEXT PRIMARY KEY,
          run_id       TEXT,
          ts           INTEGER NOT NULL,
          group_name   TEXT NOT NULL,
          project_name TEXT NOT NULL,
          file         TEXT NOT NULL,
          language     TEXT,
          error_class  TEXT NOT NULL,
          message      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chunking_errors_run ON chunking_errors(run_id);

        CREATE TABLE IF NOT EXISTS embedding_calls (
          id          TEXT PRIMARY KEY,
          ts          INTEGER NOT NULL,
          user        TEXT NOT NULL,
          kind        TEXT NOT NULL,
          batch_size  INTEGER NOT NULL DEFAULT 1,
          cache_hits  INTEGER NOT NULL DEFAULT 0,
          cache_miss  INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL,
          timeout     INTEGER NOT NULL DEFAULT 0,
          error       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_embedding_calls_ts ON embedding_calls(ts);

        CREATE TABLE IF NOT EXISTS files (
          group_name   TEXT NOT NULL,
          project_name TEXT NOT NULL,
          file         TEXT NOT NULL,
          language     TEXT,
          total_lines  INTEGER NOT NULL,
          total_bytes  INTEGER NOT NULL,
          indexed_at   INTEGER NOT NULL,
          PRIMARY KEY (group_name, project_name, file)
        );

        CREATE TABLE IF NOT EXISTS tokens_per_language (
          language        TEXT PRIMARY KEY,
          tokens_per_line REAL NOT NULL
        );
      `);
      this.db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(SCHEMA_VERSION, Date.now());
    });
    tx();
  }

  private prepareStatements(): void {
    this.insSearchEvent = this.db.prepare(`
      INSERT INTO search_events (
        id, request_id, ts, user, session, client, tool, group_name, anchor_project,
        query_text, query_hash, query_tokens, limit_param,
        duration_ms, result_count, cache_hit, error
      ) VALUES (
        @id, @request_id, @ts, @user, @session, @client, @tool, @group_name, @anchor_project,
        @query_text, @query_hash, @query_tokens, @limit_param,
        @duration_ms, @result_count, @cache_hit, @error
      )
    `);

    this.insSearchResult = this.db.prepare(`
      INSERT INTO search_results (
        search_id, rank, project, file, language, score,
        start_line, end_line, chunk_lines, file_total_lines, chunk_id
      ) VALUES (
        @search_id, @rank, @project, @file, @language, @score,
        @start_line, @end_line, @chunk_lines, @file_total_lines, @chunk_id
      )
    `);

    this.insChunkFetch = this.db.prepare(`
      INSERT INTO chunk_fetches (
        id, ts, user, session, chunk_id, preceding_search_id,
        radius_lines, duration_ms, found
      ) VALUES (
        @id, @ts, @user, @session, @chunk_id, @preceding_search_id,
        @radius_lines, @duration_ms, @found
      )
    `);

    this.insToolCall = this.db.prepare(`
      INSERT INTO tool_calls (id, ts, user, session, tool, duration_ms, ok, error)
      VALUES (@id, @ts, @user, @session, @tool, @duration_ms, @ok, @error)
    `);

    this.insIndexingRun = this.db.prepare(`
      INSERT INTO indexing_runs (
        id, started_at, ended_at, group_name, project_name, trigger,
        files_total, files_skipped, chunks_total, errors_total, status
      ) VALUES (
        @id, @started_at, @ended_at, @group_name, @project_name, @trigger,
        @files_total, @files_skipped, @chunks_total, @errors_total, @status
      )
    `);
    this.upsIndexingRun = this.db.prepare(`
      INSERT INTO indexing_runs (
        id, started_at, ended_at, group_name, project_name, trigger,
        files_total, files_skipped, chunks_total, errors_total, status
      ) VALUES (
        @id, @started_at, @ended_at, @group_name, @project_name, @trigger,
        @files_total, @files_skipped, @chunks_total, @errors_total, @status
      )
      ON CONFLICT(id) DO UPDATE SET
        ended_at      = excluded.ended_at,
        files_total   = excluded.files_total,
        files_skipped = excluded.files_skipped,
        chunks_total  = excluded.chunks_total,
        errors_total  = excluded.errors_total,
        status        = excluded.status
    `);

    this.insChunkingError = this.db.prepare(`
      INSERT INTO chunking_errors (
        id, run_id, ts, group_name, project_name, file, language, error_class, message
      ) VALUES (
        @id, @run_id, @ts, @group_name, @project_name, @file, @language, @error_class, @message
      )
    `);

    this.insEmbeddingCall = this.db.prepare(`
      INSERT INTO embedding_calls (
        id, ts, user, kind, batch_size, cache_hits, cache_miss, duration_ms, timeout, error
      ) VALUES (
        @id, @ts, @user, @kind, @batch_size, @cache_hits, @cache_miss, @duration_ms, @timeout, @error
      )
    `);

    this.upsFile = this.db.prepare(`
      INSERT INTO files (group_name, project_name, file, language, total_lines, total_bytes, indexed_at)
      VALUES (@group_name, @project_name, @file, @language, @total_lines, @total_bytes, @indexed_at)
      ON CONFLICT(group_name, project_name, file) DO UPDATE SET
        language    = excluded.language,
        total_lines = excluded.total_lines,
        total_bytes = excluded.total_bytes,
        indexed_at  = excluded.indexed_at
    `);

    this.getFileLines = this.db.prepare(
      'SELECT total_lines AS total_lines FROM files WHERE group_name = ? AND project_name = ? AND file = ?'
    );

    this.resolvePrecedingStmt = this.db.prepare(`
      SELECT se.id AS id
      FROM search_events se
      JOIN search_results sr ON sr.search_id = se.id
      WHERE se.user = ? AND (se.session = ? OR (se.session IS NULL AND ? IS NULL))
        AND sr.chunk_id = ?
      ORDER BY se.ts DESC
      LIMIT 1
    `);

    this.upsTokensPerLang = this.db.prepare(
      'INSERT INTO tokens_per_language (language, tokens_per_line) VALUES (?, ?) ON CONFLICT(language) DO NOTHING'
    );
  }

  private seedTokensPerLanguage(): void {
    const tx = this.db.transaction(() => {
      for (const [lang, tpl] of Object.entries(TOKENS_PER_LANGUAGE_SEED)) {
        this.upsTokensPerLang.run(lang, tpl);
      }
    });
    tx();
  }

  /** Look up total_lines for a file from the indexer-populated files table. Returns null when unknown. */
  getFileTotalLines(groupName: string, projectName: string, file: string): number | null {
    const row = this.getFileLines.get(groupName, projectName, file) as
      | { total_lines: number }
      | undefined;
    return row?.total_lines ?? null;
  }

  /** Direct DB access for analytics MCP tools (read-only queries). */
  get database(): Database.Database {
    return this.db;
  }

  recordSearch(event: SearchRecordEvent): void {
    if (this.closed) return;
    const ctx = tctx.getOrAnonymous();
    const id = uuidv7();
    const tx = this.db.transaction(() => {
      this.insSearchEvent.run({
        id,
        request_id: ctx.requestId,
        ts: event.ts,
        user: ctx.user,
        session: ctx.session,
        client: ctx.client,
        tool: event.tool,
        group_name: event.groupName,
        anchor_project: event.anchorProject,
        query_text: this.logQueryText ? event.queryText.slice(0, 1024) : null,
        query_hash: event.queryHash,
        query_tokens: JSON.stringify(event.queryTokens),
        limit_param: event.limit,
        duration_ms: event.durationMs,
        result_count: event.resultCount,
        cache_hit: event.cacheHit ? 1 : 0,
        error: event.error,
      });
      for (const r of event.results) {
        this.insSearchResult.run({
          search_id: id,
          rank: r.rank,
          project: r.project,
          file: this.logResultFiles ? r.file : null,
          language: r.language,
          score: r.score,
          start_line: r.startLine,
          end_line: r.endLine,
          chunk_lines: r.chunkLines,
          file_total_lines: r.fileTotalLines,
          chunk_id: r.chunkId,
        });
      }
    });
    try {
      tx();
    } catch (err) {
      console.warn('[analytics] recordSearch failed:', (err as Error).message);
    }
  }

  recordChunkFetch(event: ChunkFetchEvent): void {
    if (this.closed) return;
    const ctx = tctx.getOrAnonymous();
    const preceding = this.resolvePrecedingSearchId(event.chunkId, ctx.user, ctx.session);
    try {
      this.insChunkFetch.run({
        id: uuidv7(),
        ts: event.ts,
        user: ctx.user,
        session: ctx.session,
        chunk_id: event.chunkId,
        preceding_search_id: preceding,
        radius_lines: event.radiusLines,
        duration_ms: event.durationMs,
        found: event.found ? 1 : 0,
      });
    } catch (err) {
      console.warn('[analytics] recordChunkFetch failed:', (err as Error).message);
    }
  }

  recordToolCall(event: ToolCallEvent): void {
    if (this.closed) return;
    const ctx = tctx.getOrAnonymous();
    try {
      this.insToolCall.run({
        id: uuidv7(),
        ts: event.ts,
        user: ctx.user,
        session: ctx.session,
        tool: event.tool,
        duration_ms: event.durationMs,
        ok: event.ok ? 1 : 0,
        error: event.error,
      });
    } catch (err) {
      console.warn('[analytics] recordToolCall failed:', (err as Error).message);
    }
  }

  recordIndexingRun(event: IndexingRunEvent): void {
    if (this.closed) return;
    try {
      const stmt = event.endedAt === null ? this.insIndexingRun : this.upsIndexingRun;
      stmt.run({
        id: event.id,
        started_at: event.startedAt,
        ended_at: event.endedAt,
        group_name: event.groupName,
        project_name: event.projectName,
        trigger: event.trigger,
        files_total: event.filesTotal,
        files_skipped: event.filesSkipped,
        chunks_total: event.chunksTotal,
        errors_total: event.errorsTotal,
        status: event.status,
      });
    } catch (err) {
      console.warn('[analytics] recordIndexingRun failed:', (err as Error).message);
    }
  }

  recordChunkingError(event: ChunkingErrorEvent): void {
    if (this.closed) return;
    try {
      this.insChunkingError.run({
        id: uuidv7(),
        run_id: event.runId,
        ts: event.ts,
        group_name: event.groupName,
        project_name: event.projectName,
        file: event.file,
        language: event.language,
        error_class: event.errorClass,
        message: event.message ? event.message.slice(0, 512) : null,
      });
    } catch (err) {
      console.warn('[analytics] recordChunkingError failed:', (err as Error).message);
    }
  }

  recordEmbedding(event: EmbeddingCallEvent): void {
    if (this.closed) return;
    const ctx = tctx.getOrAnonymous();
    try {
      this.insEmbeddingCall.run({
        id: uuidv7(),
        ts: event.ts,
        user: ctx.user,
        kind: event.kind,
        batch_size: event.batchSize,
        cache_hits: event.cacheHits,
        cache_miss: event.cacheMiss,
        duration_ms: event.durationMs,
        timeout: event.timeout ? 1 : 0,
        error: event.error,
      });
    } catch (err) {
      console.warn('[analytics] recordEmbedding failed:', (err as Error).message);
    }
  }

  upsertFile(record: FileSnapshotRecord): void {
    if (this.closed) return;
    try {
      this.upsFile.run({
        group_name: record.groupName,
        project_name: record.projectName,
        file: record.file,
        language: record.language,
        total_lines: record.totalLines,
        total_bytes: record.totalBytes,
        indexed_at: record.indexedAt,
      });
    } catch (err) {
      console.warn('[analytics] upsertFile failed:', (err as Error).message);
    }
  }

  resolvePrecedingSearchId(chunkId: string, user: string, session: string | null): string | null {
    if (this.closed) return null;
    try {
      const row = this.resolvePrecedingStmt.get(user, session, session, chunkId) as
        | { id: string }
        | undefined;
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Delete events older than the cutoff timestamp. Returns rows removed. */
  pruneOlderThan(cutoffMs: number): number {
    if (this.closed) return 0;
    let removed = 0;
    const tx = this.db.transaction(() => {
      const childStmt = this.db.prepare(
        'DELETE FROM search_results WHERE search_id IN (SELECT id FROM search_events WHERE ts < ?)'
      );
      removed += childStmt.run(cutoffMs).changes;

      for (const t of [
        'search_events',
        'chunk_fetches',
        'tool_calls',
        'chunking_errors',
        'embedding_calls',
      ]) {
        const stmt = this.db.prepare(`DELETE FROM ${t} WHERE ts < ?`);
        removed += stmt.run(cutoffMs).changes;
      }
      const ix = this.db.prepare('DELETE FROM indexing_runs WHERE started_at < ?');
      removed += ix.run(cutoffMs).changes;
    });
    tx();
    return removed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
