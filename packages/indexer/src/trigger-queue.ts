import type { RepoConfig } from './types.js';

/** One full-cycle request: from `POST /trigger`, the slow cron, or startup. */
export interface CycleRequest {
  /** Repo identifiers (short or full name). Absent or empty = every repo. */
  repos?: string[];
  /** Drop existing chunks before reindexing the requested repos. */
  force?: boolean;
}

/** The merged requests, ready to run as a single cycle. */
export interface PendingCycle {
  /** Identifiers to run, or `undefined` for every repo. */
  filter?: string[];
  /** Whether a given repo was requested with `force`. */
  isForced(repo: RepoConfig): boolean;
}

/**
 * Collects full-cycle requests that arrive while a cycle is running so none is
 * dropped. Requests merge: the repo sets union (any "all" request makes it
 * all), and `force` sticks to the repos it was asked for — forcing one repo
 * does not force a full re-embed of everything queued beside it.
 */
export class TriggerQueue {
  private pending = false;
  private all = false;
  private forceAll = false;
  private readonly names = new Set<string>();
  private readonly forced = new Set<string>();

  add(request: CycleRequest): void {
    this.pending = true;
    const force = request.force === true;
    if (!request.repos || request.repos.length === 0) {
      this.all = true;
      if (force) this.forceAll = true;
      return;
    }
    for (const name of request.repos) {
      this.names.add(name);
      if (force) this.forced.add(name);
    }
  }

  get hasPending(): boolean {
    return this.pending;
  }

  /** Take everything queued so far, leaving the queue empty. */
  take(): PendingCycle | null {
    if (!this.pending) return null;
    const filter = this.all ? undefined : Array.from(this.names);
    const forceAll = this.forceAll;
    const forced = new Set(this.forced);
    this.pending = false;
    this.all = false;
    this.forceAll = false;
    this.names.clear();
    this.forced.clear();
    return {
      ...(filter ? { filter } : {}),
      isForced: (repo) => forceAll || forced.has(repo.name) || forced.has(repo.fullName),
    };
  }
}
