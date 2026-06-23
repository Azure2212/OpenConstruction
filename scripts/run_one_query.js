// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// run_one_query.js — run the REAL benchmarked agent (agent.run + 23 tools + frozen prompt) on ONE
// free-text query, against a live vLLM endpoint. Prints the answer (top-k) + full tool-call trace
// (which tools, in what order, whether submit_answer was called). Same harness as run_live_agent_full.js.
//   node scripts/run_one_query.js --base http://<node>:<port>/v1 [--model M] [--q "object detection"] [--k 8]

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var AT = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var Agent = require(path.join(ROOT, 'assets/js/agent.js'));
var LLM = require(path.join(ROOT, 'assets/js/llm-client.js'));
function argVal(f, d) { var i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

var BASE = argVal('--base'); if (!BASE) { console.error('need --base'); process.exit(1); }
var MODEL = argVal('--model', 'Qwen2.5-7B-Instruct');
var Q = argVal('--q', 'object detection');
var K = parseInt(argVal('--k', '8'), 10);
var TASK = argVal('--task', '');         // structured need.task label (e.g. "Object detection"); '' = free-text
var MODALITY = argVal('--modality', ''); // structured need.modality; '' = leave empty (agent must not invent)

var client = LLM.createClient({ baseUrl: BASE, model: MODEL, temperature: 0, max_tokens: 700, timeout_ms: 120000 });
var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var benchPath = path.join(ROOT, 'data/benchmark-results.json');
var benchmarkResults = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;
var tools = AT.createTools(api, corpus, taxonomy, { benchmarkResults: benchmarkResults });
var LOOP = argVal('--loop', 'v1');
var MAXSTEPS = argVal('--max-steps', null);
var agentDeps = { api: api, corpus: corpus, taxonomy: taxonomy, tools: tools, llm: client, loopVersion: LOOP };
if (MAXSTEPS) agentDeps.maxSteps = parseInt(MAXSTEPS, 10);
var agent = Agent.createAgent(agentDeps);

(async function () {
  console.log('=== REAL benchmarked agent | model=' + MODEL + ' | prompt=' + Agent.SYSTEM_PROMPT_VERSION + ' | LOOP=' + LOOP + (MAXSTEPS ? (' maxSteps=' + MAXSTEPS) : '') + ' | q="' + Q + '" | task="' + TASK + '" | modality="' + MODALITY + '" | k=' + K + ' ===');
  // Discovery/retrieve task input — same shape the Category-A goldenset feeds the agent.
  var input = { q: Q, need: { task: TASK, modality: MODALITY, license: 'any' }, k: K };
  var t0 = Date.now(), r;
  try { r = await agent.run(input); } catch (e) { console.error('agent.run ERROR: ' + (e && e.message || e)); process.exit(1); }
  var ms = Date.now() - t0;
  var trace = r.trace || [];
  var seq = trace.map(function (t) { return t.tool; });
  console.log('\nTOOL TRACE (' + seq.length + ' calls): ' + (seq.join(' -> ') || '(none)'));
  trace.forEach(function (t, i) { console.log('  [' + (i + 1) + '] ' + t.tool + '  args=' + JSON.stringify(t.args || t.input || {}).slice(0, 140)); });
  console.log('\nsubmit_answer called: ' + (seq.indexOf('submit_answer') >= 0 ? 'YES' : 'NO'));
  console.log('steps=' + r.steps + ' | llm_calls=' + (r.usage && r.usage.calls) + ' | latency=' + ms + 'ms | ok=' + r.ok);
  var a = r.answer || {};
  var ids = [].concat(a.selected_ids || [], (a.selected_ids ? [] : (a.ranking || [])));
  console.log('abstained=' + a.abstained + ' | n_selected=' + ids.length);
  console.log('\nTOP-' + K + ' datasets returned:');
  if (!ids.length) console.log('  (none)');
  ids.slice(0, K).forEach(function (id) { var rec = corpus.byId.get(ckey(id)); console.log('  - ' + id + (rec ? (' | ' + rec.name) : '')); });
  console.log('\nRAW answer: ' + JSON.stringify(a).slice(0, 400));
})();
