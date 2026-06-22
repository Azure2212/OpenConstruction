// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// test_agent_integration.js — ONE shared END-TO-END harness. Drives the REAL `agent.run` (agent loop +
// tools + submit_answer) through EVERY existing grader in data-agent.js, so the A-F benchmark scores
// reflect the actual agent path — NOT reference impls (closes Critic's systemic 🟠).
//
// The LLM is INJECTED. In CI it is a DETERMINISTIC policy stub that NEVER reads GT — it only sees the task
// input + tool results, selects the RIGHT real tools, and submits their outputs via submit_answer. TOMORROW:
// swap `makePolicyStub()` for the live llm client (llm-client.js) in createAgent — ZERO other code change —
// and this same harness runs the full A-F experiment against a real model.
//
//   run: node scripts/test_agent_integration.js   (from OpenConstruction/)

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var AT = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var Agent = require(path.join(ROOT, 'assets/js/agent.js'));
var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var benchPath = path.join(ROOT, 'data/benchmark-results.json');
var benchmarkResults = fs.existsSync(benchPath) ? JSON.parse(fs.readFileSync(benchPath, 'utf8')) : null;
var tools = AT.createTools(api, corpus, taxonomy, { benchmarkResults: benchmarkResults });
function loadJson(f) { var p = path.join(ROOT, 'data', f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

var pass = 0, fail = 0;
function check(n, c, extra) { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra != null ? '-> ' + JSON.stringify(extra).slice(0, 280) : ''); } }

// ---------------------------------------------------------------- the policy stub (no GT peek)
function tcall(name, args) { return { id: 'tc_' + name + '_' + (tcall._n = (tcall._n || 0) + 1), type: 'function', function: { name: name, arguments: JSON.stringify(args || {}) } }; }
function rankFromEvidence(cr) {   // E: deterministic ranking from EVIDENCE ONLY (no oracle weights/scores)
  return (cr.rows || []).map(function (r) { var v = r.criteria && r.criteria.volume && r.criteria.volume.value; return { id: r.id, vol: typeof v === 'number' ? v : 0 }; })
    .sort(function (a, b) { return b.vol - a.vol || (a.id < b.id ? -1 : 1); }).map(function (x) { return x.id; });
}
function makePolicyStub() {
  function firstUser(messages) { for (var i = 0; i < messages.length; i++) if (messages[i].role === 'user') { try { return JSON.parse(messages[i].content); } catch (e) { return {}; } } return {}; }
  function last(messages, name) { for (var i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'tool' && messages[i].name === name) { try { return JSON.parse(messages[i].content); } catch (e) { return null; } } return null; }
  function allOf(messages, name) { var o = []; messages.forEach(function (m) { if (m.role === 'tool' && m.name === name) { try { o.push(JSON.parse(m.content)); } catch (e) {} } }); return o; }
  function nd(input) { var n = input.need || {}; return { task: n.task, modality: n.modality, annotation: n.annotation, license: n.license }; }
  function classify(input) {
    if (input && input.candidate_ids != null) return 'compare';
    if (input && input.dataset_id != null) return 'access';
    var st = input && input.subtype;
    if (st === 'inventory' || st === 'format-detection' || st === 'annotation-format') return 'retrieve';
    if (st === 'numeric-profile' || st === 'tool-selection' || st === 'edge-case') return 'profile';
    if (st === 'annotation-conversion' || st === 'dataset-split' || st === 'annotation-validity') return 'prep';
    return 'discovery';
  }
  return { chat: function (messages) {
    var input = firstUser(messages), t = classify(input);
    function done(f) { return { content: '', tool_calls: [tcall('submit_answer', Object.assign({ abstained: false }, f))] }; }
    function gather(calls) { return { content: '', tool_calls: calls }; }

    if (t === 'retrieve') {
      if (input.subtype === 'inventory') { var iv = last(messages, 'inventory_files'); if (!iv) return gather([tcall('inventory_files', { path: input.path })]); return done({ inventory: { file_count: iv.file_count, by_format: iv.by_format } }); }
      var d0 = last(messages, 'detect_format'); if (!d0) return gather([tcall('detect_format', { path: input.path })]);
      return done({ format: input.subtype === 'annotation-format' ? d0.annotation_format : d0.format });
    }
    if (t === 'profile') {
      var d = last(messages, 'detect_format'); if (!d) return gather([tcall('detect_format', { path: input.path })]);
      if (input.subtype === 'edge-case') return done({ result: d.target === 'file' ? d.format : d.modality_guess });
      if (input.subtype === 'tool-selection') { var tl = [d.recommended_profiler]; if (d.recommended_annotation_profiler) tl.push(d.recommended_annotation_profiler); return done({ tools: tl }); }
      var which = AT.profilerForModality(d.modality_guess);
      if (which === 'profile_images') {
        var pi = last(messages, 'profile_images'), pa = last(messages, 'profile_annotations'), calls = [];
        if (!pi) calls.push(tcall('profile_images', { path: input.path }));
        if (d.recommended_annotation_profiler && !pa) calls.push(tcall('profile_annotations', { path: input.path }));
        if (calls.length) return gather(calls);
        return done({ profile: Object.assign({}, pi, pa || {}) });
      }
      if (!which) return done({ profile: {} });   // unimplemented modality -> honest empty (no fabrication)
      var pr = last(messages, which); if (!pr) return gather([tcall(which, { path: input.path })]);
      return done({ profile: pr });
    }
    if (t === 'prep') {
      if (input.subtype === 'dataset-split') { var sp = last(messages, 'create_dataset_split'); if (!sp) return gather([tcall('create_dataset_split', { items: input.items, ratios: input.ratios, seed: input.seed })]); return done({ splits: sp.splits }); }
      var cv = last(messages, 'convert_annotations');
      if (!cv) { var a = input.inline_source ? { coco: input.inline_source, to: 'coco' } : { path: 'data/samples/' + input.source, to: input.subtype === 'annotation-validity' ? 'coco' : input.target }; return gather([tcall('convert_annotations', a)]); }
      if (input.subtype === 'annotation-validity') return done({ valid: cv.valid === true });
      return done({ annotations: cv.annotations });
    }
    if (t === 'access') {
      var ca = last(messages, 'check_access'), cl = last(messages, 'check_license'), c2 = [];
      if (!ca) c2.push(tcall('check_access', { id: input.dataset_id }));
      if (!cl) c2.push(tcall('check_license', { id: input.dataset_id }));
      if (c2.length) return gather(c2);
      return done({ access_status: ca.access_status, commercial_ok: cl.commercial_ok, selected_ids: [input.dataset_id] });
    }
    if (t === 'compare') {
      var cr = last(messages, 'compare_resources');
      if (!cr) return gather([tcall('compare_resources', Object.assign({ ids: input.candidate_ids }, nd(input)))]);
      var rk = rankFromEvidence(cr); return done({ ranking: rk, selected_ids: rk.slice(0, 1) });
    }
    // discovery (A)
    if (input.fitness_target) {
      var cf = last(messages, 'check_fitness'); if (!cf) return gather([tcall('check_fitness', Object.assign({ id: input.fitness_target }, nd(input)))]);
      return done({ fitness_verdict: { id: input.fitness_target, verdict: cf.verdict === 'unfit' ? 'unfit' : 'fit' }, selected_ids: [] });
    }
    var sd = last(messages, 'search_datasets');
    if (!sd) return gather([tcall('search_datasets', Object.assign({ limit: 50 }, nd(input)))]);
    var fits = allOf(messages, 'check_fitness');
    if (fits.length === 0) {
      var cands = (sd.results || []).map(function (r) { return r.id; });
      if (!cands.length) return done({ selected_ids: [], abstained: true });
      return gather(cands.map(function (id) { return tcall('check_fitness', Object.assign({ id: id }, nd(input))); }));
    }
    var sel = fits.filter(function (f) { return f.verdict === 'fit'; }).map(function (f) { return f.id; });
    return done({ selected_ids: sel, abstained: sel.length === 0 });
  } };
}

// ---------------------------------------------------------------- the SHARED harness (3-pass)
// pass 1: capture the exact inputs the grader passes · pass 2: run the REAL agent.run per unique input
// (async; cache by input) · pass 3: grade with a sync lookup into the real-agent answers. Zero coupling to
// any one grader — drives ALL of them identically.
async function gradeViaAgent(graderWrap, categoryJson) {
  var agent = Agent.createAgent({ api: api, corpus: corpus, taxonomy: taxonomy, tools: tools, llm: makePolicyStub(), maxSteps: 6 });
  var inputs = [];
  graderWrap(function (inp) { inputs.push(inp); return {}; }, categoryJson);     // pass 1
  var cache = {};
  for (var i = 0; i < inputs.length; i++) { var k = JSON.stringify(inputs[i]); if (!(k in cache)) cache[k] = (await agent.run(inputs[i])).answer; }  // pass 2 (REAL agent)
  var report = graderWrap(function (inp) { return cache[JSON.stringify(inp)] || {}; }, categoryJson);  // pass 3
  return { report: report, cache: cache, inputs: inputs };
}

(async function () {
  var ran = [];
  console.log('\n[A] DISCOVERY — benchmarkAgent through the REAL agent loop (search -> check_fitness -> submit)');
  var gs = loadJson('data-agent-goldenset.json');
  if (gs) {
    var A = (await gradeViaAgent(function (fn, c) { return api.benchmarkAgent(fn, c, corpus); }, gs)).report;
    console.log('  A:', JSON.stringify({ precision: A.precisionAtK, nDCG: A.ndcgAtK, fitness: A.fitnessAccuracy, license: A.licenseCorrectness, abstention: A.abstentionCorrectness, halluc: A.hallucinationRate }),
      '(precision/abstention are reasoning-bound: stub selects all-fit in search order, no suitability oracle — real quality measured tomorrow)');
    // A's TOOL-BOUND parts are deterministic and must be exact: fitness verdicts, license-correctness, and
    // NO hallucination (every selected id is real). Ranking quality (precision/nDCG/abstention) is reasoning-bound.
    check('A runs e2e (144 cases) + NO hallucination + fitness 1.0 + license 1.0 (tool-bound parts exact)',
      A.cases === 144 && A.hallucinationRate === 0 && A.fitnessAccuracy === 1.0 && A.licenseCorrectness === 1.0, A);
    ran.push('A');
  } else check('goldenset present', false);

  console.log('\n[B] EVALUATE/access — benchmarkAccessLicense through the REAL agent (check_access + check_license)');
  var B = loadJson('benchmark-category-B.json');
  var Br = (await gradeViaAgent(function (fn, c) { return api.benchmarkAccessLicense(fn, c); }, B)).report;
  console.log('  B:', JSON.stringify({ access: Br.accessStatusAccuracy, license: Br.licenseCorrectness }));
  check('B accessStatusAccuracy === 1.0 (real agent path)', Br.accessStatusAccuracy === 1.0, Br);
  check('B licenseCorrectness === 1.0 (real agent path)', Br.licenseCorrectness === 1.0, Br);
  ran.push('B');

  console.log('\n[C] RETRIEVE — benchmarkRetrieve through the REAL agent (inventory_files / detect_format)');
  var C = loadJson('benchmark-category-C.json');
  var Cr = (await gradeViaAgent(function (fn, c) { return api.benchmarkRetrieve(fn, c); }, C)).report;
  console.log('  C:', JSON.stringify({ format: Cr.formatAccuracy, inventory: Cr.inventoryExactAccuracy, corruptMissing: Cr.corruptMissingDetection }));
  check('C formatAccuracy === 1.0 (real agent path)', Cr.formatAccuracy === 1.0, Cr);
  check('C inventoryExactAccuracy === 1.0 (real agent path)', Cr.inventoryExactAccuracy === 1.0, Cr);
  ran.push('C');

  console.log('\n[D] UNDERSTAND — benchmarkProfile through the REAL agent (profile_* / detect_format, modality-routed)');
  var D = loadJson('benchmark-category-D.json');
  var Dr = (await gradeViaAgent(function (fn, c) { return api.benchmarkProfile(fn, c); }, D)).report;
  console.log('  D:', JSON.stringify({ profile: Dr.profileAccuracy, tools: Dr.toolSelectionAccuracy, edge: Dr.edgeCaseAccuracy }));
  check('D profileAccuracy === 1.0 (real agent path, incl. BIM)', Dr.profileAccuracy === 1.0, Dr);
  check('D toolSelectionAccuracy === 1.0 (real agent path)', Dr.toolSelectionAccuracy === 1.0, Dr);
  check('D edgeCaseAccuracy === 1.0 (real agent path)', Dr.edgeCaseAccuracy === 1.0, Dr);
  ran.push('D');

  console.log('\n[E] EVALUATE/compare — benchmarkAgentCompare through the REAL agent (compare_resources -> ranking)');
  var E = loadJson('benchmark-category-E.json');
  var Eres = await gradeViaAgent(function (fn, c) { return api.benchmarkAgentCompare(fn, c); }, E);
  var Er = Eres.report;
  console.log('  E:', JSON.stringify({ top1: Er.top1Accuracy, meanTau: Er.meanTau }), '(reasoning-bound: agent weighs evidence; stub uses a naive heuristic — real quality measured tomorrow)');
  // E is reasoning-bound (compare_resources is evidence-only by design). Assert the loop RUNS and the agent
  // emits a WELL-FORMED ranking (a permutation of the candidate ids — NO fabrication). Score is reported, not forced.
  var wellFormed = (E.cases || []).every(function (c) { var ans = Eres.cache[JSON.stringify({ q: c.q, need: c.need, candidate_ids: (c.candidate_ids || []).slice() })] || {}; var r = ans.ranking || []; var cset = {}; (c.candidate_ids || []).forEach(function (x) { cset[norm(x)] = 1; }); return r.length === (c.candidate_ids || []).length && r.every(function (x) { return cset[norm(x)]; }); });
  check('E runs e2e + every ranking is a permutation of candidate_ids (no fabrication)', typeof Er.top1Accuracy === 'number' && wellFormed, { top1: Er.top1Accuracy, wellFormed: wellFormed });
  ran.push('E');

  console.log('\n[F] USE/prep — benchmarkPrep through the REAL agent (convert_annotations / create_dataset_split)');
  var F = loadJson('benchmark-category-F.json');
  var Fr = (await gradeViaAgent(function (fn, c) { return api.benchmarkPrep(fn, c); }, F)).report;
  console.log('  F:', JSON.stringify({ conversion: Fr.conversionAccuracy, split: Fr.splitCorrectness, validity: Fr.annotationValidityAccuracy }));
  check('F conversionAccuracy === 1.0 (real agent path)', Fr.conversionAccuracy === 1.0, Fr);
  check('F splitCorrectness === 1.0 (real agent path)', Fr.splitCorrectness === 1.0, Fr);
  check('F annotationValidityAccuracy === 1.0 (real agent path)', Fr.annotationValidityAccuracy === 1.0, Fr);
  ran.push('F');

  console.log('\n[*] determinism — the whole harness is reproducible (re-run B identical)');
  var B2 = (await gradeViaAgent(function (fn, c) { return api.benchmarkAccessLicense(fn, c); }, B)).report;
  check('re-run is identical (deterministic agent path)', JSON.stringify(B2.accessStatusAccuracy) === JSON.stringify(Br.accessStatusAccuracy));

  console.log('\n  Categories now running END-TO-END through the real agent loop: ' + ran.join(', '));
  console.log('  (swap makePolicyStub() -> live llm client in createAgent to run the same harness on a real model)');
  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})();
