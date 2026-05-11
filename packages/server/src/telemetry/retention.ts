import type { AnalyticsStore } from './analytics-store.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionConfig {
  retentionDays: number;
  runHour: number; // 0-23 local time
}

export function getRetentionConfig(): RetentionConfig {
  const retentionDays = Math.max(
    1,
    parseInt(process.env.PAPARATS_ANALYTICS_RETENTION_DAYS ?? '90', 10)
  );
  const runHour = Math.max(
    0,
    Math.min(23, parseInt(process.env.PAPARATS_ANALYTICS_RETENTION_RUN_HOUR ?? '3', 10))
  );
  return { retentionDays, runHour };
}

/** Run a single retention pass immediately. Returns rows removed. */
export function runRetention(store: AnalyticsStore, retentionDays: number): number {
  const cutoff = Date.now() - retentionDays * DAY_MS;
  return store.pruneOlderThan(cutoff);
}

/**
 * Schedule a daily retention prune. Returns a stop function.
 * The first run is delayed by 60s after boot to avoid blocking startup.
 * Subsequent checks run every hour; the actual prune fires at runHour local time.
 */
export function scheduleRetention(
  store: AnalyticsStore,
  config: RetentionConfig = getRetentionConfig()
): () => void {
  let lastRun = 0;

  const tick = (): void => {
    const now = new Date();
    const hour = now.getHours();
    if (hour !== config.runHour) return;
    if (Date.now() - lastRun < 23 * HOUR_MS) return; // already ran in this window
    try {
      const removed = runRetention(store, config.retentionDays);
      lastRun = Date.now();
      console.log(
        `[analytics] Retention prune: removed ${removed} rows older than ${config.retentionDays}d`
      );
    } catch (err) {
      console.warn(`[analytics] Retention prune failed: ${(err as Error).message}`);
    }
  };

  // Initial deferred check
  const initial = setTimeout(tick, 60 * 1000);
  initial.unref?.();

  // Hourly check
  const interval = setInterval(tick, HOUR_MS);
  interval.unref?.();

  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
