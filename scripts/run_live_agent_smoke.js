// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// run_live_agent_smoke.js — SMOKE-TEST the LLM-agent against a LIVE vLLM endpoint (Qwen2.5-7B-Instruct).
// Builds the REAL agent (agent.run + tools + submit_answer) with the LIVE llm client injected (the same
// `createAgent` the integration harness uses with a stub — here the stub is swapped for the real client,
// ZERO algorithm change). Runs 2-3 cases, prints the tool TRACE, checks NO fabrication, logs latency/tokens.
// It does NOT score the full 144 — that waits for sign-off.
//   node scripts/run_live_agent_smoke.js [--config .llm-config.json] [--max-steps 8]

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var AT = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var Agent = require(path.join(ROOT, 'assets/js/agent.js'));
var LLM = require(path.join(ROOT, 'assets/js/llm-client.js'));
function argVal(f) { var i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; }
function die(m) { console.error('\n✗ ' + m + '\n'); process.exit(1); }
function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

var CONFIG = argVal('--config') || path.join(ROOT, '.llm-config.json');
var MAXSTEPS = parseInt(argVal('--max-steps') || '8', 10);
var BASE = argVal('--base');               // override server (per-job localhost; same as run_live_agent_full)
var cfg = {}; try { cfg = LLM.loadConfig(CONFIG); } catch (e) { if (!BASE) die('config: ' + e.message); }
if (BASE) cfg.baseUrl = BASE;
if (argVal('--model')) cfg.model = argVal('--model');
if (!cfg.baseUrl || !cfg.model) die('need --base + --model (the vLLM server + served-model-name).');
var client = LLM.createClient(cfg);

var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var benchPath = path.join(ROOT, 'data/benchmark-results.json');
var benchmarkResults = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;
var tools = AT.createTools(api, corpus, taxonomy, { benchmarkResults: benchmarkResults });
var agent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tools, llm: client, maxSteps: MAXSTEPS });

// 2-3 smoke cases across task types (GT hidden from the agent; we only check shape + no-fabrication).
var CASES = [
  { label: 'DISCOVERY', input: { q: 'object detection dataset', need: { task: 'Object detection', modality: '', license: 'any' }, k: 5 } },
  { label: 'FITNESS',   input: { need: { task: 'Object detection', modality: '', license: 'any' }, k: 5, fitness_target: 'ACID' } },
  { label: 'RETRIEVE',  input: { path: 'data/samples/PC-Urban', subtype: 'inventory' } }
];

(async function () {
  // preflight: endpoint reachable + model served?
  try { var t0 = Date.now(); var probe = await client.chat([{ role: 'user', content: 'reply with the single word: ok' }], undefined); console.log('endpoint OK (' + (Date.now() - t0) + 'ms) | model=' + cfg.model + ' | ' + cfg.baseUrl + ' | probe="' + String(probe.content || '').slice(0, 40).replace(/\n/g, ' ') + '"'); }
  catch (e) { die('vLLM endpoint not reachable / not ready at ' + cfg.baseUrl + ':\n  ' + (e && e.message || e)); }

  var corpusIds = new Set(corpus.datasets.map(function (d) { return ckey(d.id); }));
  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    console.log('\n──────── [' + c.label + '] input=' + JSON.stringify(c.input));
    var t0 = Date.now(); var r;
    try { r = await agent.run(c.input); } catch (e) { console.log('  ✗ run error: ' + (e && e.message || e)); continue; }
    var ms = Date.now() - t0;
    var seq = (r.trace || []).map(function (t) { return t.tool; });
    console.log('  tool sequence : ' + (seq.join(' -> ') || '(none)'));
    console.log('  steps=' + r.steps + ' | latency=' + ms + 'ms | llm_calls=' + (r.usage && r.usage.calls) + ' | tokens p/c=' + (r.usage && r.usage.prompt_tokens) + '/' + (r.usage && r.usage.completion_tokens) + ' | ok=' + r.ok);
    var a = r.answer || {};
    // shape + NO-FABRICATION checks (every emitted dataset id must exist in the corpus)
    var emitted = [].concat(a.selected_ids || [], a.ranking || [], (a.fitness_verdict ? [a.fitness_verdict.id] : []));
    var fake = emitted.filter(function (id) { return !corpusIds.has(ckey(id)); });
    console.log('  answer        : ' + JSON.stringify({ selected_ids: a.selected_ids, fitness_verdict: a.fitness_verdict, inventory: a.inventory, abstained: a.abstained }).slice(0, 240));
    console.log('  no-fabrication: ' + (fake.length === 0 ? 'OK (all ids real)' : '✗ FABRICATED: ' + JSON.stringify(fake)));
    console.log('  tool-call parse OK: ' + (seq.length > 0 ? 'yes (native tool_calls dispatched)' : 'NO tool call emitted — check tool-parser'));
  }
  console.log('\n✓ smoke done (NOT scoring full 144 — awaiting sign-off).');
})().catch(function (e) { die('smoke failed: ' + (e && e.message || e)); });
