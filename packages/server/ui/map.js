// paparats code map — vanilla, no build step.
// A project's code as its folder tree: each level shows its folders and files
// with the calls between them, and the folders elsewhere they call or are
// called from on a ring around them. Click a folder to go into it, a file to
// see what it calls; every view has its own URL, so back, forward, reload and
// "open in a new tab" all work. Data reaches the DOM through textContent or
// setAttribute — never innerHTML.

(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Links per node drawn while nothing is hovered or selected. */
  const LINKS_PER_NODE = 3;
  /**
   * Label size in map units: labels zoom with the map, so the layout, which
   * leaves room for them, keeps them apart at any zoom. Zoomed in they stop
   * growing at LABEL_MAX_PX on screen; below LABEL_MIN_PX they are hidden
   * until hovered.
   */
  const LABEL_SIZE = 13;
  const OUTSIDE_LABEL_SIZE = 12;
  const LABEL_MAX_PX = 17;
  const LABEL_MIN_PX = 6.5;
  /** Key of the node holding what is not drawn (the server's MORE_KEY). */
  const MORE = '…';
  const $ = (sel) => document.querySelector(sel);

  const state = {
    params: {},
    meta: null,
    view: null,
    fileInfo: null,
    nodes: [],
    edges: [],
    hovered: null,
    zoom: { x: 0, y: 0, k: 1 },
  };
  const cache = new Map();

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

  const plural = (n, one, many) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  function setBanner(msg) {
    const b = $('#banner');
    b.textContent = msg || '';
    b.classList.toggle('banner--hidden', !msg);
  }

  async function getJson(url) {
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
    cache.set(url, data);
    return data;
  }

  // ── URLs: every view is a link ───────────────────────────────────────────

  const PARAM_KEYS = ['group', 'project', 'path', 'module', 'file'];

  function readParams() {
    const p = new URLSearchParams(window.location.search);
    const out = {};
    for (const k of PARAM_KEYS) if (p.get(k)) out[k] = p.get(k);
    return out;
  }

  function hrefFor(params) {
    const p = new URLSearchParams();
    for (const k of PARAM_KEYS) if (params[k]) p.set(k, params[k]);
    const qs = p.toString();
    return qs ? `?${qs}` : window.location.pathname;
  }

  function go(params, replace) {
    const href = hrefFor(params);
    if (replace) window.history.replaceState(null, '', href);
    else window.history.pushState(null, '', href);
    render();
  }

  /** A plain click navigates in place; a modified or middle click opens a tab as usual. */
  function wireLink(a, params) {
    a.setAttribute('href', hrefFor(params));
    a.addEventListener('click', (ev) => {
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      go(params);
    });
    return a;
  }

  function link(text, params, cls) {
    return wireLink(el('a', cls || 'map-link', text), params);
  }

  const base = () => ({ group: state.params.group });
  const folderParams = (project, path) => ({ ...base(), project, path: path || undefined });
  const fileParams = (project, file) => ({
    ...base(),
    project,
    path: dirname(file) || undefined,
    file,
  });
  const moduleParams = (id) => ({ ...base(), module: String(id) });

  // ── Layout ───────────────────────────────────────────────────────────────

  /** Rough label width in layout units, so the layout leaves room for it. */
  const labelWidth = (d) => Math.min(260, d.label.length * 7.6);

  /**
   * Force layout of the inner nodes (repulsion, links pull, a pull to the
   * centre), seeded on a sunflower spiral in node order so a view always lands
   * the same way. Outside nodes then go on a ring, each near the nodes it is
   * linked to.
   */
  function layout(inner, outer, edges) {
    const box = $('#mapSvg').getBoundingClientRect();
    // Wider than tall: pull less sideways, so the map fills the stage.
    const aspect = box.height > 0 ? Math.min(2.2, Math.max(1, box.width / box.height)) : 1;
    inner.forEach((d, i) => {
      const angle = i * 2.399963;
      const radius = 60 * Math.sqrt(i);
      d.x = Math.cos(angle) * radius;
      d.y = Math.sin(angle) * radius;
    });
    const index = new Map(inner.map((d, i) => [d.key, i]));
    const innerEdges = edges.filter((e) => index.has(e.from) && index.has(e.to));
    const k = 60;
    const steps = 420;
    for (let step = 0; step < steps; step++) {
      const temperature = 3 + 50 * (1 - step / steps);
      const fx = new Float64Array(inner.length);
      const fy = new Float64Array(inner.length);
      for (let i = 0; i < inner.length; i++) {
        for (let j = i + 1; j < inner.length; j++) {
          const a = inner[i];
          const b = inner[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy);
          if (dist < 0.01) {
            dx = 0.01 * (i - j);
            dy = 0.01;
            dist = 0.014;
          }
          const room =
            Math.max(a.r + b.r + 34, (labelWidth(a) + labelWidth(b)) / 2 + 16) *
            (Math.abs(dy) > Math.abs(dx) ? 0.75 : 1);
          let force = (k * k) / dist;
          if (dist < room) force += (room - dist) * 8;
          fx[i] += (dx / dist) * force;
          fy[i] += (dy / dist) * force;
          fx[j] -= (dx / dist) * force;
          fy[j] -= (dy / dist) * force;
        }
      }
      for (const e of innerEdges) {
        const ia = index.get(e.from);
        const ib = index.get(e.to);
        const a = inner[ia];
        const b = inner[ib];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.hypot(dx, dy), 0.01);
        const force = ((dist * dist) / k) * (0.25 + 0.75 * e.strength) * 0.2;
        fx[ia] += (dx / dist) * force;
        fy[ia] += (dy / dist) * force;
        fx[ib] -= (dx / dist) * force;
        fy[ib] -= (dy / dist) * force;
      }
      inner.forEach((d, i) => {
        fx[i] -= (d.x * 0.9) / aspect;
        fy[i] -= d.y * 0.9;
        const len = Math.hypot(fx[i], fy[i]);
        if (len === 0) return;
        const move = Math.min(len, temperature);
        d.x += (fx[i] / len) * move;
        d.y += (fy[i] / len) * move;
      });
    }

    separate(inner);

    // Centre the inner nodes, then put the outside ones on a ring.
    if (inner.length > 0) {
      const cx = inner.reduce((s, d) => s + d.x, 0) / inner.length;
      const cy = inner.reduce((s, d) => s + d.y, 0) / inner.length;
      for (const d of inner) {
        d.x -= cx;
        d.y -= cy;
      }
    }
    // An ellipse around the inner nodes, as wide as the stage allows.
    const ry = inner.reduce((m, d) => Math.max(m, Math.abs(d.y) + d.r), 0) + 100;
    const rx = Math.max(ry, inner.reduce((m, d) => Math.max(m, Math.abs(d.x) + d.r), 0) + 140);
    state.ring = outer.length > 0 ? { rx, ry } : null;
    const byKey = new Map(inner.map((d) => [d.key, d]));
    const wanted = outer.map((d, i) => {
      let sx = 0;
      let sy = 0;
      for (const e of edges) {
        const other =
          e.from === d.key ? byKey.get(e.to) : e.to === d.key ? byKey.get(e.from) : null;
        if (other) {
          sx += other.x * e.weight;
          sy += other.y * e.weight;
        }
      }
      const angle =
        sx === 0 && sy === 0 ? (i / outer.length) * 2 * Math.PI : Math.atan2(sy / ry, sx / rx);
      return { d, angle };
    });
    wanted.sort((a, b) => a.angle - b.angle);
    const gap = Math.min((2 * Math.PI) / Math.max(outer.length, 1), 0.5);
    for (let i = 1; i < wanted.length; i++) {
      if (wanted[i].angle - wanted[i - 1].angle < gap) wanted[i].angle = wanted[i - 1].angle + gap;
    }
    for (const w of wanted) {
      w.d.x = Math.cos(w.angle) * rx;
      w.d.y = Math.sin(w.angle) * ry;
    }
  }

  /**
   * Push apart nodes whose circle-plus-label boxes overlap, along the axis of
   * least overlap, until none do: every label stays readable.
   */
  function separate(nodes) {
    const box = (d) => ({
      w: Math.max(2 * d.r, labelWidth(d)) + 14,
      top: d.y - d.r - 6,
      bottom: d.y + d.r + 26,
    });
    for (let round = 0; round < 300; round++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const ba = box(a);
          const bb = box(b);
          const ox = (ba.w + bb.w) / 2 - Math.abs(a.x - b.x);
          const oy = Math.min(ba.bottom, bb.bottom) - Math.max(ba.top, bb.top);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox < oy) {
            const push = ox / 2 + 0.5;
            const dir = a.x < b.x || (a.x === b.x && i < j) ? -1 : 1;
            a.x += dir * push;
            b.x -= dir * push;
          } else {
            const push = oy / 2 + 0.5;
            const dir = a.y < b.y || (a.y === b.y && i < j) ? -1 : 1;
            a.y += dir * push;
            b.y -= dir * push;
          }
        }
      }
      if (!moved) break;
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  function applyZoom() {
    const z = state.zoom;
    $('#mapViewport').setAttribute('transform', `translate(${z.x} ${z.y}) scale(${z.k})`);
    for (const d of state.nodes) {
      if (!d.label_el) continue;
      const size = Math.min(d.outside ? OUTSIDE_LABEL_SIZE : LABEL_SIZE, LABEL_MAX_PX / z.k);
      d.label_el.setAttribute('font-size', size.toFixed(2));
      d.label_el.setAttribute('y', (d.r + size + 3).toFixed(2));
      if (d.count_el) d.count_el.setAttribute('font-size', Math.min(11, 13 / z.k).toFixed(2));
      d.el.classList.toggle('is-tiny', size * z.k < LABEL_MIN_PX);
      if (d.count_el) d.count_el.style.display = d.r * z.k < 14 ? 'none' : '';
    }
    for (const e of state.edges) e.el.setAttribute('stroke-width', (e.width / z.k).toFixed(2));
  }

  function fitView() {
    const box = $('#mapSvg').getBoundingClientRect();
    if (state.nodes.length === 0 || box.width === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of state.nodes) {
      const w = Math.max(d.r, labelWidth(d) / 2);
      minX = Math.min(minX, d.x - w);
      maxX = Math.max(maxX, d.x + w);
      minY = Math.min(minY, d.y - d.r);
      maxY = Math.max(maxY, d.y + d.r + 26);
    }
    const pad = 40;
    const k = Math.min(
      (box.width - 2 * pad) / (maxX - minX),
      (box.height - 2 * pad) / (maxY - minY),
      1.6
    );
    state.zoom = {
      k,
      x: box.width / 2 - ((minX + maxX) / 2) * k,
      y: box.height / 2 - ((minY + maxY) / 2) * k,
    };
    applyZoom();
  }

  function zoomBy(factor, px, py) {
    const box = $('#mapSvg').getBoundingClientRect();
    const x = px ?? box.width / 2;
    const y = py ?? box.height / 2;
    const z = state.zoom;
    const k = Math.min(8, Math.max(0.08, z.k * factor));
    z.x = x - ((x - z.x) * k) / z.k;
    z.y = y - ((y - z.y) * k) / z.k;
    z.k = k;
    applyZoom();
  }

  /** Path from the rim of `a` to the rim of `b`, bent a little so A→B and B→A do not overlap. */
  function edgePath(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(Math.hypot(dx, dy), 0.01);
    const ux = dx / dist;
    const uy = dy / dist;
    const bend = Math.min(30, dist * 0.12);
    const sx = a.x + ux * a.r;
    const sy = a.y + uy * a.r;
    const ex = b.x - ux * (b.r + 2);
    const ey = b.y - uy * (b.r + 2);
    const cx = (sx + ex) / 2 - uy * bend;
    const cy = (sy + ey) / 2 + ux * bend;
    return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
  }

  /** Where clicking a node leads. */
  function nodeTarget(d) {
    const v = state.view;
    if (d.kind === 'more') return null;
    if (d.kind === 'module') return moduleParams(d.key.slice(1));
    if (d.kind === 'project') {
      const name = d.key.startsWith('[') ? d.key.slice(1, -1) : d.key;
      return folderParams(name, '');
    }
    if (d.kind === 'file') {
      // Inside a module, a file stays in the module's view.
      if (v.module && !d.outside)
        return { ...moduleParams(v.module.id), project: v.project, file: d.key };
      return fileParams(v.project, d.key);
    }
    return folderParams(v.project, d.key);
  }

  function draw() {
    const nodesG = $('#mapNodes');
    const edgesG = $('#mapEdges');
    const ringG = $('#mapRing');
    nodesG.replaceChildren();
    edgesG.replaceChildren();
    ringG.replaceChildren();
    if (state.ring) {
      ringG.appendChild(
        svg('ellipse', { rx: state.ring.rx, ry: state.ring.ry, class: 'map-ring' })
      );
    }
    const byKey = new Map(state.nodes.map((d) => [d.key, d]));

    for (const e of state.edges) {
      const a = byKey.get(e.from);
      const b = byKey.get(e.to);
      e.el = svg('path', {
        d: edgePath(a, b),
        class: `map-edge${a.outside || b.outside ? ' is-outside' : ''}`,
        'marker-end': 'url(#arrow)',
      });
      edgesG.appendChild(e.el);
    }

    for (const d of state.nodes) {
      const a = svg('a', {
        class: `map-node map-node--${d.kind}${d.outside ? ' is-outside' : ''}`,
        transform: `translate(${d.x} ${d.y})`,
        'aria-label': d.title,
      });
      const target = nodeTarget(d);
      if (target) wireLink(a, target);
      else {
        a.setAttribute('tabindex', '0');
        a.setAttribute('role', 'button');
        a.addEventListener('click', () => renderMore());
      }
      const title = svg('title');
      title.textContent = d.title;
      a.appendChild(title);
      a.appendChild(svg('circle', { r: d.r, class: 'map-node__circle' }));
      if (d.kind !== 'file') {
        d.count_el = svg('text', {
          class: 'map-node__count',
          'text-anchor': 'middle',
          dy: '0.35em',
        });
        d.count_el.textContent = d.files.toLocaleString('en');
        a.appendChild(d.count_el);
      }
      d.label_el = svg('text', { class: 'map-node__label', 'text-anchor': 'middle' });
      d.label_el.textContent = d.label;
      a.appendChild(d.label_el);
      a.addEventListener('pointerenter', () => {
        state.hovered = d.key;
        highlight();
      });
      a.addEventListener('pointerleave', () => {
        state.hovered = null;
        highlight();
      });
      d.el = a;
      nodesG.appendChild(a);
    }
    highlight();
  }

  /** Focus: the hovered node, else the selected file. Unrelated nodes and links fade. */
  function highlight() {
    const focus = state.hovered ?? state.params.file ?? null;
    const near = new Set();
    const hasFocus = focus !== null && state.nodes.some((d) => d.key === focus);
    if (hasFocus) {
      near.add(focus);
      for (const e of state.edges) {
        if (e.from === focus) near.add(e.to);
        if (e.to === focus) near.add(e.from);
      }
    }
    for (const d of state.nodes) {
      d.el.classList.toggle('is-selected', d.key === state.params.file);
      d.el.classList.toggle('is-near', hasFocus && near.has(d.key));
      d.el.classList.toggle('is-faded', hasFocus && !near.has(d.key));
    }
    for (const e of state.edges) {
      const out = hasFocus && e.from === focus;
      const inc = hasFocus && e.to === focus;
      e.el.classList.toggle('is-out', out);
      e.el.classList.toggle('is-in', inc);
      e.el.classList.toggle('is-faded', hasFocus && !out && !inc);
      e.el.classList.toggle('is-minor', !hasFocus && e.minor);
      e.el.setAttribute('marker-end', out || inc ? 'url(#arrowHot)' : 'url(#arrow)');
    }
  }

  // ── View → nodes ─────────────────────────────────────────────────────────

  /** A node's label: its name relative to the folder being shown. */
  function labelFor(n, view, outside) {
    if (n.kind === 'more') return `${(view.more || []).length.toLocaleString('en')} more…`;
    if (n.kind === 'module') {
      const m = state.meta && state.meta.modulesById.get(Number(n.key.slice(1)));
      return m ? m.name : `module ${n.key.slice(1)}`;
    }
    if (n.kind === 'project') return n.key.replace(/^\[|\]$/g, '');
    if (outside) return n.key;
    const prefix = view.path ? `${view.path}/` : '';
    if (n.kind === 'file') return basename(n.key);
    return n.key.startsWith(prefix) ? n.key.slice(prefix.length) : n.key;
  }

  function titleFor(n, label) {
    const size = n.kind === 'file' ? '' : ` — ${plural(n.files, 'file', 'files')}`;
    const action =
      n.kind === 'file'
        ? 'click to see what it calls'
        : n.kind === 'more'
          ? 'click to list them'
          : 'click to open';
    return `${label}${size} · ${action}`;
  }

  function buildGraph(view) {
    const maxFiles = Math.max(1, ...view.nodes.map((n) => n.files));
    const maxCalled = Math.max(1, ...view.nodes.map((n) => n.calledWeight));
    const radius = (n) =>
      n.kind === 'file'
        ? 9 + 16 * Math.sqrt(n.calledWeight / maxCalled)
        : 14 + 36 * Math.sqrt(n.files / maxFiles);
    const inner = view.nodes.map((n) => {
      const label = labelFor(n, view, false);
      return { ...n, label, title: titleFor(n, label), r: radius(n), outside: false };
    });
    const maxOut = Math.max(1, ...view.outside.map((n) => n.files));
    const outer = view.outside.map((n) => {
      const label = labelFor(n, view, true);
      return {
        ...n,
        label,
        title: titleFor(n, label),
        r: 11 + 17 * Math.sqrt(n.files / maxOut),
        outside: true,
      };
    });

    const keys = new Set([...inner, ...outer].map((d) => d.key));
    const all = [...view.links, ...view.outsideLinks].filter(
      (l) => keys.has(l.from) && keys.has(l.to)
    );
    const maxWeight = Math.max(1, ...all.map((l) => l.weight));
    // Show each node's few heaviest links; hovering one shows all of its own.
    const outsideKeys = new Set(outer.map((d) => d.key));
    const shown = new Set();
    const perNode = new Map();
    for (const l of [...all].sort((a, b) => b.weight - a.weight)) {
      const out = outsideKeys.has(l.from) ? l.from : outsideKeys.has(l.to) ? l.to : null;
      const ends = out ? [out] : [l.from, l.to];
      const cap = out ? 1 : LINKS_PER_NODE;
      for (const key of ends) {
        const n = perNode.get(key) || 0;
        if (n < cap) shown.add(l);
        perNode.set(key, n + 1);
      }
    }
    const edges = all.map((l) => {
      const strength = Math.log1p(l.weight) / Math.log1p(maxWeight);
      const touchesMore = l.from === MORE || l.to === MORE;
      return { ...l, strength, width: 1 + 3.5 * strength, minor: touchesMore || !shown.has(l) };
    });
    layout(inner, outer, edges);
    state.nodes = [...outer, ...inner];
    state.edges = edges;
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  function section(title, items, more) {
    const wrap = el('section', 'map-section');
    wrap.appendChild(el('h3', 'map-section__title', title));
    const list = el('ul', 'map-list');
    for (const item of items) {
      const li = el('li');
      for (const part of Array.isArray(item) ? item : [item]) {
        if (typeof part === 'string') li.appendChild(document.createTextNode(part));
        else if (part) li.appendChild(part);
      }
      list.appendChild(li);
    }
    wrap.appendChild(list);
    if (more) wrap.appendChild(el('p', 'map-more', more));
    return wrap;
  }

  const small = (text) => el('small', '', text);

  function setPanel(eyebrow, title) {
    $('#panelEyebrow').textContent = eyebrow;
    $('#panelTitle').textContent = title;
    const body = $('#panelBody');
    body.replaceChildren();
    return body;
  }

  /** Links of a node to the outside, summed per outside node, one direction. */
  function outsideList(view, direction) {
    const sums = new Map();
    for (const l of view.outsideLinks) {
      const inside = direction === 'out' ? l.from : l.to;
      const other = direction === 'out' ? l.to : l.from;
      if (!view.nodes.some((n) => n.key === inside)) continue;
      sums.set(other, (sums.get(other) || 0) + l.weight);
    }
    return [...sums]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key]) => view.outside.find((n) => n.key === key))
      .filter(Boolean)
      .map((n) => {
        const target = nodeTarget({ ...n, outside: true });
        return [link(labelFor(n, view, true), target), small(plural(n.files, 'file', 'files'))];
      });
  }

  function renderFolderPanel(view) {
    const meta = state.meta;
    if (view.project === null) {
      const body = setPanel('group', state.params.group);
      body.appendChild(
        el(
          'p',
          'map-note',
          'Each circle is a repository. Open one to walk its folders: arrows show which folder calls which.'
        )
      );
      body.appendChild(
        section(
          'Repositories',
          view.nodes.map((n) => [
            link(n.key, folderParams(n.key, '')),
            small(plural(n.files, 'file', 'files')),
          ])
        )
      );
      if (view.links.length === 0 && view.nodes.length > 1) {
        body.appendChild(
          el(
            'p',
            'map-more',
            'No arrows between repositories: calls are linked inside one repository only.'
          )
        );
      }
      return;
    }

    const body = setPanel(view.path ? 'folder' : 'repository', view.path || view.project);
    const folders = view.nodes.filter((n) => n.kind === 'folder');
    const files = view.nodes.filter((n) => n.kind === 'file');
    const total = view.nodes.reduce((s, n) => s + n.files, 0);
    body.appendChild(
      el(
        'p',
        'map-stats',
        `${plural(total, 'file', 'files')} · ${plural(folders.length, 'folder', 'folders')} and ${plural(files.length + (view.more.length || 0), 'file', 'files')} directly inside`
      )
    );
    body.appendChild(
      el(
        'p',
        'map-note',
        'Circles are folders (green) and files (grey) inside this one; arrows point from the caller to the called. Dashed circles around the edge are folders elsewhere it is linked to.'
      )
    );
    const top = view.nodes
      .filter((n) => n.kind !== 'more')
      .map((n) => [
        link(labelFor(n, view, false), nodeTarget(n)),
        small(n.kind === 'file' ? 'file' : plural(n.files, 'file', 'files')),
      ]);
    body.appendChild(
      section(
        'Inside — most called first',
        top,
        view.more.length
          ? `…and ${view.more.length} less called — the “more” circle lists them.`
          : ''
      )
    );
    const uses = outsideList(view, 'out');
    if (uses.length) body.appendChild(section('Calls into', uses));
    const usedBy = outsideList(view, 'in');
    if (usedBy.length) body.appendChild(section('Called from', usedBy));
    if (view.modules.length) {
      body.appendChild(
        section(
          'Modules here — files that work together',
          view.modules.map((m) => [
            link(m.name, moduleParams(m.id)),
            small(`${m.filesHere} of ${m.fileCount} files here`),
          ]),
          'A module is a set of files that call each other much more than the rest, wherever they sit.'
        )
      );
    }
    if (!view.path && meta && meta.map) {
      const shared = meta.map.shared.filter((s) => s.project === view.project);
      if (shared.length) {
        body.appendChild(
          section(
            'Shared code — called from much of the rest',
            shared.map((s) => [
              link(s.file, fileParams(s.project, s.file)),
              small(plural(s.callers, 'caller', 'callers')),
            ])
          )
        );
      }
    }
  }

  function renderModulePanel(view) {
    const body = setPanel(`module · ${view.project}`, view.module.name);
    body.appendChild(
      el(
        'p',
        'map-stats',
        `${plural(view.module.fileCount, 'file', 'files')}${view.module.tests.length ? ` · ${plural(view.module.tests.length, 'test', 'tests')}` : ''}`
      )
    );
    body.appendChild(
      el(
        'p',
        'map-note',
        'Files that call each other much more than they call the rest. Violet circles around the edge are the modules it calls or is called from.'
      )
    );
    const dirs = new Map();
    for (const n of view.nodes) {
      if (n.kind !== 'file') continue;
      const d = dirname(n.key);
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
    body.appendChild(
      section(
        'Folders it spans',
        [...dirs]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([d, n]) => [
            link(d || '(root)', folderParams(view.project, d)),
            small(plural(n, 'file', 'files')),
          ])
      )
    );
    const files = view.nodes.filter((n) => n.kind === 'file');
    body.appendChild(
      section(
        'Files — most called first',
        files
          .slice(0, 20)
          .map((n) =>
            link(n.key, { ...moduleParams(view.module.id), project: view.project, file: n.key })
          ),
        view.module.fileCount > 20 ? `…and ${view.module.fileCount - 20} more` : ''
      )
    );
    const uses = outsideList(view, 'out');
    if (uses.length) body.appendChild(section('Calls into', uses));
    const usedBy = outsideList(view, 'in');
    if (usedBy.length) body.appendChild(section('Called from', usedBy));
    if (view.module.tests.length) {
      body.appendChild(
        section(
          'Tests',
          view.module.tests.slice(0, 20).map((t) => link(t, fileParams(view.project, t))),
          view.module.tests.length > 20 ? `…and ${view.module.tests.length - 20} more` : ''
        )
      );
    }
  }

  function renderFilePanel(info) {
    const body = setPanel(`file · ${info.project}`, info.file);
    const where = [link('open its folder', folderParams(info.project, dirname(info.file)))];
    if (info.module) where.push(' · module ', link(info.module.name, moduleParams(info.module.id)));
    const p = el('p', 'map-stats');
    for (const part of where)
      p.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
    body.appendChild(p);
    if (info.shared) {
      body.appendChild(el('p', 'map-note', 'Shared code: called from much of the repository.'));
    }
    const row = (l) => [
      link(l.file, fileParams(l.project, l.file)),
      l.project !== info.project ? small(l.project) : null,
    ];
    body.appendChild(
      section(
        'Calls',
        info.calls.slice(0, 25).map(row),
        info.calls.length === 0
          ? 'Nothing found: no call from this file to another one.'
          : info.calls.length > 25
            ? `…and ${info.calls.length - 25} more`
            : ''
      )
    );
    body.appendChild(
      section(
        'Called from',
        info.calledBy.slice(0, 25).map(row),
        info.calledBy.length === 0
          ? 'Nothing found: no other file calls into this one.'
          : info.calledBy.length > 25
            ? `…and ${info.calledBy.length - 25} more`
            : ''
      )
    );
    const back = el('p', 'map-more');
    const params = { ...state.params };
    delete params.file;
    back.appendChild(link('← back to the overview', params));
    body.appendChild(back);
  }

  function renderMore() {
    const view = state.view;
    if (!view || !view.more || view.more.length === 0) return;
    const body = setPanel('the rest', `${plural(view.more.length, 'more entry', 'more entries')}`);
    body.appendChild(
      section(
        'Less called, not drawn',
        view.more.slice(0, 200).map((key) => {
          if (state.params.module !== undefined) return link(key, fileParams(view.project, key));
          const isFolder = !view.nodes.some((n) => n.key === key) && !/\.[a-z0-9]+$/i.test(key);
          return isFolder
            ? link(key, folderParams(view.project, key))
            : link(key, fileParams(view.project, key));
        }),
        view.more.length > 200 ? `…and ${view.more.length - 200} more` : ''
      )
    );
  }

  // ── Breadcrumbs ──────────────────────────────────────────────────────────

  function renderCrumbs(view) {
    const nav = $('#crumbs');
    nav.replaceChildren();
    const parts = [];
    const group = state.params.group;
    parts.push({ text: group, params: { group } });
    const project = view && view.project;
    const multi = state.meta && state.meta.projects.length > 1;
    if (project) {
      parts.push({ text: project, params: folderParams(project, '') });
      if (state.params.module !== undefined && view.module) {
        parts.push({ text: `module: ${view.module.name}`, params: moduleParams(view.module.id) });
      } else if (view.path) {
        const segs = view.path.split('/');
        segs.forEach((s, i) => {
          parts.push({ text: s, params: folderParams(project, segs.slice(0, i + 1).join('/')) });
        });
      }
    }
    if (state.params.file) {
      parts.push({ text: basename(state.params.file), params: { ...state.params } });
    }
    if (!multi && parts.length > 1 && parts[0].text === group && project) parts.splice(0, 1);
    // One step up.
    if (parts.length > 1) {
      const up = link('↑ up', parts[parts.length - 2].params, 'map-crumbs__up');
      nav.appendChild(up);
    }
    parts.forEach((p, i) => {
      if (i > 0) nav.appendChild(el('span', 'map-crumbs__sep', '/'));
      if (i === parts.length - 1) nav.appendChild(el('strong', '', p.text));
      else nav.appendChild(link(p.text, p.params));
    });
  }

  function renderLegend(view) {
    const legend = $('#legend');
    legend.replaceChildren();
    const kinds = new Set([...view.nodes, ...view.outside].map((n) => n.kind));
    const items = [
      ['project', 'repository'],
      ['folder', 'folder'],
      ['file', 'file'],
      ['module', 'module'],
    ];
    for (const [kind, text] of items)
      if (kinds.has(kind)) legend.appendChild(el('span', `is-${kind}`, text));
    if (view.outside.length) legend.appendChild(el('span', 'is-outside', 'elsewhere'));
    if (view.links.length || view.outsideLinks.length)
      legend.appendChild(el('span', 'is-arrow', 'calls'));
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  function fillGroups(groups, current) {
    const select = $('#groupSelect');
    select.replaceChildren();
    for (const g of groups) {
      const opt = el('option', '', g);
      opt.value = g;
      if (g === current) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function showEmpty(text) {
    const empty = $('#mapEmpty');
    empty.hidden = !text;
    empty.textContent = text || '';
  }

  let renderSeq = 0;

  async function render() {
    const seq = ++renderSeq;
    const params = readParams();
    state.params = params;
    setBanner('');
    try {
      const metaUrl = `/api/module-map?${new URLSearchParams(params.group ? { group: params.group } : {})}`;
      const meta = await getJson(metaUrl);
      if (seq !== renderSeq) return;
      meta.modulesById = new Map(((meta.map && meta.map.modules) || []).map((m) => [m.id, m]));
      state.meta = meta;
      fillGroups(meta.groups, meta.group);
      if (!params.group && meta.group) {
        params.group = meta.group;
        state.params = params;
        window.history.replaceState(null, '', hrefFor(params));
      }
      if (!meta.group) {
        state.nodes = [];
        state.edges = [];
        draw();
        showEmpty('No groups indexed yet.');
        setPanel('', 'Nothing indexed');
        renderCrumbs(null);
        return;
      }

      const key =
        params.module !== undefined
          ? `module:${params.module}`
          : `tree:${params.project || ''}:${params.path || ''}`;
      const viewUrl =
        params.module !== undefined
          ? `/api/module-map/module?${new URLSearchParams({ group: params.group, module: params.module })}`
          : `/api/module-map/tree?${new URLSearchParams({ group: params.group, ...(params.project ? { project: params.project } : {}), ...(params.path ? { path: params.path } : {}) })}`;
      const view = await getJson(viewUrl);
      if (seq !== renderSeq) return;
      if (state.viewKey !== key || state.view !== view) {
        state.view = view;
        state.viewKey = key;
        if (view.nodes.length === 0) {
          state.nodes = [];
          state.edges = [];
          state.ring = null;
          draw();
          showEmpty(
            'Nothing here: the symbol graph has no links between files yet. Index the project, or check that its language has AST support.'
          );
        } else {
          showEmpty('');
          buildGraph(view);
          draw();
          fitView();
        }
        renderLegend(view);
      } else {
        highlight();
      }
      renderCrumbs(view);
      document.title = `paparats · ${view.module ? view.module.name : view.path || view.project || params.group}`;

      if (params.file && (view.project || params.project)) {
        const fileUrl = `/api/module-map/file?${new URLSearchParams({ group: params.group, project: view.project || params.project, file: params.file })}`;
        let info = null;
        try {
          info = await getJson(fileUrl);
        } catch (err) {
          if (seq !== renderSeq) return;
          if (view.module) renderModulePanel(view);
          else renderFolderPanel(view);
          const note = el('p', 'map-note', `${params.file}: ${err.message}`);
          $('#panelBody').prepend(note);
          return;
        }
        if (seq !== renderSeq) return;
        state.fileInfo = info;
        highlight();
        renderFilePanel(info);
      } else if (view.module) {
        renderModulePanel(view);
      } else {
        renderFolderPanel(view);
      }
    } catch (err) {
      if (seq !== renderSeq) return;
      setBanner(`Could not load the map: ${err.message}`);
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  let searchTimer = null;

  function wireSearch() {
    const input = $('#fileSearch');
    const list = $('#searchResults');
    const close = () => {
      list.hidden = true;
      list.replaceChildren();
    };
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length < 2 || !state.params.group) {
        close();
        return;
      }
      searchTimer = setTimeout(async () => {
        try {
          const data = await getJson(
            `/api/module-map/search?${new URLSearchParams({ group: state.params.group, q })}`
          );
          if (input.value.trim() !== q) return;
          list.replaceChildren();
          if (data.files.length === 0)
            list.appendChild(el('li')).appendChild(el('span', '', 'No file matches'));
          const multi = state.meta && state.meta.projects.length > 1;
          for (const f of data.files) {
            const a = el('a');
            if (multi) a.appendChild(small(f.project));
            a.appendChild(document.createTextNode(f.file));
            wireLink(a, fileParams(f.project, f.file));
            a.addEventListener('click', () => {
              input.value = '';
              close();
            });
            list.appendChild(el('li')).appendChild(a);
          }
          list.hidden = false;
        } catch (err) {
          setBanner(`Search failed: ${err.message}`);
        }
      }, 180);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        input.value = '';
        close();
      }
      if (ev.key === 'Enter') {
        const first = list.querySelector('a');
        if (first) first.click();
      }
    });
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('.map-search-box')) close();
    });
  }

  // ── Pan and zoom ─────────────────────────────────────────────────────────

  function wirePanZoom() {
    const svgEl = $('#mapSvg');
    let drag = null;
    svgEl.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest && ev.target.closest('.map-node')) return;
      drag = { x: ev.clientX, y: ev.clientY, zx: state.zoom.x, zy: state.zoom.y, moved: false };
      svgEl.setPointerCapture(ev.pointerId);
    });
    svgEl.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      state.zoom.x = drag.zx + dx;
      state.zoom.y = drag.zy + dy;
      applyZoom();
    });
    svgEl.addEventListener('pointerup', () => {
      // A click on empty space clears the selected file.
      if (drag && !drag.moved && state.params.file) {
        const params = { ...state.params };
        delete params.file;
        go(params);
      }
      drag = null;
    });
    svgEl.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const box = svgEl.getBoundingClientRect();
        zoomBy(Math.exp(-ev.deltaY * 0.0015), ev.clientX - box.left, ev.clientY - box.top);
      },
      { passive: false }
    );
    $('#zoomIn').addEventListener('click', () => zoomBy(1.4));
    $('#zoomOut').addEventListener('click', () => zoomBy(1 / 1.4));
    $('#zoomFit').addEventListener('click', fitView);
  }

  // ── Start ────────────────────────────────────────────────────────────────

  function start() {
    wirePanZoom();
    wireSearch();
    $('#groupSelect').addEventListener('change', (ev) => go({ group: ev.target.value }));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.params.file && document.activeElement !== $('#fileSearch')) {
        const params = { ...state.params };
        delete params.file;
        go(params);
      }
      if ((ev.key === '+' || ev.key === '=') && ev.target === document.body) zoomBy(1.4);
      if (ev.key === '-' && ev.target === document.body) zoomBy(1 / 1.4);
    });
    window.addEventListener('popstate', render);
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitView, 150);
    });
    render();
  }

  start();
})();
