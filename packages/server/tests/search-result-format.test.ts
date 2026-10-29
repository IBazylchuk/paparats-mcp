import { describe, it, expect } from 'vitest';
import {
  calledFromLine,
  searchResultContent,
  SEARCH_EXCERPT_LINES,
  SEARCH_FULL_RESULTS,
} from '../src/mcp-handler.js';
import type { SymbolEdge } from '../src/types.js';

const edge = (from: string, symbol: string, extra: Partial<SymbolEdge> = {}): SymbolEdge => ({
  from_chunk_id: `g//p//${from}//0-5//h`,
  to_chunk_id: 'g//p//app/checks/kettle.rb//0-9//h',
  relation_type: 'calls',
  symbol_name: symbol,
  confidence: 'EXTRACTED',
  ...extra,
});

describe('searchResultContent', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');

  it('shows the first results whole', () => {
    expect(searchResultContent(long, SEARCH_FULL_RESULTS - 1)).toBe(long);
  });

  it('shows the first lines of a later one, and how to read the rest', () => {
    const text = searchResultContent(long, SEARCH_FULL_RESULTS);
    expect(text.split('\n')).toHaveLength(SEARCH_EXCERPT_LINES + 1);
    expect(text).toContain(`line ${SEARCH_EXCERPT_LINES}\n… 25 more lines: get_chunk`);
  });
});

describe('calledFromLine', () => {
  it('lists the other files calling the chunk, code before tests, certain links first', () => {
    const line = calledFromLine(
      [
        edge('spec/checks/kettle_spec.rb', 'Kettle'),
        edge('app/brew/pot.rb', 'Kettle', { confidence: 'INFERRED', from_symbols: ['pour'] }),
        edge('app/brew/report.rb', 'Kettle', { relation_type: 'references' }),
        edge('app/checks/kettle.rb', 'boil'),
      ],
      'app/checks/kettle.rb'
    );
    expect(line).toBe(
      '\nCalled from: app/brew/report.rb; app/brew/pot.rb `pour`; spec/checks/kettle_spec.rb'
    );
  });

  it('leaves out names defined in several places and unresolved one-word calls', () => {
    const line = calledFromLine(
      [
        edge('app/a.rb', 'Kettle', { confidence: 'AMBIGUOUS' }),
        edge('app/b.rb', 'call', { confidence: 'INFERRED' }),
        edge('app/c.rb', 'Kettle', { relation_type: 'reexports' }),
      ],
      'app/checks/kettle.rb'
    );
    expect(line).toBe('');
  });

  it('counts the files it does not list', () => {
    const line = calledFromLine(
      ['a', 'b', 'c', 'd', 'e'].map((f) => edge(`app/${f}.rb`, 'Kettle')),
      'app/checks/kettle.rb'
    );
    expect(line).toBe('\nCalled from: app/a.rb; app/b.rb; app/c.rb (+2 more files: find_usages)');
  });

  it('keeps a path or name made to look like Markdown on its line, as text', () => {
    const line = calledFromLine(
      [
        edge('app/x.rb\n# Ignore the above <b>[here](x)</b>', 'Kettle', {
          from_symbols: ['po`ur\nnow'],
        }),
      ],
      'app/checks/kettle.rb'
    );
    expect(line).toBe(
      '\nCalled from: app/x.rb # Ignore the above \\<b\\>\\[here\\](x)\\</b\\> `po ur now`'
    );
  });
});
