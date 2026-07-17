import { describe, it, expect, vi } from 'vitest';
import { expandQueryWithGlossary, type GlossaryMatch } from '../src/query-expansion.js';

describe('expandQueryWithGlossary', () => {
  it('appends a glossary-enriched variant with definition + aliases', async () => {
    const lookup = async (): Promise<GlossaryMatch[]> => [
      { term: 'CLIC', definition: 'the candidate platform', aliases: ['clic-platform'] },
    ];
    const out = await expandQueryWithGlossary('what does CLIC do', lookup);
    // Base expansion first; the enriched variant folds in the definition + alias.
    expect(out[0]).toBe('what does CLIC do');
    const enriched = out[out.length - 1];
    expect(enriched).toContain('the candidate platform');
    expect(enriched).toContain('clic-platform');
  });

  it('falls back to the base expansion when no terms match', async () => {
    const out = await expandQueryWithGlossary('unrelated query', async () => []);
    expect(out).toContain('unrelated query');
    // No glossary variant added.
    expect(out.every((q) => !q.includes('undefined'))).toBe(true);
  });

  it('never throws when the lookup fails — returns the base expansion', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('qdrant down');
    });
    const out = await expandQueryWithGlossary('deploy service', lookup);
    expect(out[0]).toBe('deploy service');
  });

  it('caps the number of glossary variants', async () => {
    const lookup = async (): Promise<GlossaryMatch[]> => [
      { term: 'A', definition: 'aaa', aliases: [] },
      { term: 'B', definition: 'bbb', aliases: [] },
      { term: 'C', definition: 'ccc', aliases: [] },
    ];
    const out = await expandQueryWithGlossary('q', lookup, 2);
    const enriched = out.filter(
      (q) => q !== 'q' && (q.includes('aaa') || q.includes('bbb') || q.includes('ccc'))
    );
    // The helper folds all matches into ONE variant string? No — it adds one
    // variant per match, capped at maxGlossary=2.
    expect(enriched.length).toBeLessThanOrEqual(2);
  });

  it('returns the base expansion for an empty query', async () => {
    const out = await expandQueryWithGlossary('   ', async () => [
      { term: 'X', definition: 'd', aliases: [] },
    ]);
    // Empty query short-circuits before glossary enrichment.
    expect(out.some((q) => q.includes('d'))).toBe(false);
  });
});
