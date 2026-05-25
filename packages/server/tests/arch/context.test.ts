import { describe, it, expect, vi } from 'vitest';
import { buildArchContext, buildArchContextWithVector } from '../../src/arch/context.js';
import type { ArchStore, ArchSearchHit, ArchStats } from '../../src/arch/store.js';
import type { ArchComponent, ArchDecision, ArchLesson, ArchKind } from '../../src/arch/types.js';

function comp(name: string, score = 0.9): ArchSearchHit {
  return {
    id: 'c-' + name,
    kind: 'component',
    project: 'my-app',
    name,
    summary: 'sum-' + name,
    files: ['f.ts'],
    neighbours: [],
    anchors: [],
    createdAt: 0,
    updatedAt: 0,
    score,
  } as ArchSearchHit & ArchComponent;
}
function dec(title: string, score = 0.9): ArchSearchHit {
  return {
    id: 'd-' + title,
    kind: 'decision',
    title,
    context: 'c',
    decision: 'd',
    alternativesRejected: '',
    consequences: 'q',
    status: 'accepted',
    supersedes: null,
    scope: 'global',
    createdAt: 0,
    updatedAt: 0,
    score,
  } as ArchSearchHit & ArchDecision;
}
function les(rule: string, score = 0.9): ArchSearchHit {
  return {
    id: 'l-' + rule,
    kind: 'lesson',
    rule,
    why: 'reason',
    when: 'situation',
    scope: 'global',
    evidence: null,
    severity: 'info',
    status: 'accepted',
    createdAt: 0,
    updatedAt: 0,
    score,
  } as ArchSearchHit & ArchLesson;
}

const emptyStats: ArchStats = {
  group: 'my-app',
  total: 0,
  byKind: { component: 0, decision: 0, lesson: 0 },
  byStatus: { proposed: 0, accepted: 0, superseded: 0, deprecated: 0 },
  oldestUpdatedAt: null,
  newestUpdatedAt: null,
};

const someStats: ArchStats = {
  ...emptyStats,
  total: 3,
  byKind: { component: 3, decision: 0, lesson: 0 },
};

/**
 * Build a mocked ArchStore whose searchWithVector returns different hits per
 * requested kind. The kind-routing matches the new per-kind search strategy:
 * arch_context fans out three calls (one per kind), and each call passes
 * `kinds: [kind]` so we can dispatch off it.
 */
function storeWithPerKind(perKind: {
  component?: ArchSearchHit[];
  decision?: ArchSearchHit[];
  lesson?: ArchSearchHit[];
  stats?: ArchStats;
}): {
  store: ArchStore;
  searchWithVector: ReturnType<typeof vi.fn>;
  embedQuestion: ReturnType<typeof vi.fn>;
} {
  const searchWithVector = vi.fn(
    async (_group: string, _vec: number[], opts: { kinds?: ArchKind[] } = {}) => {
      const k = opts.kinds?.[0];
      if (k === 'component') return perKind.component ?? [];
      if (k === 'decision') return perKind.decision ?? [];
      if (k === 'lesson') return perKind.lesson ?? [];
      return [];
    }
  );
  const embedQuestion = vi.fn(async () => [0.1, 0.2, 0.3]);
  const store = {
    searchWithVector,
    embedQuestion,
    stats: vi.fn().mockResolvedValue(perKind.stats ?? emptyStats),
  } as unknown as ArchStore;
  return { store, searchWithVector, embedQuestion };
}

describe('buildArchContext', () => {
  it('returns an empty result with init hint when group is empty', async () => {
    const { store } = storeWithPerKind({});
    const res = await buildArchContext(store, 'my-app', 'where is X');
    expect(res.empty).toBe(true);
    expect(res.hint).toMatch(/initialise/i);
    expect(res.components).toEqual([]);
  });

  it('returns low-confidence hint when group has cards but nothing matched the question', async () => {
    const { store } = storeWithPerKind({ stats: someStats });
    const res = await buildArchContext(store, 'my-app', 'completely off-topic');
    expect(res.empty).toBe(true);
    expect(res.hint).toMatch(/high-confidence/i);
  });

  it('separates components, decisions and lessons', async () => {
    const { store } = storeWithPerKind({
      component: [comp('A'), comp('D')],
      decision: [dec('B')],
      lesson: [les('C')],
    });
    const res = await buildArchContext(store, 'my-app', 'q');
    expect(res.empty).toBe(false);
    expect(res.hint).toBeNull();
    expect(res.components.map((c) => c.name)).toEqual(['A', 'D']);
    expect(res.decisions.map((d) => d.title)).toEqual(['B']);
    expect(res.lessons.map((l) => l.rule)).toEqual(['C']);
  });

  it('embeds the question once and fans the vector across all three kind queries', async () => {
    const { store, searchWithVector, embedQuestion } = storeWithPerKind({
      component: [comp('A')],
    });
    await buildArchContext(store, 'my-app', 'q');
    expect(embedQuestion).toHaveBeenCalledTimes(1);
    expect(searchWithVector).toHaveBeenCalledTimes(3);
    const kinds = searchWithVector.mock.calls.map((call) => call[2].kinds[0]);
    expect(kinds.sort()).toEqual(['component', 'decision', 'lesson']);
  });

  // Support mode has no file watcher and no cross-mode invalidation signal,
  // so any cache layer between buildArchContext and the store would serve
  // stale cards after a coding-mode write. Lock that in: every call must
  // hit the store fresh, even with identical args back-to-back.
  it('does not cache: identical back-to-back calls hit the store again', async () => {
    const { store, searchWithVector } = storeWithPerKind({ component: [comp('A')] });
    await buildArchContextWithVector(store, 'my-app', [0, 0]);
    await buildArchContextWithVector(store, 'my-app', [0, 0]);
    // 3 kinds × 2 calls = 6 searches. If a cache lands here, this drops to 3.
    expect(searchWithVector).toHaveBeenCalledTimes(6);
  });
});

describe('buildArchContextWithVector — per-kind limits', () => {
  it('passes a default limit of 5 to each kind-scoped search call', async () => {
    const { store, searchWithVector } = storeWithPerKind({});
    await buildArchContextWithVector(store, 'my-app', [0, 0]);
    for (const call of searchWithVector.mock.calls) {
      expect(call[2].limit).toBe(5);
    }
  });

  // Bug fix: a verbose decision bucket can no longer starve components out of
  // the result. With one global top-N, 20 decisions in the top-20 left nothing
  // for components. With per-kind searches, components get their own budget.
  it('decisions cannot starve components out of the result', async () => {
    const { store, searchWithVector } = storeWithPerKind({
      component: [comp('only-comp')],
      decision: Array.from({ length: 20 }, (_, i) => dec(`d${i}`)),
      lesson: [],
    });
    const res = await buildArchContextWithVector(store, 'my-app', [0, 0]);
    expect(res.components.map((c) => c.name)).toEqual(['only-comp']);
    // Decisions are still capped at 5 even when many were returned upstream —
    // the bucket cap is the store-level limit, enforced by the per-kind search.
    expect(searchWithVector.mock.calls.find((c) => c[2].kinds[0] === 'decision')?.[2].limit).toBe(
      5
    );
  });

  it('respects per-kind limit overrides and skips searches with limit 0', async () => {
    const { store, searchWithVector } = storeWithPerKind({});
    await buildArchContextWithVector(store, 'my-app', [0, 0], {
      limits: { component: 10, decision: 3, lesson: 0 },
    });
    const byKind = Object.fromEntries(
      searchWithVector.mock.calls.map((call) => [call[2].kinds[0], call[2].limit])
    );
    expect(byKind['component']).toBe(10);
    expect(byKind['decision']).toBe(3);
    // lesson search must not be issued at all when its limit is 0.
    expect(byKind['lesson']).toBeUndefined();
  });

  it('forwards project and minScore to every kind-scoped search', async () => {
    const { store, searchWithVector } = storeWithPerKind({});
    await buildArchContextWithVector(store, 'my-app', [0, 0], {
      project: 'app-a',
      minScore: 0.7,
    });
    for (const call of searchWithVector.mock.calls) {
      expect(call[2].project).toBe('app-a');
      expect(call[2].minScore).toBe(0.7);
    }
  });
});
