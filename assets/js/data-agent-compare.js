// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// data-agent-compare.js — C4 multi-dataset comparison instrument (ACTION_PLAN task 2.2).
//
// A TRANSPARENT, DETERMINISTIC suitability scorer over the .doc criteria
// (task-align · modality · annotation · license · volume · class-coverage · quality · docs ·
// access · prep-cost). Pure (no window, no fetch, no model) → Node == browser. Taxonomy-driven via
// the injected engine `api`, so it inherits the frozen fit semantics (exact+descendant).
//
// PRIMITIVE vs ORACLE boundary (guardrail): two consumers, two surfaces —
//   • `compareTable(recs, need, {forAgent:true})` → the AGENT primitive: per-criterion raw value +
//     0..1 sub-score + evidence, per dataset. NO weights, NO aggregate total, NO ranking → the agent
//     must weigh the evidence itself (the reasoning H2 measures). It cannot copy a "winner".
//   • `suitabilityScore` / `rankBySuitability` → the ENGINE/grader surface (Category E ground truth +
//     reports): the full weighted total + breakdown + ranking. NOT exposed as an agent tool.
// Weights are a documented DESIGN DECISION (see solutionAnalysis/c4-suitability-and-email-tools.md).

(function () {
  'use strict';
  // Parse a count that may be written as "57,500", "5 million", "10K frames", "5.7 million words",
  // "37 IFC models with 1,027 QA" (-> first number). Handles K/M/B + thousand/million/billion suffixes;
  // "km" etc. do NOT trigger a multiplier (word-boundary guard). (G2.1 R2 fix.)
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v == null) return null;
    var m = String(v).toLowerCase().match(/(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|k|m|b)?\b/);
    if (!m) return null;
    var base = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(base)) return null;
    var s = m[2];
    var mult = (s === 'thousand' || s === 'k') ? 1e3 : (s === 'million' || s === 'm') ? 1e6 : (s === 'billion' || s === 'b') ? 1e9 : 1;
    return Math.round(base * mult);
  }
  function band(v, stops) { for (var i = 0; i < stops.length; i++) { if (v != null && v >= stops[i][0]) return stops[i][1]; } return 0; }
  function present(v) { return v != null && String(v).trim() !== '' && !(Array.isArray(v) && v.length === 0); }

  function createComparer(api) {
    // Each criterion: scorer(rec, need) -> {raw, score(0..1)|null, evidence}. score=null => N/A (need
    // didn't constrain it) => excluded from the weighted total (weights renormalized over present).
    var CRITERIA = [
      { key: 'task_align', weight: 0.25, scorer: function (rec, need) {
        if (!need.taskIds.length) return { raw: rec.tasksRaw, score: null, evidence: 'no task in need' };
        var ok = need.taskIds.some(function (n) { return rec.taskIds.some(function (d) { return api.taskIdMatch(n, d); }); });
        return { raw: rec.tasksRaw, score: ok ? 1 : 0, evidence: rec.tasksRaw.join(', ') || 'no declared tasks' };
      }},
      { key: 'modality_match', weight: 0.15, scorer: function (rec, need) {
        if (!need.modality) return { raw: rec.modality, score: null, evidence: rec.modalityRaw || '' };
        return { raw: rec.modality, score: rec.modality.indexOf(need.modality) >= 0 ? 1 : 0, evidence: rec.modalityRaw || rec.modality.join(',') };
      }},
      { key: 'annotation_match', weight: 0.10, scorer: function (rec, need) {
        if (!need.annotation) return { raw: rec.annotation, score: null, evidence: rec.annotationRaw.join(', ') };
        return { raw: rec.annotation, score: rec.annotation.indexOf(need.annotation) >= 0 ? 1 : 0, evidence: rec.annotationRaw.join(', ') || 'undeclared' };
      }},
      { key: 'license', weight: 0.12, scorer: function (rec) {
        var ok = rec.rights.commercial_ok; var s = ok === true ? 1 : (ok === false ? 0 : 0.5);
        return { raw: rec.license, score: s, evidence: rec.license + ' (commercial_ok=' + ok + ')' };
      }},
      { key: 'volume', weight: 0.10, scorer: function (rec) {
        var n = num(rec.numImages); return { raw: n, score: band(n, [[10000, 1], [1000, 0.75], [100, 0.5], [1, 0.25]]), evidence: n != null ? n + ' images' : 'size unspecified' };
      }},
      { key: 'class_coverage', weight: 0.08, scorer: function (rec) {
        var c = num(rec.numClasses) || (rec.classes ? rec.classes.length : null);
        return { raw: c, score: band(c, [[20, 1], [10, 0.8], [5, 0.6], [2, 0.4], [1, 0.2]]), evidence: c != null ? c + ' classes' : 'classes unspecified' };
      }},
      { key: 'quality', weight: 0.08, scorer: function (rec) {  // DECLARED completeness, not measured (G2.1 R3: dropped dead `resolution` term)
        var s = (rec.annotation.length ? 0.5 : 0) + (present(rec.numImages) ? 0.5 : 0);
        return { raw: { annotation: rec.annotation.length > 0, size: present(rec.numImages) }, score: s, evidence: 'declared completeness (annotation + size present); NOT measured quality' };
      }},
      { key: 'docs', weight: 0.05, scorer: function (rec) {
        var s = ((present(rec.paper) ? 1 : 0) + (present(rec.doi) ? 1 : 0)) / 2;
        return { raw: { paper: present(rec.paper), doi: present(rec.doi) }, score: s, evidence: (present(rec.doi) ? 'doi ' : '') + (present(rec.paper) ? 'paper' : (present(rec.doi) ? '' : 'no paper/doi')) };
      }},
      { key: 'access', weight: 0.04, scorer: function (rec) {  // provisional — full classification = Phase 3 / Category B
        var a = String(rec.access || ''); var gated = /request|upon request|contact|e-?mail|apply/i.test(a);
        var s = !a ? 0.5 : (gated ? 0.3 : 1);
        return { raw: rec.access, score: s, evidence: a ? (gated ? 'gated (' + a.slice(0, 40) + ')' : 'link present') : 'no access link', note: 'provisional' };
      }},
      { key: 'prep_cost', weight: 0.03, scorer: function (rec) {  // heuristic (higher score = lower prep effort)
        var m = rec.modality[0] || '';
        var standard = ['ground_rgb', 'aerial_rgb', 'satellite_rgb', 'image', 'tabular', 'text'];
        var heavy = ['point_cloud', 'bim', 'drawing', 'gpr', 'hyperspectral'];
        var s = standard.indexOf(m) >= 0 ? (rec.annotation.length ? 1 : 0.7) : (heavy.indexOf(m) >= 0 ? 0.4 : 0.6);
        return { raw: m, score: s, evidence: 'heuristic from modality(' + (m || '?') + ')+annotation', note: 'design-decision heuristic' };
      }}
    ];

    function scoreOne(rec, need) {
      return CRITERIA.map(function (c) { var r = c.scorer(rec, need); return { criterion: c.key, weight: c.weight, score: r.score, raw: r.raw, evidence: r.evidence, note: r.note }; });
    }

    // Full transparent score (engine/grader surface). total renormalized over non-null criteria.
    function suitabilityScore(rec, need) {
      var bd = scoreOne(rec, need);
      var wsum = 0, acc = 0;
      bd.forEach(function (b) { if (b.score != null) { wsum += b.weight; acc += b.weight * b.score; } });
      return { id: rec.id, name: rec.name, total: wsum ? +(acc / wsum).toFixed(4) : 0, breakdown: bd };
    }

    // Category-E ground-truth ranking (engine surface; NOT an agent tool).
    function rankBySuitability(recs, need) {
      return recs.map(function (r) { return suitabilityScore(r, need); }).sort(function (a, b) { return b.total - a.total; });
    }

    // Comparison table. forAgent=true (default): evidence only — NO weight, NO total, NO ranking.
    function compareTable(recs, need, opts) {
      opts = opts || {};
      var forAgent = opts.forAgent !== false;
      var rows = recs.map(function (rec) {
        var per = {};
        scoreOne(rec, need).forEach(function (b) {
          // G2.1 R4: the AGENT gets RAW metadata values + evidence ONLY — NOT the grader's normalized
          // sub-scores (that made Category-E circular: "guess our weights over scores we gave you").
          per[b.criterion] = forAgent ? { value: b.raw, evidence: b.evidence } : { score: b.score, value: b.raw, weight: b.weight };
        });
        var row = { id: rec.id, name: rec.name, criteria: per };
        if (!forAgent) row.total = suitabilityScore(rec, need).total;
        return row;
      });
      var out = { criteria: CRITERIA.map(function (c) { return c.key; }), rows: rows };
      if (forAgent) out._note = 'Raw metadata values + evidence only — no normalized sub-scores, no weights, no total, no ranking. Weigh the evidence yourself to choose.';
      return out;
    }

    return { CRITERIA: CRITERIA, scoreOne: scoreOne, suitabilityScore: suitabilityScore, rankBySuitability: rankBySuitability, compareTable: compareTable };
  }

  var API = { createComparer: createComparer };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCDataAgentCompare = API;
})();
