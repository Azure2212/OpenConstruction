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
  function createTools(api, corpus, taxonomy) {
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
        name: 'submit_answer',
        description: 'Declare your final answer and finish. selected_ids = dataset ids that satisfy the need (empty if none). For a single-dataset fitness question, also set fitness_verdict. Set abstained=true when no dataset in the catalog fits.',
        parameters: { type: 'object', properties: {
          selected_ids: { type: 'array', items: { type: 'string' } },
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
      if (name === 'submit_answer') {
        return { _final: true, selected_ids: arr(args.selected_ids), fitness_verdict: args.fitness_verdict || null, abstained: !!args.abstained };
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
