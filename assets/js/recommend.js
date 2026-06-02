// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// recommend.js — improved "Related Resources" recommender (Q-recommendation).
//
// WHY: the platform's detail pages recommend similar datasets/models, but the
// original scoring counted raw term overlaps with hand-tuned weights (and a
// dataset<->model "training_data" signal that this catalog does not populate),
// so generic tasks dominated and semantically-close items were missed.
//
// HOW: this is an ADDITIVE layer. It does NOT modify the professor's detail.js.
// It reuses the assistant's tokenizer/synonym bag (the per-item `tokens` map
// built by buildIndex), adds the missing IDF term, and ranks by TF-IDF cosine
// similarity between the current resource and every other catalog item. It then
// re-renders only the "Related models" and "Related datasets" sub-cards of the
// existing #related-resources section, adding a transparent "why" line.
//
// $0 / fully client-side. Also exports a pure core for Node eval.

(function () {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function listOf(v) {
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    if (v == null || v === '') return [];
    return [String(v)];
  }

  // ---- IDF across the corpus (the piece the original count-based scorer lacked)
  function computeIdf(items) {
    const df = new Map();
    const N = Math.max(1, items.length);
    items.forEach(it => {
      if (!it.tokens) return;
      new Set(it.tokens.keys()).forEach(t => df.set(t, (df.get(t) || 0) + 1));
    });
    const idf = new Map();
    df.forEach((c, t) => idf.set(t, Math.log(1 + N / c)));
    return idf;
  }

  // ---- TF-IDF cosine between two token-weight maps
  function cosineSim(a, b, idf) {
    if (!a || !b) return 0;
    let dot = 0, na = 0, nb = 0;
    a.forEach((wa, t) => {
      const i = idf.get(t) || 1;
      const va = wa * i;
      na += va * va;
      const wb = b.get(t);
      if (wb) dot += va * (wb * i);
    });
    b.forEach((wb, t) => {
      const i = idf.get(t) || 1;
      const vb = wb * i;
      nb += vb * vb;
    });
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
  }

  // ---- human-readable reason (shared task / modality) for transparency
  function reasonFor(cur, other) {
    const curTasks = new Set(listOf(cur.tasks).map(norm).filter(Boolean));
    const sharedTasks = listOf(other.tasks).filter(t => curTasks.has(norm(t)));
    const curMods = new Set(listOf(cur.modality).map(norm).filter(Boolean));
    const sharedMods = listOf(other.modality).filter(m => curMods.has(norm(m)));
    const bits = [];
    if (sharedTasks.length) bits.push('task: ' + sharedTasks.slice(0, 2).join(', '));
    if (sharedMods.length) bits.push('modality: ' + sharedMods.slice(0, 1).join(', '));
    return bits.length ? 'Shares ' + bits.join(' · ') : 'Closely related in the catalog';
  }

  // ---- main: rank all items by similarity to the current resource
  function recommend(items, currentId, opts) {
    opts = opts || {};
    const k = opts.k || 4;
    const idf = computeIdf(items);
    const cur = items.find(it => it.id && norm(it.id) === norm(currentId)) ||
                items.find(it => it.title && norm(it.title) === norm(currentId));
    if (!cur) return null;
    const scored = items
      .filter(it => it && it !== cur && it.id)
      .map(it => ({ item: it, sim: cosineSim(cur.tokens, it.tokens, idf), reason: reasonFor(cur, it) }))
      .filter(x => x.sim > 0)
      .sort((a, b) => b.sim - a.sim);
    const byType = (type, n) => scored.filter(x => x.item.type === type).slice(0, n);
    return {
      cur: cur,
      models: byType('model', k),
      datasets: byType('dataset', k),
      workflows: byType('workflow', opts.kSmall || 3),
      oers: byType('oer', opts.kSmall || 3),
      all: scored
    };
  }

  // -------------------------------------------------------- Node export / done
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { norm: norm, computeIdf: computeIdf, cosineSim: cosineSim, recommend: recommend, reasonFor: reasonFor };
  }
  if (typeof document === 'undefined') return; // node test context: skip DOM

  // ------------------------------------------------------------ browser render
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function detailPage() {
    const p = location.pathname || '';
    if (/\/datasets\/detail\.html$/.test(p)) return 'dataset';
    if (/\/models\/details\.html$/.test(p)) return 'model';
    if (/\/workflows\/details\.html$/.test(p)) return 'workflow';
    if (/\/oers\/details\.html$/.test(p)) return 'oer';
    return null;
  }

  // All detail pages live one level deep -> build links by TYPE (not the index
  // href, whose workflow/oer targets point elsewhere) so links land on the
  // right detail page. workflow id == title (matches workflow-detail.js lookup).
  var TYPE_LABEL = { dataset: 'Dataset', model: 'Model', workflow: 'Workflow', oer: 'OER', skill: 'Skill' };
  function hrefFor(it) {
    var enc = encodeURIComponent(it.id || it.title || '');
    switch (it.type) {
      case 'dataset':  return '../datasets/detail.html?id=' + enc;
      case 'model':    return '../models/details.html?id=' + enc;
      case 'workflow': return '../workflows/details.html?id=' + enc;
      case 'oer':      return '../oers/details.html?id=' + enc;
      case 'skill':    return '../skills.html#' + enc;
      default:         return '../' + String(it.href || '').replace(/^\.?\//, '');
    }
  }

  function linkHtml(entry) {
    var it = entry.item;
    return '<a class="related-link" href="' + esc(hrefFor(it)) + '">' +
      '<span class="related-link-type">' + esc(TYPE_LABEL[it.type] || 'Resource') + '</span>' +
      '<span class="related-link-title">' + esc(it.title || it.id) + '</span>' +
      '<span class="related-link-meta">' + esc(entry.reason) + '</span>' +
      '</a>';
  }

  function fillSubcard(card, entries, emptyMsg) {
    var head = card.querySelector('.detail-subhead');
    var headHtml = head ? head.outerHTML : '';
    var body = entries.length
      ? entries.map(linkHtml).join('')
      : '<p class="text-muted small mb-0">' + emptyMsg + '</p>';
    card.innerHTML = headHtml + body;
  }

  // Map each related sub-card (by its subhead label) to the matching rec group.
  function applyRecommendations(rec, pageType) {
    var section = document.getElementById('related-resources');
    if (!section || !rec) return false;
    var cards = section.querySelectorAll('.detail-subcard');
    var touched = false;
    cards.forEach(function (card) {
      var head = card.querySelector('.detail-subhead');
      var label = head ? head.textContent.trim().toLowerCase() : '';
      var entries = null, empty = '';
      if (label === 'related models') { entries = rec.models; empty = 'No related models were identified from the current catalog.'; }
      else if (label === 'related datasets') { entries = rec.datasets; empty = 'No related datasets were identified from the current catalog.'; }
      else if (label === 'related workflows') { entries = rec.workflows; empty = 'No closely related workflows were found from the current catalog metadata.'; }
      else if (label === 'related learning' || label === 'related oers' || label === 'related education') { entries = rec.oers; empty = 'No closely related OERs were found from the current catalog metadata.'; }
      else if (!head && pageType === 'oer') { entries = rec.oers; empty = 'No closely related OERs were found from the current catalog metadata.'; }
      if (entries) { fillSubcard(card, entries, empty); touched = true; }
    });
    return touched;
  }

  async function init() {
    var pageType = detailPage();
    if (!pageType) return;
    if (!window.OCAssistant || !window.OCAssistant.getIndex) return;
    const id = new URLSearchParams(location.search).get('id');
    if (!id) return;
    let items;
    try { items = await window.OCAssistant.getIndex(); } catch (e) { return; }
    const rec = recommend(items, id, { k: 4 });
    if (!rec) return;
    // detail.js renders #related-resources async; wait for the sub-cards to exist.
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const done = applyRecommendations(rec, pageType);
      if (done || tries > 40) clearInterval(timer); // ~10s max
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
