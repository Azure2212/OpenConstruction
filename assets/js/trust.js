// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// trust.js — OCTrust: the shared "trust evidence-drawer" (Phase-C component #1).
// Renders the TRUST axis (T1 license-gate · T2 abstention · T3 hallucination-safe · T4 provenance)
// as a reusable badge row + expandable drawer, used across discovery results, the workspace canvas,
// and dataset detail.
//
// HARD RULE (research integrity): OCTrust ONLY renders values it reads back from the deterministic
// engine (window.OCDataAgent) or from an OCMethods result row. It NEVER fabricates a number, score,
// or verdict. Where the engine has no real datum, it renders an honest state ("Not specified",
// "unknown", "not checked", "would abstain") — never a placeholder value dressed up as a result.
//
// API:
//   OCTrust.compute(record, need, corpus) -> payload   (pure; reads the engine)
//   OCTrust.render(targetEl, { record, need, corpus }) -> payload  (renders + returns it)
//   OCTrust.fromMethodsRow(targetEl, row, { corpus, need }) -> payload  (adapter for OCMethods rows)

(function () {
  'use strict';
  var W = (typeof window !== 'undefined') ? window : null;

  // mirror the engine's id normalization so the catalog-membership (hallucination) check matches byId keys
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function eng() { return W && W.OCDataAgent ? W.OCDataAgent : null; }

  // ---------------------------------------------------------------- compute (engine-only)
  // Returns a normalized trust payload. Every field traces to a real engine value or an honest "unknown".
  function compute(record, need, corpus) {
    var A = eng();
    if (!record) return null;
    var rec = record;

    // --- T1 license-gate --------------------------------------------------
    var licText = rec.license || (A && A.licenseClass && rec.license ? rec.license : 'Not specified');
    var cls = rec.licenseClass || (A && A.licenseClass ? A.licenseClass(rec.license) : 'unknown');
    var commercialOk = rec.rights ? rec.rights.commercial_ok
      : (A && A.licenseRights ? A.licenseRights(rec.license).commercial_ok : null);
    var licRequired = !!(need && need.license && need.license !== 'any');
    var gateSatisfied = licRequired ? (commercialOk === true) : null; // null = not requested by the need

    // --- T4 provenance ----------------------------------------------------
    var accessClass = (A && A.classifyAccess) ? A.classifyAccess(rec) : 'unknown';
    var urlInfo = (rec.access && A && A.classifyUrl) ? A.classifyUrl(rec.access) : null;
    var cite = (A && A.citation) ? A.citation(rec) : null;

    // --- T3 hallucination-safe (catalog membership) -----------------------
    var checked = !!(corpus && corpus.byId && typeof corpus.byId.has === 'function');
    var safe = checked ? corpus.byId.has(norm(rec.id)) : null; // null = not checked (no corpus) -> honest, not "yes"

    // --- T2 + fitness (evaluate) -----------------------------------------
    var fit = (need && A && A.c3Fitness) ? A.c3Fitness(rec, need) : null;
    var abstain = null;
    if (fit && fit.requiredCount > 0 && fit.verdict === 'unfit') {
      var failing = fit.criteria.filter(function (c) { return c.required && !c.pass; }).map(function (c) { return c.label; });
      abstain = {
        wouldAbstain: true,
        message: 'Does not satisfy ' + (fit.requiredCount - fit.passedRequired) + '/' + fit.requiredCount +
          ' required constraint(s): ' + failing.join('; ')
      };
    }

    // --- deterministic warnings (derived from real fields only) -----------
    var warnings = [];
    if (!rec.license || /not specified|unknown|unclear|n\/a/i.test(String(rec.license))) warnings.push({ type: 'unclear-license', msg: 'License not specified' });
    if (accessClass === 'gated' || accessClass === 'registration_required' || accessClass === 'restricted') warnings.push({ type: 'restricted-access', msg: 'Access: ' + accessClass });
    if (accessClass === 'unknown') warnings.push({ type: 'access-unknown', msg: 'Access status could not be grounded from metadata' });
    if (!rec.modality || !rec.modality.length) warnings.push({ type: 'missing-metadata', msg: 'No modality declared' });
    if (!rec.annotation || !rec.annotation.length) warnings.push({ type: 'missing-metadata', msg: 'No annotation declared' });
    if (licRequired && gateSatisfied === false) warnings.push({ type: 'license-conflict', msg: 'Does not meet the requested commercial-use constraint' });

    return {
      id: rec.id, name: rec.name, href: rec.href,
      license: { text: licText, cls: cls, commercialOk: commercialOk, required: licRequired, satisfied: gateSatisfied },
      provenance: {
        source: rec.access || null, accessClass: accessClass,
        repository: urlInfo ? urlInfo.repository : null, isDoi: urlInfo ? !!urlInfo.is_doi : false,
        doi: rec.doi || null, paper: rec.paper || null, citation: cite ? cite.text : null, citationUrl: cite ? cite.source_url : null
      },
      hallucination: { checked: checked, safe: safe, id: rec.id },
      fitness: fit, abstain: abstain, warnings: warnings
    };
  }

  // Adapter: when the caller already has an OCMethods.run() row (carries evidence/warnings/criteria).
  // We still prefer the engine for license-class/provenance/membership when a corpus/record is reachable.
  function payloadFromRow(row, opts) {
    opts = opts || {};
    var corpus = opts.corpus, need = opts.need;
    // If we can resolve the real record from the corpus, compute() is the source of truth.
    if (corpus && corpus.byId && row && row.id) {
      var rec = corpus.byId.get(norm(row.id));
      if (rec) return compute(rec, need, corpus);
    }
    // Fallback: render strictly from the row's own engine-derived fields (no invention).
    var ev = (row && row.evidence) || {};
    return {
      id: row && row.id, name: row && row.name, href: row && row.href,
      license: { text: ev.license || 'Not specified', cls: 'unknown', commercialOk: null, required: false, satisfied: null },
      provenance: { source: ev.source || null, accessClass: 'unknown', repository: null, isDoi: false, doi: null, paper: null, citation: null, citationUrl: null },
      hallucination: { checked: false, safe: null, id: row && row.id },
      fitness: (row && row.criteria) ? { criteria: row.criteria.map(function (c) { return { key: c.key, label: c.key, required: true, pass: !!c.pass, evidence: c.evidence }; }) } : null,
      abstain: null,
      warnings: (row && row.warnings) || []
    };
  }

  // ---------------------------------------------------------------- render
  function ensureStyles() {
    if (!W || document.getElementById('oc-trust-css')) return;
    var s = document.createElement('style');
    s.id = 'oc-trust-css';
    s.textContent =
      '.oc-trust{border:1px solid #e7edf3;border-radius:12px;background:#fff;padding:.6rem .7rem;margin:.5rem 0;font-size:.85rem;color:#1e2a36;}' +
      '.oc-trust-badges{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;}' +
      '.oc-tb{display:inline-flex;align-items:center;gap:.3rem;border-radius:999px;padding:.18rem .6rem;font-size:.76rem;font-weight:700;border:1px solid #e7edf3;background:#f8fafc;color:#33414f;white-space:nowrap;}' +
      '.oc-tb .k{font-weight:600;color:#6b7280;}' +
      '.oc-tb.ok{background:#ecfdf3;border-color:#abefc6;color:#067647;}' +
      '.oc-tb.bad{background:#fef3f2;border-color:#fecdca;color:#b42318;}' +
      '.oc-tb.warn{background:#fffaeb;border-color:#fedf89;color:#b54708;}' +
      '.oc-tb.muted{background:#f2f4f7;border-color:#e4e7ec;color:#667085;}' +
      '.oc-trust-toggle{margin-left:auto;background:0;border:0;color:#0b66c3;font-size:.78rem;font-weight:700;cursor:pointer;padding:.1rem .3rem;}' +
      '.oc-trust-drawer{margin-top:.55rem;border-top:1px dashed #e4e7ec;padding-top:.5rem;display:none;}' +
      '.oc-trust.open .oc-trust-drawer{display:block;}' +
      '.oc-trust-drawer h6{font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:#667085;margin:.5rem 0 .25rem;}' +
      '.oc-crit{list-style:none;margin:0;padding:0;}' +
      '.oc-crit li{display:flex;gap:.4rem;align-items:baseline;padding:.12rem 0;font-size:.8rem;}' +
      '.oc-crit .m{width:1.1em;flex:none;font-weight:800;}' +
      '.oc-crit li.pass .m{color:#067647;}.oc-crit li.fail .m{color:#b42318;}.oc-crit li.soft .m{color:#98a2b3;}' +
      '.oc-crit .ev{color:#667085;font-size:.76rem;}' +
      '.oc-trust-warn{color:#b54708;font-size:.78rem;margin:.1rem 0;}' +
      '.oc-trust-abstain{background:#fef3f2;border:1px solid #fecdca;color:#b42318;border-radius:8px;padding:.4rem .55rem;margin:.35rem 0;font-size:.8rem;}' +
      '.oc-trust-cite{font-size:.76rem;color:#475569;margin-top:.3rem;word-break:break-word;}';
    document.head.appendChild(s);
  }

  function licenseBadge(L) {
    var label = L.cls || 'unknown';
    var commercial = L.commercialOk === true ? 'commercial-OK' : (L.commercialOk === false ? 'non-commercial' : 'unknown');
    var cls = 'muted';
    if (L.required) cls = (L.satisfied === true) ? 'ok' : (L.satisfied === false ? 'bad' : 'muted');
    var gate = L.required ? (L.satisfied === true ? ' ✓gate' : (L.satisfied === false ? ' ✕gate' : '')) : '';
    return '<span class="oc-tb ' + cls + '" title="' + esc(L.text) + '"><span class="k">license</span> ' + esc(label) + ' · ' + commercial + gate + '</span>';
  }
  function provenanceBadge(P) {
    var who = P.repository || P.accessClass || 'unknown';
    var cls = (P.accessClass === 'open') ? 'ok' : ((P.accessClass === 'gated' || P.accessClass === 'registration_required' || P.accessClass === 'restricted') ? 'warn' : 'muted');
    var src = P.source ? '<span class="k">source</span> ' + esc(who) : '<span class="k">source</span> not specified';
    return '<span class="oc-tb ' + cls + '">' + src + '</span>';
  }
  function hallucinationBadge(H) {
    if (!H.checked) return '<span class="oc-tb muted"><span class="k">catalog</span> not checked</span>';
    return H.safe
      ? '<span class="oc-tb ok"><span class="k">catalog</span> in-catalog ✓</span>'
      : '<span class="oc-tb bad"><span class="k">catalog</span> NOT in catalog ✕</span>';
  }
  function abstainBadge(payload) {
    if (payload.abstain && payload.abstain.wouldAbstain) return '<span class="oc-tb bad"><span class="k">abstain</span> would abstain</span>';
    if (payload.fitness && payload.fitness.verdict === 'fit') return '<span class="oc-tb ok"><span class="k">fit</span> answered</span>';
    if (payload.fitness && payload.fitness.verdict === 'no-constraint') return '<span class="oc-tb muted"><span class="k">fit</span> no hard constraint</span>';
    return '';
  }

  function renderPayload(targetEl, payload) {
    ensureStyles();
    if (!targetEl || !payload) return payload;
    var wrap = document.createElement('div');
    wrap.className = 'oc-trust';

    var badges = '<div class="oc-trust-badges">' +
      licenseBadge(payload.license) + provenanceBadge(payload.provenance) +
      hallucinationBadge(payload.hallucination) + abstainBadge(payload) +
      '<button type="button" class="oc-trust-toggle">evidence ▾</button></div>';

    // drawer: per-criterion evidence + warnings + abstain + citation (all real)
    var critHtml = '';
    if (payload.fitness && payload.fitness.criteria && payload.fitness.criteria.length) {
      critHtml = '<h6>Fitness criteria (deterministic)</h6><ul class="oc-crit">' +
        payload.fitness.criteria.map(function (c) {
          var st = c.pass ? 'pass' : (c.required ? 'fail' : 'soft');
          var mark = c.pass ? '✓' : (c.required ? '✕' : '○');
          return '<li class="' + st + '"><span class="m">' + mark + '</span><span>' + esc(c.label) +
            ' <span class="ev">' + esc(c.evidence) + '</span></span></li>';
        }).join('') + '</ul>';
      if (payload.fitness.requiredCount != null)
        critHtml += '<div class="oc-trust-warn" style="color:#475569">required criteria passed: ' +
          esc(payload.fitness.passedRequired) + '/' + esc(payload.fitness.requiredCount) + '</div>';
    }
    var abstainHtml = (payload.abstain && payload.abstain.wouldAbstain)
      ? '<div class="oc-trust-abstain"><strong>Abstain:</strong> ' + esc(payload.abstain.message) + '</div>' : '';
    var warnHtml = (payload.warnings && payload.warnings.length)
      ? '<h6>Warnings</h6>' + payload.warnings.map(function (w) { return '<div class="oc-trust-warn">⚠ ' + esc(w.msg) + '</div>'; }).join('') : '';
    var citeHtml = '';
    if (payload.provenance.citation) {
      var c = esc(payload.provenance.citation);
      citeHtml = '<h6>Citation</h6><div class="oc-trust-cite">' +
        (payload.provenance.citationUrl ? '<a href="' + esc(payload.provenance.citationUrl) + '" target="_blank" rel="noopener">' + c + '</a>' : c) + '</div>';
    }

    wrap.innerHTML = badges + '<div class="oc-trust-drawer">' + abstainHtml + critHtml + warnHtml + citeHtml +
      (critHtml || warnHtml || citeHtml || abstainHtml ? '' : '<div class="oc-trust-warn" style="color:#667085">No further evidence available from the engine.</div>') +
      '</div>';

    var btn = wrap.querySelector('.oc-trust-toggle');
    btn.addEventListener('click', function () {
      var open = wrap.classList.toggle('open');
      btn.textContent = open ? 'evidence ▴' : 'evidence ▾';
    });

    targetEl.appendChild(wrap);
    return payload;
  }

  var OCTrust = {
    compute: compute,
    render: function (targetEl, opts) {
      opts = opts || {};
      var payload = compute(opts.record, opts.need, opts.corpus);
      return renderPayload(targetEl, payload);
    },
    fromMethodsRow: function (targetEl, row, opts) {
      return renderPayload(targetEl, payloadFromRow(row, opts || {}));
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = OCTrust;
  if (W) W.OCTrust = OCTrust;
})();
