import path from 'path';
import os from 'os';
import fs from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import type { EmbeddingProvider } from './types.js';
import { prefixQuery, prefixPassage, type TaskPrefixConfig } from './task-prefixes.js';

// ── SQLite embedding cache ─────────────────────────────────────────────────

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const CACHE_DB_PATH = path.join(PAPARATS_DIR, 'cache', 'embeddings.db');

const DEFAULT_MAX_CACHE_SIZE = 100_000;

export class EmbeddingCache {
  private db: Database.Database;
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;
  private countStmt: Database.Statement;
  private cleanupStmt: Database.Statement;
  hitCount = 0;
  private readonly maxCacheSize: number;
  private closed = false;

  constructor(dbPath?: string, maxCacheSize = DEFAULT_MAX_CACHE_SIZE) {
    const p = dbPath ?? CACHE_DB_PATH;
    this.maxCacheSize = maxCacheSize;
    fs.mkdirSync(path.dirname(p), { recursive: true });

    this.db = new Database(p);
    try {
      this.db.pragma('journal_mode = WAL');
    } catch {
      console.warn('[paparats] WAL mode not supported, using default journal mode');
    }

    // Migrate from old schema (Float64, single PK) if needed
    const tableInfo = this.db.prepare('PRAGMA table_info(embeddings)').all() as { name: string }[];
    if (tableInfo.length > 0 && !tableInfo.some((c) => c.name === 'created_at')) {
      this.db.exec('DROP TABLE embeddings');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (hash, model)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);
      CREATE INDEX IF NOT EXISTS idx_embeddings_created_at ON embeddings(created_at);
    `);

    this.getStmt = this.db.prepare('SELECT vector FROM embeddings WHERE hash = ? AND model = ?');
    this.setStmt = this.db.prepare(
      "INSERT OR REPLACE INTO embeddings (hash, model, vector, created_at) VALUES (?, ?, ?, strftime('%s', 'now'))"
    );
    this.countStmt = this.db.prepare('SELECT COUNT(*) as cnt FROM embeddings');
    this.cleanupStmt = this.db.prepare(`
      DELETE FROM embeddings WHERE rowid IN (
        SELECT rowid FROM embeddings ORDER BY created_at ASC LIMIT ?
      )
    `);
  }

  get(hash: string, model: string): number[] | null {
    const row = this.getStmt.get(hash, model) as { vector: Buffer } | undefined;
    if (!row) return null;
    this.hitCount++;
    return Array.from(
      new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)
    );
  }

  set(hash: string, model: string, vector: number[]): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.setStmt.run(hash, model, buf);

    const { cnt } = this.countStmt.get() as { cnt: number };
    if (cnt > this.maxCacheSize) {
      const toDelete = cnt - this.maxCacheSize;
      this.cleanupStmt.run(toDelete);
    }
  }

  /** Cache stats for monitoring */
  getStats(): { size: number; hitCount: number; maxSize: number } {
    const { cnt } = this.countStmt.get() as { cnt: number };
    return {
      size: cnt,
      hitCount: this.hitCount,
      maxSize: this.maxCacheSize,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// ── Ollama provider ────────────────────────────────────────────────────────

export interface OllamaProviderConfig {
  url?: string;
  model?: string;
  dimensions?: number;
}

const OLLAMA_TIMEOUT_MS = 30_000;
const OLLAMA_MAX_RETRIES = 3;
const OLLAMA_MAX_BATCH_SIZE = 100;

export class OllamaProvider implements EmbeddingProvider {
  private url: string;
  readonly model: string;
  readonly dimensions: number;

  constructor(config?: OllamaProviderConfig) {
    this.url = config?.url ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    // Ollama alias for jinaai/jina-code-embeddings-1.5b-GGUF
    // Registered locally via Modelfile — not in Ollama registry
    this.model = config?.model ?? 'jina-code-embeddings';
    this.dimensions = config?.dimensions ?? 1536;
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.slice(0, 8192);
    if (text.length > 8192) {
      console.warn(`[paparats] Text truncated from ${text.length} to 8192 chars for embedding`);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < OLLAMA_MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

        const res = await fetch(`${this.url}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            input: truncated,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Ollama error ${res.status}: ${errorText}`);
        }

        const data = (await res.json()) as { embeddings: number[][] };
        const embedding = data.embeddings[0];
        if (!embedding) {
          throw new Error('Ollama returned no embeddings');
        }

        if (embedding.length !== this.dimensions) {
          console.warn(
            `[paparats] Model ${this.model} returned ${embedding.length} dimensions, ` +
              `expected ${this.dimensions}. Update config.`
          );
        }

        return embedding;
      } catch (err) {
        lastError = err as Error;
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error('Ollama request timeout after 30s');
        }
        if (attempt < OLLAMA_MAX_RETRIES - 1) {
          const delay = Math.min(1000 * 2 ** attempt, 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          console.warn(
            `[paparats] Ollama request failed, retrying (${attempt + 1}/${OLLAMA_MAX_RETRIES})...`
          );
        }
      }
    }
    throw new Error(`Ollama failed after ${OLLAMA_MAX_RETRIES} retries: ${lastError?.message}`);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    if (texts.length > OLLAMA_MAX_BATCH_SIZE) {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += OLLAMA_MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + OLLAMA_MAX_BATCH_SIZE);
        results.push(...(await this.embedBatch(batch)));
      }
      return results;
    }

    const inputs = texts.map((t) => {
      const trimmed = t.trim();
      if (!trimmed) {
        console.warn('[paparats] Empty text in batch, using space placeholder');
        return ' ';
      }
      if (trimmed.length > 8192) {
        console.warn(
          `[paparats] Text truncated from ${trimmed.length} to 8192 chars for embedding`
        );
      }
      return trimmed.slice(0, 8192);
    });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < OLLAMA_MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS * 2); // 60s for batch

        const res = await fetch(`${this.url}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            input: inputs,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Ollama error ${res.status}: ${errorText}`);
        }

        const data = (await res.json()) as { embeddings: number[][] };
        const embeddings = data.embeddings;
        if (!embeddings || embeddings.length !== texts.length) {
          throw new Error(
            `Ollama returned ${embeddings?.length ?? 0} embeddings, expected ${texts.length}`
          );
        }

        embeddings.forEach((emb, i) => {
          if (emb.length !== this.dimensions) {
            console.warn(
              `[paparats] Model ${this.model} returned ${emb.length} dimensions for item ${i}, ` +
                `expected ${this.dimensions}. Update config.`
            );
          }
        });

        return embeddings;
      } catch (err) {
        lastError = err as Error;
        if (err instanceof Error && err.name === 'AbortError') {
          lastError = new Error('Ollama batch request timeout after 60s');
        }
        if (attempt < OLLAMA_MAX_RETRIES - 1) {
          const delay = Math.min(1000 * 2 ** attempt, 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          console.warn(
            `[paparats] Ollama batch request failed, retrying (${attempt + 1}/${OLLAMA_MAX_RETRIES})...`
          );
        }
      }
    }
    throw new Error(`Ollama failed after ${OLLAMA_MAX_RETRIES} retries: ${lastError?.message}`);
  }
}

// ── Cached provider wrapper ────────────────────────────────────────────────

const providerRegistry = new Set<CachedEmbeddingProvider>();
let exitHandlersRegistered = false;

function registerExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const cleanup = () => {
    for (const p of providerRegistry) {
      p.close();
    }
  };

  process.on('beforeExit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}

export interface CacheStats {
  size: number;
  hitCount: number;
  maxSize: number;
  hitRate: number;
}

export class CachedEmbeddingProvider implements EmbeddingProvider {
  private provider: EmbeddingProvider;
  private cache: EmbeddingCache;
  private embedCalls = 0;
  private taskPrefixConfig: TaskPrefixConfig;

  get dimensions(): number {
    return this.provider.dimensions;
  }

  get model(): string {
    return this.provider.model;
  }

  get cacheHits(): number {
    return this.cache.hitCount;
  }

  get prefixesEnabled(): boolean {
    return this.taskPrefixConfig.enabled;
  }

  constructor(
    provider: EmbeddingProvider,
    cache?: EmbeddingCache,
    taskPrefixConfig?: TaskPrefixConfig
  ) {
    this.provider = provider;
    this.cache = cache ?? new EmbeddingCache();
    this.taskPrefixConfig = taskPrefixConfig ?? { enabled: false };
    providerRegistry.add(this);
    registerExitHandlers();
  }

  /** Cache stats for monitoring */
  getCacheStats(): CacheStats {
    const stats = this.cache.getStats();
    const hitRate = this.embedCalls > 0 ? stats.hitCount / this.embedCalls : 0;
    return {
      ...stats,
      hitRate: Math.round(hitRate * 1000) / 1000,
    };
  }

  async embed(text: string): Promise<number[]> {
    this.embedCalls++;
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 32);

    const cached = this.cache.get(hash, this.model);
    if (cached) return cached;

    const vector = await this.provider.embed(text);
    this.cache.set(hash, this.model, vector);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.embedCalls += texts.length;

    const model = this.model;
    const hashes = texts.map((t) => createHash('sha256').update(t).digest('hex').slice(0, 32));
    const results: (number[] | null)[] = hashes.map((h) => this.cache.get(h, model));

    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    results.forEach((r, i) => {
      if (r === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]!);
      }
    });

    if (uncachedTexts.length > 0) {
      let vectors: number[][];
      if (typeof this.provider.embedBatch === 'function') {
        vectors = await this.provider.embedBatch(uncachedTexts);
      } else {
        vectors = await Promise.all(uncachedTexts.map((t) => this.provider.embed(t)));
      }
      if (vectors.length !== uncachedTexts.length) {
        throw new Error(
          `Provider returned ${vectors.length} embeddings, expected ${uncachedTexts.length}`
        );
      }
      uncachedIndices.forEach((idx, i) => {
        const vec = vectors[i]!;
        this.cache.set(hashes[idx]!, model, vec);
        results[idx] = vec;
      });
    }

    return results as number[][];
  }

  /** Embed a search query with auto-detected task prefix (if enabled) */
  async embedQuery(text: string): Promise<number[]> {
    const input = this.taskPrefixConfig.enabled ? prefixQuery(text) : text;
    return this.embed(input);
  }

  /** Embed a code passage/chunk with passage prefix (if enabled) */
  async embedPassage(text: string): Promise<number[]> {
    const input = this.taskPrefixConfig.enabled ? prefixPassage(text) : text;
    return this.embed(input);
  }

  /** Embed a batch of code passages/chunks with passage prefix (if enabled) */
  async embedBatchPassage(texts: string[]): Promise<number[][]> {
    if (!this.taskPrefixConfig.enabled) {
      return this.embedBatch(texts);
    }
    const prefixed = texts.map((t) => prefixPassage(t));
    return this.embedBatch(prefixed);
  }

  close(): void {
    providerRegistry.delete(this);
    this.cache.close();
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createEmbeddingProvider(config: {
  provider: string;
  model: string;
  dimensions: number;
  taskPrefixes?: TaskPrefixConfig;
}): CachedEmbeddingProvider {
  let base: EmbeddingProvider;

  switch (config.provider) {
    case 'ollama':
      base = new OllamaProvider({
        model: config.model,
        dimensions: config.dimensions,
      });
      break;
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }

  // Auto-enable task prefixes for Jina code embedding models
  const taskPrefixes = config.taskPrefixes ?? {
    enabled: config.model.includes('jina-code') || config.model.includes('jina_code'),
  };

  return new CachedEmbeddingProvider(base, undefined, taskPrefixes);
}
