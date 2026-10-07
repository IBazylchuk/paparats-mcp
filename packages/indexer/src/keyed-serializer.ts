/**
 * Runs async tasks one at a time per key, in submission order; tasks for
 * different keys run concurrently. A failed task does not block the ones
 * queued behind it.
 *
 * The indexer keys this by project name so the cron cycles, `/trigger` and
 * the projects.yml hot-reload can never work on the same repo at once — two
 * concurrent runs race on the git working copy and write duplicate chunks.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // Drop the entry once nothing is queued behind this task.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
