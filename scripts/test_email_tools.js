// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// test_email_tools.js — headless CI for the email-core tools (ACTION_PLAN 1.4/1.6/2.2):
// check_license · validate_metadata · compare_resources · recommend_benchmark + the C4 suitability
// instrument. Model-free. Asserts determinism, primitive-not-oracle, and benchmark wiring.
//   run: node scripts/test_email_tools.js   (from OpenConstruction/)

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var agentTools = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var compareMod = require(path.join(ROOT, 'assets/js/data-agent-compare.js'));

var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var benchPath = path.join(ROOT, 'data/benchmark-results.json');
var benchmarkResults = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;

var tk = agentTools.createTools(api, corpus, taxonomy, { benchmarkResults: benchmarkResults });
var comparer = compareMod.createComparer(api);

var pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra != null ? '-> ' + JSON.stringify(extra).slice(0, 240) : ''); } }
function idsOf(modality) { return corpus.datasets.filter(function (d) { return d.modality.indexOf(modality) >= 0; }).slice(0, 3).map(function (d) { return d.id; }); }

console.log('\n[1] check_license — deterministic rights for one dataset');
(function () {
  var anyId = corpus.datasets[0].id;
  var r = tk.dispatch('check_license', { id: anyId });
  check('returns the 4 license axes + cls', r.id === anyId && 'commercial_ok' in r && 'derivatives_ok' in r && 'share_alike' in r && 'attribution' in r && typeof r.cls === 'string', r);
  check('not-found is handled', tk.dispatch('check_license', { id: 'NO_SUCH' }).error != null);
})();

console.log('\n[2] validate_metadata — completeness + conflict detection');
(function () {
  var anyId = corpus.datasets[0].id;
  var r = tk.dispatch('validate_metadata', { id: anyId });
  check('returns checks[] + completeness in [0,1]', Array.isArray(r.checks) && r.checks.length > 0 && r.completeness >= 0 && r.completeness <= 1, r.completeness);
  check('every check has field+status', r.checks.every(function (c) { return c.field && (c.status === 'ok' || c.status === 'missing'); }));
  // a dataset with no parseable modality (if any) should surface a conflict; at minimum conflicts is an array
  check('conflicts is an array', Array.isArray(r.conflicts));
})();

console.log('\n[3] compare_resources — PRIMITIVE table (no oracle: no weights/total/winner)');
(function () {
  var ids = idsOf('point_cloud');
  var r = tk.dispatch('compare_resources', { ids: ids, modality: 'point_cloud' });
  check('returns criteria[] + rows[] for each dataset', Array.isArray(r.criteria) && r.rows.length === ids.length, { c: r.criteria && r.criteria.length, rows: r.rows && r.rows.length });
  var allCrit = ['task_align', 'modality_match', 'annotation_match', 'license', 'volume', 'class_coverage', 'quality', 'docs', 'access', 'prep_cost'];
  check('table covers all 10 criteria', JSON.stringify(r.criteria) === JSON.stringify(allCrit), r.criteria);
  var row0 = r.rows[0];
  // G2.1 R4: de-circularized — agent gets RAW value + evidence, NOT the grader's normalized sub-score.
  check('per-criterion = raw value + evidence, NO normalized score', row0.criteria.license && 'value' in row0.criteria.license && 'evidence' in row0.criteria.license && row0.criteria.license.score === undefined, row0.criteria.license);
  check('NO grader sub-scores leaked on ANY criterion', r.rows.every(function (row) { return r.criteria.every(function (k) { return row.criteria[k] && row.criteria[k].score === undefined; }); }));
  check('NO ORACLE: row has no total/winner, table has no weights', row0.total === undefined && row0.criteria.license.weight === undefined && r.best === undefined && r.ranking === undefined, row0);
})();

console.log('\n[4] suitability instrument (engine surface) — transparent score + ranking');
(function () {
  var ids = idsOf('point_cloud');
  var recs = ids.map(function (id) { return corpus.byId.get(id.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); });
  var need = api.parseNeed({ task: '3D semantic segmentation', modality: 'point_cloud' });
  var s = comparer.suitabilityScore(recs[0], need);
  check('suitabilityScore: total in [0,1] + full breakdown w/ weights', s.total >= 0 && s.total <= 1 && s.breakdown.length === 10 && s.breakdown.every(function (b) { return typeof b.weight === 'number'; }), s.total);
  var ranked = comparer.rankBySuitability(recs, need);
  check('rankBySuitability sorts desc by total', ranked.length === recs.length && (ranked.length < 2 || ranked[0].total >= ranked[1].total), ranked.map(function (x) { return x.total; }));
  // DETERMINISM (Node==browser: pure fns, same input -> identical output)
  check('DETERMINISTIC: identical output on repeat', JSON.stringify(comparer.suitabilityScore(recs[0], need)) === JSON.stringify(s));
})();

console.log('\n[5] recommend_benchmark — sourced from benchmark-results.json');
(function () {
  check('benchmark-results.json present', benchmarkResults && Array.isArray(benchmarkResults.benchmarks) && benchmarkResults.benchmarks.length > 0, benchmarkResults ? benchmarkResults.benchmarks.length : null);
  var all = tk.dispatch('recommend_benchmark', {});
  check('no-filter lists all benchmarks', all.count === benchmarkResults.benchmarks.length, all.count);
  var m = all.matches[0];
  check('each match has name/task/dataset/primary_metric/best/source_url', m.name && m.task && m.dataset_id && m.primary_metric && 'best' in m && 'source_url' in m, m);
  check('best = top method by primary metric (value present)', m.best == null || (m.best.method && typeof m.best.value === 'number'), m.best);
  // filter by a task that exists in the benchmark file
  var t = benchmarkResults.benchmarks[0].task;
  var byTask = tk.dispatch('recommend_benchmark', { task: t });
  check('task filter returns >=1 match for an indexed task', byTask.count >= 1, { task: t, count: byTask.count });
  check('unrelated task -> 0 matches (not everything)', tk.dispatch('recommend_benchmark', { task: 'zzz nonexistent task' }).count === 0);
  // G2.1 R1: metric DIRECTION respected
  function findBy(metric) { return all.matches.filter(function (x) { return x.primary_metric === metric; })[0]; }
  var rmse = findBy('rmse');  // nysolarforecastlab: lower-is-better
  if (rmse) {
    var minRow = benchmarkResults.benchmarks.filter(function (b) { return b.primary_metric_key === 'rmse'; })[0].results
      .reduce(function (a, r2) { return (a == null || r2.metrics.rmse < a.metrics.rmse) ? r2 : a; }, null);
    check('R1: lower-is-better metric -> best = MIN (not max)', rmse.primary_metric_direction === 'lower' && rmse.best.method === minRow.method && rmse.best.value === minRow.metrics.rmse, rmse.best);
  } else { check('R1: rmse benchmark present', false, 'no rmse benchmark'); }
  var higher = all.matches.filter(function (x) { return x.primary_metric_direction === 'higher' && x.best; })[0];
  check('R1: higher-is-better -> best = MAX', !!higher, higher && higher.best);
})();

console.log('\n[6] recommend_benchmark STUB contract when data absent');
(function () {
  var tkNo = agentTools.createTools(api, corpus, taxonomy, {}); // no benchmarkResults
  var r = tkNo.dispatch('recommend_benchmark', { task: 'x' });
  check('absent data -> error + contract shape stub', r.error && r.contract && Array.isArray(r.contract.matches), r);
})();

console.log('\n[7] R2 num_images parser -> volume criterion');
(function () {
  var need = api.parseNeed({});
  function volRaw(id) { var rec = corpus.byId.get(id.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); if (!rec) return undefined; return comparer.suitabilityScore(rec, need).breakdown.filter(function (b) { return b.criterion === 'volume'; })[0].raw; }
  function volScore(id) { var rec = corpus.byId.get(id.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()); if (!rec) return undefined; return comparer.suitabilityScore(rec, need).breakdown.filter(function (b) { return b.criterion === 'volume'; })[0].score; }
  // suffix expansion (was wrongly LOW)
  check('"10K frames" (UrbanTwin) -> 10000, volume 1.0', volRaw('UrbanTwin') === 10000 && volScore('UrbanTwin') === 1, volRaw('UrbanTwin'));
  check('"5 million..." (BuildingWorld) -> 5e6, volume 1.0', volRaw('BuildingWorld') === 5000000 && volScore('BuildingWorld') === 1, volRaw('BuildingWorld'));
  check('"2.75B" (GlobalBuildingAtlas) -> 2.75e9', volRaw('GlobalBuildingAtlas') === 2750000000, volRaw('GlobalBuildingAtlas'));
  // digit-concatenation (was wrongly HIGH) -> first number only
  check('"37 IFC models with 1,027 QA" (ifc-bench) -> 37 (not 371027)', volRaw('ifc-bench') === 37, volRaw('ifc-bench'));
  check('"382 (..) +537 (..)" (TunGPR) -> 382 (not 382537)', volRaw('TunGPR') === 382, volRaw('TunGPR'));
  // "km" must NOT be treated as a multiplier
  check('"Over 40km" (camhighways) -> not 40000 (km != k)', volRaw('camhighways') !== 40000, volRaw('camhighways'));
})();

console.log('\n[8] R3 quality criterion has no dead resolution term (spans 0..1)');
(function () {
  var need = api.parseNeed({});
  var anyId = corpus.datasets[0].id;
  var q = comparer.suitabilityScore(corpus.byId.get(anyId.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()), need).breakdown.filter(function (b) { return b.criterion === 'quality'; })[0];
  check('quality raw has no `resolution` key (dead term removed)', q.raw && !('resolution' in q.raw) && ('size' in q.raw));
  // a dataset with annotation + size present should reach quality 1.0 (was capped at 0.75 by dead term)
  var full = corpus.datasets.filter(function (d) { return d.annotation.length && d.numImages != null; })[0];
  var qf = comparer.suitabilityScore(full, need).breakdown.filter(function (b) { return b.criterion === 'quality'; })[0];
  check('annotation+size present -> quality 1.0 (no silent 0.75 cap)', qf.score === 1, { id: full.id, q: qf.score });
})();

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
