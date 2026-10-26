// paparats module map — vanilla, no build step.
// Loads /api/module-map, lays the modules out with a small force simulation and
// draws them as SVG. Every piece of data reaches the DOM through textContent or
// setAttribute — never innerHTML.

(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Links per module drawn in the overview; a selected module shows all of its own. */
  const OVERVIEW_LINKS = 2;
  /** A label is drawn once its circle is at least this many pixels across on screen. */
  const LABEL_MIN_DIAMETER = 26;
  const $ = (sel) => document.querySelector(sel);

  const state = {
    data: null,
    nodes: [],
    edges: [],
    selected: null,
    query: '',
    view: { x: 0, y: 0, k: 1 },
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    return node;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** Folder names that say nothing on their own; the label then keeps their parent too. */
  const GENERIC_FOLDERS = new Set([
    'src',
    'lib',
    'app',
    'source',
    'sources',
    'main',
    'internal',
    'pkg',
  ]);

  /** "packages/server/src (indexer.ts)" → "server/src (indexer)"; "app/services/companies" → "companies". */
  function shortLabel(name) {
    const m = name.match(/^(.*?)(?: \((.+)\))?$/);
    const folder = (m && m[1]) || name;
    const parts = folder.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || folder;
    const shown = GENERIC_FOLDERS.has(last) && parts.length > 1 ? parts.slice(-2).join('/') : last;
    const file = m && m[2] ? m[2].replace(/\.[^.]+$/, '') : '';
    return file ? `${shown} (${file})` : shown;
  }

  function setBanner(msg) {
    const b = $('#banner');
    b.textContent = msg || '';
    b.classList.toggle('banner--hidden', !msg);
  }

  function readParams() {
    const p = new URLSearchParams(window.location.search);
    return {
      group: p.get('group') || '',
      project: p.get('project') || '',
      module: p.get('module'),
    };
  }

  function writeParams() {
    const p = new URLSearchParams();
    if (state.data && state.data.group) p.set('group', state.data.group);
    if (state.data && state.data.project) p.set('project', state.data.project);
    if (state.selected !== null) p.set('module', String(state.selected + 1));
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  /**
   * Force-directed layout: every pair repels, linked modules attract, a weak
   * pull keeps everything near the centre. Seeded on a sunflower spiral in
   * module order (largest first), so the same map always lands the same way.
   */
  function layout(nodes, edges) {
    nodes.forEach((d, i) => {
      const angle = i * 2.399963;
      const radius = 30 * Math.sqrt(i);
      d.x = Math.cos(angle) * radius;
      d.y = Math.sin(angle) * radius;
    });
    const index = new Map(nodes.map((d, i) => [d.id, i]));
    // A module with no drawn link is pulled in harder, or repulsion alone
    // would push it to the edge and shrink everything else to fit.
    const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
    const pull = nodes.map((d) => (linked.has(d.id) ? 0.35 : 1.2));
    // Fruchterman–Reingold: repulsion k²/d, attraction d²/k along links, plus a
    // pull to the centre so unlinked modules stay on screen.
    const k = 110;
    const steps = 500;
    for (let step = 0; step < steps; step++) {
      const temperature = 2 + 40 * (1 - step / steps);
      const fx = new Float64Array(nodes.length);
      const fy = new Float64Array(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 0.01) {
            dx = 0.01 * (i - j);
            dy = 0.01;
            dist = 0.014;
          }
          const room = a.r + b.r + 70;
          let force = (k * k) / dist;
          if (dist < room) force += (room - dist) * 6;
          fx[i] += (dx / dist) * force;
          fy[i] += (dy / dist) * force;
          fx[j] -= (dx / dist) * force;
          fy[j] -= (dy / dist) * force;
        }
      }
      for (const e of edges) {
        const ia = index.get(e.from);
        const ib = index.get(e.to);
        const a = nodes[ia];
        const b = nodes[ib];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.hypot(dx, dy), 0.01);
        const force = ((dist * dist) / k) * (0.3 + 0.7 * e.strength) * 0.25;
        fx[ia] += (dx / dist) * force;
        fy[ia] += (dy / dist) * force;
        fx[ib] -= (dx / dist) * force;
        fy[ib] -= (dy / dist) * force;
      }
      nodes.forEach((d, i) => {
        fx[i] -= d.x * pull[i];
        fy[i] -= d.y * pull[i];
        const len = Math.hypot(fx[i], fy[i]);
        if (len === 0) return;
        const move = Math.min(len, temperature);
        d.x += (fx[i] / len) * move;
        d.y += (fy[i] / len) * move;
      });
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  function applyView() {
    const v = state.view;
    $('#mapViewport').setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`);
    for (const d of state.nodes) {
      if (d.el) d.el.classList.toggle('is-small', 2 * d.r * v.k < LABEL_MIN_DIAMETER);
    }
  }

  function fitView() {
    const box = $('#mapSvg').getBoundingClientRect();
    if (state.nodes.length === 0 || box.width === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of state.nodes) {
      minX = Math.min(minX, d.x - d.r - 70);
      maxX = Math.max(maxX, d.x + d.r + 70);
      minY = Math.min(minY, d.y - d.r - 20);
      maxY = Math.max(maxY, d.y + d.r + 34);
    }
    const k = Math.min(box.width / (maxX - minX), box.height / (maxY - minY), 1.15);
    state.view = {
      k,
      x: box.width / 2 - ((minX + maxX) / 2) * k,
      y: box.height / 2 - ((minY + maxY) / 2) * k,
    };
    applyView();
  }

  /** Path from the rim of `a` to the rim of `b`, bent a little so A→B and B→A do not overlap. */
  function edgePath(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(Math.hypot(dx, dy), 0.01);
    const ux = dx / dist;
    const uy = dy / dist;
    const bend = Math.min(26, dist * 0.12);
    const sx = a.x + ux * a.r;
    const sy = a.y + uy * a.r;
    const ex = b.x - ux * (b.r + 3);
    const ey = b.y - uy * (b.r + 3);
    const cx = (sx + ex) / 2 - uy * bend;
    const cy = (sy + ey) / 2 + ux * bend;
    return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  }

  function draw() {
    const nodesG = $('#mapNodes');
    const edgesG = $('#mapEdges');
    nodesG.replaceChildren();
    edgesG.replaceChildren();
    const byId = new Map(state.nodes.map((d) => [d.id, d]));

    for (const e of state.edges) {
      const path = svg('path', {
        d: edgePath(byId.get(e.from), byId.get(e.to)),
        class: 'map-edge',
        'stroke-width': (0.8 + 2.2 * e.strength).toFixed(2),
        'data-rank': e.rank,
        'marker-end': 'url(#arrow)',
      });
      e.el = path;
      edgesG.appendChild(path);
    }

    for (const d of state.nodes) {
      const g = svg('g', {
        class: 'map-node',
        transform: `translate(${d.x} ${d.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${d.module.name}, ${plural(d.module.fileCount, 'file', 'files')}`,
      });
      const title = svg('title');
      title.textContent = `${d.module.id + 1}. ${d.module.name} — ${plural(d.module.fileCount, 'file', 'files')}`;
      g.appendChild(title);
      g.appendChild(svg('circle', { r: d.r, class: 'map-node__circle' }));
      if (d.r >= 16) {
        const count = svg('text', {
          class: 'map-node__count',
          'text-anchor': 'middle',
          dy: '0.35em',
        });
        count.textContent = String(d.module.fileCount);
        g.appendChild(count);
      }
      const label = svg('text', { class: 'map-node__label', 'text-anchor': 'middle', y: d.r + 15 });
      label.textContent = shortLabel(d.module.name);
      g.appendChild(label);
      g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(d.id);
      });
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          select(d.id);
        }
      });
      d.el = g;
      nodesG.appendChild(g);
    }
    highlight();
  }

  /** Dim everything unrelated to the selection or the file search. */
  function highlight() {
    const sel = state.selected;
    const matches = searchMatches();
    const near = new Set();
    if (sel !== null) {
      near.add(sel);
      for (const e of state.edges) {
        if (e.from === sel) near.add(e.to);
        if (e.to === sel) near.add(e.from);
      }
    }
    for (const d of state.nodes) {
      d.el.classList.toggle('is-selected', d.id === sel);
      d.el.classList.toggle('is-near', sel !== null && near.has(d.id));
      d.el.classList.toggle('is-match', matches !== null && matches.has(d.id));
      const faded = (sel !== null && !near.has(d.id)) || (matches !== null && !matches.has(d.id));
      d.el.classList.toggle('is-faded', faded);
    }
    for (const e of state.edges) {
      const out = sel !== null && e.from === sel;
      const inc = sel !== null && e.to === sel;
      e.el.classList.toggle('is-out', out);
      e.el.classList.toggle('is-in', inc);
      e.el.classList.toggle('is-faded', (sel !== null && !out && !inc) || matches !== null);
      e.el.classList.toggle('is-minor', e.rank >= OVERVIEW_LINKS && !out && !inc);
      e.el.setAttribute('marker-end', out ? 'url(#arrowHot)' : 'url(#arrow)');
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /** Module ids with a listed file matching the search, or null when not searching. */
  function searchMatches() {
    const q = state.query.trim().toLowerCase();
    if (!q || !state.data || !state.data.map) return null;
    const ids = new Set();
    for (const m of state.data.map.modules) {
      if (m.files.some((f) => f.toLowerCase().includes(q))) ids.add(m.id);
    }
    return ids;
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  function moduleButton(id) {
    const m = state.data.map.modules[id];
    const b = el('button', 'map-link', `${id + 1}. ${m.name}`);
    b.type = 'button';
    b.addEventListener('click', () => select(id));
    return b;
  }

  function section(title, items, more) {
    const wrap = el('section', 'map-section');
    wrap.appendChild(el('h3', 'map-section__title', title));
    const list = el('ul', 'map-list');
    for (const item of items) {
      const li = el('li');
      if (typeof item === 'string') li.textContent = item;
      else li.appendChild(item);
      list.appendChild(li);
    }
    wrap.appendChild(list);
    if (more) wrap.appendChild(el('p', 'map-more', more));
    return wrap;
  }

  function renderPanel() {
    const body = $('#panelBody');
    body.replaceChildren();
    const map = state.data && state.data.map;
    if (!map || map.modules.length === 0) {
      $('#panelEyebrow').textContent = '002 / details';
      $('#panelTitle').textContent = 'Nothing to show';
      return;
    }

    const matches = searchMatches();
    if (matches !== null && state.selected === null) {
      $('#panelEyebrow').textContent = '002 / search';
      $('#panelTitle').textContent = `“${state.query.trim()}”`;
      const q = state.query.trim().toLowerCase();
      const hits = [];
      for (const m of map.modules) {
        for (const f of m.files) {
          if (f.toLowerCase().includes(q)) {
            const row = el('div', 'map-hit');
            row.appendChild(el('span', 'map-hit__file', f));
            row.appendChild(moduleButton(m.id));
            hits.push(row);
          }
        }
      }
      body.appendChild(
        section(
          hits.length === 0 ? 'No listed file matches' : plural(hits.length, 'file', 'files'),
          hits.slice(0, 40),
          'Only the most-called files of each module are listed; a module shows up to 60.'
        )
      );
      return;
    }

    if (state.selected === null) {
      $('#panelEyebrow').textContent = '002 / overview';
      $('#panelTitle').textContent = 'Pick a module';
      body.appendChild(
        section(
          'Largest modules',
          map.modules.slice(0, 12).map((m) => moduleButton(m.id)),
          map.modules.length > 12 ? `…and ${map.modules.length - 12} more on the map.` : ''
        )
      );
      if (map.shared.length > 0) {
        body.appendChild(
          section(
            'Shared code — called from much of the rest',
            map.shared.map((s) => `${s.file} — ${plural(s.callers, 'caller', 'callers')}`)
          )
        );
      }
      if (map.migrations > 0) {
        body.appendChild(
          el(
            'p',
            'map-more',
            `${plural(map.migrations, 'migration', 'migrations')} left out of the map.`
          )
        );
      }
      return;
    }

    const m = map.modules[state.selected];
    $('#panelEyebrow').textContent =
      `module ${m.id + 1}${state.data.projects.length > 1 ? ` · ${m.project}` : ''}`;
    $('#panelTitle').textContent = m.name;
    body.appendChild(
      el(
        'p',
        'map-stats',
        `${plural(m.fileCount, 'file', 'files')}${m.testCount > 0 ? ` · ${plural(m.testCount, 'test', 'tests')}` : ''}`
      )
    );
    if (m.uses.length > 0)
      body.appendChild(
        section(
          'Uses',
          m.uses.map((l) => moduleButton(l.module))
        )
      );
    if (m.usedBy.length > 0)
      body.appendChild(
        section(
          'Used by',
          m.usedBy.map((l) => moduleButton(l.module))
        )
      );
    body.appendChild(
      section(
        'Main files — most called first',
        m.files,
        m.fileCount > m.files.length ? `…and ${m.fileCount - m.files.length} more` : ''
      )
    );
    if (m.tests.length > 0) {
      body.appendChild(
        section(
          'Tests',
          m.tests,
          m.testCount > m.tests.length ? `…and ${m.testCount - m.tests.length} more` : ''
        )
      );
    }
  }

  function select(id) {
    state.selected = id;
    highlight();
    renderPanel();
    writeParams();
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  function fillSelect(select, values, current, allLabel) {
    select.replaceChildren();
    if (allLabel !== undefined) {
      const opt = el('option', '', allLabel);
      opt.value = '';
      select.appendChild(opt);
    }
    for (const v of values) {
      const opt = el('option', '', v);
      opt.value = v;
      if (v === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  async function load(group, project, moduleNumber) {
    const qs = new URLSearchParams();
    if (group) qs.set('group', group);
    if (project) qs.set('project', project);
    setBanner('');
    $('#mapChip').textContent = 'loading';
    let data;
    try {
      const res = await fetch(`/api/module-map?${qs}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      data = await res.json();
      if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
    } catch (err) {
      $('#mapChip').textContent = 'error';
      setBanner(`Could not load the module map: ${err.message}`);
      return;
    }

    state.data = data;
    fillSelect($('#groupSelect'), data.groups, data.group);
    fillSelect($('#projectSelect'), data.projects, data.project || '', 'all projects');

    const map = data.map;
    const empty = $('#mapEmpty');
    if (!map || map.modules.length === 0) {
      state.nodes = [];
      state.edges = [];
      state.selected = null;
      $('#mapChip').textContent = '0 modules';
      empty.hidden = false;
      empty.textContent = data.group
        ? 'No modules here: the symbol graph has no links between files yet. Index the project, or check that its language has AST support.'
        : 'No groups indexed yet.';
      draw();
      renderPanel();
      return;
    }
    empty.hidden = true;

    const fileCount = map.modules.reduce((n, m) => n + m.fileCount, 0);
    $('#mapChip').textContent =
      `${plural(map.modules.length, 'module', 'modules')} · ${plural(fileCount, 'file', 'files')}`;

    const maxFiles = Math.max(...map.modules.map((m) => m.fileCount));
    state.nodes = map.modules.map((m) => ({
      id: m.id,
      module: m,
      r: 8 + 30 * Math.sqrt(m.fileCount / maxFiles),
    }));
    const maxWeight = Math.max(1, ...map.modules.flatMap((m) => m.uses.map((l) => l.weight)));
    state.edges = map.modules.flatMap((m) =>
      m.uses.map((l, rank) => ({
        from: m.id,
        to: l.module,
        rank,
        strength: Math.log1p(l.weight) / Math.log1p(maxWeight),
      }))
    );
    layout(state.nodes, state.edges);
    const wanted = moduleNumber ? Number(moduleNumber) - 1 : null;
    state.selected = wanted !== null && map.modules[wanted] ? wanted : null;
    draw();
    fitView();
    applyView();
    renderPanel();
    writeParams();
  }

  // ── Pan and zoom ─────────────────────────────────────────────────────────

  function wirePanZoom() {
    const svgEl = $('#mapSvg');
    let drag = null;
    svgEl.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest && ev.target.closest('.map-node')) return;
      drag = { x: ev.clientX, y: ev.clientY, vx: state.view.x, vy: state.view.y, moved: false };
      svgEl.setPointerCapture(ev.pointerId);
    });
    svgEl.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.view.x = drag.vx + dx;
      state.view.y = drag.vy + dy;
      applyView();
    });
    svgEl.addEventListener('pointerup', () => {
      if (drag && !drag.moved && state.selected !== null) select(null);
      drag = null;
    });
    svgEl.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const box = svgEl.getBoundingClientRect();
        const px = ev.clientX - box.left;
        const py = ev.clientY - box.top;
        const v = state.view;
        const k = Math.min(6, Math.max(0.15, v.k * Math.exp(-ev.deltaY * 0.0015)));
        v.x = px - ((px - v.x) * k) / v.k;
        v.y = py - ((py - v.y) * k) / v.k;
        v.k = k;
        applyView();
      },
      { passive: false }
    );
  }

  // ── Start ────────────────────────────────────────────────────────────────

  function start() {
    wirePanZoom();
    $('#groupSelect').addEventListener('change', (ev) => load(ev.target.value, '', null));
    $('#projectSelect').addEventListener('change', (ev) =>
      load(state.data ? state.data.group : '', ev.target.value, null)
    );
    $('#fileSearch').addEventListener('input', (ev) => {
      state.query = ev.target.value;
      if (state.query.trim()) state.selected = null;
      highlight();
      renderPanel();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.selected !== null) select(null);
    });
    window.addEventListener('resize', fitView);
    const p = readParams();
    load(p.group, p.project, p.module);
  }

  start();
})();
