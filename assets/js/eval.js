// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q2 — Assistant evaluation harness. Loads data/eval-queries.json, runs each case
// through window.OCAssistant.retrieve, and scores recall@k + MRR + no-hallucination.

(function () {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function paths(f) { return ['data/' + f, './data/' + f, '../data/' + f]; }
  async function loadJSON(f) {
    for (var i = 0; i < paths(f).length; i++) {
      try { var r = await fetch(paths(f)[i], { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) {}
    }
    return null;
  }

  // Does an item satisfy a case? Match by title substring (case-insensitive) and,
  // if the case specifies a type, the item type must match too.
  function itemMatches(item, c) {
    if (c.type && item.type !== c.type) return false;
    var hay = ((item.title || '') + ' ' + (item.id || '')).toLowerCase();
    return c.expect.some(function (sub) { return hay.indexOf(String(sub).toLowerCase()) !== -1; });
  }

  // Rank (1-based) of the first matching result within top-k, or 0 if none.
  function firstHitRank(results, c, k) {
    for (var i = 0; i < Math.min(results.length, k); i++) {
      if (itemMatches(results[i].item, c)) return i + 1;
    }
    return 0;
  }

  async function run() {
    var btn = document.getElementById('runBtn');
    var state = document.getElementById('runState');
    btn.disabled = true; state.textContent = 'Loading engine and queries…';

    var eng = window.OCAssistant;
    var spec = await loadJSON('eval-queries.json');
    if (!eng || !spec || !Array.isArray(spec.cases)) {
      document.getElementById('errorState').classList.remove('d-none');
      btn.disabled = false; state.textContent = '';
      return;
    }
    var K = spec.k || 5;
    var index = await eng.getIndex();
    state.textContent = 'Running ' + spec.cases.length + ' cases…';

    var rows = '', posTotal = 0, posPass = 0, negTotal = 0, negPass = 0, rrSum = 0;

    spec.cases.forEach(function (c, i) {
      var k = c.k || K;
      var res = eng.retrieve(index, c.q, Math.max(k, 10));
      var results = res.results || [];
      var isNeg = !c.expect || c.expect.length === 0;
      var pass, detail, rank = 0;

      if (isNeg) {
        // Negative / adversarial: pass when the engine returns NO results.
        negTotal++;
        pass = results.length === 0;
        if (pass) negPass++;
        detail = results.length === 0
          ? '<span class="ev-hit">(correctly returned no match)</span>'
          : '<span class="ev-hit">leaked: ' + esc(results[0].item.title) + '</span>';
      } else {
        posTotal++;
        rank = firstHitRank(results, c, k);
        pass = rank > 0;
        if (pass) { posPass++; rrSum += 1 / rank; }
        var top = results[0];
        detail = top
          ? '<span class="ev-type">' + esc(top.item.type) + '</span> ' + esc(top.item.title) +
            (rank ? ' <span class="ev-hit">(hit @' + rank + ')</span>' : ' <span class="ev-hit">(no expected hit in top ' + k + ')</span>')
          : '<span class="ev-hit">(no results)</span>';
      }

      rows += '<tr>' +
        '<td class="text-muted">' + (i + 1) + '</td>' +
        '<td class="ev-q">' + esc(c.q) + (isNeg ? ' <span class="ev-type">adversarial</span>' : '') + '</td>' +
        '<td class="small text-muted">' + (isNeg ? '∅ none' : (c.type ? esc(c.type) : 'any')) + '</td>' +
        '<td>' + (pass ? '<span class="ev-pass">PASS</span>' : '<span class="ev-fail">FAIL</span>') + '</td>' +
        '<td>' + detail + '</td>' +
      '</tr>';
    });

    document.getElementById('rows').innerHTML = rows;
    document.getElementById('results').classList.remove('d-none');

    var recall = posTotal ? Math.round(100 * posPass / posTotal) : 0;
    var negRate = negTotal ? Math.round(100 * negPass / negTotal) : 0;
    var mrr = posTotal ? (rrSum / posTotal) : 0;
    document.getElementById('mRecall').textContent = recall + '%';
    document.getElementById('mPos').textContent = posPass + '/' + posTotal;
    document.getElementById('mNeg').textContent = negPass + '/' + negTotal;
    document.getElementById('mMRR').textContent = mrr.toFixed(2);
    document.getElementById('mK').textContent = K;
    document.getElementById('summary').classList.remove('d-none');

    state.textContent = 'Done — recall@' + K + ' = ' + recall + '%, no-hallucination ' + negRate + '%.';
    btn.disabled = false;
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('runBtn').addEventListener('click', run);
  });
})();
