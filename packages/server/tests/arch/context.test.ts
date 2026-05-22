import { describe, it, expect, vi } from 'vitest';
import { buildArchContext, buildArchContextWithVector } from '../../src/arch/context.js';
import type { ArchStore } from '../../src/arch/store.js';
import type { ArchComponent, ArchDecision, ArchLesson } from '../../src/arch/types.js';

function comp(name: string): ArchComponent {
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
  };
}
function dec(title: string): ArchDecision {
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
  };
}
function les(rule: string): ArchLesson {
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
  };
}

describe('buildArchContext', () => {
  it('returns an empty result with init hint when nothing is indexed', async () => {
    const store = { search: vi.fn().mockResolvedValue([]) } as unknown as ArchStore;
    const res = await buildArchContext(store, 'my-app', 'where is X');
    expect(res.empty).toBe(true);
    expect(res.hint).toMatch(/initialise/i);
    expect(res.components).toEqual([]);
  });

  it('separates components, decisions and lessons', async () => {
    const store = {
      search: vi.fn().mockResolvedValue([comp('A'), dec('B'), les('C'), comp('D')]),
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
    const store = { search: vi.fn().mockResolvedValue(many) } as unknown as ArchStore;
    const res = await buildArchContext(store, 'my-app', 'q');
    expect(res.components).toHaveLength(5);
  });
});

describe('buildArchContextWithVector', () => {
  it('delegates to searchWithVector and skips re-embedding', async () => {
    const searchWithVector = vi.fn().mockResolvedValue([comp('A')]);
    const store = { searchWithVector } as unknown as ArchStore;
    const vector = [0.1, 0.2, 0.3];
    const res = await buildArchContextWithVector(store, 'my-app', vector);
    expect(searchWithVector).toHaveBeenCalledWith('my-app', vector, { limit: 20 });
    expect(res.components.map((c) => c.name)).toEqual(['A']);
  });
});
