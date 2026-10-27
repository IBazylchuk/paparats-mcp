import { describe, expect, it } from 'vitest';
import {
  BARE_IDENTIFIER_DEFINES_BOOST,
  CHURN_WEIGHT,
  DEFINES_IDENTIFIER_BOOST,
  FILE_NAMED_AFTER_IDENTIFIER_BOOST,
  TEST_FILE_DEMOTION,
  definitionCandidatesFilter,
  identifierTokens,
  conventionalTestPaths,
  isTestPath,
  mentionsTests,
  rankKey,
  rankQuery,
} from '../src/ranking.js';

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

describe('identifierTokens', () => {
  it('picks code-shaped tokens and the parts of qualified names', () => {
    expect(
      identifierTokens('Billing::InvoiceTotal charge_card retry logic in buildSymbolEdges')
    ).toEqual([
      'Billing::InvoiceTotal',
      'Billing',
      'InvoiceTotal',
      'charge_card',
      'buildSymbolEdges',
    ]);
  });

  it('ignores plain words, capitalised or not', () => {
    expect(identifierTokens('Where is the Invoice total computed')).toEqual([]);
    expect(identifierTokens('id of a user')).toEqual([]);
  });
});

describe('definitionCandidatesFilter', () => {
  it('matches chunks that define any of the identifiers', () => {
    expect(definitionCandidatesFilter(['InvoiceTotal', 'charge_card'])).toEqual({
      must: [{ key: 'defines_symbols', match: { any: ['InvoiceTotal', 'charge_card'] } }],
    });
  });
});

describe('rankKey for identifier queries', () => {
  const query = rankQuery('where is InvoiceTotal computed');

  it('lifts a chunk that defines a named identifier above one that only uses it', () => {
    const user = { score: 0.52, file: 'app/services/report.rb', defines_symbols: ['render'] };
    const definition = {
      score: 0.5,
      file: 'app/models/total.rb',
      defines_symbols: ['InvoiceTotal'],
    };
    expect(rankKey(query, definition)).toBeCloseTo(0.5 * DEFINES_IDENTIFIER_BOOST);
    expect(rankKey(query, definition)).toBeGreaterThan(rankKey(query, user));
  });

  it('lifts a file named after the identifier, in either naming style', () => {
    expect(rankKey(query, { score: 0.5, file: 'app/models/invoice_total.rb' })).toBeCloseTo(
      0.5 * FILE_NAMED_AFTER_IDENTIFIER_BOOST
    );
    expect(rankKey(query, { score: 0.5, file: 'src/InvoiceTotal.ts' })).toBeCloseTo(
      0.5 * FILE_NAMED_AFTER_IDENTIFIER_BOOST
    );
  });

  it('leaves queries without identifiers to similarity and test demotion', () => {
    const plain = rankQuery('where is the invoice total computed');
    const r = {
      score: 0.5,
      file: 'app/models/invoice_total.rb',
      defines_symbols: ['InvoiceTotal'],
    };
    expect(rankKey(plain, r)).toBe(0.5);
  });

  it('puts the definition first when the query is only the name', () => {
    const reexport = { score: 0.5, file: 'src/config.ts', defines_symbols: [] };
    const definition = { score: 0.42, file: 'src/indexer.ts', defines_symbols: ['charge_card'] };
    for (const bare of ['charge_card', '  charge_card ', 'Billing::charge_card', 'valid_card?']) {
      expect(rankQuery(bare).bare).toBe(true);
    }
    expect(rankKey('charge_card', definition)).toBeCloseTo(0.42 * BARE_IDENTIFIER_DEFINES_BOOST);
    expect(rankKey('charge_card', definition)).toBeGreaterThan(rankKey('charge_card', reexport));
    // With other words around it, the usual boost.
    expect(rankQuery('where is charge_card called').bare).toBe(false);
    expect(rankKey('where is charge_card called', definition)).toBeCloseTo(
      0.42 * DEFINES_IDENTIFIER_BOOST
    );
    expect(rankQuery('invoice').bare).toBe(false);
  });

  it('accepts the raw query string too', () => {
    const r = { score: 0.5, file: 'a.rb', defines_symbols: ['InvoiceTotal'] };
    expect(rankKey('InvoiceTotal', r)).toBe(rankKey(rankQuery('InvoiceTotal'), r));
  });
});

describe('rankKey with file churn', () => {
  it('lifts files that change often, by up to CHURN_WEIGHT', () => {
    const q = rankQuery('where are invoices totalled');
    expect(rankKey(q, { score: 0.5, file: 'a.rb', file_churn: 1 })).toBeCloseTo(
      0.5 * (1 + CHURN_WEIGHT)
    );
    expect(rankKey(q, { score: 0.5, file: 'a.rb', file_churn: 0 })).toBe(0.5);
    expect(rankKey(q, { score: 0.5, file: 'a.rb', file_churn: null })).toBe(0.5);
  });

  it('does not outweigh a clearly closer match', () => {
    const q = rankQuery('where are invoices totalled');
    expect(rankKey(q, { score: 0.6, file: 'a.rb', file_churn: 0 })).toBeGreaterThan(
      rankKey(q, { score: 0.55, file: 'b.rb', file_churn: 1 })
    );
  });
});

describe('conventionalTestPaths', () => {
  it('names where a file’s tests sit by convention', () => {
    expect(conventionalTestPaths('app/models/invoice.rb')).toEqual([
      'spec/models/invoice_spec.rb',
      'test/models/invoice_test.rb',
    ]);
    expect(conventionalTestPaths('lib/billing/ledger.rb')).toEqual([
      'spec/lib/billing/ledger_spec.rb',
      'test/lib/billing/ledger_test.rb',
    ]);
    expect(conventionalTestPaths('src/queue.ts')).toEqual([
      'src/queue.test.ts',
      'src/queue.spec.ts',
    ]);
    expect(conventionalTestPaths('spec/models/invoice_spec.rb')).toEqual([]);
    expect(conventionalTestPaths('README.md')).toEqual([]);
  });
});
