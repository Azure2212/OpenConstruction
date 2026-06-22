// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// rag-baseline.js — RAG-style RETRIEVAL baselines for the Bước-6 experiment (the weak-retrieval baseline the
// .doc experiment design anticipates). Each baseline is an AGENT-AGNOSTIC `agentRunFn` with the SAME contract
// as the tool-agent ({selected_ids, ranking, fitness_verdict?, abstained}), so the SAME grader
// (`benchmarkAgent` over Category-A) scores it head-to-head:  RAG-lexical vs RAG-dense vs tool-agent.
//
//   (1) RAG-lexical  = real BM25 (Lucene-style idf, k1=1.5 b=0.75) over the 136 metadata records. Pure code,
//                      $0, deterministic, runs in CI now.
//   (2) RAG-dense    = cosine over embeddings from the OpenAI-compatible /embeddings endpoint
//                      (LM Studio `text-embedding-nomic`). Wired to run when the tunnel is up; CI tests the
//                      cosine/ranking math on fixed vectors and never calls the network.
//
// FAIRNESS: the retrieval itself is a real BM25 (not a strawman). What RAG lacks vs the tool-agent — license/
// constraint enforcement, structured task-graph fitness, principled abstention — is left NAIVE on purpose:
// that gap is exactly the experimental finding. RAG abstains only on ZERO lexical overlap (no tuned threshold);
// it ignores the license facet; fitness = "is the target among what I'd retrieve for this need".

(function () {
  'use strict';
  function norm(s) { return String(s == null ? '' : s).toLowerCase(); }
  var STOP = { the: 1, a: 1, an: 1, of: 1, for: 1, and: 1, or: 1, to: 1, in: 1, on: 1, with: 1, from: 1, by: 1, dataset: 1, datasets: 1, data: 1 };
  function tokenize(text) { return norm(text).split(/[^a-z0-9]+/).filter(function (t) { return t && t.length > 1 && !STOP[t]; }); }
  // Searchable document text per record: name + tasks + modality + annotation + class names + note.
  function docText(rec) {
    return [rec.name, (rec.tasksRaw || []).join(' '), rec.modalityRaw || '', (rec.annotationRaw || []).join(' '), (rec.classes || []).join(' '), rec.note || '']
      .filter(Boolean).join(' ');
  }
  // Query text from a discovery need (free-text q + task + modality + annotation). License is a CONSTRAINT,
  // not a query term — deliberately excluded (the tool-agent enforces it; pure retrieval does not).
  function queryText(input) {
    var n = (input && input.need) || {};
    return [input && input.q, n.task, n.modality, n.annotation].filter(function (x) { return x && String(x).trim(); }).join(' ');
  }
  // corpus.byId is keyed by the engine's norm (lowercase + non-alnum->space + trim) — match it for lookups.
  function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function needRequiresCommercial(input) { var l = input && input.need && input.need.license; return !!(l && norm(l) !== 'any'); }
  // Canonical RAG metadata post-filter: when the need requires commercial use, drop non-commercial_ok records
  // from the ranked list (the corpus carries `rights.commercial_ok`). This is what any real RAG pipeline does.
  function applyLicenseFilter(ranked, corpus, input) {
    if (!needRequiresCommercial(input)) return ranked;
    return ranked.filter(function (r) { var rec = corpus.byId.get(ckey(r.id)); return !!(rec && rec.rights && rec.rights.commercial_ok === true); });
  }

  // ---------------------------------------------------------------- BM25 (real, Lucene-style)
  function buildBM25Index(corpus, opts) {
    opts = opts || {};
    var k1 = opts.k1 != null ? opts.k1 : 1.5, b = opts.b != null ? opts.b : 0.75;
    var docs = corpus.datasets.map(function (rec) {
      var toks = tokenize(docText(rec)), tf = {}; toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      return { id: rec.id, tf: tf, len: toks.length };
    });
    var N = docs.length, df = {}, totalLen = 0;
    docs.forEach(function (d) { totalLen += d.len; Object.keys(d.tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; }); });
    var avgdl = N ? totalLen / N : 0, idf = {};
    Object.keys(df).forEach(function (t) { idf[t] = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)); }); // Lucene BM25 idf (>0)
    return { docs: docs, N: N, avgdl: avgdl, idf: idf, k1: k1, b: b };
  }
  function bm25Score(index, qtokens, doc) {
    var k1 = index.k1, b = index.b, s = 0;
    qtokens.forEach(function (t) {
      var f = doc.tf[t]; if (!f) return; var idf = index.idf[t]; if (idf == null) return;
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.len / (index.avgdl || 1)));
    });
    return s;
  }
  function bm25Rank(index, qtext) {
    var q = Object.keys(tokenize(qtext).reduce(function (m, t) { m[t] = 1; return m; }, {}));  // unique query terms
    return index.docs.map(function (d) { return { id: d.id, score: +bm25Score(index, q, d).toFixed(6) }; })
      .sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });  // deterministic tie-break
  }

  // ---------------------------------------------------------------- RAG-lexical agentRunFn (BM25)
  // opts.licenseFilter (bool): apply the canonical license post-filter. false => RAG-naive (honest lower bound);
  // true => RAG+filter (the FAIR comparison — a real RAG pipeline would post-filter on the commercial_ok facet).
  function makeLexicalRetriever(corpus, opts) {
    opts = opts || {};
    var index = buildBM25Index(corpus, opts);
    function run(input) {
      var k = (input && input.k) || opts.k || 5;
      var ranked = bm25Rank(index, queryText(input));
      if (opts.licenseFilter) ranked = applyLicenseFilter(ranked, corpus, input);
      if (input && input.fitness_target) {                                  // RAG fitness = target in top-k for the need
        var topk = ranked.slice(0, k), tgt = norm(input.fitness_target);
        var fit = topk.some(function (r) { return norm(r.id) === tgt; });
        return { selected_ids: [], ranking: [], fitness_verdict: { id: input.fitness_target, verdict: fit ? 'fit' : 'unfit' }, abstained: false };
      }
      var top = ranked.slice(0, k).filter(function (r) { return r.score > 0; });   // drop zero-overlap tail
      var abstain = top.length === 0, ids = top.map(function (r) { return r.id; });  // abstain ONLY on zero overlap
      return { selected_ids: abstain ? [] : ids, ranking: ids, abstained: abstain };
    }
    run.index = index; run.kind = opts.licenseFilter ? 'rag-lexical-bm25+license-filter' : 'rag-lexical-bm25';
    return run;
  }

  // ---------------------------------------------------------------- RAG-dense (embeddings)
  function cosine(a, b) {
    var dot = 0, na = 0, nb = 0, n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
  function buildDenseIndex(ids, vecs) { return { ids: ids, vecs: vecs }; }
  function denseRank(denseIndex, queryVec) {
    return denseIndex.ids.map(function (id, i) { return { id: id, score: +cosine(queryVec, denseIndex.vecs[i]).toFixed(6) }; })
      .sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  }
  // agentRunFn over a prebuilt dense index + a SYNC query-vector lookup (benchmarkAgent is sync, so queries
  // are embedded ahead of time and looked up by queryText). See prepareDenseRetriever for the async wiring.
  function makeDenseRetriever(corpus, denseIndex, queryVecOf, opts) {
    opts = opts || {};
    function run(input) {
      var k = (input && input.k) || opts.k || 5;
      var qv = queryVecOf(queryText(input));
      if (!qv) return { selected_ids: [], ranking: [], abstained: true, _no_query_vec: true };
      var ranked = denseRank(denseIndex, qv);
      if (opts.licenseFilter) ranked = applyLicenseFilter(ranked, corpus, input);   // same fair filter as lexical
      if (input && input.fitness_target) {
        var topk = ranked.slice(0, k), tgt = norm(input.fitness_target);
        return { selected_ids: [], ranking: [], fitness_verdict: { id: input.fitness_target, verdict: topk.some(function (r) { return norm(r.id) === tgt; }) ? 'fit' : 'unfit' }, abstained: false };
      }
      var top = ranked.slice(0, k), ids = top.map(function (r) { return r.id; });
      return { selected_ids: ids, ranking: ids, abstained: false };
    }
    run.kind = 'rag-dense-embeddings'; run.denseIndex = denseIndex;
    return run;
  }
  // ASYNC — call when the tunnel is up. Embeds the 136 docs + every goldenset query via the llm-client
  // `embed`, then returns a ready agentRunFn to drop into benchmarkAgent (zero further code change).
  function prepareDenseRetriever(corpus, embedClient, goldenSet, opts) {
    opts = opts || {};
    var docTexts = corpus.datasets.map(docText), ids = corpus.datasets.map(function (d) { return d.id; });
    return Promise.resolve(embedClient.embed(docTexts, opts.embedModel)).then(function (docVecs) {
      var denseIndex = buildDenseIndex(ids, docVecs);
      var qset = {}; (goldenSet.cases || []).forEach(function (c) { qset[queryText({ q: c.q, need: c.need })] = 1; });
      var qlist = Object.keys(qset);
      return Promise.resolve(embedClient.embed(qlist, opts.embedModel)).then(function (qvecs) {
        var map = {}; qlist.forEach(function (q, i) { map[q] = qvecs[i]; });
        return makeDenseRetriever(corpus, denseIndex, function (q) { return map[q]; }, opts);
      });
    });
  }

  var API = { tokenize: tokenize, docText: docText, queryText: queryText,
    buildBM25Index: buildBM25Index, bm25Score: bm25Score, bm25Rank: bm25Rank, makeLexicalRetriever: makeLexicalRetriever,
    cosine: cosine, buildDenseIndex: buildDenseIndex, denseRank: denseRank, makeDenseRetriever: makeDenseRetriever, prepareDenseRetriever: prepareDenseRetriever };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCRagBaseline = API;
})();
