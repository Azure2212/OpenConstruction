// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// agent-tools.js — the LLM's toolbox (B2). Wraps the deterministic capability PRIMITIVES as
// OpenAI function-calling tools. Corpus is loaded internally; tools take JSON args.
//
// ⚠️ PRIMITIVES, NOT AN ORACLE. We deliberately expose only retrieval/inspection primitives —
//   list_tasks · search_datasets · get_dataset · check_fitness
// and a final declaration tool `submit_answer`. We DO NOT expose the deterministic selector
// (c4CompareSelect) or any "give me the answer" tool — the agent must reason its way to the set of
// datasets and decide abstention itself. (Same spirit as DAB's query primitives, not a solve() call.)

(function () {
  'use strict';
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x != null && String(x).trim() !== ''; }) : (v == null || v === '' ? [] : [v]); }

  // ============================================================ TF2 RETRIEVE: local file inspection
  // Deterministic, OFFLINE primitives that run on a LOCAL sample dir/file under data/samples/<id>/.
  // Reproduces OC_DATA_1's Category-C ground truth (data/samples/*/_FIXTURE.json + benchmark-category-C.json):
  //   format by MAGIC BYTES + extension — png/ply/coco/json/csv/text, plus empty (0 bytes) and
  //   corrupted (extension<->content/magic mismatch). NO network, NO model. (`_FIXTURE.json` is GT metadata,
  //   excluded from the agent-visible inventory.)
  var _fs = null, _path = null;
  try { if (typeof require !== 'undefined') { _fs = require('fs'); _path = require('path'); } } catch (e) { _fs = null; _path = null; }

  function extOf(name) { var m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; }
  function isPrintable(buf) {            // text vs binary heuristic (no NUL, <30% control bytes in first 1KB)
    var n = Math.min(buf.length, 1024), ctrl = 0;
    for (var i = 0; i < n; i++) { var b = buf[i]; if (b === 0) return false; if (b < 9 || (b > 13 && b < 32)) ctrl++; }
    return ctrl / Math.max(n, 1) < 0.30;
  }
  function sniffMagic(buf) {             // -> empty|png|jpeg|gif|pdf|zip|ply|json|text|binary
    if (!buf || buf.length === 0) return 'empty';
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 4 && buf.slice(0, 4).toString('latin1') === 'GIF8') return 'gif';
    if (buf.length >= 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5)) return 'zip';
    if (buf.length >= 3 && buf.slice(0, 3).toString('latin1') === 'ply') return 'ply';
    if (isPrintable(buf)) { var t = buf.toString('utf8').replace(/^﻿/, '').replace(/^\s+/, ''); return (t.charAt(0) === '{' || t.charAt(0) === '[') ? 'json' : 'text'; }
    return 'binary';
  }
  function isCoco(buf) {                 // COCO = a JSON object with images + annotations + categories
    try { var o = JSON.parse(buf.toString('utf8')); return !!(o && typeof o === 'object' && o.images && o.annotations && o.categories); }
    catch (e) { return false; }
  }
  var EXT_SIG = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', pdf: 'pdf', zip: 'zip', ply: 'ply' };
  // -> { format, magic, ext, size_bytes }. `magic === format` (matches GT gt_format/gt_magic).
  function classifyFileFormat(name, buf) {
    var ext = extOf(name), size = buf ? buf.length : 0;
    if (size === 0) return { format: 'empty', magic: 'empty', ext: ext, size_bytes: 0 };
    var magic = sniffMagic(buf), fmt;
    if (magic === 'json') { fmt = isCoco(buf) ? 'coco' : 'json'; }
    else if (EXT_SIG[ext]) { fmt = (magic === EXT_SIG[ext]) ? magic : 'corrupted'; }   // ext promises a signature -> must match
    else if (magic === 'png' || magic === 'jpeg' || magic === 'gif' || magic === 'pdf' || magic === 'zip' || magic === 'ply') { fmt = magic; } // real signature, ext didn't predict it
    else if (magic === 'text') { fmt = (ext === 'csv' || ext === 'tsv') ? 'csv' : 'text'; }
    else { fmt = 'binary'; }
    return { format: fmt, magic: fmt, ext: ext, size_bytes: size };
  }

  // format -> modality bucket (taxonomy ids). HONEST: raster-image bytes can't distinguish ground/aerial/satellite.
  var FORMAT_MODALITY = { ply: 'point_cloud', pcd: 'point_cloud', las: 'point_cloud', laz: 'point_cloud', e57: 'point_cloud',
    png: 'ground_rgb', jpeg: 'ground_rgb', gif: 'ground_rgb', csv: 'tabular', tsv: 'tabular', parquet: 'tabular',
    ifc: 'bim', rvt: 'bim', dwg: 'drawing', dxf: 'drawing', mp4: 'video', avi: 'video', mov: 'video' };
  var MODALITY_PRIORITY = ['point_cloud', 'bim', 'drawing', 'video', 'tabular', 'ground_rgb'];
  function guessModality(formats) {
    var present = {}; formats.forEach(function (f) { var m = FORMAT_MODALITY[f]; if (m) present[m] = 1; });
    for (var i = 0; i < MODALITY_PRIORITY.length; i++) if (present[MODALITY_PRIORITY[i]]) return MODALITY_PRIORITY[i];
    return null;
  }
  function guessAnnotationFormat(fmts, exts) {
    if (fmts.indexOf('coco') >= 0) return 'coco';
    if (exts.indexOf('xml') >= 0) return 'pascal_voc';
    if (exts.indexOf('labels') >= 0) return 'per_point_labels';
    if (exts.indexOf('txt') >= 0 && (fmts.indexOf('png') >= 0 || fmts.indexOf('jpeg') >= 0)) return 'yolo';
    return 'none';
  }

  // resolve_url's URL host/scheme classifier (`classifyUrl`) lives in data-agent.js as the SINGLE
  // rulebook, shared with classifyAccess (C6 / Category-B). The tool calls api.classifyUrl (see dispatch).

  // Sandbox a caller-supplied path to the samples root (accepts repo-relative "data/samples/X" OR "X").
  function resolveSamplePath(baseDir, samplesRoot, p) {
    if (!_path) return { error: 'path module unavailable' };
    var rel = String(p == null ? '' : p); if (!rel.trim()) return { error: 'no path given' };
    var root = _path.resolve(samplesRoot);
    var c1 = _path.resolve(baseDir, rel);
    if (c1 === root || c1.indexOf(root + _path.sep) === 0) return { abs: c1 };
    var c2 = _path.resolve(root, rel);
    if (c2 === root || c2.indexOf(root + _path.sep) === 0) return { abs: c2 };
    return { error: 'path is outside the samples sandbox' };
  }
  function walkFiles(absDir) {            // bounded, sorted, recursive; excludes _FIXTURE.json
    var out = [], MAXF = 5000, MAXD = 8;
    (function rec(dir, prefix, depth) {
      if (out.length >= MAXF || depth > MAXD) return;
      var entries; try { entries = _fs.readdirSync(dir); } catch (e) { return; }
      entries.sort();
      for (var i = 0; i < entries.length; i++) {
        var nm = entries[i]; if (nm === '_FIXTURE.json') continue;
        var abs = _path.join(dir, nm), st; try { st = _fs.statSync(abs); } catch (e) { continue; }
        var rel = prefix ? prefix + '/' + nm : nm;
        if (st.isDirectory()) rec(abs, rel, depth + 1);
        else if (st.isFile() && out.length < MAXF) out.push({ rel: rel, abs: abs });
      }
    })(absDir, '', 0);
    return out;
  }

  // api = window.OCDataAgent / require('data-agent.js'); corpus = api.buildCorpus(...); taxonomy = the loaded agent-taxonomy.json
  // opts = { benchmarkResults?: <parsed data/benchmark-results.json> } (for recommend_benchmark)
  function createTools(api, corpus, taxonomy, opts) {
    opts = opts || {};
    var benchmarkResults = opts.benchmarkResults || null;
    // TF2 retrieve: where the local sample fixtures live. baseDir resolves repo-relative paths
    // ("data/samples/<id>"); samplesRoot sandboxes them. Defaults derive from this module's location.
    var baseDir = opts.baseDir || (_path ? _path.resolve(__dirname, '../..') : '.');
    var samplesRoot = opts.samplesRoot || (_path ? _path.join(baseDir, 'data', 'samples') : 'data/samples');
    var compareMod = (typeof require !== 'undefined') ? require('./data-agent-compare.js') : (typeof window !== 'undefined' ? window.OCDataAgentCompare : null);
    var comparer = compareMod ? compareMod.createComparer(api) : null;
    // Vocabulary the agent may use (so it can phrase tasks canonically). Built from task_canon.map.
    var seen = {}, taskList = [];
    var map = (taxonomy && taxonomy.task_canon && taxonomy.task_canon.map) || {};
    Object.keys(map).forEach(function (label) {
      var v = map[label]; var id = v.canonical_id; if (!id || seen[id]) return; seen[id] = 1;
      taskList.push({ id: id, label: v.preferred_label || label, broader: v.broader || null });
    });
    var modalityIds = ((taxonomy && taxonomy.modality_buckets && taxonomy.modality_buckets.buckets) || []).map(function (b) { return b.id; });

    function needFrom(args) {
      return api.parseNeed({ task: args.task || '', modality: args.modality || '', annotation: args.annotation || '', license: args.license || 'any' });
    }

    var schemas = [
      { type: 'function', function: {
        name: 'list_tasks',
        description: 'List the canonical AEC task vocabulary (id, label, broader-parent) the catalog uses. Call this first to phrase a task correctly before searching.',
        parameters: { type: 'object', properties: {}, required: [] }
      }},
      { type: 'function', function: {
        name: 'search_datasets',
        description: 'Retrieve candidate datasets by facets and/or free text. Returns candidates with their declared metadata — it does NOT decide fitness; you must evaluate candidates yourself. Provide any subset of facets.',
        parameters: { type: 'object', properties: {
          query: { type: 'string', description: 'free-text keywords (optional)' },
          task: { type: 'string', description: 'a task label/id from list_tasks (optional)' },
          modality: { type: 'string', enum: modalityIds, description: 'one modality bucket (optional)' },
          annotation: { type: 'string', description: 'annotation type, e.g. segmentation/detection (optional)' },
          license: { type: 'string', enum: ['any', 'commercial'], description: 'commercial-use filter (optional)' },
          limit: { type: 'integer', description: 'max results (default 15, cap 50)' }
        }, required: [] }
      }},
      { type: 'function', function: {
        name: 'get_dataset',
        description: 'Get the full normalized metadata for ONE dataset by id (modality, annotation, tasks, license, counts, provenance).',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
      }},
      { type: 'function', function: {
        name: 'check_fitness',
        description: 'Deterministically check whether ONE dataset fits a need (per-criterion task/modality/annotation/license pass-fail + overall verdict fit|unfit|no-constraint). Use to confirm a candidate before selecting it.',
        parameters: { type: 'object', properties: {
          id: { type: 'string' }, task: { type: 'string' }, modality: { type: 'string', enum: modalityIds },
          annotation: { type: 'string' }, license: { type: 'string', enum: ['any', 'commercial'] }
        }, required: ['id'] }
      }},
      { type: 'function', function: {
        name: 'check_license',
        description: 'Get the deterministic rights for ONE dataset license: commercial_ok / derivatives_ok / share_alike / attribution + class. Use to reason about reuse before selecting.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
      }},
      { type: 'function', function: {
        name: 'validate_metadata',
        description: 'Check ONE dataset record for metadata completeness/consistency: which key fields are present/missing and any internal conflicts (e.g. num_classes vs classes, unparseable modality, unknown license). Returns per-field checks + a completeness fraction.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
      }},
      { type: 'function', function: {
        name: 'compare_resources',
        description: 'Compare SEVERAL datasets side by side over the suitability criteria (task-align, modality, annotation, license, volume, class-coverage, quality, docs, access, prep-cost). Returns a per-criterion evidence table with 0..1 sub-scores per dataset. It does NOT pick a winner or weight the criteria — you must weigh them yourself.',
        parameters: { type: 'object', properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'dataset ids to compare (2+)' },
          task: { type: 'string' }, modality: { type: 'string', enum: modalityIds }, annotation: { type: 'string' }, license: { type: 'string', enum: ['any', 'commercial'] }
        }, required: ['ids'] }
      }},
      { type: 'function', function: {
        name: 'recommend_benchmark',
        description: 'List published benchmark leaderboards from the catalog relevant to a task (and/or dataset). Returns benchmark name, task, dataset, primary metric, and the best reported method — so you can point the user at how models are evaluated for that task.',
        parameters: { type: 'object', properties: {
          task: { type: 'string' }, modality: { type: 'string', enum: modalityIds }, dataset_id: { type: 'string' }
        }, required: [] }
      }},
      { type: 'function', function: {
        name: 'check_access',
        description: 'Classify ONE dataset\'s STATED access from its metadata: open | gated | registration_required | restricted | unknown (NOT broken-link — that needs a live check). Use to reason about whether/how a dataset can be obtained.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
      }},
      { type: 'function', function: {
        name: 'get_citation',
        description: 'Get the deterministic citation/attribution for ONE dataset (authors/year/name/DOI) + source URL. Use to ground provenance in a report.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
      }},
      { type: 'function', function: {
        name: 'inventory_files',
        description: 'Inventory the files in a LOCAL retrieved/cached sample directory (a dataset folder under data/samples). Returns the raw on-disk listing — each file\'s name, extension, detected type/format, and size in bytes — plus counts by type. Reports only what is on disk (it does NOT judge fitness or quality). Detected types include empty (0 bytes) and corrupted (extension/content mismatch).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'local directory, e.g. data/samples/PC-Urban' } }, required: ['path'] }
      }},
      { type: 'function', function: {
        name: 'detect_format',
        description: 'Detect the format of a LOCAL path (a single file OR a sample directory) by magic bytes + extension: png/jpeg/ply/coco/json/csv/text, plus empty (0 bytes) and corrupted (extension vs content/magic mismatch). For a directory it also returns the set of formats, a modality guess, and the annotation format (e.g. coco). Observation only — no quality verdict.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'local file or directory under data/samples' } }, required: ['path'] }
      }},
      { type: 'function', function: {
        name: 'resolve_url',
        description: 'Classify a URL\'s scheme and host DETERMINISTICALLY, WITHOUT contacting the network. Returns scheme, host, whether it is a DOI (+prefix), the repository kind (github/zenodo/figshare/ieee_dataport/…), and an access class (open | registration_required | gated | restricted | unknown) derived from the host. It does NOT check liveness (HTTP 200 vs 404).',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }},
      { type: 'function', function: {
        name: 'submit_answer',
        description: 'Declare your final answer and finish. selected_ids = dataset ids that satisfy the need (empty if none). For a single-dataset fitness question, also set fitness_verdict. For a multi-dataset COMPARISON / "rank these" / "which is best among N" task, also set ranking = the dataset ids ordered best→worst. Set abstained=true when no dataset in the catalog fits.',
        parameters: { type: 'object', properties: {
          selected_ids: { type: 'array', items: { type: 'string' } },
          ranking: { type: 'array', items: { type: 'string' }, description: 'ordered dataset ids best->worst (comparison/Category-E tasks)' },
          fitness_verdict: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['fit', 'unfit'] } } },
          abstained: { type: 'boolean' }
        }, required: ['selected_ids', 'abstained'] }
      }}
    ];

    function dispatch(name, args) {
      args = args || {};
      if (name === 'list_tasks') return { tasks: taskList, modalities: modalityIds };
      if (name === 'search_datasets') {
        var need = needFrom(args); need.raw = args.query || '';
        var ranked = api.c1Discovery(corpus, need);
        var limit = Math.min(args.limit || 15, 50);
        return { count: ranked.length, results: ranked.slice(0, limit).map(function (x) {
          return { id: x.rec.id, name: x.rec.name, modality: x.rec.modality, tasks: x.rec.tasksRaw, license: x.rec.license, license_class: x.rec.licenseClass, matched_facets: x.matched };
        }) };
      }
      if (name === 'get_dataset') {
        var rec = corpus.byId.get(norm(args.id));
        return rec ? api.c2Understand(rec) : { error: 'dataset not found', id: args.id };
      }
      if (name === 'check_fitness') {
        var r = corpus.byId.get(norm(args.id));
        if (!r) return { error: 'dataset not found', id: args.id };
        var f = api.c3Fitness(r, needFrom(args));
        return { id: r.id, verdict: f.verdict, criteria: f.criteria.map(function (c) { return { key: c.key, required: c.required, pass: c.pass, evidence: c.evidence }; }) };
      }
      if (name === 'check_license') {
        var lr = corpus.byId.get(norm(args.id));
        if (!lr) return { error: 'dataset not found', id: args.id };
        return { id: lr.id, license: lr.license, commercial_ok: lr.rights.commercial_ok, derivatives_ok: lr.rights.derivatives_ok,
                 share_alike: lr.rights.share_alike, attribution: lr.rights.attribution, cls: lr.rights.cls };
      }
      if (name === 'validate_metadata') {
        var v = corpus.byId.get(norm(args.id));
        if (!v) return { error: 'dataset not found', id: args.id };
        var checks = [];
        function chk(field, ok, detail) { checks.push({ field: field, status: ok ? 'ok' : 'missing', detail: detail }); }
        chk('tasks', v.tasksRaw.length > 0, v.tasksRaw.join(', '));
        chk('modality', v.modality.length > 0, v.modalityRaw || '(unparseable -> no bucket)');
        chk('annotation', v.annotationRaw.length > 0, v.annotationRaw.join(', '));
        chk('license', v.rights.cls !== 'unknown', v.license + ' (' + v.rights.cls + ')');
        chk('provenance', !!(v.doi || v.paper), (v.doi || v.paper || 'none'));
        chk('scale', v.numImages != null || v.numClasses != null, 'images=' + v.numImages + ' classes=' + v.numClasses);
        chk('access', !!v.access, v.access || 'none');
        var conflicts = [];
        if (v.numClasses != null && v.classes.length && v.numClasses !== v.classes.length)
          conflicts.push({ field: 'num_classes', detail: 'num_classes=' + v.numClasses + ' but classes[] has ' + v.classes.length });
        if (v.modalityRaw && v.modality.length === 0)
          conflicts.push({ field: 'modality', detail: 'raw "' + v.modalityRaw + '" matched no bucket' });
        var okCount = checks.filter(function (c) { return c.status === 'ok'; }).length;
        return { id: v.id, checks: checks, conflicts: conflicts, completeness: +(okCount / checks.length).toFixed(3) };
      }
      if (name === 'compare_resources') {
        if (!comparer) return { error: 'comparison module not loaded' };
        var recs = arr(args.ids).map(function (id) { return corpus.byId.get(norm(id)); }).filter(Boolean);
        if (recs.length < 1) return { error: 'no valid dataset ids', ids: args.ids };
        return comparer.compareTable(recs, needFrom(args), { forAgent: true });  // evidence only — no weights/total/winner
      }
      if (name === 'recommend_benchmark') {
        if (!benchmarkResults || !Array.isArray(benchmarkResults.benchmarks))
          return { error: 'benchmark-results not loaded', contract: { matches: [{ id: '', name: '', task: '', dataset_id: '', primary_metric: '', best: { method: '', value: null }, source_url: '' }] } };
        var wantTaskIds = args.task ? api.canonTaskIds(args.task) : null;
        var matches = benchmarkResults.benchmarks.filter(function (b) {
          if (args.dataset_id && norm(b.dataset_id) === norm(args.dataset_id)) return true;
          if (wantTaskIds) { var bIds = api.canonTaskIds(b.task || ''); return wantTaskIds.some(function (n) { return bIds.some(function (d) { return api.taskIdMatch(n, d); }); }); }
          return !args.task && !args.dataset_id; // no filter -> list all
        }).map(function (b) {
          var pk = b.primary_metric_key, rows = Array.isArray(b.results) ? b.results : [];
          // G2.1 R1: respect the metric DIRECTION — for rmse/error/loss/distance (lower-is-better) the
          // best method is the MIN, not the MAX. Use the primary column's `direction`; fall back to the
          // metric-name heuristic if a column is missing.
          var cols = Array.isArray(b.metric_columns) ? b.metric_columns : [];
          var col = null; cols.forEach(function (c) { if (c.key === pk) col = c; });
          var lower = col ? (col.direction === 'lower') : /rmse|mae|mse|error|loss|distance|latency|wer|cer|perplexity/i.test(pk || '');
          var best = null;
          rows.forEach(function (r) {
            var val = r.metrics && r.metrics[pk];
            if (val == null) return;
            if (!best || (lower ? val < best.value : val > best.value)) best = { method: r.method, value: val };
          });
          return { id: b.id, name: b.name, task: b.task, dataset_id: b.dataset_id, primary_metric: pk, primary_metric_direction: lower ? 'lower' : 'higher', n_methods: rows.length, best: best, source_url: b.source_url };
        });
        return { count: matches.length, matches: matches };
      }
      if (name === 'check_access') {
        var ar = corpus.byId.get(norm(args.id));
        if (!ar) return { error: 'dataset not found', id: args.id };
        return { id: ar.id, access_status: api.classifyAccess(ar), evidence: ar.access || null };
      }
      if (name === 'get_citation') {
        var cr = corpus.byId.get(norm(args.id));
        if (!cr) return { error: 'dataset not found', id: args.id };
        var c = api.citation(cr);
        return { id: cr.id, citation: c.text, source_url: c.source_url, doi: c.doi, authors: cr.authors || null, year: cr.year || null };
      }
      if (name === 'inventory_files') {
        if (!_fs) return { error: 'filesystem not available in this environment', path: args.path };
        var rp = resolveSamplePath(baseDir, samplesRoot, args.path);
        if (rp.error) return { error: rp.error, path: args.path };
        var ist; try { ist = _fs.statSync(rp.abs); } catch (e) { return { error: 'path not found', path: args.path }; }
        if (!ist.isDirectory()) return { error: 'inventory_files expects a directory (use detect_format for a single file)', path: args.path };
        var files = [], counts = {};
        walkFiles(rp.abs).forEach(function (f) {
          var buf; try { buf = _fs.readFileSync(f.abs); } catch (e) { buf = Buffer.alloc(0); }
          var c = classifyFileFormat(f.rel, buf);
          // task contract {name,ext,type,size_bytes} + GT-shape aliases {format,bytes} (one object satisfies both)
          files.push({ name: f.rel, ext: c.ext, type: c.format, size_bytes: c.size_bytes, format: c.format, bytes: c.size_bytes });
          counts[c.format] = (counts[c.format] || 0) + 1;
        });
        return { path: args.path, file_count: files.length, files: files, counts_by_type: counts, by_format: counts };
      }
      if (name === 'detect_format') {
        if (!_fs) return { error: 'filesystem not available in this environment', path: args.path };
        var dp = resolveSamplePath(baseDir, samplesRoot, args.path);
        if (dp.error) return { error: dp.error, path: args.path };
        var dst; try { dst = _fs.statSync(dp.abs); } catch (e) { return { error: 'path not found', path: args.path }; }
        if (dst.isFile()) {
          var fb; try { fb = _fs.readFileSync(dp.abs); } catch (e) { fb = Buffer.alloc(0); }
          var cf = classifyFileFormat(_path.basename(dp.abs), fb);
          return { path: args.path, target: 'file', format: cf.format, magic: cf.magic, ext: cf.ext, size_bytes: cf.size_bytes,
                   modality_guess: guessModality([cf.format]), annotation_format: guessAnnotationFormat([cf.format], [cf.ext]), formats: [cf.format] };
        }
        var dfmts = [], dexts = [];
        walkFiles(dp.abs).forEach(function (f) { var b; try { b = _fs.readFileSync(f.abs); } catch (e) { b = Buffer.alloc(0); } var c = classifyFileFormat(f.rel, b); dfmts.push(c.format); dexts.push(c.ext); });
        var uniq = dfmts.filter(function (v, i) { return dfmts.indexOf(v) === i; }).sort();
        return { path: args.path, target: 'dir', formats: uniq, modality_guess: guessModality(dfmts), annotation_format: guessAnnotationFormat(dfmts, dexts) };
      }
      if (name === 'resolve_url') { return api.classifyUrl ? api.classifyUrl(args.url) : { error: 'classifyUrl unavailable (update data-agent.js)' }; }
      if (name === 'submit_answer') {
        return { _final: true, selected_ids: arr(args.selected_ids), ranking: arr(args.ranking), fitness_verdict: args.fitness_verdict || null, abstained: !!args.abstained };
      }
      return { error: 'unknown tool: ' + name };
    }

    return { schemas: schemas, dispatch: dispatch, taskList: taskList, modalityIds: modalityIds,
             toolNames: schemas.map(function (s) { return s.function.name; }) };
  }

  // Export the pure TF2 file classifier for reuse. (classifyUrl now lives in data-agent.js — one rulebook.)
  var API = { createTools: createTools, classifyFileFormat: classifyFileFormat };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCAgentTools = API;
})();
