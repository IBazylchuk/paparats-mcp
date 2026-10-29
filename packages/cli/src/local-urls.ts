import fs from 'fs';
import path from 'path';
import { PAPARATS_HOME } from './projects-yml.js';

export interface LocalUrls {
  server: string;
  indexer: string;
  qdrant: string;
  /** The embed server as the host reaches it (Docker mode publishes `EMBED_PORT`, native listens on 18434). */
  embed: string;
  /**
   * The key the server and indexer ask for, when they run with `PAPARATS_API_KEY`
   * (the first one, if several are listed). Undefined when none is set.
   */
  apiKey?: string;
}

/** `KEY=value` lines of a dotenv file; comments, blanks and malformed lines are skipped. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    out[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Where the local stack answers. The generated compose publishes its ports as
 * `${PAPARATS_PORT:-9876}` and so on, read from `~/.paparats/.env`, so the CLI
 * reads the same file: a port changed there must not leave the health checks
 * and the client wiring on the default. `PAPARATS_SERVER_URL`,
 * `PAPARATS_INDEXER_URL`, `QDRANT_URL` and `EMBED_URL` in the environment replace a whole
 * URL (the Codespaces workspace reaches the stack by service name).
 */
export function localUrls(
  env: NodeJS.ProcessEnv = process.env,
  home: string = PAPARATS_HOME
): LocalUrls {
  let file: Record<string, string> = {};
  try {
    file = parseDotenv(fs.readFileSync(path.join(home, '.env'), 'utf8'));
  } catch {
    // No .env yet: defaults.
  }
  const port = (key: string, fallback: number) => env[key] || file[key] || String(fallback);
  const apiKey = (env['PAPARATS_API_KEY'] || file['PAPARATS_API_KEY'] || '')
    .split(',')
    .map((k) => k.trim())
    .find((k) => k.length > 0);
  return {
    server: env['PAPARATS_SERVER_URL'] || `http://localhost:${port('PAPARATS_PORT', 9876)}`,
    indexer: env['PAPARATS_INDEXER_URL'] || `http://localhost:${port('INDEXER_PORT', 9877)}`,
    qdrant: env['QDRANT_URL'] || `http://localhost:${port('QDRANT_PORT', 6333)}`,
    embed: env['EMBED_URL'] || `http://localhost:${port('EMBED_PORT', 18434)}`,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** `Authorization: Bearer <key>` when a key is given, else no header. */
export function authHeaders(
  apiKey: string | undefined = localUrls().apiKey
): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
