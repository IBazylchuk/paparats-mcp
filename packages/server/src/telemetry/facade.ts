import { tctx } from './context.js';
import type {
  ChunkFetchEvent,
  ChunkingErrorEvent,
  EmbeddingCallEvent,
  FileSnapshotRecord,
  IndexingRunEvent,
  SearchRecordEvent,
  ToolCallEvent,
} from './types.js';

export interface TelemetrySink {
  recordSearch(event: SearchRecordEvent): void;
  recordChunkFetch(event: ChunkFetchEvent): void;
  recordToolCall(event: ToolCallEvent): void;
  recordIndexingRun(event: IndexingRunEvent): void;
  recordChunkingError(event: ChunkingErrorEvent): void;
  recordEmbedding(event: EmbeddingCallEvent): void;
  upsertFile(record: FileSnapshotRecord): void;
  /** Resolve the most recent search_event id for the current user/session that returned a row matching chunkId. Returns null when no match. */
  resolvePrecedingSearchId(chunkId: string, user: string, session: string | null): string | null;
  close(): void;
}

export interface Telemetry extends TelemetrySink {
  /** Wrap an async operation in a span. Always invokes fn; sinks may attach trace context. */
  span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
}

class FanoutTelemetry implements Telemetry {
  constructor(
    private readonly sinks: TelemetrySink[],
    private readonly sampleRate: number = 1.0
  ) {}

  /**
   * Roll a Bernoulli for sampling. Errors are always sampled (rate=Infinity)
   * because telemetry on errors is far more valuable than savings.
   */
  private sampled(forceKeep = false): boolean {
    if (forceKeep) return true;
    if (this.sampleRate >= 1.0) return true;
    if (this.sampleRate <= 0) return false;
    return Math.random() < this.sampleRate;
  }

  recordSearch(event: SearchRecordEvent): void {
    if (!this.sampled(event.error !== null)) return;
    for (const s of this.sinks) {
      try {
        s.recordSearch(event);
      } catch (err) {
        console.warn('[telemetry] sink.recordSearch failed:', (err as Error).message);
      }
    }
  }
  recordChunkFetch(event: ChunkFetchEvent): void {
    if (!this.sampled()) return;
    for (const s of this.sinks) {
      try {
        s.recordChunkFetch(event);
      } catch (err) {
        console.warn('[telemetry] sink.recordChunkFetch failed:', (err as Error).message);
      }
    }
  }
  recordToolCall(event: ToolCallEvent): void {
    if (!this.sampled(!event.ok)) return;
    for (const s of this.sinks) {
      try {
        s.recordToolCall(event);
      } catch (err) {
        console.warn('[telemetry] sink.recordToolCall failed:', (err as Error).message);
      }
    }
  }
  recordIndexingRun(event: IndexingRunEvent): void {
    for (const s of this.sinks) {
      try {
        s.recordIndexingRun(event);
      } catch (err) {
        console.warn('[telemetry] sink.recordIndexingRun failed:', (err as Error).message);
      }
    }
  }
  recordChunkingError(event: ChunkingErrorEvent): void {
    for (const s of this.sinks) {
      try {
        s.recordChunkingError(event);
      } catch (err) {
        console.warn('[telemetry] sink.recordChunkingError failed:', (err as Error).message);
      }
    }
  }
  recordEmbedding(event: EmbeddingCallEvent): void {
    for (const s of this.sinks) {
      try {
        s.recordEmbedding(event);
      } catch (err) {
        console.warn('[telemetry] sink.recordEmbedding failed:', (err as Error).message);
      }
    }
  }
  upsertFile(record: FileSnapshotRecord): void {
    for (const s of this.sinks) {
      try {
        s.upsertFile(record);
      } catch (err) {
        console.warn('[telemetry] sink.upsertFile failed:', (err as Error).message);
      }
    }
  }
  resolvePrecedingSearchId(chunkId: string, user: string, session: string | null): string | null {
    for (const s of this.sinks) {
      try {
        const id = s.resolvePrecedingSearchId(chunkId, user, session);
        if (id) return id;
      } catch {
        // continue
      }
    }
    return null;
  }
  async span<T>(name: string, _attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    // OTel sink will plug into this once it's installed; for now just run.
    return fn();
  }
  close(): void {
    for (const s of this.sinks) {
      try {
        s.close();
      } catch {
        // ignore
      }
    }
  }
}

class NoOpSink implements TelemetrySink {
  recordSearch(): void {}
  recordChunkFetch(): void {}
  recordToolCall(): void {}
  recordIndexingRun(): void {}
  recordChunkingError(): void {}
  recordEmbedding(): void {}
  upsertFile(): void {}
  resolvePrecedingSearchId(): string | null {
    return null;
  }
  close(): void {}
}

export interface CreateTelemetryOptions {
  sinks?: TelemetrySink[];
  /** Sampling rate (0..1). Errors are always kept regardless. */
  sampleRate?: number;
}

export function createTelemetry(options: CreateTelemetryOptions = {}): Telemetry {
  const sinks = options.sinks && options.sinks.length > 0 ? options.sinks : [new NoOpSink()];
  const sampleRate = options.sampleRate ?? 1.0;
  return new FanoutTelemetry(sinks, sampleRate);
}

/** Convenience accessor: read current identity context. */
export function currentIdentity() {
  return tctx.getOrAnonymous();
}
