import { AnalyticsStore } from './analytics-store.js';
import { createTelemetry, type Telemetry, type TelemetrySink } from './facade.js';

export interface BuildTelemetryOptions {
  /** Override the analytics DB path (otherwise PAPARATS_ANALYTICS_DB_PATH or default). */
  analyticsDbPath?: string;
  /** When provided, takes precedence over PAPARATS_ANALYTICS_ENABLED. */
  analyticsEnabled?: boolean;
  /** Override the OTel service name (defaults to OTEL_SERVICE_NAME or 'paparats-mcp'). */
  otelServiceName?: string;
  /** Override the OTel service version (defaults to package.json version). */
  otelServiceVersion?: string;
}

export interface BuiltTelemetry {
  telemetry: Telemetry;
  analytics: AnalyticsStore | null;
}

/** Boot the telemetry façade with configured sinks. Safe defaults. */
export async function buildTelemetry(options: BuildTelemetryOptions = {}): Promise<BuiltTelemetry> {
  const sinks: TelemetrySink[] = [];

  const analyticsEnabled =
    options.analyticsEnabled ??
    (process.env.PAPARATS_ANALYTICS_ENABLED ?? 'true').toLowerCase() !== 'false';

  let analytics: AnalyticsStore | null = null;
  if (analyticsEnabled) {
    try {
      analytics = new AnalyticsStore({
        dbPath: options.analyticsDbPath ?? process.env.PAPARATS_ANALYTICS_DB_PATH,
        logResultFiles: (process.env.PAPARATS_LOG_RESULT_FILES ?? 'true').toLowerCase() !== 'false',
        logQueryText: (process.env.PAPARATS_LOG_QUERY_TEXT ?? 'true').toLowerCase() !== 'false',
      });
      sinks.push(analytics);
    } catch (err) {
      console.warn(
        `[telemetry] Failed to initialize analytics store (non-fatal): ${(err as Error).message}`
      );
    }
  }

  // OTel sink — lazy-loaded only when explicitly enabled. The dynamic import
  // keeps cold start fast (~80 ms saved) when OTel is off.
  const otelEnabled = (process.env.PAPARATS_OTEL_ENABLED ?? 'false').toLowerCase() === 'true';
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otelEnabled && otelEndpoint) {
    try {
      const { OtelSink, parseHeaders, parseResourceAttributes } = await import('./otel.js');
      const sink = new OtelSink({
        serviceName: options.otelServiceName ?? process.env.OTEL_SERVICE_NAME ?? 'paparats-mcp',
        serviceVersion: options.otelServiceVersion,
        endpoint: otelEndpoint,
        headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
        resourceAttributes: parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
      });
      sinks.push(sink);
      console.log(`[telemetry] OpenTelemetry exporter configured: ${otelEndpoint}`);
    } catch (err) {
      console.warn(
        `[telemetry] OTel sink initialization failed (non-fatal): ${(err as Error).message}`
      );
    }
  }

  const sampleRate = Math.max(
    0,
    Math.min(1, parseFloat(process.env.PAPARATS_TELEMETRY_SAMPLE_RATE ?? '1.0'))
  );

  return { telemetry: createTelemetry({ sinks, sampleRate }), analytics };
}
