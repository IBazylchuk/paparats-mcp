import { parseApiKeysEnv } from './api-key-auth.js';

/** Where the server reaches the indexer: `PAPARATS_INDEXER_URL`, else its default port here. */
export function indexerUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env['PAPARATS_INDEXER_URL'] || 'http://localhost:9877';
}

export interface RepoStatusEntry {
  repo: string;
  status: string;
  lastRun?: string;
  lastError?: string;
  chunksIndexed?: number;
}

/** The indexer's `/health`, as the server reaches it. */
export interface IndexerSection {
  reachable: boolean;
  url: string;
  globalStatus?: string;
  lastRunAt?: string;
  repos: RepoStatusEntry[];
  error?: string;
}

/**
 * The indexer's state from its `/health`: never throws, an unreachable indexer
 * comes back as `reachable: false` with the reason.
 */
export async function fetchIndexerHealth(url: string, timeoutMs = 15000): Promise<IndexerSection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The indexer shares the server's PAPARATS_API_KEY; without it, its /health names no repos.
    const key = parseApiKeysEnv(process.env)?.[0];
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    });
    if (!res.ok) {
      return { reachable: false, url, repos: [], error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      status?: string;
      lastRunAt?: string;
      repos?: RepoStatusEntry[];
    };
    return {
      reachable: true,
      url,
      globalStatus: body.status,
      lastRunAt: body.lastRunAt,
      repos: Array.isArray(body.repos) ? body.repos : [],
    };
  } catch (err) {
    // node fetch() under AbortController throws DOMException with name="AbortError"
    // and a noisy default message — surface a clear timeout message instead.
    const e = err as Error;
    const message = e.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : e.message;
    return {
      reachable: false,
      url,
      repos: [],
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
