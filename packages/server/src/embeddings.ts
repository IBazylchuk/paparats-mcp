import path from 'path';
import os from 'os';
import fs from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import type { EmbeddingProvider } from './types.js';
import { prefixQuery, prefixPassage, type TaskPrefixConfig } from './task-prefixes.js';
import type { Telemetry } from './telemetry/facade.js';

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
  private approximateSize: number;

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

    // Initialize approximate size once at startup to avoid COUNT(*) on every write
    this.approximateSize = (this.countStmt.get() as { cnt: number }).cnt;
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

    // Track approximate size to avoid COUNT(*) on every write
    this.approximateSize++;
    if (this.approximateSize > this.maxCacheSize) {
      const { cnt } = this.countStmt.get() as { cnt: number };
      this.approximateSize = cnt;
      if (cnt > this.maxCacheSize) {
        const toDelete = cnt - this.maxCacheSize;
        this.cleanupStmt.run(toDelete);
        this.approximateSize = this.maxCacheSize;
      }
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

const OLLAMA_TIMEOUT_MS = 120_000;
const OLLAMA_MAX_RETRIES = 3;
const OLLAMA_DEFAULT_BATCH_SIZE = 5;
const OLLAMA_MAX_BATCH_SIZE =
  parseInt(process.env['OLLAMA_BATCH_SIZE'] ?? '', 10) || OLLAMA_DEFAULT_BATCH_SIZE;
// Cap suburb of large chunks per request. CPU-only Ollama can exceed 240s on
// dense batches; splitting by total chars keeps each request bounded.
const OLLAMA_DEFAULT_BATCH_CHARS = 16_000;
const OLLAMA_MAX_BATCH_CHARS =
  parseInt(process.env['OLLAMA_BATCH_CHARS'] ?? '', 10) || OLLAMA_DEFAULT_BATCH_CHARS;

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
          lastError = new Error('Ollama request timeout after 120s');
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

    // Split by count first, then re-check total chars on each slice — a slice
    // of 5 ~4KB chunks easily exceeds CPU Ollama's per-request budget.
    if (texts.length > OLLAMA_MAX_BATCH_SIZE) {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += OLLAMA_MAX_BATCH_SIZE) {
        const batch = texts.slice(i, i + OLLAMA_MAX_BATCH_SIZE);
        results.push(...(await this.embedBatch(batch)));
      }
      return results;
    }
    const totalChars = texts.reduce((sum, t) => sum + Math.min(t.length, 8192), 0);
    if (texts.length > 1 && totalChars > OLLAMA_MAX_BATCH_CHARS) {
      const mid = Math.ceil(texts.length / 2);
      const left = await this.embedBatch(texts.slice(0, mid));
      const right = await this.embedBatch(texts.slice(mid));
      return [...left, ...right];
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
        const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS * 2); // 240s for batch

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
          lastError = new Error('Ollama batch request timeout after 240s');
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

// ── Cloud HTTP helpers (shared by OpenAI/Voyage) ───────────────────────────

/** True if the status code shouldn't be retried — bad input or auth. */
function isCloudClientError(status: number): boolean {
  // 401/403 = bad key, 402 = no credit, 400 = malformed input.
  // 404/422 also belong here for completeness.
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 422
  );
}

interface CloudCallConfig {
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  maxRetries: number;
  providerLabel: string;
}

async function cloudEmbeddingCall<T>(cfg: CloudCallConfig): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(cfg.body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) return (await res.json()) as T;

      const errText = await res.text();
      const err = new Error(`${cfg.providerLabel} error ${res.status}: ${errText}`);
      if (isCloudClientError(res.status)) {
        // Don't retry — caller's fault (bad key, no credit, malformed input).
        throw err;
      }
      lastError = err;
    } catch (err) {
      clearTimeout(timeoutId);
      const e = err as Error;
      if (e.name === 'AbortError') {
        lastError = new Error(`${cfg.providerLabel} request timeout after ${cfg.timeoutMs}ms`);
      } else if (/error 4\d\d/.test(e.message)) {
        // Surface client errors immediately — already wrapped above.
        throw e;
      } else {
        lastError = e;
      }
    }

    if (attempt < cfg.maxRetries - 1) {
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      console.warn(
        `[paparats] ${cfg.providerLabel} request failed, retrying (${attempt + 1}/${cfg.maxRetries})...`
      );
    }
  }
  throw new Error(
    `${cfg.providerLabel} failed after ${cfg.maxRetries} retries: ${lastError?.message}`
  );
}

// ── OpenAI provider ────────────────────────────────────────────────────────

export interface OpenAIProviderConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}

const OPENAI_TIMEOUT_MS = 60_000;
const OPENAI_MAX_RETRIES = 3;
const OPENAI_MAX_INPUTS_PER_BATCH = 2048;

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private url: string;
  private apiKey: string;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey) throw new Error('OpenAI provider requires apiKey');
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions ?? 1536;
    this.url = (config.baseUrl ?? 'https://api.openai.com/v1') + '/embeddings';
  }

  async embed(text: string): Promise<number[]> {
    const data = await cloudEmbeddingCall<OpenAIEmbeddingResponse>({
      url: this.url,
      apiKey: this.apiKey,
      body: { model: this.model, input: text, dimensions: this.dimensions },
      timeoutMs: OPENAI_TIMEOUT_MS,
      maxRetries: OPENAI_MAX_RETRIES,
      providerLabel: 'OpenAI',
    });
    const emb = data.data[0]?.embedding;
    if (!emb) throw new Error('OpenAI returned no embeddings');
    return emb;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > OPENAI_MAX_INPUTS_PER_BATCH) {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += OPENAI_MAX_INPUTS_PER_BATCH) {
        results.push(...(await this.embedBatch(texts.slice(i, i + OPENAI_MAX_INPUTS_PER_BATCH))));
      }
      return results;
    }

    const data = await cloudEmbeddingCall<OpenAIEmbeddingResponse>({
      url: this.url,
      apiKey: this.apiKey,
      body: { model: this.model, input: texts, dimensions: this.dimensions },
      timeoutMs: OPENAI_TIMEOUT_MS,
      maxRetries: OPENAI_MAX_RETRIES,
      providerLabel: 'OpenAI',
    });
    // Sort by index — OpenAI guarantees order but spec says rely on `index`.
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

// ── Voyage AI provider ─────────────────────────────────────────────────────

export interface VoyageProviderConfig {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}

const VOYAGE_TIMEOUT_MS = 60_000;
const VOYAGE_MAX_RETRIES = 3;
// Voyage limit: 128 inputs per request for code models.
const VOYAGE_MAX_INPUTS_PER_BATCH = 128;

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export class VoyageProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private url: string;
  private apiKey: string;
  private currentInputType: 'query' | 'document' = 'document';

  constructor(config: VoyageProviderConfig) {
    if (!config.apiKey) throw new Error('Voyage provider requires apiKey');
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'voyage-code-3';
    // voyage-code-3 supports 256/512/1024/2048 via Matryoshka; 1024 is the
    // documented default and the Pareto sweet spot for code retrieval.
    this.dimensions = config.dimensions ?? 1024;
    this.url = (config.baseUrl ?? 'https://api.voyageai.com/v1') + '/embeddings';
  }

  /**
   * Sets the input_type for subsequent requests. Voyage code models score
   * noticeably better when queries vs documents are tagged correctly.
   */
  setInputType(type: 'query' | 'document'): void {
    this.currentInputType = type;
  }

  private buildBody(input: string | string[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      input,
      input_type: this.currentInputType,
    };
    if (this.dimensions !== 1024) body['output_dimension'] = this.dimensions;
    return body;
  }

  async embed(text: string): Promise<number[]> {
    const data = await cloudEmbeddingCall<VoyageEmbeddingResponse>({
      url: this.url,
      apiKey: this.apiKey,
      body: this.buildBody(text),
      timeoutMs: VOYAGE_TIMEOUT_MS,
      maxRetries: VOYAGE_MAX_RETRIES,
      providerLabel: 'Voyage',
    });
    const emb = data.data[0]?.embedding;
    if (!emb) throw new Error('Voyage returned no embeddings');
    return emb;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > VOYAGE_MAX_INPUTS_PER_BATCH) {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i += VOYAGE_MAX_INPUTS_PER_BATCH) {
        results.push(...(await this.embedBatch(texts.slice(i, i + VOYAGE_MAX_INPUTS_PER_BATCH))));
      }
      return results;
    }
    const data = await cloudEmbeddingCall<VoyageEmbeddingResponse>({
      url: this.url,
      apiKey: this.apiKey,
      body: this.buildBody(texts),
      timeoutMs: VOYAGE_TIMEOUT_MS,
      maxRetries: VOYAGE_MAX_RETRIES,
      providerLabel: 'Voyage',
    });
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
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
  private telemetry: Telemetry | null = null;

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

  /** Attach telemetry for embedding_calls instrumentation. Optional. */
  attachTelemetry(telemetry: Telemetry): void {
    this.telemetry = telemetry;
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
    const start = performance.now();
    let cacheHits = 0;
    let cacheMiss = 0;
    let error: string | null = null;

    try {
      const cached = this.cache.get(hash, this.model);
      if (cached) {
        cacheHits = 1;
        return cached;
      }
      cacheMiss = 1;
      const vector = await this.provider.embed(text);
      this.cache.set(hash, this.model, vector);
      return vector;
    } catch (err) {
      error = (err as Error).message.slice(0, 256);
      throw err;
    } finally {
      this.telemetry?.recordEmbedding({
        ts: Date.now(),
        kind: 'query',
        batchSize: 1,
        cacheHits,
        cacheMiss,
        durationMs: Math.round(performance.now() - start),
        timeout: false,
        error,
      });
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.embedCalls += texts.length;
    const start = performance.now();
    let cacheHits = 0;
    let cacheMiss = 0;
    let error: string | null = null;

    try {
      const model = this.model;
      const hashes = texts.map((t) => createHash('sha256').update(t).digest('hex').slice(0, 32));
      const results: (number[] | null)[] = hashes.map((h) => this.cache.get(h, model));

      const uncachedIndices: number[] = [];
      const uncachedTexts: string[] = [];
      results.forEach((r, i) => {
        if (r === null) {
          uncachedIndices.push(i);
          uncachedTexts.push(texts[i]!);
        } else {
          cacheHits++;
        }
      });
      cacheMiss = uncachedTexts.length;

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
    } catch (err) {
      error = (err as Error).message.slice(0, 256);
      throw err;
    } finally {
      this.telemetry?.recordEmbedding({
        ts: Date.now(),
        kind: 'batch',
        batchSize: texts.length,
        cacheHits,
        cacheMiss,
        durationMs: Math.round(performance.now() - start),
        timeout: false,
        error,
      });
    }
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
  apiKey?: string;
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
    case 'openai':
      if (!config.apiKey) {
        throw new Error('OpenAI provider requires apiKey (set OPENAI_API_KEY)');
      }
      base = new OpenAIProvider({
        apiKey: config.apiKey,
        model: config.model,
        dimensions: config.dimensions,
      });
      break;
    case 'voyage':
      if (!config.apiKey) {
        throw new Error('Voyage provider requires apiKey (set VOYAGE_API_KEY)');
      }
      base = new VoyageProvider({
        apiKey: config.apiKey,
        model: config.model,
        dimensions: config.dimensions,
      });
      break;
    default:
      throw new Error(`Unsupported embedding provider: ${config.provider}`);
  }

  // Auto-enable task prefixes for Jina code embedding models (Ollama).
  // OpenAI and Voyage handle task differentiation natively; for Voyage we
  // toggle via setInputType() inside the searcher hot path.
  const taskPrefixes = config.taskPrefixes ?? {
    enabled: config.model.includes('jina-code') || config.model.includes('jina_code'),
  };

  return new CachedEmbeddingProvider(base, undefined, taskPrefixes);
}

/**
 * Resolve provider config from process.env. Centralises the env-var contract
 * so server and indexer agree on defaults and the install flow has one place
 * to mirror.
 *
 * Precedence: explicit EMBEDDING_PROVIDER → openai if OPENAI_API_KEY set →
 * voyage if VOYAGE_API_KEY set → ollama. The auto-detect is intentional: a
 * user who supplies an OpenAI key but forgets EMBEDDING_PROVIDER almost
 * certainly meant "use OpenAI", not "use Ollama and ignore my key".
 */
export interface ResolvedEmbeddingConfig {
  provider: 'ollama' | 'openai' | 'voyage';
  model: string;
  dimensions: number;
  apiKey?: string;
}

export function resolveEmbeddingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ResolvedEmbeddingConfig {
  const explicit = env['EMBEDDING_PROVIDER']?.trim().toLowerCase();
  const openaiKey = env['OPENAI_API_KEY']?.trim();
  const voyageKey = env['VOYAGE_API_KEY']?.trim();

  let provider: ResolvedEmbeddingConfig['provider'];
  if (explicit === 'openai' || explicit === 'voyage' || explicit === 'ollama') {
    provider = explicit;
  } else if (openaiKey) {
    provider = 'openai';
  } else if (voyageKey) {
    provider = 'voyage';
  } else {
    provider = 'ollama';
  }

  const modelEnv = env['EMBEDDING_MODEL']?.trim();
  const dimEnv = env['EMBEDDING_DIMENSIONS']?.trim();
  const dimEnvParsed = dimEnv ? parseInt(dimEnv, 10) : NaN;

  if (provider === 'openai') {
    if (!openaiKey) {
      throw new Error(
        'EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY (none found in environment)'
      );
    }
    return {
      provider: 'openai',
      model: modelEnv || 'text-embedding-3-small',
      dimensions: Number.isFinite(dimEnvParsed) ? dimEnvParsed : 1536,
      apiKey: openaiKey,
    };
  }
  if (provider === 'voyage') {
    if (!voyageKey) {
      throw new Error(
        'EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY (none found in environment)'
      );
    }
    return {
      provider: 'voyage',
      model: modelEnv || 'voyage-code-3',
      dimensions: Number.isFinite(dimEnvParsed) ? dimEnvParsed : 1024,
      apiKey: voyageKey,
    };
  }
  return {
    provider: 'ollama',
    model: modelEnv || 'jina-code-embeddings',
    dimensions: Number.isFinite(dimEnvParsed) ? dimEnvParsed : 1536,
  };
}
