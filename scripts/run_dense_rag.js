// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// run_dense_rag.js — TURNKEY runner for the RAG-DENSE baseline. Needs a LIVE OpenAI-compatible
// /v1/embeddings endpoint (LM Studio `text-embedding-nomic`). It NEVER silently falls back to the chat
// model — if `embedModel` is missing or the endpoint is unreachable it FAILS LOUDLY. Same metric set as
// RAG-lexical, so the dense row drops straight into the Category-A comparison table.
//
// USAGE (when the GPU/endpoint is up — nothing else to wire):
//   node scripts/run_dense_rag.js                  -> score RAG-dense on Category-A (144 cases)
//   node scripts/run_dense_rag.js --filter         -> same, with the canonical license post-filter
//   node scripts/run_dense_rag.js --query "..."    -> top-k docs for ONE arbitrary user query (+cosine)
//   flags: --k N (default 5) · --config <path> (default .llm-config.json)

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var RAG = require(path.join(ROOT, 'assets/js/rag-baseline.js'));
var LLM = require(path.join(ROOT, 'assets/js/llm-client.js'));

function argVal(flag) { var i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; }
function hasFlag(f) { return process.argv.indexOf(f) >= 0; }
function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }

var QUERY = argVal('--query');
var K = parseInt(argVal('--k') || '5', 10);
var USE_FILTER = hasFlag('--filter');
var CONFIG = argVal('--config') || path.join(ROOT, '.llm-config.json');
var CACHE = argVal('--cache');

// ---- LOAD-FROM-CACHE mode (no endpoint, no embedModel): score RAG-dense from a pre-embedded cache built once
// on GPU (dense_cache.json). Scores BOTH naive + license-filter on the goldenset. "Tạo 1 lần dùng mãi."
if (CACHE) {
  var RAG = require(path.join(ROOT, 'assets/js/rag-baseline.js'));
  api.setTaxonomy(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8')));
  var cCorpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
  var cGs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/data-agent-goldenset.json'), 'utf8'));
  if (!fs.existsSync(CACHE)) die('cache not found: ' + CACHE);
  var cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.log('dense cache:', JSON.stringify(cache._meta));
  function denseRow(name, filt) {
    var fn = RAG.makeDenseRetrieverFromCache(cCorpus, cache, { licenseFilter: filt, k: K });
    var r = api.benchmarkAgent(fn, cGs, cCorpus);
    console.log('  ' + name.padEnd(16) + JSON.stringify({ P: r.precisionAtK, R: r.recallAtK, nDCG: r.ndcgAtK, fit: r.fitnessAccuracy, lic: r.licenseCorrectness, abs: r.abstentionCorrectness, halluc: r.hallucinationRate }));
    return r;
  }
  console.log('\nRAG-DENSE (nomic) — Category-A (k=' + K + ', cache-scored, deterministic):');
  denseRow('RAG-dense', false);
  denseRow('RAG-dense+filter', true);
  process.exit(0);
}

// ---- X-guard: load config + REFUSE to run without an embedding model (never embed with the chat model)
var cfg;
try { cfg = LLM.loadConfig(CONFIG); }
catch (e) { die('Config load failed: ' + e.message + '\n  -> cp .llm-config.example.json ' + path.relative(ROOT, CONFIG) + '  (then set "embedModel").'); }
if (!cfg.embedModel) die('Config "' + path.relative(ROOT, CONFIG) + '" is missing "embedModel" (e.g. "text-embedding-nomic").\n  Refusing to embed with the CHAT model "' + cfg.model + '". Add  "embedModel": "text-embedding-nomic"  and retry.');
var client = LLM.createClient(cfg);

// ---- data (deterministic; same corpus/goldenset as every other scorer)
api.setTaxonomy(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8')));
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var gs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/data-agent-goldenset.json'), 'utf8'));

// ---- preflight: a 1-token probe so an endpoint problem is a CLEAR message, not a 136-doc stack trace
function preflight() {
  return Promise.resolve(client.embed(['preflight'], cfg.embedModel)).then(function (v) {
    if (!Array.isArray(v) || !Array.isArray(v[0]) || !v[0].length) die('Embeddings endpoint returned no vector — is model "' + cfg.embedModel + '" loaded at ' + cfg.baseUrl + '?');
    console.log('endpoint OK  | ' + cfg.baseUrl + '/embeddings | embedModel=' + cfg.embedModel + ' | dim=' + v[0].length);
  }).catch(function (e) { die('Embeddings endpoint NOT reachable at ' + cfg.baseUrl + '/embeddings:\n  ' + (e && e.message || e) + '\n  -> start the endpoint (LM Studio) and load "' + cfg.embedModel + '".'); });
}

function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// ---- mode A: ONE user query -> dense top-k docs (what the user means by "prompt -> results")
function runQuery() {
  var docTexts = corpus.datasets.map(RAG.docText), ids = corpus.datasets.map(function (d) { return d.id; });
  return Promise.resolve(client.embed(docTexts, cfg.embedModel)).then(function (docVecs) {
    var di = RAG.buildDenseIndex(ids, docVecs);
    return Promise.resolve(client.embed([QUERY], cfg.embedModel)).then(function (qv) {
      var ranked = RAG.denseRank(di, qv[0]).slice(0, K);
      console.log('\nRAG-DENSE top-' + K + ' for query: "' + QUERY + '"');
      ranked.forEach(function (r, i) { var rec = corpus.byId.get(ckey(r.id)); console.log('  ' + (i + 1) + '. ' + r.id + '  (cos=' + r.score + ')  ' + ((rec && rec.name) || '')); });
    });
  });
}

// ---- mode B: full Category-A scoring (same metric set as RAG-lexical -> drops into the comparison table)
function runBench() {
  return RAG.prepareDenseRetriever(corpus, client, gs, { embedModel: cfg.embedModel, licenseFilter: USE_FILTER }).then(function (denseFn) {
    var R = api.benchmarkAgent(denseFn, gs, corpus);
    console.log('\nRAG-DENSE' + (USE_FILTER ? '+license-filter' : '') + ' — Category-A (k=' + R.k + ', ' + R.cases + ' cases):');
    console.log('  ' + JSON.stringify({ precision: R.precisionAtK, recall: R.recallAtK, nDCG: R.ndcgAtK, fitness: R.fitnessAccuracy, license: R.licenseCorrectness, abstention: R.abstentionCorrectness, halluc: R.hallucinationRate }));
    console.log('  (paste this row beside RAG-naive / RAG+filter / tool-agent)');
  });
}

preflight()
  .then(function () { return QUERY != null ? runQuery() : runBench(); })
  .then(function () { console.log('\n✓ done.'); })
  .catch(function (e) { die('Run failed: ' + (e && e.message || e)); });
