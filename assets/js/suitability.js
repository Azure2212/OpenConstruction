// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// suitability.js — OCSuitability: the Evaluate-stage widget (Phase-C component #2).
// Renders "is this dataset suitable for your task?" as the deterministic fitness checklist + an explicit
// license-gate (T1) + an honest abstention block (T2) when nothing fits. The compact trust badge row is
// delegated to OCTrust (component #1) — we do NOT re-implement badges here.
//
// HARD RULE (research integrity): every criterion, verdict, gate state and abstain message is read back
// from the engine (OCDataAgent.c3Fitness / c4CompareSelect / c5Reliability). Nothing is fabricated. Where
// the need states no hard constraint, we say so ("no hard constraint — fitness cannot be ruled"); we never
// invent a pass, a percentage, or a fit verdict.
//
// API:
//   OCSuitability.evaluate(record, need) -> { fitness, gate, verdict }   (pure; reads c3Fitness)
//   OCSuitability.render(targetEl, record, need, { corpus }) -> result   (single dataset)
//   OCSuitability.renderSet(targetEl, candidates, need, { corpus }) -> result  (2+ datasets: c4 + c5 abstention)

(function () {
  'use strict';
  var W = (typeof window !== 'undefined') ? window : null;
  function eng() { return W && W.OCDataAgent ? W.OCDataAgent : null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- evaluate (engine-only)
  function evaluate(record, need) {
    var A = eng();
    if (!record || !A || !A.c3Fitness) return null;
    var fitness = A.c3Fitness(record, need);
    // license-gate is just the 'license' criterion when the need requests a license constraint
    var licCrit = (fitness.criteria || []).filter(function (c) { return c.key === 'license'; })[0] || null;
    var gate = {
      requested: !!(need && need.license && need.license !== 'any'),
      satisfied: licCrit ? !!licCrit.pass : null,      // null = the need did not request a license constraint
      evidence: licCrit ? licCrit.evidence : null
    };
    return { fitness: fitness, gate: gate, verdict: fitness.verdict };
  }

  // ---------------------------------------------------------------- styles
  function ensureStyles() {
    if (!W || document.getElementById('oc-suit-css')) return;
    var s = document.createElement('style');
    s.id = 'oc-suit-css';
    s.textContent =
      '.oc-suit{border:1px solid #e7edf3;border-radius:12px;background:#fff;padding:.7rem .85rem;margin:.5rem 0;font-size:.86rem;color:#1e2a36;}' +
      '.oc-suit-head{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.2rem;}' +
      '.oc-suit-name{font-weight:700;color:#0f2e4b;}' +
      '.oc-suit-verdict{font-size:.78rem;font-weight:800;border-radius:999px;padding:.18rem .7rem;}' +
      '.oc-suit-verdict.fit{background:#ecfdf3;color:#067647;border:1px solid #abefc6;}' +
      '.oc-suit-verdict.unfit{background:#fef3f2;color:#b42318;border:1px solid #fecdca;}' +
      '.oc-suit-verdict.none{background:#f2f4f7;color:#667085;border:1px solid #e4e7ec;}' +
      '.oc-suit-gate{font-size:.8rem;margin:.3rem 0;}' +
      '.oc-suit-gate .g{font-weight:700;}' +
      '.oc-suit-gate.ok .g{color:#067647;}.oc-suit-gate.bad .g{color:#b42318;}.oc-suit-gate.na .g{color:#667085;}' +
      '.oc-suit-crit{list-style:none;margin:.3rem 0 0;padding:0;}' +
      '.oc-suit-crit li{display:flex;gap:.45rem;align-items:baseline;padding:.16rem 0;}' +
      '.oc-suit-crit .m{width:1.1em;flex:none;font-weight:800;}' +
      '.oc-suit-crit li.pass .m{color:#067647;}.oc-suit-crit li.fail .m{color:#b42318;}.oc-suit-crit li.soft .m{color:#98a2b3;}' +
      '.oc-suit-crit .lbl{font-weight:600;}.oc-suit-crit .ev{color:#667085;font-size:.78rem;}' +
      '.oc-suit-count{font-size:.78rem;color:#475569;margin-top:.25rem;}' +
      '.oc-suit-abstain{background:#fef3f2;border:1px solid #fecdca;color:#b42318;border-radius:9px;padding:.5rem .65rem;margin:.4rem 0;font-size:.82rem;}' +
      '.oc-suit-row{display:flex;align-items:center;gap:.5rem;padding:.25rem 0;border-top:1px solid #f0f3f7;}' +
      '.oc-suit-row:first-child{border-top:0;}' +
      '.oc-suit-row .nm{flex:1;font-size:.84rem;} .oc-suit-row .mk{font-weight:800;}' +
      '.oc-suit-row.fit .mk{color:#067647;}.oc-suit-row.unfit .mk{color:#b42318;}.oc-suit-row.soft .mk{color:#98a2b3;}';
    document.head.appendChild(s);
  }

  function verdictBadge(v) {
    if (v === 'fit') return '<span class="oc-suit-verdict fit">SUITABLE ✓</span>';
    if (v === 'unfit') return '<span class="oc-suit-verdict unfit">NOT SUITABLE ✕</span>';
    return '<span class="oc-suit-verdict none">NO HARD CONSTRAINT</span>';
  }

  function gateLine(gate) {
    if (!gate.requested) return '<div class="oc-suit-gate na"><span class="g">License-gate:</span> not requested by the need</div>';
    var cls = gate.satisfied === true ? 'ok' : (gate.satisfied === false ? 'bad' : 'na');
    var txt = gate.satisfied === true ? '✓ satisfies the commercial-use constraint'
      : (gate.satisfied === false ? '✕ does NOT satisfy the commercial-use constraint' : 'could not be evaluated');
    return '<div class="oc-suit-gate ' + cls + '"><span class="g">License-gate:</span> ' + txt +
      (gate.evidence ? ' <span class="ev" style="color:#667085">(' + esc(gate.evidence) + ')</span>' : '') + '</div>';
  }

  function critList(fitness) {
    if (!fitness || !fitness.criteria || !fitness.criteria.length)
      return '<div class="oc-suit-count">No criteria to evaluate (the need stated no constraints).</div>';
    var ul = '<ul class="oc-suit-crit">' + fitness.criteria.map(function (c) {
      var st = c.pass ? 'pass' : (c.required ? 'fail' : 'soft');
      var mark = c.pass ? '✓' : (c.required ? '✕' : '○');
      return '<li class="' + st + '"><span class="m">' + mark + '</span><span><span class="lbl">' + esc(c.label) + '</span>' +
        (c.required ? '' : ' <span class="ev">(soft)</span>') + ' — <span class="ev">' + esc(c.evidence) + '</span></span></li>';
    }).join('') + '</ul>';
    var count = (fitness.requiredCount != null)
      ? '<div class="oc-suit-count">Required criteria passed: <strong>' + esc(fitness.passedRequired) + '/' + esc(fitness.requiredCount) + '</strong>' +
        (fitness.requiredCount === 0 ? ' (none required → fitness cannot be ruled)' : '') + '</div>'
      : '';
    return ul + count;
  }

  // delegate the compact trust badges to OCTrust (no duplication)
  function trustBadges(host, record, need, corpus) {
    if (W && W.OCTrust && typeof W.OCTrust.render === 'function') W.OCTrust.render(host, { record: record, need: need, corpus: corpus });
  }

  // ---------------------------------------------------------------- render: single dataset
  function render(targetEl, record, need, opts) {
    ensureStyles();
    opts = opts || {};
    var res = evaluate(record, need);
    if (!targetEl) return res;
    var box = document.createElement('div');
    box.className = 'oc-suit';
    if (!res) { box.innerHTML = '<div class="oc-suit-count">Engine unavailable — cannot evaluate.</div>'; targetEl.appendChild(box); return res; }

    box.innerHTML =
      '<div class="oc-suit-head"><span class="oc-suit-name">' + esc(record.name || record.id) + '</span>' + verdictBadge(res.verdict) + '</div>' +
      gateLine(res.gate) + critList(res.fitness);
    // honest "would not be selected" note for a single unfit dataset
    if (res.verdict === 'unfit' && res.fitness.requiredCount > 0) {
      var failing = res.fitness.criteria.filter(function (c) { return c.required && !c.pass; }).map(function (c) { return c.label; });
      box.insertAdjacentHTML('beforeend', '<div class="oc-suit-abstain"><strong>Would not be selected.</strong> Fails ' +
        (res.fitness.requiredCount - res.fitness.passedRequired) + '/' + res.fitness.requiredCount + ' required: ' + esc(failing.join('; ')) + '</div>');
    }
    trustBadges(box, record, need, opts.corpus);
    targetEl.appendChild(box);
    return res;
  }

  // ---------------------------------------------------------------- render: a set (c4 select + c5 abstain)
  // candidates = [{rec, score, matched}] (c1Discovery shape). Reads c4CompareSelect + c5Reliability.
  function renderSet(targetEl, candidates, need, opts) {
    ensureStyles();
    opts = opts || {};
    var A = eng();
    if (!targetEl) return null;
    var box = document.createElement('div');
    box.className = 'oc-suit';
    if (!A || !A.c4CompareSelect || !A.c5Reliability) { box.innerHTML = '<div class="oc-suit-count">Engine unavailable.</div>'; targetEl.appendChild(box); return null; }

    var compare = A.c4CompareSelect(candidates || [], need);
    var c5 = A.c5Reliability(compare, need, opts.corpus || { byId: new Map() });

    var head = '<div class="oc-suit-head"><span class="oc-suit-name">Suitability over ' + (candidates ? candidates.length : 0) + ' candidate(s)</span>' +
      (c5.abstained ? '<span class="oc-suit-verdict unfit">ABSTAINED ✕</span>' : '<span class="oc-suit-verdict fit">' + compare.selected.length + ' selected</span>') + '</div>';
    box.innerHTML = head;

    if (c5.abstained) {
      var nm = c5.nearestMiss;
      box.insertAdjacentHTML('beforeend', '<div class="oc-suit-abstain"><strong>Abstain — no dataset fits.</strong> ' + esc(c5.message || '') +
        (nm && nm.failing ? '<br>Nearest miss <strong>' + esc(nm.name) + '</strong> fails: ' + esc(nm.failing.join('; ')) : '') + '</div>');
    }
    // ranked rows with the engine's per-row verdict (real)
    var rows = (compare.rows || []).map(function (r) {
      var v = r.fitness.verdict;
      var st = v === 'fit' ? 'fit' : (v === 'unfit' ? 'unfit' : 'soft');
      var mark = v === 'fit' ? '✓' : (v === 'unfit' ? '✕' : '○');
      return '<div class="oc-suit-row ' + st + '"><span class="mk">' + mark + '</span><span class="nm">' + esc(r.rec.name || r.rec.id) +
        '</span><span class="ev" style="color:#667085;font-size:.78rem">' + esc(r.fitness.passedRequired) + '/' + esc(r.fitness.requiredCount) + ' req</span></div>';
    }).join('');
    box.insertAdjacentHTML('beforeend', rows || '<div class="oc-suit-count">No candidates.</div>');
    targetEl.appendChild(box);
    return { compare: compare, c5: c5 };
  }

  var OCSuitability = { evaluate: evaluate, render: render, renderSet: renderSet };
  if (typeof module !== 'undefined' && module.exports) module.exports = OCSuitability;
  if (W) W.OCSuitability = OCSuitability;
})();
