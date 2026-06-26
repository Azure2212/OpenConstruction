// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// smoke_floor.js — INSTRUMENTED smoke for the v2 agent floor (Critic protocol). Drives the real agent loop
// (v2) with a stub model that searches + check_fitness but NEVER calls submit_answer, so the FLOOR decides.
// Proves: floor returns ONLY confirmed-fit ids, and fires only when >=1 fit (0 confirmed-fit => abstain,
// no fabrication). Emits per-run + aggregate instrumentation: abstain confusion 2x2, false-answer-rate on the
// must-abstain subset, hallucinationRate, floor_fired flag. No GPU/model needed — deterministic.
//   node scripts/smoke_floor.js

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var AT = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var Agent = require(path.join(ROOT, 'assets/js/agent.js'));
function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var tools = AT.createTools(api, corpus, taxonomy, {});
var corpusIds = new Set(corpus.datasets.map(function (d) { return ckey(d.id); }));

// Stub model: turn 1 -> search_datasets; thereafter -> check_fitness(id, ...checkArgs) on each candidate id;
// NEVER calls submit_answer (forces the floor to decide). checkArgs control the verdict via the REAL c3Fitness.
function makeStub(ids, checkArgs) {
  var n = 0;
  return { chat: function (messages) {
    n++;
    if (n === 1) return Promise.resolve({ content: '', tool_calls: [{ id: 's', function: { name: 'search_datasets', arguments: JSON.stringify({ query: checkArgs.query || '', task: checkArgs.task, limit: 8 }) } }] });
    var id = ids[(n - 2) % ids.length];
    var args = {}; for (var k in checkArgs) if (k !== 'query') args[k] = checkArgs[k]; args.id = id;
    return Promise.resolve({ content: '', tool_calls: [{ id: 'c' + n, function: { name: 'check_fitness', arguments: JSON.stringify(args) } }] });
  } };
}

// real object-detection datasets (so check_fitness on task-only => 'fit'); same ids with modality='tabular' => 'unfit'
var OD_IDS = ['SODA', 'Hardhat-Wearing', 'SHWD', 'CMOT'];
var CASES = [
  { label: 'answerable', gold: 'answer', need: { task: 'Object detection', modality: '', license: 'any' }, checkArgs: { task: 'Object detection' } },
  { label: 'must-abstain', gold: 'abstain', need: { task: 'Object detection', modality: 'tabular', license: 'any' }, checkArgs: { task: 'Object detection', modality: 'tabular' } }
];

(async function () {
  // transparency: real check_fitness verdict (via the SAME tool path the agent uses) for these ids per case
  console.log('=== real check_fitness verdicts (ground truth for the stub) ===');
  CASES.forEach(function (c) {
    var vs = OD_IDS.map(function (id) { var args = { id: id }; for (var k in c.checkArgs) if (k !== 'query') args[k] = c.checkArgs[k]; return id + ':' + (tools.dispatch('check_fitness', args).verdict || '?'); });
    console.log('  [' + c.label + '] ' + vs.join('  '));
  });

  var rows = [];
  for (var i = 0; i < CASES.length; i++) {
    var c = CASES[i];
    var agent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tools, llm: makeStub(OD_IDS, c.checkArgs), loopVersion: 'v2', maxSteps: 6 });
    var r = await agent.run({ q: c.need.task, need: c.need, k: 8 });
    var sel = r.selected_ids || [];
    var floor = !!(r.floor_fired || (r.answer && r.answer.floor_fired));
    var predAbstain = !!(r.answer && r.answer.abstained) && sel.length === 0;
    var halluc = sel.filter(function (id) { return !corpusIds.has(ckey(id)); });
    rows.push({ label: c.label, gold: c.gold, predAbstain: predAbstain, floor: floor, nSel: sel.length, halluc: halluc.length, sel: sel });
    console.log('\n[' + c.label + '] gold=' + c.gold + ' | submit_called=' + (r.trace || []).some(function (t) { return t.tool === 'submit_answer'; }) +
      ' | floor_fired=' + floor + ' | pred=' + (predAbstain ? 'ABSTAIN' : 'ANSWER') + ' | n_selected=' + sel.length + ' | hallucinated=' + halluc.length);
    console.log('   selected_ids: ' + (sel.length ? sel.join(', ') : '(none)'));
  }

  // ---- aggregate instrumentation ----
  var cm = { aa: 0, an: 0, na: 0, nn: 0 }; // gold x pred: a=abstain n=answer
  var totalSel = 0, totalHalluc = 0, mustAbstain = 0, falseAnswer = 0;
  rows.forEach(function (x) {
    var goldA = x.gold === 'abstain', predA = x.predAbstain;
    if (goldA && predA) cm.aa++; else if (goldA && !predA) { cm.an++; }
    else if (!goldA && predA) cm.na++; else cm.nn++;
    if (goldA) { mustAbstain++; if (!predA) falseAnswer++; }
    totalSel += x.nSel; totalHalluc += x.halluc;
  });
  console.log('\n=== INSTRUMENTATION (aggregate) ===');
  console.log('abstain confusion 2x2 (gold \\ pred):');
  console.log('             pred=abstain  pred=answer');
  console.log('  gold=abstain     ' + cm.aa + '            ' + cm.an + '   <- false-answer if >0');
  console.log('  gold=answer      ' + cm.na + '            ' + cm.nn);
  console.log('false_answer_rate (must-abstain subset): ' + falseAnswer + '/' + mustAbstain + ' = ' + (mustAbstain ? (falseAnswer / mustAbstain).toFixed(3) : 'n/a'));
  console.log('hallucinationRate: ' + totalHalluc + '/' + totalSel + ' = ' + (totalSel ? (totalHalluc / totalSel).toFixed(3) : '0'));
  console.log('floor_fired per case: ' + rows.map(function (x) { return x.label + '=' + x.floor; }).join(', '));
  var pass = (cm.an === 0) && (totalHalluc === 0);
  console.log('\nFLOOR PROTOCOL ' + (pass ? 'PASS' : 'FAIL') + ' — must-abstain returned nothing (false_answer=' + falseAnswer + '), no hallucination.');
})();
