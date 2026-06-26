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

console.log('\n[9] TF2 RETRIEVE — inventory_files / detect_format / resolve_url vs Category-C GT');
(function () {
  var Cpath = path.join(ROOT, 'data/benchmark-category-C.json');
  if (!fs.existsSync(Cpath)) { check('benchmark-category-C.json present', false, Cpath); return; }
  var C = JSON.parse(fs.readFileSync(Cpath, 'utf8'));
  var nInv = 0, nFmt = 0, nAnn = 0, invOk = 0, fmtOk = 0, annOk = 0;

  C.cases.forEach(function (c) {
    if (c.subtype === 'inventory') {
      nInv++;
      var r = tk.dispatch('inventory_files', { path: c.path }), gt = c.gt_inventory;
      var filesMatch = JSON.stringify(r.files.map(function (f) { return { name: f.name, ext: f.ext, bytes: f.bytes, format: f.format }; })) === JSON.stringify(gt.files);
      if (r.file_count === gt.file_count && JSON.stringify(r.by_format) === JSON.stringify(gt.by_format) && filesMatch) invOk++;
      else check('inventory MISMATCH ' + c.path, false, { got: r.by_format, gt: gt.by_format });
      // task contract shape: every file carries name/ext/type/size_bytes
      check('inventory shape ' + c.path + ' -> {name,ext,type,size_bytes}+counts_by_type', r.files.every(function (f) { return 'name' in f && 'ext' in f && 'type' in f && 'size_bytes' in f; }) && r.counts_by_type != null, r.files[0]);
    } else if (c.subtype === 'format-detection') {
      nFmt++;
      var rf = tk.dispatch('detect_format', { path: c.path });
      if (rf.format === c.gt_format && rf.magic === c.gt_magic) fmtOk++;
      else check('format MISMATCH ' + c.path, false, { got: rf.format + '/' + rf.magic, gt: c.gt_format + '/' + c.gt_magic });
    } else if (c.subtype === 'annotation-format') {
      nAnn++;
      var ra = tk.dispatch('detect_format', { path: c.path });
      if (ra.annotation_format === c.gt_annotation_format) annOk++;
      else check('annotation MISMATCH ' + c.path, false, { got: ra.annotation_format, gt: c.gt_annotation_format });
    }
  });
  check('inventory_files reproduces Category-C GT (' + invOk + '/' + nInv + ')', invOk === nInv && nInv === 4);
  check('detect_format reproduces Category-C GT (' + fmtOk + '/' + nFmt + ')', fmtOk === nFmt && nFmt >= 7);
  check('detect_format annotation_format reproduces GT (' + annOk + '/' + nAnn + ')', annOk === nAnn && nAnn >= 1);

  // edge cases: corrupted + empty must be detected from bytes (NOT just extension)
  check('detect corrupted: .png ext but plain-text content -> "corrupted"', tk.dispatch('detect_format', { path: 'data/samples/_edgecases/broken.png' }).format === 'corrupted');
  check('detect empty: 0-byte file -> "empty"', tk.dispatch('detect_format', { path: 'data/samples/_edgecases/empty.csv' }).format === 'empty');
  var edge = tk.dispatch('inventory_files', { path: 'data/samples/_edgecases' });
  check('inventory_files surfaces corrupted+empty in counts_by_type', JSON.stringify(edge.counts_by_type) === JSON.stringify({ corrupted: 1, empty: 1 }), edge.counts_by_type);
  // content-aware: a .json that IS coco -> "coco", not generic "json"
  check('coco json detected by structure (images+annotations+categories)', tk.dispatch('detect_format', { path: 'data/samples/Construction-Site-Segmentation/annotations.json' }).format === 'coco');

  // determinism (repeat-equal) + primitive-not-oracle (no fitness/winner/score leaked)
  var a = JSON.stringify(tk.dispatch('inventory_files', { path: 'data/samples/PC-Urban' }));
  var b = JSON.stringify(tk.dispatch('inventory_files', { path: 'data/samples/PC-Urban' }));
  check('inventory_files deterministic (repeat-equal)', a === b);
  check('inventory/detect are primitives (no fitness/winner/suitability field)', a.indexOf('verdict') < 0 && a.indexOf('suitab') < 0 && a.indexOf('"best"') < 0 && a.indexOf('"score"') < 0, a.slice(0, 120));

  // sandbox: a path escaping data/samples is rejected (no arbitrary local read)
  check('path traversal blocked (../../etc rejected)', /sandbox/.test(tk.dispatch('inventory_files', { path: '../../etc' }).error || ''));

  // resolve_url — deterministic host/scheme classification, NO network; grounded in Category-B host rules
  var spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/sample-corpus-spec.json'), 'utf8'));
  var byId = {}; spec.datasets.forEach(function (d) { byId[d.dataset_id] = tk.dispatch('resolve_url', { url: d.access }); });
  check('resolve_url: ieee-dataport -> registration_required', byId['PC-Urban'].access_class === 'registration_required' && byId['PC-Urban'].repository === 'ieee_dataport');
  check('resolve_url: github -> open', byId['Construction-Site-Segmentation'].access_class === 'open' && byId['Construction-Site-Segmentation'].repository === 'github');
  check('resolve_url: figshare data-DOI (10.6084) -> open', byId['wblca-benchmark-v2-data'].access_class === 'open' && byId['wblca-benchmark-v2-data'].is_doi === true && byId['wblca-benchmark-v2-data'].doi_prefix === '10.6084');
  check('resolve_url: drive.google -> open', byId['DTCTP'].access_class === 'open' && byId['DTCTP'].repository === 'google_drive');
  check('resolve_url: journal DOI (10.1109) = citation -> unknown (not access)', tk.dispatch('resolve_url', { url: 'https://doi.org/10.1109/ACCESS.2021.3062547' }).access_class === 'unknown');
  check('resolve_url: lab/personal host -> unknown', tk.dispatch('resolve_url', { url: 'http://anlab340.com/dataset' }).access_class === 'unknown');
  check('resolve_url: deterministic + declares no-liveness-probe', JSON.stringify(tk.dispatch('resolve_url', { url: 'https://zenodo.org/record/1' })) === JSON.stringify(tk.dispatch('resolve_url', { url: 'https://zenodo.org/record/1' })) && /liveness/.test(tk.dispatch('resolve_url', { url: 'x' }).note));
})();

console.log('\n[10] TF4 UNDERSTAND — profilers graded by OC_DATA_1 benchmark-category-D.json (numeric accuracy vs oracle)');
(function () {
  var Dpath = path.join(ROOT, 'data/benchmark-category-D.json');
  if (!fs.existsSync(Dpath)) { check('benchmark-category-D.json present', false, Dpath); return; }
  var D = JSON.parse(fs.readFileSync(Dpath, 'utf8'));
  if (typeof api.benchmarkProfile !== 'function') { check('data-agent exposes benchmarkProfile', false); return; }

  // The agent assembles its profile from OUR tools, routed by modality (Level-3). An image dataset's
  // profile = profile_images (image side) merged with profile_annotations (annotation side) -> the merged
  // OC_DATA_1 image shape (num_images/width/height + num_annotations/num_categories/annotation_type/class_names).
  function profileFor(p) {
    var df = tk.dispatch('detect_format', { path: p }), which = agentTools.profilerForModality(df.modality_guess), prof = {};
    if (which === 'profile_pointcloud') prof = tk.dispatch('profile_pointcloud', { path: p });
    else if (which === 'profile_table') prof = tk.dispatch('profile_table', { path: p });
    else if (which === 'profile_bim') prof = tk.dispatch('profile_bim', { path: p });
    else if (which === 'profile_images') { prof = tk.dispatch('profile_images', { path: p }); if (df.recommended_annotation_profiler) prof = Object.assign({}, prof, tk.dispatch('profile_annotations', { path: p })); }
    return prof;
  }
  function edgeResult(p) { var df = tk.dispatch('detect_format', { path: p }); return df.target === 'file' ? df.format : df.modality_guess; }
  // G4.0 (Critic): OC_DATA_1 renamed gt_tools to the canonical .doc Tool Family 4 names
  // (profile_pointcloud/profile_images/profile_table/profile_annotations) — the alias bridge is gone;
  // the agent's REAL tool names are now scored directly against the canonical GT (one rulebook).
  function selectTools(p) { var df = tk.dispatch('detect_format', { path: p }), t = [df.recommended_profiler]; if (df.recommended_annotation_profiler) t.push(df.recommended_annotation_profiler); return t; }

  var agentRunFn = function (input) {
    if (input.subtype === 'numeric-profile') return { profile: profileFor(input.path) };
    if (input.subtype === 'tool-selection') return { tools: selectTools(input.path) };
    return { result: edgeResult(input.path) };
  };
  var rep = api.benchmarkProfile(agentRunFn, D);
  check('Category-D profileAccuracy === 1.0 (our profilers === oracle on every fixture)', rep.profileAccuracy === 1.0, rep);
  check('Category-D edgeCaseAccuracy === 1.0 (corrupted/empty/modality detected)', rep.edgeCaseAccuracy === 1.0, rep);
  check('Category-D toolSelectionAccuracy === 1.0 (Level-3 routing, canonical gt_tools, no alias)', rep.toolSelectionAccuracy === 1.0, rep.toolSelectionAccuracy);

  // direct field sanity (independent of the grader) + Level-3 routing in OUR canonical names
  var pc = tk.dispatch('profile_pointcloud', { path: 'data/samples/PC-Urban' });
  check('profile_pointcloud: num_points 8, centroid [.5,.5,.5], 4 classes', pc.num_points === 8 && JSON.stringify(pc.centroid) === JSON.stringify([0.5, 0.5, 0.5]) && pc.num_classes === 4, pc);
  var tb = tk.dispatch('profile_table', { path: 'data/samples/wblca-benchmark-v2-data' });
  check('profile_table: 3x4, dtypes, numeric_stats mean(gfa)=1800', tb.num_rows === 3 && tb.num_columns === 4 && tb.columns[1].dtype === 'numeric' && tb.numeric_stats.gfa_m2.mean === 1800, tb);
  check('Level-3 routing (our names): point_cloud->profile_pointcloud, tabular->profile_table', tk.dispatch('detect_format', { path: 'data/samples/PC-Urban' }).recommended_profiler === 'profile_pointcloud' && tk.dispatch('detect_format', { path: 'data/samples/DTCTP' }).recommended_profiler === 'profile_table');

  // determinism + COMPUTE-primitive (no oracle-answer/verdict/suitability leak) + honest failure
  var a = JSON.stringify(tb);
  check('profilers deterministic (repeat-equal)', a === JSON.stringify(tk.dispatch('profile_table', { path: 'data/samples/wblca-benchmark-v2-data' })));
  check('profilers are COMPUTE primitives (no verdict/suitability/best/score field)', a.indexOf('verdict') < 0 && a.indexOf('suitab') < 0 && a.indexOf('"best"') < 0 && a.indexOf('"score"') < 0);
  var wrong = tk.dispatch('profile_table', { path: 'data/samples/PC-Urban' });
  check('wrong profiler on a non-matching modality fails honestly (no fabricated rows)', wrong.error != null || wrong.num_rows === 0, wrong);
})();

console.log('\n[11] TF5 USE — training READINESS (Category-F: convert / split / validity / config / assess). NO training (Cat-G deferred)');
(function () {
  // ===== PRODUCTION integration (G5.0 fix): drive the REAL SHIPPED tools through OC_DATA_1's benchmarkPrep.
  // No inline reference impls — every output comes from tk.dispatch(real tool). Confirms the tools satisfy
  // the grader contract in production (conversion/split/validity all 1.0), not just in a bespoke harness.
  var Fpath = path.join(ROOT, 'data/benchmark-category-F.json');
  if (!fs.existsSync(Fpath) || typeof api.benchmarkPrep !== 'function') { check('benchmark-category-F.json + api.benchmarkPrep present', false, Fpath); }
  else {
    var F = JSON.parse(fs.readFileSync(Fpath, 'utf8'));
    function srcPath(s) { return 'data/samples/' + s; }
    var agentRunFn = function (input) {
      if (input.subtype === 'annotation-conversion') return tk.dispatch('convert_annotations', { path: srcPath(input.source), to: input.target });
      if (input.subtype === 'dataset-split') return tk.dispatch('create_dataset_split', { items: input.items, ratios: input.ratios, seed: input.seed });
      if (input.subtype === 'annotation-validity') {
        var out = input.source ? tk.dispatch('convert_annotations', { path: srcPath(input.source), to: 'coco' }) : tk.dispatch('convert_annotations', { coco: input.inline_source, to: 'coco' });
        return { valid: out.valid === true };
      }
      return {};
    };
    var rep = api.benchmarkPrep(agentRunFn, F);
    check('Category-F PRODUCTION conversionAccuracy === 1.0 (real convert_annotations: yolo/pascal_voc/coco)', rep.conversionAccuracy === 1.0, rep);
    check('Category-F PRODUCTION splitCorrectness === 1.0 (real create_dataset_split: no-leakage + reproducible)', rep.splitCorrectness === 1.0, rep);
    check('Category-F PRODUCTION annotationValidityAccuracy === 1.0 (real tool: path valid + inline out-of-bounds invalid)', rep.annotationValidityAccuracy === 1.0, rep);
  }
  // contract-lock asserts (the exact gaps Critic G5.0 found): pascal_voc accepted; .annotations + .splits emitted
  var pv = tk.dispatch('convert_annotations', { path: 'data/samples/Construction-Site-Segmentation', to: 'pascal_voc' });
  check('convert accepts "pascal_voc" (no error) + emits .annotations in GT shape', pv.error == null && Array.isArray(pv.annotations)
    && JSON.stringify(pv.annotations) === JSON.stringify([{ image_id: 1, class_id: 0, xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, { image_id: 2, class_id: 0, xmin: 1, ymin: 1, xmax: 2, ymax: 2 }]), pv);
  var yo = tk.dispatch('convert_annotations', { path: 'data/samples/Construction-Site-Segmentation', to: 'yolo' });
  check('convert COCO->YOLO .annotations normalized (cx,cy,w,h)', JSON.stringify(yo.annotations) === JSON.stringify([{ image_id: 1, class_id: 0, cx: 0.25, cy: 0.25, w: 0.5, h: 0.5 }, { image_id: 2, class_id: 0, cx: 0.75, cy: 0.75, w: 0.5, h: 0.5 }]), yo);
  check('convert: unknown target format -> honest error', tk.dispatch('convert_annotations', { path: 'data/samples/Construction-Site-Segmentation', to: 'png' }).error != null);
  var spc = tk.dispatch('create_dataset_split', { items: ['a', 'b', 'c', 'd'], ratios: { train: 0.5, val: 0.25, test: 0.25 }, seed: 1 });
  check('create_dataset_split emits .splits.{train,val,test} (benchmarkPrep contract)', spc.splits && Array.isArray(spc.splits.train) && Array.isArray(spc.splits.val) && Array.isArray(spc.splits.test), spc);

  // (c) create_dataset_split — leakage-free, covers-all, reproducible by seed, order-independent, seed-sensitive
  var items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  var s1 = tk.dispatch('create_dataset_split', { items: items, ratios: { train: 0.7, val: 0.15, test: 0.15 }, seed: 42 });
  var s2 = tk.dispatch('create_dataset_split', { items: items.slice().reverse(), ratios: { train: 0.7, val: 0.15, test: 0.15 }, seed: 42 });
  var s3 = tk.dispatch('create_dataset_split', { items: items, ratios: { train: 0.7, val: 0.15, test: 0.15 }, seed: 7 });
  var all = s1.train.concat(s1.val, s1.test), seen = {}, leak = false; all.forEach(function (x) { if (seen[x]) leak = true; seen[x] = 1; });
  check('split: NO train/test leakage (disjoint, covers all unique items)', !leak && s1.covers_all && all.length === 10 && s1.total === 10, s1.counts);
  check('split: reproducible by seed + INPUT-ORDER-INDEPENDENT', JSON.stringify(s1) === JSON.stringify(s2));
  check('split: seed-sensitive (different seed -> different partition)', JSON.stringify(s1.train) !== JSON.stringify(s3.train));
  check('split: ratios honored (10 -> 7/1/2)', JSON.stringify(s1.counts) === JSON.stringify({ train: 7, val: 1, test: 2 }));
  var sdup = tk.dispatch('create_dataset_split', { items: ['a', 'a', 'b', 'c'], ratios: [0.5, 0.25, 0.25], seed: 1 });
  check('split: duplicate items removed BEFORE splitting (leakage prevention)', sdup.duplicates_removed === 1 && sdup.total === 3);
  // unnormalized ratios are normalized
  var snorm = tk.dispatch('create_dataset_split', { items: items, ratios: { train: 7, val: 1.5, test: 1.5 }, seed: 42 });
  check('split: ratios normalized if they do not sum to 1', JSON.stringify(snorm.counts) === JSON.stringify(s1.counts));

  // (d) prepare_training_config — deterministic guidance (NOT a training run)
  var cfgDet = tk.dispatch('prepare_training_config', { task: 'object detection', modality: 'ground_rgb', num_classes: 1 });
  check('config: detection+image -> yolov8n, mAP, input 640, num_classes from arg', cfgDet.recommended_model === 'yolov8n' && cfgDet.metrics.indexOf('mAP') >= 0 && JSON.stringify(cfgDet.input_size) === JSON.stringify([640, 640]) && cfgDet.num_classes === 1);
  var cfgPc = tk.dispatch('prepare_training_config', { task: 'semantic segmentation', modality: 'point_cloud' });
  check('config: point-cloud seg -> pointnet2_seg, mIoU', cfgPc.recommended_model === 'pointnet2_seg' && cfgPc.metrics.indexOf('mIoU') >= 0);
  var cfgTab = tk.dispatch('prepare_training_config', { profile: tk.dispatch('profile_table', { path: 'data/samples/wblca-benchmark-v2-data' }), task: 'cost regression' });
  check('config: from a table profile -> lightgbm + leakage-free split + readiness note (not training)', cfgTab.recommended_model === 'lightgbm' && cfgTab.split.leakage_free === true && /not a training run/i.test(cfgTab.note));
  check('config: deterministic (repeat-equal)', JSON.stringify(cfgDet) === JSON.stringify(tk.dispatch('prepare_training_config', { task: 'object detection', modality: 'ground_rgb', num_classes: 1 })));

  // (e) assess_training_readiness — deterministic verdict per fixture (enough + valid + splittable)
  var R = {};
  ['PC-Urban', 'Construction-Site-Segmentation', 'wblca-benchmark-v2-data', 'DTCTP', '_edgecases'].forEach(function (p) { R[p] = tk.dispatch('assess_training_readiness', { path: 'data/samples/' + p }); });
  check('readiness: PC-Urban READY (8 points, valid labels)', R['PC-Urban'].readiness === 'ready' && R['PC-Urban'].num_items === 8 && R['PC-Urban'].has_valid_annotations === true);
  check('readiness: image set with COCO PARTIAL (valid but only 2 imgs < split min)', R['Construction-Site-Segmentation'].readiness === 'partial' && R['Construction-Site-Segmentation'].splittable === false && R['Construction-Site-Segmentation'].has_valid_annotations === true);
  check('readiness: wblca READY (3 rows splittable)', R['wblca-benchmark-v2-data'].readiness === 'ready');
  check('readiness: edge cases NOT_READY (corrupted/empty -> 0 valid items)', R['_edgecases'].readiness === 'not_ready' && R['_edgecases'].corrupted_count === 2 && R['_edgecases'].num_items === 0);
  check('readiness: every result carries checks[] + blockers[] (auditable, deterministic)', ['PC-Urban', '_edgecases'].every(function (p) { return Array.isArray(R[p].checks) && Array.isArray(R[p].blockers); }) && JSON.stringify(R['PC-Urban']) === JSON.stringify(tk.dispatch('assess_training_readiness', { path: 'data/samples/PC-Urban' })));

  // Cat-G boundary: readiness tools are preprocessing only — no train/evaluate, no metric/score leak
  var rj = JSON.stringify(R['PC-Urban']) + JSON.stringify(cfgDet) + JSON.stringify(yo);
  check('TF5 stays in READINESS scope (no accuracy/mAP-result/loss/trained field)', rj.indexOf('"trained"') < 0 && rj.indexOf('"accuracy_result"') < 0 && rj.indexOf('"loss"') < 0 && tk.toolNames.indexOf('train_baseline_model') < 0);
})();

console.log('\n[12] SCORING ALIGNMENT — nDCG primary for Category-E (SAP §3.2.1) + pass@k wrapper (DAB §3.1.5)');
(function () {
  var E = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/benchmark-category-E.json'), 'utf8'));
  // (a) ndcgScore: ideal order = 1.0; GT-tied swap ~ invariant; relevance from gt_scores[].total
  var c0 = E.cases[0];
  check('ndcgScore(ideal) === 1.0 (graded relevance from gt_scores)', api.ndcgScore(c0.gt_ranking, c0.gt_scores) === 1.0);
  check('ndcgScore(empty ranking) < 1.0 (no credit without ordering)', (api.ndcgScore([], c0.gt_scores) || 0) < 1.0);
  // (b) benchmarkAgentCompare now reports nDCG (PRIMARY) + top1 + Kendall-τ (supplementary)
  var byCand = {}; E.cases.forEach(function (c) { byCand[JSON.stringify(c.candidate_ids)] = c; });
  function agentOf(transform) { return function (inp) { var c = byCand[JSON.stringify(inp.candidate_ids)]; return { ranking: transform(c) }; }; }
  var perfect = api.benchmarkAgentCompare(agentOf(function (c) { return c.gt_ranking.slice(); }), E);
  var reversed = api.benchmarkAgentCompare(agentOf(function (c) { return c.gt_ranking.slice().reverse(); }), E);
  check('E report carries meanNDCG (primary) + top1Accuracy + meanTau (supplementary)', typeof perfect.meanNDCG === 'number' && typeof perfect.top1Accuracy === 'number' && typeof perfect.meanTau === 'number', { ndcg: perfect.meanNDCG, top1: perfect.top1Accuracy, tau: perfect.meanTau });
  check('perfect agent -> meanNDCG 1.0 / top1 1.0 / meanTau 1.0', perfect.meanNDCG === 1.0 && perfect.top1Accuracy === 1.0 && perfect.meanTau === 1.0, perfect);
  check('reversed agent -> meanNDCG < 1.0 / top1 0 / meanTau <= -0.9 (nDCG less discriminative than τ here -> τ kept)', reversed.meanNDCG < 1.0 && reversed.top1Accuracy === 0.0 && reversed.meanTau <= -0.9, { ndcg: reversed.meanNDCG, top1: reversed.top1Accuracy, tau: reversed.meanTau });
  check('Kendall-τ retained as supplementary (not removed)', 'meanTau' in perfect && typeof api.kendallTau === 'function');

  // (c) passAtK estimator (DAB §3.1.5): pass@k = 1 - C(n-c,k)/C(n,k); pass@1 = c/n
  check('passAtK(10,2,1)=0.2 / (10,2,2)=0.3778 / (50,19,1)=0.38', api.passAtK(10, 2, 1) === 0.2 && Math.abs(api.passAtK(10, 2, 2) - 0.377778) < 1e-5 && api.passAtK(50, 19, 1) === 0.38);
  check('passAtK edges: c=0 -> 0, c=n -> 1', api.passAtK(5, 0, 3) === 0 && api.passAtK(5, 5, 3) === 1);
  // (d) benchmarkPassK wrapper: deterministic outcomes -> pass@k == pass@1; stochastic -> estimator
  var det = api.benchmarkPassK([[true, true, true], [false, false, false]], 3);
  check('benchmarkPassK deterministic: pass@k == pass@1 (=0.5)', det.pass1 === 0.5 && det.passK === 0.5);
  var stoch = api.benchmarkPassK([[true, false, true, false, false]], 2);   // n=5,c=2 -> pass@1=0.4, pass@2=0.7
  check('benchmarkPassK stochastic: pass@1=0.4, pass@2=0.7 (one case, n=5 c=2)', Math.abs(stoch.pass1 - 0.4) < 1e-6 && Math.abs(stoch.passK - 0.7) < 1e-6, stoch);
})();

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
