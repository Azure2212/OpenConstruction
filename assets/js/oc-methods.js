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
  var BGE_MODEL = 'Xenova/bge-small-en-v1.5';
  // Device-adaptive agent model: WebGPU can handle 1.5B; plain WASM/CPU OOMs on 1.5B (~1.7 GB),
  // so fall back to the smaller 0.5B (~0.5 GB, fits WASM, already verified).
  var GEN_MODEL_GPU = 'onnx-community/Qwen2.5-1.5B-Instruct';
  var GEN_MODEL_CPU = 'onnx-community/Qwen2.5-0.5B-Instruct';
  var HAS_WEBGPU = (typeof navigator !== 'undefined' && !!navigator.gpu);
  var DEVICE = HAS_WEBGPU ? 'webgpu' : 'wasm';
  var AGENT_MODEL_USED = null, AGENT_DEVICE_USED = null;   // resolved when the generator loads
  function agentModelShort(m) { return /1\.5B/.test(m || '') ? 'Qwen2.5-1.5B' : 'Qwen2.5-0.5B'; }
  var FRIENDLY_AGENT = 'The in-browser language model could not run on this device — it likely lacks WebGPU or enough memory. Try BM25 or RAG-dense (both run fine here), or open this page in Chrome/Edge with WebGPU enabled for the agent.';
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
      var useGpu = HAS_WEBGPU;
      var model = useGpu ? GEN_MODEL_GPU : GEN_MODEL_CPU;
      onStatus(useGpu
        ? 'WebGPU ✓ — loading Qwen2.5-1.5B (~1.7 GB first load, then cached)…'
        : 'WASM (no WebGPU) — loading Qwen2.5-0.5B (~0.5 GB first load, then cached)…');
      return TJS.pipeline('text-generation', model, { device: useGpu ? 'webgpu' : 'wasm', dtype: 'q4', progress_callback: window.OCMethods._onProg })
        .then(function (p) { AGENT_MODEL_USED = model; AGENT_DEVICE_USED = useGpu ? 'webgpu' : 'wasm'; return p; })
        .catch(function (e) {
          // WebGPU attempt failed → fall back to the SMALL model on WASM (don't retry 1.5B on WASM = OOM).
          if (useGpu) {
            onStatus('WebGPU init failed — falling back to Qwen2.5-0.5B on WASM…');
            return TJS.pipeline('text-generation', GEN_MODEL_CPU, { device: 'wasm', dtype: 'q4', progress_callback: window.OCMethods._onProg })
              .then(function (p) { AGENT_MODEL_USED = GEN_MODEL_CPU; AGENT_DEVICE_USED = 'wasm'; return p; });
          }
          throw e;
        });
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
    }).catch(function (e) {
      if (typeof console !== 'undefined' && console.error) console.error('[OCMethods] dense run failed:', e);
      throw new Error('The in-browser embedding model could not run on this device (likely no WebGPU / memory or a network issue loading the model). Try BM25 — it runs fully offline.');
    });
  }
  // Hybrid = weighted fusion of BM25 (lexical) + RAG-dense (bge-small). Min-max normalize each score
  // list to [0,1], then fuse alpha*BM25 + (1-alpha)*dense with alpha=0.7 (BM25-heavy, best benchmark variant).
  function runHybrid(q, onStatus) {
    var ALPHA = 0.7;
    if (!docvecP) docvecP = fetch('data/dense-docvecs-bge-small.json', { cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error('docvecs ' + r.status); return r.json(); });
    return Promise.all([docvecP, getEmbedder(onStatus)]).then(function (a) {
      var bundle = a[0], embedder = a[1], meta = bundle._meta || {};
      var bm = window.OCRagBaseline.bm25Rank(lexIndex, q);            // all docs, lexical score
      onStatus('Embedding query (hybrid) in-browser (' + meta.model + ', ' + DEVICE + ')…');
      return embedder((meta.query_prefix || '') + q, { pooling: meta.pooling || 'cls', normalize: true }).then(function (out) {
        var qv = Array.prototype.slice.call(out.data);
        var di = window.OCRagBaseline.buildDenseIndex(bundle.doc_ids, bundle.doc_vecs);
        var dn = window.OCRagBaseline.denseRank(di, qv);              // all docs, cosine
        function minmax(list) {
          var mn = Infinity, mx = -Infinity;
          list.forEach(function (r) { if (r.score < mn) mn = r.score; if (r.score > mx) mx = r.score; });
          var rng = (mx - mn) || 1, m = {};
          list.forEach(function (r) { m[ckey(r.id)] = (r.score - mn) / rng; });
          return m;
        }
        var bmN = minmax(bm), dnN = minmax(dn), ids = {};
        bm.forEach(function (r) { ids[ckey(r.id)] = r.id; });
        dn.forEach(function (r) { ids[ckey(r.id)] = r.id; });
        var fused = Object.keys(ids).map(function (k) { return { id: ids[k], score: ALPHA * (bmN[k] || 0) + (1 - ALPHA) * (dnN[k] || 0) }; });
        fused.sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
        var top = fused.slice(0, K);
        return { rows: top.map(function (r) { return rowOf(r.id, { score: r.score }); }),
          note: 'Hybrid · weighted α=0.7·BM25 + 0.3·RAG-dense (' + meta.model + '), min-max normalized fusion over ' + bundle.doc_ids.length + ' datasets' };
      });
    }).catch(function (e) {
      if (typeof console !== 'undefined' && console.error) console.error('[OCMethods] hybrid run failed:', e);
      throw new Error('Hybrid needs the in-browser embedding model, which could not run on this device (likely no WebGPU / memory). Try BM25 — it runs fully offline.');
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
      var shortName = agentModelShort(AGENT_MODEL_USED);
      onStatus('Running ' + shortName + ' in-browser (' + (AGENT_DEVICE_USED === 'webgpu' ? 'WebGPU' : 'WASM') + ')… (small model, may take a moment)');
      return generator(messages, { max_new_tokens: 256, do_sample: false, return_full_text: false }).then(function (out) {
        var txt = (out && out[0] && out[0].generated_text) || ''; if (Array.isArray(txt)) { var last = txt[txt.length - 1]; txt = (last && last.content) || ''; }
        var rank = []; try { var mm = String(txt).match(/\{[\s\S]*\}/); var pj = JSON.parse(mm ? mm[0] : txt); if (pj && pj.ranking) rank = pj.ranking; } catch (e) {}
        if (!rank.length) { var re = /"id"\s*:\s*"([^"]+)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?/g, x; while ((x = re.exec(String(txt)))) rank.push({ id: x[1], reason: x[2] || '' }); }
        var seen = {}, rows = [];
        rank.forEach(function (r) { var k = ckey(r && r.id); if (recById[k] && !seen[k]) { seen[k] = 1; rows.push(rowOf(r.id, { reason: r.reason })); } });
        rows = rows.slice(0, K);
        return { rows: rows,
          note: 'LLM-agent · ' + agentModelShort(AGENT_MODEL_USED) + '-Instruct (ONNX, in-browser, ' + (AGENT_DEVICE_USED === 'webgpu' ? 'WebGPU' : 'WASM') + ') · re-rank of a BM25 shortlist · ' + rows.length + ' picks (invalid ids dropped). ⚠ small demo model, NOT the 7B/14B benchmark models.' };
      });
    }).catch(function (e) {
      // Surface a human-readable message instead of a raw WASM abort code (e.g. an OOM pointer like "3587054648").
      if (typeof console !== 'undefined' && console.error) console.error('[OCMethods] agent run failed:', e);
      throw new Error(FRIENDLY_AGENT);
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
      if (mode === 'hybrid') return runHybrid(q, onStatus);
      if (mode === 'agent') return runAgent(q, onStatus);
      return runBM25(q);
    });
  }

  window.OCMethods = {
    run: run, ensureCorpus: ensureCorpus, device: DEVICE,
    LABELS: { bm25: 'BM25 (lexical)', dense: 'RAG-dense (bge-small)', hybrid: 'Hybrid (BM25 + RAG-dense)', agent: 'LLM-agent (Qwen2.5)' },
    _onProg: function () {}
  };
})();
