import { execFile } from 'child_process';
import { promisify } from 'util';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type { MetadataStore } from './metadata-db.js';
import { extractTickets } from './ticket-extractor.js';
import { toCollectionName } from './indexer.js';

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

interface CommitInfo {
  hash: string;
  date: string;
  email: string;
  subject: string;
}

interface DiffHunk {
  commitHash: string;
  startLine: number;
  endLine: number;
}

interface IndexedChunk {
  chunk_id: string;
  startLine: number;
  endLine: number;
}

export interface ExtractGitMetadataOptions {
  projectPath: string;
  group: string;
  project: string;
  maxCommitsPerFile: number;
  ticketPatterns: string[];
  metadataStore: MetadataStore;
  qdrantClient: QdrantClient;
  chunksByFile: Map<string, IndexedChunk[]>;
}

export interface ExtractGitMetadataResult {
  filesProcessed: number;
  commitsStored: number;
  ticketsStored: number;
}

// ── Collect indexed chunks from Qdrant ─────────────────────────────────────

export async function collectIndexedChunks(
  qdrantClient: QdrantClient,
  group: string,
  project: string
): Promise<Map<string, IndexedChunk[]>> {
  const chunksByFile = new Map<string, IndexedChunk[]>();
  let offset: string | number | undefined = undefined;

  // Scroll through all project chunks
  for (;;) {
    const result = await qdrantClient.scroll(toCollectionName(group), {
      filter: {
        must: [{ key: 'project', match: { value: project } }],
      },
      with_payload: { include: ['chunk_id', 'file', 'startLine', 'endLine'] },
      with_vector: false,
      limit: 1000,
      ...(offset !== undefined ? { offset } : {}),
    });

    for (const point of result.points) {
      const payload = point.payload as Record<string, unknown> | null;
      if (!payload) continue;

      const chunkId = payload['chunk_id'] as string | undefined;
      const file = payload['file'] as string | undefined;
      const startLine = payload['startLine'] as number | undefined;
      const endLine = payload['endLine'] as number | undefined;

      if (!chunkId || !file || startLine === undefined || endLine === undefined) continue;

      const chunks = chunksByFile.get(file) ?? [];
      chunks.push({ chunk_id: chunkId, startLine, endLine });
      chunksByFile.set(file, chunks);
    }

    if (!result.next_page_offset) break;
    offset = result.next_page_offset as string | number;
  }

  return chunksByFile;
}

// ── Git log parsing ────────────────────────────────────────────────────────

async function getFileCommits(
  projectPath: string,
  filePath: string,
  maxCommits: number
): Promise<CommitInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        `--max-count=${maxCommits}`,
        '--pretty=format:%H|%aI|%ae|%s',
        '--follow',
        '--',
        filePath,
      ],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );

    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, date, email, ...subjectParts] = line.split('|');
        if (!hash || !date || !email) return null;
        return {
          hash,
          date,
          email,
          subject: subjectParts.join('|'),
        };
      })
      .filter((c): c is CommitInfo => c !== null);
  } catch (err) {
    console.warn(
      `[git-metadata] Failed to get commits for ${filePath} in ${projectPath}: ${(err as Error).message}`
    );
    return [];
  }
}

async function getFileDiffHunks(
  projectPath: string,
  filePath: string,
  maxCommits: number
): Promise<DiffHunk[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        `--max-count=${maxCommits}`,
        '-p',
        '--follow',
        '-U0',
        '--pretty=format:COMMIT:%H',
        '--',
        filePath,
      ],
      { cwd: projectPath, maxBuffer: 10 * 1024 * 1024 }
    );

    if (!stdout.trim()) return [];

    const hunks: DiffHunk[] = [];
    let currentCommit: string | null = null;

    for (const line of stdout.split('\n')) {
      if (line.startsWith('COMMIT:')) {
        currentCommit = line.slice(7);
        continue;
      }

      if (!currentCommit) continue;

      // Parse @@ -a,b +c,d @@ hunk headers — we care about the + (new file) side
      const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (hunkMatch) {
        const start = parseInt(hunkMatch[1]!, 10);
        const count = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        const end = count === 0 ? start : start + count - 1;
        hunks.push({ commitHash: currentCommit, startLine: start, endLine: end });
      }
    }

    return hunks;
  } catch (err) {
    console.warn(
      `[git-metadata] Failed to get diff hunks for ${filePath} in ${projectPath}: ${(err as Error).message}`
    );
    return [];
  }
}

// ── Overlap check ──────────────────────────────────────────────────────────

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

function getChunksForCommit(
  commitHash: string,
  hunks: DiffHunk[],
  chunks: IndexedChunk[]
): IndexedChunk[] {
  const commitHunks = hunks.filter((h) => h.commitHash === commitHash);

  // If no hunks found (e.g. initial commit, renames), conservatively include all chunks
  if (commitHunks.length === 0) {
    return chunks;
  }

  return chunks.filter((chunk) =>
    commitHunks.some((hunk) =>
      rangesOverlap(chunk.startLine, chunk.endLine, hunk.startLine, hunk.endLine)
    )
  );
}

// ── Main extraction ────────────────────────────────────────────────────────

export async function extractGitMetadata(
  options: ExtractGitMetadataOptions
): Promise<ExtractGitMetadataResult> {
  const {
    projectPath,
    group,
    maxCommitsPerFile,
    ticketPatterns,
    metadataStore,
    qdrantClient,
    chunksByFile,
  } = options;

  let filesProcessed = 0;
  let commitsStored = 0;
  let ticketsStored = 0;

  for (const [filePath, chunks] of chunksByFile) {
    const [commits, hunks] = await Promise.all([
      getFileCommits(projectPath, filePath, maxCommitsPerFile),
      getFileDiffHunks(projectPath, filePath, maxCommitsPerFile),
    ]);

    if (commits.length === 0) continue;
    filesProcessed++;

    // Collect Qdrant payload updates for this file, then batch them
    const pendingUpdates: Array<{ chunkId: string; payload: Record<string, unknown> }> = [];

    for (const chunk of chunks) {
      // Find which commits affected this chunk
      const affectingCommits = commits.filter((commit) => {
        const affectedChunks = getChunksForCommit(commit.hash, hunks, [chunk]);
        return affectedChunks.length > 0;
      });

      if (affectingCommits.length === 0) continue;

      // Store commits
      metadataStore.upsertCommits(
        chunk.chunk_id,
        affectingCommits.map((c) => ({
          commit_hash: c.hash,
          committed_at: c.date,
          author_email: c.email,
          message_summary: c.subject,
        }))
      );
      commitsStored += affectingCommits.length;

      // Extract and store tickets from all affecting commit messages
      const allTickets = new Map<
        string,
        { ticket_key: string; source: 'jira' | 'github' | 'custom' }
      >();
      for (const commit of affectingCommits) {
        const extracted = extractTickets(commit.subject, ticketPatterns);
        for (const t of extracted) {
          allTickets.set(t.key, { ticket_key: t.key, source: t.source });
        }
      }

      if (allTickets.size > 0) {
        metadataStore.upsertTickets(chunk.chunk_id, Array.from(allTickets.values()));
        ticketsStored += allTickets.size;
      }

      // Build Qdrant payload update
      const latest = metadataStore.getLatestCommit(chunk.chunk_id);
      const tickets = metadataStore.getTickets(chunk.chunk_id);

      const payloadUpdate: Record<string, unknown> = {};
      if (latest) {
        payloadUpdate['last_commit_hash'] = latest.commit_hash;
        payloadUpdate['last_commit_at'] = latest.committed_at;
        payloadUpdate['last_author_email'] = latest.author_email;
      }
      if (tickets.length > 0) {
        payloadUpdate['ticket_keys'] = tickets.map((t) => t.ticket_key);
      }

      if (Object.keys(payloadUpdate).length > 0) {
        pendingUpdates.push({ chunkId: chunk.chunk_id, payload: payloadUpdate });
      }
    }

    // Batch Qdrant payload updates for all chunks in this file
    if (pendingUpdates.length > 0) {
      const results = await Promise.allSettled(
        pendingUpdates.map((update) =>
          qdrantClient.setPayload(toCollectionName(group), {
            payload: update.payload,
            filter: {
              must: [{ key: 'chunk_id', match: { value: update.chunkId } }],
            },
          })
        )
      );
      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        if (result.status === 'rejected') {
          console.warn(
            `[git-metadata] Failed to update Qdrant payload for ${pendingUpdates[i]!.chunkId}: ${result.reason}`
          );
        }
      }
    }
  }

  return { filesProcessed, commitsStored, ticketsStored };
}
