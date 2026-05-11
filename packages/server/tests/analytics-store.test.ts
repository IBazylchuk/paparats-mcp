import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AnalyticsStore } from '../src/telemetry/analytics-store.js';
import { tctx, newContext } from '../src/telemetry/context.js';
import {
  tokenSavingsReport,
  topQueries,
  crossProjectShare,
  retryRate,
  failedChunks,
} from '../src/telemetry/queries.js';
import { hashQuery, tokenizeQuery } from '../src/telemetry/query-utils.js';

function tmpFile(): string {
  const dir = path.join(
    os.tmpdir(),
    `paparats-analytics-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'analytics.db');
}

describe('AnalyticsStore', () => {
  let store: AnalyticsStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpFile();
    store = new AnalyticsStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('records a search and per-result rows in one transaction', () => {
    const ctx = newContext({ user: 'alice' });
    tctx.run(ctx, () => {
      store.upsertFile({
        groupName: 'g',
        projectName: 'p',
        file: 'src/a.ts',
        language: 'ts',
        totalLines: 100,
        totalBytes: 4000,
        indexedAt: Date.now(),
      });
      store.recordSearch({
        ts: Date.now(),
        tool: 'search',
        groupName: 'g',
        anchorProject: 'p',
        queryText: 'find user',
        queryHash: hashQuery('find user'),
        queryTokens: tokenizeQuery('find user'),
        limit: 5,
        durationMs: 42,
        resultCount: 1,
        cacheHit: false,
        error: null,
        results: [
          {
            rank: 0,
            project: 'p',
            file: 'src/a.ts',
            language: 'ts',
            score: 0.9,
            startLine: 1,
            endLine: 10,
            chunkLines: 10,
            fileTotalLines: store.getFileTotalLines('g', 'p', 'src/a.ts'),
            chunkId: 'g//p//src/a.ts//1-10//deadbeef',
          },
        ],
      });
    });

    const events = store.database.prepare('SELECT * FROM search_events').all() as Array<{
      user: string;
      group_name: string;
      query_hash: string;
      result_count: number;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.user).toBe('alice');
    expect(events[0]!.group_name).toBe('g');
    expect(events[0]!.result_count).toBe(1);

    const results = store.database.prepare('SELECT * FROM search_results').all() as Array<{
      file_total_lines: number;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.file_total_lines).toBe(100);
  });

  it('resolves preceding_search_id for chunk_fetches', () => {
    const ctx = newContext({ user: 'bob', session: 's1' });
    tctx.run(ctx, () => {
      store.recordSearch({
        ts: Date.now() - 1000,
        tool: 'search',
        groupName: 'g',
        anchorProject: null,
        queryText: 'q',
        queryHash: hashQuery('q'),
        queryTokens: tokenizeQuery('q'),
        limit: 5,
        durationMs: 10,
        resultCount: 1,
        cacheHit: false,
        error: null,
        results: [
          {
            rank: 0,
            project: 'p',
            file: 'a.ts',
            language: 'ts',
            score: 0.8,
            startLine: 1,
            endLine: 5,
            chunkLines: 5,
            fileTotalLines: 50,
            chunkId: 'CHUNK-1',
          },
        ],
      });
      store.recordChunkFetch({
        ts: Date.now(),
        chunkId: 'CHUNK-1',
        radiusLines: 0,
        durationMs: 5,
        found: true,
      });
    });

    const fetches = store.database.prepare('SELECT * FROM chunk_fetches').all() as Array<{
      preceding_search_id: string | null;
    }>;
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.preceding_search_id).toBeTruthy();
  });
});

describe('analytics queries', () => {
  let store: AnalyticsStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpFile();
    store = new AnalyticsStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('token_savings_report returns non-zero baselines and search-only', () => {
    const ctx = newContext({ user: 'alice', session: 'sess' });
    tctx.run(ctx, () => {
      store.upsertFile({
        groupName: 'g',
        projectName: 'p',
        file: 'big.ts',
        language: 'ts',
        totalLines: 200,
        totalBytes: 8000,
        indexedAt: Date.now(),
      });
      store.recordSearch({
        ts: Date.now(),
        tool: 'search',
        groupName: 'g',
        anchorProject: 'p',
        queryText: 'how to login',
        queryHash: hashQuery('how to login'),
        queryTokens: tokenizeQuery('how to login'),
        limit: 5,
        durationMs: 20,
        resultCount: 1,
        cacheHit: false,
        error: null,
        results: [
          {
            rank: 0,
            project: 'p',
            file: 'big.ts',
            language: 'ts',
            score: 0.9,
            startLine: 10,
            endLine: 30,
            chunkLines: 21,
            fileTotalLines: 200,
            chunkId: 'C1',
          },
        ],
      });
      store.recordChunkFetch({
        ts: Date.now() + 100,
        chunkId: 'C1',
        radiusLines: 0,
        durationMs: 1,
        found: true,
      });
    });

    const r = tokenSavingsReport(store, {});
    expect(r.searches).toBe(1);
    expect(r.naive_baseline).toBeGreaterThan(0);
    expect(r.search_only).toBeGreaterThan(0);
    expect(r.actually_consumed).toBeGreaterThan(0);
    expect(r.savings_realized).not.toBeNull();
  });

  it('cross_project_share counts off-anchor results correctly', () => {
    const ctx = newContext({ user: 'alice', session: 's', anchorProject: 'service-a' });
    tctx.run(ctx, () => {
      store.recordSearch({
        ts: Date.now(),
        tool: 'search',
        groupName: 'g',
        anchorProject: 'service-a',
        queryText: 'login flow',
        queryHash: hashQuery('login flow'),
        queryTokens: tokenizeQuery('login flow'),
        limit: 5,
        durationMs: 30,
        resultCount: 4,
        cacheHit: false,
        error: null,
        results: [
          {
            rank: 0,
            project: 'service-a',
            file: 'a.ts',
            language: 'ts',
            score: 0.9,
            startLine: 1,
            endLine: 5,
            chunkLines: 5,
            fileTotalLines: 50,
            chunkId: 'A',
          },
          {
            rank: 1,
            project: 'service-b',
            file: 'b.ts',
            language: 'ts',
            score: 0.8,
            startLine: 1,
            endLine: 5,
            chunkLines: 5,
            fileTotalLines: 50,
            chunkId: 'B',
          },
          {
            rank: 2,
            project: 'service-c',
            file: 'c.ts',
            language: 'ts',
            score: 0.7,
            startLine: 1,
            endLine: 5,
            chunkLines: 5,
            fileTotalLines: 50,
            chunkId: 'C',
          },
          {
            rank: 3,
            project: 'service-d',
            file: 'd.ts',
            language: 'ts',
            score: 0.6,
            startLine: 1,
            endLine: 5,
            chunkLines: 5,
            fileTotalLines: 50,
            chunkId: 'D',
          },
        ],
      });
    });

    const rows = crossProjectShare(store, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.anchor_project).toBe('service-a');
    expect(rows[0]!.share).toBeCloseTo(0.75, 2);
  });

  it('retry_rate detects reformulations within the window', () => {
    const t0 = Date.now() - 60_000;
    const event = (ts: number, q: string, results: number) => {
      tctx.run(newContext({ user: 'alice', session: 'sess' }), () => {
        store.recordSearch({
          ts,
          tool: 'search',
          groupName: 'g',
          anchorProject: null,
          queryText: q,
          queryHash: hashQuery(q),
          queryTokens: tokenizeQuery(q),
          limit: 5,
          durationMs: 10,
          resultCount: results,
          cacheHit: false,
          error: null,
          results: Array.from({ length: results }, (_, i) => ({
            rank: i,
            project: 'p',
            file: 'f.ts',
            language: 'ts',
            score: 0.7,
            startLine: i,
            endLine: i + 1,
            chunkLines: 2,
            fileTotalLines: 50,
            chunkId: `R${ts}-${i}`,
          })),
        });
      });
    };
    event(t0, 'auth login flow', 1);
    // Same tokens — 100% Jaccard, definitively a reformulation.
    event(t0 + 5_000, 'auth login flow ?', 1);

    const rows = retryRate(store, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user).toBe('alice');
    expect(rows[0]!.total_searches).toBe(2);
    expect(rows[0]!.reformulations).toBeGreaterThanOrEqual(1);
  });

  it('top_queries deduplicates by query_hash', () => {
    const baseTs = Date.now() - 60_000;
    for (let i = 0; i < 3; i++) {
      tctx.run(newContext({ user: 'alice' }), () => {
        store.recordSearch({
          ts: baseTs + i * 100,
          tool: 'search',
          groupName: 'g',
          anchorProject: null,
          queryText: 'duplicate query',
          queryHash: hashQuery('duplicate query'),
          queryTokens: tokenizeQuery('duplicate query'),
          limit: 5,
          durationMs: 10,
          resultCount: 0,
          cacheHit: false,
          error: null,
          results: [],
        });
      });
    }
    const rows = topQueries(store, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
  });

  it('failed_chunks aggregates by error_class', () => {
    store.recordChunkingError({
      ts: Date.now(),
      runId: null,
      groupName: 'g',
      projectName: 'p',
      file: 'a.ts',
      language: 'ts',
      errorClass: 'ast_chunk_zero',
      message: null,
    });
    store.recordChunkingError({
      ts: Date.now(),
      runId: null,
      groupName: 'g',
      projectName: 'p',
      file: 'b.ts',
      language: 'ts',
      errorClass: 'ast_chunk_zero',
      message: null,
    });
    store.recordChunkingError({
      ts: Date.now(),
      runId: null,
      groupName: 'g',
      projectName: 'p',
      file: 'c.go',
      language: 'go',
      errorClass: 'regex_fallback',
      message: 'parse error',
    });

    const rows = failedChunks(store, {});
    expect(rows.length).toBeGreaterThan(0);
    const ast = rows.find((r) => r.error_class === 'ast_chunk_zero');
    expect(ast?.count).toBe(2);
  });
});
