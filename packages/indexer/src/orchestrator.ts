import fs from 'fs';
import type { IndexProjectReport, ProjectConfig } from '@paparats/server';
import { DEFAULT_GROUP } from '@paparats/shared';
import type { Fingerprint } from './change-detector.js';
import type { ConfigChange } from './config-watcher.js';
import { KeyedSerializer } from './keyed-serializer.js';
import type { ResolvedRepoProject } from './project-resolver.js';
import type { StoredFingerprint } from './state-store.js';
import { resolveTriggerTargets } from './trigger-filter.js';
import { TriggerQueue, type CycleRequest, type PendingCycle } from './trigger-queue.js';
import type { HealthResponse, RepoConfig, RepoStatus, RunStatus } from './types.js';

/** The `Indexer` surface the orchestrator drives. */
export interface IndexerLike {
  indexProjectWithReport(project: ProjectConfig): Promise<IndexProjectReport>;
  indexDocsProject(project: ProjectConfig): Promise<number>;
  deleteProjectChunks(group: string, project: string): Promise<void>;
  purgeProject(group: string, project: string): Promise<void>;
}

export interface FingerprintStore {
  get(fullName: string): StoredFingerprint | undefined;
  set(fullName: string, fingerprint: string, kind: string, chunks: number | undefined): void;
  delete(fullName: string): void;
}

export interface OrchestratorDeps {
  indexer: IndexerLike;
  stateStore: FingerprintStore;
  /** Clone or update a remote repo; no-op for bind-mounted ones. */
  syncRepo(repo: RepoConfig): Promise<void>;
  /** Where the repo's files live on this filesystem. */
  repoPath(repo: RepoConfig): string;
  resolveProject(repo: RepoConfig, localPath: string): ResolvedRepoProject;
  /** Cheap source-state fingerprint (remote HEAD sha or local file-stat hash). */
  fingerprint(repo: RepoConfig): Promise<Fingerprint>;
  /** Also run the docs pass for every repo. */
  indexDocs: boolean;
  /** `PAPARATS_GROUP`, used to work out where a never-indexed repo would live. */
  sharedGroup?: string;
  /** Wraps every per-repo task, e.g. in a telemetry context. */
  runInContext?: <T>(task: () => Promise<T>) => Promise<T>;
  /** Cap on one fingerprint probe, so a frozen remote cannot stall a cycle. */
  fingerprintTimeoutMs?: number;
}

/** Per-repo fingerprint probe; consumed by the indexing step. */
export type FingerprintProbe =
  | { repo: RepoConfig; outcome: 'fingerprint'; current: Fingerprint }
  | { repo: RepoConfig; outcome: 'failed'; error: Error };

/** Where a project's data lives: what has to be purged when it moves or goes. */
interface ProjectIdentity {
  group: string;
  name: string;
}

interface IndexOutcome {
  /** `skipped`: the repo left the config while the task waited. */
  result: 'complete' | 'partial' | 'failed' | 'skipped';
  chunks: number;
}

const DEFAULT_FINGERPRINT_TIMEOUT_MS = 30_000;

/**
 * Owns the indexer's scheduling state: the live repo list, per-repo status,
 * the full and fast cycles, queued `/trigger` requests and projects.yml
 * hot-reloads.
 *
 * Every path that touches a repo goes through one per-project lock, so a
 * cycle, a trigger and a hot-reload never index (or purge) the same repo at
 * once. A fingerprint is captured before the repo is synced and persisted only
 * after a run that indexed everything, so neither a partial failure nor a push
 * landing mid-run is recorded as indexed.
 */
export class IndexOrchestrator {
  /** Live repo list. Replaced in place on hot-reload. */
  readonly repos: RepoConfig[];
  private readonly statuses = new Map<string, RepoStatus>();
  private globalStatus: RunStatus = 'idle';
  private lastRunAt: string | undefined;
  private running: 'full' | 'fast' | null = null;
  private draining: Promise<void> | null = null;
  private fastCycle: Promise<void> | null = null;
  private readonly queue = new TriggerQueue();
  private readonly locks = new KeyedSerializer();
  /** Group/name each repo was last indexed under in this process. */
  private readonly indexedAs = new Map<string, ProjectIdentity>();
  private readonly runInContext: <T>(task: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly deps: OrchestratorDeps,
    initialRepos: RepoConfig[]
  ) {
    this.repos = [...initialRepos];
    for (const repo of this.repos) this.statusFor(repo);
    this.runInContext = deps.runInContext ?? ((task) => task());
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  /** Repos a `/trigger` filter would select. */
  resolveTargets(filter: string[]): RepoConfig[] {
    return resolveTriggerTargets(this.repos, filter);
  }

  /**
   * Ask for a full cycle (startup, `/trigger`). Runs now when nothing else is
   * running; otherwise it is queued, merged with other queued requests, and
   * run right after the current cycle.
   */
  requestCycle(request: CycleRequest): 'started' | 'queued' {
    this.queue.add(request);
    if (this.running) return 'queued';
    this.drain();
    return 'started';
  }

  /** Slow-cron tick: a no-op while a full cycle runs, queued behind a fast one. */
  scheduledFullCycle(): void {
    if (this.repos.length === 0) return;
    if (this.running === 'full') {
      console.warn('[indexer] Index cycle already running, skipping scheduled run');
      return;
    }
    if (this.requestCycle({}) === 'queued') {
      console.log('[indexer] Fast cycle running, full cycle queued');
    }
  }

  /** Resolves once no cycle is running or queued. */
  async whenIdle(): Promise<void> {
    while (this.draining || this.fastCycle) {
      await (this.draining ?? this.fastCycle);
    }
  }

  health(): HealthResponse {
    return {
      status: this.globalStatus,
      lastRunAt: this.lastRunAt,
      nextScheduledAt: undefined,
      repoCount: this.repos.length,
      repos: Array.from(this.statuses.values()),
    };
  }

  // ── Cycles ────────────────────────────────────────────────────────────────

  private drain(): void {
    if (this.draining) return;
    const loop = async (): Promise<void> => {
      // Stop when a fast cycle took over; it calls drain() when it ends.
      while (!this.running) {
        const next = this.queue.take();
        if (!next) return;
        await this.runFullCycle(next);
      }
    };
    this.draining = loop().finally(() => {
      this.draining = null;
      // A request may have been queued after the loop's last check.
      if (!this.running && this.queue.hasPending) this.drain();
    });
  }

  private async runFullCycle(cycle: PendingCycle): Promise<void> {
    this.running = 'full';
    this.globalStatus = 'running';
    const startTime = Date.now();
    // Snapshot: a hot-reload replaces `repos` in place mid-cycle.
    const targets = cycle.filter
      ? resolveTriggerTargets(this.repos, cycle.filter)
      : [...this.repos];
    const forced = targets.filter((r) => cycle.isForced(r)).length;
    console.log(
      `[indexer] Starting index cycle for ${targets.length} repo(s)${forced > 0 ? ` (${forced} forced)` : ''}...`
    );

    try {
      let totalChunks = 0;
      for (const repo of targets) {
        const outcome = await this.indexRepo(repo, { force: cycle.isForced(repo) });
        totalChunks += outcome.chunks;
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      this.lastRunAt = new Date().toISOString();
      this.globalStatus = 'success';
      console.log(`[indexer] Index cycle complete: ${totalChunks} total chunks in ${elapsed}s`);
    } catch (err) {
      this.globalStatus = 'error';
      console.error(`[indexer] Index cycle failed: ${(err as Error).message}`);
    } finally {
      this.running = null;
    }
  }

  /**
   * Fast cycle: fingerprint every repo (concurrently, so a slow remote can't
   * block the others) and index only those whose fingerprint differs from the
   * persisted one. Indexing stays sequential — it is heavy on the embedding
   * server and Qdrant. Probe failures fall through to a defensive reindex.
   */
  async runChangeCheckCycle(): Promise<void> {
    if (this.repos.length === 0) return;
    if (this.running) {
      console.log(
        `[indexer] ${this.running === 'full' ? 'Full' : 'Fast'} cycle running, skipping fast check`
      );
      return;
    }
    this.running = 'fast';
    let finished!: () => void;
    this.fastCycle = new Promise<void>((resolve) => (finished = resolve));
    const startTime = Date.now();
    let skipped = 0;
    let indexed = 0;
    let totalChunks = 0;

    try {
      const probes = await Promise.all([...this.repos].map((repo) => this.probe(repo)));
      for (const probe of probes) {
        const { repo } = probe;
        if (probe.outcome === 'fingerprint') {
          const stored = this.deps.stateStore.get(repo.fullName);
          if (stored && stored.fingerprint === probe.current.value) {
            skipped++;
            continue;
          }
          console.log(
            `[indexer] ${repo.fullName}: changed (${stored?.fingerprint.slice(0, 12) ?? 'new'} → ${probe.current.value.slice(0, 12)}), reindexing`
          );
        } else {
          console.warn(
            `[indexer] ${repo.fullName}: fingerprint failed (${probe.error.message}), reindexing defensively`
          );
        }
        const outcome = await this.indexRepo(repo, { probe });
        if (outcome.result === 'complete' || outcome.result === 'partial') {
          indexed++;
          totalChunks += outcome.chunks;
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (indexed > 0) {
        this.lastRunAt = new Date().toISOString();
        this.globalStatus = 'success';
      }
      console.log(
        `[indexer] Fast cycle complete: ${indexed} indexed, ${skipped} skipped, ${totalChunks} chunks in ${elapsed}s`
      );
    } catch (err) {
      console.error(`[indexer] Fast cycle failed: ${(err as Error).message}`);
    } finally {
      this.running = null;
      this.fastCycle = null;
      finished();
      // Run whatever was queued while this cycle held the slot.
      this.drain();
    }
  }

  // ── Hot-reload ────────────────────────────────────────────────────────────

  /**
   * Apply a projects.yml change: purge removed projects, reindex added and
   * modified ones. Resolves when every resulting task has finished; never
   * rejects.
   */
  async applyConfigChange(change: ConfigChange): Promise<void> {
    this.repos.length = 0;
    this.repos.push(...change.next);

    const tasks: Array<Promise<unknown>> = [];
    for (const repo of change.removed) {
      tasks.push(this.removeRepo(repo));
    }
    for (const repo of change.added) {
      this.statusFor(repo);
      tasks.push(this.indexRepo(repo, {}));
    }
    for (const { prior, next } of change.modified) {
      // Bookkeeping is keyed by fullName, which changes when `url` is repointed.
      if (prior.fullName !== next.fullName) this.statuses.delete(prior.fullName);
      this.statusFor(next);
      // Overrides like `exclude_extra` can change what gets indexed without
      // touching content, so the stored fingerprint no longer proves anything.
      this.deps.stateStore.delete(prior.fullName);
      tasks.push(
        this.withLock(next, async () => {
          // Record what the prior config was indexed as (if this process never
          // indexed it) so a group change retires the old location.
          if (!this.indexedAs.has(prior.name)) {
            this.indexedAs.set(prior.name, this.identityOf(prior));
          }
          return this.indexRepoLocked(next, {});
        })
      );
    }
    await Promise.all(
      tasks.map((t) =>
        t.catch((err: unknown) =>
          console.error(`[indexer] Hot-reload task failed: ${(err as Error).message}`)
        )
      )
    );
  }

  private removeRepo(repo: RepoConfig): Promise<void> {
    return this.withLock(repo, async () => {
      // Re-added while this waited: that entry's own indexing takes over.
      if (this.repos.some((r) => r.name === repo.name)) return;
      this.statuses.delete(repo.fullName);
      this.deps.stateStore.delete(repo.fullName);
      const { group, name } = this.identityOf(repo);
      try {
        await this.deps.indexer.purgeProject(group, name);
        this.indexedAs.delete(repo.name);
        console.log(`[indexer] ${repo.fullName}: removed from config, purged ${group}/${name}`);
      } catch (err) {
        console.error(
          `[indexer] ${repo.fullName}: removed from config but purging ${group}/${name} failed: ${(err as Error).message}. ` +
            'Delete it with the delete_project tool.'
        );
      }
    });
  }

  // ── Per-repo work ─────────────────────────────────────────────────────────

  private withLock<T>(repo: RepoConfig, task: () => Promise<T>): Promise<T> {
    return this.locks.run(repo.name, () => this.runInContext(task));
  }

  /** Index one repo under its lock. Never rejects. */
  private indexRepo(
    repo: RepoConfig,
    opts: { force?: boolean; probe?: FingerprintProbe }
  ): Promise<IndexOutcome> {
    return this.withLock(repo, () => this.indexRepoLocked(repo, opts));
  }

  private async indexRepoLocked(
    requested: RepoConfig,
    opts: { force?: boolean; probe?: FingerprintProbe }
  ): Promise<IndexOutcome> {
    // The config may have changed while this task waited for the lock: index
    // the live entry, or nothing if the repo is gone or was repointed.
    const repo = this.repos.find(
      (r) => r.name === requested.name && r.fullName === requested.fullName
    );
    if (!repo) {
      console.log(`[indexer] ${requested.fullName}: no longer configured, skipping`);
      return { result: 'skipped', chunks: 0 };
    }

    const status = this.statusFor(repo);
    status.status = 'running';
    try {
      // Fingerprint BEFORE syncing: if a push lands while we index, the stored
      // value stays behind the remote and the next fast tick picks it up.
      const before = opts.probe ?? (await this.probe(repo));

      await this.deps.syncRepo(repo);
      const { project, source } = this.deps.resolveProject(repo, this.deps.repoPath(repo));
      logSource(repo, project, source);

      if (opts.force) {
        console.log(
          `[indexer] ${repo.fullName}: force=true → dropping existing chunks for ${project.group}/${project.name}`
        );
        await this.deps.indexer.deleteProjectChunks(project.group, project.name);
      }

      const report = await this.deps.indexer.indexProjectWithReport(project);
      const problems: string[] = [];
      if (report.errors > 0) problems.push(`${report.errors} file(s) failed to index`);

      if (this.deps.indexDocs) {
        try {
          const docChunks = await this.deps.indexer.indexDocsProject(project);
          console.log(`[indexer] ${repo.fullName}: indexed ${docChunks} docs chunks`);
        } catch (err) {
          problems.push(`docs indexing failed: ${(err as Error).message}`);
        }
      }

      await this.retirePreviousLocation(repo, project);

      status.lastRun = new Date().toISOString();
      status.chunksIndexed = report.chunks;
      if (problems.length > 0) {
        status.status = 'error';
        status.lastError = problems.join('; ');
        console.warn(
          `[indexer] ${repo.fullName}: indexed ${report.chunks} chunks with problems (${status.lastError}); will retry next cycle`
        );
        return { result: 'partial', chunks: report.chunks };
      }

      status.status = 'success';
      status.lastError = undefined;
      console.log(`[indexer] ${repo.fullName}: indexed ${report.chunks} chunks`);
      if (before.outcome === 'fingerprint') {
        this.deps.stateStore.set(
          repo.fullName,
          before.current.value,
          before.current.kind,
          report.chunks
        );
      }
      return { result: 'complete', chunks: report.chunks };
    } catch (err) {
      status.status = 'error';
      status.lastRun = new Date().toISOString();
      status.lastError = (err as Error).message;
      console.error(`[indexer] ${repo.fullName}: failed - ${(err as Error).message}`);
      return { result: 'failed', chunks: 0 };
    }
  }

  /**
   * After a repo is indexed under a new group or name, remove what it left at
   * the old one (code chunks, metadata, docs). A failed purge is logged and
   * retried after the next index of this repo.
   */
  private async retirePreviousLocation(repo: RepoConfig, project: ProjectConfig): Promise<void> {
    const prev = this.indexedAs.get(repo.name);
    const current = { group: project.group, name: project.name };
    if (prev && (prev.group !== current.group || prev.name !== current.name)) {
      try {
        await this.deps.indexer.purgeProject(prev.group, prev.name);
        console.log(
          `[indexer] ${repo.fullName}: moved to ${current.group}/${current.name}, purged ${prev.group}/${prev.name}`
        );
      } catch (err) {
        console.error(
          `[indexer] ${repo.fullName}: purging old location ${prev.group}/${prev.name} failed: ${(err as Error).message}`
        );
        return;
      }
    }
    this.indexedAs.set(repo.name, current);
  }

  /** Where a repo's data lives: as last indexed, else as its config resolves now. */
  private identityOf(repo: RepoConfig): ProjectIdentity {
    const known = this.indexedAs.get(repo.name);
    if (known) return known;
    const localPath = this.deps.repoPath(repo);
    if (fs.existsSync(localPath)) {
      try {
        const { project } = this.deps.resolveProject(repo, localPath);
        return { group: project.group, name: project.name };
      } catch {
        // fall through to the config-only answer
      }
    }
    return {
      group: this.deps.sharedGroup ?? repo.overrides?.group ?? DEFAULT_GROUP,
      name: repo.name,
    };
  }

  private async probe(repo: RepoConfig): Promise<FingerprintProbe> {
    const timeoutMs = this.deps.fingerprintTimeoutMs ?? DEFAULT_FINGERPRINT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`fingerprint timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      const current = await Promise.race([this.deps.fingerprint(repo), timeout]);
      return { repo, outcome: 'fingerprint', current };
    } catch (err) {
      return { repo, outcome: 'failed', error: err as Error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private statusFor(repo: RepoConfig): RepoStatus {
    let status = this.statuses.get(repo.fullName);
    if (!status) {
      status = { repo: repo.fullName, status: 'idle' };
      this.statuses.set(repo.fullName, status);
    }
    return status;
  }
}

function logSource(
  repo: RepoConfig,
  project: ProjectConfig,
  source: ResolvedRepoProject['source']
): void {
  if (source === 'repo-config+overrides') {
    console.log(`[indexer] ${repo.fullName}: .paparats.yml + indexer overrides applied`);
  } else if (source === 'overrides') {
    console.log(
      `[indexer] ${repo.fullName}: using indexer config overrides (${project.languages.join(', ')})`
    );
  } else if (source === 'auto') {
    console.log(
      `[indexer] No .paparats.yml in ${repo.fullName}, auto-detected: ${project.languages.join(', ')} (${project.exclude.length} exclude patterns)`
    );
  }
}
