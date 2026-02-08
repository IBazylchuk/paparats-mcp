import http from 'node:http';
import https from 'node:https';

const DEFAULT_BASE_URL = 'http://localhost:9876';
const MAX_RESPONSE_SIZE = 100 * 1024 * 1024; // 100MB

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
}

export interface IndexConfig {
  chunkSize?: number;
  overlap?: number;
  batchSize?: number;
  concurrency?: number;
  languages?: string[];
}

export interface IndexFile {
  path: string;
  content: string;
  language?: string;
}

export interface ApiClientOptions {
  baseUrl?: string;
  defaultTimeout?: number;
  maxRetries?: number;
  debug?: boolean;
}

interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

function formatConnectionError(err: NodeJS.ErrnoException, baseUrl: string): string {
  if (err.code === 'ABORT_ERR' || err.name === 'AbortError') {
    return 'Request aborted';
  }

  let message = `Failed to connect to ${baseUrl}`;

  switch (err.code) {
    case 'ECONNREFUSED':
      message += ' - Connection refused. Is the server running?';
      break;
    case 'ENOTFOUND':
      message += ' - Host not found. Check the URL.';
      break;
    case 'ETIMEDOUT':
      message += ' - Connection timed out.';
      break;
    case 'ECONNRESET':
      message += ' - Connection reset by server.';
      break;
    default:
      message += ` - ${err.message}`;
  }

  return message;
}

export class ApiClient {
  private baseUrl: string;
  private defaultTimeout: number;
  private maxRetries: number;
  private debug: boolean;

  constructor(options?: ApiClientOptions | string) {
    const opts = typeof options === 'string' ? { baseUrl: options } : (options ?? {});
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultTimeout = opts.defaultTimeout ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.debug = opts.debug ?? false;

    try {
      new URL(this.baseUrl);
    } catch {
      throw new Error(`Invalid base URL: ${this.baseUrl}`);
    }
  }

  private log(message: string, data?: unknown): void {
    if (this.debug) {
      console.error(`[ApiClient] ${message}`, data ?? '');
    }
  }

  async request<T = unknown>(options: RequestOptions): Promise<ApiResponse<T>> {
    const url = new URL(options.path, this.baseUrl);
    const payload = options.body ? JSON.stringify(options.body) : undefined;
    const client = url.protocol === 'https:' ? https : http;
    const timeout = options.timeout ?? this.defaultTimeout;

    this.log(`${options.method} ${url.href}`, options.body);

    return new Promise((resolve, reject) => {
      const req = client.request(
        url,
        {
          method: options.method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
          },
          timeout,
          ...(options.signal && { signal: options.signal }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalLength = 0;

          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            totalLength += chunk.length;

            if (totalLength > MAX_RESPONSE_SIZE) {
              req.destroy();
              reject(new Error('Response too large (>100MB)'));
            }
          });

          res.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf-8');
              const data = body ? (JSON.parse(body) as T) : ({} as T);
              const status = res.statusCode ?? 500;

              this.log(`Response: ${status}`);

              if (status >= 400) {
                const errorMsg = (data as { error?: string })?.error ?? `HTTP ${status} error`;
                reject(new Error(`HTTP ${status}: ${errorMsg}`));
              } else {
                resolve({ status, data });
              }
            } catch {
              const body = Buffer.concat(chunks).toString('utf-8');
              reject(new Error(`Invalid JSON response: ${body.slice(0, 200)}`));
            }
          });
        }
      );

      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(new Error(formatConnectionError(err, this.baseUrl)));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${timeout}ms`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  private async requestWithRetry<T = unknown>(
    options: RequestOptions,
    skipRetry?: boolean
  ): Promise<ApiResponse<T>> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < (skipRetry ? 1 : this.maxRetries); attempt++) {
      try {
        return await this.request<T>(options);
      } catch (err) {
        lastError = err as Error;

        if (skipRetry) throw lastError;

        const msg = lastError.message;
        if (
          msg.includes('HTTP 4') ||
          msg.includes('Invalid JSON') ||
          msg.includes('Response too large')
        ) {
          throw lastError;
        }

        if (attempt < this.maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
          this.log(`Retry ${attempt + 1}/${this.maxRetries} after ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }

  async search(
    group: string,
    query: string,
    options?: { project?: string; limit?: number; timeout?: number; signal?: AbortSignal }
  ): Promise<ApiResponse> {
    return this.requestWithRetry({
      method: 'POST',
      path: '/api/search',
      body: { group, query, project: options?.project ?? 'all', limit: options?.limit ?? 5 },
      timeout: options?.timeout ?? 30_000,
      signal: options?.signal,
    });
  }

  /** Content-based index: send group, project, config, and files with content */
  async indexContent(
    group: string,
    project: string,
    files: IndexFile[],
    options?: {
      config?: IndexConfig;
      force?: boolean;
      timeout?: number;
      signal?: AbortSignal;
    }
  ): Promise<ApiResponse> {
    return this.requestWithRetry({
      method: 'POST',
      path: '/api/index',
      body: {
        group,
        project,
        config: options?.config,
        files,
        ...(options?.force && { force: true }),
      },
      timeout: options?.timeout ?? 300_000,
      signal: options?.signal,
    });
  }

  async fileChanged(
    group: string,
    project: string,
    path: string,
    content: string,
    options?: { language?: string; timeout?: number; signal?: AbortSignal }
  ): Promise<ApiResponse> {
    return this.requestWithRetry({
      method: 'POST',
      path: '/api/file-changed',
      body: { group, project, path, content, language: options?.language },
      timeout: options?.timeout ?? 60_000,
      signal: options?.signal,
    });
  }

  async fileDeleted(
    group: string,
    project: string,
    path: string,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<ApiResponse> {
    return this.requestWithRetry({
      method: 'POST',
      path: '/api/file-deleted',
      body: { group, project, path },
      timeout: options?.timeout ?? 60_000,
      signal: options?.signal,
    });
  }

  async health(options?: { timeout?: number }): Promise<ApiResponse> {
    return this.request({ method: 'GET', path: '/health', timeout: options?.timeout ?? 5_000 });
  }

  async stats(options?: { timeout?: number }): Promise<ApiResponse> {
    return this.request({
      method: 'GET',
      path: '/api/stats',
      timeout: options?.timeout ?? 10_000,
    });
  }
}
