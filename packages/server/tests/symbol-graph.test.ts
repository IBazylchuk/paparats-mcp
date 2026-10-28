import { describe, it, expect } from 'vitest';
import {
  buildSymbolEdges,
  COMMON_NAME_MIN_FILES,
  isCommonName,
  MAX_DEFINITION_FANOUT,
  type ChunkSymbols,
} from '../src/symbol-graph.js';
import type { SymbolEdge } from '../src/types.js';

describe('isCommonName', () => {
  const usage = (callerFiles: number, names: Record<string, number>) => ({
    callerFiles,
    filesUsing: new Map(Object.entries(names)),
  });

  it('flags a single lowercase word used from more than a few files, however large the group', () => {
    const u = usage(6000, { create: 33, digest: 18, close: 3 });
    expect(isCommonName('create', u)).toBe(true);
    expect(isCommonName('digest', u)).toBe(true);
    expect(isCommonName('close', u)).toBe(false);
  });

  it('counts Ruby conversions as one word', () => {
    const u = usage(6000, { to_s: 900, to_h: 400 });
    expect(isCommonName('to_s', u)).toBe(true);
    expect(isCommonName('to_h', u)).toBe(true);
  });

  it('keeps compound names, however widely used', () => {
    const u = usage(400, { ProjectConfig: 300, getChunkById: 300, find_by_name: 300 });
    for (const name of ['ProjectConfig', 'getChunkById', 'find_by_name']) {
      expect(isCommonName(name, u)).toBe(false);
    }
  });

  it('needs more than the minimum number of files', () => {
    const u = usage(16, { run: COMMON_NAME_MIN_FILES, each: COMMON_NAME_MIN_FILES + 1 });
    expect(isCommonName('run', u)).toBe(false);
    expect(isCommonName('each', u)).toBe(true);
    expect(isCommonName('valid?', usage(16, { 'valid?': 9 }))).toBe(true);
  });
});

describe('buildSymbolEdges', () => {
  it('keeps the methods reaching a call apart from those making it, and how it is used', () => {
    const { edges } = buildSymbolEdges([
      {
        chunk_id: 'g//p//log.rb//0-9//a',
        defines_symbols: ['signature_valid?', 'Receipt'],
        uses_symbols: [],
      },
      {
        chunk_id: 'g//p//unsub.rb//0-9//b',
        defines_symbols: ['ledger_entry', 'call'],
        uses_symbols: ['signature_valid?', 'Receipt'],
        use_sites: [
          { name: 'signature_valid?', from: 'ledger_entry' },
          { name: 'signature_valid?', from: 'call', through: true },
          { name: 'Receipt', from: 'ledger_entry' },
          { name: 'Receipt', from: 'call', value: true },
        ],
      },
    ]);
    const edge = (name: string) => edges.find((e) => e.symbol_name === name);
    expect(edge('signature_valid?')).toMatchObject({
      relation_type: 'calls',
      from_symbols: ['ledger_entry'],
      reach_symbols: ['call'],
    });
    // Held as a value anywhere in the chunk: `change_impact` follows it whatever changed.
    expect(edge('Receipt')?.relation_type).toBe('references');
    expect(edge('Receipt')?.reach_symbols).toBeUndefined();
  });

  it('links a file-private definition only from its own file', () => {
    const { edges } = buildSymbolEdges([
      {
        chunk_id: 'g//p//lint.ts//0-9//a',
        defines_symbols: ['readText'],
        uses_symbols: [],
        local_defs: ['readText'],
      },
      { chunk_id: 'g//p//lint.ts//10-19//b', defines_symbols: [], uses_symbols: ['readText'] },
      { chunk_id: 'g//p//io.ts//0-9//c', defines_symbols: ['readText'], uses_symbols: [] },
      { chunk_id: 'g//p//app.ts//0-9//d', defines_symbols: [], uses_symbols: ['readText'] },
    ]);
    const links = edges.map((e) => [
      e.from_chunk_id.split('//')[2],
      e.to_chunk_id.split('//')[2],
      e.confidence,
    ]);
    // Each use has one definition it can reach, so neither link is ambiguous.
    expect(links.sort()).toEqual([
      ['app.ts', 'io.ts', 'INFERRED'],
      ['lint.ts', 'lint.ts', 'EXTRACTED'],
    ]);
  });

  it('links a bare call to the top-level definition beside it in the same file', () => {
    const { edges } = buildSymbolEdges([
      {
        chunk_id: 'g//p//scripts/compare.rb//0-9//a',
        defines_symbols: ['pairs'],
        uses_symbols: [],
      },
      {
        chunk_id: 'g//p//scripts/compare.rb//10-19//b',
        defines_symbols: [],
        uses_symbols: ['pairs'],
        use_sites: [{ name: 'pairs', from: '' }],
      },
      { chunk_id: 'g//p//scripts/other.rb//0-9//c', defines_symbols: ['pairs'], uses_symbols: [] },
      {
        chunk_id: 'g//p//lib/ledger.rb//0-9//d',
        defines_symbols: ['pairs'],
        uses_symbols: [],
        def_owners: { pairs: 'Ledger' },
      },
      {
        chunk_id: 'g//p//lib/ledger.rb//10-19//e',
        defines_symbols: [],
        uses_symbols: ['pairs'],
        use_sites: [{ name: 'pairs', from: '', onObject: true }],
      },
    ]);
    const links = edges.map((e) => [
      e.from_chunk_id.split('//')[2],
      e.to_chunk_id.split('//')[2],
      e.confidence,
    ]);
    expect(links.filter((l) => l[0] === 'scripts/compare.rb')).toEqual([
      ['scripts/compare.rb', 'scripts/compare.rb', 'EXTRACTED'],
    ]);
    // A call on an object, or beside a method of a class, is not narrowed.
    expect(links.filter((l) => l[0] === 'lib/ledger.rb')).toHaveLength(3);
  });

  it('does not link a call on an object to a Ruby class method', () => {
    const { edges } = buildSymbolEdges([
      {
        chunk_id: 'g//p//queue.rb//0-9//a',
        defines_symbols: ['batch'],
        uses_symbols: [],
        def_owners: { batch: 'Queue' },
        class_methods: ['batch'],
      },
      {
        chunk_id: 'g//p//draft.rb//0-9//b',
        defines_symbols: [],
        uses_symbols: ['batch'],
        use_sites: [{ name: 'batch', from: 'resolve', onObject: true }],
      },
      {
        chunk_id: 'g//p//flush.rb//0-9//c',
        defines_symbols: [],
        uses_symbols: ['batch'],
        use_sites: [{ name: 'batch', from: 'perform', on: 'Queue' }],
      },
    ]);
    expect(edges.map((e) => e.from_chunk_id.split('//')[2])).toEqual(['flush.rb']);
  });

  it('links a Ruby constant to the class its namespace lookup finds, and a gem constant to none', () => {
    const def = (id: string, owner?: string) => ({
      chunk_id: `g//p//${id}//0-9//h`,
      defines_symbols: ['Base'],
      uses_symbols: [],
      ...(owner ? { def_owners: { Base: owner } } : {}),
    });
    const use = (id: string, site: Record<string, unknown>) => ({
      chunk_id: `g//p//${id}//0-9//u`,
      defines_symbols: [],
      uses_symbols: ['Base'],
      use_sites: [{ name: 'Base', from: '', constant: true as const, ...site }],
    });
    const { edges } = buildSymbolEdges([
      def('orbit/base.rb', 'Orbit'),
      def('reports/base.rb', 'Reports'),
      def('base.rb'),
      use('orbit/runner.rb', { lexical: true, in: 'Orbit::Runner' }),
      use('jobs/sync.rb', { lexical: true, in: 'Jobs::Sync' }),
      use('reports/view.rb', { on: 'Reports', in: 'Billing' }),
      use('models/user.rb', { on: 'ActiveRecord' }),
    ]);
    const links = edges.map(
      (e) => `${e.from_chunk_id.split('//')[2]} -> ${e.to_chunk_id.split('//')[2]} ${e.confidence}`
    );
    expect(links.sort()).toEqual([
      'jobs/sync.rb -> base.rb EXTRACTED',
      'orbit/runner.rb -> orbit/base.rb EXTRACTED',
      'reports/view.rb -> reports/base.rb EXTRACTED',
    ]);
  });

  it('creates edges from usage to definition', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//f1.ts//1-5//h1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//f2.ts//1-5//h2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      from_chunk_id: 'g//p//f2.ts//1-5//h2',
      to_chunk_id: 'g//p//f1.ts//1-5//h1',
      relation_type: 'calls',
      symbol_name: 'greet',
      confidence: 'INFERRED',
      from_symbols: [],
    });
  });

  it('links a call that names its class only to that class, as EXTRACTED', () => {
    const { edges } = buildSymbolEdges([
      {
        chunk_id: 'g//p//usage.rb//1-5//h1',
        defines_symbols: ['claim'],
        uses_symbols: [],
        def_owners: { claim: 'Usage' },
      },
      {
        chunk_id: 'g//p//quota.rb//1-5//h2',
        defines_symbols: ['claim'],
        uses_symbols: [],
        def_owners: { claim: 'Quota' },
      },
      {
        chunk_id: 'g//p//caller.rb//1-5//h3',
        defines_symbols: [],
        uses_symbols: ['claim'],
        use_sites: [{ name: 'claim', from: 'run', on: 'Usage' }],
      },
    ]);

    expect(edges).toEqual([
      expect.objectContaining({
        to_chunk_id: 'g//p//usage.rb//1-5//h1',
        confidence: 'EXTRACTED',
        from_symbols: ['run'],
      }),
    ]);
  });

  it('resolves a relative class name from the namespace of the call, as Ruby does', () => {
    const defs = [
      ['api', 'Api::Parser'],
      ['ext', 'Intake::Parser'],
      ['top', 'Parser'],
    ].map(([id, owner]) => ({
      chunk_id: `g//p//${id}.rb//1-5//h`,
      defines_symbols: ['resolve'],
      uses_symbols: [],
      def_owners: { resolve: owner! },
    }));
    const caller = (on: string, scope?: string) => ({
      chunk_id: 'g//p//caller.rb//1-5//h',
      defines_symbols: [],
      uses_symbols: ['resolve'],
      use_sites: [{ name: 'resolve', from: 'run', on, ...(scope ? { in: scope } : {}) }],
    });
    const linked = (c: ReturnType<typeof caller>) =>
      buildSymbolEdges([...defs, c]).edges.map((e) => [e.to_chunk_id.split('//')[2], e.confidence]);

    // From inside Intake, `Parser` is Intake::Parser, not the others of the same name.
    expect(linked(caller('Parser', 'Intake::Pipeline'))).toEqual([['ext.rb', 'EXTRACTED']]);
    expect(linked(caller('Parser', 'Billing::Job'))).toEqual([['top.rb', 'EXTRACTED']]);
    expect(linked(caller('::Api::Parser'))).toEqual([['api.rb', 'EXTRACTED']]);
    // No class of the project is `V1::Parser`: a gem's, which links to nothing.
    expect(linked(caller('V1::Parser'))).toEqual([]);
  });

  it('is less sure of a class found by the end of its path, or defined in several files', () => {
    const def = (id: string, owner: string) => ({
      chunk_id: `g//p//${id}.rb//1-5//h`,
      defines_symbols: ['resolve'],
      uses_symbols: [],
      def_owners: { resolve: owner },
    });
    const caller = {
      chunk_id: 'g//p//caller.rb//1-5//h',
      defines_symbols: [],
      uses_symbols: ['resolve'],
      use_sites: [{ name: 'resolve', from: 'run', on: 'Parser' }],
    };
    const confidences = (defs: Array<ReturnType<typeof def>>) =>
      buildSymbolEdges([...defs, caller]).edges.map((e) => e.confidence);

    expect(confidences([def('a', 'Api::Parser'), def('x', 'Other')])).toEqual(['INFERRED']);
    expect(confidences([def('a', 'Api::Parser'), def('b', 'Intake::Parser')])).toEqual([
      'AMBIGUOUS',
      'AMBIGUOUS',
    ]);
    expect(confidences([def('a', 'Parser'), def('b', 'Parser')])).toEqual([
      'AMBIGUOUS',
      'AMBIGUOUS',
    ]);
  });

  it('looks a method up the class ancestry, and links nothing when no class of the project answers', () => {
    const defs = [
      {
        chunk_id: 'g//p//a.rb//0-9//a',
        defines_symbols: ['claim'],
        uses_symbols: [],
        def_owners: { claim: 'A' },
      },
      {
        chunk_id: 'g//p//b.rb//0-9//b',
        defines_symbols: ['claim'],
        uses_symbols: [],
        def_owners: { claim: 'B' },
      },
      {
        chunk_id: 'g//p//child.rb//0-9//c',
        defines_symbols: ['Child'],
        uses_symbols: [],
        def_classes: { Child: [{ name: 'A' }] },
      },
    ];
    const caller = (on: string) => ({
      chunk_id: 'g//p//run.rb//0-9//d',
      defines_symbols: [],
      uses_symbols: ['claim'],
      use_sites: [{ name: 'claim', from: 'run', on }],
    });
    const linked = (on: string) =>
      buildSymbolEdges([...defs, caller(on)]).edges.map((e) => [
        e.to_chunk_id.split('//')[2],
        e.confidence,
      ]);

    expect(linked('Child')).toEqual([['a.rb', 'EXTRACTED']]);
    // `ActiveRecord::Base.claim`, `Gem.claim`: not the project's, so not its namesakes either.
    expect(linked('Gem')).toEqual([]);
  });

  it('collects the calling methods per edge; a call outside any method makes the whole chunk the caller', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'def', defines_symbols: ['post', 'log'], uses_symbols: [] },
      {
        chunk_id: 'caller',
        defines_symbols: ['a', 'b'],
        uses_symbols: ['post', 'log'],
        use_sites: [
          { name: 'post', from: 'a' },
          { name: 'post', from: 'b' },
          { name: 'log', from: 'a' },
          { name: 'log', from: '' },
        ],
      },
    ]);

    const bySymbol = Object.fromEntries(edges.map((e) => [e.symbol_name, e.from_symbols]));
    expect(bySymbol).toEqual({ post: ['a', 'b'], log: [] });
  });

  it('exempts a call naming its class from the fan-out cap', () => {
    const chunks = [
      { chunk_id: 'd1', defines_symbols: ['call'], uses_symbols: [], def_owners: { call: 'One' } },
      { chunk_id: 'd2', defines_symbols: ['call'], uses_symbols: [], def_owners: { call: 'Two' } },
      {
        chunk_id: 'd3',
        defines_symbols: ['call'],
        uses_symbols: [],
        def_owners: { call: 'Three' },
      },
      {
        chunk_id: 'c',
        defines_symbols: [],
        uses_symbols: ['call'],
        use_sites: [{ name: 'call', from: 'run', on: 'Two' }],
      },
    ];
    const { edges, stats } = buildSymbolEdges(chunks, 2);

    expect(edges.map((e) => e.to_chunk_id)).toEqual(['d2']);
    expect(stats.skippedSymbols).toBe(0);
  });

  it('labels intra-file edges as EXTRACTED (same `<group>//<project>//<file>` prefix)', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//same.ts//1-5//h1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//same.ts//6-10//h2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.confidence).toBe('EXTRACTED');
  });

  it('labels edges AMBIGUOUS when a symbol resolves to multiple chunks', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//a.ts//1-5//h1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//b.ts//1-5//h2', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'g//p//c.ts//1-5//h3', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.confidence === 'AMBIGUOUS')).toBe(true);
  });

  it('creates multiple edges for multiple symbols', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['foo', 'bar'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['foo', 'bar'] },
    ]);

    expect(edges).toHaveLength(2);
    const symbols = edges.map((e) => e.symbol_name).sort();
    expect(symbols).toEqual(['bar', 'foo']);
  });

  it('skips self-edges', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(0);
  });

  it('deduplicates edges by (from, to, symbol)', () => {
    // Same symbol defined in same chunk, used by same chunk - should only appear once
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(1);
  });

  it('handles multiple callers for one definition', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'def', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'caller1', defines_symbols: [], uses_symbols: ['greet'] },
      { chunk_id: 'caller2', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.to_chunk_id === 'def')).toBe(true);
  });

  it('handles symbol defined in multiple chunks', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'def1', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'def2', defines_symbols: ['greet'], uses_symbols: [] },
      { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['greet'] },
    ]);

    // Caller -> def1 and Caller -> def2
    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.to_chunk_id).sort();
    expect(targets).toEqual(['def1', 'def2']);
  });

  it('with `only`, gives the edges of the uses it accepts exactly as the full graph has them', () => {
    const chunks = [
      { chunk_id: 'g//p//a.rb//1-5//h1', defines_symbols: ['claim'], uses_symbols: ['save'] },
      { chunk_id: 'g//p//b.rb//1-5//h2', defines_symbols: ['claim', 'save'], uses_symbols: [] },
      { chunk_id: 'g//p//c.rb//1-5//h3', defines_symbols: [], uses_symbols: ['claim', 'save'] },
      { chunk_id: 'g//p//d.rb//1-5//h4', defines_symbols: [], uses_symbols: ['save'] },
    ];
    const only = (chunkId: string, name: string) =>
      chunkId.includes('//a.rb//') || name === 'claim';
    const full = buildSymbolEdges(chunks).edges.filter((e) => only(e.from_chunk_id, e.symbol_name));
    const part = buildSymbolEdges(chunks, undefined, only).edges;
    expect(part).toEqual(full);
    expect(part.map((e) => `${e.from_chunk_id} ${e.symbol_name}`)).not.toContain(
      'g//p//d.rb//1-5//h4 save'
    );
  });

  it('finds a method in a mixin, a top-level helper, or the implementations of an interface', () => {
    const chunk = (id: string, extra: Partial<ChunkSymbols>): ChunkSymbols => ({
      chunk_id: `g//p//${id}//0-9//h`,
      defines_symbols: [],
      uses_symbols: [],
      ...extra,
    });
    const to = (edges: SymbolEdge[]) =>
      edges.map((e) => [e.to_chunk_id.split('//')[2], e.confidence]);
    const ruby = [
      chunk('retryable.rb', { defines_symbols: ['attempt'], def_owners: { attempt: 'Retryable' } }),
      chunk('other.rb', { defines_symbols: ['attempt'], def_owners: { attempt: 'Other' } }),
      chunk('helpers.rb', { defines_symbols: ['slugify'] }),
      chunk('run.rb', {
        defines_symbols: ['Run'],
        def_classes: { Run: [{ name: 'Retryable' }] },
        uses_symbols: ['attempt', 'slugify'],
        use_sites: [
          { name: 'attempt', from: 'go', on: '::Run' },
          { name: 'slugify', from: 'go', on: '::Run' },
        ],
      }),
    ];
    const edges = buildSymbolEdges(ruby).edges;
    expect(to(edges.filter((e) => e.symbol_name === 'attempt'))).toEqual([
      ['retryable.rb', 'EXTRACTED'],
    ]);
    expect(to(edges.filter((e) => e.symbol_name === 'slugify'))).toEqual([
      ['helpers.rb', 'INFERRED'],
    ]);

    const ts = [
      chunk('store.ts', { defines_symbols: ['Store'], def_classes: { Store: [] } }),
      chunk('memory.ts', {
        defines_symbols: ['MemoryStore', 'save'],
        def_owners: { save: 'MemoryStore' },
        def_classes: { MemoryStore: [{ name: 'Store', module: './store.js' }] },
      }),
      chunk('file.ts', {
        defines_symbols: ['FileStore', 'save'],
        def_owners: { save: 'FileStore' },
        def_classes: { FileStore: [{ name: 'Store', module: './store.js' }] },
      }),
      chunk('cache.ts', { defines_symbols: ['save'], def_owners: { save: 'Cache' } }),
      chunk('use.ts', {
        uses_symbols: ['save'],
        use_sites: [
          { name: 'save', from: 'run', on: 'Store', module: './store.js', onObject: true },
        ],
      }),
    ];
    // A call on an interface reaches what implements it, each of them, and
    // nothing else of that name.
    expect(to(buildSymbolEdges(ts).edges)).toEqual([
      ['memory.ts', 'INFERRED'],
      ['file.ts', 'INFERRED'],
    ]);
  });

  it('links an imported name to its module, and a call on a builtin or a package to nothing', () => {
    const chunk = (id: string, extra: Partial<ChunkSymbols>): ChunkSymbols => ({
      chunk_id: `g//p//src/${id}//0-9//h`,
      defines_symbols: [],
      uses_symbols: [],
      ...extra,
    });
    const { edges } = buildSymbolEdges([
      chunk('a.ts', { defines_symbols: ['parse'] }),
      chunk('lib/b.ts', { defines_symbols: ['parse'] }),
      chunk('lib/c.ts', {
        uses_symbols: ['parse'],
        use_sites: [
          { name: 'parse', from: 'run', module: '../a.js' },
          { name: 'parse', from: 'check', external: true },
        ],
      }),
    ]);
    expect(edges.map((e) => [e.to_chunk_id.split('//')[2], e.confidence, e.from_symbols])).toEqual([
      ['src/a.ts', 'EXTRACTED', ['run']],
    ]);
  });

  it('returns empty array for no input', () => {
    expect(buildSymbolEdges([])).toEqual({
      edges: [],
      stats: { skippedSymbols: 0, skippedEdges: 0 },
    });
  });

  it('returns empty array when no cross-references exist', () => {
    const { edges } = buildSymbolEdges([
      { chunk_id: 'a', defines_symbols: ['foo'], uses_symbols: [] },
      { chunk_id: 'b', defines_symbols: ['bar'], uses_symbols: [] },
    ]);

    expect(edges).toEqual([]);
  });

  describe('high-fanout cap', () => {
    it('skips a symbol defined in more chunks than the fanout cap', () => {
      // `Business` is defined in 3 chunks; with a cap of 2 it is structural
      // noise and must not link the caller to any of them.
      const chunks = [
        { chunk_id: 'def1', defines_symbols: ['Business'], uses_symbols: [] },
        { chunk_id: 'def2', defines_symbols: ['Business'], uses_symbols: [] },
        { chunk_id: 'def3', defines_symbols: ['Business'], uses_symbols: [] },
        { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['Business'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks, 2);

      expect(edges).toHaveLength(0);
      expect(stats.skippedSymbols).toBe(1);
      // 1 caller × 3 definitions = 3 edges avoided.
      expect(stats.skippedEdges).toBe(3);
    });

    it('keeps a symbol defined at exactly the cap (boundary is >, not >=)', () => {
      const chunks = [
        { chunk_id: 'def1', defines_symbols: ['helper'], uses_symbols: [] },
        { chunk_id: 'def2', defines_symbols: ['helper'], uses_symbols: [] },
        { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['helper'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks, 2);

      expect(edges).toHaveLength(2);
      expect(stats.skippedSymbols).toBe(0);
      expect(stats.skippedEdges).toBe(0);
    });

    it('counts a skipped symbol once even when many chunks use it', () => {
      const chunks = [
        { chunk_id: 'def1', defines_symbols: ['ns'], uses_symbols: [] },
        { chunk_id: 'def2', defines_symbols: ['ns'], uses_symbols: [] },
        { chunk_id: 'def3', defines_symbols: ['ns'], uses_symbols: [] },
        { chunk_id: 'c1', defines_symbols: [], uses_symbols: ['ns'] },
        { chunk_id: 'c2', defines_symbols: [], uses_symbols: ['ns'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks, 2);

      expect(edges).toHaveLength(0);
      expect(stats.skippedSymbols).toBe(1);
      // 2 callers × 3 definitions.
      expect(stats.skippedEdges).toBe(6);
    });

    it('defaults to MAX_DEFINITION_FANOUT and keeps normal symbols', () => {
      // Well under the default cap — nothing is skipped.
      const chunks = [
        { chunk_id: 'def', defines_symbols: ['greet'], uses_symbols: [] },
        { chunk_id: 'caller', defines_symbols: [], uses_symbols: ['greet'] },
      ];
      const { edges, stats } = buildSymbolEdges(chunks);

      expect(MAX_DEFINITION_FANOUT).toBeGreaterThan(1);
      expect(edges).toHaveLength(1);
      expect(stats.skippedSymbols).toBe(0);
    });
  });
});
