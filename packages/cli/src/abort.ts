/**
 * Returns an AbortSignal that aborts after the given timeout.
 * Uses AbortSignal.timeout() when available (Node 18+), otherwise falls back to AbortController.
 */
export function createTimeoutSignal(timeoutMs: number): AbortSignal {
  if ('timeout' in AbortSignal && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
