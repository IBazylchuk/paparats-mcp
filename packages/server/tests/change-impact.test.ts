import { describe, expect, it } from 'vitest';
import { collectDependents, definitionLine } from '../src/change-impact.js';
import { buildSymbolEdges } from '../src/symbol-graph.js';
import type { EdgeConfidence, SymbolEdge } from '../src/types.js';

/** Edges as `[caller, callee, symbol, confidence?, calling methods?]`. */
function graph(edges: Array<[string, string, string, EdgeConfidence?, string[]?]>) {
  const rows: SymbolEdge[] = edges.map(([from, to, sym, confidence, fromSymbols]) => ({
    from_chunk_id: from,
    to_chunk_id: to,
    relation_type: 'calls',
    symbol_name: sym,
    ...(confidence ? { confidence } : {}),
    ...(fromSymbols ? { from_symbols: fromSymbols } : {}),
  }));
  return (id: string) => rows.filter((e) => e.to_chunk_id === id);
}

const base = { depth: 2, maxDependents: 50, isHub: () => false };

describe('collectDependents', () => {
  it('walks callers hop by hop and reports each chunk once, at its nearest hop', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['b', 'a', 'g'],
      ['b', 'seed', 'f'],
      ['c', 'b', 'h'],
    ]);
    const { dependents, deeper } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => [d.chunkId, d.hop])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 2],
    ]);
    expect(deeper).toBe(false);
  });

  it('passes the change on only through the calling method, not its neighbours in the chunk', () => {
    // `config` holds two methods; only `description` calls the seed.
    const edgesTo = graph([
      ['config', 'seed', 'f', 'INFERRED', ['description']],
      ['page', 'config', 'description'],
      ['header', 'config', 'title'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => [d.chunkId, d.hop, d.callers])).toEqual([
      ['config', 1, ['description']],
      ['page', 2, []],
    ]);
  });

  it('counts steps by method: past a method reaching the call in its chunk, a lower bound', () => {
    const rows: SymbolEdge[] = [
      {
        from_chunk_id: 'form',
        to_chunk_id: 'seed',
        relation_type: 'calls',
        symbol_name: 'f',
        from_symbols: ['submit'],
        reach_symbols: ['wizard'],
      },
      { from_chunk_id: 'page', to_chunk_id: 'form', relation_type: 'calls', symbol_name: 'submit' },
      { from_chunk_id: 'view', to_chunk_id: 'form', relation_type: 'calls', symbol_name: 'wizard' },
      { from_chunk_id: 'app', to_chunk_id: 'view', relation_type: 'calls', symbol_name: 'render' },
    ];
    const edgesTo = (id: string) => rows.filter((e) => e.to_chunk_id === id);
    const { dependents } = collectDependents({ ...base, depth: 3, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => [d.chunkId, d.hop, d.step, d.exact])).toEqual([
      ['form', 1, 1, true],
      ['page', 2, 2, true],
      ['view', 2, 3, false],
      ['app', 3, 4, false],
    ]);
  });

  it('keeps a later exact path over a nearer lower bound of the same step', () => {
    const rows: SymbolEdge[] = [
      {
        from_chunk_id: 'form',
        to_chunk_id: 'seed',
        relation_type: 'calls',
        symbol_name: 'f',
        from_symbols: ['submit'],
        reach_symbols: ['wizard'],
      },
      { from_chunk_id: 'helper', to_chunk_id: 'seed', relation_type: 'calls', symbol_name: 'f' },
      { from_chunk_id: 'mid', to_chunk_id: 'helper', relation_type: 'calls', symbol_name: 'g' },
      // `view` calls `wizard` (at least 3 steps) and `mid` (exactly 3).
      { from_chunk_id: 'view', to_chunk_id: 'form', relation_type: 'calls', symbol_name: 'wizard' },
      { from_chunk_id: 'view', to_chunk_id: 'mid', relation_type: 'calls', symbol_name: 'h' },
    ];
    const edgesTo = (id: string) => rows.filter((e) => e.to_chunk_id === id);
    const { dependents } = collectDependents({ ...base, depth: 3, seeds: ['seed'], edgesTo });
    const view = dependents.find((d) => d.chunkId === 'view')!;
    expect([view.hop, view.step, view.exact]).toEqual([2, 3, true]);
  });

  it('follows a chunk again when a later hop reaches another of its methods', () => {
    const edgesTo = graph([
      ['config', 'seed', 'f', 'INFERRED', ['description']],
      ['helper', 'seed', 'f', 'INFERRED', ['run']],
      ['config', 'helper', 'run', 'INFERRED', ['title']],
      ['header', 'config', 'title'],
    ]);
    const { dependents } = collectDependents({ ...base, depth: 3, seeds: ['seed'], edgesTo });
    expect(dependents.map((d) => d.chunkId)).toEqual(['config', 'helper', 'header']);
  });

  it('keeps a common name when the edge names its target', () => {
    const edgesTo = graph([
      ['a', 'seed', 'create', 'EXTRACTED'],
      ['b', 'seed', 'create', 'INFERRED'],
    ]);
    const { dependents, viaCommonNames } = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isCommonName: (n) => n === 'create',
    });
    expect(dependents.map((d) => [d.chunkId, d.certain])).toEqual([['a', true]]);
    expect(viaCommonNames).toEqual([{ symbol: 'create', chunkIds: ['b'] }]);
  });

  it('collects every name a dependent uses from the previous level', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['a', 'seed', 'g'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(dependents[0]?.symbols).toEqual(['f', 'g']);
  });

  it('never reports a seed, even when seeds call each other', () => {
    const edgesTo = graph([
      ['s2', 's1', 'f'],
      ['a', 's2', 'g'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['s1', 's2'], edgesTo });
    expect(dependents.map((d) => d.chunkId)).toEqual(['a']);
  });

  it('filters the first hop by symbol only', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['x', 'seed', 'other'],
      ['b', 'a', 'unrelated'],
    ]);
    const { dependents } = collectDependents({ ...base, seeds: ['seed'], edgesTo, symbol: 'f' });
    expect(dependents.map((d) => d.chunkId)).toEqual(['a', 'b']);
  });

  it('keeps a dependent that a certain link also reaches', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f', 'AMBIGUOUS'],
      ['b', 'a', 'g', 'INFERRED'],
      ['c', 'seed', 'f', 'AMBIGUOUS'],
      ['c', 'seed', 'h', 'EXTRACTED'],
    ]);
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(res.dependents.map((d) => [d.chunkId, d.certain])).toEqual([['c', true]]);
    expect(res.viaAmbiguousNames).toEqual([{ symbol: 'f', chunkIds: ['a'] }]);
  });

  it('follows a hub through the methods it is reached by, after the rest of its hop', () => {
    const edgesTo = graph([
      ['hub', 'seed', 'f', 'EXTRACTED', ['write']],
      ['plain', 'seed', 'f', 'EXTRACTED', ['run']],
      ['behindHub', 'hub', 'write'],
      ['behindHub2', 'hub', 'write'],
      ['behindPlain', 'plain', 'run'],
    ]);
    const all = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isHub: (id) => id === 'hub',
    });
    expect(all.dependents.map((d) => d.chunkId).sort()).toEqual([
      'behindHub',
      'behindHub2',
      'behindPlain',
      'hub',
      'plain',
    ]);
    // Out of places: what lies behind the hub goes first.
    const tight = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      maxDependents: 3,
      isHub: (id) => id === 'hub',
    });
    expect(tight.dependents.map((d) => d.chunkId).sort()).toEqual(['behindPlain', 'hub', 'plain']);
  });

  it('lists hubs reached as a whole chunk, and leaves, without following their callers', () => {
    const edgesTo = graph([
      ['hub', 'seed', 'f'],
      ['test', 'seed', 'f'],
      ['behindHub', 'hub', 'g'],
      ['behindTest', 'test', 'g'],
    ]);
    const { dependents } = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isHub: (id) => id === 'hub',
      isLeaf: (id) => id === 'test',
    });
    expect(dependents.map((d) => [d.chunkId, d.hub])).toEqual([
      ['hub', true],
      ['test', false],
    ]);
  });

  it('stops at maxDependents and says so', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['b', 'seed', 'f'],
      ['c', 'seed', 'f'],
    ]);
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo, maxDependents: 2 });
    expect(res.dependents).toHaveLength(2);
    expect(res.truncated).toBe(true);
  });

  it('keeps a cap of its own for tests, so they do not take the places of code', () => {
    const edgesTo = graph([
      ['test1', 'seed', 'f'],
      ['test2', 'seed', 'f'],
      ['test3', 'seed', 'f'],
      ['a', 'seed', 'f'],
      ['b', 'a', 'g'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      maxDependents: 2,
      isLeaf: (id) => id.startsWith('test'),
    });
    expect(res.dependents.map((d) => d.chunkId).sort()).toEqual(['a', 'b', 'test1', 'test2']);
    expect(res.truncated).toBe(false);
    expect(res.testsTruncated).toBe(true);
  });

  it('sets aside callers linked only through a common name, and does not follow them', () => {
    const edgesTo = graph([
      ['real', 'seed', 'enqueue'],
      ['setUser', 'seed', 'add'],
      ['setUser2', 'seed', 'add'],
      ['both', 'seed', 'add'],
      ['both', 'real', 'run'],
      ['behindSetUser', 'setUser', 'build'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isCommonName: (s) => s === 'add',
    });
    expect(res.dependents.map((d) => [d.chunkId, d.hop])).toEqual([
      ['real', 1],
      ['both', 2],
    ]);
    // `both` is reached through a real link too, so it is a dependent, not a coincidence.
    expect(res.viaCommonNames).toEqual([{ symbol: 'add', chunkIds: ['setUser', 'setUser2'] }]);
    expect(res.dependents.some((d) => d.chunkId === 'behindSetUser')).toBe(false);
  });

  it('keeps a common-name caller the file link confirms, as uncertain', () => {
    const edgesTo = graph([
      ['queueUser', 'seed', 'add'],
      ['setUser', 'seed', 'add'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      isCommonName: (s) => s === 'add',
      confirmsLink: (caller) => caller === 'queueUser',
    });
    expect(res.dependents.map((d) => [d.chunkId, d.certain])).toEqual([['queueUser', false]]);
    expect(res.viaCommonNames).toEqual([{ symbol: 'add', chunkIds: ['setUser'] }]);
  });

  it('does not count common-name callers as deeper work', () => {
    const edgesTo = graph([
      ['a', 'seed', 'enqueue'],
      ['x', 'a', 'get'],
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo,
      depth: 1,
      isCommonName: (s) => s === 'get',
    });
    expect(res.deeper).toBe(false);
  });

  it('reports callers left beyond depth', () => {
    const edgesTo = graph([
      ['a', 'seed', 'f'],
      ['b', 'a', 'g'],
    ]);
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo, depth: 1 });
    expect(res.dependents.map((d) => d.chunkId)).toEqual(['a']);
    expect(res.deeper).toBe(true);
    expect(res.truncated).toBe(false);
  });
  it('lists a barrel file that re-exports the change, without following its other names', () => {
    // lib.ts re-exports `toName` and defines `version` in the same chunk; `cli` only uses `version`.
    const { edges } = buildSymbolEdges([
      { chunk_id: 'g//p//names.ts//0-9//a', defines_symbols: ['toName'], uses_symbols: [] },
      {
        chunk_id: 'g//p//lib.ts//0-9//b',
        defines_symbols: ['version'],
        uses_symbols: ['toName'],
        use_sites: [{ name: 'toName', from: 'toName', reexport: true }],
      },
      {
        chunk_id: 'g//p//cli.ts//0-9//c',
        defines_symbols: [],
        uses_symbols: ['version'],
        use_sites: [{ name: 'version', from: '' }],
      },
    ]);
    const res = collectDependents({
      ...base,
      seeds: ['g//p//names.ts//0-9//a'],
      edgesTo: (id) => edges.filter((e) => e.to_chunk_id === id),
    });
    expect(res.dependents.map((d) => [d.chunkId, d.symbols, d.reexport])).toEqual([
      ['g//p//lib.ts//0-9//b', ['toName'], true],
    ]);
    expect(edges.find((x) => x.symbol_name === 'toName')?.relation_type).toBe('reexports');
  });
  it('follows the methods that reach the call through the chunk’s own calls', () => {
    // `service` calls the seed from a private helper that only its `call` uses.
    const edgesTo = graph([
      ['service', 'seed', 'signature_valid?', 'INFERRED', ['ledger_entry']],
      ['mutation', 'service', 'call'],
    ]);
    const plain = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(plain.dependents.map((d) => d.chunkId)).toEqual(['service']);

    const withReach = (id: string) =>
      edgesTo(id).map((e) =>
        e.from_chunk_id === 'service' ? { ...e, reach_symbols: ['call'] } : e
      );
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo: withReach });
    expect(res.dependents.map((d) => [d.chunkId, d.hop, d.callers])).toEqual([
      ['service', 1, ['ledger_entry']],
      ['mutation', 2, []],
    ]);
  });

  it('sets aside links through a name defined in several places', () => {
    const edgesTo = graph([
      ['other', 'seed', 'f', 'AMBIGUOUS'],
      ['service', 'seed', 'g', 'EXTRACTED'],
      ['resolver', 'service', 'h', 'EXTRACTED'],
      ['far', 'service', 'preview', 'AMBIGUOUS'],
    ]);
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(res.dependents.map((d) => [d.chunkId, d.certain])).toEqual([
      ['service', true],
      ['resolver', true],
    ]);
    expect(res.viaAmbiguousNames).toEqual([
      { symbol: 'f', chunkIds: ['other'] },
      { symbol: 'preview', chunkIds: ['far'] },
    ]);
  });

  it('passes a method change on to code holding its class as a value only when the class is the change', () => {
    const rows: SymbolEdge[] = [
      {
        from_chunk_id: 'consumer',
        to_chunk_id: 'seed',
        relation_type: 'calls',
        symbol_name: 'f',
        from_symbols: ['refund'],
      },
      {
        from_chunk_id: 'poll',
        to_chunk_id: 'consumer',
        relation_type: 'references',
        symbol_name: 'Worker',
      },
      {
        from_chunk_id: 'caller',
        to_chunk_id: 'consumer',
        relation_type: 'calls',
        symbol_name: 'Worker',
      },
    ];
    const edgesTo = (id: string) => rows.filter((e) => e.to_chunk_id === id);
    // `refund` changed: `poll` holds the class, it calls no `refund`.
    const res = collectDependents({ ...base, seeds: ['seed'], edgesTo });
    expect(res.dependents.map((d) => d.chunkId)).toEqual(['consumer']);
    // The class itself is the change: whoever holds or names it depends on it.
    const whole = collectDependents({ ...base, seeds: ['consumer'], edgesTo });
    expect(whole.dependents.map((d) => d.chunkId).sort()).toEqual(['caller', 'poll']);
  });

  it("follows a template method's callers on self only from the class whose override changed", () => {
    // `Base#summary` calls `title` on self; `Sub` overrides `title` (the change).
    const rows: SymbolEdge[] = [
      {
        from_chunk_id: 'base',
        to_chunk_id: 'sub',
        relation_type: 'overrides',
        symbol_name: 'title',
        from_symbols: ['summary'],
      },
      {
        from_chunk_id: 'sibling',
        to_chunk_id: 'base',
        relation_type: 'calls',
        symbol_name: 'summary',
        from_symbols: ['card'],
      },
      {
        from_chunk_id: 'sub_card',
        to_chunk_id: 'base',
        relation_type: 'calls',
        symbol_name: 'summary',
        from_symbols: ['card'],
      },
      {
        from_chunk_id: 'base_list',
        to_chunk_id: 'base',
        relation_type: 'calls',
        symbol_name: 'summary',
        from_symbols: ['list'],
      },
      {
        from_chunk_id: 'mailer',
        to_chunk_id: 'base',
        relation_type: 'calls',
        symbol_name: 'summary',
        from_symbols: ['send_digest'],
      },
      {
        from_chunk_id: 'far',
        to_chunk_id: 'base_list',
        relation_type: 'calls',
        symbol_name: 'list',
        from_symbols: ['index'],
      },
    ];
    const selfFrom: Record<string, string | null> = {
      sibling: 'Feeds::Other',
      sub_card: 'Feeds::Sub',
      base_list: 'Feeds::Base',
      mailer: null,
      far: 'Feeds::Other',
    };
    const res = collectDependents({
      ...base,
      seeds: ['sub'],
      edgesTo: (id) => rows.filter((e) => e.to_chunk_id === id),
      ownerOf: (id) => ({ sub: 'Feeds::Sub', base: 'Feeds::Base', base_list: 'Feeds::Base' })[id],
      selfCallFrom: (edge) => selfFrom[edge.from_chunk_id],
    });
    // `Feeds::Other` inherits `summary` too, but its objects never run `Sub#title`;
    // a call on an object of unknown class (`mailer`) may be on a `Sub`.
    expect(res.dependents.map((d) => d.chunkId).sort()).toEqual([
      'base',
      'base_list',
      'mailer',
      'sub_card',
    ]);
  });

  it('does not follow a file opening the namespace a dependent defines', () => {
    const rows: SymbolEdge[] = [
      {
        from_chunk_id: 'registry',
        to_chunk_id: 'seed',
        relation_type: 'references',
        symbol_name: 'PlainParser',
      },
      {
        from_chunk_id: 'other_parser',
        to_chunk_id: 'registry',
        relation_type: 'opens',
        symbol_name: 'Parsers',
      },
    ];
    const res = collectDependents({
      ...base,
      seeds: ['seed'],
      edgesTo: (id) => rows.filter((e) => e.to_chunk_id === id),
    });
    expect(res.dependents.map((d) => d.chunkId)).toEqual(['registry']);
    expect(res.deeper).toBe(false);
  });
});

describe('definitionLine', () => {
  it('finds the line a method is defined on', () => {
    const ruby = [
      'class Prepare',
      '  def call',
      '    run',
      '  end',
      '',
      '  def self.build(x)',
      '  end',
      '  def ready?',
      '  end',
    ].join('\n');
    expect(definitionLine(ruby, 10, 'call', 'app/prepare.rb')).toBe(11);
    expect(definitionLine(ruby, 10, 'build', 'app/prepare.rb')).toBe(15);
    expect(definitionLine(ruby, 10, 'ready?', 'app/prepare.rb')).toBe(17);
    // A bare call at the start of a line is not a definition in Ruby.
    expect(definitionLine(ruby, 10, 'run', 'app/prepare.rb')).toBeNull();

    const ts = [
      'export class Store {',
      '  private readonly items = new Map();',
      '  async save(item: Item): Promise<void> {',
      '    this.items.set(item.id, item);',
      '  }',
      '}',
      'export function load() {}',
      'export const parse = (s: string) => s;',
    ].join('\n');
    expect(definitionLine(ts, 0, 'save', 'src/store.ts')).toBe(2);
    expect(definitionLine(ts, 0, 'load', 'src/store.ts')).toBe(6);
    expect(definitionLine(ts, 0, 'parse', 'src/store.ts')).toBe(7);
    expect(definitionLine(ts, 0, 'missing', 'src/store.ts')).toBeNull();
    expect(definitionLine('def handle(event):\n    pass', 3, 'handle', 'a.py')).toBe(3);
    expect(definitionLine('func (s *Server) Start() error {', 0, 'Start', 'a.go')).toBe(0);
  });
});
