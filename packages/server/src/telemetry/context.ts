import { AsyncLocalStorage } from 'node:async_hooks';
import { v7 as uuidv7 } from 'uuid';

export interface TelemetryContext {
  user: string;
  session: string | null;
  client: string | null;
  anchorProject: string | null;
  requestId: string;
  startedAt: number;
}

const ANONYMOUS: TelemetryContext = Object.freeze({
  user: 'anonymous',
  session: null,
  client: null,
  anchorProject: null,
  requestId: '00000000-0000-7000-8000-000000000000',
  startedAt: 0,
});

const als = new AsyncLocalStorage<TelemetryContext>();

export function newContext(partial: Partial<TelemetryContext> = {}): TelemetryContext {
  return {
    user: partial.user ?? 'anonymous',
    session: partial.session ?? null,
    client: partial.client ?? null,
    anchorProject: partial.anchorProject ?? null,
    requestId: partial.requestId ?? uuidv7(),
    startedAt: partial.startedAt ?? performance.now(),
  };
}

export const tctx = {
  run<T>(ctx: TelemetryContext, fn: () => T): T {
    return als.run(ctx, fn);
  },
  get(): TelemetryContext | undefined {
    return als.getStore();
  },
  getOrAnonymous(): TelemetryContext {
    return als.getStore() ?? ANONYMOUS;
  },
  /** Mutates the current store (used for late-binding session identity). No-op when outside a context. */
  patch(updates: Partial<TelemetryContext>): void {
    const current = als.getStore();
    if (!current) return;
    Object.assign(current, updates);
  },
};

export function systemContext(
  actor: 'watcher' | 'scheduler' | 'indexer' | 'cli'
): TelemetryContext {
  return newContext({ user: `system:${actor}` });
}
