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
