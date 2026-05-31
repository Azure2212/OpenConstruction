// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// OpenConstruction Assistant
// ---------------------------
// An assistant-style layer that EXTENDS the existing hero search bar
// (per PI feedback: extend the current interface, do not build a separate
// platform). It reads the same catalog JSON the site already ships
// (data/datasets.json, models.json, use-cases.json, oer.json) and returns
// grounded, citation-based resource recommendations.
//
// Design goal = sustainability: retrieval runs 100% in the browser, so there
// is NO server, NO database call, and NO LLM API cost per query. Because the
// answer is assembled only from real catalog fields, it cannot hallucinate a
// citation. An optional LLM/MCP layer can sit on top later (see mcp.html);
// this file is the zero-cost baseline.

(function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[_\-/]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function arr(v) {
    if (Array.isArray(v)) return v.filter(x => x != null && String(x).trim() !== '');
    if (v == null || String(v).trim() === '') return [];
    return [v];
  }
  function firstAuthor(a) {
    if (Array.isArray(a)) return a[0] || '';
    return String(a || '').split(',')[0].trim();
  }
  function authorsEtAl(a) {
    const list = Array.isArray(a) ? a : String(a || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return list[0] + ' & ' + list[1];
    return list[0] + ' et al.';
  }

  const STOP = new Set(('a an and are as at be by for from has have i in is it its of on or our that the their them ' +
    'these this to was were what which with you your me my we how do does can could would show find get give list ' +
    'any some need want looking related about into using use used best top good which one any there here').split(' '));

  // AEC-aware query expansion: maps a user term to extra terms we also score.
  const SYN = {
    crack: ['defect', 'damage', 'fracture'],
    cracks: ['crack', 'defect', 'damage'],
    defect: ['crack', 'damage', 'distress', 'anomaly'],
    damage: ['defect', 'crack', 'distress'],
    pothole: ['defect', 'pavement', 'distress'],
    rebar: ['reinforcement', 'reinforcing', 'steel'],
    ppe: ['hardhat', 'helmet', 'safety', 'vest', 'protective'],
    hardhat: ['helmet', 'ppe', 'safety'],
    helmet: ['hardhat', 'ppe', 'safety'],
    safety: ['ppe', 'hardhat', 'hazard'],
    lidar: ['point cloud', 'laser scan', 'scan'],
    'point cloud': ['lidar', 'laser scan', 'pointcloud', '3d'],
    pointcloud: ['point cloud', 'lidar'],
    scan: ['point cloud', 'lidar', 'scanning'],
    bim: ['ifc', 'revit', 'building information'],
    ifc: ['bim', 'building information'],
    segmentation: ['segment', 'semantic', 'instance'],
    detection: ['detect', 'detector', 'recognition'],
    classification: ['classify', 'classifier', 'recognition'],
    drone: ['uav', 'aerial'],
    uav: ['drone', 'aerial'],
    bridge: ['infrastructure', 'structural'],
    pavement: ['road', 'asphalt', 'surface'],
    road: ['pavement', 'highway'],
    worker: ['workforce', 'personnel', 'labor', 'activity'],
    progress: ['monitoring', 'tracking'],
    estimating: ['estimation', 'cost', 'quantity', 'takeoff'],
    course: ['education', 'teaching', 'learn', 'curriculum', 'lecture'],
    tutorial: ['education', 'guide', 'learn'],
    textbook: ['education', 'book', 'learn']
  };

  // Which catalog a query is leaning toward (used as a gentle multiplier).
  const TYPE_HINTS = {
    dataset: ['dataset', 'datasets', 'data', 'benchmark', 'images', 'annotated', 'labeled', 'corpus'],
    model: ['model', 'models', 'pretrained', 'pre-trained', 'network', 'detector', 'cnn', 'transformer', 'weights', 'checkpoint', 'architecture'],
    oer: ['course', 'courses', 'tutorial', 'tutorials', 'learn', 'learning', 'teaching', 'education', 'educational', 'lecture', 'textbook', 'class', 'curriculum', 'student', 'syllabus'],
    workflow: ['workflow', 'workflows', 'use case', 'usecase', 'deployment', 'case study', 'real world', 'in practice', 'company', 'companies', 'adoption', 'industry']
  };

  function expand(tokens) {
    const out = new Set();
    tokens.forEach(t => {
      out.add(t);
      (SYN[t] || []).forEach(s => norm(s).split(' ').forEach(w => out.add(w)));
    });
    return Array.from(out).filter(t => t && !STOP.has(t) && t.length > 1);
  }

  function detectTypeBias(qNorm) {
    const bias = {};
    Object.keys(TYPE_HINTS).forEach(type => {
      bias[type] = TYPE_HINTS[type].some(h => qNorm.includes(h)) ? 1.4 : 1;
    });
    return bias;
  }

  // ----------------------------------------------------------- data loading
  function candidatePaths(file) {
    return Array.from(new Set([
      'data/' + file, './data/' + file, '../data/' + file, '/open-construction/data/' + file
    ]));
  }
  async function loadJson(file) {
    for (const url of candidatePaths(file)) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) return await res.json();
      } catch (e) { /* try next */ }
    }
    return null;
  }

  // --------------------------------------------------- build the search index
  // Each entry keeps the fields needed to render a real citation, plus a
  // weighted token bag for scoring.
  function bag(fields) {
    // fields: array of [text, weight]
    const map = new Map();
    fields.forEach(([text, w]) => {
      norm(text).split(' ').forEach(tok => {
        if (!tok || STOP.has(tok) || tok.length < 2) return;
        map.set(tok, (map.get(tok) || 0) + w);
      });
    });
    return map;
  }

  function buildIndex(d) {
    const items = [];
    const nowYear = new Date().getFullYear();

    // datasets.json is a map keyed by id
    Object.values(d.datasets || {}).forEach(ds => {
      const tasks = arr(ds.potential_tasks);
      const classes = arr(ds.classes);
      items.push({
        type: 'dataset',
        id: ds.id || ds.name,
        title: ds.name || ds.id || 'Untitled dataset',
        href: 'datasets/detail.html?id=' + encodeURIComponent(ds.id || ds.name || ''),
        year: +ds.year || null,
        authors: ds.authors, doi: ds.doi, paper: ds.paper, license: ds.license,
        modality: ds.data_modality, count: ds.num_images,
        tasks: tasks,
        tokens: bag([
          [ds.name, 3], [ds.id, 2], [tasks.join(' '), 2.2], [classes.join(' '), 1.5],
          [ds.data_modality, 1.4], [ds.annotation_types, 1.2], [ds.authors, .7],
          [ds.paper, 1], [ds.geographical_location, .4]
        ])
      });
    });

    // models.json is an array
    (Array.isArray(d.models) ? d.models : []).forEach(m => {
      const tasks = arr(m.tasks).concat(arr(m.task));
      const apps = arr(m.applications).concat(arr(m.application));
      const mod = arr(m.modalities).concat(arr(m.modality));
      items.push({
        type: 'model',
        id: m.id || m.title,
        title: m.title || m.id || 'Untitled model',
        href: 'models/details.html?id=' + encodeURIComponent(m.id || m.title || ''),
        year: +m.year || null,
        authors: m.authors, doi: m.doi, paper: m.paper_url || m.paper, code: m.code_url, license: m.license,
        tasks: tasks,
        tokens: bag([
          [m.title, 3], [m.id, 1.5], [tasks.join(' '), 2.2], [apps.join(' '), 1.8],
          [mod.join(' '), 1.4], [Array.isArray(m.authors) ? m.authors.join(' ') : m.authors, .7],
          [m.abstract, .5]
        ])
      });
    });

    // use-cases.json -> workflows
    arr(d.usecases && d.usecases.use_cases).forEach(u => {
      const apps = arr(u.applications);
      const companies = arr(u.companies).map(c => c && c.name).filter(Boolean);
      items.push({
        type: 'workflow',
        id: u.title,
        title: u.title || 'Untitled workflow',
        href: 'deployments.html?q=' + encodeURIComponent(u.title || ''),
        year: +u.year || null,
        provider: u.provider, companies: companies, evidence: u.evidence_level,
        phase: u.phase, stage: u.deployment_stage,
        tasks: apps,
        tokens: bag([
          [u.title, 3], [u.summary, 1], [apps.join(' '), 2], [u.phase, 1.2],
          [arr(u.ai_tech).join(' '), 1.4], [arr(u.data_modalities).join(' '), 1.2],
          [u.provider, 1], [companies.join(' '), 1], [arr(u.stakeholders).join(' '), .7]
        ])
      });
    });

    // oer.json -> resources
    arr(d.oers && d.oers.resources).forEach(r => {
      const topics = arr(r.topics);
      items.push({
        type: 'oer',
        id: r.id || r.title,
        title: r.title || 'Untitled resource',
        href: r.source || 'oer.html',
        external: !!r.source,
        year: +r.year || null,
        provider: r.provider || r.publisher, license: r.license,
        topics: topics,
        tasks: topics,
        tokens: bag([
          [r.title, 3], [topics.join(' '), 2.2], [r.provider, 1], [r.publisher, 1],
          [arr(r.institutions).join(' '), .8], [r.description, .5]
        ])
      });
    });

    items.forEach(it => {
      // recency: 0 (old) .. 1 (recent), small influence
      it.recency = it.year ? Math.max(0, Math.min(1, (it.year - 2010) / (nowYear - 2010))) : 0.3;
    });
    return items;
  }

  // ------------------------------------------------------------------ scoring
  function score(item, qTokens, typeBias) {
    let s = 0;
    const matched = new Set();
    qTokens.forEach(t => {
      let w = item.tokens.get(t) || 0;
      if (!w && t.length >= 4) {
        // light prefix fallback for compound tokens (e.g. "pointcloud" ~ "point").
        // Prefix-only avoids spurious hits like "underwater" matching "water".
        for (const [tok, tw] of item.tokens) {
          if (tok.length >= 4 && (tok.startsWith(t) || t.startsWith(tok))) { w = Math.max(w, tw * 0.5); break; }
        }
      }
      if (w > 0) { s += w; matched.add(t); }
    });
    if (s === 0) return null;
    s *= (typeBias[item.type] || 1);
    s += s * 0.08 * item.recency;          // gentle recency nudge
    s += Math.min(matched.size, 4) * 0.6;   // reward breadth of match
    return { score: s, matched: Array.from(matched) };
  }

  function retrieve(index, query, limit) {
    const qNorm = norm(query);
    const baseTokens = qNorm.split(' ').filter(t => t && !STOP.has(t) && t.length > 1);
    const qTokens = expand(baseTokens);
    const typeBias = detectTypeBias(qNorm);
    const scored = [];
    index.forEach(item => {
      const r = score(item, qTokens, typeBias);
      // Floor: drop weak/incidental matches so a nonsense query honestly
      // returns "no match" instead of padding with irrelevant cards.
      if (r && r.score >= 3) scored.push({ item, score: r.score, matched: r.matched });
    });
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, limit || 6), tokens: baseTokens };
  }

  // ----------------------------------------------------------------- citation
  function citation(item) {
    const bits = [];
    if (item.type === 'dataset') {
      if (item.authors) bits.push(esc(authorsEtAl(item.authors)));
      if (item.year) bits.push('(' + item.year + ')');
      const meta = [];
      if (item.modality) meta.push(esc(item.modality));
      if (item.count) meta.push((typeof item.count === 'number' ? item.count.toLocaleString() : esc(item.count)) + ' samples');
      if (item.license) meta.push(esc(item.license));
      let line = bits.join(' ');
      if (meta.length) line += (line ? ' · ' : '') + meta.join(' · ');
      if (item.doi) line += ' · <a href="' + esc(item.doi) + '" target="_blank" rel="noopener">DOI</a>';
      return line;
    }
    if (item.type === 'model') {
      if (item.authors) bits.push(esc(authorsEtAl(item.authors)));
      if (item.year) bits.push('(' + item.year + ')');
      let line = bits.join(' ');
      const links = [];
      if (item.paper) links.push('<a href="' + esc(item.paper) + '" target="_blank" rel="noopener">Paper</a>');
      else if (item.doi) links.push('<a href="' + esc(item.doi) + '" target="_blank" rel="noopener">DOI</a>');
      if (item.code) links.push('<a href="' + esc(item.code) + '" target="_blank" rel="noopener">Code</a>');
      if (item.license) line += (line ? ' · ' : '') + esc(item.license);
      if (links.length) line += (line ? ' · ' : '') + links.join(' · ');
      return line;
    }
    if (item.type === 'workflow') {
      const who = item.companies && item.companies.length ? item.companies.join(', ') : (item.provider || '');
      if (who) bits.push(esc(who));
      if (item.year) bits.push('(' + item.year + ')');
      const meta = [item.phase, item.stage, item.evidence].filter(Boolean).map(esc);
      let line = bits.join(' ');
      if (meta.length) line += (line ? ' · ' : '') + meta.join(' · ');
      return line;
    }
    // oer
    if (item.provider) bits.push(esc(item.provider));
    if (item.year) bits.push('(' + item.year + ')');
    let line = bits.join(' ');
    if (item.topics && item.topics.length) line += (line ? ' · ' : '') + esc(item.topics.slice(0, 3).join(', '));
    if (item.license) line += (line ? ' · ' : '') + esc(item.license);
    return line;
  }

  const TYPE_LABEL = { dataset: 'Dataset', model: 'Model', workflow: 'Workflow', oer: 'Education' };
  const GROUP_ORDER = ['dataset', 'model', 'workflow', 'oer'];

  // -------------------------------------------------------------------- render
  function renderAnswer(panel, query, retrieved) {
    const { results, tokens } = retrieved;
    if (!results.length) {
      panel.hidden = false;
      panel.innerHTML =
        '<div class="oc-assistant-head">' +
          '<div class="oc-assistant-avatar">OC</div>' +
          '<div><div class="oc-assistant-intro">I could not find a catalog match for ' +
          '<strong>"' + esc(query) + '"</strong>.</div>' +
          '<div class="oc-assistant-sub">Try a task or modality, e.g. "crack detection dataset", ' +
          '"point cloud segmentation model", or "construction management course".</div></div></div>' +
        '<div class="oc-assistant-empty">Every answer here is grounded only in real OpenConstruction ' +
        'catalog entries — so when there is no match, I say so rather than invent one.</div>';
      return;
    }

    const n = results.length;
    const types = Array.from(new Set(results.map(r => r.item.type)));
    const typeText = types.map(t => TYPE_LABEL[t].toLowerCase() + (t === 'oer' ? ' resources' : 's')).join(', ');

    let html =
      '<div class="oc-assistant-head">' +
        '<div class="oc-assistant-avatar">OC</div>' +
        '<div>' +
          '<div class="oc-assistant-intro">Here ' + (n === 1 ? 'is' : 'are') + ' <strong>' + n +
            '</strong> ' + esc(typeText) + ' in the OpenConstruction catalog that match ' +
            '<strong>"' + esc(query) + '"</strong>.</div>' +
          '<div class="oc-assistant-sub">Ranked by relevance. Each card links to its catalog entry and original source.</div>' +
        '</div>' +
      '</div><div class="oc-assistant-body">';

    let rank = 0;
    GROUP_ORDER.forEach(type => {
      const group = results.filter(r => r.item.type === type);
      if (!group.length) return;
      html += '<div class="oc-rec-group-title">' + esc(TYPE_LABEL[type]) +
              (group.length > 1 ? 's' : '') + '</div>';
      group.forEach(({ item, matched }) => {
        rank += 1;
        const terms = matched.slice(0, 5).map(t => '<span class="oc-rec-term">' + esc(t) + '</span>').join('');
        html +=
          '<a class="oc-rec" href="' + esc(item.href) + '"' +
            (item.external ? ' target="_blank" rel="noopener"' : '') + '>' +
            '<span class="oc-rec-rank">' + rank + '</span>' +
            '<span class="oc-rec-main">' +
              '<span class="oc-rec-type is-' + item.type + '">' + esc(TYPE_LABEL[item.type]) + '</span>' +
              '<div class="oc-rec-title">' + esc(item.title) + '</div>' +
              '<div class="oc-rec-cite">' + citation(item) + '</div>' +
              (terms ? '<div class="oc-rec-why"><span class="oc-rec-why-label">matched:</span>' + terms + '</div>' : '') +
            '</span>' +
          '</a>';
      });
    });

    html += '</div>' +
      '<div class="oc-assistant-foot">' +
        '<span class="oc-foot-badge">⚡ Runs in your browser — no server, no API cost</span>' +
        '<span>Want conversational answers? <a href="mcp.html">Connect your own Claude via MCP →</a></span>' +
      '</div>';

    panel.hidden = false;
    panel.innerHTML = html;
  }

  // Expose pure retrieval internals for testing (no-op in the browser).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { norm, expand, buildIndex, retrieve, citation };
  }

  // ----------------------------------------------------------------- bootstrap
  if (typeof document === 'undefined') return; // node test context: skip DOM wiring
  document.addEventListener('DOMContentLoaded', async function () {
    const form = document.getElementById('homeSearchForm');
    const input = document.getElementById('homeSearchInput');
    const hero = document.querySelector('.hero-search');
    if (!form || !input || !hero) return; // only on the home page

    // --- inject mode toggle + ask button + examples + panel ---
    const modes = document.createElement('div');
    modes.className = 'oc-search-modes';
    modes.innerHTML =
      '<button type="button" class="oc-search-mode" data-mode="search" aria-pressed="true">Search</button>' +
      '<button type="button" class="oc-search-mode" data-mode="ask" aria-pressed="false">' +
        '<span class="oc-mode-spark">✨</span> Ask the assistant</button>';
    hero.parentNode.insertBefore(modes, hero);

    const askWrap = document.createElement('div');
    askWrap.className = 'oc-ask-submit';
    askWrap.innerHTML = '<button type="button" class="oc-ask-btn" id="ocAskBtn">Ask the catalog</button>';

    const examples = document.createElement('div');
    examples.className = 'oc-ask-examples oc-ask-submit';
    ['crack detection dataset', 'point cloud segmentation model', 'PPE / hardhat safety detection',
     'construction management course', 'BIM in real-world deployments'].forEach(q => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'oc-ask-example'; b.textContent = q;
      examples.appendChild(b);
    });

    const panel = document.createElement('div');
    panel.className = 'oc-assistant';
    panel.id = 'ocAssistant';
    panel.hidden = true;

    hero.appendChild(askWrap);
    hero.appendChild(examples);
    hero.parentNode.insertBefore(panel, hero.nextSibling);

    // --- state + data (lazy) ---
    let askMode = false;
    let indexPromise = null;
    function ensureIndex() {
      if (!indexPromise) {
        indexPromise = (async () => {
          const [datasets, models, usecases, oers] = await Promise.all([
            loadJson('datasets.json'), loadJson('models.json'),
            loadJson('use-cases.json'), loadJson('oer.json')
          ]);
          return buildIndex({ datasets, models, usecases, oers });
        })();
      }
      return indexPromise;
    }

    async function runAsk() {
      const q = input.value.trim();
      if (!q) { panel.hidden = true; return; }
      panel.hidden = false;
      panel.innerHTML = '<div class="oc-assistant-empty">Searching the catalog…</div>';
      const index = await ensureIndex();
      renderAnswer(panel, q, retrieve(index, q, 6));
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function setMode(mode) {
      askMode = (mode === 'ask');
      document.body.classList.toggle('oc-ask-mode', askMode);
      modes.querySelectorAll('.oc-search-mode').forEach(btn =>
        btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false'));
      input.placeholder = askMode
        ? 'Describe what you need, e.g. "datasets for concrete crack detection" …'
        : 'Search resources, authors, titles, or keywords ...';
      if (askMode) { ensureIndex(); input.focus(); }
      else { panel.hidden = true; }
    }

    modes.addEventListener('click', e => {
      const btn = e.target.closest('.oc-search-mode');
      if (btn) setMode(btn.dataset.mode);
    });
    document.getElementById('ocAskBtn').addEventListener('click', runAsk);
    examples.addEventListener('click', e => {
      const b = e.target.closest('.oc-ask-example');
      if (!b) return;
      if (!askMode) setMode('ask');
      input.value = b.textContent;
      runAsk();
    });

    // Intercept Enter/submit while in Ask mode BEFORE the existing handler
    // (capture phase) so the page does not navigate to the first keyword hit.
    form.addEventListener('submit', e => {
      if (askMode) { e.preventDefault(); e.stopImmediatePropagation(); runAsk(); }
    }, true);
  });
})();
