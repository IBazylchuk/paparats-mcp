import path from 'path';
import os from 'os';
import fs from 'fs';
import Database from 'better-sqlite3';
import type { EmbeddingProvider } from './types.js';

// ── SQLite embedding cache ─────────────────────────────────────────────────

const PAPARATS_DIR = path.join(os.homedir(), '.paparats');
const CACHE_DB_PATH = path.join(PAPARATS_DIR, 'cache', 'embeddings.db');

export class EmbeddingCache {
  private db: Database.Database;
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;
  hitCount = 0;

  constructor(dbPath?: string) {
    const p = dbPath ?? CACHE_DB_PATH;
    fs.mkdirSync(path.dirname(p), { recursive: true });

    this.db = new Database(p);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        hash TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        vector BLOB NOT NULL
      )
    `);

    this.getStmt = this.db.prepare('SELECT vector FROM embeddings WHERE hash = ? AND model = ?');
    this.setStmt = this.db.prepare(
      'INSERT OR REPLACE INTO embeddings (hash, model, vector) VALUES (?, ?, ?)',
    );
  }

  get(hash: string, model: string): number[] | null {
    const row = this.getStmt.get(hash, model) as { vector: Buffer } | undefined;
    if (!row) return null;
    this.hitCount++;
    return Array.from(new Float64Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 8));
  }

  set(hash: string, model: string, vector: number[]): void {
    const buf = Buffer.from(new Float64Array(vector).buffer);
    this.setStmt.run(hash, model, buf);
  }

  close(): void {
    this.db.close();
  }
}

// ── Ollama provider ────────────────────────────────────────────────────────

export interface OllamaProviderConfig {
  url?: string;
  model?: string;
  dimensions?: number;
}

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
    const res = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: text.slice(0, 8192),
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }
}

// ── Cached provider wrapper ────────────────────────────────────────────────

export class CachedEmbeddingProvider implements EmbeddingProvider {
  private provider: EmbeddingProvider;
  private cache: EmbeddingCache;

  get dimensions(): number {
    return this.provider.dimensions;
  }

  get model(): string {
    return this.provider.model;
  }

  get cacheHits(): number {
    return this.cache.hitCount;
  }

  constructor(provider: EmbeddingProvider, cache?: EmbeddingCache) {
    this.provider = provider;
    this.cache = cache ?? new EmbeddingCache();
  }

  async embed(text: string): Promise<number[]> {
    // We use a hash of the text as cache key — callers don't need to manage this
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);

    const cached = this.cache.get(hash, this.model);
    if (cached) return cached;

    const vector = await this.provider.embed(text);
    this.cache.set(hash, this.model, vector);
    return vector;
  }

  close(): void {
    this.cache.close();
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createEmbeddingProvider(config: {
  provider: string;
  model: string;
  dimensions: number;
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

  return new CachedEmbeddingProvider(base);
}
