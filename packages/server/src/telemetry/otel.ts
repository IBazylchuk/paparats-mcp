// OpenTelemetry sink. Lazily imported via factory.ts only when
// PAPARATS_OTEL_ENABLED=true and OTEL_EXPORTER_OTLP_ENDPOINT is set.
// Spans are emitted for every event so external collectors (Tempo, Jaeger,
// Honeycomb, Datadog, Grafana Cloud) can observe the same data shape that
// SqliteSink stores locally.

import { trace, type Span, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { tctx } from './context.js';
import type { TelemetrySink } from './facade.js';
import type {
  ChunkFetchEvent,
  ChunkingErrorEvent,
  EmbeddingCallEvent,
  FileSnapshotRecord,
  IndexingRunEvent,
  SearchRecordEvent,
  ToolCallEvent,
} from './types.js';

export interface OtelSinkOptions {
  serviceName: string;
  serviceVersion?: string;
  endpoint: string;
  headers?: Record<string, string>;
  /** Extra resource attributes (parsed from OTEL_RESOURCE_ATTRIBUTES). */
  resourceAttributes?: Record<string, string>;
}

export class OtelSink implements TelemetrySink {
  private tracer: Tracer;
  private processor: SpanProcessor;
  private provider: BasicTracerProvider;
  private closed = false;

  constructor(opts: OtelSinkOptions) {
    const exporter = new OTLPTraceExporter({
      url: opts.endpoint,
      headers: opts.headers ?? {},
    });
    this.processor = new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      scheduledDelayMillis: 5000,
    });
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: opts.serviceName,
        [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? 'dev',
        ...(opts.resourceAttributes ?? {}),
      }),
      spanProcessors: [this.processor],
    });
    this.tracer = this.provider.getTracer('paparats-mcp');
    // Register globally so spans created elsewhere (e.g. via @opentelemetry/api) flow here.
    trace.setGlobalTracerProvider(this.provider);
  }

  private withIdentity(span: Span, extra?: Record<string, unknown>): Span {
    const ctx = tctx.getOrAnonymous();
    span.setAttributes({
      'paparats.user': ctx.user,
      'paparats.session': ctx.session ?? 'none',
      'paparats.client': ctx.client ?? 'none',
      'paparats.request_id': ctx.requestId,
      ...(ctx.anchorProject ? { 'paparats.anchor_project': ctx.anchorProject } : {}),
      ...flatten(extra),
    });
    return span;
  }

  recordSearch(event: SearchRecordEvent): void {
    if (this.closed) return;
    const span = this.tracer.startSpan('paparats.search', {
      attributes: {
        'paparats.tool': event.tool,
        'paparats.group': event.groupName ?? 'unknown',
        'paparats.anchor_project': event.anchorProject ?? 'none',
        'paparats.query.hash': event.queryHash,
        'paparats.query.length': event.queryText.length,
        'paparats.search.limit': event.limit,
        'paparats.search.duration_ms': event.durationMs,
        'paparats.search.result_count': event.resultCount,
        'paparats.search.cache_hit': event.cacheHit,
      },
    });
    this.withIdentity(span);
    if (event.error) {
      span.recordException(new Error(event.error));
      span.setStatus({ code: 2, message: event.error });
    }
    span.end();
  }

  recordChunkFetch(event: ChunkFetchEvent): void {
    if (this.closed) return;
    const span = this.tracer.startSpan('paparats.get_chunk', {
      attributes: {
        'paparats.chunk_id': event.chunkId,
        'paparats.fetch.radius_lines': event.radiusLines,
        'paparats.fetch.duration_ms': event.durationMs,
        'paparats.fetch.found': event.found,
      },
    });
    this.withIdentity(span);
    span.end();
  }

  recordToolCall(event: ToolCallEvent): void {
    if (this.closed) return;
    const span = this.tracer.startSpan('paparats.mcp.tool', {
      attributes: {
        'paparats.tool': event.tool,
        'paparats.tool.duration_ms': event.durationMs,
        'paparats.tool.ok': event.ok,
      },
    });
    this.withIdentity(span);
    if (event.error) {
      span.recordException(new Error(event.error));
      span.setStatus({ code: 2, message: event.error });
    }
    span.end();
  }

  recordIndexingRun(event: IndexingRunEvent): void {
    if (this.closed) return;
    const span = this.tracer.startSpan('paparats.indexing.run', {
      attributes: {
        'paparats.indexing.run_id': event.id,
        'paparats.group': event.groupName,
        'paparats.project': event.projectName ?? 'multi',
        'paparats.indexing.trigger': event.trigger,
        'paparats.indexing.status': event.status,
        'paparats.indexing.files_total': event.filesTotal,
        'paparats.indexing.files_skipped': event.filesSkipped,
        'paparats.indexing.chunks_total': event.chunksTotal,
        'paparats.indexing.errors_total': event.errorsTotal,
      },
    });
    span.end();
  }

  recordChunkingError(event: ChunkingErrorEvent): void {
    if (this.closed) return;
    const span = this.tracer.startSpan('paparats.indexing.chunking_error', {
      attributes: {
        'paparats.group': event.groupName,
        'paparats.project': event.projectName,
        'paparats.file': event.file,
        'paparats.language': event.language ?? 'unknown',
        'paparats.chunking.error_class': event.errorClass,
      },
    });
    if (event.message) span.recordException(new Error(event.message));
    span.setStatus({ code: 2, message: event.errorClass });
    span.end();
  }

  recordEmbedding(event: EmbeddingCallEvent): void {
    if (this.closed) return;
    const span = this.tracer.startSpan('paparats.embedding', {
      attributes: {
        'paparats.embedding.kind': event.kind,
        'paparats.embedding.batch_size': event.batchSize,
        'paparats.embedding.cache_hits': event.cacheHits,
        'paparats.embedding.cache_miss': event.cacheMiss,
        'paparats.embedding.duration_ms': event.durationMs,
        'paparats.embedding.timeout': event.timeout,
      },
    });
    this.withIdentity(span);
    if (event.error) {
      span.recordException(new Error(event.error));
      span.setStatus({ code: 2, message: event.error });
    }
    span.end();
  }

  upsertFile(_record: FileSnapshotRecord): void {
    // No-op: file snapshots only matter for token-savings SQL aggregation.
  }

  resolvePrecedingSearchId(): string | null {
    return null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.provider.shutdown();
  }
}

function flatten(obj?: Record<string, unknown>): Record<string, string | number | boolean> {
  if (!obj) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
