// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// workspace.js — OCWorkspace: the chat-workspace state-machine (Phase-C component #4, the assembly).
// Wires the three leaf components (OCTrust · OCSuitability · OCStarterKit) + the deterministic engine
// (OCDataAgent) + retrieval (OCMethods) into one flow: discover → understand → evaluate → retrieve → use.
// Two-way chat <-> canvas via a single dispatch().
//
// HARD RULE (research integrity): every stage renders REAL engine output. Where the engine has no datum
// (e.g. BIM/point-cloud content profiling — C3 is weak), the canvas shows an honest "metadata-level" /
// "not available" / abstention state — never a fabricated number or result. Leaf components are reused
// (no duplicated badge/checklist/notebook code).
//
// DOM contract (data-agent.html): #wsStages #wsChatLog #wsChatInput #wsChatSend #wsCanvas

(function () {
  'use strict';
  var W = (typeof window !== 'undefined') ? window : null;
  if (!W) return;
  function $(id) { return document.getElementById(id); }
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function A() { return W.OCDataAgent || null; }

  var STAGES = ['discover', 'understand', 'evaluate', 'retrieve', 'use'];
  var STAGE_LABEL = { discover: 'Discover', understand: 'Understand', evaluate: 'Evaluate', retrieve: 'Retrieve', use: 'Use' };

  var ctx = { query: '', need: null, dataset: null, stage: 'discover', corpus: null, mode: 'bm25', candidates: [] };
  var els = {};

  // ----------------------------------------------------------- styles
  function ensureStyles() {
    if ($('oc-ws-css')) return;
    var s = document.createElement('style'); s.id = 'oc-ws-css';
    s.textContent =
      '.ws-stages{display:flex;gap:.4rem;flex-wrap:wrap;margin:.2rem 0 .8rem;}' +
      '.ws-stage{font-size:.78rem;font-weight:700;border:1px solid #e7edf3;background:#f8fafc;color:#667085;border-radius:999px;padding:.25rem .8rem;cursor:pointer;}' +
      '.ws-stage.active{background:#0f2e4b;color:#fff;border-color:#0f2e4b;}' +
      '.ws-stage.done{color:#067647;border-color:#abefc6;background:#ecfdf3;}' +
      '.ws-grid{display:grid;grid-template-columns:320px 1fr;gap:1rem;align-items:start;}' +
      '@media(max-width:840px){.ws-grid{grid-template-columns:1fr;}}' +
      '.ws-chat{border:1px solid #e7edf3;border-radius:12px;background:#fff;display:flex;flex-direction:column;height:520px;}' +
      '.ws-log{flex:1;overflow-y:auto;padding:.7rem;display:flex;flex-direction:column;gap:.5rem;background:#f8fafc;}' +
      '.ws-msg{font-size:.84rem;border-radius:10px;padding:.45rem .6rem;max-width:95%;}' +
      '.ws-msg.user{align-self:flex-end;background:#0f2e4b;color:#fff;}' +
      '.ws-msg.bot{align-self:flex-start;background:#fff;border:1px solid #e7edf3;color:#1e2a36;}' +
      '.ws-foot{display:flex;gap:.4rem;padding:.5rem;border-top:1px solid #e7edf3;}' +
      '.ws-input{flex:1;border:1px solid #e7edf3;border-radius:999px;padding:.45rem .8rem;font-size:.86rem;outline:none;}' +
      '.ws-send{border:0;background:#f2a238;color:#3a2606;border-radius:999px;padding:.45rem .9rem;font-weight:700;cursor:pointer;}' +
      '.ws-canvas{border:1px solid #e7edf3;border-radius:12px;background:#fff;padding:.8rem .9rem;min-height:520px;}' +
      '.ws-card{border:1px solid #e7edf3;border-radius:10px;padding:.55rem .7rem;margin:.4rem 0;}' +
      '.ws-card .nm{font-weight:700;color:#0f2e4b;}' +
      '.ws-pick{border:1px solid #0b66c3;background:#fff;color:#0b66c3;border-radius:999px;padding:.15rem .6rem;font-size:.76rem;font-weight:700;cursor:pointer;}' +
      '.ws-next{border:0;background:#0f2e4b;color:#fff;border-radius:999px;padding:.35rem .9rem;font-weight:700;cursor:pointer;margin-top:.6rem;font-size:.82rem;}' +
      '.ws-honest{background:#fffaeb;border:1px solid #fedf89;color:#b54708;border-radius:8px;padding:.45rem .6rem;font-size:.8rem;margin:.4rem 0;}' +
      '.ws-h{font-weight:800;color:#0f2e4b;font-size:.95rem;margin:.1rem 0 .4rem;}' +
      '.ws-muted{color:#667085;font-size:.82rem;} pre.ws-nb{background:#0f2e4b;color:#e9f1f8;padding:.6rem;border-radius:8px;font-size:.7rem;max-height:260px;overflow:auto;white-space:pre;}';
    document.head.appendChild(s);
  }

  // ----------------------------------------------------------- chat
  function chat(role, html) {
    if (!els.log) return;
    var d = document.createElement('div'); d.className = 'ws-msg ' + role; d.innerHTML = html;
    els.log.appendChild(d); els.log.scrollTop = els.log.scrollHeight;
  }

  // ----------------------------------------------------------- stage rail
  function renderStages() {
    if (!els.stages) return;
    var maxReached = ctx.dataset ? STAGES.indexOf(ctx.stage) : 0;
    els.stages.innerHTML = STAGES.map(function (st, i) {
      var cls = 'ws-stage' + (st === ctx.stage ? ' active' : (i < STAGES.indexOf(ctx.stage) ? ' done' : ''));
      return '<button class="' + cls + '" data-stage="' + st + '">' + (i + 1) + '. ' + STAGE_LABEL[st] + '</button>';
    }).join('');
    Array.prototype.forEach.call(els.stages.querySelectorAll('.ws-stage'), function (b) {
      b.addEventListener('click', function () {
        var st = b.getAttribute('data-stage');
        if (st !== 'discover' && !ctx.dataset) { chat('bot', 'Pick a dataset first (Discover).'); return; }
        dispatch({ type: 'goStage', stage: st });
      });
    });
  }

  // ----------------------------------------------------------- canvas renderers (REAL engine)
  function clearCanvas() { if (els.canvas) els.canvas.innerHTML = ''; }
  function nextBtn(label, stage) {
    var b = document.createElement('button'); b.className = 'ws-next'; b.textContent = label;
    b.addEventListener('click', function () { dispatch({ type: 'goStage', stage: stage }); });
    return b;
  }

  function renderDiscover() {
    clearCanvas();
    els.canvas.innerHTML = '<div class="ws-h">1 · Discover</div><div class="ws-muted">Running retrieval over the real catalog…</div>';
    var need = ctx.need;
    var done = function (rows) {
      ctx.candidates = rows;
      var html = '<div class="ws-h">1 · Discover <span class="ws-muted">(' + esc(ctx.mode) + ' · ' + rows.length + ' hits)</span></div>';
      if (!rows.length) html += '<div class="ws-honest">No candidate matched a hard facet — the engine returns nothing rather than guess.</div>';
      els.canvas.innerHTML = html;
      rows.slice(0, 8).forEach(function (r) {
        var rec = ctx.corpus.byId.get(norm(r.id));
        var card = document.createElement('div'); card.className = 'ws-card';
        card.innerHTML = '<div><span class="nm">' + esc(r.name || (rec && rec.name) || r.id) + '</span>' +
          (r.score != null ? ' <span class="ws-muted">score ' + esc(typeof r.score === 'number' ? r.score.toFixed(3) : r.score) + '</span>' : '') +
          ' <button class="ws-pick" data-id="' + esc(r.id) + '">Analyze →</button></div>';
        if (rec && W.OCTrust) W.OCTrust.render(card, { record: rec, need: need, corpus: ctx.corpus });
        els.canvas.appendChild(card);
        card.querySelector('.ws-pick').addEventListener('click', function () { dispatch({ type: 'selectDataset', id: this.getAttribute('data-id') }); });
      });
    };
    // prefer OCMethods (spec); fall back to deterministic c1Discovery if retrieval modules absent
    if (W.OCMethods && W.OCRagBaseline) {
      W.OCMethods.run(ctx.mode, ctx.query, {}).then(function (out) { done(out.rows || []); })
        .catch(function () { done(discoverEngine()); });
    } else { done(discoverEngine()); }
  }
  function discoverEngine() {
    var a = A(); if (!a) return [];
    return a.c1Discovery(ctx.corpus, ctx.need).map(function (c) { return { id: c.rec.id, name: c.rec.name, score: c.score }; });
  }

  function modalityKind(rec) {
    var hay = ((rec.modality || []).join(' ') + ' ' + (rec.modalityRaw || '')).toLowerCase();
    if (/point|lidar|\.ply|\.las|\.pcd|e57/.test(hay)) return 'point_cloud';
    if (/\bbim\b|ifc/.test(hay)) return 'bim';
    return 'other';
  }
  function renderUnderstand() {
    clearCanvas();
    var rec = ctx.dataset, a = A();
    if (!rec || !a) { els.canvas.innerHTML = '<div class="ws-honest">No dataset selected.</div>'; return; }
    var u = a.c2Understand(rec);
    var html = '<div class="ws-h">2 · Understand — ' + esc(rec.name || rec.id) + '</div>' +
      '<div class="ws-muted">' + esc(u.summary) + '</div>';
    var kind = modalityKind(rec);
    if (kind === 'point_cloud' || kind === 'bim') {
      html += '<div class="ws-honest"><strong>Content profiling not available here (C3 is weak for ' + kind +
        ').</strong> This is a <em>metadata-level</em> view only. Open the client-side viewer to inspect the file — ' +
        'no numeric profile is fabricated. <br><a href="viewer.html?title=' + encodeURIComponent(rec.name || rec.id) + '" target="_blank" rel="noopener">Open viewer →</a></div>';
    } else {
      html += '<div class="ws-honest">Understanding is <em>metadata-level</em> (modality/annotation/license/counts from the catalog record). File-content profiling is not run in the browser.</div>';
    }
    els.canvas.innerHTML = html;
    els.canvas.appendChild(nextBtn('Evaluate fitness →', 'evaluate'));
  }

  function renderEvaluate() {
    clearCanvas();
    els.canvas.innerHTML = '<div class="ws-h">3 · Evaluate</div>';
    if (W.OCSuitability && ctx.dataset) W.OCSuitability.render(els.canvas, ctx.dataset, ctx.need, { corpus: ctx.corpus });
    else els.canvas.innerHTML += '<div class="ws-honest">OCSuitability not loaded.</div>';
    els.canvas.appendChild(nextBtn('How to get it →', 'retrieve'));
  }

  function renderRetrieve() {
    clearCanvas();
    var rec = ctx.dataset, a = A();
    var html = '<div class="ws-h">4 · Retrieve / access</div>';
    if (rec && a) {
      var cls = a.classifyAccess ? a.classifyAccess(rec) : 'unknown';
      var info = (rec.access && a.classifyUrl) ? a.classifyUrl(rec.access) : null;
      html += '<div class="ws-card"><div><strong>Access status:</strong> ' + esc(cls) +
        (info ? ' <span class="ws-muted">(' + esc(info.repository) + ')</span>' : '') + '</div>' +
        '<div><strong>Source:</strong> ' + (rec.access ? '<a href="' + esc(rec.access) + '" target="_blank" rel="noopener">' + esc(rec.access) + '</a>' : '<span class="ws-muted">not specified</span>') + '</div>' +
        '<div><strong>Provenance:</strong> ' + esc(rec.doi || rec.paper || 'not specified') + '</div></div>';
      els.canvas.innerHTML = html;
      if (W.OCTrust) W.OCTrust.render(els.canvas, { record: rec, need: ctx.need, corpus: ctx.corpus });
    } else { els.canvas.innerHTML = html + '<div class="ws-honest">No dataset selected.</div>'; }
    els.canvas.appendChild(nextBtn('Generate starter-kit →', 'use'));
  }

  function renderUse() {
    clearCanvas();
    var rec = ctx.dataset;
    els.canvas.innerHTML = '<div class="ws-h">5 · Use — starter-kit</div>';
    if (!rec || !W.OCStarterKit) { els.canvas.innerHTML += '<div class="ws-honest">OCStarterKit not loaded / no dataset.</div>'; return; }
    var out = W.OCStarterKit.build(rec, ctx.need);
    var valid = false; try { valid = JSON.parse(out.nbString).nbformat === 4; } catch (e) {}
    els.canvas.innerHTML += '<div class="ws-muted">nbformat-4: ' + (valid ? 'valid ✓' : 'invalid ✕') + ' · <code>' + esc(out.filename) + '</code> · no training is run on a server; runs in Colab/your machine.</div>' +
      (out.notes.length ? '<div class="ws-honest">notes: ' + esc(out.notes.join(' · ')) + '</div>' : '') +
      '<pre class="ws-nb">' + esc(out.nbString.slice(0, 1800)) + '\n…</pre>';
    var b = document.createElement('button'); b.className = 'ws-next'; b.textContent = '⬇ Download ' + out.filename;
    b.addEventListener('click', function () { W.OCStarterKit.download(rec, ctx.need); chat('bot', 'Generated <strong>' + esc(out.filename) + '</strong> (metadata-grounded scaffold, no server training).'); });
    els.canvas.appendChild(b);
  }

  function renderStage() {
    ensureStyles(); renderStages();
    if (ctx.stage === 'discover') renderDiscover();
    else if (ctx.stage === 'understand') renderUnderstand();
    else if (ctx.stage === 'evaluate') renderEvaluate();
    else if (ctx.stage === 'retrieve') renderRetrieve();
    else if (ctx.stage === 'use') renderUse();
  }

  // ----------------------------------------------------------- dispatch (chat <-> canvas bus)
  function dispatch(action) {
    var a = A();
    switch (action.type) {
      case 'setQuery':
        ctx.query = action.query; ctx.need = a ? a.parseNeed(action.query) : null; ctx.dataset = null; ctx.stage = 'discover';
        chat('user', esc(action.query));
        chat('bot', 'Parsed need → <code>' + esc(JSON.stringify({ task: ctx.need && ctx.need.task, modality: ctx.need && ctx.need.modality, annotation: ctx.need && ctx.need.annotation, license: ctx.need && ctx.need.license })) + '</code>. Discovering…');
        renderStage(); break;
      case 'selectDataset':
        ctx.dataset = ctx.corpus.byId.get(norm(action.id)) || null; ctx.stage = 'understand';
        chat('bot', ctx.dataset ? 'Selected <strong>' + esc(ctx.dataset.name || ctx.dataset.id) + '</strong> → Understand.' : 'Could not resolve that dataset.');
        renderStage(); break;
      case 'goStage':
        ctx.stage = action.stage; chat('bot', 'Stage → <strong>' + STAGE_LABEL[action.stage] + '</strong>.'); renderStage(); break;
    }
  }

  // ----------------------------------------------------------- chat command parsing (minimal, deterministic)
  function handleChat(text) {
    var t = text.trim(); if (!t) return;
    var low = t.toLowerCase();
    if (ctx.dataset && /(notebook|starter|kit|tải|download|use)\b/.test(low)) { chat('user', esc(t)); return dispatch({ type: 'goStage', stage: 'use' }); }
    if (ctx.dataset && /(đánh giá|evaluate|fit|suitab|phù hợp)/.test(low)) { chat('user', esc(t)); return dispatch({ type: 'goStage', stage: 'evaluate' }); }
    if (ctx.dataset && /(access|license|provenance|retrieve|lấy|nguồn)/.test(low)) { chat('user', esc(t)); return dispatch({ type: 'goStage', stage: 'retrieve' }); }
    // otherwise treat as a (new) discovery query
    dispatch({ type: 'setQuery', query: t });
  }

  // ----------------------------------------------------------- bridge: search/detail → workspace
  // Reads data-agent.html?id=&q=&task= . With id → jump to Understand on that real record; with only q → Discover.
  function autoBoot() {
    var a = A(); if (!a || !ctx.corpus) return false;
    var p; try { p = new URLSearchParams(location.search); } catch (e) { return false; }
    var id = p.get('id'), q = p.get('q'), task = p.get('task');
    if (id) {
      ctx.query = q || '';
      ctx.need = a.parseNeed(((q || '') + ' ' + (task || '')).trim());  // valid even if empty
      var rec = ctx.corpus.byId.get(norm(id));
      if (rec) {
        ctx.dataset = rec; ctx.stage = 'understand';
        chat('bot', 'Opened from search: <strong>' + esc(rec.name || rec.id) + '</strong>' +
          (ctx.need && ctx.need.task ? ' · task <em>' + esc(ctx.need.task) + '</em>' : '') + ' → Understand.');
        renderStage(); return true;
      }
      chat('bot', 'Could not resolve dataset id "' + esc(id) + '" in the catalog.');
    }
    if (q) { dispatch({ type: 'setQuery', query: q }); return true; }
    return false;
  }

  // ----------------------------------------------------------- init
  function init() {
    els = { stages: $('wsStages'), log: $('wsChatLog'), input: $('wsChatInput'), send: $('wsChatSend'), canvas: $('wsCanvas') };
    if (!els.canvas) return; // not the workspace page
    ensureStyles();
    var a = A();
    if (!a || !a.loadCorpus) { els.canvas.innerHTML = '<div class="ws-honest">Engine (OCDataAgent) not loaded.</div>'; return; }
    chat('bot', 'Ask for a dataset (e.g. <em>“object detection with bounding boxes, commercial use”</em>). I run the deterministic engine — and abstain when nothing fits.');
    a.loadCorpus().then(function (corpus) {
      ctx.corpus = corpus;
      if (!ctx.need) ctx.need = a.parseNeed('');   // always a valid need object (empty = no hard constraint)
      renderStages();
      // bridge: if data-agent.html was opened with ?id / ?q (from search/detail), boot straight into context
      if (!autoBoot()) els.canvas.innerHTML = '<div class="ws-muted">Corpus loaded: <strong>' + corpus.datasets.length + '</strong> datasets. State a need to begin.</div>';
    }).catch(function (e) { els.canvas.innerHTML = '<div class="ws-honest">Could not load catalog: ' + esc(e && e.message || e) + '</div>'; });

    if (els.send) els.send.addEventListener('click', function () { var v = els.input.value; els.input.value = ''; handleChat(v); });
    if (els.input) els.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var v = els.input.value; els.input.value = ''; handleChat(v); } });
  }

  W.OCWorkspace = { ctx: ctx, dispatch: dispatch, handleChat: handleChat, init: init, bootFromParams: autoBoot };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
