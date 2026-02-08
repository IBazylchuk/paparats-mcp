import { QdrantClient } from '@qdrant/js-client-rest';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import PQueue from 'p-queue';
import { Chunker } from './chunker.js';
import type { CachedEmbeddingProvider } from './embeddings.js';
import type { ProjectConfig, IndexerStats } from './types.js';

export interface IndexerConfig {
  qdrantUrl: string;
  embeddingProvider: CachedEmbeddingProvider;
  dimensions: number;
}

export class Indexer {
  private qdrant: QdrantClient;
  private chunker: Chunker;
  private provider: CachedEmbeddingProvider;
  private dimensions: number;
  stats: IndexerStats;

  constructor(config: IndexerConfig) {
    this.qdrant = new QdrantClient({ url: config.qdrantUrl });
    this.provider = config.embeddingProvider;
    this.dimensions = config.dimensions;
    this.chunker = new Chunker({ chunkSize: 1024, overlap: 128 });
    this.stats = { files: 0, chunks: 0, cached: 0, errors: 0 };
  }

  /** Deterministic numeric ID from group + project + file + chunk index */
  private pointId(group: string, project: string, relPath: string, chunkIdx: number): number {
    const raw = `${group}:${project}:${relPath}:${chunkIdx}`;
    const hex = crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
    return parseInt(hex, 16);
  }

  /** Ensure group collection exists in Qdrant */
  async ensureCollection(groupName: string): Promise<void> {
    try {
      await this.qdrant.getCollection(groupName);
    } catch {
      await this.qdrant.createCollection(groupName, {
        vectors: {
          size: this.dimensions,
          distance: 'Cosine',
        },
      });
      // Payload indexes for filtering
      await this.qdrant.createPayloadIndex(groupName, {
        field_name: 'project',
        field_schema: 'keyword',
        wait: true,
      });
      await this.qdrant.createPayloadIndex(groupName, {
        field_name: 'file',
        field_schema: 'keyword',
        wait: true,
      });
    }
  }

  /** Index a single file into its group collection */
  async indexFile(groupName: string, project: ProjectConfig, filePath: string): Promise<number> {
    const relPath = path.relative(project.path, filePath);

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return 0;
    }

    if (!content.trim() || content.includes('\0')) return 0;

    // Use the first language for chunking strategy
    const language = project.languages[0] ?? 'generic';
    const chunks = this.chunker.chunk(content, language);
    if (chunks.length === 0) return 0;

    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await this.provider.embed(chunk.content);

      points.push({
        id: this.pointId(groupName, project.name, relPath, i),
        vector: embedding,
        payload: {
          project: project.name,
          file: relPath,
          language,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          hash: chunk.hash,
        },
      });
    }

    const batchSize = project.indexing.batchSize;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.qdrant.upsert(groupName, { points: batch, wait: true });
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

    // Gather files using project patterns
    const allFiles: string[] = [];
    for (const pattern of project.patterns) {
      const found = await glob(pattern, {
        cwd: project.path,
        absolute: true,
        ignore: project.exclude,
        nodir: true,
      });
      allFiles.push(...found);
    }

    const files = [...new Set(allFiles)];
    console.error(`  ${files.length} files found`);

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
            console.error(`  [${processed}/${files.length}] ${totalChunks} chunks`);
          }
        } catch (err) {
          this.stats.errors++;
          const rel = path.relative(project.path, file);
          console.error(`  Error: ${rel}: ${(err as Error).message}`);
        }
      }),
    );

    await Promise.all(tasks);
    return totalChunks;
  }

  /** Index multiple projects (all in the same or different groups) */
  async indexAll(projects: ProjectConfig[]): Promise<void> {
    console.error('Starting full index...\n');
    const start = Date.now();

    for (const project of projects) {
      console.error(`[${project.group}/${project.name}]`);
      const n = await this.indexProject(project);
      console.error(`  Done: ${n} chunks\n`);
    }

    this.stats.cached = this.provider.cacheHits;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`Indexing complete in ${elapsed}s`);
    console.error(
      `  Files: ${this.stats.files}, Chunks: ${this.stats.chunks}, Cached: ${this.stats.cached}, Errors: ${this.stats.errors}`,
    );
  }

  /** Update a single file (delete old chunks + re-index) */
  async updateFile(groupName: string, project: ProjectConfig, filePath: string): Promise<void> {
    const relPath = path.relative(project.path, filePath);

    // Delete existing chunks for this file in the group collection
    try {
      await this.qdrant.delete(groupName, {
        filter: {
          must: [
            { key: 'project', match: { value: project.name } },
            { key: 'file', match: { value: relPath } },
          ],
        },
        wait: true,
      });
    } catch {
      // collection may not exist yet
    }

    if (fs.existsSync(filePath)) {
      const n = await this.indexFile(groupName, project, filePath);
      console.error(`[indexer] Updated ${groupName}/${project.name}/${relPath} (${n} chunks)`);
    } else {
      console.error(`[indexer] Deleted ${groupName}/${project.name}/${relPath}`);
    }
  }

  /** Remove all chunks for a file */
  async deleteFile(groupName: string, project: ProjectConfig, filePath: string): Promise<void> {
    const relPath = path.relative(project.path, filePath);

    try {
      await this.qdrant.delete(groupName, {
        filter: {
          must: [
            { key: 'project', match: { value: project.name } },
            { key: 'file', match: { value: relPath } },
          ],
        },
        wait: true,
      });
      console.error(`[indexer] Removed ${groupName}/${project.name}/${relPath}`);
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
    const result: Record<string, number> = {};
    for (const col of collections.collections) {
      const info = await this.qdrant.getCollection(col.name);
      result[col.name] = info.points_count ?? 0;
    }
    return result;
  }
}
