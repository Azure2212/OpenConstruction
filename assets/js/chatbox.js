// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// Floating chatbox — a conversational front end for the catalog assistant.
// It reuses the SAME client-side retrieval engine as the search-bar "Ask" mode
// (window.OCAssistant), so answers are grounded, citation-based, and cost $0:
// no server, no LLM API. Multi-turn chat log; every card links to a real entry.

(function () {
  'use strict';
  if (window.__ocbotLoaded) return; window.__ocbotLoaded = true;

  // On detail pages (datasets/…, models/…) catalog hrefs need a "../" prefix.
  var SUBDIR = /\/(datasets|models|workflows|oers)\//.test(location.pathname);
  function fixHref(item) {
    var h = item.href || '#';
    if (/^https?:/i.test(h)) return h;
    return SUBDIR ? '../' + h : h;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---- styles (namespaced .ocbot-*) ----
  var css = document.createElement('style');
  css.textContent = [
    '.ocbot-fab{position:fixed;right:20px;bottom:20px;z-index:1080;width:58px;height:58px;border-radius:50%;',
    'border:0;background:#0f2e4b;color:#fff;box-shadow:0 10px 28px rgba(15,46,75,.32);cursor:pointer;font-size:1.5rem;display:grid;place-items:center;transition:transform .15s ease;}',
    '.ocbot-fab:hover{transform:scale(1.06);}',
    '.ocbot-fab .ocbot-spark{position:absolute;top:-2px;right:-2px;width:18px;height:18px;background:#f2a238;border-radius:50%;font-size:.7rem;display:grid;place-items:center;color:#3a2606;font-weight:800;}',
    '.ocbot-panel{position:fixed;right:20px;bottom:20px;z-index:1081;width:378px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 40px);',
    'background:#fff;border:1px solid #e7edf3;border-radius:16px;box-shadow:0 24px 60px rgba(15,46,75,.28);display:none;flex-direction:column;overflow:hidden;font-family:Inter,system-ui,sans-serif;}',
    '.ocbot-panel.open{display:flex;}',
    '.ocbot-head{display:flex;align-items:center;gap:.6rem;padding:.85rem 1rem;background:linear-gradient(120deg,#0f2e4b,#123c62);color:#fff;}',
    '.ocbot-head .av{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.16);display:grid;place-items:center;font-weight:800;font-size:.85rem;}',
    '.ocbot-head .t{font-weight:700;font-size:.95rem;line-height:1.1;}',
    '.ocbot-head .s{font-size:.72rem;opacity:.8;}',
    '.ocbot-head .x{margin-left:auto;background:0;border:0;color:#fff;font-size:1.3rem;cursor:pointer;opacity:.85;line-height:1;}',
    '.ocbot-log{flex:1;overflow-y:auto;padding:1rem .9rem;background:#f8fafc;display:flex;flex-direction:column;gap:.7rem;}',
    '.ocbot-msg{max-width:88%;font-size:.88rem;line-height:1.45;border-radius:13px;padding:.55rem .75rem;}',
    '.ocbot-msg.user{align-self:flex-end;background:#0f2e4b;color:#fff;border-bottom-right-radius:4px;}',
    '.ocbot-msg.bot{align-self:flex-start;background:#fff;color:#1e2a36;border:1px solid #e7edf3;border-bottom-left-radius:4px;}',
    '.ocbot-cards{display:flex;flex-direction:column;gap:.45rem;margin-top:.5rem;}',
    '.ocbot-card{display:block;text-decoration:none;border:1px solid #e7edf3;border-radius:10px;padding:.5rem .6rem;background:#fff;}',
    '.ocbot-card:hover{background:#fbfdff;border-color:#f2a238;}',
    '.ocbot-ctype{font-size:.62rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:#123c62;padding:.04rem .35rem;border-radius:4px;}',
    '.ocbot-ctype.dataset{background:#1f6f54;}.ocbot-ctype.model{background:#123c62;}.ocbot-ctype.workflow{background:#8a5418;}.ocbot-ctype.oer{background:#5b3a8a;}.ocbot-ctype.skill{background:#0f2e4b;}',
    '.ocbot-ctitle{font-weight:700;color:#0f2e4b;font-size:.84rem;margin-top:.2rem;}',
    '.ocbot-ccite{color:#4f5d6c;font-size:.76rem;margin-top:.1rem;}.ocbot-ccite a{color:#0b66c3;}',
    '.ocbot-chips{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.3rem;}',
    '.ocbot-chip{font-size:.76rem;border:1px dashed #cfd9e4;background:#fff;color:#0b66c3;border-radius:999px;padding:.22rem .6rem;cursor:pointer;}',
    '.ocbot-chip:hover{border-style:solid;background:#f6f9fc;}',
    '.ocbot-foot{border-top:1px solid #e7edf3;padding:.55rem .7rem;background:#fff;}',
    '.ocbot-form{display:flex;gap:.4rem;}',
    '.ocbot-input{flex:1;border:1px solid #e7edf3;border-radius:999px;padding:.5rem .8rem;font-size:.86rem;outline:none;}',
    '.ocbot-input:focus{border-color:#86b7fe;}',
    '.ocbot-send{border:0;background:#f2a238;color:#3a2606;font-weight:800;border-radius:999px;padding:.5rem .9rem;cursor:pointer;}',
    '.ocbot-note{font-size:.68rem;color:#8a97a5;text-align:center;margin-top:.35rem;}.ocbot-note a{color:#0b66c3;}',
    '.ocbot-typing{display:inline-flex;gap:3px;}.ocbot-typing i{width:6px;height:6px;border-radius:50%;background:#9bb0c4;animation:ocbotb 1s infinite;}',
    '.ocbot-typing i:nth-child(2){animation-delay:.15s;}.ocbot-typing i:nth-child(3){animation-delay:.3s;}',
    '@keyframes ocbotb{0%,60%,100%{opacity:.3;transform:translateY(0);}30%{opacity:1;transform:translateY(-3px);}}',
    '.ocbot-mode-row{display:flex;align-items:center;gap:.4rem;margin-bottom:.45rem;}',
    '.ocbot-mode{flex:1;border:1px solid #e7edf3;border-radius:999px;padding:.34rem .7rem;font-size:.8rem;background:#fff;color:#0f2e4b;outline:none;cursor:pointer;}',
    '.ocbot-mode:focus{border-color:#86b7fe;}',
    '.ocbot-status{color:#4f5d6c;font-size:.82rem;margin-left:.4rem;}',
    '.ocbot-modetag{font-size:.64rem;font-weight:800;letter-spacing:.03em;color:#3a2606;background:#f2a238;border-radius:4px;padding:.05rem .32rem;}',
    '.ocbot-foot-note{color:#8a97a5;font-size:.72rem;margin-top:.4rem;}'
  ].join('');
  document.head.appendChild(css);

  var TYPE_LABEL = { dataset: 'Dataset', model: 'Model', workflow: 'Workflow', oer: 'Education', skill: 'Skill' };
  var SUGGESTIONS = ['crack detection dataset', 'point cloud segmentation model',
    'PPE / hardhat safety detection', 'construction management course', 'IFC quantity takeoff skill'];

  // ---- DOM ----
  var fab = document.createElement('button');
  fab.className = 'ocbot-fab';
  fab.setAttribute('aria-label', 'Open the OpenConstruction assistant');
  fab.innerHTML = '💬<span class="ocbot-spark">✨</span>';

  var panel = document.createElement('div');
  panel.className = 'ocbot-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'OpenConstruction assistant chat');
  panel.innerHTML =
    '<div class="ocbot-head"><div class="av" aria-hidden="true">OC</div>' +
      '<div><div class="t">OpenConstruction Assistant</div><div class="s">Grounded in the live catalog</div></div>' +
      '<button class="x" type="button" aria-label="Close assistant">×</button></div>' +
    '<div class="ocbot-log" id="ocbotLog" role="log" aria-live="polite" aria-atomic="false"></div>' +
    '<div class="ocbot-foot">' +
      '<form class="ocbot-form" id="ocbotForm">' +
        '<label class="visually-hidden" for="ocbotInput">Ask the assistant</label>' +
        '<input class="ocbot-input" id="ocbotInput" placeholder="Ask about datasets, models, skills…" autocomplete="off" aria-label="Ask the assistant">' +
        '<button class="ocbot-send" type="submit">Send</button>' +
      '</form>' +
      '<div class="ocbot-note">Runs in your browser — no API cost. ' +
        '<a href="' + (SUBDIR ? '../mcp.html' : 'mcp.html') + '">Use your own Claude via MCP →</a></div>' +
    '</div>';

  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(fab);
    document.body.appendChild(panel);

    // Some pages have a fixed "Suggest a …" button at bottom-right (.issue-btn)
    // in the same spot as our chat FAB. Stack the FAB above it so neither hides
    // the other; nudge the open panel up too so it clears the suggest button.
    if (document.querySelector('.issue-btn')) {
      fab.style.bottom = '88px';
      panel.style.bottom = '88px';
      panel.style.maxHeight = 'calc(100vh - 108px)';
    }
    var log = panel.querySelector('#ocbotLog');
    var form = panel.querySelector('#ocbotForm');
    var input = panel.querySelector('#ocbotInput');
    var greeted = false;

    // On pages where the in-browser methods are loaded (oc-methods.js, e.g. the home page), add a
    // method selector to the chat (BM25 / RAG-dense / LLM-agent, default RAG-dense). Elsewhere the
    // chatbox keeps its existing keyword-assistant behavior unchanged.
    if (window.OCMethods) {
      var foot = panel.querySelector('.ocbot-foot');
      var modeRow = document.createElement('div');
      modeRow.className = 'ocbot-mode-row';
      modeRow.innerHTML = '<label class="visually-hidden" for="ocbotMode">Retrieval method</label>' +
        '<select class="ocbot-mode" id="ocbotMode" aria-label="Retrieval method">' +
          '<option value="bm25">BM25 (lexical)</option>' +
          '<option value="dense" selected>RAG-dense (bge-small)</option>' +
          '<option value="hybrid">Hybrid (BM25 + RAG-dense)</option>' +
          '<option value="agent">LLM-agent (Qwen2.5)</option>' +
        '</select>';
      if (foot) foot.insertBefore(modeRow, foot.firstChild);
      if (window.OCMethods.ensureCorpus) window.OCMethods.ensureCorpus().catch(function () {});
    }

    function scroll() { log.scrollTop = log.scrollHeight; }
    function addUser(text) {
      var d = document.createElement('div'); d.className = 'ocbot-msg user'; d.textContent = text;
      log.appendChild(d); scroll();
    }
    function addBot(html) {
      var d = document.createElement('div'); d.className = 'ocbot-msg bot'; d.innerHTML = html;
      log.appendChild(d); scroll(); return d;
    }
    function chips() {
      return '<div class="ocbot-chips">' + SUGGESTIONS.map(function (s) {
        return '<button class="ocbot-chip" data-q="' + esc(s) + '">' + esc(s) + '</button>';
      }).join('') + '</div>';
    }
    function greet() {
      if (greeted) return; greeted = true;
      addBot('Hi! I can search OpenConstruction’s datasets, models, workflows, education, and skills — ' +
        'and I always cite the source. What are you working on?' + chips());
    }

    function cardHtml(r) {
      var it = r.item;
      var cite = (window.OCAssistant && window.OCAssistant.citation) ? window.OCAssistant.citation(it) : '';
      var ext = /^https?:/i.test(it.href || '') || it.external;
      return '<a class="ocbot-card" href="' + esc(fixHref(it)) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' +
        '<span class="ocbot-ctype ' + it.type + '">' + esc(TYPE_LABEL[it.type] || it.type) + '</span>' +
        '<div class="ocbot-ctitle">' + esc(it.title) + '</div>' +
        '<div class="ocbot-ccite">' + cite + '</div></a>';
    }

    // Existing catalog assistant (keyword retrieval via window.OCAssistant) — kept as the fallback
    // for pages where the in-browser methods (oc-methods.js) are not loaded.
    async function answerAssistant(q) {
      var thinking = addBot('<span class="ocbot-typing"><i></i><i></i><i></i></span>');
      var eng = window.OCAssistant;
      if (!eng) { thinking.textContent = 'Assistant engine not loaded on this page.'; return; }
      var index = await eng.getIndex();
      var res = eng.retrieve(index, q, 4);
      if (!res.results.length) {
        thinking.innerHTML = 'I couldn’t find a catalog match for <strong>“' + esc(q) + '”</strong>. ' +
          'I only answer from real entries, so I won’t invent one. Try a task or modality.' + chips();
        return;
      }
      var n = res.results.length;
      thinking.innerHTML = 'Here ' + (n === 1 ? 'is' : 'are') + ' <strong>' + n + '</strong> catalog ' +
        (n === 1 ? 'match' : 'matches') + ' for “' + esc(q) + '”:' +
        '<div class="ocbot-cards">' + res.results.map(cardHtml).join('') + '</div>';
      scroll();
    }

    // In-browser retrieval methods (BM25 / RAG-dense / LLM-agent) via window.OCMethods, with a
    // live loading indicator (typing dots + status/progress while a model downloads/runs).
    function modeLabel(m) { return (window.OCMethods && window.OCMethods.LABELS && window.OCMethods.LABELS[m]) || m; }
    function rowCard(r) {
      var href = r.href ? fixHref({ href: r.href }) : '#';
      var ev = r.evidence ? [r.evidence.license ? ('License: ' + r.evidence.license) : '', r.evidence.scale, r.evidence.source].filter(Boolean).join(' · ') : '';
      var warn = (r.warnings && r.warnings.length) ? r.warnings.map(function (w) { return '⚠ ' + w.type; }).join('  ') : '';
      return '<a class="ocbot-card" href="' + esc(href) + '">' +
        '<span class="ocbot-ctype dataset">Dataset</span>' +
        '<div class="ocbot-ctitle">' + esc(r.name) + '</div>' +
        '<div class="ocbot-ccite">' + esc(r.id) + (r.meta ? (' · ' + esc(r.meta)) : '') + (r.reason ? (' — ' + esc(r.reason)) : '') + '</div>' +
        (ev ? '<div class="ocbot-ccite">' + esc(ev) + '</div>' : '') +
        (warn ? '<div class="ocbot-ccite" style="color:#b45309">' + esc(warn) + '</div>' : '') +
        '</a>';
    }
    async function answerMethod(q, mode) {
      var thinking = addBot('<span class="ocbot-typing"><i></i><i></i><i></i></span>');
      function setStatus(s) { thinking.innerHTML = '<span class="ocbot-typing"><i></i><i></i><i></i></span><span class="ocbot-status">' + esc(s) + '</span>'; scroll(); }
      function onProg(p) { if (p && p.status === 'progress' && p.total) { var pct = Math.round(p.loaded / p.total * 100); setStatus('Downloading ' + (p.file || '') + ' — ' + pct + '%'); } }
      try {
        var out = await window.OCMethods.run(mode, q, { onProgress: onProg, onStatus: setStatus });
        if (!out.rows.length) {
          thinking.innerHTML = 'No catalog match for <strong>“' + esc(q) + '”</strong> via ' + esc(modeLabel(mode)) + '. I only answer from real entries.' + chips();
          return;
        }
        var n = out.rows.length;
        thinking.innerHTML = 'Here ' + (n === 1 ? 'is' : 'are') + ' <strong>' + n + '</strong> dataset ' + (n === 1 ? 'match' : 'matches') +
          ' for “' + esc(q) + '” <span class="ocbot-modetag">' + esc(modeLabel(mode)) + '</span>:' +
          '<div class="ocbot-cards">' + out.rows.map(rowCard).join('') + '</div>' +
          (out.note ? '<div class="ocbot-foot-note">' + esc(out.note) + '</div>' : '');
        scroll();
      } catch (e) { thinking.innerHTML = esc((e && e.message) || String(e)); scroll(); }
    }
    function answer(q) {
      var modeSel = document.getElementById('ocbotMode');
      if (window.OCMethods && modeSel) return answerMethod(q, modeSel.value);
      return answerAssistant(q);
    }

    function send(q) {
      q = (q || '').trim(); if (!q) return;
      addUser(q); input.value = ''; answer(q);
    }

    function openChat(prefill) {
      panel.classList.add('open'); fab.style.display = 'none'; greet();
      if (prefill) input.value = prefill;
      input.focus();
      if (window.OCAssistant) window.OCAssistant.getIndex(); // warm cache
    }
    function closeChat() { panel.classList.remove('open'); fab.style.display = 'grid'; fab.focus(); }

    fab.addEventListener('click', function () { openChat(); });
    panel.querySelector('.x').addEventListener('click', closeChat);
    // Escape closes the panel (standard dialog behaviour).
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeChat(); });
    form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
    log.addEventListener('click', function (e) {
      var c = e.target.closest('.ocbot-chip'); if (c) send(c.dataset.q);
    });

    // Expose so per-page search bars can hand off to the assistant.
    window.OCChat = { open: openChat, close: closeChat, ask: function (q) { openChat(q); } };

    // --- "✨ Ask the assistant" buttons next to each page's keyword search ---
    // The per-page search keeps filtering that page's list; this button bridges
    // to the cross-catalog assistant (chatbox), pre-filling whatever was typed.
    var sparkCss = document.createElement('style');
    sparkCss.textContent =
      '.ocbot-ask-btn{display:inline-flex;align-items:center;gap:.3rem;border:1px solid #e7edf3;background:#fff;' +
      'color:#0f2e4b;font-weight:700;font-size:.8rem;border-radius:999px;padding:.32rem .7rem;cursor:pointer;white-space:nowrap;}' +
      '.ocbot-ask-btn:hover{border-color:#f2a238;background:#fffaf2;}' +
      '.navbar-search .ocbot-ask-btn{margin-left:.4rem;padding:.28rem .6rem;font-size:.76rem;}' +
      // our own in-box frame so the spark button sits INSIDE the search field
      '.ocbot-searchbox{display:flex;align-items:center;gap:.35rem;border:1px solid #e7edf3;border-radius:999px;' +
      'background:#fff;padding:.12rem .5rem;box-shadow:0 4px 14px rgba(15,46,75,.05);}' +
      '.ocbot-searchbox:focus-within{border-color:#86b7fe;}' +
      '.ocbot-searchbox > input,.ocbot-searchbox > input:focus{flex:1;min-width:0;border:0 !important;' +
      'outline:0 !important;box-shadow:none !important;background:transparent !important;}' +
      '.ocbot-searchbox .ocbot-ask-btn{flex:0 0 auto;border-color:#eef3f8;}' +
      '.ocbot-searchbox.compact{border-radius:9px;padding:.04rem .35rem;}';
    document.head.appendChild(sparkCss);

    function makeBtn(compact) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ocbot-ask-btn';
      b.title = 'Ask the assistant (searches the whole catalog)';
      b.innerHTML = '✨' + (compact ? '' : ' <span>Ask the assistant</span>');
      return b;
    }
    function attach(inputEl, compact) {
      if (!inputEl || inputEl.dataset.ocbotAttached) return;
      inputEl.dataset.ocbotAttached = '1';
      var btn = makeBtn(compact);
      btn.addEventListener('click', function () {
        var v = (inputEl.value || '').trim();
        v ? window.OCChat.ask(v) : window.OCChat.open();
      });
      var parent = inputEl.parentElement;
      // If the input already lives inside a styled flex frame (e.g. the
      // benchmarks search box, icon + input), just drop the button in as a
      // sibling — it lands inside the frame and looks integrated.
      var alreadyBoxed = parent && parent.children.length > 1 &&
        /flex/.test((getComputedStyle(parent).display || ''));
      if (alreadyBoxed) {
        inputEl.insertAdjacentElement('afterend', btn);
      } else {
        // Otherwise wrap the input in our own pill frame so the button sits
        // INSIDE the search field (matching the benchmarks look).
        var box = document.createElement('span');
        box.className = 'ocbot-searchbox' + (compact ? ' compact' : '');
        parent.insertBefore(box, inputEl);
        box.appendChild(inputEl);
        box.appendChild(btn);
      }
    }
    // Page search inputs, incl. the home hero (the button opens the chatbox for
    // a conversational session; typing in the hero still gives inline results).
    ['homeSearchInput', 'q', 'skillSearch', 'globalSearch'].forEach(function (idv) { attach(document.getElementById(idv), false); });
    var sd = document.getElementById('searchDock');
    if (sd) attach(sd.querySelector('input'), false);
    // Navbar docked search (compact).
    attach(document.getElementById('qDock'), true);
  });
})();
