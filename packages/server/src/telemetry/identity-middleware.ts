import type { RequestHandler } from 'express';
import { newContext, tctx } from './context.js';

const DEFAULT_HEADER = 'x-paparats-user';
const SESSION_HEADER = 'x-paparats-session';
const CLIENT_HEADER = 'x-paparats-client';
const ANCHOR_HEADER = 'x-paparats-anchor-project';

function readHeader(req: Parameters<RequestHandler>[0], name: string): string | null {
  const v = req.headers[name];
  if (typeof v === 'string') return v.slice(0, 256);
  if (Array.isArray(v) && v[0]) return String(v[0]).slice(0, 256);
  return null;
}

export function identityMiddleware(): RequestHandler {
  const userHeader = (process.env.PAPARATS_IDENTITY_HEADER ?? DEFAULT_HEADER).toLowerCase();
  return (req, _res, next) => {
    const user = readHeader(req, userHeader) ?? 'anonymous';
    const session = readHeader(req, SESSION_HEADER);
    const client = readHeader(req, CLIENT_HEADER);
    const anchorProject = readHeader(req, ANCHOR_HEADER);
    const ctx = newContext({ user, session, client, anchorProject });
    tctx.run(ctx, () => next());
  };
}
