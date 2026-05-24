import { describe, it, expect, vi } from 'vitest';
import { buildArchContext, buildArchContextWithVector } from '../../src/arch/context.js';
import type { ArchStore, ArchSearchHit, ArchStats } from '../../src/arch/store.js';
import type { ArchComponent, ArchDecision, ArchLesson } from '../../src/arch/types.js';

function comp(name: string, score = 0.9): ArchSearchHit {
  return {
    id: 'c-' + name,
    kind: 'component',
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
    id: 'd',
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
    id: 'l',
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

describe('buildArchContext', () => {
  it('returns an empty result with init hint when group is empty', async () => {
    const store = {
      search: vi.fn().mockResolvedValue([]),
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    const res = await buildArchContext(store, 'my-app', 'where is X');
    expect(res.empty).toBe(true);
    expect(res.hint).toMatch(/initialise/i);
    expect(res.components).toEqual([]);
  });

  it('returns low-confidence hint when group has cards but nothing matched the question', async () => {
    const store = {
      search: vi.fn().mockResolvedValue([]),
      stats: vi.fn().mockResolvedValue(someStats),
    } as unknown as ArchStore;
    const res = await buildArchContext(store, 'my-app', 'completely off-topic');
    expect(res.empty).toBe(true);
    expect(res.hint).toMatch(/high-confidence/i);
  });

  it('separates components, decisions and lessons', async () => {
    const store = {
      search: vi.fn().mockResolvedValue([comp('A'), dec('B'), les('C'), comp('D')]),
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    const res = await buildArchContext(store, 'my-app', 'q');
    expect(res.empty).toBe(false);
    expect(res.hint).toBeNull();
    expect(res.components.map((c) => c.name)).toEqual(['A', 'D']);
    expect(res.decisions.map((d) => d.title)).toEqual(['B']);
    expect(res.lessons.map((l) => l.rule)).toEqual(['C']);
  });

  it('caps each bucket at 5 by default', async () => {
    const many = Array.from({ length: 12 }, (_, i) => comp(String(i)));
    const store = {
      search: vi.fn().mockResolvedValue(many),
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    const res = await buildArchContext(store, 'my-app', 'q');
    expect(res.components).toHaveLength(5);
  });

  it('forwards min_score to the underlying search', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const store = {
      search,
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    await buildArchContext(store, 'my-app', 'q', { minScore: 0.6 });
    expect(search).toHaveBeenCalledWith('my-app', 'q', { limit: 20, minScore: 0.6 });
  });
});

describe('buildArchContextWithVector', () => {
  it('delegates to searchWithVector and skips re-embedding', async () => {
    const searchWithVector = vi.fn().mockResolvedValue([comp('A')]);
    const store = {
      searchWithVector,
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    const vector = [0.1, 0.2, 0.3];
    const res = await buildArchContextWithVector(store, 'my-app', vector);
    expect(searchWithVector).toHaveBeenCalledWith('my-app', vector, {
      limit: 20,
      minScore: 0.45,
    });
    expect(res.components.map((c) => c.name)).toEqual(['A']);
  });

  it('respects custom minScore override', async () => {
    const searchWithVector = vi.fn().mockResolvedValue([]);
    const store = {
      searchWithVector,
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    await buildArchContextWithVector(store, 'my-app', [0, 0], { minScore: 0.8 });
    expect(searchWithVector).toHaveBeenCalledWith('my-app', [0, 0], {
      limit: 20,
      minScore: 0.8,
    });
  });

  it('forwards project to the underlying search', async () => {
    const searchWithVector = vi.fn().mockResolvedValue([]);
    const store = {
      searchWithVector,
      stats: vi.fn().mockResolvedValue(emptyStats),
    } as unknown as ArchStore;
    await buildArchContextWithVector(store, 'default', [0, 0], { project: 'app-a' });
    expect(searchWithVector).toHaveBeenCalledWith('default', [0, 0], {
      limit: 20,
      minScore: 0.45,
      project: 'app-a',
    });
  });
});
