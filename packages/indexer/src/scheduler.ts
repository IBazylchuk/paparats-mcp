import cron from 'node-cron';

/**
 * Start a cron-based scheduler that runs the given task on the specified schedule.
 * Returns the cron task handle for stopping.
 */
export function startScheduler(
  cronExpression: string,
  task: () => Promise<void>
): cron.ScheduledTask {
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression: "${cronExpression}"`);
  }

  console.log(`[scheduler] Starting with cron: ${cronExpression}`);

  const scheduled = cron.schedule(cronExpression, async () => {
    console.log(`[scheduler] Triggered at ${new Date().toISOString()}`);
    try {
      await task();
    } catch (err) {
      console.error('[scheduler] Task failed:', (err as Error).message);
    }
  });

  return scheduled;
}

/**
 * Calculate the next scheduled run time from a cron expression.
 * Returns ISO string or undefined if unable to determine.
 */
export function getNextRun(cronExpression: string): string | undefined {
  try {
    // node-cron doesn't expose next run time directly,
    // but we can use a basic heuristic
    if (!cron.validate(cronExpression)) return undefined;
    return undefined; // Caller should track manually
  } catch {
    return undefined;
  }
}
