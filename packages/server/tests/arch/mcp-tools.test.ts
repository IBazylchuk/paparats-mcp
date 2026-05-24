import { describe, it, expect, vi } from 'vitest';
import {
  SUPPORT_TOOLS,
  CODING_TOOLS,
  pickArchContextEmptyText,
  renderArchContextSection,
  STALE_THRESHOLD_MS,
  isStale,
} from '../../src/mcp-handler.js';
import type { ArchContextResult } from '../../src/arch/types.js';
import { LOW_CONFIDENCE_HINT } from '../../src/arch/context.js';
import { ArchStore } from '../../src/arch/store.js';
import type { CachedEmbeddingProvider } from '../../src/embeddings.js';
import type { QdrantClient } from '@qdrant/js-client-rest';

function fakeProvider(): CachedEmbeddingProvider {
  return {
    dimensions: 512,
    model: 'jina-embeddings-v5-text-small',
    embed: vi.fn(async () => Array(512).fill(0.1)),
    embedBatch: vi.fn(),
    embedQuery: vi.fn(),
    embedPassage: vi.fn(),
    embedBatchPassage: vi.fn(),
    getCacheStats: vi.fn(),
    attachTelemetry: vi.fn(),
    attachMetrics: vi.fn(),
    close: vi.fn(),
    cacheHits: 0,
    prefixesEnabled: false,
  } as unknown as CachedEmbeddingProvider;
}

function fakeQdrant() {
  return {
    getCollection: vi.fn().mockResolvedValue({}),
    createCollection: vi.fn(),
    createPayloadIndex: vi.fn(),
    upsert: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
    search: vi.fn().mockResolvedValue([]),
    setPayload: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn(),
  };
}

describe('pickArchContextEmptyText', () => {
  it('returns LOW_CONFIDENCE_HINT verbatim in both modes when memory exists but matched nothing', () => {
    expect(pickArchContextEmptyText(LOW_CONFIDENCE_HINT, 'coding')).toBe(LOW_CONFIDENCE_HINT);
    expect(pickArchContextEmptyText(LOW_CONFIDENCE_HINT, 'support')).toBe(LOW_CONFIDENCE_HINT);
  });

  it('returns a support-safe message when the group has no memory at all', () => {
    const supportText = pickArchContextEmptyText(null, 'support');
    // Must not mention any writer tool — support mode can't reach them.
    expect(supportText).not.toMatch(/arch_record_/);
    expect(supportText).toMatch(/coding mode/);
  });

  it('returns the INIT_HINT (or default coding fallback) in coding mode', () => {
    const codingDefault = pickArchContextEmptyText(null, 'coding');
    expect(codingDefault).toMatch(/arch_record_component/);

    const fromHint = 'Custom init hint with arch_record_component reference.';
    expect(pickArchContextEmptyText(fromHint, 'coding')).toBe(fromHint);
  });
});

describe('renderArchContextSection', () => {
  // Every card line must surface the card's id verbatim — without it, a caller
  // who wants to call arch_delete has no way to obtain the id from the
  // formatted tool output.
  it('prints the id of every component, decision, and lesson in the rendered output', () => {
    const ctx: ArchContextResult = {
      components: [
        {
          kind: 'component',
          id: 'comp-uuid',
          project: 'my-app',
          name: 'file indexer',
          summary: 'Indexes files.',
          files: ['packages/server/src/indexer.ts'],
          neighbours: [],
          anchors: [],
          createdAt: 0,
          updatedAt: 0,
          score: 0.62,
        },
      ],
      decisions: [
        {
          kind: 'decision',
          id: 'dec-uuid',
          title: 'Use jina-code-embeddings',
          context: 'c',
          decision: 'use jina',
          alternativesRejected: '',
          consequences: '',
          status: 'accepted',
          supersedes: null,
          scope: 'global',
          createdAt: 0,
          updatedAt: 0,
          score: 0.7,
        },
      ],
      lessons: [
        {
          kind: 'lesson',
          id: 'les-uuid',
          rule: 'Always preserve createdAt on re-upsert.',
          why: 'because',
          when: 'when re-upserting',
          scope: 'global',
          evidence: null,
          severity: 'info',
          status: 'accepted',
          createdAt: 0,
          updatedAt: 0,
          score: 0.55,
        },
      ],
      empty: false,
      hint: null,
    };
    const rendered = renderArchContextSection('my-app', ctx).join('\n');
    expect(rendered).toContain('id `comp-uuid`');
    expect(rendered).toContain('id `dec-uuid`');
    expect(rendered).toContain('id `les-uuid`');
  });

  it('returns an empty array for an empty result so the caller can render an init/low-confidence hint instead', () => {
    const ctx: ArchContextResult = {
      components: [],
      decisions: [],
      lessons: [],
      empty: true,
      hint: 'whatever',
    };
    expect(renderArchContextSection('my-app', ctx)).toEqual([]);
  });

  // Why/when carry the incident context — without them an agent sees only the
  // rule and loses the signal that tells it when the rule actually applies.
  it('includes lesson why and when as indented continuation bullets', () => {
    const ctx: ArchContextResult = {
      components: [],
      decisions: [],
      lessons: [
        {
          kind: 'lesson',
          id: 'les-uuid',
          rule: 'Always preserve createdAt on re-upsert.',
          why: 'cohort report keyed on createdAt and silently broke',
          when: 're-upserting an existing arch card',
          scope: 'global',
          evidence: null,
          severity: 'warning',
          status: 'accepted',
          createdAt: 0,
          updatedAt: Date.now(),
          score: 0.7,
        },
      ],
      empty: false,
      hint: null,
    };
    const rendered = renderArchContextSection('my-app', ctx).join('\n');
    expect(rendered).toContain('**why:** cohort report keyed on createdAt and silently broke');
    expect(rendered).toContain('**when:** re-upserting an existing arch card');
  });

  // Stale marker — agents/humans need a visible signal to not act on >90d
  // cards without verifying.
  it('prefixes stale cards (>90d) with ⚠ stale across all three kinds', () => {
    const staleTs = Date.now() - STALE_THRESHOLD_MS - 1000;
    const ctx: ArchContextResult = {
      components: [
        {
          kind: 'component',
          id: 'comp-stale',
          project: 'my-app',
          name: 'old indexer',
          summary: 'legacy',
          files: [],
          neighbours: [],
          anchors: [],
          createdAt: 0,
          updatedAt: staleTs,
          score: 0.5,
        },
      ],
      decisions: [
        {
          kind: 'decision',
          id: 'dec-stale',
          title: 'old decision',
          context: 'c',
          decision: 'd',
          alternativesRejected: '',
          consequences: '',
          status: 'accepted',
          supersedes: null,
          scope: 'global',
          createdAt: 0,
          updatedAt: staleTs,
          score: 0.5,
        },
      ],
      lessons: [
        {
          kind: 'lesson',
          id: 'les-stale',
          rule: 'old rule',
          why: '',
          when: '',
          scope: 'global',
          evidence: null,
          severity: 'info',
          status: 'accepted',
          createdAt: 0,
          updatedAt: staleTs,
          score: 0.5,
        },
      ],
      empty: false,
      hint: null,
    };
    const rendered = renderArchContextSection('my-app', ctx).join('\n');
    expect(rendered).toContain('⚠ stale **old indexer**');
    expect(rendered).toContain('⚠ stale **old decision**');
    expect(rendered).toContain('⚠ stale (id `les-stale`');
  });

  it('does not prefix fresh (<90d) cards with the stale marker', () => {
    const ctx: ArchContextResult = {
      components: [
        {
          kind: 'component',
          id: 'comp-fresh',
          project: 'my-app',
          name: 'fresh indexer',
          summary: 's',
          files: [],
          neighbours: [],
          anchors: [],
          createdAt: 0,
          updatedAt: Date.now(),
          score: 0.5,
        },
      ],
      decisions: [],
      lessons: [],
      empty: false,
      hint: null,
    };
    const rendered = renderArchContextSection('my-app', ctx).join('\n');
    expect(rendered).not.toContain('⚠ stale');
  });
});

describe('isStale', () => {
  it('returns true for timestamps older than the 90-day threshold', () => {
    expect(isStale(Date.now() - STALE_THRESHOLD_MS - 1000)).toBe(true);
  });
  it('returns false for fresh timestamps', () => {
    expect(isStale(Date.now())).toBe(false);
  });
  it('returns false for missing/non-finite timestamps (unknown ≠ stale)', () => {
    expect(isStale(undefined)).toBe(false);
    expect(isStale(NaN)).toBe(false);
    expect(isStale(Infinity)).toBe(false);
  });
});

describe('arch_delete description warning', () => {
  // Defensive UX: deletes silently miss when the LLM uses ids from earlier in
  // the conversation (a re-upsert allocates a fresh UUID). Description must
  // tell the LLM to re-fetch ids first.
  it('warns about stale ids by directing the caller to re-fetch from arch_context', async () => {
    const { prompts } = await import('../../src/prompts/index.js');
    const desc = prompts.tools.arch_delete.description;
    expect(desc).toMatch(/re-fetch/i);
    expect(desc).toContain('arch_context');
  });
});

describe('memory-layer dichotomy in instructions', () => {
  // Agents kept writing workflow / collaboration rules to arch_record_lesson
  // when those belong in agent-side memory (auto-memory / CLAUDE.md). The
  // distinction has to be spelled out in both the per-tool description and
  // the top-level coding instructions, otherwise the agent only sees it on
  // the surface that happens to be in context at the moment.
  it('arch_record_lesson description distinguishes arch from agent-side memory', async () => {
    const { prompts } = await import('../../src/prompts/index.js');
    const desc = prompts.tools.arch_record_lesson.description;
    expect(desc).toMatch(/arch/i);
    expect(desc).toMatch(/auto-memory|CLAUDE\.md|AGENTS\.md/);
    expect(desc).toMatch(/code|codebase/i);
  });

  it('codingInstructions has a Memory layers block pointing at agent-side memory for workflow rules', async () => {
    const { prompts } = await import('../../src/prompts/index.js');
    expect(prompts.codingInstructions).toMatch(/Memory layers/);
    expect(prompts.codingInstructions).toMatch(/agent-side memory|auto-memory/);
  });

  it('record_lesson_from_correction workflow flags workflow rules as belonging elsewhere', async () => {
    const { prompts } = await import('../../src/prompts/index.js');
    const message = prompts.workflows['record_lesson_from_correction']?.message ?? '';
    expect(message).toMatch(/workflow|collaboration/i);
    expect(message).toMatch(/agent-side memory|auto-memory|CLAUDE\.md/);
  });
});

describe('arch tool exposure per mode', () => {
  it('coding mode exposes the full arch toolkit (read + write + delete)', () => {
    expect(CODING_TOOLS.has('arch_context')).toBe(true);
    expect(CODING_TOOLS.has('arch_record_component')).toBe(true);
    expect(CODING_TOOLS.has('arch_record_decision')).toBe(true);
    expect(CODING_TOOLS.has('arch_record_lesson')).toBe(true);
    expect(CODING_TOOLS.has('arch_delete')).toBe(true);
  });

  it('support mode is read-only — only arch_context, no arch_record_*, no arch_delete', () => {
    expect(SUPPORT_TOOLS.has('arch_context')).toBe(true);
    expect(SUPPORT_TOOLS.has('arch_record_component')).toBe(false);
    expect(SUPPORT_TOOLS.has('arch_record_decision')).toBe(false);
    expect(SUPPORT_TOOLS.has('arch_record_lesson')).toBe(false);
    expect(SUPPORT_TOOLS.has('arch_delete')).toBe(false);
  });
});

describe('ArchStore wiring sanity', () => {
  it('an ArchStore built with mocks round-trips upsert + upsert call', async () => {
    const qdrant = fakeQdrant();
    const store = new ArchStore({
      qdrant: qdrant as unknown as QdrantClient,
      provider: fakeProvider(),
    });
    const result = await store.upsertComponent('my-app', {
      name: 'X',
      summary: 's',
      files: [],
      neighbours: [],
      anchors: [],
    });
    expect(typeof result.id).toBe('string');
    expect(result.status).toBe('created');
    expect(qdrant.upsert).toHaveBeenCalled();
  });
});
