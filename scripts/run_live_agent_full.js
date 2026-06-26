// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// run_live_agent_full.js — score the LIVE LLM-agent over the FULL benchmark (Category A-F) through the SAME
// graders as the engine/RAG baselines, via the REAL agent.run (agent loop + tools + frozen system prompt).
// The injected llm is the live vLLM client (swap-in for the integration-harness stub; ZERO algorithm change).
// Deterministic single-pass (temp=0); pass@k/seeds later. Robust: per-case errors are counted, not fatal.
//   node scripts/run_live_agent_full.js --base http://<node>:<port>/v1 [--model M] [--cats ABCDEF]
//        [--concurrency 8] [--out results.json] [--max-steps 8]
// --base overrides .llm-config.json baseUrl (the server node changes every SLURM job — read it from server.addr).

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var AT = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var Agent = require(path.join(ROOT, 'assets/js/agent.js'));
var LLM = require(path.join(ROOT, 'assets/js/llm-client.js'));
function argVal(f, d) { var i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
function die(m) { console.error('\n✗ ' + m + '\n'); process.exit(1); }

var BASE = argVal('--base', null);
var CATS = (argVal('--cats', 'ABCDEF')).toUpperCase();
var CONC = parseInt(argVal('--concurrency', '8'), 10);
var MAXSTEPS = parseInt(argVal('--max-steps', '8'), 10);
var OUT = argVal('--out', null);
var cfg = {};
try { cfg = LLM.loadConfig(path.join(ROOT, '.llm-config.json')); } catch (e) { if (!BASE) die('need --base or a .llm-config.json: ' + e.message); }
var clientCfg = { baseUrl: BASE || cfg.baseUrl, model: argVal('--model', cfg.model || 'Qwen2.5-7B-Instruct'), temperature: 0, max_tokens: cfg.max_tokens || 700, timeout_ms: cfg.timeout_ms || 120000 };
if (!clientCfg.baseUrl) die('no baseUrl (pass --base http://<node>:<port>/v1)');
var client = LLM.createClient(clientCfg);

var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var benchPath = path.join(ROOT, 'data/benchmark-results.json');
var benchmarkResults = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;
var tools = AT.createTools(api, corpus, taxonomy, { benchmarkResults: benchmarkResults });
function loadCat(f) { var p = path.join(ROOT, 'data', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }

// bounded-concurrency pool
async function pool(items, n, worker) { var i = 0; async function next() { while (i < items.length) { var k = i++; await worker(items[k], k); } } var ps = []; for (var c = 0; c < Math.min(n, items.length); c++) ps.push(next()); await Promise.all(ps); }

// gradeViaAgent (LIVE): pass1 capture grader inputs -> pass2 run REAL agent.run per unique input (concurrent,
// robust) -> pass3 grade with a sync lookup into the live-agent answers.
var STATS = { runs: 0, errors: 0, agentMs: 0 };
async function gradeViaAgent(graderWrap, categoryJson, label) {
  var agent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tools, llm: client, maxSteps: MAXSTEPS });
  var inputs = []; graderWrap(function (inp) { inputs.push(inp); return {}; }, categoryJson);          // pass 1
  var uniq = {}; inputs.forEach(function (inp) { uniq[JSON.stringify(inp)] = inp; });
  var keys = Object.keys(uniq); var cache = {}; var done = 0;
  await pool(keys, CONC, async function (k) {                                                          // pass 2 (live)
    var t0 = Date.now();
    try { var r = await agent.run(uniq[k]); cache[k] = r.answer || {}; }
    catch (e) { cache[k] = {}; STATS.errors++; }
    STATS.runs++; STATS.agentMs += Date.now() - t0; done++;
    if (done % 20 === 0 || done === keys.length) process.stderr.write('  [' + label + '] ' + done + '/' + keys.length + ' agent runs\r');
  });
  process.stderr.write('\n');
  return graderWrap(function (inp) { return cache[JSON.stringify(inp)] || {}; }, categoryJson);          // pass 3
}

(async function () {
  // preflight
  try { await client.chat([{ role: 'user', content: 'reply ok' }], undefined); } catch (e) { die('endpoint not reachable at ' + clientCfg.baseUrl + ': ' + (e && e.message || e)); }
  console.log('LIVE full run | model=' + clientCfg.model + ' | base=' + clientCfg.baseUrl + ' | prompt=' + Agent.SYSTEM_PROMPT_VERSION + ' | temp=0 single-pass | concurrency=' + CONC);
  var t0 = Date.now(); var results = { model: clientCfg.model, prompt: Agent.SYSTEM_PROMPT_VERSION, base: clientCfg.baseUrl, categories: {} };

  if (CATS.indexOf('A') >= 0) { var gs = loadCat('data-agent-goldenset.json');
    var A = await gradeViaAgent(function (fn, c) { return api.benchmarkAgent(fn, c, corpus); }, gs, 'A');
    results.categories.A = { precisionAtK: A.precisionAtK, recallAtK: A.recallAtK, ndcgAtK: A.ndcgAtK, fitnessAccuracy: A.fitnessAccuracy, licenseCorrectness: A.licenseCorrectness, abstentionCorrectness: A.abstentionCorrectness, hallucinationRate: A.hallucinationRate, cases: A.cases };
    console.log('A (discovery/fitness/license/abstain):', JSON.stringify(results.categories.A)); }
  if (CATS.indexOf('B') >= 0) { var B = await gradeViaAgent(function (fn, c) { return api.benchmarkAccessLicense(fn, c); }, loadCat('benchmark-category-B.json'), 'B');
    results.categories.B = { accessStatusAccuracy: B.accessStatusAccuracy, licenseCorrectness: B.licenseCorrectness }; console.log('B (access):', JSON.stringify(results.categories.B)); }
  if (CATS.indexOf('C') >= 0) { var C = await gradeViaAgent(function (fn, c) { return api.benchmarkRetrieve(fn, c); }, loadCat('benchmark-category-C.json'), 'C');
    results.categories.C = { formatAccuracy: C.formatAccuracy, inventoryExactAccuracy: C.inventoryExactAccuracy, corruptMissingDetection: C.corruptMissingDetection }; console.log('C (retrieve):', JSON.stringify(results.categories.C)); }
  if (CATS.indexOf('D') >= 0) { var D = await gradeViaAgent(function (fn, c) { return api.benchmarkProfile(fn, c); }, loadCat('benchmark-category-D.json'), 'D');
    results.categories.D = { profileAccuracy: D.profileAccuracy, toolSelectionAccuracy: D.toolSelectionAccuracy, edgeCaseAccuracy: D.edgeCaseAccuracy }; console.log('D (profile):', JSON.stringify(results.categories.D)); }
  if (CATS.indexOf('E') >= 0) { var E = await gradeViaAgent(function (fn, c) { return api.benchmarkAgentCompare(fn, c); }, loadCat('benchmark-category-E.json'), 'E');
    results.categories.E = { meanNDCG: E.meanNDCG, top1Accuracy: E.top1Accuracy, meanTau: E.meanTau }; console.log('E (compare):', JSON.stringify(results.categories.E)); }
  if (CATS.indexOf('F') >= 0) { var F = await gradeViaAgent(function (fn, c) { return api.benchmarkPrep(fn, c); }, loadCat('benchmark-category-F.json'), 'F');
    results.categories.F = { conversionAccuracy: F.conversionAccuracy, splitCorrectness: F.splitCorrectness, annotationValidityAccuracy: F.annotationValidityAccuracy }; console.log('F (prep):', JSON.stringify(results.categories.F)); }

  results.runtime_s = +((Date.now() - t0) / 1000).toFixed(1);
  results.agent_runs = STATS.runs; results.run_errors = STATS.errors; results.mean_agent_ms = STATS.runs ? Math.round(STATS.agentMs / STATS.runs) : 0;
  console.log('\nRUNTIME ' + results.runtime_s + 's | agent_runs=' + results.runs + ' (' + STATS.runs + ') | errors=' + STATS.errors + ' | mean ' + results.mean_agent_ms + 'ms/run');
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); console.log('wrote ' + OUT); }
})().catch(function (e) { die('full run failed: ' + (e && e.message || e)); });
