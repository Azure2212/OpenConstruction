// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// test_agent_stub.js — headless CI test of the agent harness with a STUB LLM (no real model).
// Verifies: llm-client pure helpers; tool toolbox (primitives only, no oracle); agent loop for
// discovery / abstain / fitness paths; output contract; no fabricated ids.
//   run:  node scripts/test_agent_stub.js   (from OpenConstruction/)

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var agentTools = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var Agent = require(path.join(ROOT, 'assets/js/agent.js'));
var LLM = require(path.join(ROOT, 'assets/js/llm-client.js'));

var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));

var pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra != null ? '-> ' + JSON.stringify(extra) : ''); } }

// ---- helper: a scripted STUB llm that reacts to the last tool result (proves the feedback loop) ----
// `plan` decides what to call given the message history.
function makeStub(plan) { return { chat: function (messages, tools) { return Promise.resolve(plan(messages, tools)); } }; }
function lastToolMsg(messages, name) { for (var i = messages.length - 1; i >= 0; i--) { var m = messages[i]; if (m.role === 'tool' && (!name || m.name === name)) return m; } return null; }
function toolCall(name, args) { return { content: '', tool_calls: [{ id: name + '_1', type: 'function', function: { name: name, arguments: JSON.stringify(args) } }] }; }

console.log('\n[1] llm-client pure helpers (no network)');
(function () {
  var body = LLM.buildRequestBody({ model: 'm', max_tokens: 1500, temperature: 0 }, [{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'x', parameters: {} } }]);
  check('buildRequestBody sets model+max_tokens>=1500+tool_choice', body.model === 'm' && body.max_tokens >= 1500 && body.tools && body.tool_choice === 'auto', body);
  check('buildRequestBody omits tools when none', !('tools' in LLM.buildRequestBody({ model: 'm' }, [], [])), 'tools should be absent');
  // reasoning-model response: content + reasoning_content + tool_calls together
  var parsed = LLM.parseChatResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: 'thinking…', reasoning_content: 'CoT here', tool_calls: [{ id: 'a', type: 'function', function: { name: 'search_datasets', arguments: '{"modality":"point_cloud"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  check('parseChatResponse extracts tool_calls + content + reasoning', parsed.tool_calls && parsed.tool_calls.length === 1 && parsed.content === 'thinking…' && parsed.reasoning === 'CoT here', parsed);
  check('parseChatResponse null tool_calls when none', LLM.parseChatResponse({ choices: [{ message: { content: 'plain' } }] }).tool_calls === null);
})();

console.log('\n[2] toolbox = PRIMITIVES ONLY (no oracle)');
var tk = agentTools.createTools(api, corpus, taxonomy);
(function () {
  var names = tk.toolNames.sort();
  check('exposes exactly the primitive toolset', JSON.stringify(names) === JSON.stringify(['check_fitness', 'get_dataset', 'list_tasks', 'search_datasets', 'submit_answer']), names);
  check('NO oracle/selector tool exposed', names.indexOf('compare_select') < 0 && names.indexOf('recommend') < 0 && names.indexOf('solve') < 0 && names.indexOf('c4CompareSelect') < 0, names);
  var sd = tk.dispatch('search_datasets', { modality: 'point_cloud' });
  check('search_datasets returns candidates (no fit verdict leaked)', sd.results.length > 0 && sd.results[0].verdict === undefined && sd.results.every(function (r) { return corpus.byId.has(String(r.id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); }), { n: sd.results.length });
  var cf = tk.dispatch('check_fitness', { id: sd.results[0].id, modality: 'point_cloud' });
  check('check_fitness returns per-criterion verdict for ONE dataset', cf.verdict && Array.isArray(cf.criteria), cf);
  check('list_tasks returns vocabulary + modalities', tk.dispatch('list_tasks', {}).tasks.length > 0 && tk.dispatch('list_tasks', {}).modalities.indexOf('point_cloud') >= 0);
})();

(async function () {
  console.log('\n[3] agent loop — DISCOVERY (search -> submit, uses tool output)');
  var discAgent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tk, llm: makeStub(function (messages) {
    var st = lastToolMsg(messages, 'search_datasets');
    if (!st) return toolCall('search_datasets', { modality: 'point_cloud', query: 'point cloud' });
    var ids = (JSON.parse(st.content).results || []).slice(0, 2).map(function (r) { return r.id; });
    return toolCall('submit_answer', { selected_ids: ids, abstained: ids.length === 0 });
  }) });
  var d = await discAgent.run('point cloud datasets');
  check('discovery: ok + 2 real ids selected', d.ok && d.answer.selected_ids.length === 2 && d.answer.selected_ids.every(function (id) { return corpus.byId.has(id.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); }), d.answer);
  check('discovery: trace shows search then submit', d.trace.length === 2 && d.trace[0].tool === 'search_datasets' && d.trace[1].tool === 'submit_answer', d.trace.map(function (t) { return t.tool; }));
  check('discovery: not abstained', d.answer.abstained === false);

  console.log('\n[4] agent loop — ABSTAIN');
  var absAgent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tk, llm: makeStub(function (messages) {
    var st = lastToolMsg(messages, 'search_datasets');
    if (!st) return toolCall('search_datasets', { task: 'object detection', modality: 'gpr' });
    return toolCall('submit_answer', { selected_ids: [], abstained: true });
  }) });
  var ab = await absAgent.run('object detection on GPR radargrams');
  check('abstain: ok + abstained true + empty selection', ab.ok && ab.answer.abstained === true && ab.answer.selected_ids.length === 0, ab.answer);

  console.log('\n[5] agent loop — FITNESS verdict');
  var anyId = corpus.datasets[0].id;
  var fitAgent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tk, llm: makeStub(function (messages) {
    var cf = lastToolMsg(messages, 'check_fitness');
    if (!cf) return toolCall('check_fitness', { id: anyId, task: 'image classification' });
    var v = JSON.parse(cf.content).verdict;
    return toolCall('submit_answer', { selected_ids: v === 'fit' ? [anyId] : [], fitness_verdict: { id: anyId, verdict: v === 'fit' ? 'fit' : 'unfit' }, abstained: false });
  }) });
  var ft = await fitAgent.run('does ' + anyId + ' fit image classification?');
  check('fitness: contract carries fitness_verdict {id,verdict}', ft.ok && ft.answer.fitness_verdict && ft.answer.fitness_verdict.id === anyId && ['fit', 'unfit'].indexOf(ft.answer.fitness_verdict.verdict) >= 0, ft.answer);

  console.log('\n[6] agent loop — text-fallback tool call (no native tool_calls)');
  var textAgent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tk, llm: makeStub(function (messages) {
    if (!lastToolMsg(messages)) return { content: '```json\n{"tool":"submit_answer","args":{"selected_ids":[],"abstained":true}}\n```', tool_calls: null };
    return { content: 'done', tool_calls: null };
  }) });
  var tf = await textAgent.run('nonsense query');
  check('text-fallback: parsed submit_answer from content', tf.ok && tf.answer.abstained === true, tf.answer);

  console.log('\n[7] max-steps guard (model never submits)');
  var loopAgent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tk, maxSteps: 3, llm: makeStub(function () { return toolCall('search_datasets', { modality: 'point_cloud' }); }) });
  var lp = await loopAgent.run('loop forever');
  check('max-steps: returns incomplete, not crash', !lp.ok && lp.answer._incomplete === true && lp.steps === 3, { ok: lp.ok, steps: lp.steps });

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})();
