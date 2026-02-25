import { QdrantClient } from '@qdrant/js-client-rest';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import { filterFilesByGitignore } from '@paparats/shared';
import { v7 as uuidv7 } from 'uuid';
import PQueue from 'p-queue';
import { Chunker } from './chunker.js';
import { resolveTags } from './metadata.js';
import { extractGitMetadata } from './git-metadata.js';
import type { MetadataStore } from './metadata-db.js';
import type { CachedEmbeddingProvider } from './embeddings.js';
import type { TreeSitterManager } from './tree-sitter-parser.js';
import { extractSymbolsForChunks } from './ast-symbol-extractor.js';
import type { SymbolExtractionResult } from './ast-symbol-extractor.js';
import { buildSymbolEdges } from './symbol-graph.js';
import { chunkByAst } from './ast-chunker.js';
import type { ChunkResult, ProjectConfig, IndexerStats } from './types.js';

// ── Collection name helpers ──────────────────────────────────────────────────

const COLLECTION_PREFIX = 'paparats_';

/** Map a logical group name to a Qdrant collection name */
export function toCollectionName(group: string): string {
  return `${COLLECTION_PREFIX}${group}`;
}

/** Map a Qdrant collection name back to a logical group name */
export function fromCollectionName(collection: string): string {
  return collection.startsWith(COLLECTION_PREFIX)
    ? collection.slice(COLLECTION_PREFIX.length)
    : collection;
}

/**
 * Create a QdrantClient with correct port handling for HTTPS URLs.
 * The JS client defaults to port 6333 when no port is in the URL,
 * which breaks Qdrant Cloud (HTTPS on port 443).
 */
export function createQdrantClient(opts: {
  url: string;
  apiKey?: string;
  timeout?: number;
}): QdrantClient {
  const parsed = new URL(opts.url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 6333;
  return new QdrantClient({
    url: opts.url,
    apiKey: opts.apiKey,
    port,
    checkCompatibility: false,
    timeout: opts.timeout ?? 30_000,
  });
}

// ── Chunk ID helpers ────────────────────────────────────────────────────────

/**
 * Build a stable, deterministic chunk_id from its components.
 * Format: {group}//{project}//{file}//{startLine}-{endLine}//{hash}
 */
export function buildChunkId(
  group: string,
  project: string,
  file: string,
  startLine: number,
  endLine: number,
  hash: string
): string {
  return `${group}//${project}//${file}//${startLine}-${endLine}//${hash}`;
}

/**
 * Parse a chunk_id back into its components.
 * Returns null if the format is invalid.
 */
export function parseChunkId(chunkId: string): {
  group: string;
  project: string;
  file: string;
  startLine: number;
  endLine: number;
  hash: string;
} | null {
  const parts = chunkId.split('//');
  if (parts.length !== 5) return null;

  const [group, project, file, lineRange, hash] = parts;
  if (!group || !project || !file || !lineRange || !hash) return null;

  const lineParts = lineRange.split('-');
  if (lineParts.length !== 2) return null;

  const startLine = parseInt(lineParts[0]!, 10);
  const endLine = parseInt(lineParts[1]!, 10);

  if (isNaN(startLine) || isNaN(endLine)) return null;

  return { group, project, file, startLine, endLine, hash };
}

export interface IndexerConfig {
  qdrantUrl: string;
  /** Qdrant API key for authenticated access (e.g. Qdrant Cloud) */
  qdrantApiKey?: string;
  embeddingProvider: CachedEmbeddingProvider;
  dimensions: number;
  /** Qdrant request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional Qdrant client for testing (skips creating from qdrantUrl) */
  qdrantClient?: QdrantClient;
  /** Optional metadata store for git history enrichment */
  metadataStore?: MetadataStore;
  /** Optional tree-sitter manager for AST-based symbol extraction */
  treeSitter?: TreeSitterManager;
}

/** Qdrant timeout in milliseconds (default: 30s) */
const QDRANT_TIMEOUT_MS = 30_000;
const QDRANT_MAX_RETRIES = 3;

export class Indexer {
  private qdrant: QdrantClient;
  private chunkers = new Map<string, Chunker>();
  private provider: CachedEmbeddingProvider;
  private dimensions: number;
  private metadataStore: MetadataStore | null;
  private treeSitter: TreeSitterManager | null;
  stats: IndexerStats;

  constructor(config: IndexerConfig) {
    this.qdrant =
      config.qdrantClient ??
      createQdrantClient({
        url: config.qdrantUrl,
        apiKey: config.qdrantApiKey,
        timeout: config.timeout ?? QDRANT_TIMEOUT_MS,
      });
    this.provider = config.embeddingProvider;
    this.dimensions = config.dimensions;
    this.metadataStore = config.metadataStore ?? null;
    this.treeSitter = config.treeSitter ?? null;
    this.stats = { files: 0, chunks: 0, cached: 0, errors: 0, skipped: 0 };
  }

  /** Expose Qdrant client for git-metadata enrichment */
  get qdrantClient(): QdrantClient {
    return this.qdrant;
  }

  /** Map logical group name to Qdrant collection name (paparats_ prefix) */
  col(group: string): string {
    return toCollectionName(group);
  }

  private getChunker(project: ProjectConfig): Chunker {
    const key = `${project.indexing.chunkSize}:${project.indexing.overlap}`;
    if (!this.chunkers.has(key)) {
      this.chunkers.set(
        key,
        new Chunker({
          chunkSize: project.indexing.chunkSize,
          overlap: project.indexing.overlap,
        })
      );
    }
    return this.chunkers.get(key)!;
  }

  private async retryQdrant<T>(fn: () => Promise<T>, retries = QDRANT_MAX_RETRIES): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        if (attempt < retries - 1) {
          const delay = 1000 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delay));
          console.warn(
            `[indexer] Qdrant operation failed, retrying (${attempt + 1}/${retries})...`
          );
        }
      }
    }
    throw new Error(`Qdrant failed after ${retries} retries: ${lastError?.message}`);
  }

  /** Fetch existing chunk hashes for a file from Qdrant */
  private async getFileChunkHashes(
    groupName: string,
    projectName: string,
    relPath: string
  ): Promise<Set<string>> {
    try {
      const hashes = new Set<string>();
      let offset: string | number | undefined = undefined;

      for (;;) {
        const result = await this.qdrant.scroll(this.col(groupName), {
          filter: {
            must: [
              { key: 'project', match: { value: projectName } },
              { key: 'file', match: { value: relPath } },
            ],
          },
          with_payload: { include: ['hash'] },
          with_vector: false,
          limit: 1000,
          ...(offset !== undefined ? { offset } : {}),
        });

        for (const point of result.points) {
          const hash = (point.payload as Record<string, unknown> | null)?.['hash'];
          if (typeof hash === 'string') {
            hashes.add(hash);
          }
        }

        if (!result.next_page_offset) break;
        offset = result.next_page_offset as string | number;
      }

      return hashes;
    } catch (err) {
      console.warn(
        `[indexer] Failed to get chunk hashes for ${projectName}/${relPath}: ${(err as Error).message}`
      );
      return new Set<string>();
    }
  }

  /** Get all unique file paths currently indexed for a project in Qdrant */
  private async getIndexedFilePaths(groupName: string, projectName: string): Promise<Set<string>> {
    const files = new Set<string>();
    let offset: string | number | undefined = undefined;

    try {
      for (;;) {
        const result = await this.qdrant.scroll(this.col(groupName), {
          filter: {
            must: [{ key: 'project', match: { value: projectName } }],
          },
          with_payload: { include: ['file'] },
          with_vector: false,
          limit: 1000,
          ...(offset !== undefined ? { offset } : {}),
        });

        for (const point of result.points) {
          const file = (point.payload as Record<string, unknown> | null)?.['file'];
          if (typeof file === 'string') {
            files.add(file);
          }
        }

        if (!result.next_page_offset) break;
        offset = result.next_page_offset as string | number;
      }
    } catch (err) {
      console.warn(
        `[indexer] Failed to get indexed file paths for ${projectName}: ${(err as Error).message}`
      );
    }

    return files;
  }

  /** Remove Qdrant chunks and metadata for files that are no longer present */
  private async cleanupOrphanedChunks(
    groupName: string,
    projectName: string,
    currentFilePaths: Set<string>
  ): Promise<void> {
    try {
      const indexedPaths = await this.getIndexedFilePaths(groupName, projectName);
      const orphaned = Array.from(indexedPaths).filter((p) => !currentFilePaths.has(p));

      if (orphaned.length > 0) {
        for (const relPath of orphaned) {
          await this.retryQdrant(() =>
            this.qdrant.delete(this.col(groupName), {
              filter: {
                must: [
                  { key: 'project', match: { value: projectName } },
                  { key: 'file', match: { value: relPath } },
                ],
              },
              wait: true,
            })
          );
          this.metadataStore?.deleteByFile(groupName, projectName, relPath);
        }
        console.log(
          `  [indexer] Removed ${orphaned.length} orphaned file(s): ${orphaned.join(', ')}`
        );
      }
    } catch (err) {
      console.warn(`  [indexer] Orphan cleanup failed (non-fatal): ${(err as Error).message}`);
    }
  }

  private hashSetsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const h of a) {
      if (!b.has(h)) return false;
    }
    return true;
  }

  /**
   * Parse once, chunk by AST (with regex fallback), and extract symbols from the same tree.
   * Returns chunks and optional symbol results.
   */
  private async chunkFile(
    content: string,
    language: string,
    project: ProjectConfig
  ): Promise<{ chunks: ChunkResult[]; symbolResults: SymbolExtractionResult[] | null }> {
    // Try AST-based chunking + symbol extraction (single parse)
    if (this.treeSitter) {
      try {
        const parsed = await this.treeSitter.parseFile(content, language);
        if (parsed) {
          try {
            const astConfig = {
              chunkSize: project.indexing.chunkSize,
              maxChunkSize: project.indexing.chunkSize * 3,
            };
            let chunks = chunkByAst(parsed.tree, content, astConfig);

            if (chunks.length === 0) {
              // AST chunking produced 0 chunks — fall back to regex
              const chunker = this.getChunker(project);
              chunks = chunker.chunk(content, language);
            }

            // Extract symbols from the same tree (no re-parse)
            const symbolResults = extractSymbolsForChunks(
              parsed.tree,
              parsed.language,
              chunks.map((c) => ({ startLine: c.startLine, endLine: c.endLine })),
              language
            );
            return { chunks, symbolResults };
          } catch (err) {
            console.warn(
              `[indexer] AST chunking/symbol extraction failed, falling back to regex: ${(err as Error).message}`
            );
            // Fall back to regex chunker, no symbols (tree may be in bad state)
            const chunker = this.getChunker(project);
            const chunks = chunker.chunk(content, language);
            return { chunks, symbolResults: null };
          } finally {
            parsed.tree.delete();
          }
        }
      } catch (err) {
        console.warn(`[indexer] Tree-sitter parse failed (non-fatal): ${(err as Error).message}`);
      }
    }

    // No tree-sitter available — regex chunker only, no symbols
    const chunker = this.getChunker(project);
    const chunks = chunker.chunk(content, language);
    return { chunks, symbolResults: null };
  }

  /** Build Qdrant point payloads from chunks, embeddings, and symbol results */
  private buildPointPayloads(
    chunks: ChunkResult[],
    embeddings: number[][],
    groupName: string,
    projectName: string,
    relPath: string,
    language: string,
    tags: string[],
    service: string,
    boundedContext: string | null,
    symbolResults: SymbolExtractionResult[] | null
  ): Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> {
    return chunks.map((chunk, i) => ({
      id: uuidv7(),
      vector: embeddings[i]!,
      payload: {
        project: projectName,
        file: relPath,
        language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        hash: chunk.hash,
        chunk_id: buildChunkId(
          groupName,
          projectName,
          relPath,
          chunk.startLine,
          chunk.endLine,
          chunk.hash
        ),
        symbol_name: symbolResults?.[i]?.defined_symbols?.[0]?.name ?? null,
        kind: symbolResults?.[i]?.defined_symbols?.[0]?.kind ?? null,
        service,
        bounded_context: boundedContext,
        tags,
        defines_symbols: symbolResults?.[i]?.defines_symbols ?? [],
        uses_symbols: symbolResults?.[i]?.uses_symbols ?? [],
      },
    }));
  }

  /** Ensure group collection exists in Qdrant */
  async ensureCollection(groupName: string): Promise<void> {
    try {
      await this.qdrant.getCollection(this.col(groupName));
      return;
    } catch {
      // Collection doesn't exist, try to create
    }

    try {
      await this.retryQdrant(() =>
        this.qdrant.createCollection(this.col(groupName), {
          vectors: {
            size: this.dimensions,
            distance: 'Cosine',
          },
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'project',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'file',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'chunk_id',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'kind',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'tags',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'last_commit_at',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'ticket_keys',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'defines_symbols',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(this.col(groupName), {
          field_name: 'uses_symbols',
          field_schema: 'keyword',
          wait: true,
        })
      );
    } catch (err) {
      // If creation failed, check if another process created it
      try {
        await this.qdrant.getCollection(this.col(groupName));
        // Collection exists now, that's OK
      } catch {
        throw err;
      }
    }
  }

  /** Index a single file into its group collection */
  async indexFile(groupName: string, project: ProjectConfig, filePath: string): Promise<number> {
    const relPath = path.relative(project.path, filePath);

    let content: string;
    try {
      const buffer = await fs.promises.readFile(filePath);
      if (buffer.includes(0)) return 0; // Binary file
      content = buffer.toString('utf8');
      if (content.includes('\uFFFD')) return 0; // Invalid UTF-8
    } catch (err) {
      console.error(`  Failed to read ${relPath}: ${(err as Error).message}`);
      return 0;
    }

    if (!content.trim()) return 0;

    const language = project.languages[0] ?? 'generic';
    const { chunks, symbolResults } = await this.chunkFile(content, language, project);
    if (chunks.length === 0) return 0;

    // Compare chunk hashes to skip unchanged files
    const newHashes = new Set(chunks.map((c) => c.hash));
    const existingHashes = await this.getFileChunkHashes(groupName, project.name, relPath);
    if (this.hashSetsEqual(newHashes, existingHashes)) {
      this.stats.skipped++;
      return 0;
    }

    // Delete old chunks if file was previously indexed
    if (existingHashes.size > 0) {
      await this.retryQdrant(() =>
        this.qdrant.delete(this.col(groupName), {
          filter: {
            must: [
              { key: 'project', match: { value: project.name } },
              { key: 'file', match: { value: relPath } },
            ],
          },
          wait: true,
        })
      );
    }

    const contents = chunks.map((c) => c.content);
    const embeddings = await this.provider.embedBatchPassage(contents);

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks in ${relPath}`
      );
    }

    const tags = resolveTags(project.metadata, relPath);

    const points = this.buildPointPayloads(
      chunks,
      embeddings,
      groupName,
      project.name,
      relPath,
      language,
      tags,
      project.metadata.service,
      project.metadata.bounded_context,
      symbolResults
    );

    const batchSize = project.indexing.batchSize;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.retryQdrant(() =>
        this.qdrant.upsert(this.col(groupName), { points: batch, wait: true })
      );
    }

    return points.length;
  }

  /** Index all files in a project into its group collection */
  async indexProject(project: ProjectConfig): Promise<number> {
    const groupName = project.group;

    if (!fs.existsSync(project.path)) {
      console.error(`  Project path not found: ${project.path}`);
      return 0;
    }

    await this.ensureCollection(groupName);

    const fileSet = new Set<string>();
    for (const pattern of project.patterns) {
      const found = await glob(pattern, {
        cwd: project.path,
        absolute: true,
        ignore: project.exclude,
        nodir: true,
      });
      found.forEach((f) => fileSet.add(f));
    }
    let files = Array.from(fileSet);
    if (project.indexing.respectGitignore) {
      files = filterFilesByGitignore(files, project.path);
    }
    console.log(`  ${files.length} files found`);

    const queue = new PQueue({ concurrency: project.indexing.concurrency });
    let totalChunks = 0;
    let processed = 0;

    const tasks = files.map((file) =>
      queue.add(async () => {
        try {
          const n = await this.indexFile(groupName, project, file);
          totalChunks += n;
          processed++;
          this.stats.files++;
          this.stats.chunks += n;

          if (processed % 20 === 0 || processed === files.length) {
            console.log(`  [${processed}/${files.length}] ${totalChunks} chunks`);
          }
        } catch (err) {
          this.stats.errors++;
          const rel = path.relative(project.path, file);
          console.error(`  Error indexing ${rel}:`);
          console.error(`    ${(err as Error).message}`);
          if (process.env.DEBUG) {
            console.error((err as Error).stack);
          }
        }
      })
    );

    await Promise.all(tasks);
    this.stats.cached = this.provider.cacheHits; // Update once after all tasks complete

    if (this.stats.skipped > 0) {
      console.log(`  [indexer] Skipped ${this.stats.skipped}/${files.length} files (unchanged)`);
    }

    // Clean up orphaned chunks (files deleted from disk but still in Qdrant)
    const currentRelPaths = new Set(files.map((f) => path.relative(project.path, f)));
    await this.cleanupOrphanedChunks(groupName, project.name, currentRelPaths);

    // Post-indexing: git metadata + symbol graph (single Qdrant scan for both)
    const needsGit = this.metadataStore && project.metadata.git.enabled && totalChunks > 0;
    const needsSymbols = this.metadataStore && this.treeSitter && totalChunks > 0;

    if (needsGit || needsSymbols) {
      try {
        const { chunksByFile, chunkSymbols } = await this.collectProjectChunksForPostIndex(
          groupName,
          project.name,
          !!needsGit,
          !!needsSymbols
        );

        // Git metadata extraction
        if (needsGit && chunksByFile.size > 0) {
          try {
            const result = await extractGitMetadata({
              projectPath: project.path,
              group: groupName,
              project: project.name,
              maxCommitsPerFile: project.metadata.git.maxCommitsPerFile,
              ticketPatterns: project.metadata.git.ticketPatterns,
              metadataStore: this.metadataStore!,
              qdrantClient: this.qdrant,
              chunksByFile,
            });
            console.log(
              `  [indexer] Git metadata: ${result.filesProcessed} files, ${result.commitsStored} commits, ${result.ticketsStored} tickets`
            );
          } catch (err) {
            console.warn(
              `  [indexer] Git metadata extraction failed (non-fatal): ${(err as Error).message}`
            );
          }
        }

        // Symbol graph building
        if (needsSymbols && chunkSymbols.length > 0) {
          try {
            const edges = buildSymbolEdges(chunkSymbols);
            this.metadataStore!.deleteEdgesByProject(groupName, project.name);
            if (edges.length > 0) {
              this.metadataStore!.upsertSymbolEdges(edges);
            }
            console.log(
              `  [indexer] Symbol graph: ${chunkSymbols.length} chunks, ${edges.length} edges`
            );
          } catch (err) {
            console.warn(
              `  [indexer] Symbol graph building failed (non-fatal): ${(err as Error).message}`
            );
          }
        }
      } catch (err) {
        console.warn(
          `  [indexer] Post-index data collection failed (non-fatal): ${(err as Error).message}`
        );
      }
    }

    return totalChunks;
  }

  /**
   * Single Qdrant scan for post-index data (git metadata + symbol graph).
   * Collects all needed fields in one pass instead of two separate scans.
   */
  private async collectProjectChunksForPostIndex(
    groupName: string,
    projectName: string,
    needsGit: boolean,
    needsSymbols: boolean
  ): Promise<{
    chunksByFile: Map<string, Array<{ chunk_id: string; startLine: number; endLine: number }>>;
    chunkSymbols: Array<{ chunk_id: string; defines_symbols: string[]; uses_symbols: string[] }>;
  }> {
    const chunksByFile = new Map<
      string,
      Array<{ chunk_id: string; startLine: number; endLine: number }>
    >();
    const chunkSymbols: Array<{
      chunk_id: string;
      defines_symbols: string[];
      uses_symbols: string[];
    }> = [];

    // Request all fields needed by both consumers
    const fields: string[] = ['chunk_id'];
    if (needsGit) fields.push('file', 'startLine', 'endLine');
    if (needsSymbols) fields.push('defines_symbols', 'uses_symbols');

    let offset: string | number | undefined = undefined;

    for (;;) {
      const page = await this.retryQdrant(() =>
        this.qdrant.scroll(this.col(groupName), {
          filter: {
            must: [{ key: 'project', match: { value: projectName } }],
          },
          with_payload: { include: fields },
          with_vector: false,
          limit: 100,
          ...(offset !== undefined ? { offset } : {}),
        })
      );

      for (const point of page.points) {
        const payload = point.payload as Record<string, unknown> | null;
        if (!payload) continue;
        const chunkId = payload['chunk_id'];
        if (typeof chunkId !== 'string') continue;

        // Populate git metadata map
        if (needsGit) {
          const file = payload['file'] as string | undefined;
          const startLine = payload['startLine'] as number | undefined;
          const endLine = payload['endLine'] as number | undefined;
          if (file && startLine !== undefined && endLine !== undefined) {
            const chunks = chunksByFile.get(file) ?? [];
            chunks.push({ chunk_id: chunkId, startLine, endLine });
            chunksByFile.set(file, chunks);
          }
        }

        // Populate symbol data
        if (needsSymbols) {
          const defs = payload['defines_symbols'];
          const uses = payload['uses_symbols'];
          chunkSymbols.push({
            chunk_id: chunkId,
            defines_symbols: Array.isArray(defs) ? (defs as string[]) : [],
            uses_symbols: Array.isArray(uses) ? (uses as string[]) : [],
          });
        }
      }

      if (!page.next_page_offset) break;
      offset = page.next_page_offset as string | number;
    }

    return { chunksByFile, chunkSymbols };
  }

  /** Index multiple projects (all in the same or different groups) */
  async indexAll(projects: ProjectConfig[]): Promise<void> {
    console.log('Starting full index...\n');
    const start = Date.now();

    for (const project of projects) {
      console.log(`[${project.group}/${project.name}]`);
      const n = await this.indexProject(project);
      console.log(`  Done: ${n} chunks\n`);
    }

    this.stats.cached = this.provider.cacheHits;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const cacheStats = this.provider.getCacheStats();
    console.log(`Indexing complete in ${elapsed}s`);
    console.log(
      `  Files: ${this.stats.files}, Chunks: ${this.stats.chunks}, Cached: ${this.stats.cached}, Skipped: ${this.stats.skipped}, Errors: ${this.stats.errors}`
    );
    console.log(
      `  Cache: ${cacheStats.size}/${cacheStats.maxSize} entries, hit rate ${(cacheStats.hitRate * 100).toFixed(1)}%`
    );
  }

  /** Update a single file (delete old chunks + re-index) */
  async updateFile(groupName: string, project: ProjectConfig, filePath: string): Promise<void> {
    const relPath = path.relative(project.path, filePath);

    try {
      await this.retryQdrant(() =>
        this.qdrant.delete(this.col(groupName), {
          filter: {
            must: [
              { key: 'project', match: { value: project.name } },
              { key: 'file', match: { value: relPath } },
            ],
          },
          wait: true,
        })
      );
    } catch (err) {
      console.warn(
        `[indexer] Could not delete old chunks for ${relPath}: ${(err as Error).message}`
      );
    }

    if (fs.existsSync(filePath)) {
      const n = await this.indexFile(groupName, project, filePath);
      console.log(`[indexer] Updated ${groupName}/${project.name}/${relPath} (${n} chunks)`);
    } else {
      console.log(`[indexer] Deleted ${groupName}/${project.name}/${relPath}`);
    }
  }

  /** Remove all chunks for a file */
  async deleteFile(groupName: string, project: ProjectConfig, filePath: string): Promise<void> {
    const relPath = path.relative(project.path, filePath);

    try {
      await this.retryQdrant(() =>
        this.qdrant.delete(this.col(groupName), {
          filter: {
            must: [
              { key: 'project', match: { value: project.name } },
              { key: 'file', match: { value: relPath } },
            ],
          },
          wait: true,
        })
      );
      console.log(`[indexer] Removed ${groupName}/${project.name}/${relPath}`);
    } catch {
      // ignore
    }
  }

  /** Content-based: index files from in-memory content (no filesystem access) */
  async indexFilesContent(
    project: ProjectConfig,
    files: Array<{ path: string; content: string; language?: string }>
  ): Promise<number> {
    const groupName = project.group;
    await this.ensureCollection(groupName);

    const defaultLang = project.languages[0] ?? 'generic';
    let totalChunks = 0;

    const queue = new PQueue({ concurrency: project.indexing.concurrency });
    const tasks = files.map((file) =>
      queue.add(async () => {
        const { path: relPath, content, language } = file;
        const lang = language ?? defaultLang;

        if (!content.trim()) return;

        const { chunks, symbolResults } = await this.chunkFile(content, lang, project);
        if (chunks.length === 0) return;

        // Compare chunk hashes to skip unchanged files
        const newHashes = new Set(chunks.map((c) => c.hash));
        const existingHashes = await this.getFileChunkHashes(groupName, project.name, relPath);
        if (this.hashSetsEqual(newHashes, existingHashes)) {
          this.stats.skipped++;
          return;
        }

        // Delete old chunks if file was previously indexed
        if (existingHashes.size > 0) {
          await this.retryQdrant(() =>
            this.qdrant.delete(this.col(groupName), {
              filter: {
                must: [
                  { key: 'project', match: { value: project.name } },
                  { key: 'file', match: { value: relPath } },
                ],
              },
              wait: true,
            })
          );
        }

        const contents = chunks.map((c) => c.content);
        const embeddings = await this.provider.embedBatchPassage(contents);

        if (embeddings.length !== chunks.length) {
          throw new Error(
            `Embedding mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks in ${relPath}`
          );
        }

        const tags = resolveTags(project.metadata, relPath);

        const points = this.buildPointPayloads(
          chunks,
          embeddings,
          groupName,
          project.name,
          relPath,
          lang,
          tags,
          project.metadata.service,
          project.metadata.bounded_context,
          symbolResults
        );

        const batchSize = project.indexing.batchSize;
        for (let i = 0; i < points.length; i += batchSize) {
          const batch = points.slice(i, i + batchSize);
          await this.retryQdrant(() =>
            this.qdrant.upsert(this.col(groupName), { points: batch, wait: true })
          );
        }

        totalChunks += points.length;
        this.stats.files++;
        this.stats.chunks += points.length;
      })
    );

    await Promise.all(tasks);
    this.stats.cached = this.provider.cacheHits;

    // Clean up orphaned chunks (files no longer in the provided list but still in Qdrant)
    const currentRelPaths = new Set(files.map((f) => f.path));
    await this.cleanupOrphanedChunks(groupName, project.name, currentRelPaths);

    return totalChunks;
  }

  /** Content-based: update file by deleting old chunks and indexing new content */
  async updateFileContent(
    groupName: string,
    projectName: string,
    relPath: string,
    content: string,
    language: string,
    project: ProjectConfig
  ): Promise<number> {
    try {
      await this.retryQdrant(() =>
        this.qdrant.delete(this.col(groupName), {
          filter: {
            must: [
              { key: 'project', match: { value: projectName } },
              { key: 'file', match: { value: relPath } },
            ],
          },
          wait: true,
        })
      );
    } catch (err) {
      console.warn(
        `[indexer] Could not delete old chunks for ${relPath}: ${(err as Error).message}`
      );
    }

    if (!content.trim()) {
      console.log(`[indexer] Updated ${groupName}/${projectName}/${relPath} (0 chunks, empty)`);
      return 0;
    }

    const { chunks, symbolResults } = await this.chunkFile(content, language, project);
    if (chunks.length === 0) {
      console.log(`[indexer] Updated ${groupName}/${projectName}/${relPath} (0 chunks)`);
      return 0;
    }

    const contents = chunks.map((c) => c.content);
    const embeddings = await this.provider.embedBatchPassage(contents);

    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding mismatch: got ${embeddings.length} embeddings for ${chunks.length} chunks in ${relPath}`
      );
    }

    const tags = resolveTags(project.metadata, relPath);

    const points = this.buildPointPayloads(
      chunks,
      embeddings,
      groupName,
      projectName,
      relPath,
      language,
      tags,
      project.metadata.service,
      project.metadata.bounded_context,
      symbolResults
    );

    const batchSize = project.indexing.batchSize;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.retryQdrant(() =>
        this.qdrant.upsert(this.col(groupName), { points: batch, wait: true })
      );
    }

    console.log(
      `[indexer] Updated ${groupName}/${projectName}/${relPath} (${points.length} chunks)`
    );
    return points.length;
  }

  /** Content-based: delete all chunks for a project (used when force re-index) */
  async deleteProjectChunks(groupName: string, projectName: string): Promise<void> {
    try {
      await this.retryQdrant(() =>
        this.qdrant.delete(this.col(groupName), {
          filter: {
            must: [{ key: 'project', match: { value: projectName } }],
          },
          wait: true,
        })
      );
      console.log(`[indexer] Removed all chunks for ${groupName}/${projectName}`);
    } catch {
      // ignore (collection may not exist)
    }
  }

  /** Content-based: delete chunks by group, project, and relative path (no filesystem) */
  async deleteFileByPath(groupName: string, projectName: string, relPath: string): Promise<void> {
    try {
      await this.retryQdrant(() =>
        this.qdrant.delete(this.col(groupName), {
          filter: {
            must: [
              { key: 'project', match: { value: projectName } },
              { key: 'file', match: { value: relPath } },
            ],
          },
          wait: true,
        })
      );
      console.log(`[indexer] Removed ${groupName}/${projectName}/${relPath}`);
    } catch {
      // ignore
    }
  }

  /** Delete entire group collection and re-index all its projects */
  async reindexGroup(groupName: string, projects: ProjectConfig[]): Promise<number> {
    try {
      await this.qdrant.deleteCollection(this.col(groupName));
    } catch {
      // may not exist
    }

    let total = 0;
    for (const project of projects) {
      total += await this.indexProject(project);
    }
    return total;
  }

  /** Get collection stats for a group */
  async getGroupStats(groupName: string): Promise<{ points: number; status: string }> {
    try {
      const info = await this.qdrant.getCollection(this.col(groupName));
      return { points: info.points_count ?? 0, status: String(info.status) };
    } catch {
      return { points: 0, status: 'not_indexed' };
    }
  }

  /** Retrieve a chunk by its chunk_id (Qdrant payload filter on keyword index) */
  async getChunkById(chunkId: string): Promise<Record<string, unknown> | null> {
    const parsed = parseChunkId(chunkId);
    if (!parsed) return null;

    try {
      const result = await this.retryQdrant(() =>
        this.qdrant.scroll(this.col(parsed.group), {
          filter: {
            must: [{ key: 'chunk_id', match: { value: chunkId } }],
          },
          with_payload: true,
          with_vector: false,
          limit: 1,
        })
      );

      const point = result.points[0];
      if (!point) return null;
      return point.payload as Record<string, unknown>;
    } catch (err) {
      console.error(`[indexer] Failed to get chunk by ID ${chunkId}:`, err);
      return null;
    }
  }

  /** Get adjacent chunks in the same file, ordered by startLine */
  async getAdjacentChunks(
    groupName: string,
    project: string,
    file: string,
    startLine: number,
    endLine: number,
    radiusLines: number
  ): Promise<Array<Record<string, unknown>>> {
    const minLine = Math.max(0, startLine - radiusLines);
    const maxLine = endLine + radiusLines;

    try {
      const allPoints: Array<Record<string, unknown>> = [];
      let offset: string | number | undefined = undefined;

      for (;;) {
        const result = await this.retryQdrant(() =>
          this.qdrant.scroll(this.col(groupName), {
            filter: {
              must: [
                { key: 'project', match: { value: project } },
                { key: 'file', match: { value: file } },
                { key: 'startLine', range: { lte: maxLine } },
                { key: 'endLine', range: { gte: minLine } },
              ],
            },
            with_payload: true,
            with_vector: false,
            limit: 100,
            ...(offset !== undefined ? { offset } : {}),
          })
        );

        for (const p of result.points) {
          allPoints.push(p.payload as Record<string, unknown>);
        }

        if (!result.next_page_offset) break;
        offset = result.next_page_offset as string | number;
      }

      return allPoints.sort((a, b) => (a['startLine'] as number) - (b['startLine'] as number));
    } catch (err) {
      console.error(
        `[indexer] Failed to get adjacent chunks for ${groupName}/${project}/${file}:`,
        err
      );
      return [];
    }
  }

  /** List all paparats collections (groups), returning logical group names */
  async listGroups(): Promise<Record<string, number>> {
    const collections = await this.qdrant.getCollections();
    const paparatsCollections = collections.collections.filter((col) =>
      col.name.startsWith(COLLECTION_PREFIX)
    );
    const infos = await Promise.all(
      paparatsCollections.map((col) => this.qdrant.getCollection(col.name))
    );
    const result: Record<string, number> = {};
    paparatsCollections.forEach((col, i) => {
      result[fromCollectionName(col.name)] = infos[i]!.points_count ?? 0;
    });
    return result;
  }
}
