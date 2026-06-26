// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// test_rag_baseline.js — CI for the RAG retrieval baselines (Bước-6). Verifies the real BM25 (lexical),
// scores it through the SAME grader (benchmarkAgent / Category-A) for a fair head-to-head vs the tool-agent,
// and exercises the dense (embedding) path end-to-end with a FAKE embedder (no network). Model-free.
//   run: node scripts/test_rag_baseline.js   (from OpenConstruction/)

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var RAG = require(path.join(ROOT, 'assets/js/rag-baseline.js'));
var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var gs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/data-agent-goldenset.json'), 'utf8'));

var pass = 0, fail = 0;
function check(n, c, extra) { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra != null ? '-> ' + JSON.stringify(extra).slice(0, 280) : ''); } }
function approx(a, b) { return Math.abs(a - b) < 1e-3; }

console.log('\n[1] BM25 index — real (Lucene-style idf, k1=1.5 b=0.75), deterministic');
(function () {
  var idx = RAG.buildBM25Index(corpus);
  check('index covers all 136 records + positive idf + avgdl>0', idx.N === 136 && idx.avgdl > 0 && Object.keys(idx.idf).length > 100 && Object.values(idx.idf).every(function (v) { return v > 0; }), { N: idx.N, vocab: Object.keys(idx.idf).length });
  var r1 = RAG.bm25Rank(idx, 'object detection'), r2 = RAG.bm25Rank(idx, 'object detection');
  check('ranking is deterministic (repeat-equal) + descending score', JSON.stringify(r1) === JSON.stringify(r2) && r1.every(function (x, i) { return i === 0 || r1[i - 1].score >= x.score; }));
  check('relevant terms retrieve real ids with score>0 (no strawman)', r1[0].score > 0 && corpus.byId.has(String(r1[0].id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  check('tokenize drops stopwords/short tokens', RAG.tokenize('the a of Object Detection dataset').join(',') === 'object,detection');
  // a query with NO lexical overlap scores 0 everywhere
  check('zero-overlap query -> all scores 0', RAG.bm25Rank(idx, 'zzqq xxyy nonexistent').every(function (x) { return x.score === 0; }));
})();

console.log('\n[2] RAG-lexical as an agent-agnostic agentRunFn (same contract as the tool-agent)');
(function () {
  var lex = RAG.makeLexicalRetriever(corpus);
  var out = lex({ q: 'object detection dataset', need: { task: 'Object detection', modality: '', license: 'any' }, k: 5 });
  check('returns {selected_ids, ranking, abstained} with real top-k ids', Array.isArray(out.selected_ids) && out.selected_ids.length === 5 && Array.isArray(out.ranking) && out.selected_ids.every(function (id) { return corpus.byId.has(String(id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); }), out);
  // fitness: target-in-top-k proxy
  var fit = lex({ need: { task: 'Object detection', modality: '', license: 'any' }, k: 5, fitness_target: 'ACID' });
  check('fitness case -> fitness_verdict {id,verdict in fit|unfit}', fit.fitness_verdict && fit.fitness_verdict.id === 'ACID' && ['fit', 'unfit'].indexOf(fit.fitness_verdict.verdict) >= 0, fit);
  // abstain ONLY on zero overlap (honest, no tuned threshold)
  var ab = lex({ q: 'zzqq xxyy', need: { task: 'zzqq', modality: '', license: 'any' }, k: 5 });
  check('abstains only on zero lexical overlap', ab.abstained === true && ab.selected_ids.length === 0, ab);
})();

console.log('\n[3] 3-row head-to-head (Category-A): RAG-naive / RAG+license-filter / tool-agent — same grader');
(function () {
  var N = api.benchmarkAgent(RAG.makeLexicalRetriever(corpus), gs, corpus);                       // RAG-naive (lower bound)
  var Fl = api.benchmarkAgent(RAG.makeLexicalRetriever(corpus, { licenseFilter: true }), gs, corpus); // RAG + canonical license post-filter
  var T = api.benchmarkOn(corpus, gs);                                                             // tool-agent (deterministic engine)
  function row(name, r) { return '  ' + name.padEnd(12) + JSON.stringify({ P: r.precisionAtK, R: r.recallAtK, nDCG: r.ndcgAtK, fit: r.fitnessAccuracy, lic: r.licenseCorrectness, abs: r.abstentionCorrectness, halluc: r.hallucinationRate }); }
  console.log(row('RAG-naive', N)); console.log(row('RAG+filter', Fl)); console.log(row('tool-agent', T));

  // lock the deterministic numbers (regression guard)
  check('RAG-naive locked (P .503 / R .751 / nDCG .799 / fit .864 / lic .083 / abs .79)', approx(N.precisionAtK, 0.503) && approx(N.recallAtK, 0.751) && approx(N.ndcgAtK, 0.799) && approx(N.fitnessAccuracy, 0.864) && approx(N.licenseCorrectness, 0.083) && approx(N.abstentionCorrectness, 0.79) && N.hallucinationRate === 0, N);
  check('RAG+filter locked (P .545 / R .776 / nDCG .846 / fit .864 / lic 1.0 / abs .79)', approx(Fl.precisionAtK, 0.545) && approx(Fl.recallAtK, 0.776) && approx(Fl.ndcgAtK, 0.846) && approx(Fl.fitnessAccuracy, 0.864) && approx(Fl.licenseCorrectness, 1.0) && approx(Fl.abstentionCorrectness, 0.79) && Fl.hallucinationRate === 0, Fl);

  // FAIRNESS FIX (Critic 🔴): the canonical license post-filter takes RAG license .083 -> 1.0 (NOT a tool-agent
  // advantage), while precision/nDCG barely move -> license was a STRAWMAN differentiator.
  check('license post-filter fixes RAG license (.083 -> 1.0); precision/nDCG barely move (license was a strawman)',
    Fl.licenseCorrectness === 1.0 && Math.abs(Fl.precisionAtK - N.precisionAtK) < 0.06 && Math.abs(Fl.ndcgAtK - N.ndcgAtK) < 0.06);
  check('RAG+filter MATCHES the tool-agent on license (both 1.0) — not a differentiator', Fl.licenseCorrectness === 1.0 && T.licenseCorrectness === 1.0);

  // RE-ANCHORED "where the tool-agent earns its value" = the advantages that SURVIVE a fair filtered RAG:
  // precision (structured task-graph fitness), nDCG, fitness-acc, abstention. NOT license.
  check('tool-agent beats RAG+filter on PRECISION (structured task-graph fitness, not retrieval)', T.precisionAtK - Fl.precisionAtK > 0.3, { tool: T.precisionAtK, ragFilter: Fl.precisionAtK });
  check('tool-agent beats RAG+filter on nDCG + fitness-acc + abstention (the surviving advantages)', T.ndcgAtK > Fl.ndcgAtK && T.fitnessAccuracy > Fl.fitnessAccuracy && T.abstentionCorrectness > Fl.abstentionCorrectness, { nDCG: [Fl.ndcgAtK, T.ndcgAtK], fit: [Fl.fitnessAccuracy, T.fitnessAccuracy], abs: [Fl.abstentionCorrectness, T.abstentionCorrectness] });
  check('all three are FAIR baselines: competent retrieval + 0 hallucination', N.recallAtK >= 0.7 && Fl.recallAtK >= 0.7 && N.hallucinationRate === 0 && Fl.hallucinationRate === 0 && T.hallucinationRate === 0);
  check('deterministic (repeat-equal full reports)', JSON.stringify(api.benchmarkAgent(RAG.makeLexicalRetriever(corpus), gs, corpus)) === JSON.stringify(N) && JSON.stringify(api.benchmarkAgent(RAG.makeLexicalRetriever(corpus, { licenseFilter: true }), gs, corpus)) === JSON.stringify(Fl));
})();

console.log('\n[4] RAG-dense — cosine/rank math + end-to-end via a FAKE embedder (no network; proves the wiring)');
(function () {
  check('cosine: identical=1, orthogonal=0', approx(RAG.cosine([1, 2, 3], [1, 2, 3]), 1) && RAG.cosine([1, 0], [0, 1]) === 0);
  var di = RAG.buildDenseIndex(['A', 'B', 'C'], [[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0]]);
  check('denseRank orders by cosine (query~A -> A,C,B) deterministically', JSON.stringify(RAG.denseRank(di, [1, 0, 0]).map(function (x) { return x.id; })) === JSON.stringify(['A', 'C', 'B']));
  // FAKE embedder = deterministic bag-of-words hashing into 64 dims (stands in for text-embedding-nomic).
  // Tomorrow: swap fakeClient -> llmClient (createClient with embedModel) — ZERO further code change.
  function fakeEmbed(texts) {
    var DIM = 64;
    return Promise.resolve((Array.isArray(texts) ? texts : [texts]).map(function (t) {
      var v = new Array(DIM).fill(0);
      String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).forEach(function (tok) { var h = 0; for (var i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0; v[h % DIM] += 1; });
      return v;
    }));
  }
  var fakeClient = { embed: fakeEmbed };
  return RAG.prepareDenseRetriever(corpus, fakeClient, gs).then(function (denseAgentRunFn) {
    var out = denseAgentRunFn({ q: 'object detection dataset', need: { task: 'Object detection', modality: '', license: 'any' }, k: 5 });
    check('dense agentRunFn returns the same contract (real top-k ids, no fabrication)', Array.isArray(out.selected_ids) && out.selected_ids.length === 5 && out.selected_ids.every(function (id) { return corpus.byId.has(String(id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); }), out);
    var D = api.benchmarkAgent(denseAgentRunFn, gs, corpus);
    console.log('  RAG-dense (FAKE embedder, math-check only):', JSON.stringify({ precision: D.precisionAtK, recall: D.recallAtK, nDCG: D.ndcgAtK, halluc: D.hallucinationRate }));
    check('dense path runs end-to-end through benchmarkAgent + 0 hallucination (wiring works; real numbers need the tunnel)', typeof D.precisionAtK === 'number' && D.hallucinationRate === 0, D);

    console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
    process.exit(fail ? 1 : 0);
  });
})();
