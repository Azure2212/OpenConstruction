// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// agent.js — the agent loop + system prompt (B3). NL need -> the model calls tools -> we dispatch to
// the deterministic primitives -> feed results back -> repeat until the model calls submit_answer.
//
// Output contract (agreed with OC_DATA_1, so the benchmark grader can score it):
//   { selected_ids: [...], fitness_verdict?: {id, verdict}, abstained: bool }
//
// The LLM client is INJECTED (`llm.chat(messages, tools) -> {content, tool_calls, ...}`), so the whole
// loop runs headless in Node CI with a STUB client (no real model). Native `tool_calls` are primary;
// a lightweight text fallback parses a ```json {tool,args}``` block for local models that emit tool
// calls as text (LMStudio support varies).

(function () {
  'use strict';
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x != null && String(x).trim() !== ''; }) : (v == null || v === '' ? [] : [v]); }

  // FROZEN system prompt — versioned, used unchanged across models (7B / 32B / B1 LLM-only) so cross-model
  // comparisons differ only by the MODEL, not the prompt. It specifies OUTPUT FORMAT only — it never reveals
  // any answer / golden / ground truth. Do not edit without bumping SYSTEM_PROMPT_VERSION + re-baselining.
  var SYSTEM_PROMPT_VERSION = 'v1-frozen-2026-06-22';
  var SYSTEM_PROMPT = [
    'You are the OpenConstruction Data Agent. You act ONLY through the provided tools — never browse or',
    'invent data, and never output an id/value you did not get from a tool. Each task arrives as JSON;',
    'detect its type, gather evidence with the right tools, then call submit_answer EXACTLY ONCE with only',
    'the field(s) that task needs (always include abstained).',
    '',
    'TASK ROUTING (check in this order; the FIRST matching rule wins):',
    '1. FITNESS (input has fitness_target): this is ALWAYS a fitness task, even if need/k/q are also present.',
    '   Call check_fitness(id=fitness_target, need), then submit fitness_verdict={id,verdict}. A fitness task',
    '   MUST return fitness_verdict and MUST NOT return a discovery selection (no selected_ids).',
    '2. DISCOVERY (input has need + k, NO fitness_target, no candidate_ids): list_tasks -> search_datasets ->',
    '   check_fitness on candidates. submit selected_ids = every dataset that fits. If NONE fit, submit',
    '   selected_ids=[] and abstained=true. A dataset fits a TASK only if it declares that task or a descendant.',
    '3. COMPARISON (input has candidate_ids): compare_resources(ids=candidate_ids, need) -> weigh the per-criterion',
    '   evidence yourself. submit ranking = candidate ids ordered best->worst (and selected_ids=[best]).',
    '4. ACCESS (input has dataset_id + evidence): check_access + check_license on the id. submit access_status',
    '   and commercial_ok.',
    '5. RETRIEVE (input has path + subtype inventory|format-detection|annotation-format): inventory ->',
    '   inventory_files(path), submit inventory={file_count,by_format}; format-detection -> detect_format(path),',
    '   submit format=its format; annotation-format -> detect_format(path), submit format=its annotation_format.',
    '6. PROFILE (input has path + subtype numeric-profile|tool-selection|edge-case): for numeric-profile pick',
    '   the modality profiler (profile_pointcloud|profile_images|profile_table; an image+COCO set merges',
    '   profile_images with profile_annotations) and submit profile=that object; for tool-selection submit',
    '   tools=the profiler name(s) (use detect_format.recommended_profiler/recommended_annotation_profiler);',
    '   for edge-case submit result=detect_format format (file) or modality_guess (dir).',
    '7. PREP (input has subtype annotation-conversion|dataset-split|annotation-validity): conversion ->',
    '   convert_annotations(path=data/samples/<source>, to=target), submit annotations=its annotations;',
    '   dataset-split -> create_dataset_split(items, ratios, seed), submit splits=its splits; annotation-validity',
    '   -> convert_annotations(... to=coco) on the source (or inline coco), submit valid=its valid.',
    '',
    'OUTPUT CONTRACT (format rules — apply to EVERY task, regardless of the answer):',
    '- abstained=true REQUIRES selected_ids=[] (and ranking=[]). Never set abstained=true while returning any ids.',
    '- If selected_ids is non-empty, abstained MUST be false. (no "abstain + ids" contradiction)',
    '- A fitness task (input has fitness_target) MUST include fitness_verdict={id,verdict} and no discovery selection.',
    '- Submit ONLY the field(s) the task needs; leave the others unset.',
    '',
    'Be deterministic and precise: only report what the tools returned; do not pad, guess, or fabricate.'
  ].join('\n');

  // Fallback: extract a tool call emitted as text (```json {"tool":"x","args":{...}}``` or {"name","arguments"}).
  function parseTextToolCalls(content) {
    if (!content) return null;
    var m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    var blob = m ? m[1] : content;
    try {
      var o = JSON.parse(blob.trim());
      var name = o.tool || o.name || (o.function && o.function.name);
      var args = o.args || o.arguments || (o.function && o.function.arguments) || {};
      if (!name) return null;
      return [{ id: 'text_' + Date.now(), type: 'function', function: { name: name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }];
    } catch (e) { return null; }
  }

  function normalizeAnswer(a) {
    a = a || {};
    return { selected_ids: arr(a.selected_ids), ranking: arr(a.ranking), fitness_verdict: a.fitness_verdict || null, abstained: !!a.abstained,
      // task-specific result fields read by the existing graders (B/C/D/F); null when not part of this task
      access_status: a.access_status != null ? a.access_status : null, commercial_ok: (a.commercial_ok === undefined ? null : a.commercial_ok),
      inventory: a.inventory || null, format: a.format != null ? a.format : null,
      profile: a.profile || null, tools: a.tools || null, result: a.result != null ? a.result : null,
      annotations: a.annotations != null ? a.annotations : null, splits: a.splits || null, valid: (a.valid === undefined ? null : a.valid) };
  }

  // deps: { api, corpus, taxonomy, llm, tools?, maxSteps?, systemPrompt? }
  function createAgent(deps) {
    var api = deps.api;
    var tools = deps.tools || (typeof require !== 'undefined' ? require('./agent-tools.js') : window.OCAgentTools).createTools(api, deps.corpus, deps.taxonomy, { benchmarkResults: deps.benchmarkResults });
    // v2 loop (opt-in via deps.loopVersion='v2'): near-budget submit-nudge + higher step budget + shortlist
    // floor. Pure loop mechanics — the SYSTEM_PROMPT (v1-frozen) is unchanged, and v1 behaviour is identical
    // when loopVersion!='v2'. Generic/query-agnostic: the floor returns the agent's OWN search_datasets ranking.
    var V2 = deps.loopVersion === 'v2';
    // v2 default budget = 12 as a CAPACITY BOUND (not metric argmax): a worst-case discovery flow is
    // list_tasks(1) + search_datasets(1) + ~6 check_fitness on candidates + submit_answer(1) + slack ~= 12.
    // (Phase-2 sweep happened to peak at 12 too, but the default is set by capacity, not by that score.)
    var maxSteps = deps.maxSteps || (V2 ? 12 : 8);
    var sys = deps.systemPrompt || SYSTEM_PROMPT;

    async function run(input) {
      var userText = typeof input === 'string' ? input : JSON.stringify(input);
      var messages = [{ role: 'system', content: sys }, { role: 'user', content: userText }];
      var trace = [];
      var usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
      var confirmedFit = [];                                           // v2 (Critic protocol): ONLY ids whose check_fitness verdict==='fit' — the sole floor source (NO raw search top-K)
      var submitNudged = false;                                         // v2: fire the near-budget submit nudge once
      var K = (input && typeof input === 'object' && input.k) || 8;     // v2: floor size = requested k
      // v2 floor: return the datasets the agent ITSELF confirmed fit, and only when >=1 exists. With 0
      // confirmed-fit the caller keeps the abstain path — never fabricate a selection.
      function floorAnswer(stepN) {
        var ids = confirmedFit.slice(0, K);
        return { answer: { selected_ids: ids, ranking: ids, abstained: false, _fallback: 'confirmed-fit-floor', floor_fired: true }, selected_ids: ids, ranking: ids, trace: trace, steps: stepN, ok: true, reason: 'confirmed-fit-floor', floor_fired: true, usage: usage };
      }

      for (var step = 0; step < maxSteps; step++) {
        var resp = await deps.llm.chat(messages, tools.schemas);
        usage.calls++;
        if (resp.usage) { usage.prompt_tokens += resp.usage.prompt_tokens || 0; usage.completion_tokens += resp.usage.completion_tokens || 0; }
        var toolCalls = resp.tool_calls || parseTextToolCalls(resp.content);

        // record the assistant turn
        var asst = { role: 'assistant', content: resp.content || '' };
        if (resp.tool_calls) asst.tool_calls = resp.tool_calls;
        messages.push(asst);

        if (!toolCalls || !toolCalls.length) {
          // no tool call: nudge once to force a submit, else stop
          if (!run._nudged) { run._nudged = true; messages.push({ role: 'user', content: 'Please finish by calling submit_answer with your result.' }); continue; }
          if (V2 && confirmedFit.length) return floorAnswer(step + 1);   // v2: floor ONLY if >=1 confirmed-fit, else abstain below
          return { answer: { selected_ids: [], ranking: [], abstained: true, _incomplete: true }, selected_ids: [], ranking: [], trace: trace, steps: step + 1, ok: false, reason: 'no tool call', usage: usage };
        }

        var submitted = null;
        for (var i = 0; i < toolCalls.length; i++) {
          var tc = toolCalls[i];
          var name = tc.function.name;
          var args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }
          trace.push({ step: step, tool: name, args: args });
          var result = tools.dispatch(name, args);
          if (name === 'submit_answer') submitted = normalizeAnswer(result);
          if (V2 && name === 'check_fitness' && result && result.verdict === 'fit' && confirmedFit.indexOf(result.id) < 0) confirmedFit.push(result.id);  // v2 floor source = confirmed fits only
          // feed tool result back (truncate big payloads in the message, keep full in trace)
          messages.push({ role: 'tool', tool_call_id: tc.id || ('tc_' + step + '_' + i), name: name, content: JSON.stringify(result).slice(0, 6000) });
        }
        if (submitted) { run._nudged = false; return { answer: submitted, selected_ids: submitted.selected_ids, ranking: submitted.ranking, trace: trace, steps: step + 1, ok: true, usage: usage }; }
        // v2: when the budget is nearly spent, force a submit on the NEXT turn even if the model keeps calling tools.
        if (V2 && !submitNudged && step >= maxSteps - 2) {
          submitNudged = true;
          messages.push({ role: 'user', content: 'You are almost out of steps. Call submit_answer NOW with your best selected_ids (every dataset you have confirmed fits), or abstain only if none fit. Do not call any other tool.' });
        }
      }
      if (V2 && confirmedFit.length) return floorAnswer(maxSteps);   // v2: floor ONLY if >=1 confirmed-fit, else abstain below
      return { answer: { selected_ids: [], ranking: [], abstained: true, _incomplete: true }, selected_ids: [], ranking: [], trace: trace, steps: maxSteps, ok: false, reason: 'max steps', usage: usage };
    }
    run._nudged = false;
    return { run: run, tools: tools, systemPrompt: sys };
  }

  var API = { createAgent: createAgent, SYSTEM_PROMPT: SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION: SYSTEM_PROMPT_VERSION, parseTextToolCalls: parseTextToolCalls, normalizeAnswer: normalizeAnswer };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCAgent = API;
})();
