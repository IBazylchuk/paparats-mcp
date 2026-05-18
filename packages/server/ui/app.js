// paparats operator console — vanilla dashboard
// Polls /api/analytics every 5s, builds rows via DOM API (no innerHTML on user data).

(function () {
  'use strict';

  const REFRESH_MS = 5000;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let currentPeriod = '24h';
  let pollTimer = null;
  let inFlight = false;

  // ── Formatting helpers ───────────────────────────────────────────────────

  const fmtInt = new Intl.NumberFormat('en-US');
  const fmtPct = (n) => (n === null || n === undefined ? '—' : (n * 100).toFixed(1) + '%');

  function abbrevTokens(n) {
    if (n === null || n === undefined || n === 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtUptime(seconds) {
    if (!seconds || seconds < 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtRelative(iso) {
    if (!iso) return '—';
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '—';
    const diff = Date.now() - then;
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function setText(selector, value) {
    const el = typeof selector === 'string' ? $(`[data-bind="${selector}"]`) : selector;
    if (el) el.textContent = value;
  }

  function setBanner(msg) {
    const el = $('#banner');
    if (!el) return;
    if (!msg) {
      el.classList.add('banner--hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('banner--hidden');
    el.textContent = msg;
  }

  function setConn(state) {
    const el = $('#connDot');
    if (el) el.dataset.state = state;
  }

  // ── DOM builders (XSS-safe: every text node goes via textContent) ────────

  /**
   * Build a <td> with text content and optional className/title.
   * All user input flows through textContent — no HTML interpolation.
   */
  function makeCell(text, opts = {}) {
    const td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    if (opts.className) td.className = opts.className;
    if (opts.title) td.title = String(opts.title);
    if (opts.colspan) td.colSpan = opts.colspan;
    return td;
  }

  function makeRow(...cells) {
    const tr = document.createElement('tr');
    for (const c of cells) tr.append(c);
    return tr;
  }

  function makeEmptyRow(colspan, text) {
    const tr = document.createElement('tr');
    tr.className = 'data-table__empty';
    tr.append(makeCell(text, { colspan }));
    return tr;
  }

  function clearTbody(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function replaceTbody(el, rows) {
    clearTbody(el);
    for (const r of rows) el.append(r);
  }

  // ── Renderers ────────────────────────────────────────────────────────────

  function renderOverview(d) {
    const o = d.overview || {};
    const period = d.period?.label ?? '—';
    setText('uptime', fmtUptime(o.uptimeSec));
    setText('uptimeCaption', `process uptime · ${o.cpuLoad?.['1m'] ?? '—'} load avg`);
    setText('cpu', `${o.cpuLoad?.perCore1m ?? '—'}%`);
    setText('memory', `${o.memPct ?? '—'}%`);

    setText('groups', fmtInt.format(o.groups ?? 0));
    setText(
      'projects',
      `${fmtInt.format(o.projects ?? 0)} project${o.projects === 1 ? '' : 's'} · ${fmtInt.format(o.groups ?? 0)} group${o.groups === 1 ? '' : 's'}`
    );
    setText('chunks', abbrevTokens(o.chunksTotal ?? 0));

    setText('searches', fmtInt.format(o.searchesInPeriod ?? 0));
    setText('searchesCaption', `searches in last ${period}`);
    setText('fetches', fmtInt.format(o.fetchesInPeriod ?? 0));

    const rate = o.fetchRate;
    if (rate === null || rate === undefined) {
      setText('fetchRate', '—');
      setText('fetchRateCaption', 'no searches in period');
      const el = $(`[data-bind="fetchHealth"]`);
      if (el) {
        el.textContent = '—';
        el.className = 'cell-mute';
      }
    } else {
      setText('fetchRate', rate.toFixed(2));
      setText('fetchRateCaption', 'chunks opened per search');
      const el = $(`[data-bind="fetchHealth"]`);
      if (el) {
        if (rate >= 0.4) {
          el.textContent = 'healthy';
          el.className = 'cell-good';
        } else if (rate >= 0.1) {
          el.textContent = 'low usage';
          el.className = 'cell-warn';
        } else {
          el.textContent = 'unused';
          el.className = 'cell-bad';
        }
      }
    }
  }

  function setBar(name, pct) {
    const el = document.querySelector(`[data-bar="${name}"]`);
    if (el) el.style.setProperty('--w', `${Math.max(0, Math.min(100, pct))}%`);
  }

  function renderRoi(d) {
    const ts = d.tokenSavings;
    const fetches = d.overview?.fetchesInPeriod ?? 0;
    const fetchRate = d.overview?.fetchRate;

    function emptyRoi(headline, legend) {
      setText('roiPct', '—');
      setText('roiHeadline', headline);
      setText('roiSavedTokens', '—');
      setText('roiSearchesLine', '—');
      setText('roiPanelSaved', '—');
      setText('baseline', '—');
      setText('searchOnly', '—');
      setText('consumed', '—');
      setText('roiLegend', legend);
      setBar('baseline', 0);
      setBar('search', 0);
      setBar('consumed', 0);
    }

    if (!d.analyticsEnabled) {
      emptyRoi(
        'savings vs naïve baseline',
        'Telemetry disabled. Set PAPARATS_ANALYTICS_ENABLED=true to populate.'
      );
      return;
    }
    if (!ts || !ts.searches) {
      emptyRoi(
        'savings vs naïve baseline',
        `No searches in last ${d.period?.label ?? '—'} · run a few MCP queries to populate.`
      );
      return;
    }

    const naive = ts.naive_baseline || 0;
    const search = ts.search_only || 0;
    const consumed = ts.actually_consumed || 0;
    const max = Math.max(naive, search, consumed, 1);

    // Hero metric is savings_vs_naive: stable, intuitive, "what would we pay
    // if we just pasted the whole file each time vs. the chunked search".
    setText('roiPct', fmtPct(ts.savings_vs_naive));
    setText('roiHeadline', 'tokens saved by sending chunks instead of whole files');

    const tokensSaved = Math.max(0, naive - search);
    setText('roiSavedTokens', abbrevTokens(tokensSaved));
    setText(
      'roiSearchesLine',
      `across ${fmtInt.format(ts.searches)} search${ts.searches === 1 ? '' : 'es'} in ${d.period?.label ?? '—'} · ${abbrevTokens(naive)} → ${abbrevTokens(search)} tokens`
    );

    // Right panel: realised savings (after fetch behaviour). This number is
    // unreliable when the LLM rarely fetches — explain it instead of trumpeting.
    setText('roiPanelSaved', `${abbrevTokens(tokensSaved)} tok saved`);
    setText('baseline', `${abbrevTokens(naive)} tok`);
    setText('searchOnly', `${abbrevTokens(search)} tok`);
    setText('consumed', `${abbrevTokens(consumed)} tok`);
    setBar('baseline', (naive / max) * 100);
    setBar('search', (search / max) * 100);
    setBar('consumed', (consumed / max) * 100);

    const legend = legendForRoi({ ts, fetches, fetchRate });
    const legendEl = $(`[data-bind="roiLegend"]`);
    if (legendEl) {
      while (legendEl.firstChild) legendEl.removeChild(legendEl.firstChild);
      for (const node of legend) legendEl.append(node);
    }
  }

  function legendForRoi({ ts, fetches, fetchRate }) {
    const nodes = [];
    function text(s) {
      return document.createTextNode(s);
    }
    function bold(s) {
      const b = document.createElement('strong');
      b.textContent = s;
      return b;
    }
    function warn(s) {
      const span = document.createElement('span');
      span.className = 'roi__warn';
      span.textContent = s;
      return span;
    }

    const realizedPct =
      ts.savings_realized != null ? (ts.savings_realized * 100).toFixed(1) + '%' : '—';

    nodes.push(text('"Actually used" looks tiny because the LLM opened '));
    nodes.push(bold(fmtInt.format(fetches) + ' chunk' + (fetches === 1 ? '' : 's')));
    nodes.push(text(' from '));
    nodes.push(bold(fmtInt.format(ts.searches) + ' search' + (ts.searches === 1 ? '' : 'es')));
    if (fetchRate != null) {
      nodes.push(text(' (' + fetchRate.toFixed(2) + ' per search). '));
    } else {
      nodes.push(text('. '));
    }

    if (fetchRate != null && fetchRate < 0.1) {
      nodes.push(warn('Low fetch rate'));
      nodes.push(
        text(
          " — results may not be reaching the LLM's context. Check that the MCP client surfaces get_chunk results. "
        )
      );
    }

    nodes.push(
      text(
        `Realized savings sit at ${realizedPct}, but that's a "what was opened" number, not "what was useful".`
      )
    );
    return nodes;
  }

  function renderSlow(d) {
    const body = $('#slowBody');
    if (!d.analyticsEnabled) {
      replaceTbody(body, [makeEmptyRow(4, 'analytics disabled')]);
      return;
    }
    const rows = d.slowestSearches || [];
    if (rows.length === 0) {
      replaceTbody(body, [makeEmptyRow(4, 'no searches in window')]);
      return;
    }
    const out = rows.map((r, i) => {
      const slowClass =
        r.duration_ms > 5000
          ? 'col-num cell-bad'
          : r.duration_ms > 1000
            ? 'col-num cell-warn'
            : 'col-num';
      const queryText = truncate(r.query_example || '<no query text>', 64);
      return makeRow(
        makeCell(String(i + 1), { className: 'col-rank' }),
        makeCell(queryText, { className: 'cell-query', title: r.query_example || '' }),
        makeCell(fmtInt.format(r.duration_ms), { className: slowClass }),
        makeCell(fmtInt.format(r.result_count), { className: 'col-num cell-mute' })
      );
    });
    replaceTbody(body, out);
  }

  function renderTop(d) {
    const body = $('#topBody');
    if (!d.analyticsEnabled) {
      replaceTbody(body, [makeEmptyRow(4, 'analytics disabled')]);
      return;
    }
    const rows = d.topQueries || [];
    if (rows.length === 0) {
      replaceTbody(body, [makeEmptyRow(4, 'no searches in window')]);
      return;
    }
    const out = rows.map((r) => {
      const zcr = r.zero_click_rate ?? 0;
      const zcrCls =
        zcr >= 0.6 ? 'col-num cell-bad' : zcr >= 0.3 ? 'col-num cell-warn' : 'col-num cell-good';
      const queryText = truncate(r.example || '<no query text>', 56);
      return makeRow(
        makeCell(queryText, { className: 'cell-query', title: r.example || '' }),
        makeCell(fmtInt.format(r.count), { className: 'col-num' }),
        makeCell(fmtInt.format(r.avg_duration_ms), { className: 'col-num cell-mute' }),
        makeCell(fmtPct(zcr), { className: zcrCls })
      );
    });
    replaceTbody(body, out);
  }

  function makeStatusTag(state) {
    const span = document.createElement('span');
    span.className = 'dot-tag';
    span.dataset.state = String(state || 'idle').toLowerCase();
    span.textContent = state || 'idle';
    const td = document.createElement('td');
    td.append(span);
    return td;
  }

  function renderIndexer(d) {
    const body = $('#indexerBody');
    const chip = $('#indexerChip');
    const ix = d.indexer || { reachable: false, repos: [] };
    if (!ix.reachable) {
      chip.dataset.state = 'bad';
      chip.textContent = 'offline';
      const msg = ix.error ? `unreachable: ${ix.error}` : 'unreachable';
      replaceTbody(body, [makeEmptyRow(5, msg)]);
      return;
    }
    chip.dataset.state = ix.globalStatus === 'error' ? 'bad' : 'ok';
    chip.textContent = ix.globalStatus || 'idle';
    if (!ix.repos.length) {
      replaceTbody(body, [makeEmptyRow(5, 'no repos configured')]);
      return;
    }
    const out = ix.repos.map((r) => {
      const errCell = r.lastError
        ? makeCell(truncate(r.lastError, 50), { className: 'cell-bad', title: r.lastError })
        : makeCell('—', { className: 'cell-mute' });
      return makeRow(
        makeCell(r.repo, { className: 'cell-query' }),
        makeStatusTag(r.status),
        makeCell(fmtRelative(r.lastRun), { className: 'cell-mute' }),
        makeCell(r.chunksIndexed != null ? fmtInt.format(r.chunksIndexed) : '—', {
          className: 'col-num',
        }),
        errCell
      );
    });
    replaceTbody(body, out);
  }

  function makeShareCell(share) {
    const td = document.createElement('td');
    td.className = 'col-num';
    const wrap = document.createElement('span');
    wrap.className = 'share-bar';
    const track = document.createElement('span');
    track.className = 'share-bar__track';
    const fill = document.createElement('span');
    fill.className = 'share-bar__fill';
    fill.style.setProperty('--share', `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`);
    track.append(fill);
    const pct = document.createElement('span');
    pct.className = 'share-bar__pct';
    pct.textContent = fmtPct(share);
    wrap.append(track, pct);
    td.append(wrap);
    return td;
  }

  function makeBridgeCell(anchor, target) {
    const td = document.createElement('td');
    td.className = 'cell-bridge';
    const a = document.createElement('span');
    a.textContent = anchor;
    const arrow = document.createElement('span');
    arrow.className = 'bridge-arrow';
    arrow.textContent = '→';
    const t = document.createElement('span');
    t.textContent = target;
    td.append(a, arrow, t);
    return td;
  }

  function renderCrossProjects(d) {
    const chip = $('#crossChip');
    const anchorBody = $('#crossAnchorBody');
    const pairBody = $('#crossPairBody');

    if (!d.analyticsEnabled) {
      chip.dataset.state = '';
      chip.textContent = 'disabled';
      replaceTbody(anchorBody, [makeEmptyRow(4, 'analytics disabled')]);
      replaceTbody(pairBody, [makeEmptyRow(3, 'analytics disabled')]);
      return;
    }

    const anchors = d.crossProjects?.anchors ?? [];
    const pairs = d.crossProjects?.topPairs ?? [];
    const hint = $('#crossHint');

    function clearHint() {
      if (!hint) return;
      hint.classList.remove('is-visible');
      while (hint.firstChild) hint.removeChild(hint.firstChild);
    }

    if (anchors.length === 0 && pairs.length === 0) {
      chip.dataset.state = '';
      chip.textContent = 'no anchored searches';
      clearHint();
      replaceTbody(anchorBody, [makeEmptyRow(4, 'no searches with an anchor project in window')]);
      replaceTbody(pairBody, [makeEmptyRow(3, '—')]);
      return;
    }

    // Chip: aggregate share weighted by searches
    const totalSearches = anchors.reduce((a, b) => a + b.searches, 0);
    const weightedShare =
      totalSearches > 0
        ? anchors.reduce((a, b) => a + b.off_anchor_share * b.searches, 0) / totalSearches
        : 0;
    chip.dataset.state = weightedShare >= 0.2 ? 'ok' : '';
    chip.textContent = `${fmtPct(weightedShare)} off-anchor`;

    // Anchor-scope hint: 0% off-anchor across N anchored searches almost
    // always means the MCP client is calling search_code with an explicit
    // project param. Spell out the diagnosis path instead of leaving a
    // silent 0%.
    if (d.crossProjects?.scopeLikelyAnchored && totalSearches > 0) {
      clearHint();
      const intro = document.createTextNode(
        `0 off-anchor results across ${fmtInt.format(totalSearches)} anchored searches. Two possible causes — `
      );
      const s1 = document.createElement('strong');
      s1.textContent = 'the MCP client passes ';
      const code1 = document.createElement('code');
      code1.textContent = 'project: "<anchor>"';
      const s1tail = document.createTextNode(' to ');
      const code2 = document.createElement('code');
      code2.textContent = 'search_code';
      const s1end = document.createTextNode(' (most likely), ');
      const s2 = document.createElement('strong');
      s2.textContent = 'or';
      const s2tail = document.createTextNode(
        ' the embedding model genuinely never ranks off-anchor chunks in the top results. Try calling search_code with '
      );
      const code3 = document.createElement('code');
      code3.textContent = 'project: "all"';
      const tail = document.createTextNode(' to tell them apart.');
      hint.append(intro, s1, code1, s1tail, code2, s1end, s2, s2tail, code3, tail);
      hint.classList.add('is-visible');
    } else {
      clearHint();
    }

    if (anchors.length === 0) {
      replaceTbody(anchorBody, [makeEmptyRow(4, '—')]);
    } else {
      const out = anchors.map((a) =>
        makeRow(
          makeCell(a.anchor_project, { className: 'cell-query' }),
          makeCell(fmtInt.format(a.searches), { className: 'col-num' }),
          makeShareCell(a.off_anchor_share),
          makeCell(fmtInt.format(a.off_anchor_fetches), {
            className: 'col-num ' + (a.off_anchor_fetches === 0 ? 'cell-mute' : 'cell-good'),
          })
        )
      );
      replaceTbody(anchorBody, out);
    }

    if (pairs.length === 0) {
      replaceTbody(pairBody, [makeEmptyRow(3, 'no cross-project hits in window')]);
    } else {
      const out = pairs.map((p) =>
        makeRow(
          makeBridgeCell(p.anchor_project, p.result_project),
          makeCell(fmtInt.format(p.results_count), { className: 'col-num' }),
          makeCell(fmtInt.format(p.fetches), {
            className: 'col-num ' + (p.fetches === 0 ? 'cell-mute' : 'cell-good'),
          })
        )
      );
      replaceTbody(pairBody, out);
    }
  }

  function renderUsers(d) {
    const chip = $('#usersChip');
    const body = $('#usersBody');

    if (!d.analyticsEnabled) {
      chip.dataset.state = '';
      chip.textContent = 'disabled';
      replaceTbody(body, [makeEmptyRow(6, 'analytics disabled')]);
      return;
    }

    const u = d.users || { distinctCount: 0, rows: [] };
    chip.dataset.state = u.distinctCount > 0 ? 'ok' : '';
    chip.textContent = `${fmtInt.format(u.distinctCount)} distinct`;

    if (!u.rows.length) {
      replaceTbody(body, [makeEmptyRow(6, 'no activity in window')]);
      return;
    }

    const out = u.rows.map((r) =>
      makeRow(
        makeCell(r.user, { className: 'cell-query' }),
        makeCell(fmtInt.format(r.searches), { className: 'col-num' }),
        makeCell(fmtInt.format(r.fetches), {
          className: 'col-num ' + (r.fetches === 0 ? 'cell-mute' : 'cell-good'),
        }),
        makeCell(fmtInt.format(r.sessions), { className: 'col-num cell-mute' }),
        makeCell(r.top_anchor_project || '—', { className: 'cell-mute' }),
        makeCell(fmtRelative(r.last_active_ts ? new Date(r.last_active_ts).toISOString() : null), {
          className: 'cell-mute',
        })
      )
    );
    replaceTbody(body, out);
  }

  function renderSparkline(d) {
    const svg = $('#sparkline');
    const linePath = $('#sparklinePath');
    const areaPath = $('#sparklineArea');
    const fetchesPath = $('#sparklineFetches');
    if (!svg || !linePath || !areaPath || !fetchesPath) return;
    const points = d.timeseries || [];
    const w = 200;
    const h = 40;
    if (points.length < 2) {
      linePath.setAttribute('d', '');
      areaPath.setAttribute('d', '');
      fetchesPath.setAttribute('d', '');
      return;
    }
    const max = Math.max(1, ...points.map((p) => p.searches));
    const fetchMax = Math.max(1, ...points.map((p) => p.fetches));
    const xStep = w / (points.length - 1);
    function searchPoint(i) {
      const x = i * xStep;
      const y = h - (points[i].searches / max) * (h - 2) - 1;
      return [x, y];
    }
    function fetchPoint(i) {
      const x = i * xStep;
      const y = h - (points[i].fetches / fetchMax) * (h - 2) - 1;
      return [x, y];
    }
    const line = points
      .map((_, i) => {
        const [x, y] = searchPoint(i);
        return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');
    linePath.setAttribute('d', line);

    const area = line + ` L ${w},${h} L 0,${h} Z`;
    areaPath.setAttribute('d', area);

    const fetchLine = points
      .map((_, i) => {
        const [x, y] = fetchPoint(i);
        return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      })
      .join(' ');
    fetchesPath.setAttribute('d', fetchLine);
  }

  function renderFailedSearches(d) {
    const body = $('#failedBody');
    const chip = $('#failedChip');
    if (!d.analyticsEnabled) {
      chip.dataset.state = '';
      chip.textContent = 'disabled';
      replaceTbody(body, [makeEmptyRow(4, 'analytics disabled')]);
      return;
    }
    const rows = d.failedSearches || [];
    if (rows.length === 0) {
      chip.dataset.state = 'ok';
      chip.textContent = 'all clean';
      replaceTbody(body, [makeEmptyRow(4, 'no failed searches in window · nice')]);
      return;
    }
    chip.dataset.state = 'bad';
    chip.textContent = `${rows.length} recent`;
    const out = rows.map((r) =>
      makeRow(
        makeCell(fmtRelative(new Date(r.ts).toISOString()), { className: 'cell-mute' }),
        makeCell(r.user, { className: 'cell-mute' }),
        makeCell(truncate(r.query_example || '<no query text>', 50), {
          className: 'cell-query',
          title: r.query_example || '',
        }),
        makeCell(truncate(r.error, 50), { className: 'cell-bad', title: r.error })
      )
    );
    replaceTbody(body, out);
  }

  function renderEmbedding(d) {
    const chip = $('#embeddingChip');
    const e = d.embedding || {
      total: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      timeouts: 0,
    };

    if (!d.analyticsEnabled) {
      chip.dataset.state = '';
      chip.textContent = 'disabled';
      setText('embP95', '—');
      setText('embP95Sub', 'analytics disabled');
      setText('embP50', '—');
      setText('embP99', '—');
      setText('embCalls', '—');
      setText('embCacheRate', '—');
      setText('embCacheSub', '—');
      setText('embErrors', '—');
      setText('embTimeouts', '—');
      setBar('embCache', 0);
      return;
    }

    if (e.total === 0) {
      chip.dataset.state = '';
      chip.textContent = 'idle';
      setText('embP95', '—');
      setText('embP95Sub', 'no embedding calls in window');
      setText('embP50', '—');
      setText('embP99', '—');
      setText('embCalls', '0');
      setText('embCacheRate', '—');
      setText('embCacheSub', '0 hits / 0 misses');
      setText('embErrors', '0');
      setText('embTimeouts', '0 timeouts');
      setBar('embCache', 0);
      return;
    }

    const slow = e.p95 > 500;
    chip.dataset.state = e.errors > 0 ? 'bad' : slow ? '' : 'ok';
    chip.textContent = e.errors > 0 ? `${e.errors} errors` : slow ? 'slow' : 'healthy';

    setText('embP95', `${fmtInt.format(Math.round(e.p95))}ms`);
    setText(
      'embP95Sub',
      `p99: ${fmtInt.format(Math.round(e.p99))}ms · 5% of calls slower than this`
    );
    setText('embP50', `${fmtInt.format(Math.round(e.p50))}ms`);
    setText('embP99', `${fmtInt.format(Math.round(e.p99))}ms`);
    setText('embCalls', fmtInt.format(e.total));

    const totalCache = e.cacheHits + e.cacheMisses;
    const rate = totalCache > 0 ? e.cacheHits / totalCache : 0;
    setText('embCacheRate', fmtPct(rate));
    setText(
      'embCacheSub',
      `${fmtInt.format(e.cacheHits)} hits / ${fmtInt.format(e.cacheMisses)} misses`
    );
    setBar('embCache', rate * 100);

    setText('embErrors', fmtInt.format(e.errors));
    setText('embTimeouts', `${fmtInt.format(e.timeouts)} timeouts`);
  }

  function renderErrors(d) {
    const body = $('#errBody');
    if (!d.analyticsEnabled) {
      replaceTbody(body, [makeEmptyRow(4, 'analytics disabled')]);
      return;
    }
    const rows = d.recentErrors || [];
    if (rows.length === 0) {
      replaceTbody(body, [makeEmptyRow(4, 'no chunking failures · nice')]);
      return;
    }
    const out = rows.map((r) =>
      makeRow(
        makeCell(r.error_class, { className: 'cell-query' }),
        makeCell(r.language || '—', { className: 'cell-mute' }),
        makeCell(fmtInt.format(r.count), { className: 'col-num' }),
        makeCell(truncate(r.example_file || '—', 48), {
          className: 'cell-mute',
          title: r.example_file || '',
        })
      )
    );
    replaceTbody(body, out);
  }

  // ── Tick ─────────────────────────────────────────────────────────────────

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const pageParams = new URLSearchParams(window.location.search);
      const demo = pageParams.get('demo');
      const url = demo
        ? `/api/analytics?period=${encodeURIComponent(currentPeriod)}&demo=${encodeURIComponent(demo)}`
        : `/api/analytics?period=${encodeURIComponent(currentPeriod)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) {
        setConn('bad');
        setBanner(`Failed to fetch analytics: HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setConn('ok');
      if (!data.analyticsEnabled) {
        setBanner(
          'Analytics store disabled. Overview + indexer tiles use live data; the rest needs PAPARATS_OTEL_ENABLED=true.'
        );
      } else {
        setBanner(null);
      }
      renderOverview(data);
      renderSparkline(data);
      renderRoi(data);
      renderSlow(data);
      renderTop(data);
      renderCrossProjects(data);
      renderUsers(data);
      renderIndexer(data);
      renderErrors(data);
      renderFailedSearches(data);
      renderEmbedding(data);
      setText($('#lastRefresh'), new Date().toLocaleTimeString());
    } catch (err) {
      setConn('bad');
      setBanner(`Network error: ${err.message}`);
    } finally {
      inFlight = false;
    }
  }

  // ── Period switch ────────────────────────────────────────────────────────

  function bindPeriod() {
    $$('.period-switch__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.period;
        if (!p || p === currentPeriod) return;
        currentPeriod = p;
        $$('.period-switch__btn').forEach((b) =>
          b.setAttribute('aria-selected', String(b.dataset.period === currentPeriod))
        );
        tick();
      });
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  function boot() {
    bindPeriod();
    tick();
    pollTimer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearInterval(pollTimer);
        pollTimer = null;
      } else if (!pollTimer) {
        tick();
        pollTimer = setInterval(tick, REFRESH_MS);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
