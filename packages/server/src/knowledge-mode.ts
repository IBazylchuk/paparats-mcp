import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from 'express';
import { DEFAULT_AUDIENCE, validateAudienceLabel } from './docs/store.js';

/**
 * The knowledge MCP mode: a docs-only endpoint for a consumer outside the trust
 * boundary — typically an agent backend in another network, calling through a
 * load balancer that forwards this one path.
 *
 * It serves `search_docs` and `get_document` and nothing else, behind bearer-token
 * auth, limited to an audience ceiling and an optional project allowlist of its
 * own. Every guarantee is enforced by this server: nothing relies on the caller
 * or the proxy in front of it.
 */

/** The only path the mode answers on. No SSE, no `/messages`. */
export const KNOWLEDGE_MCP_PATH = '/knowledge/mcp';

/**
 * JSON body limit for the mode, in bytes. A tool call is a short query or a
 * (project, file) pair; the global 50 MB limit exists for the indexing API, which
 * this endpoint must never inherit.
 */
export const KNOWLEDGE_MAX_BODY_BYTES = 64 * 1024;

/** Longest `search_docs` query the mode accepts, in characters. */
export const KNOWLEDGE_MAX_QUERY_CHARS = 1000;

/**
 * Shortest token accepted. A bearer token is the only credential on a route
 * reachable from another network, so a placeholder like `changeme` must not pass.
 */
export const KNOWLEDGE_MIN_TOKEN_LENGTH = 16;

/** RFC 6750 `b64token` — the characters a bearer token may carry. */
const TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** Parsed knowledge-mode settings. */
export interface KnowledgeModeConfig {
  /** Accepted bearer tokens. Never logged. */
  tokens: string[];
  /** Audience labels the mode may serve — its ceiling. Never includes `internal`. */
  audience: string[];
  /** Projects the mode may serve, or null for every project. */
  projects: string[] | null;
}

/** The part of {@link KnowledgeModeConfig} the MCP handler needs: no secrets. */
export interface KnowledgeScope {
  audience: string[];
  projects: string[] | null;
}

function splitList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  );
}

/**
 * Read the knowledge mode from `PAPARATS_KNOWLEDGE_TOKENS`,
 * `PAPARATS_KNOWLEDGE_AUDIENCE` and `PAPARATS_KNOWLEDGE_PROJECTS`.
 *
 * Returns null — mode off, route not mounted — when neither tokens nor audience
 * is set. A variable assigned the empty string counts as unset, which is what an
 * unset `${VAR}` becomes in a Compose file.
 *
 * Throws when the mode is half-configured: one of the two required variables
 * missing, a value that trims to nothing, a malformed token or label, or a
 * project allowlist without the mode. An operator who set any of these meant to
 * publish something under specific rules; starting without those rules (or
 * without the endpoint they expected) is the one wrong outcome.
 */
export function parseKnowledgeModeEnv(
  env: Record<string, string | undefined>
): KnowledgeModeConfig | null {
  const rawTokens = env['PAPARATS_KNOWLEDGE_TOKENS'];
  const rawAudience = env['PAPARATS_KNOWLEDGE_AUDIENCE'];
  const rawProjects = env['PAPARATS_KNOWLEDGE_PROJECTS'];
  const isSet = (v: string | undefined): v is string => v !== undefined && v !== '';

  if (!isSet(rawTokens) && !isSet(rawAudience)) {
    if (isSet(rawProjects)) {
      throw new Error(
        'PAPARATS_KNOWLEDGE_PROJECTS is set but the knowledge mode is off. Set ' +
          'PAPARATS_KNOWLEDGE_TOKENS and PAPARATS_KNOWLEDGE_AUDIENCE as well, or unset it.'
      );
    }
    return null;
  }
  if (!isSet(rawTokens) || !isSet(rawAudience)) {
    const missing = isSet(rawTokens) ? 'PAPARATS_KNOWLEDGE_AUDIENCE' : 'PAPARATS_KNOWLEDGE_TOKENS';
    throw new Error(
      `The knowledge mode needs both PAPARATS_KNOWLEDGE_TOKENS and PAPARATS_KNOWLEDGE_AUDIENCE, ` +
        `but ${missing} is not set. Refusing to start half-configured — set both, or unset both ` +
        `to turn the mode off.`
    );
  }

  const tokens = splitList(rawTokens);
  if (tokens.length === 0) {
    throw new Error('PAPARATS_KNOWLEDGE_TOKENS is set but lists no tokens.');
  }
  tokens.forEach((token, i) => {
    // The message names the position, never the value: a token must not reach a log.
    if (token.length < KNOWLEDGE_MIN_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
      throw new Error(
        `PAPARATS_KNOWLEDGE_TOKENS: token #${i + 1} is not usable. Tokens must be at least ` +
          `${KNOWLEDGE_MIN_TOKEN_LENGTH} characters of A-Z a-z 0-9 - . _ ~ + / ` +
          `(for example the output of \`openssl rand -hex 32\`).`
      );
    }
  });

  const audience = splitList(rawAudience);
  if (audience.length === 0) {
    throw new Error('PAPARATS_KNOWLEDGE_AUDIENCE is set but lists no labels.');
  }
  for (const label of audience) {
    validateAudienceLabel(label, 'PAPARATS_KNOWLEDGE_AUDIENCE label');
    if (label === DEFAULT_AUDIENCE) {
      throw new Error(
        `PAPARATS_KNOWLEDGE_AUDIENCE must not include "${DEFAULT_AUDIENCE}": every unlabelled ` +
          `document reads as "${DEFAULT_AUDIENCE}", so the mode would publish all of them. ` +
          `Label the documents it may serve (e.g. "client") and list that label instead.`
      );
    }
  }

  let projects: string[] | null = null;
  if (isSet(rawProjects)) {
    projects = splitList(rawProjects);
    if (projects.length === 0) {
      throw new Error('PAPARATS_KNOWLEDGE_PROJECTS is set but lists no projects.');
    }
  }

  return { tokens, audience, projects };
}

/** Intersect two allowlists, where null means "no restriction". */
export function intersectAllowlists(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  const keep = new Set(b);
  return a.filter((x) => keep.has(x));
}

/**
 * What the mode may actually serve: its own ceiling and allowlist intersected
 * with the process-wide `PAPARATS_DOCS_AUDIENCE` / `PAPARATS_PROJECTS` when those
 * are set. The globals can only narrow it. An empty audience means the mode
 * serves nothing.
 */
export function effectiveKnowledgeScope(
  scope: KnowledgeScope,
  globals: { docsAudience: string[] | null; projects: string[] | null }
): KnowledgeScope {
  return {
    audience: intersectAllowlists(scope.audience, globals.docsAudience) ?? [],
    projects: intersectAllowlists(scope.projects, globals.projects),
  };
}

// ── Request guards ──────────────────────────────────────────────────────────

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Whether `presented` equals one of the accepted tokens, in time independent of
 * where the two differ. Both sides are hashed first so `timingSafeEqual` always
 * compares equal-length buffers — comparing raw strings would leak the length.
 * Every token is checked, with no early exit.
 */
function tokenMatches(presented: string, digests: Buffer[]): boolean {
  const given = sha256(presented);
  let matched = false;
  for (const digest of digests) {
    matched = timingSafeEqual(given, digest) || matched;
  }
  return matched;
}

/** Requests that passed {@link knowledgeBearerAuth}. Unforgeable by other middleware. */
const authenticated = new WeakSet<Request>();

/**
 * Whether the request passed the knowledge-mode bearer check. The MCP handler
 * refuses to serve the mode without it, so a route mounted without its guards
 * fails closed instead of open.
 */
export function isKnowledgeAuthenticated(req: Request): boolean {
  return authenticated.has(req);
}

/** `Authorization: Bearer <token>`, checked before anything reads the request body. */
export function knowledgeBearerAuth(tokens: string[]): RequestHandler {
  const digests = tokens.map(sha256);
  return (req, res, next) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer +(\S+) *$/i.exec(header) : null;
    if (match && tokenMatches(match[1]!, digests)) {
      authenticated.add(req);
      next();
      return;
    }
    res.set(
      'WWW-Authenticate',
      match
        ? 'Bearer realm="paparats-knowledge", error="invalid_token"'
        : 'Bearer realm="paparats-knowledge"'
    );
    res.status(401).json(jsonRpcError(-32001, 'Unauthorized'));
  };
}

/** Body-parser failures on this route answered as JSON-RPC errors, not HTML pages. */
const knowledgeBodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  const { type, status } = err as { type?: unknown; status?: unknown };
  if (type === 'entity.too.large') {
    res
      .status(413)
      .json(jsonRpcError(-32600, `Request body exceeds ${KNOWLEDGE_MAX_BODY_BYTES} bytes`));
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json(jsonRpcError(-32700, 'Parse error: request body is not valid JSON'));
    return;
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json(jsonRpcError(-32600, 'Invalid request'));
    return;
  }
  next(err);
};

/**
 * Middleware for {@link KNOWLEDGE_MCP_PATH}, to be mounted BEFORE the app's global
 * JSON parser: bearer auth first, so an unauthenticated caller cannot make the
 * server read a body at all, then a small JSON parser that claims the body so
 * the global 50 MB one never sees it.
 *
 * The parser accepts any content type. Leaving a non-JSON body unparsed would
 * hand the raw stream to the MCP transport, which reads it without a limit.
 */
export function knowledgeRequestGuards(
  config: Pick<KnowledgeModeConfig, 'tokens'>
): Array<RequestHandler | ErrorRequestHandler> {
  return [
    knowledgeBearerAuth(config.tokens),
    express.json({ limit: KNOWLEDGE_MAX_BODY_BYTES, type: () => true }),
    knowledgeBodyErrors,
  ];
}
