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

  // api = window.OCDataAgent / require('data-agent.js'); corpus = api.buildCorpus(...); taxonomy = the loaded agent-taxonomy.json
  // opts = { benchmarkResults?: <parsed data/benchmark-results.json> } (for recommend_benchmark)
  function createTools(api, corpus, taxonomy, opts) {
    opts = opts || {};
    var benchmarkResults = opts.benchmarkResults || null;
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
      if (name === 'submit_answer') {
        return { _final: true, selected_ids: arr(args.selected_ids), ranking: arr(args.ranking), fitness_verdict: args.fitness_verdict || null, abstained: !!args.abstained };
      }
      return { error: 'unknown tool: ' + name };
    }

    return { schemas: schemas, dispatch: dispatch, taskList: taskList, modalityIds: modalityIds,
             toolNames: schemas.map(function (s) { return s.function.name; }) };
  }

  var API = { createTools: createTools };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCAgentTools = API;
})();
