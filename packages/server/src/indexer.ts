import { QdrantClient } from '@qdrant/js-client-rest';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import { filterFilesByGitignore } from '@paparats/shared';
import { v7 as uuidv7 } from 'uuid';
import PQueue from 'p-queue';
import { Chunker } from './chunker.js';
import type { CachedEmbeddingProvider } from './embeddings.js';
import type { ProjectConfig, IndexerStats } from './types.js';

export interface IndexerConfig {
  qdrantUrl: string;
  embeddingProvider: CachedEmbeddingProvider;
  dimensions: number;
  /** Qdrant request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Optional Qdrant client for testing (skips creating from qdrantUrl) */
  qdrantClient?: QdrantClient;
}

/** Qdrant timeout in milliseconds (default: 30s) */
const QDRANT_TIMEOUT_MS = 30_000;
const QDRANT_MAX_RETRIES = 3;

export class Indexer {
  private qdrant: QdrantClient;
  private chunkers = new Map<string, Chunker>();
  private provider: CachedEmbeddingProvider;
  private dimensions: number;
  stats: IndexerStats;

  constructor(config: IndexerConfig) {
    this.qdrant =
      config.qdrantClient ??
      new QdrantClient({
        url: config.qdrantUrl,
        timeout: config.timeout ?? QDRANT_TIMEOUT_MS,
      });
    this.provider = config.embeddingProvider;
    this.dimensions = config.dimensions;
    this.stats = { files: 0, chunks: 0, cached: 0, errors: 0, skipped: 0 };
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
      const result = await this.qdrant.scroll(groupName, {
        filter: {
          must: [
            { key: 'project', match: { value: projectName } },
            { key: 'file', match: { value: relPath } },
          ],
        },
        with_payload: { include: ['hash'] },
        with_vector: false,
        limit: 1000,
      });
      const hashes = new Set<string>();
      for (const point of result.points) {
        const hash = (point.payload as Record<string, unknown> | null)?.['hash'];
        if (typeof hash === 'string') {
          hashes.add(hash);
        }
      }
      return hashes;
    } catch (err) {
      console.warn(
        `[indexer] Failed to get chunk hashes for ${projectName}/${relPath}: ${(err as Error).message}`
      );
      return new Set<string>();
    }
  }

  private hashSetsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const h of a) {
      if (!b.has(h)) return false;
    }
    return true;
  }

  /** Ensure group collection exists in Qdrant */
  async ensureCollection(groupName: string): Promise<void> {
    try {
      await this.qdrant.getCollection(groupName);
      return;
    } catch {
      // Collection doesn't exist, try to create
    }

    try {
      await this.retryQdrant(() =>
        this.qdrant.createCollection(groupName, {
          vectors: {
            size: this.dimensions,
            distance: 'Cosine',
          },
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(groupName, {
          field_name: 'project',
          field_schema: 'keyword',
          wait: true,
        })
      );
      await this.retryQdrant(() =>
        this.qdrant.createPayloadIndex(groupName, {
          field_name: 'file',
          field_schema: 'keyword',
          wait: true,
        })
      );
    } catch (err) {
      // If creation failed, check if another process created it
      try {
        await this.qdrant.getCollection(groupName);
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

    const chunker = this.getChunker(project);
    const language = project.languages[0] ?? 'generic';
    const chunks = chunker.chunk(content, language);
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
        this.qdrant.delete(groupName, {
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

    const points = chunks.map((chunk, i) => ({
      id: uuidv7(),
      vector: embeddings[i]!,
      payload: {
        project: project.name,
        file: relPath,
        language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        hash: chunk.hash,
      },
    }));

    const batchSize = project.indexing.batchSize;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.retryQdrant(() => this.qdrant.upsert(groupName, { points: batch, wait: true }));
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

    return totalChunks;
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
        this.qdrant.delete(groupName, {
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
        this.qdrant.delete(groupName, {
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

    const chunker = this.getChunker(project);
    const defaultLang = project.languages[0] ?? 'generic';
    let totalChunks = 0;

    const queue = new PQueue({ concurrency: project.indexing.concurrency });
    const tasks = files.map((file) =>
      queue.add(async () => {
        const { path: relPath, content, language } = file;
        const lang = language ?? defaultLang;

        if (!content.trim()) return;

        const chunks = chunker.chunk(content, lang);
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
            this.qdrant.delete(groupName, {
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

        const points = chunks.map((chunk, i) => ({
          id: uuidv7(),
          vector: embeddings[i]!,
          payload: {
            project: project.name,
            file: relPath,
            language: lang,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            hash: chunk.hash,
          },
        }));

        const batchSize = project.indexing.batchSize;
        for (let i = 0; i < points.length; i += batchSize) {
          const batch = points.slice(i, i + batchSize);
          await this.retryQdrant(() =>
            this.qdrant.upsert(groupName, { points: batch, wait: true })
          );
        }

        totalChunks += points.length;
        this.stats.files++;
        this.stats.chunks += points.length;
      })
    );

    await Promise.all(tasks);
    this.stats.cached = this.provider.cacheHits;
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
        this.qdrant.delete(groupName, {
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

    const chunker = this.getChunker(project);
    const chunks = chunker.chunk(content, language);
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

    const points = chunks.map((chunk, i) => ({
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
      },
    }));

    const batchSize = project.indexing.batchSize;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.retryQdrant(() => this.qdrant.upsert(groupName, { points: batch, wait: true }));
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
        this.qdrant.delete(groupName, {
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
        this.qdrant.delete(groupName, {
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
      await this.qdrant.deleteCollection(groupName);
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
      const info = await this.qdrant.getCollection(groupName);
      return { points: info.points_count ?? 0, status: String(info.status) };
    } catch {
      return { points: 0, status: 'not_indexed' };
    }
  }

  /** List all collections (groups) */
  async listGroups(): Promise<Record<string, number>> {
    const collections = await this.qdrant.getCollections();
    const infos = await Promise.all(
      collections.collections.map((col) => this.qdrant.getCollection(col.name))
    );
    const result: Record<string, number> = {};
    collections.collections.forEach((col, i) => {
      result[col.name] = infos[i]!.points_count ?? 0;
    });
    return result;
  }
}
