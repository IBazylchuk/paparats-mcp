import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

/**
 * Optional API key for the whole server (and the indexer's HTTP API).
 *
 * Off by default: a server reached only over a VPN or from localhost needs no
 * key, and every route stays open as before. With `PAPARATS_API_KEY` set, every
 * route asks for `Authorization: Bearer <key>` except `/health` (which then
 * answers only its status) and the knowledge route, which has its own tokens.
 * The browser pages accept the key as a basic-auth password too, so a browser
 * can open them.
 */

/** Shortest key accepted, so a placeholder like `changeme` does not pass. */
export const MIN_TOKEN_LENGTH = 16;

/** RFC 6750 `b64token` — the characters a bearer token may carry. */
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** Whether a token is long enough and made of bearer-token characters. */
export function isUsableToken(token: string): boolean {
  return token.length >= MIN_TOKEN_LENGTH && TOKEN_PATTERN.test(token);
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Digests of the accepted tokens, for {@link tokenMatches}. */
export function tokenDigests(tokens: string[]): Buffer[] {
  return tokens.map(sha256);
}

/**
 * Whether `presented` equals one of the accepted tokens, in time independent of
 * where the two differ. Both sides are hashed first so `timingSafeEqual` always
 * compares equal-length buffers — comparing raw strings would leak the length.
 * Every token is checked, with no early exit.
 */
export function tokenMatches(presented: string, digests: Buffer[]): boolean {
  const given = sha256(presented);
  let matched = false;
  for (const digest of digests) {
    matched = timingSafeEqual(given, digest) || matched;
  }
  return matched;
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = typeof header === 'string' ? /^Bearer +(\S+) *$/i.exec(header) : null;
  return match ? match[1]! : null;
}

/** The password of an `Authorization: Basic <base64 user:password>` header, or null. */
function basicPassword(header: string | undefined): string | null {
  const match = typeof header === 'string' ? /^Basic +(\S+) *$/i.exec(header) : null;
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  return sep >= 0 ? decoded.slice(sep + 1) : null;
}

/**
 * Read `PAPARATS_API_KEY`: one key, or several separated by commas (to rotate
 * one without cutting off the clients of another). Null when unset or empty —
 * an unset `${VAR}` in a Compose file is the empty string.
 *
 * Throws on a key that is too short or has characters a bearer token cannot
 * carry: an operator who set a key meant the server to be closed, and starting
 * it open is the one wrong outcome. The message names the position, never the
 * value.
 */
export function parseApiKeysEnv(env: Record<string, string | undefined>): string[] | null {
  const raw = env['PAPARATS_API_KEY'];
  if (raw === undefined || raw.trim() === '') return null;
  const keys = Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  );
  if (keys.length === 0) throw new Error('PAPARATS_API_KEY is set but lists no keys.');
  keys.forEach((key, i) => {
    if (!isUsableToken(key)) {
      throw new Error(
        `PAPARATS_API_KEY: key #${i + 1} is not usable. Keys must be at least ` +
          `${MIN_TOKEN_LENGTH} characters of A-Z a-z 0-9 - . _ ~ + / ` +
          `(for example the output of \`openssl rand -hex 32\`).`
      );
    }
  });
  return keys;
}

/** Requests that presented a valid API key. Unforgeable by other middleware. */
const withKey = new WeakSet<Request>();

/** Whether the request presented a valid API key. Always false when keys are off. */
export function hasApiKey(req: Request): boolean {
  return withKey.has(req);
}

export interface ApiKeyAuthOptions {
  /**
   * Paths answered without a key: exact matches, or a prefix ending in `/`.
   * Such a request is still marked when it carries a valid key, so a handler
   * can tell (`/health` shows more to a caller with the key).
   */
  open?: string[];
  /** Realm named in `WWW-Authenticate`. */
  realm?: string;
}

/**
 * `Authorization: Bearer <key>` on every request but the open paths, checked
 * before anything reads the body. A basic-auth password equal to a key passes
 * too (any user name), so browser pages can be opened; a refused request whose
 * path is not an API path asks the browser for one.
 */
export function apiKeyAuth(keys: string[], options: ApiKeyAuthOptions = {}): RequestHandler {
  const digests = tokenDigests(keys);
  const open = options.open ?? [];
  const realm = options.realm ?? 'paparats';
  const isOpen = (p: string) =>
    open.some((o) => (o.endsWith('/') ? p.startsWith(o) || p === o.slice(0, -1) : p === o));
  return (req, res, next) => {
    const header = req.headers.authorization;
    const presented = bearerToken(header) ?? basicPassword(header);
    if (presented !== null && tokenMatches(presented, digests)) {
      withKey.add(req);
      next();
      return;
    }
    if (isOpen(req.path)) {
      next();
      return;
    }
    const browserPage = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
    res.set(
      'WWW-Authenticate',
      browserPage
        ? `Basic realm="${realm}"`
        : presented !== null
          ? `Bearer realm="${realm}", error="invalid_token"`
          : `Bearer realm="${realm}"`
    );
    res
      .status(401)
      .json({ error: 'Unauthorized: this server needs an API key (Authorization: Bearer <key>)' });
  };
}
