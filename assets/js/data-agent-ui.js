// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// data-agent-ui.js — browser wiring for the Data Agent page.
// Renders the capability framework (C1–C5) as the UI itself (not a chat bubble),
// plus the in-product deterministic benchmark panel. Engine: window.OCDataAgent.

(function () {
  'use strict';
  if (typeof document === 'undefined' || !window.OCDataAgent) return;
  const A = window.OCDataAgent;
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function fitnessBadge(v) {
    const map = { fit: ['da-ok', 'FIT'], unfit: ['da-no', 'UNFIT'], 'no-constraint': ['da-muted', 'no hard constraint'] };
    const [cls, txt] = map[v] || ['da-muted', v];
    return '<span class="da-badge ' + cls + '">' + txt + '</span>';
  }

  function renderResult(r) {
    const need = r.need;
    const needChips = [
      need.task && 'task: ' + need.task, need.modality && 'modality: ' + need.modality,
      need.annotation && 'annotation: ' + need.annotation, need.license !== 'any' && 'license: ' + need.license,
      need.intendedUse && 'use: ' + need.intendedUse
    ].filter(Boolean).map(c => '<span class="da-chip">' + esc(c) + '</span>').join('');

    // C5 first if abstained (the honest, headline answer)
    const c5 = r.c5;
    let c5Html = '';
    if (c5.abstained) {
      c5Html = '<div class="da-abstain"><strong>C5 · Abstained — no dataset fits.</strong><div>' + esc(c5.message) + '</div>' +
        (c5.nearestMiss ? '<div class="da-near">Nearest miss: <a href="' + esc(c5.nearestMiss.href) + '">' + esc(c5.nearestMiss.name) + '</a> — failing: ' + esc(c5.nearestMiss.failing.join('; ')) + '</div>' : '') +
        '</div>';
    } else {
      c5Html = '<div class="da-reliable"><strong>C5 · Reliability</strong> · confidence ' + Math.round((c5.confidence || 0) * 100) + '%' +
        ' · hallucination-safe: ' + (c5.hallucinationSafe ? 'yes' : 'NO') +
        ' · license-correct: ' + (c5.licenseCorrect ? 'yes' : 'NO') +
        (c5.flags.length ? '<div class="da-flag">' + c5.flags.map(esc).join('<br>') + '</div>' : '') + '</div>';
    }

    // C1 discovery
    const c1Html = r.c1.candidates.map(c =>
      '<li><a href="' + esc(c.href) + '">' + esc(c.name) + '</a> <span class="da-score">' + c.score + '</span>' +
      '<span class="da-matched">' + c.matched.map(m => '<span class="da-tag">' + esc(m) + '</span>').join('') + '</span></li>'
    ).join('') || '<li class="da-muted">no candidates matched a hard facet</li>';

    // C2 understanding (top candidates)
    const c2Html = r.c2.slice(0, 5).map(u =>
      '<div class="da-understand"><a href="' + esc(u.href) + '"><strong>' + esc(u.name) + '</strong></a>' +
      '<div class="da-sum">' + esc(u.summary) + '</div>' +
      (u.provenance.doi || u.provenance.paper ? '<div class="da-prov">source: ' + esc(u.provenance.doi || u.provenance.paper) + '</div>' : '') +
      '</div>').join('');

    // C3 fitness checklist (top candidates)
    const c3Html = r.c3.slice(0, 5).map(row => {
      const crit = row.fitness.criteria.map(c =>
        '<li class="' + (c.pass ? 'da-pass' : (c.required ? 'da-fail' : 'da-soft')) + '">' +
        (c.pass ? '✓' : (c.required ? '✕' : '○')) + ' ' + esc(c.label) +
        '<span class="da-ev">' + esc(c.evidence) + '</span></li>').join('');
      return '<div class="da-fitness"><div class="da-fhead">' + esc(row.name) + ' ' + fitnessBadge(row.fitness.verdict) + '</div><ul>' + crit + '</ul></div>';
    }).join('');

    // C4 selection + comparison table
    const sel = r.c4.selected.map(s => '<li><a href="' + esc(s.href) + '">' + esc(s.name) + '</a> ' + fitnessBadge(s.verdict) + ' <span class="da-score">' + s.score + '</span></li>').join('') || '<li class="da-muted">no dataset passed all required criteria</li>';
    const cmpRows = r.c4.comparison.slice(0, 8).map(c =>
      '<tr><td><a href="datasets/detail.html?id=' + encodeURIComponent(c.id) + '">' + esc(c.name) + '</a></td>' +
      '<td>' + esc(c.modality.join(', ') || '—') + '</td><td>' + esc(c.annotation.join(', ') || '—') + '</td>' +
      '<td>' + esc(c.license) + ' <span class="da-muted">(' + esc(c.licenseClass) + ')</span></td>' +
      '<td>' + fitnessBadge(c.verdict) + '</td><td>' + c.score + '</td></tr>').join('');

    $('#daResult').innerHTML =
      '<div class="da-need">Parsed need: ' + (needChips || '<span class="da-muted">(no facets parsed)</span>') +
        ' · corpus: ' + r.corpusSize + ' datasets</div>' +
      c5Html +
      '<div class="da-grid">' +
        '<section class="da-panel"><h3>C1 · Discovery <small>' + r.c1.count + ' candidates</small></h3><ul class="da-list">' + c1Html + '</ul></section>' +
        '<section class="da-panel"><h3>C2 · Metadata understanding</h3>' + (c2Html || '<p class="da-muted">—</p>') + '</section>' +
        '<section class="da-panel"><h3>C3 · Fitness-for-task</h3>' + (c3Html || '<p class="da-muted">—</p>') + '</section>' +
        '<section class="da-panel"><h3>C4 · Compare &amp; select</h3><ul class="da-list">' + sel + '</ul>' +
          '<div class="table-responsive"><table class="table table-sm da-cmp"><thead><tr><th>Dataset</th><th>Modality</th><th>Annotation</th><th>License</th><th>Fit</th><th>Score</th></tr></thead><tbody>' + cmpRows + '</tbody></table></div></section>' +
      '</div>';
  }

  async function runAgent() {
    const text = $('#daQuery').value.trim();
    const facet = {
      text,
      task: $('#daTask').value.trim(),
      modality: $('#daModality').value,
      annotation: $('#daAnnotation').value,
      license: $('#daLicense').value,
      k: parseInt($('#daK').value, 10) || 5
    };
    // If any explicit facet set, prefer the structured need; else parse the text.
    const need = (facet.task || facet.modality || facet.annotation || (facet.license && facet.license !== 'any'))
      ? facet : text;
    $('#daResult').innerHTML = '<div class="da-muted">Running the C1→C5 reference baseline over catalog metadata…</div>';
    try { renderResult(await A.run(need)); }
    catch (e) { $('#daResult').innerHTML = '<div class="text-danger">Baseline error: ' + esc(e.message) + '</div>'; console.error(e); }
  }

  async function runBench() {
    const out = $('#daBenchOut');
    out.innerHTML = '<span class="da-muted">Loading golden set…</span>';
    let gs = null;
    for (const url of ['data/data-agent-goldenset.seed.json', 'data/eval-queries.json', '../data/data-agent-goldenset.seed.json']) {
      try { const res = await fetch(url, { cache: 'no-cache' }); if (res.ok) { gs = await res.json(); break; } } catch (e) {}
    }
    if (!gs) { out.innerHTML = '<span class="text-danger">No golden set found.</span>'; return; }
    try {
      const m = await A.runBenchmark(gs);
      out.innerHTML =
        '<div class="da-metrics">' +
        metric('precision@' + m.k, m.precisionAtK) + metric('nDCG@' + m.k, m.ndcgAtK) +
        metric('abstention-correctness', m.abstentionCorrectness) + metric('license-correctness', m.licenseCorrectness) +
        metric('hallucination-rate', m.hallucinationRate) + metric('cases', m.cases) +
        '</div><p class="da-muted small mt-2">' + esc(m.note) + '</p>';
    } catch (e) { out.innerHTML = '<span class="text-danger">Benchmark error: ' + esc(e.message) + '</span>'; console.error(e); }
  }
  function metric(label, v) {
    return '<div class="da-metric"><div class="da-mv">' + (v == null ? '—' : v) + '</div><div class="da-ml">' + esc(label) + '</div></div>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    // surface the framework definition from the engine (research embedded in product)
    const fw = $('#daFramework');
    if (fw && A.FRAMEWORK) fw.innerHTML = A.FRAMEWORK.map(c =>
      '<div class="da-cap"><span class="da-cap-id">' + c.id + '</span><strong>' + esc(c.name) + '</strong><span>' + esc(c.desc) + '</span></div>').join('');
    const run = $('#daRun'); if (run) run.addEventListener('click', runAgent);
    const q = $('#daQuery'); if (q) q.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAgent(); });
    const bench = $('#daBenchRun'); if (bench) bench.addEventListener('click', runBench);
  });
})();
