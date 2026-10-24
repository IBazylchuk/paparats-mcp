/**
 * True when a Qdrant client error means the collection (or point) does not exist.
 *
 * Callers use this to tell "nothing indexed here yet" — a normal state for a new
 * group — apart from Qdrant being unreachable or failing. Collapsing the two hides
 * outages: a delete that silently did nothing gets reported as done.
 */
export function isMissingCollection(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * A readable message for a Qdrant call that failed.
 *
 * When the server cannot connect at all, Node's fetch throws a bare `fetch failed`
 * and keeps the reason (`ECONNREFUSED`, `ENOTFOUND`, ...) in `cause`. Shown as is,
 * that tells the reader nothing about what to fix, so connection failures name the
 * cause and the setting to check. Any other error keeps its own message.
 */
export function describeQdrantError(err: unknown): string {
  const code = connectionErrorCode(err);
  if (code) {
    return `Cannot reach Qdrant (${code}). Check that Qdrant is running and QDRANT_URL points at it.`;
  }
  return err instanceof Error ? err.message : String(err);
}

function connectionErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const { code, errors, cause } = current as {
      code?: unknown;
      errors?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code)) return code;
    // Happy Eyeballs tries every address and reports an AggregateError of their failures.
    current = Array.isArray(errors) && errors.length > 0 ? errors[0] : cause;
  }
  return undefined;
}
