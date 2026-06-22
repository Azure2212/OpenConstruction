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
      authors: ds.authors != null ? ds.authors : null,
      doi: ds.doi || null, paper: ds.paper || null, access: ds.access || null, note: ds.note || null
    };
  }

  // ---------------------------------------------- URL host/scheme classification (ONE RULEBOOK)
  // Deterministic, NO network. Single source of truth for access-class-by-host, shared by
  // classifyAccess (C6/Category-B) and the agent's resolve_url tool. Host rules grounded in the
  // Category-B host-derived GT (data/benchmark-category-B.json). Liveness (200 vs 404) NOT probed.
  var OPEN_DATA_DOI = { '10.6084': 'figshare', '10.5281': 'zenodo', '10.17632': 'mendeley', '10.7910': 'dataverse' };
  function classifyUrl(url) {
    var raw = String(url == null ? '' : url).trim();
    if (!raw) return { url: raw, scheme: 'invalid', host: null, is_doi: false, doi_prefix: null, repository: 'other', access_class: 'unknown', note: 'empty url' };
    var lower = raw.toLowerCase();
    var scheme = 'none', host = null, rest = raw;
    var sm = raw.match(/^([a-z][a-z0-9+.\-]*):\/\//i);
    if (sm) { scheme = sm[1].toLowerCase(); rest = raw.slice(sm[0].length); }
    else if (/^doi:/i.test(raw)) { scheme = 'doi'; rest = raw.replace(/^doi:/i, ''); }
    else if (/^10\.\d{4,9}\//.test(raw)) { scheme = 'doi'; }
    var hm = rest.match(/^([^\/:?#]+)/); if (hm && scheme !== 'doi') host = hm[1].toLowerCase();
    var isDoi = scheme === 'doi' || /(^|\/)(dx\.)?doi\.org\//.test(lower) || /^doi:10\./.test(lower);
    var doiPrefix = null; if (isDoi) { var pm = lower.match(/10\.(\d{4,9})\b/); if (pm) doiPrefix = '10.' + pm[1]; }
    function hostHas(s) { return host && host.indexOf(s) >= 0; }
    var repository = 'other', access = 'unknown';
    if (isDoi && doiPrefix && OPEN_DATA_DOI[doiPrefix]) { repository = OPEN_DATA_DOI[doiPrefix]; access = 'open'; } // data-repo DOI
    else if (isDoi) { repository = 'doi'; access = 'unknown'; }                        // journal DOI = citation, not access
    else if (hostHas('github.io') || hostHas('github.com')) { repository = 'github'; access = 'open'; }
    else if (hostHas('zenodo.org')) { repository = 'zenodo'; access = 'open'; }
    else if (hostHas('figshare.com')) { repository = 'figshare'; access = 'open'; }
    else if (hostHas('mendeley.com')) { repository = 'mendeley'; access = 'open'; }
    else if (hostHas('huggingface.co')) { repository = 'huggingface'; access = 'open'; }
    else if (hostHas('dataverse')) { repository = 'dataverse'; access = 'open'; }
    else if (hostHas('drive.google.com') || hostHas('docs.google.com')) { repository = 'google_drive'; access = 'open'; }
    else if (hostHas('data.dtu.dk')) { repository = 'dtu_data'; access = 'open'; }
    else if (hostHas('purr.purdue.edu')) { repository = 'purdue_purr'; access = 'open'; }
    else if (hostHas('ieee-dataport.org')) { repository = 'ieee_dataport'; access = 'registration_required'; }
    else if (hostHas('roboflow')) { repository = 'roboflow'; access = 'registration_required'; }
    else if (hostHas('sharepoint')) { repository = 'sharepoint'; access = 'gated'; }
    else { repository = 'other'; access = 'unknown'; }                                // lab/personal host -> not groundable
    return { url: raw, scheme: scheme, host: host, is_doi: isDoi, doi_prefix: doiPrefix, repository: repository,
      access_class: access, note: 'host/scheme classification only — liveness (HTTP 200 vs 404) NOT probed' };
  }

  // ---------------------------------------------- access classification (STATED access from metadata)
  // open | gated | registration_required | restricted | unknown. NOT broken_link (needs a live probe — Phase 3).
  // G3.0 FIX: the catalog's `access` is a bare URL in all 136 (0 access-instruction text), so the old
  // text-then-"https->open" path degenerated to "open" for everything and mislabeled 8/14 Category-B
  // cases. Now: a URL/DOI is classified by HOST via classifyUrl (one rulebook with resolve_url); only
  // genuine free-text instructions fall through to the text signals.
  function classifyAccess(rec) {
    var a = String((rec && rec.access) || '').trim();
    if (!a) return 'unknown';
    var low = a.toLowerCase();
    if (/^(https?:\/\/|ftp:\/\/|s3:\/\/|gs:\/\/|doi:)/.test(low) || /^10\.\d{4,9}\//.test(low) || /(^|\/)(dx\.)?doi\.org\//.test(low))
      return classifyUrl(a).access_class;                                              // URL/DOI -> host rulebook
    if (low === 'not specified' || low === 'unknown' || low === 'n/a' || low === 'tbd') return 'unknown';
    if (/restricted|private|not publicly|by agreement|\beula\b|\bnda\b|license agreement|on request only|requires approval|upon agreement/.test(low)) return 'restricted';
    if (/regist(er|ration)|sign[- ]?up|create an account|account required|log[- ]?in|sign[- ]?in/.test(low)) return 'registration_required';
    if (/request|apply|contact|e-?mail|permission|forms?\.gle|google form|inquir|\bform\b/.test(low)) return 'gated';
    return 'unknown';
  }

  // ---------------------------------------------- citation (deterministic, from metadata)
  function citation(rec) {
    var raw = rec && rec.authors;
    var list = Array.isArray(raw) ? raw.map(function (x) { return typeof x === 'string' ? x : (x && x.name) || ''; }).filter(Boolean)
             : (raw ? [String(raw)] : []);
    var who = list.length ? (list.length > 3 ? list[0] + ' et al.' : list.join(', ')) : '';
    var yr = rec && rec.year ? ' (' + rec.year + ')' : '';
    var name = (rec && (rec.name || rec.id)) || '';
    var text = (who ? who + yr + '. ' : '') + name + '.' + (rec && rec.doi ? ' ' + rec.doi : '');
    return { text: text.trim(), source_url: (rec && (rec.doi || rec.paper || rec.access)) || null, doi: (rec && rec.doi) || null };
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

  // ---------------------------------------------- CATEGORY-E COMPARE-SELECT SCORING (B-step, OC_DATA_1)
  // Grades an agent's `result.ranking` (array of dataset IDs, best-first) against benchmark-category-E.json.
  // REUSES the policy baked into each case by scripts/gen_category_E_grade.js (do NOT reinvent):
  //   • EPS-top1: top-1 correct  <=>  agent ranking[0] ∈ case.gt_top1_set  (the within-EPS set).
  //   • Kendall-τ vs case.gt_ranking, with case.gt_ties groups treated as EITHER-ORDER (excluded pairs).
  function kendallTau(agentRanking, gtRanking, gtTies) {
    const gtPos = {}; gtRanking.forEach((id, i) => { gtPos[id] = i; });
    const tieOf = {}; (gtTies || []).forEach((g, gi) => g.forEach(id => { tieOf[id] = gi; }));
    const sameTie = (a, b) => tieOf[a] !== undefined && tieOf[a] === tieOf[b];
    const aPos = {}; arr(agentRanking).forEach((id, i) => { if (aPos[id] === undefined) aPos[id] = i; });
    let next = arr(agentRanking).length; gtRanking.forEach(id => { if (aPos[id] === undefined) aPos[id] = next++; }); // omitted -> last (deterministic)
    let C = 0, D = 0;
    for (let i = 0; i < gtRanking.length; i++) for (let j = i + 1; j < gtRanking.length; j++) {
      const a = gtRanking[i], b = gtRanking[j];
      if (sameTie(a, b)) continue;                                  // GT-tied => either-order => not scored
      const gtS = Math.sign(gtPos[a] - gtPos[b]), aS = Math.sign(aPos[a] - aPos[b]);
      if (aS === 0) { D++; continue; }
      if (gtS === aS) C++; else D++;
    }
    return (C + D) ? +((C - D) / (C + D)).toFixed(4) : 1;            // no comparable pairs => trivially 1
  }
  function scoreCompareSelect(c, agentRanking) {
    const r = arr(agentRanking);
    const top1 = r.length > 0 && (c.gt_top1_set || [c.gt_best]).indexOf(r[0]) >= 0;   // EPS-top1 via baked set
    return { top1Correct: !!top1, tau: kendallTau(r, c.gt_ranking || [], c.gt_ties || []), agentTop1: r[0] || null };
  }
  // benchmarkAgentCompare(agentRunFn, categoryE) — categoryE = parsed benchmark-category-E.json.
  // agentRunFn(input) is SYNC; input HIDES the GT = { q, need, candidate_ids }. Returns ranking via
  // result.ranking (contract Analyst adds to submit_answer). Async LLMs: pre-collect -> sync lookup.
  function benchmarkAgentCompare(agentRunFn, categoryE) {
    const cases = (categoryE && categoryE.cases) || [];
    let t1 = 0, tauSum = 0; const perCase = [];
    for (const c of cases) {
      const out = agentRunFn({ q: c.q, need: c.need, candidate_ids: (c.candidate_ids || []).slice() }) || {};
      const s = scoreCompareSelect(c, out.ranking);
      if (s.top1Correct) t1++; tauSum += s.tau;
      perCase.push({ task: (c.need && c.need.task) || '', top1Correct: s.top1Correct, tau: s.tau,
        agentTop1: s.agentTop1, gtBest: c.gt_best, gtTop1Set: c.gt_top1_set, gtRanking: c.gt_ranking });
    }
    return { category: 'E', cases: cases.length,
      top1Accuracy: cases.length ? +(t1 / cases.length).toFixed(4) : null,
      meanTau: cases.length ? +(tauSum / cases.length).toFixed(4) : null,
      note: 'compare-select. EPS-top1 (gt_top1_set) + Kendall-τ with gt_ties either-order — policy from gen_category_E_grade.js. No LLM-judge.',
      perCase };
  }

  // ---------------------------------------------- CATEGORY-B: access-status + license + report metrics (OC_DATA_1)
  // Deterministic, no LLM-judge. access-status GT is host-derived (benchmark-category-B.json);
  // completeness fields align with agent-tools.js validate_metadata (provenance=doi|paper, license, access).
  function scoreAccessStatus(pred, gt) { return { correct: norm(pred) === norm(gt), pred: pred || null, gt: gt }; }
  var REPORT_REQUIRED_FIELDS = ['datasets', 'rationale', 'source_citation', 'license', 'access', 'limitations', 'residual_risks'];
  var GROUNDED_FIELDS = ['source_citation', 'license', 'access'];
  function _present(v) { return v != null && String(v).trim() !== '' && !(Array.isArray(v) && v.length === 0); }
  // reportCompleteness — scores an agent REPORT vs the required fields; grounds the verifiable ones
  // (source_citation/license/access) against the real dataset record. provenanceCompleteness = grounded subset.
  function reportCompleteness(report, rec, required) {
    report = report || {}; required = required || REPORT_REQUIRED_FIELDS;
    var present = [], grounded = [], missing = [];
    required.forEach(function (f) {
      if (!_present(report[f])) { missing.push(f); return; }
      present.push(f);
      if (GROUNDED_FIELDS.indexOf(f) >= 0 && rec) {
        var val = norm(report[f]), ok = false;
        if (f === 'license') ok = val === norm(rec.license) || (report.license_class && norm(report.license_class) === norm(rec.rights && rec.rights.cls));
        else if (f === 'access') ok = val === norm(rec.access);
        else if (f === 'source_citation') ok = !!((rec.doi && val.indexOf(norm(rec.doi)) >= 0) || (rec.paper && val.indexOf(norm(rec.paper)) >= 0));
        if (ok) grounded.push(f);
      }
    });
    var credited = required.filter(function (f) {
      if (missing.indexOf(f) >= 0) return false;
      if (GROUNDED_FIELDS.indexOf(f) >= 0) return grounded.indexOf(f) >= 0;   // grounded fields only count if grounded
      return true;
    }).length;
    return { completeness: +(credited / required.length).toFixed(3), provenanceCompleteness: +(grounded.length / GROUNDED_FIELDS.length).toFixed(3),
      present: present, grounded: grounded, missing: missing };
  }
  // citation presence + accuracy vs the real doi/paper
  function citationScore(reportCitation, rec) {
    var c = String(reportCitation == null ? '' : reportCitation), present = _present(c);
    var accurate = !!(rec && ((rec.doi && norm(c).indexOf(norm(rec.doi)) >= 0) || (rec.paper && norm(c).indexOf(norm(rec.paper)) >= 0)));
    return { present: present, accurate: accurate, doiSyntax: /10\.\d{4,9}\//.test(c), score: +((present ? 0.5 : 0) + (accurate ? 0.5 : 0)).toFixed(2) };
  }
  // benchmarkAccessLicense(agentRunFn, categoryB) — grades agent {access_status, commercial_ok} vs GT.
  // Input HIDES GT: { q, dataset_id, evidence }. License REUSES commercial_ok. No LLM-judge.
  function benchmarkAccessLicense(agentRunFn, categoryB) {
    var cases = (categoryB && categoryB.cases) || [], accT = 0, accC = 0, licT = 0, licC = 0, perCase = [];
    cases.forEach(function (c) {
      var out = agentRunFn({ q: c.q, dataset_id: c.dataset_id, evidence: c.evidence }) || {};
      var row = { dataset: c.dataset_id, subtype: c.subtype };
      if (c.gt_access_status != null) { accT++; var ok = norm(out.access_status) === norm(c.gt_access_status); if (ok) accC++; row.access = { pred: out.access_status || null, gt: c.gt_access_status, correct: ok }; }
      if ('gt_commercial_ok' in c) { licT++; var lok = (out.commercial_ok === c.gt_commercial_ok); if (lok) licC++; row.license = { pred: (out.commercial_ok === undefined ? null : out.commercial_ok), gt: c.gt_commercial_ok, correct: lok }; }
      perCase.push(row);
    });
    return { category: 'B', cases: cases.length, accessStatusAccuracy: accT ? +(accC / accT).toFixed(4) : null,
      licenseCorrectness: licT ? +(licC / licT).toFixed(4) : null, counts: { access: accT, license: licT },
      note: 'Deterministic. access-status exact-match vs host-derived GT; license reuses commercial_ok. No LLM-judge.', perCase: perCase };
  }

  // ---------------------------------------------- C6 provenance-report assembler (GRADER-SIDE REFERENCE)
  // Builds the CANONICAL complete report from metadata for the selected datasets. ANTI-CIRCULARITY:
  // this is NOT exposed as an agent tool. The AGENT builds its OWN report from the primitives it calls
  // (get_citation / check_access / check_license / get_dataset); reportCompleteness scores the agent's
  // report and credits a grounded field only when the agent actually surfaced it — so an agent that
  // skips a primitive loses that field and completeness < 1 (not trivially 1.0).
  function assembleReport(selectedIds, corpus) {
    var recs = arr(selectedIds).map(function (id) { return corpus.byId.get(norm(id)); }).filter(Boolean);
    function limitationsFor(r) {
      var L = [];
      if (!r.rights || r.rights.cls === 'unknown') L.push(r.id + ': license unclear — reuse rights not groundable');
      if (classifyAccess(r) === 'unknown') L.push(r.id + ': access status not groundable from metadata');
      if (r.numImages == null && r.numClasses == null) L.push(r.id + ': scale not reported (no image/class counts)');
      if (r.modalityRaw && (!r.modality || r.modality.length === 0)) L.push(r.id + ': modality unparseable from metadata');
      return L;
    }
    var per = recs.map(function (r) {
      var cit = citation(r);
      var srcCit = cit.text + (cit.source_url && cit.text.indexOf(cit.source_url) < 0 ? ' ' + cit.source_url : '');
      return { id: r.id, name: r.name, source_url: cit.source_url, source_citation: srcCit,
        license: r.license, license_class: r.rights && r.rights.cls, access: r.access || null,
        access_status: classifyAccess(r), modality: r.modalityRaw || null,
        task: (r.tasksRaw && r.tasksRaw[0]) || null, limitations: limitationsFor(r) };
    });
    var primary = per[0] || {};
    var residual = ['Access/link liveness NOT verified at metadata level (needs Phase-3 live probe).',
                    'Metadata-only report: no file inventory / profiling performed.'];
    if (per.some(function (p) { return p.license_class === 'unknown'; }))
      residual.push('≥1 selected dataset has an unclear license — confirm terms before reuse.');
    return { datasets: per.map(function (p) { return { id: p.id, name: p.name, modality: p.modality, task: p.task }; }),
      rationale: 'Selected ' + per.length + ' dataset(s) matching the stated need; per-dataset provenance below.',
      per_dataset: per,
      source_citation: primary.source_citation || '', license: primary.license || '',
      license_class: primary.license_class || '', access: primary.access || '', access_status: primary.access_status || '',
      limitations: (function () { var L = per.reduce(function (acc, p) { return acc.concat(p.limitations); }, []); return L.length ? L : ['No metadata-level limitations identified for the selected dataset(s).']; })(),
      residual_risks: residual };
  }

  // ---------------------------------------------- CATEGORY-C: RETRIEVE — inventory + format-detection (OC_DATA_1)
  // Deterministic, no LLM-judge. GT lives in the synthetic fixtures (benchmark-category-C.json, keyed by
  // path; per-dir _FIXTURE.json). Scores an agent's inventory_files / detect_format output vs GT.
  function _sameMap(a, b) { a = a || {}; b = b || {}; var ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false; return ka.every(function (k) { return a[k] === b[k]; }); }
  function scoreFormatDetection(pred, gt) { return { correct: norm(pred) === norm(gt), pred: pred || null, gt: gt }; }
  function scoreInventory(pred, gt) {           // file-count + by-format(type) accuracy
    pred = pred || {}; var fc = pred.file_count === gt.file_count, fm = _sameMap(pred.by_format, gt.by_format);
    return { fileCountCorrect: fc, formatSetCorrect: fm, correct: fc && fm, accuracy: +(((fc ? 1 : 0) + (fm ? 1 : 0)) / 2).toFixed(3) };
  }
  // benchmarkRetrieve(agentRunFn, categoryC) — agent gets { path, subtype }, returns either
  // { inventory:{file_count,by_format} } or { format }. 'corrupted'/'empty' are first-class formats
  // (extension↔magic mismatch / 0-byte) → corrupted/missing detection is scored like any other format.
  function benchmarkRetrieve(agentRunFn, categoryC) {
    var cases = (categoryC && categoryC.cases) || [], fT = 0, fC = 0, iT = 0, iC = 0, iAcc = 0, edgeT = 0, edgeC = 0, perCase = [];
    cases.forEach(function (c) {
      var out = agentRunFn({ path: c.path, subtype: c.subtype }) || {}, row = { path: c.path, subtype: c.subtype };
      if (c.subtype === 'inventory') { iT++; var s = scoreInventory(out.inventory, c.gt_inventory); if (s.correct) iC++; iAcc += s.accuracy; row.inventory = s; }
      else { var gt = c.gt_format || c.gt_annotation_format; fT++; var ok = norm(out.format) === norm(gt); if (ok) fC++;
        if (gt === 'corrupted' || gt === 'empty') { edgeT++; if (ok) edgeC++; }
        row.format = { pred: out.format || null, gt: gt, correct: ok }; }
      perCase.push(row);
    });
    return { category: 'C', cases: cases.length,
      formatAccuracy: fT ? +(fC / fT).toFixed(4) : null,
      inventoryExactAccuracy: iT ? +(iC / iT).toFixed(4) : null,
      inventoryMeanAccuracy: iT ? +(iAcc / iT).toFixed(4) : null,
      corruptMissingDetection: edgeT ? +(edgeC / edgeT).toFixed(4) : null,
      counts: { format: fT, inventory: iT, edge: edgeT },
      note: 'Deterministic. format-detection exact-match + inventory file-count/by-format vs synthetic-fixture GT; corrupted/empty scored as formats. No LLM-judge.', perCase: perCase };
  }

  // ---------------------------------------------- CATEGORY-D: UNDERSTAND — profiling accuracy (OC_DATA_1)
  // Deterministic, no LLM-judge. Scores agent {profile}/{tools}/{result} vs ORACLE GT (read from fixture
  // bytes; benchmark-category-D.json). numeric-profile = fraction of GT fields within tolerance (counts
  // exact, floats rel 1%); tool-selection = set-match; edge = exact. `defined-only` cases are skipped.
  // relative tolerance with a 1e-9 floor; for small counts (e.g. 8) the 1% band (<1) forces exact-integer,
  // while measurements (means/bbox) get the tolerance. Avoids the Number.isInteger(1800.0)===true trap.
  function _closeNum(a, b, rt) { if (typeof a !== 'number' || typeof b !== 'number') return false; return Math.abs(a - b) <= Math.max(rt * Math.abs(b), 1e-9); }
  function _eqField(a, b, rt) {
    if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every(function (x, i) { return _eqField(a[i], x, rt); });
    if (b && typeof b === 'object') return !!a && typeof a === 'object' && Object.keys(b).every(function (k) { return _eqField(a[k], b[k], rt); });
    if (typeof b === 'number') return _closeNum(a, b, rt);
    if (typeof b === 'boolean') return a === b;
    return norm(a) === norm(b);
  }
  function _setEq(a, b) { a = uniq(arr(a).map(norm)).sort(); b = uniq(arr(b).map(norm)).sort(); return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
  function scoreProfile(pred, gt, relTol) {
    relTol = relTol || 0.01; pred = pred || {}; var keys = Object.keys(gt || {}), ok = 0, per = {};
    keys.forEach(function (k) { var c = _eqField(pred[k], gt[k], relTol); per[k] = c; if (c) ok++; });
    return { fieldsCorrect: ok, total: keys.length, accuracy: keys.length ? +(ok / keys.length).toFixed(3) : null, perField: per };
  }
  // benchmarkProfile(agentRunFn, categoryD) — agent gets { path, modality, subtype }; returns
  // { profile } | { tools } | { result }. defined-only modalities (no fixtures) are NOT scored.
  function benchmarkProfile(agentRunFn, categoryD) {
    var cases = ((categoryD && categoryD.cases) || []).filter(function (c) { return c.status !== 'defined-only'; });
    var pT = 0, pAcc = 0, tT = 0, tC = 0, eT = 0, eC = 0, perCase = [];
    cases.forEach(function (c) {
      var out = agentRunFn({ path: c.path, modality: c.modality, subtype: c.subtype }) || {}, row = { path: c.path, subtype: c.subtype, modality: c.modality };
      if (c.subtype === 'numeric-profile') { pT++; var s = scoreProfile(out.profile, c.gt_profile, c.tolerance && c.tolerance.rel); pAcc += s.accuracy; row.profile = s; }
      else if (c.subtype === 'tool-selection') { tT++; var ok = _setEq(out.tools, c.gt_tools); if (ok) tC++; row.tools = { pred: out.tools || null, gt: c.gt_tools, correct: ok }; }
      else if (c.subtype === 'edge-case') { eT++; var ok2 = norm(out.result) === norm(c.gt_result); if (ok2) eC++; row.edge = { pred: out.result || null, gt: c.gt_result, correct: ok2 }; }
      perCase.push(row);
    });
    return { category: 'D', scoredCases: cases.length,
      profileAccuracy: pT ? +(pAcc / pT).toFixed(4) : null, toolSelectionAccuracy: tT ? +(tC / tT).toFixed(4) : null,
      edgeCaseAccuracy: eT ? +(eC / eT).toFixed(4) : null, counts: { numeric_profile: pT, tool_selection: tT, edge: eT },
      note: 'Deterministic. numeric-profile within tolerance (counts exact, floats rel 1%) + modality tool-selection + corrupted/empty/incomplete edge. defined-only skipped. No LLM-judge.', perCase: perCase };
  }

  // ---------------------------------------------- exports
  const API = {
    parseNeed, c1Discovery, c2Understand, c3Fitness, c4CompareSelect, c5Reliability,
    loadResources, setTaxonomy, loadCorpus, buildCorpus, datasetRecord, runOn, benchmarkOn,
    licenseRights, licenseClass, modalityBuckets, annotationBuckets, canonTaskIds, taskIdMatch,
    run, runBenchmark, benchmarkAgent, runBenchmarkAgent,
    benchmarkAgentCompare, scoreCompareSelect, kendallTau,
    scoreAccessStatus, reportCompleteness, citationScore, benchmarkAccessLicense, REPORT_REQUIRED_FIELDS,
    scoreFormatDetection, scoreInventory, benchmarkRetrieve,
    scoreProfile, benchmarkProfile,
    classifyAccess, classifyUrl, citation, assembleReport,
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
