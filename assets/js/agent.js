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

  var SYSTEM_PROMPT = [
    'You are the OpenConstruction Data Agent. You help a user find AEC datasets in a fixed catalog by',
    'reasoning ONLY over dataset metadata via the provided tools. You cannot browse or invent data.',
    '',
    'Rules:',
    '1. Use the tools to discover and verify. Typical flow: list_tasks (to phrase the task) -> search_datasets',
    '   -> get_dataset / check_fitness on promising candidates -> decide.',
    '2. NEVER output a dataset id you did not see returned by a tool. No fabrication.',
    '3. A dataset fits a TASK only if it declares that task or a more specific (descendant) task.',
    '4. When done, call submit_answer exactly once:',
    '   - discovery need -> selected_ids = every dataset that fits (may be many); abstained=false.',
    '   - single-dataset fitness question -> set fitness_verdict={id,verdict} (fit|unfit).',
    '   - multi-dataset COMPARISON / "rank these" / "which is best among N" -> also set ranking =',
    '     the dataset ids ordered best->worst, and set selected_ids to the best one(s).',
    '   - if NO dataset in the catalog fits the need -> selected_ids=[], abstained=true.',
    '5. Prefer precision: only include datasets you verified fit. Do not pad the list.'
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
    return { selected_ids: arr(a && a.selected_ids), ranking: arr(a && a.ranking), fitness_verdict: (a && a.fitness_verdict) || null, abstained: !!(a && a.abstained) };
  }

  // deps: { api, corpus, taxonomy, llm, tools?, maxSteps?, systemPrompt? }
  function createAgent(deps) {
    var api = deps.api;
    var tools = deps.tools || (typeof require !== 'undefined' ? require('./agent-tools.js') : window.OCAgentTools).createTools(api, deps.corpus, deps.taxonomy, { benchmarkResults: deps.benchmarkResults });
    var maxSteps = deps.maxSteps || 8;
    var sys = deps.systemPrompt || SYSTEM_PROMPT;

    async function run(input) {
      var userText = typeof input === 'string' ? input : JSON.stringify(input);
      var messages = [{ role: 'system', content: sys }, { role: 'user', content: userText }];
      var trace = [];
      var usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };

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
          // feed tool result back (truncate big payloads in the message, keep full in trace)
          messages.push({ role: 'tool', tool_call_id: tc.id || ('tc_' + step + '_' + i), name: name, content: JSON.stringify(result).slice(0, 6000) });
        }
        if (submitted) { run._nudged = false; return { answer: submitted, selected_ids: submitted.selected_ids, ranking: submitted.ranking, trace: trace, steps: step + 1, ok: true, usage: usage }; }
      }
      return { answer: { selected_ids: [], ranking: [], abstained: true, _incomplete: true }, selected_ids: [], ranking: [], trace: trace, steps: maxSteps, ok: false, reason: 'max steps', usage: usage };
    }
    run._nudged = false;
    return { run: run, tools: tools, systemPrompt: sys };
  }

  var API = { createAgent: createAgent, SYSTEM_PROMPT: SYSTEM_PROMPT, parseTextToolCalls: parseTextToolCalls, normalizeAnswer: normalizeAnswer };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCAgent = API;
})();
