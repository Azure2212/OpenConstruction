// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// run_phase2_eval.js — Phase-2 re-benchmark per the Critic-signed protocol. Runs the REAL agent
// (agent.run + 23 tools + frozen prompt) over the 144 golden + 32 held-out, for v1 (maxSteps=8) and
// v2 across a maxSteps sweep, against ONE live vLLM session. Same commit; only loopVersion/maxSteps differ.
// temp=0 greedy. Reuses the G1.6-blessed grader (benchmarkAgent/benchmarkOn) via a 3-pass harness, and adds
// the protocol metric suite: per-family, abstain 2x2 confusion, false-answer-rate on the must-abstain subset,
// hallucinationRate, floor-fired count, abstain precision/recall. Writes INCREMENTALLY (per case + per config).
//   node scripts/run_phase2_eval.js --base URL --model M --outdir DIR --sweep 8,12,16 --concurrency 6 \
//        --commit <git> --vllm <ver> --node <host>

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
var OUTDIR = argVal('--outdir', path.join(ROOT, 'phase2_out'));
var SWEEP = (argVal('--sweep', '8,12,16')).split(',').map(function (x) { return parseInt(x, 10); });
var CONC = parseInt(argVal('--concurrency', '6'), 10);
var PLATEAU_PP = 0.5;   // pre-declared: smallest maxSteps where primary metric changes < 0.5pp on further increase
var FLOOR_STEPS = 9;    // pre-declared capacity floor for selection
try { fs.mkdirSync(OUTDIR, { recursive: true }); } catch (e) {}

var PROV = {
  model: MODEL, base: BASE, commit: argVal('--commit', 'unknown'), vllm: argVal('--vllm', 'unknown'),
  node: argVal('--node', 'unknown'), prompt: Agent.SYSTEM_PROMPT_VERSION, temperature: 0, seed: 'greedy/temp=0',
  sweep: SWEEP, plateau_pp: PLATEAU_PP, floor_steps: FLOOR_STEPS, started: new Date().toISOString()
};

var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var benchPath = path.join(ROOT, 'data/benchmark-results.json');
var benchmarkResults = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;
var tools = AT.createTools(api, corpus, taxonomy, { benchmarkResults: benchmarkResults });
var client = LLM.createClient({ baseUrl: BASE, model: MODEL, temperature: 0, max_tokens: 700, timeout_ms: 120000 });
var GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/data-agent-goldenset.json'), 'utf8'));
var HELDOUT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/heldout-set.json'), 'utf8'));

function makeAgent(loop, maxSteps) {
  return Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tools, llm: client, loopVersion: loop, maxSteps: maxSteps });
}

// 3-pass: pass1 capture the per-case inputs the grader feeds; pass2 run the REAL agent on unique inputs
// (concurrent, incremental jsonl, captures floor_fired); pass3 re-grade with cached agent answers.
async function gradeConfig(cfg, goldenSet, jsonlPath) {
  var agent = makeAgent(cfg.loop, cfg.maxSteps);
  var inputs = [];                                                       // aligned with cases order
  api.benchmarkAgent(function (inp) { inputs.push(inp); return {}; }, goldenSet, corpus);   // pass 1
  var uniq = {}, order = [];
  inputs.forEach(function (inp) { var k = JSON.stringify(inp); if (!(k in uniq)) { uniq[k] = inp; order.push(k); } });
  var answerCache = {}, floorCache = {}, errors = 0, done = 0;
  fs.writeFileSync(jsonlPath, '');                                        // fresh per-case log
  var i = 0;
  async function worker() {
    while (i < order.length) {
      var k = order[i++];
      var t0 = Date.now(), r;
      try { r = await agent.run(uniq[k]); } catch (e) { errors++; r = { answer: { selected_ids: [], abstained: true }, trace: [], ok: false, reason: 'run-error:' + (e && e.message || e) }; }
      var a = r.answer || {};
      var floor = !!(r.floor_fired || a.floor_fired);
      answerCache[k] = a; floorCache[k] = floor;
      done++;
      var seq = (r.trace || []).map(function (t) { return t.tool; });
      fs.appendFileSync(jsonlPath, JSON.stringify({ cfg: cfg.name, input: uniq[k], selected_ids: a.selected_ids || [], fitness_verdict: a.fitness_verdict || null, abstained: !!a.abstained, floor_fired: floor, submit: seq.indexOf('submit_answer') >= 0, steps: r.steps, ms: Date.now() - t0, ok: r.ok, reason: r.reason || null }) + '\n');
      if (done % 10 === 0 || done === order.length) process.stderr.write('  [' + cfg.name + '] ' + done + '/' + order.length + ' runs (' + errors + ' err)\r');
    }
  }
  var pool = []; for (var w = 0; w < Math.min(CONC, order.length); w++) pool.push(worker());
  await Promise.all(pool);
  process.stderr.write('\n');
  // pass 3: re-grade deterministically with cached agent answers
  var res = api.benchmarkAgent(function (inp) { return answerCache[JSON.stringify(inp)] || { selected_ids: [], abstained: true }; }, goldenSet, corpus);
  // protocol metrics from res.perCase (aligned with cases) + floor map
  var cases = goldenSet.cases;
  var floorForCase = inputs.map(function (inp) { return floorCache[JSON.stringify(inp)] || false; });
  var fam = { discovery: [], fitness: [], license: [], abstain: [] };
  var cm = { tp: 0, fp: 0, fn: 0, tn: 0 };                                // abstain confusion over non-fitness cases (positive=abstain)
  var floorFired = 0, mustAbstain = 0, falseAnswer = 0;
  cases.forEach(function (c, idx) {
    var pc = res.perCase[idx] || {};
    var family = c.family === 'must-abstain' ? 'abstain' : c.family;
    if (floorForCase[idx]) floorFired++;
    if (family === 'fitness') { fam.fitness.push(pc.ok ? 1 : 0); return; }
    (fam[family] || (fam[family] = [])).push(pc);
    var goldA = !!pc.wantAbstain, predA = !!pc.abstained;
    if (goldA && predA) cm.tp++; else if (!goldA && predA) cm.fp++; else if (goldA && !predA) cm.fn++; else cm.tn++;
    if (goldA) { mustAbstain++; if (!predA) falseAnswer++; }
  });
  function avg(list, sel) { var v = list.map(sel).filter(function (x) { return x != null; }); return v.length ? +(v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(4) : null; }
  var protocol = {
    primary_discovery_ndcg: avg(fam.discovery, function (x) { return x.score && x.score.ndcg; }),
    per_family: {
      discovery: { n: fam.discovery.length, p_at_k: avg(fam.discovery, function (x) { return x.score && x.score.p; }), ndcg: avg(fam.discovery, function (x) { return x.score && x.score.ndcg; }), recall: avg(fam.discovery, function (x) { return x.score && x.score.recall; }) },
      license: { n: fam.license.length, p_at_k: avg(fam.license, function (x) { return x.score && x.score.p; }), ndcg: avg(fam.license, function (x) { return x.score && x.score.ndcg; }), licenseCorrectness: res.licenseCorrectness },
      fitness: { n: fam.fitness.length, accuracy: fam.fitness.length ? +(fam.fitness.reduce(function (a, b) { return a + b; }, 0) / fam.fitness.length).toFixed(4) : null },
      abstain: { n: fam.abstain.length, abstain_correct: fam.abstain.length ? +(fam.abstain.filter(function (x) { return x.abstained === x.wantAbstain; }).length / fam.abstain.length).toFixed(4) : null }
    },
    abstain_confusion_2x2: cm,                                            // {tp,fp,fn,tn}; positive=abstain
    abstain_precision: (cm.tp + cm.fp) ? +(cm.tp / (cm.tp + cm.fp)).toFixed(4) : null,
    abstain_recall: (cm.tp + cm.fn) ? +(cm.tp / (cm.tp + cm.fn)).toFixed(4) : null,
    false_answer_rate_must_abstain: mustAbstain ? +(falseAnswer / mustAbstain).toFixed(4) : null,
    must_abstain_n: mustAbstain, false_answers: falseAnswer,
    hallucinationRate: res.hallucinationRate,
    floor_fired_count: floorFired,
    aggregate_grader: { precisionAtK: res.precisionAtK, ndcgAtK: res.ndcgAtK, recallAtK: res.recallAtK, abstentionCorrectness: res.abstentionCorrectness, licenseCorrectness: res.licenseCorrectness, fitnessAccuracy: res.fitnessAccuracy },
    run_errors: errors
  };
  return { config: cfg, set: goldenSet === GOLDEN ? 'golden-144' : 'heldout-32', protocol: protocol };
}

function writeSummary(all) { fs.writeFileSync(path.join(OUTDIR, 'phase2_summary.json'), JSON.stringify({ provenance: PROV, results: all }, null, 2)); }

(async function () {
  console.log('Phase-2 eval | ' + JSON.stringify(PROV));
  var all = [];
  function rec(x) { all.push(x); writeSummary(all); console.log('DONE ' + x.config.name + ' (' + x.set + ') primary_discovery_ndcg=' + x.protocol.primary_discovery_ndcg + ' false_answer=' + x.protocol.false_answer_rate_must_abstain + ' floor_fired=' + x.protocol.floor_fired_count); }

  // 1) v1 baseline on golden + held-out
  rec(await gradeConfig({ name: 'v1-s8', loop: 'v1', maxSteps: 8 }, GOLDEN, path.join(OUTDIR, 'cases_v1-s8_golden.jsonl')));
  rec(await gradeConfig({ name: 'v1-s8-heldout', loop: 'v1', maxSteps: 8 }, HELDOUT, path.join(OUTDIR, 'cases_v1-s8_heldout.jsonl')));

  // 2) v2 maxSteps sweep on golden
  var curve = [];
  for (var s = 0; s < SWEEP.length; s++) {
    var ms = SWEEP[s];
    var x = await gradeConfig({ name: 'v2-s' + ms, loop: 'v2', maxSteps: ms }, GOLDEN, path.join(OUTDIR, 'cases_v2-s' + ms + '_golden.jsonl'));
    rec(x); curve.push({ maxSteps: ms, primary: x.protocol.primary_discovery_ndcg });
  }
  // pre-declared selection: smallest maxSteps >= floor where the next-larger point changes < plateau_pp
  var eligible = curve.filter(function (p) { return p.maxSteps >= FLOOR_STEPS; }).sort(function (a, b) { return a.maxSteps - b.maxSteps; });
  var chosen = eligible.length ? eligible[eligible.length - 1].maxSteps : SWEEP[SWEEP.length - 1];
  for (var j = 0; j < eligible.length - 1; j++) {
    var d = Math.abs((eligible[j + 1].primary || 0) - (eligible[j].primary || 0)) * 100;
    if (d < PLATEAU_PP) { chosen = eligible[j].maxSteps; break; }
  }
  PROV.chosen_maxSteps = chosen; PROV.curve = curve; writeSummary(all);
  console.log('SELECTION: curve=' + JSON.stringify(curve) + ' -> chosen maxSteps=' + chosen + ' (rule: smallest >=' + FLOOR_STEPS + ' with next Δ<' + PLATEAU_PP + 'pp)');

  // 3) v2 @ chosen on held-out
  rec(await gradeConfig({ name: 'v2-s' + chosen + '-heldout', loop: 'v2', maxSteps: chosen }, HELDOUT, path.join(OUTDIR, 'cases_v2-s' + chosen + '_heldout.jsonl')));

  PROV.finished = new Date().toISOString(); writeSummary(all);
  console.log('\nPHASE2 COMPLETE -> ' + path.join(OUTDIR, 'phase2_summary.json'));
})().catch(function (e) { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
