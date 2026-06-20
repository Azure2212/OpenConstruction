// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// data-agent.js — deterministic capability layer + benchmark (reference baseline).
//
// WHAT THIS IS: NOT an LLM agent and NOT a chatbot. It is the deterministic,
// inspectable REFERENCE BASELINE for the project's capability framework
// (workingGroup/shared/ResearchOrientationProject.md). An LLM agent layer plugs in
// ON TOP of these same capabilities later. Each capability is a pure function over
// catalog METADATA only ($0, no file download, no LLM call):
//
//   C1 Discovery · C2 Metadata understanding · C3 Fitness-for-task ·
//   C4 Compare & select · C5 Reliability/abstention
//
// Controlled vocabularies (modality_buckets · license_rights · task_canon+hierarchy)
// are IMPORTED from data/agent-taxonomy.json (OWNED by OC_DATA_1) — NOT hardcoded and
// NOT read off window globals — so Node/CI and the browser run IDENTICAL logic
// (cross-environment determinism). In Node, inject via setTaxonomy(); in the browser,
// loadResources() fetches it.

(function () {
  'use strict';

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter(Boolean); }
  function arr(v) {
    if (Array.isArray(v)) return v.filter(x => x != null && String(x).trim() !== '');
    if (v == null || String(v).trim() === '') return [];
    return [v];
  }
  function uniq(a) { return Array.from(new Set(a)); }

  // ---------------------------------------------- injected resource (single source of truth)
  let _tax = null;                 // agent-taxonomy.json (OC_DATA_1)
  let _modBuckets = [];            // [{id, keywords[]}]
  let _licByKey = {};              // norm(license) -> {cls, commercial_ok, ...}
  let _licFallback = [];           // fallback_keyword_rules[]
  let _taskMap = new Map();        // norm(label) -> { ids[], broader, related[], preferred }
  let _idToNode = new Map();       // task id -> { broader, related[], preferred }

  function setTaxonomy(tax) {
    _tax = tax || null;
    _modBuckets = (_tax && _tax.modality_buckets && _tax.modality_buckets.buckets) || [];
    _licByKey = (_tax && _tax.license_rights && _tax.license_rights.by_license) || {};
    _licFallback = (_tax && _tax.license_rights && _tax.license_rights.fallback_keyword_rules) || [];
    _taskMap = new Map(); _idToNode = new Map();
    const tc = (_tax && _tax.task_canon) || {};
    Object.entries(tc.map || {}).forEach(([label, v]) => {
      const ids = v.split ? arr(v.split) : [v.canonical_id];   // honor `.split` (compound label -> several ids)
      _taskMap.set(norm(label), { ids, broader: v.broader || null, related: arr(v.related), preferred: v.preferred_label || v.canonical_id || norm(label) });
      ids.forEach(id => { if (id) _idToNode.set(id, { broader: v.broader || null, related: arr(v.related), preferred: v.preferred_label || id }); });
    });
    // split_rules: one label -> several canonical ids (kept for robustness; map may also carry `.split`)
    Object.entries(tc.split_rules || {}).forEach(([label, ids]) => {
      _taskMap.set(norm(label), { ids: arr(ids), broader: null, related: [], preferred: norm(label) });
    });
  }

  function candidatePaths(file) {
    return uniq(['data/' + file, './data/' + file, '../data/' + file, '/open-construction/data/' + file]);
  }
  async function loadJson(file) {
    for (const url of candidatePaths(file)) {
      try { const res = await fetch(url, { cache: 'no-cache' }); if (res.ok) return await res.json(); } catch (e) {}
    }
    return null;
  }
  let _resPromise = null;
  async function loadResources(force) {
    if (_tax && !force) return;
    if (_resPromise && !force) return _resPromise;
    _resPromise = (async () => { const tax = await loadJson('agent-taxonomy.json'); if (tax) setTaxonomy(tax); })();
    return _resPromise;
  }

  // ---------------------------------------------- taxonomy-driven normalization (OC_DATA_1 schema)
  // Modality: split raw on [,;/]; per piece, FIRST bucket whose keyword is a substring wins.
  function modalityBuckets(raw) {
    let s = ' ' + String(arr(raw).join(' , ')).toLowerCase() + ' ';
    [',', ';', '/'].forEach(d => { s = s.split(d).join(' | '); });
    const pieces = s.split('|').map(norm).filter(Boolean);
    const out = [];
    pieces.forEach(piece => {
      for (const b of _modBuckets) { if ((b.keywords || []).some(k => piece.includes(norm(k)))) { out.push(b.id); break; } }
    });
    return uniq(out);
  }

  // License -> per-axis RIGHTS via OC_DATA_1's by_license map + fallback_keyword_rules
  // (import contract, round-3-OC_DATA_1.md). Returns {commercial_ok, derivatives_ok, share_alike,
  // attribution, cls}. The C3 license gate tests commercial_ok === true (NOT cls === 'permissive').
  function licenseRights(raw) {
    const key = norm(raw);
    const e = _licByKey[key];
    if (e) return { commercial_ok: e.commercial_ok, derivatives_ok: e.derivatives_ok, share_alike: e.share_alike, attribution: e.attribution, cls: e.cls };
    const hay = ' ' + key + ' ';
    for (const rule of _licFallback) {
      if (rule.if_contains && rule.if_contains.some(t => hay.includes(norm(t)))) {
        if (rule.class === 'unknown') return { commercial_ok: null, derivatives_ok: null, share_alike: null, attribution: null, cls: 'unknown' };
        if ('commercial_ok' in rule) return { commercial_ok: rule.commercial_ok, derivatives_ok: null, share_alike: null, attribution: null, cls: rule.commercial_ok ? 'permissive' : 'noncommercial' };
      }
      if (rule.else) return { commercial_ok: true, derivatives_ok: null, share_alike: null, attribution: null, cls: 'permissive' }; // documented default
    }
    return { commercial_ok: null, derivatives_ok: null, share_alike: null, attribution: null, cls: 'unknown' };
  }
  function licenseClass(raw) { return licenseRights(raw).cls; } // display convenience

  // ---------------------------------------------- task canon + hierarchy (from task_canon.map)
  function canonTaskIds(label) {
    const node = _taskMap.get(norm(label));
    return node ? node.ids.slice() : ['label:' + norm(label)];
  }
  function ancestors(id) {
    const out = []; let cur = id, guard = 0;
    while (cur && guard++ < 12) { const n = _idToNode.get(cur); if (!n || !n.broader) break; out.push(n.broader); cur = n.broader; }
    return out;
  }
  // FIT semantics — FROZEN OC decision 2026-06-20 (gate G1.4/G1.5 convergence; see scope_decisions.md):
  // a dataset's declared task FITS a need task t IFF it is t (exact) or a DESCENDANT of t — i.e. t lies
  // on the dataset task's transitive `broader_task_id` chain. `related` links are NOT fit (associative
  // ≠ is-a). This puts discovery, fitness and abstain on ONE identical rule.
  function taskIdMatch(needId, dsId) {
    if (!needId || !dsId) return false;
    if (needId === dsId) return true;                  // exact
    if (ancestors(dsId).includes(needId)) return true; // dsId is a (transitive) descendant of needId
    return false;
  }
  function datasetSupportsTask(rec, needIds) {
    return needIds.some(nId => rec.taskIds.some(dsId => taskIdMatch(nId, dsId)));
  }

  // ---------------------------------------------- annotation (engine-local; may move to taxonomy)
  const ANNOTATION_BUCKETS = [
    ['segmentation', ['semantic segmentation', 'segmentation', 'segmetation', 'mask', 'pixel', 'per-point', 'point-wise', 'point wise']],
    ['instance', ['instance segmentation', 'instance']],
    ['detection', ['bounding box', 'bbox', 'object detection', 'detection', '2d box', '3d box']],
    ['classification', ['classification', 'image-level', 'class label', 'category label', 'patch']],
    ['keypoint', ['keypoint', 'pose', 'landmark', 'skeleton']],
    ['caption', ['caption', 'description', 'qa', 'question']]
  ];
  function annotationBuckets(raw) {
    const hay = ' ' + norm(arr(raw).join(' ')) + ' ';
    return uniq(ANNOTATION_BUCKETS.filter(([, terms]) => terms.some(t => hay.includes(norm(t)))).map(([b]) => b));
  }

  // ---------------------------------------------- corpus
  function datasetRecord(ds) {
    const taskLabels = arr(ds.potential_tasks);
    return {
      type: 'dataset', id: ds.id || ds.name, name: ds.name || ds.id || 'Untitled dataset',
      href: 'datasets/detail.html?id=' + encodeURIComponent(ds.id || ds.name || ''),
      year: +ds.year || null,
      tasksRaw: taskLabels, taskIds: uniq(taskLabels.flatMap(canonTaskIds)),
      modalityRaw: ds.data_modality, modality: modalityBuckets(ds.data_modality),
      annotationRaw: arr(ds.annotation_types), annotation: annotationBuckets(ds.annotation_types),
      classes: arr(ds.classes), numClasses: ds.num_classes != null ? ds.num_classes : (arr(ds.classes).length || null),
      numImages: ds.num_images != null ? ds.num_images : null,
      license: ds.license || 'Not specified', rights: licenseRights(ds.license), licenseClass: licenseClass(ds.license),
      doi: ds.doi || null, paper: ds.paper || null, access: ds.access || null, note: ds.note || null
    };
  }
  let _corpus = null;
  async function loadCorpus(force) {
    if (_corpus && !force) return _corpus;
    await loadResources(force);
    const dsRaw = await loadJson('datasets.json');
    const datasets = dsRaw ? Object.values(dsRaw).map(datasetRecord) : [];
    _corpus = { datasets, byId: new Map(datasets.map(d => [norm(d.id), d])) };
    return _corpus;
  }
  function buildCorpus(rawDatasets) { // Node/CI path (no fetch); requires setTaxonomy() first
    const datasets = Object.values(rawDatasets).map(datasetRecord);
    return { datasets, byId: new Map(datasets.map(d => [norm(d.id), d])) };
  }

  // ---------------------------------------------- C0 intake
  function parseNeed(input) {
    if (input && typeof input === 'object' && !('text' in input) &&
        ('task' in input || 'modality' in input || 'annotation' in input || 'license' in input)) return normalizeNeed(input);
    const text = typeof input === 'string' ? input : (input && input.text) || '';
    const t = norm(text);
    const need = { raw: text, task: '', modality: '', annotation: '', license: 'any', intendedUse: '', k: (input && input.k) || 5 };
    for (const b of _modBuckets) { if ((b.keywords || []).some(k => t.includes(norm(k)))) { need.modality = b.id; break; } }
    for (const [bucket, terms] of ANNOTATION_BUCKETS) { if (terms.some(x => t.includes(norm(x)))) { need.annotation = bucket; break; } }
    if (/(permissive|commercial|cc ?by|apache|mit|open licen)/.test(t)) need.license = 'commercial_ok';
    if (/(train|training|fine-?tune| ml |model)/.test(t)) need.intendedUse = 'training';
    need.task = guessTaskFromText(text);
    return normalizeNeed(need);
  }
  function guessTaskFromText(text) {
    const t = norm(text); let best = '';
    _taskMap.forEach((node, key) => { if (key.length >= 4 && t.includes(key) && key.length > best.length) best = key; });
    return best;
  }
  function normalizeNeed(n) {
    const licIn = n.license || 'any';
    return {
      raw: n.raw || '', task: n.task || '', taskIds: n.task ? canonTaskIds(n.task) : [],
      modality: n.modality || '', annotation: n.annotation || '',
      license: (licIn === 'permissive' || licIn === 'commercial') ? 'commercial_ok' : licIn,  // accept 'commercial'/'permissive'
      intendedUse: n.intendedUse || '', k: n.k || 5
    };
  }

  // ---------------------------------------------- C3 fitness (deterministic)
  function c3Fitness(rec, need) {
    const crit = [];
    const add = (key, label, required, pass, evidence) => crit.push({ key, label, required: !!required, pass: !!pass, evidence });
    const taskReq = need.taskIds.length > 0;
    add('task', 'Supports task: ' + (need.task || '—'), taskReq, taskReq && datasetSupportsTask(rec, need.taskIds),
        rec.tasksRaw.length ? rec.tasksRaw.join(', ') : 'no declared tasks');
    const modReq = !!need.modality;
    add('modality', 'Modality: ' + (need.modality || '—'), modReq, modReq && rec.modality.includes(need.modality), rec.modalityRaw || 'unspecified');
    const annReq = !!need.annotation;
    add('annotation', 'Annotation: ' + (need.annotation || '—'), annReq, annReq && rec.annotation.includes(need.annotation),
        rec.annotationRaw.length ? rec.annotationRaw.join(', ') : 'no declared annotations');
    const licReq = need.license && need.license !== 'any';
    add('license', 'License (commercial-use): ' + (need.license || 'any'), licReq, licReq && rec.rights.commercial_ok === true,
        rec.license + ' (' + rec.licenseClass + ', commercial_ok=' + rec.rights.commercial_ok + ')');
    if (need.intendedUse === 'training') {
      const ready = rec.annotation.length > 0 && (rec.numClasses || rec.classes.length);
      add('ml_ready', 'Declared training-readiness', false, ready, 'annotations=' + (rec.annotation.join(',') || 'none') + '; classes=' + (rec.numClasses || rec.classes.length || 0));
    }
    const required = crit.filter(c => c.required), passed = required.filter(c => c.pass);
    return { criteria: crit, requiredCount: required.length, passedRequired: passed.length,
      verdict: required.length > 0 && passed.length === required.length ? 'fit' : (required.length === 0 ? 'no-constraint' : 'unfit'),
      confidence: required.length ? passed.length / required.length : null };
  }

  // ---------------------------------------------- C1 discovery
  const W = { task: 0.55, modality: 0.25, annotation: 0.12, license: 0.05, text: 0.03 };
  function c1Discovery(corpus, need) {
    const terms = tokens(need.raw).filter(x => x.length > 2);
    const scored = corpus.datasets.map(rec => {
      let s = 0; const matched = [];
      if (need.taskIds.length && datasetSupportsTask(rec, need.taskIds)) { s += W.task; matched.push('task'); }
      if (need.modality && rec.modality.includes(need.modality)) { s += W.modality; matched.push('modality'); }
      if (need.annotation && rec.annotation.includes(need.annotation)) { s += W.annotation; matched.push('annotation'); }
      if (need.license !== 'any' && rec.rights.commercial_ok === true) { s += W.license; matched.push('license'); }
      if (terms.length) {
        const hay = norm(rec.name + ' ' + rec.tasksRaw.join(' ') + ' ' + (rec.modalityRaw || '') + ' ' + rec.classes.join(' '));
        const hits = terms.filter(tk => hay.includes(tk)).length;
        if (hits) s += W.text * Math.min(1, hits / terms.length);
      }
      return { rec, score: s, matched };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || (b.rec.year || 0) - (a.rec.year || 0));
    return scored;
  }

  // ---------------------------------------------- C2 understanding
  function c2Understand(rec) {
    return {
      id: rec.id, name: rec.name, href: rec.href,
      summary: [
        rec.modality.length ? 'modality: ' + rec.modality.join(', ') : 'modality: unspecified',
        rec.annotation.length ? 'annotation: ' + rec.annotation.join(', ') : 'annotation: undeclared',
        rec.tasksRaw.length ? 'tasks: ' + rec.tasksRaw.join(', ') : 'tasks: undeclared',
        'license: ' + rec.license + ' (' + rec.licenseClass + ')',
        (rec.numClasses ? rec.numClasses + ' classes' : null), (rec.numImages ? rec.numImages + ' images' : null)
      ].filter(Boolean).join(' · '),
      modality: rec.modality, annotation: rec.annotation, tasks: rec.tasksRaw,
      license: rec.license, licenseClass: rec.licenseClass, numClasses: rec.numClasses, numImages: rec.numImages,
      note: rec.note, provenance: { doi: rec.doi, paper: rec.paper, access: rec.access }
    };
  }

  // ---------------------------------------------- C4 compare & select
  function c4CompareSelect(candidates, need) {
    const rows = candidates.map(c => ({ rec: c.rec, score: c.score, matched: c.matched, fitness: c3Fitness(c.rec, need) }));
    const selected = rows
      .filter(r => r.fitness.verdict === 'fit' || (r.fitness.requiredCount === 0 && r.score > 0))
      .sort((a, b) => b.score - a.score).slice(0, need.k);
    return { rows: rows.slice(0, Math.max(need.k, 8)), selected };
  }

  // ---------------------------------------------- C5 reliability / abstention
  function c5Reliability(compare, need, corpus) {
    const selected = compare.selected;
    const out = { abstained: false, verdict: 'answered', flags: [], hallucinationSafe: true, licenseCorrect: true, confidence: 0 };
    selected.forEach(s => { if (!corpus.byId.has(norm(s.rec.id))) out.hallucinationSafe = false; });
    if (need.license && need.license !== 'any') {
      out.licenseCorrect = selected.every(s => s.rec.rights.commercial_ok === true);
      if (!out.licenseCorrect) out.flags.push('A selected dataset does not satisfy the license constraint.');
    }
    if (!selected.length) {
      out.abstained = true; out.verdict = 'none-fit';
      const nm = compare.rows.filter(r => r.fitness.requiredCount > 0).sort((a, b) => b.fitness.passedRequired - a.fitness.passedRequired)[0];
      out.nearestMiss = nm ? { id: nm.rec.id, name: nm.rec.name, href: nm.rec.href, passed: nm.fitness.passedRequired, of: nm.fitness.requiredCount,
        failing: nm.fitness.criteria.filter(c => c.required && !c.pass).map(c => c.label) } : null;
      out.message = 'No dataset in the catalog satisfies all required constraints' +
        (out.nearestMiss ? '. Closest miss: ' + out.nearestMiss.name + ' (' + out.nearestMiss.passed + '/' + out.nearestMiss.of + ' criteria).' : '.');
    } else { out.confidence = selected[0].fitness.confidence == null ? 0.5 : selected[0].fitness.confidence; }
    return out;
  }

  // ---------------------------------------------- orchestrate
  async function run(input) { return runOn(await loadCorpus(), input); }
  function runOn(corpus, input) {
    const need = parseNeed(input);
    const c1 = c1Discovery(corpus, need);
    const top = c1.slice(0, Math.max(need.k, 8));
    const c4 = c4CompareSelect(top, need);
    const c5 = c5Reliability(c4, need, corpus);
    return {
      need, corpusSize: corpus.datasets.length,
      c1: { count: c1.length, candidates: top.map(c => ({ id: c.rec.id, name: c.rec.name, href: c.rec.href, score: +c.score.toFixed(3), matched: c.matched })) },
      c2: top.map(c => c2Understand(c.rec)),
      c3: c4.rows.map(r => ({ id: r.rec.id, name: r.rec.name, fitness: r.fitness })),
      c4: { selected: c4.selected.map(s => ({ id: s.rec.id, name: s.rec.name, href: s.rec.href, score: +s.score.toFixed(3), verdict: s.fitness.verdict })),
        comparison: c4.rows.map(r => ({ id: r.rec.id, name: r.rec.name, modality: r.rec.modality, annotation: r.rec.annotation,
          license: r.rec.license, licenseClass: r.rec.licenseClass, verdict: r.fitness.verdict, score: +r.score.toFixed(3) })) },
      c5
    };
  }

  // ---------------------------------------------- BENCHMARK (deterministic; no LLM-judge)
  // Scored on C4-SELECTED (not C1-discovery). nDCG IDCG normalized over the TRUE relevant set.
  function matchExpected(rec, expect) {
    const idN = norm(rec.id), nameN = norm(rec.name);
    return expect.some(e => { const en = norm(e); return en && (idN === en || idN.includes(en) || nameN.includes(en)); });
  }
  function dcg(rels) { return rels.reduce((s, r, i) => s + r / Math.log2(i + 2), 0); }

  // A `produce(corpus, need, c, K)` returns the per-case OUTCOME the scorer consumes:
  //   fitness case -> { verdict }
  //   select case  -> { selectedIds:[...], abstained:bool, licenseCorrect:bool }
  // The default is the deterministic ENGINE; benchmarkAgent injects a producer that maps an
  // external agent's contract output. ONE metric loop => one blessed math (G1.6 carries over).
  function _engineProduce(corpus, need, c, K) {
    if (c.fitnessExpect && c.fitnessExpect.datasetId) {
      const rec0 = corpus.byId.get(norm(c.fitnessExpect.datasetId));
      return { verdict: rec0 ? c3Fitness(rec0, need).verdict : 'missing' };
    }
    const c1 = c1Discovery(corpus, need);
    const compare = c4CompareSelect(c1.slice(0, Math.max(K, 8)), need);
    const selected = compare.selected.slice(0, K).map(s => s.rec);     // C4-selected
    const c5 = c5Reliability(compare, need, corpus);
    return { selectedIds: selected.map(s => s.id), abstained: c5.abstained, licenseCorrect: c5.licenseCorrect };
  }

  // benchmarkOn(corpus, goldenSet[, produce]) — produce defaults to the engine, so calling it
  // with two args reproduces the blessed baseline byte-for-byte (behaviour-preserving refactor).
  function benchmarkOn(corpus, goldenSet, produce) {
    produce = produce || _engineProduce;
    const K = goldenSet.k || 5, cases = goldenSet.cases || [];
    let pSum = 0, ndcgSum = 0, nDisc = 0, absT = 0, absC = 0, licT = 0, licC = 0, halluc = 0, hallucN = 0, fitT = 0, fitC = 0;
    const perCase = [];
    for (const c of cases) {
      // hard constraints come ONLY from c.need; c.q is soft text used for ranking tie-breaks.
      let need;
      if ('need' in c) { need = parseNeed(c.need); need.raw = c.q || need.raw || ''; }
      else need = parseNeed(c.q || '');

      // (A) fitness-verdict case: outcome.verdict vs the expected verdict
      if (c.fitnessExpect && c.fitnessExpect.datasetId) {
        fitT++;
        const got = (produce(corpus, need, c, K) || {}).verdict || 'missing';
        const ok = got === c.fitnessExpect.verdict;
        if (ok) fitC++;
        perCase.push({ family: 'fitness', dataset: c.fitnessExpect.datasetId, expected: c.fitnessExpect.verdict, got, ok });
        continue;
      }

      // (B) discovery / license / abstain: score the produced selection set (capped to K)
      const out = produce(corpus, need, c, K) || {};
      const selIds = arr(out.selectedIds).slice(0, K);
      const selectedRecs = selIds.map(id => corpus.byId.get(norm(id)) || null);
      const expect = arr(c.expect);
      const wantAbstain = c.abstain === true || expect.length === 0;
      let rec = { p: null, ndcg: null };
      if (!wantAbstain) {
        const relevantCount = corpus.datasets.filter(d => matchExpected(d, expect)).length || expect.length; // TRUE |R|
        const rels = selectedRecs.map(r => (r && matchExpected(r, expect)) ? 1 : 0);
        const hits = rels.reduce((a, b) => a + b, 0);
        const p = hits / Math.max(1, selIds.length);                   // selection precision
        const idcg = dcg(Array.from({ length: Math.min(relevantCount, K) }, () => 1));
        const nd = idcg ? dcg(rels) / idcg : 0;
        pSum += p; ndcgSum += nd; nDisc++;
        rec = { p: +p.toFixed(3), ndcg: +nd.toFixed(3), selected: selIds.length, relevant: relevantCount, hits };
      }
      absT++; if (!!out.abstained === wantAbstain) absC++;
      if (need.license && need.license !== 'any') { licT++; if (out.licenseCorrect) licC++; }
      selIds.forEach(id => { hallucN++; if (!corpus.byId.has(norm(id))) halluc++; }); // unknown id = hallucination
      perCase.push({ q: c.q || (c.need && JSON.stringify(c.need)) || '', wantAbstain, abstained: !!out.abstained, selected: selIds, score: rec });
    }
    return {
      cases: cases.length, k: K, scoredOn: 'C4-selected',
      precisionAtK: nDisc ? +(pSum / nDisc).toFixed(3) : null,
      ndcgAtK: nDisc ? +(ndcgSum / nDisc).toFixed(3) : null,
      abstentionCorrectness: absT ? +(absC / absT).toFixed(3) : null,
      licenseCorrectness: licT ? +(licC / licT).toFixed(3) : null,
      fitnessAccuracy: fitT ? +(fitC / fitT).toFixed(3) : null,
      hallucinationRate: hallucN ? +(halluc / hallucN).toFixed(3) : 0,
      counts: { discovery: nDisc, fitness: fitT, license_constrained: licT, abstain: absT - nDisc },
      note: 'Deterministic. Scored on C4-selected. nDCG IDCG over the true relevant set. No LLM-judge. GT owned by OC_DATA_1.',
      perCase
    };
  }
  async function runBenchmark(goldenSet) { return benchmarkOn(await loadCorpus(), goldenSet); }

  // ---------------------------------------------- AGENT-AGNOSTIC SCORING ADAPTER (B4, OC_DATA_1)
  // benchmarkAgent(agentRunFn, goldenSet, corpus) — score ANY agent on golden set v1.2 using the
  // SAME blessed metric math as benchmarkOn. agentRunFn(input) is SYNC and returns the contract:
  //   { selected_ids:[...], fitness_verdict?:{id,verdict}, abstained:bool }
  // The agent input HIDES the GT: { q, need, k, fitness_target? } (fitness_target = the dataset id
  // to judge; never the expected verdict / expect list). For an async LLM, the harness (Analyst)
  // pre-collects outputs per case and passes a sync lookup as agentRunFn — keeps this adapter pure.
  function _agentProducer(agentRunFn) {
    return function (corpus, need, c, K) {
      const input = c.fitnessExpect && c.fitnessExpect.datasetId
        ? { q: c.q || '', need: c.need || {}, k: K, fitness_target: c.fitnessExpect.datasetId }
        : { q: c.q || '', need: c.need || {}, k: K };
      const out = agentRunFn(input) || {};
      if (c.fitnessExpect && c.fitnessExpect.datasetId) {
        const v = out.fitness_verdict;
        return { verdict: (v && (v.verdict || v)) || 'missing' };
      }
      const selIds = arr(out.selected_ids).slice(0, K);
      // license-correctness mirrors c5: every top-K selected dataset is commercial_ok===true
      let licenseCorrect = true;
      if (need.license && need.license !== 'any') {
        licenseCorrect = selIds.every(id => { const r = corpus.byId.get(norm(id)); return !!(r && r.rights && r.rights.commercial_ok === true); });
      }
      return { selectedIds: selIds, abstained: !!out.abstained, licenseCorrect };
    };
  }
  function benchmarkAgent(agentRunFn, goldenSet, corpus) {
    if (!corpus) throw new Error('benchmarkAgent: pass a corpus (buildCorpus(datasets) in Node, or use runBenchmarkAgent in the browser).');
    const res = benchmarkOn(corpus, goldenSet, _agentProducer(agentRunFn));
    res.scoredOn = 'agent-selected'; res.subject = 'external-agent';
    res.note = 'Agent-agnostic. Same metric math as benchmarkOn (G1.6-blessed). Contract: {selected_ids, fitness_verdict?, abstained}. No LLM-judge. GT owned by OC_DATA_1.';
    return res;
  }
  async function runBenchmarkAgent(agentRunFn, goldenSet) { return benchmarkAgent(agentRunFn, goldenSet, await loadCorpus()); }

  // ---------------------------------------------- exports
  const API = {
    parseNeed, c1Discovery, c2Understand, c3Fitness, c4CompareSelect, c5Reliability,
    loadResources, setTaxonomy, loadCorpus, buildCorpus, datasetRecord, runOn, benchmarkOn,
    licenseRights, licenseClass, modalityBuckets, annotationBuckets, canonTaskIds, taskIdMatch,
    run, runBenchmark, benchmarkAgent, runBenchmarkAgent,
    LABEL: 'Capability Framework + Deterministic Benchmark (reference baseline)',
    FRAMEWORK: [
      { id: 'C1', name: 'Discovery', desc: 'Retrieve candidate datasets for a stated need.' },
      { id: 'C2', name: 'Metadata understanding', desc: 'Normalize & explain heterogeneous fields (taxonomy-driven).' },
      { id: 'C3', name: 'Fitness-for-task', desc: 'Deterministic task(+hierarchy) ∩ modality ∩ annotation ∩ license.' },
      { id: 'C4', name: 'Compare & select', desc: 'Rank, justify, pick the best subset.' },
      { id: 'C5', name: 'Reliability / abstention', desc: 'Abstain when none fit; no fabrication; license guard.' }
    ]
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCDataAgent = API;
})();
