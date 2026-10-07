import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IndexProjectReport, ProjectConfig } from '@paparats/server';
import { IndexOrchestrator, type OrchestratorDeps } from '../src/orchestrator.js';
import type { StoredFingerprint } from '../src/state-store.js';
import type { RepoConfig } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

function remote(name: string, group?: string): RepoConfig {
  return {
    url: `https://github.com/org/${name}.git`,
    owner: 'org',
    name,
    fullName: `org/${name}`,
    ...(group ? { overrides: { group } } : {}),
  };
}

/** In-memory stand-ins for everything the orchestrator drives. */
function makeHarness() {
  const calls: string[] = [];
  const store = new Map<string, StoredFingerprint>();
  const fingerprints = new Map<string, string>();
  const reports = new Map<string, IndexProjectReport>();
  const gates = new Map<string, Promise<void>>();
  const active = new Map<string, number>();
  let maxConcurrentPerRepo = 0;
  let docsError: Error | null = null;
  let purgeError: Error | null = null;
  let onSync: ((repo: RepoConfig) => void) | null = null;

  const deps: OrchestratorDeps = {
    indexer: {
      indexProjectWithReport: vi.fn(async (project: ProjectConfig) => {
        const n = (active.get(project.name) ?? 0) + 1;
        active.set(project.name, n);
        maxConcurrentPerRepo = Math.max(maxConcurrentPerRepo, n);
        calls.push(`index ${project.group}/${project.name}`);
        await (gates.get(project.name) ?? Promise.resolve());
        active.set(project.name, n - 1);
        return reports.get(project.name) ?? { chunks: 3, errors: 0 };
      }),
      indexDocsProject: vi.fn(async (project: ProjectConfig) => {
        calls.push(`docs ${project.group}/${project.name}`);
        if (docsError) throw docsError;
        return 1;
      }),
      deleteProjectChunks: vi.fn(async (group: string, name: string) => {
        calls.push(`drop ${group}/${name}`);
      }),
      purgeProject: vi.fn(async (group: string, name: string) => {
        calls.push(`purge ${group}/${name}`);
        if (purgeError) throw purgeError;
      }),
    },
    stateStore: {
      get: (fullName) => store.get(fullName),
      set: (fullName, fingerprint, kind, chunks) =>
        store.set(fullName, {
          fingerprint,
          kind,
          lastIndexedAt: new Date().toISOString(),
          lastChunks: chunks ?? null,
        }),
      delete: (fullName) => store.delete(fullName),
    },
    syncRepo: async (repo) => {
      calls.push(`sync ${repo.fullName}`);
      onSync?.(repo);
    },
    repoPath: (repo) => `/nonexistent/${repo.name}`,
    resolveProject: (repo) => ({
      project: {
        name: repo.name,
        group: repo.overrides?.group ?? 'default',
        languages: ['typescript'],
        exclude: [],
      } as unknown as ProjectConfig,
      source: 'auto',
    }),
    fingerprint: async (repo) => ({ kind: 'git', value: fingerprints.get(repo.name) ?? 'sha-1' }),
    indexDocs: false,
  };

  return {
    deps,
    calls,
    store,
    fingerprints,
    reports,
    gates,
    get maxConcurrentPerRepo() {
      return maxConcurrentPerRepo;
    },
    failDocs: (err: Error | null) => (docsError = err),
    failPurge: (err: Error | null) => (purgeError = err),
    setOnSync: (fn: ((repo: RepoConfig) => void) | null) => (onSync = fn),
  };
}

describe('IndexOrchestrator', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fingerprints', () => {
    it('persists the fingerprint taken before syncing, not after', async () => {
      const h = makeHarness();
      h.fingerprints.set('api', 'before');
      // A push lands while the repo is being synced/indexed.
      h.setOnSync(() => h.fingerprints.set('api', 'after'));
      const o = new IndexOrchestrator(h.deps, [remote('api')]);

      o.requestCycle({});
      await o.whenIdle();

      expect(h.store.get('org/api')?.fingerprint).toBe('before');
    });

    it('does not persist when some files failed to index', async () => {
      const h = makeHarness();
      h.reports.set('api', { chunks: 5, errors: 2 });
      const o = new IndexOrchestrator(h.deps, [remote('api')]);

      o.requestCycle({});
      await o.whenIdle();

      expect(h.store.has('org/api')).toBe(false);
      const status = o.health().repos[0]!;
      expect(status.status).toBe('error');
      expect(status.lastError).toMatch(/2 file\(s\) failed/);
      expect(status.chunksIndexed).toBe(5);
    });

    it('does not persist when the docs pass throws', async () => {
      const h = makeHarness();
      h.deps.indexDocs = true;
      h.failDocs(new Error('qdrant down'));
      const o = new IndexOrchestrator(h.deps, [remote('api')]);

      o.requestCycle({});
      await o.whenIdle();

      expect(h.calls).toContain('docs default/api');
      expect(h.store.has('org/api')).toBe(false);
      expect(o.health().repos[0]!.lastError).toMatch(/docs indexing failed: qdrant down/);
    });

    it('does not persist when the fingerprint probe failed', async () => {
      const h = makeHarness();
      h.deps.fingerprint = async () => {
        throw new Error('ls-remote failed');
      };
      const o = new IndexOrchestrator(h.deps, [remote('api')]);

      o.requestCycle({});
      await o.whenIdle();

      expect(h.calls).toContain('index default/api');
      expect(h.store.has('org/api')).toBe(false);
    });
  });

  describe('fast cycle', () => {
    it('skips unchanged repos and indexes changed ones', async () => {
      const h = makeHarness();
      const o = new IndexOrchestrator(h.deps, [remote('a'), remote('b')]);
      h.deps.stateStore.set('org/a', 'sha-1', 'git', 1);

      await o.runChangeCheckCycle();

      expect(h.calls.filter((c) => c.startsWith('index'))).toEqual(['index default/b']);
      expect(h.store.get('org/b')?.fingerprint).toBe('sha-1');
    });

    it('runs a full cycle requested during a fast cycle right after it', async () => {
      const h = makeHarness();
      const gate = deferred();
      h.gates.set('a', gate.promise);
      const o = new IndexOrchestrator(h.deps, [remote('a')]);

      const fast = o.runChangeCheckCycle();
      await flush();
      expect(o.requestCycle({ repos: ['a'], force: true })).toBe('queued');
      gate.resolve();
      await fast;
      await o.whenIdle();

      expect(h.calls.filter((c) => !c.startsWith('sync'))).toEqual([
        'index default/a',
        'drop default/a',
        'index default/a',
      ]);
    });
  });

  describe('triggers', () => {
    it('queues requests that arrive mid-cycle and merges them, keeping force per repo', async () => {
      const h = makeHarness();
      const gate = deferred();
      h.gates.set('a', gate.promise);
      const o = new IndexOrchestrator(h.deps, [remote('a'), remote('b'), remote('c')]);

      expect(o.requestCycle({ repos: ['a'] })).toBe('started');
      await flush();
      expect(o.requestCycle({ repos: ['b'], force: true })).toBe('queued');
      expect(o.requestCycle({ repos: ['org/c'] })).toBe('queued');
      gate.resolve();
      await o.whenIdle();

      expect(h.calls.filter((c) => !c.startsWith('sync'))).toEqual([
        'index default/a',
        'drop default/b',
        'index default/b',
        'index default/c',
      ]);
    });

    it('treats an empty repo list as every repo', async () => {
      const h = makeHarness();
      const o = new IndexOrchestrator(h.deps, [remote('a'), remote('b')]);

      o.requestCycle({ repos: [] });
      await o.whenIdle();

      expect(h.calls.filter((c) => c.startsWith('index'))).toEqual([
        'index default/a',
        'index default/b',
      ]);
    });

    it('skips a scheduled full cycle while one is running', async () => {
      const h = makeHarness();
      const gate = deferred();
      h.gates.set('a', gate.promise);
      const o = new IndexOrchestrator(h.deps, [remote('a')]);

      o.requestCycle({});
      await flush();
      o.scheduledFullCycle();
      gate.resolve();
      await o.whenIdle();

      expect(h.calls.filter((c) => c.startsWith('index'))).toHaveLength(1);
    });
  });

  describe('per-repo serialization', () => {
    it('never indexes the same repo concurrently from a cycle and a hot-reload', async () => {
      const h = makeHarness();
      const gate = deferred();
      h.gates.set('a', gate.promise);
      const prior = remote('a');
      const o = new IndexOrchestrator(h.deps, [prior]);

      o.requestCycle({});
      await flush();
      const next = { ...prior, overrides: { indexing: { exclude_extra: ['fixtures'] } } };
      const reload = o.applyConfigChange({
        added: [],
        removed: [],
        modified: [{ prior, next }],
        next: [next],
      });
      await flush();
      gate.resolve();
      await reload;
      await o.whenIdle();

      expect(h.calls.filter((c) => c.startsWith('index'))).toHaveLength(2);
      expect(h.maxConcurrentPerRepo).toBe(1);
    });
  });

  describe('hot-reload', () => {
    it('indexes repos added to an initially empty list', async () => {
      const h = makeHarness();
      const o = new IndexOrchestrator(h.deps, []);

      await o.applyConfigChange({
        added: [remote('a')],
        removed: [],
        modified: [],
        next: [remote('a')],
      });
      await o.runChangeCheckCycle();

      expect(h.calls.filter((c) => c.startsWith('index'))).toEqual(['index default/a']);
      expect(o.health().repos.map((r) => r.repo)).toEqual(['org/a']);
    });

    it('purges a removed repo under the group it was indexed in', async () => {
      const h = makeHarness();
      const a = remote('a', 'team');
      const o = new IndexOrchestrator(h.deps, [a, remote('b')]);
      o.requestCycle({});
      await o.whenIdle();

      await o.applyConfigChange({ added: [], removed: [a], modified: [], next: [remote('b')] });

      expect(h.calls).toContain('purge team/a');
      expect(h.store.has('org/a')).toBe(false);
      expect(o.health().repos.map((r) => r.repo)).toEqual(['org/b']);
    });

    it('purges a never-indexed removed repo using its configured group', async () => {
      const h = makeHarness();
      const a = remote('a', 'team');
      const o = new IndexOrchestrator(h.deps, [a]);

      await o.applyConfigChange({ added: [], removed: [a], modified: [], next: [] });

      expect(h.calls).toEqual(['purge team/a']);
    });

    it('purges the old location after a group change', async () => {
      const h = makeHarness();
      const prior = remote('a', 'old');
      const next = remote('a', 'new');
      const o = new IndexOrchestrator(h.deps, [prior]);

      await o.applyConfigChange({
        added: [],
        removed: [],
        modified: [{ prior, next }],
        next: [next],
      });

      expect(h.calls.filter((c) => !c.startsWith('sync'))).toEqual(['index new/a', 'purge old/a']);
    });

    it('logs instead of throwing when a purge fails', async () => {
      const h = makeHarness();
      h.failPurge(new Error('qdrant down'));
      const a = remote('a');
      const o = new IndexOrchestrator(h.deps, [a]);

      await expect(
        o.applyConfigChange({ added: [], removed: [a], modified: [], next: [] })
      ).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(/purging default\/a failed/)
      );
    });

    it('lets a cycle finish when a repo is removed while it runs', async () => {
      const h = makeHarness();
      const gate = deferred();
      h.gates.set('a', gate.promise);
      const [a, b, c] = [remote('a'), remote('b'), remote('c')];
      const o = new IndexOrchestrator(h.deps, [a, b, c]);

      o.requestCycle({});
      await flush();
      const reload = o.applyConfigChange({ added: [], removed: [b], modified: [], next: [a, c] });
      gate.resolve();
      await reload;
      await o.whenIdle();

      expect(h.calls.filter((x) => x.startsWith('index'))).toEqual([
        'index default/a',
        'index default/c',
      ]);
      expect(h.calls).toContain('purge default/b');
      expect(o.health().status).toBe('success');
    });
  });
});
