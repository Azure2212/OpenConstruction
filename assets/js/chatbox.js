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
    '@keyframes ocbotb{0%,60%,100%{opacity:.3;transform:translateY(0);}30%{opacity:1;transform:translateY(-3px);}}'
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
  panel.innerHTML =
    '<div class="ocbot-head"><div class="av">OC</div>' +
      '<div><div class="t">OpenConstruction Assistant</div><div class="s">Grounded in the live catalog</div></div>' +
      '<button class="x" aria-label="Close">×</button></div>' +
    '<div class="ocbot-log" id="ocbotLog"></div>' +
    '<div class="ocbot-foot">' +
      '<form class="ocbot-form" id="ocbotForm">' +
        '<input class="ocbot-input" id="ocbotInput" placeholder="Ask about datasets, models, skills…" autocomplete="off">' +
        '<button class="ocbot-send" type="submit">Send</button>' +
      '</form>' +
      '<div class="ocbot-note">Runs in your browser — no API cost. ' +
        '<a href="' + (SUBDIR ? '../mcp.html' : 'mcp.html') + '">Use your own Claude via MCP →</a></div>' +
    '</div>';

  document.addEventListener('DOMContentLoaded', function () {
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    var log = panel.querySelector('#ocbotLog');
    var form = panel.querySelector('#ocbotForm');
    var input = panel.querySelector('#ocbotInput');
    var greeted = false;

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

    async function answer(q) {
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

    function send(q) {
      q = (q || '').trim(); if (!q) return;
      addUser(q); input.value = ''; answer(q);
    }

    fab.addEventListener('click', function () {
      panel.classList.add('open'); fab.style.display = 'none'; greet(); input.focus();
      if (window.OCAssistant) window.OCAssistant.getIndex(); // warm cache
    });
    panel.querySelector('.x').addEventListener('click', function () {
      panel.classList.remove('open'); fab.style.display = 'grid';
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
    log.addEventListener('click', function (e) {
      var c = e.target.closest('.ocbot-chip'); if (c) send(c.dataset.q);
    });
  });
})();
