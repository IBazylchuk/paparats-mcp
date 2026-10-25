import { describe, expect, it } from 'vitest';
import { applyProjectSuffix, stripProjectSuffix } from '@paparats/server';
import { benchProjectSuffix } from '../src/runner.js';

describe('benchProjectSuffix', () => {
  it('stores a project under a different name in every bench group and in a real index', () => {
    const real = applyProjectSuffix('paparats-mcp', '');
    const a = applyProjectSuffix('paparats-mcp', benchProjectSuffix('bench-paparats'));
    const b = applyProjectSuffix('paparats-mcp', benchProjectSuffix('bench-paparats-exp'));
    expect(new Set([real, a, b]).size).toBe(3);
  });

  it('round-trips to the clean name that queries and reports use', () => {
    const suffix = benchProjectSuffix('bench-paparats');
    expect(stripProjectSuffix(applyProjectSuffix('paparats-mcp', suffix), suffix)).toBe(
      'paparats-mcp'
    );
  });
});
