import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { MetadataStore } from '../src/metadata-db.js';
import { extractGitMetadata } from '../src/git-metadata.js';
import { toCollectionName } from '../src/indexer.js';

function createTempDir(): string {
  const tmpDir = path.join(
    os.tmpdir(),
    `paparats-gitmeta-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
}

function gitAdd(dir: string, file: string, content: string): void {
  const filePath = path.join(dir, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  execSync(`git add "${file}"`, { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir: string, message: string): string {
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'ignore' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

describe('extractGitMetadata', () => {
  let tmpDir: string;
  let dbDir: string;
  let store: MetadataStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    dbDir = createTempDir();
    store = new MetadataStore(path.join(dbDir, 'test-metadata.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('extracts commits and tickets from a git repo', async () => {
    // Create a git repo with commits containing ticket references
    gitInit(tmpDir);
    gitAdd(tmpDir, 'src/auth.ts', 'export function login() { return true; }');
    const hash1 = gitCommit(tmpDir, 'feat: add login PROJ-123');

    gitAdd(
      tmpDir,
      'src/auth.ts',
      'export function login() { return true; }\nexport function logout() { return false; }'
    );
    const hash2 = gitCommit(tmpDir, 'fix: logout bug #42');

    // Create a mock Qdrant client
    const mockQdrantClient = {
      setPayload: vi.fn().mockResolvedValue(undefined),
    };

    // Simulate indexed chunks for the file
    const chunksByFile = new Map([
      ['src/auth.ts', [{ chunk_id: 'g//p//src/auth.ts//1-2//h1', startLine: 1, endLine: 2 }]],
    ]);

    const result = await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile,
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.commitsStored).toBeGreaterThanOrEqual(1);

    // Verify commits stored in metadata db
    const commits = store.getCommits('g//p//src/auth.ts//1-2//h1');
    expect(commits.length).toBeGreaterThanOrEqual(1);

    // Both commits should affect the chunk (lines 1-2)
    const commitHashes = commits.map((c) => c.commit_hash);
    expect(commitHashes).toContain(hash2);
    // hash1 may or may not appear depending on hunk overlap — initial add has no hunks, so it's included conservatively
    expect(commitHashes).toContain(hash1);

    // Verify tickets extracted
    const tickets = store.getTickets('g//p//src/auth.ts//1-2//h1');
    const ticketKeys = tickets.map((t) => t.ticket_key);
    expect(ticketKeys).toContain('PROJ-123');
    expect(ticketKeys).toContain('#42');

    // Verify Qdrant payload updated
    expect(mockQdrantClient.setPayload).toHaveBeenCalled();
    const payloadCall = mockQdrantClient.setPayload.mock.calls[0];
    expect(payloadCall![0]).toBe(toCollectionName('g'));
    const payloadArg = payloadCall![1] as { payload: Record<string, unknown> };
    expect(payloadArg.payload).toHaveProperty('last_commit_hash');
    expect(payloadArg.payload).toHaveProperty('last_commit_at');
    expect(payloadArg.payload).toHaveProperty('last_author_email');
    expect(payloadArg.payload).toHaveProperty('ticket_keys');
  });

  it('returns zero counts when no files have git history', async () => {
    gitInit(tmpDir);

    const mockQdrantClient = {
      setPayload: vi.fn().mockResolvedValue(undefined),
    };

    // Empty map — no files to process
    const chunksByFile = new Map<
      string,
      { chunk_id: string; startLine: number; endLine: number }[]
    >();

    const result = await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile,
    });

    expect(result.filesProcessed).toBe(0);
    expect(result.commitsStored).toBe(0);
    expect(result.ticketsStored).toBe(0);
  });

  it('uses custom ticket patterns', async () => {
    gitInit(tmpDir);
    gitAdd(tmpDir, 'src/foo.ts', 'const x = 1;');
    gitCommit(tmpDir, 'fix: resolve TASK_99 issue');

    const mockQdrantClient = {
      setPayload: vi.fn().mockResolvedValue(undefined),
    };

    const chunksByFile = new Map([
      ['src/foo.ts', [{ chunk_id: 'g//p//src/foo.ts//1-1//h1', startLine: 1, endLine: 1 }]],
    ]);

    const result = await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: ['TASK_(\\d+)'],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile,
    });

    expect(result.ticketsStored).toBeGreaterThanOrEqual(1);

    const tickets = store.getTickets('g//p//src/foo.ts//1-1//h1');
    const customTickets = tickets.filter((t) => t.source === 'custom');
    expect(customTickets).toHaveLength(1);
    expect(customTickets[0]!.ticket_key).toBe('99');
  });

  it('handles overlap correctly — only affected chunks get commits', async () => {
    gitInit(tmpDir);

    // First commit: create file with 3 lines
    gitAdd(tmpDir, 'src/big.ts', 'line1\nline2\nline3');
    gitCommit(tmpDir, 'initial commit');

    // Second commit: modify only line 3
    gitAdd(tmpDir, 'src/big.ts', 'line1\nline2\nline3_modified');
    const hash2 = gitCommit(tmpDir, 'fix: modify line 3');

    const mockQdrantClient = {
      setPayload: vi.fn().mockResolvedValue(undefined),
    };

    // Two chunks: lines 1-1 and lines 3-3
    const chunksByFile = new Map([
      [
        'src/big.ts',
        [
          { chunk_id: 'g//p//src/big.ts//1-1//h1', startLine: 1, endLine: 1 },
          { chunk_id: 'g//p//src/big.ts//3-3//h2', startLine: 3, endLine: 3 },
        ],
      ],
    ]);

    await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile,
    });

    // Chunk at line 3 should have both commits (initial + modification)
    const chunk3Commits = store.getCommits('g//p//src/big.ts//3-3//h2');
    const chunk3Hashes = chunk3Commits.map((c) => c.commit_hash);
    expect(chunk3Hashes).toContain(hash2);

    // Chunk at line 1 should have the initial commit but NOT the line-3-only change
    const chunk1Commits = store.getCommits('g//p//src/big.ts//1-1//h1');
    const chunk1Hashes = chunk1Commits.map((c) => c.commit_hash);
    // hash2 only affects line 3 so chunk at line 1 should NOT have it
    expect(chunk1Hashes).not.toContain(hash2);
  });

  it('gracefully handles Qdrant setPayload failure', async () => {
    gitInit(tmpDir);
    gitAdd(tmpDir, 'src/bar.ts', 'const y = 2;');
    gitCommit(tmpDir, 'feat: add bar');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockQdrantClient = {
      setPayload: vi.fn().mockRejectedValue(new Error('Qdrant down')),
    };

    const chunksByFile = new Map([
      ['src/bar.ts', [{ chunk_id: 'g//p//src/bar.ts//1-1//h1', startLine: 1, endLine: 1 }]],
    ]);

    // Should not throw — Qdrant error is caught
    const result = await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile,
    });

    expect(result.filesProcessed).toBe(1);
    // Commits still stored in SQLite
    const commits = store.getCommits('g//p//src/bar.ts//1-1//h1');
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('extractGitMetadata git cache', () => {
  let tmpDir: string;
  let dbDir: string;
  let store: MetadataStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    dbDir = createTempDir();
    store = new MetadataStore(path.join(dbDir, 'test-metadata.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  function currentHead(dir: string): string {
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  }

  function runExtraction(chunksByFile: Map<string, never[]> | Map<string, object[]>) {
    const mockQdrantClient = { setPayload: vi.fn().mockResolvedValue(undefined) };
    return extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile: chunksByFile as never,
    });
  }

  const chunkId = 'g//p//src/auth.ts//1-2//h1';
  const chunksByFile = () =>
    new Map([['src/auth.ts', [{ chunk_id: chunkId, startLine: 1, endLine: 2 }]]]);

  it('uses cached git data when repo HEAD matches', async () => {
    gitInit(tmpDir);
    gitAdd(
      tmpDir,
      'src/auth.ts',
      'export function login() { return true; }\nexport const x = 1;\n'
    );
    gitCommit(tmpDir, 'feat: real commit');

    // Seed a fake cache entry at the current HEAD — if the cache is consulted,
    // the fake commit lands in the store instead of the real one.
    store.setGitFileCache(
      'g',
      'p',
      'src/auth.ts',
      currentHead(tmpDir),
      [
        {
          hash: 'cafebabe',
          date: '2024-01-01T00:00:00Z',
          email: 'cache@test.com',
          subject: 'fake: cached',
        },
      ],
      [{ commitHash: 'cafebabe', startLine: 1, endLine: 10 }]
    );

    await runExtraction(chunksByFile());

    const commits = store.getCommits(chunkId);
    expect(commits.map((c) => c.commit_hash)).toEqual(['cafebabe']);
  });

  it('populates the cache after extraction', async () => {
    gitInit(tmpDir);
    gitAdd(
      tmpDir,
      'src/auth.ts',
      'export function login() { return true; }\nexport const x = 1;\n'
    );
    const realHash = gitCommit(tmpDir, 'feat: real commit');

    await runExtraction(chunksByFile());

    const cached = store.getGitFileCache('g', 'p', 'src/auth.ts', currentHead(tmpDir));
    expect(cached).not.toBeNull();
    expect(cached!.commits.map((c) => c.hash)).toContain(realHash);
  });

  // PAPARATS_PROJECT_SUFFIX: the indexer passes the SUFFIXED project name (e.g.
  // `p-v3`) as `project`. That name must flow into both the git_file_cache
  // (real project column) and the chunk_id-keyed commits, so a second stand
  // never reads or overwrites the un-suffixed stand's git enrichment.
  it('writes git_file_cache and commits under the suffixed project name', async () => {
    gitInit(tmpDir);
    gitAdd(
      tmpDir,
      'src/auth.ts',
      'export function login() { return true; }\nexport const x = 1;\n'
    );
    const realHash = gitCommit(tmpDir, 'feat: real commit');

    const suffixedChunkId = 'g//p-v3//src/auth.ts//1-2//h1';
    const mockQdrantClient = { setPayload: vi.fn().mockResolvedValue(undefined) };
    await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p-v3',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile: new Map([
        ['src/auth.ts', [{ chunk_id: suffixedChunkId, startLine: 1, endLine: 2 }]],
      ]),
    });

    // Cache is keyed by the suffixed name; the un-suffixed name misses.
    const cached = store.getGitFileCache('g', 'p-v3', 'src/auth.ts', currentHead(tmpDir));
    expect(cached).not.toBeNull();
    expect(cached!.commits.map((c) => c.hash)).toContain(realHash);
    expect(store.getGitFileCache('g', 'p', 'src/auth.ts', currentHead(tmpDir))).toBeNull();

    // Commits land on the suffixed chunk_id.
    expect(store.getCommits(suffixedChunkId).map((c) => c.commit_hash)).toContain(realHash);
  });

  it('ignores stale cache when HEAD changed', async () => {
    gitInit(tmpDir);
    gitAdd(
      tmpDir,
      'src/auth.ts',
      'export function login() { return true; }\nexport const x = 1;\n'
    );
    gitCommit(tmpDir, 'feat: first');
    const oldHead = currentHead(tmpDir);

    store.setGitFileCache(
      'g',
      'p',
      'src/auth.ts',
      oldHead,
      [
        {
          hash: 'cafebabe',
          date: '2024-01-01T00:00:00Z',
          email: 'cache@test.com',
          subject: 'fake: cached',
        },
      ],
      [{ commitHash: 'cafebabe', startLine: 1, endLine: 10 }]
    );

    gitAdd(
      tmpDir,
      'src/auth.ts',
      'export function login() { return false; }\nexport const x = 2;\n'
    );
    const newHash = gitCommit(tmpDir, 'fix: second');

    await runExtraction(chunksByFile());

    const commits = store.getCommits(chunkId);
    const hashes = commits.map((c) => c.commit_hash);
    expect(hashes).toContain(newHash);
    expect(hashes).not.toContain('cafebabe');
  });
});

describe('extractGitMetadata on non-git directories', () => {
  let tmpDir: string;
  let dbDir: string;
  let store: MetadataStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    dbDir = createTempDir();
    store = new MetadataStore(path.join(dbDir, 'test-metadata.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('returns early without spawning per-file git processes', async () => {
    // No gitInit — tmpDir is a plain directory
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockQdrantClient = { setPayload: vi.fn().mockResolvedValue(undefined) };

    const chunksByFile = new Map([
      ['src/a.ts', [{ chunk_id: 'g//p//src/a.ts//1-2//h1', startLine: 1, endLine: 2 }]],
      ['src/b.ts', [{ chunk_id: 'g//p//src/b.ts//1-2//h1', startLine: 1, endLine: 2 }]],
    ]);

    const result = await extractGitMetadata({
      projectPath: tmpDir,
      group: 'g',
      project: 'p',
      maxCommitsPerFile: 50,
      ticketPatterns: [],
      metadataStore: store,
      qdrantClient: mockQdrantClient as never,
      chunksByFile,
    });

    expect(result).toEqual({ filesProcessed: 0, commitsStored: 0, ticketsStored: 0 });
    // Without the early return each file logs a per-file git failure warning
    expect(warnSpy).not.toHaveBeenCalled();
    expect(mockQdrantClient.setPayload).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
