import { describe, it, expect } from 'vitest';
import { buildModuleMap, type MapEdge } from '../src/module-map.js';
import {
  EXPLORER_MAX_CHILDREN,
  MORE_KEY,
  fileView,
  folderView,
  searchFiles,
} from '../src/map-explorer.js';

const e = (from: string, to: string, symbol: string, project = 'p'): MapEdge => ({
  from_chunk_id: `g//${project}//${from}//0-5//h`,
  to_chunk_id: `g//${project}//${to}//0-5//h`,
  symbol_name: symbol,
});

describe('folderView', () => {
  it('names outside folders one level below where their path leaves the current one', () => {
    const map = buildModuleMap(
      [
        e('app/services/billing/charge.ts', 'app/models/invoice.ts', 'invoiceTotal'),
        e('app/services/billing/charge.ts', 'lib/money.ts', 'formatMoney'),
        e('app/controllers/pay.ts', 'app/services/billing/charge.ts', 'chargeCard'),
      ],
      []
    );
    // `app/services` holds only `billing`, so the view opens that folder.
    const view = folderView(map, 'p', 'app/services');
    expect(view.path).toBe('app/services/billing');
    expect(view.nodes.map((n) => [n.key, n.kind])).toEqual([
      ['app/services/billing/charge.ts', 'file'],
    ]);
    expect(view.outside.map((n) => n.key).sort()).toEqual(['app/controllers', 'app/models', 'lib']);
    expect(view.outsideLinks).toContainEqual({
      from: 'app/controllers',
      to: 'app/services/billing/charge.ts',
      weight: 1,
    });
  });

  it('folds the least called children into one node and lists them', () => {
    const edges: MapEdge[] = [];
    const n = EXPLORER_MAX_CHILDREN + 5;
    for (let i = 0; i < n; i++) {
      // File i is called i + 1 times, each through its own name.
      for (let j = 0; j <= i; j++)
        edges.push(e(`caller${i}_${j}.ts`, `src/f${i}.ts`, `use${i}_${j}`));
    }
    const view = folderView(buildModuleMap(edges, []), 'p', 'src');
    expect(view.nodes).toHaveLength(EXPLORER_MAX_CHILDREN + 1);
    expect(view.nodes[0]!.key).toBe(`src/f${n - 1}`.concat('.ts'));
    expect(view.nodes.at(-1)).toMatchObject({ key: MORE_KEY, kind: 'more', files: 5 });
    expect(view.more).toEqual(['src/f4.ts', 'src/f3.ts', 'src/f2.ts', 'src/f1.ts', 'src/f0.ts']);
  });

  it('shows another project of the group as one outside node', () => {
    const map = buildModuleMap([e('a.ts', 'b.ts', 'bCall'), e('x.ts', 'y.ts', 'yCall', 'q')], []);
    expect(folderView(map, null, '').nodes.map((n) => n.key)).toEqual(['p', 'q']);
    expect(fileView(map, 'q', 'x.ts')?.calls).toEqual([{ project: 'q', file: 'y.ts', weight: 1 }]);
    expect(fileView(map, 'q', 'nope.ts')).toBeNull();
    expect(searchFiles(map, 'Y.TS')).toEqual([{ project: 'q', file: 'y.ts' }]);
  });
});
