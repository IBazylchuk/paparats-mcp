import { describe, expect, it } from 'vitest';
import { TEST_FILE_DEMOTION, isTestPath, mentionsTests, rankKey } from '../src/ranking.js';

describe('isTestPath', () => {
  it('recognises test files and directories across languages', () => {
    for (const file of [
      'packages/server/tests/searcher.test.ts',
      'src/__tests__/app.tsx',
      'spec/models/user_spec.rb',
      'lib/parser.spec.js',
      'pkg/handler_test.go',
      'test/test_utils.py',
    ]) {
      expect(isTestPath(file), file).toBe(true);
    }
  });

  it('leaves implementation files alone, including names that only contain "test"', () => {
    for (const file of [
      'packages/server/src/symbol-graph.ts',
      'app/services/attestation_service.rb',
      'src/latest.ts',
      'src/contest/score.py',
    ]) {
      expect(isTestPath(file), file).toBe(false);
    }
  });
});

describe('mentionsTests', () => {
  it('spots queries about tests', () => {
    expect(mentionsTests('where are the searcher tests')).toBe(true);
    expect(mentionsTests('rspec factory for users')).toBe(true);
    expect(mentionsTests('vitest setup')).toBe(true);
  });

  it('does not fire on words that merely contain "test"', () => {
    expect(mentionsTests('buildSymbolEdges')).toBe(false);
    expect(mentionsTests('latest release notes')).toBe(false);
    expect(mentionsTests('attestation flow')).toBe(false);
  });
});

describe('rankKey', () => {
  it('demotes a test file below code of slightly lower similarity', () => {
    const test = { score: 0.52, file: 'tests/symbol-graph.test.ts' };
    const code = { score: 0.5, file: 'src/symbol-graph.ts' };
    expect(rankKey('buildSymbolEdges', test)).toBeCloseTo(0.52 * TEST_FILE_DEMOTION);
    expect(rankKey('buildSymbolEdges', code)).toBe(0.5);
    expect(rankKey('buildSymbolEdges', test)).toBeLessThan(rankKey('buildSymbolEdges', code));
  });

  it('keeps test files at their similarity when the query asks about tests', () => {
    expect(rankKey('tests for buildSymbolEdges', { score: 0.52, file: 'tests/a.test.ts' })).toBe(
      0.52
    );
  });
});
