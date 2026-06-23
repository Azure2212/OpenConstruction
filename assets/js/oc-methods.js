// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// oc-methods.js — shared in-browser retrieval methods over the REAL 136-dataset catalog.
// Exposes window.OCMethods.run(mode, query, {onProgress, onStatus}) -> Promise<{rows, note}>.
//   mode: 'bm25'  -> native-JS BM25 (instant, offline)
//         'dense' -> bge-small-en-v1.5 ONNX query embed (transformers.js) + cosine over bundled doc-vectors
//         'agent' -> Qwen2.5-1.5B-Instruct ONNX (transformers.js) re-ranks a BM25 shortlist
// Reuses data-agent.js (corpus) + rag-baseline.js (BM25/cosine). No server, no fabrication
// (only real catalog ids returned; hallucinated ids dropped). Consumed by BOTH the hero search
// bar and the floating chatbox.
(function () {
  'use strict';
  if (window.OCMethods) return;
  var K = 8;
  var TJS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2';
  var BGE_MODEL = 'Xenova/bge-small-en-v1.5', GEN_MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';
  var DEVICE = (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
  var corpusP = null, recById = {}, lexIndex = null, tjsP = null, embedderP = null, generatorP = null, docvecP = null;

  function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function recOf(id) { return recById[ckey(id)] || null; }
  function rowOf(id, extra) {
    var r = recOf(id);
    return {
      id: id, name: r ? r.name : id, href: r && r.href ? r.href : null,
      meta: r ? [r.modalityRaw, (r.tasksRaw || []).slice(0, 2).join(', ')].filter(Boolean).join(' · ') : '',
      score: (extra && extra.score != null) ? extra.score : null,
      reason: (extra && extra.reason) || ''
    };
  }
  function ensureCorpus() {
    if (corpusP) return corpusP;
    if (!window.OCDataAgent || !window.OCRagBaseline) return Promise.reject(new Error('retrieval modules not loaded'));
    corpusP = window.OCDataAgent.loadCorpus().then(function (corpus) {
      corpus.datasets.forEach(function (d) { recById[ckey(d.id)] = d; });
      lexIndex = window.OCRagBaseline.buildBM25Index(corpus, {});
      return corpus;
    });
    return corpusP;
  }
  function loadTJS() { if (!tjsP) tjsP = import(TJS_URL).then(function (m) { m.env.allowLocalModels = false; return m; }); return tjsP; }

  function getEmbedder(onStatus) {
    if (embedderP) return embedderP;
    embedderP = loadTJS().then(function (TJS) {
      onStatus('Loading bge-small embedder (' + DEVICE + ') — first time ~130 MB, then cached…');
      return TJS.pipeline('feature-extraction', BGE_MODEL, { device: DEVICE, dtype: 'fp32', progress_callback: window.OCMethods._onProg })
        .catch(function () { return TJS.pipeline('feature-extraction', BGE_MODEL, { device: 'wasm', dtype: 'fp32', progress_callback: window.OCMethods._onProg }); });
    });
    return embedderP;
  }
  function getGenerator(onStatus) {
    if (generatorP) return generatorP;
    generatorP = loadTJS().then(function (TJS) {
      onStatus('Loading Qwen2.5-1.5B (' + DEVICE + ') — first time ~1.7 GB, then cached. Small demo model.');
      return TJS.pipeline('text-generation', GEN_MODEL, { device: DEVICE, dtype: 'q4', progress_callback: window.OCMethods._onProg })
        .catch(function () { return TJS.pipeline('text-generation', GEN_MODEL, { device: 'wasm', dtype: 'q4', progress_callback: window.OCMethods._onProg }); });
    });
    return generatorP;
  }

  function runBM25(q) {
    var ranked = window.OCRagBaseline.bm25Rank(lexIndex, q).filter(function (r) { return r.score > 0; }).slice(0, K);
    return { rows: ranked.map(function (r) { return rowOf(r.id, { score: r.score }); }),
      note: 'BM25 lexical · ' + ranked.length + ' hits · native JS, fully offline' };
  }
  function runDense(q, onStatus) {
    if (!docvecP) docvecP = fetch('data/dense-docvecs-bge-small.json', { cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error('docvecs ' + r.status); return r.json(); });
    return Promise.all([docvecP, getEmbedder(onStatus)]).then(function (a) {
      var bundle = a[0], embedder = a[1], meta = bundle._meta || {};
      onStatus('Embedding query in-browser (' + meta.model + ', ' + DEVICE + ')…');
      return embedder((meta.query_prefix || '') + q, { pooling: meta.pooling || 'cls', normalize: true }).then(function (out) {
        var qv = Array.prototype.slice.call(out.data);
        var di = window.OCRagBaseline.buildDenseIndex(bundle.doc_ids, bundle.doc_vecs);
        var ranked = window.OCRagBaseline.denseRank(di, qv).slice(0, K);
        return { rows: ranked.map(function (r) { return rowOf(r.id, { score: r.score }); }),
          note: 'RAG-dense · ' + meta.model + ' (ONNX, in-browser, ' + DEVICE + ') · cosine over ' + bundle.doc_ids.length + ' bundled doc-vectors' };
      });
    });
  }
  function runAgent(q, onStatus) {
    return getGenerator(onStatus).then(function (generator) {
      var shortlist = window.OCRagBaseline.bm25Rank(lexIndex, q).slice(0, 12).map(function (r) {
        var rec = recOf(r.id); return { id: r.id, name: rec && rec.name, modality: rec && rec.modalityRaw, tasks: (rec && rec.tasksRaw || []).slice(0, 3).join(', ') };
      });
      var messages = [
        { role: 'system', content: 'You help engineers find AEC datasets. From the CANDIDATES (real catalog ids), pick the best matches for the QUERY. Reply ONLY with compact JSON {"ranking":[{"id":"<exact id from candidates>","reason":"<short>"}]}. Use only ids present in the candidates; never invent ids.' },
        { role: 'user', content: 'QUERY: ' + q + '\n\nCANDIDATES:\n' + shortlist.map(function (c) { return '- ' + c.id + ' | ' + c.name + ' | ' + c.modality + ' | ' + c.tasks; }).join('\n') }
      ];
      onStatus('Running Qwen2.5-1.5B in-browser (' + DEVICE + ')… (small model, may take a moment)');
      return generator(messages, { max_new_tokens: 256, do_sample: false, return_full_text: false }).then(function (out) {
        var txt = (out && out[0] && out[0].generated_text) || ''; if (Array.isArray(txt)) { var last = txt[txt.length - 1]; txt = (last && last.content) || ''; }
        var rank = []; try { var mm = String(txt).match(/\{[\s\S]*\}/); var pj = JSON.parse(mm ? mm[0] : txt); if (pj && pj.ranking) rank = pj.ranking; } catch (e) {}
        if (!rank.length) { var re = /"id"\s*:\s*"([^"]+)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?/g, x; while ((x = re.exec(String(txt)))) rank.push({ id: x[1], reason: x[2] || '' }); }
        var seen = {}, rows = [];
        rank.forEach(function (r) { var k = ckey(r && r.id); if (recById[k] && !seen[k]) { seen[k] = 1; rows.push(rowOf(r.id, { reason: r.reason })); } });
        rows = rows.slice(0, K);
        return { rows: rows,
          note: 'LLM-agent · Qwen2.5-1.5B-Instruct (ONNX, in-browser, ' + DEVICE + ') · re-rank of a BM25 shortlist · ' + rows.length + ' picks (invalid ids dropped). ⚠ small demo model, NOT the 7B/14B benchmark models.' };
      });
    });
  }

  // Public: run a query through a mode. onProgress(p) gets transformers.js download events; onStatus(msg) text.
  function run(mode, query, opts) {
    opts = opts || {};
    var onStatus = opts.onStatus || function () {};
    window.OCMethods._onProg = opts.onProgress || function () {};
    var q = String(query == null ? '' : query).trim();
    if (!q) return Promise.resolve({ rows: [], note: '' });
    return ensureCorpus().then(function () {
      if (mode === 'dense') return runDense(q, onStatus);
      if (mode === 'agent') return runAgent(q, onStatus);
      return runBM25(q);
    });
  }

  window.OCMethods = {
    run: run, ensureCorpus: ensureCorpus, device: DEVICE,
    LABELS: { bm25: 'BM25 (lexical)', dense: 'RAG-dense (bge-small)', agent: 'LLM-agent (Qwen2.5-1.5B)' },
    _onProg: function () {}
  };
})();
