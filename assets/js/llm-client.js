// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// llm-client.js — provider-agnostic, OpenAI-compatible chat client (B1).
//
// Works against LMStudio (local) OR any cloud OpenAI-compatible endpoint, selected purely by config
// {baseUrl, model, temperature, max_tokens, apiKey?}. baseUrl includes the /v1 suffix
// (e.g. http://localhost:19234/v1). Uses Node's `http`/`https` (this machine is **Node 16 — no global
// fetch**). Reasoning-model aware: returns both `content` and `tool_calls` (and `reasoning` if present),
// default max_tokens >= 1500 so a thinking model has room before the tool call.
//
// Pure helpers (buildRequestBody / parseChatResponse) are exported so CI can unit-test request/response
// shaping WITHOUT a live model. The agent loop takes a client as an injected dependency, so the whole
// harness runs headless in Node with a STUB client.

(function () {
  'use strict';
  var DEFAULTS = { temperature: 0, max_tokens: 1500 };

  // Build an OpenAI /chat/completions request body. tools omitted when none (some servers 400 on []).
  function buildRequestBody(cfg, messages, tools) {
    var body = {
      model: cfg.model,
      messages: messages,
      temperature: (cfg.temperature != null ? cfg.temperature : DEFAULTS.temperature),
      max_tokens: (cfg.max_tokens || DEFAULTS.max_tokens),
      stream: false
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = cfg.tool_choice || 'auto'; }
    return body;
  }

  // Normalize one OpenAI-compatible response into {content, reasoning, tool_calls, finish_reason, usage}.
  // Handles reasoning models that put chain-of-thought in `reasoning`/`reasoning_content` and may emit
  // tool_calls alongside (or instead of) content.
  function parseChatResponse(json) {
    var choice = (json && json.choices && json.choices[0]) || {};
    var m = choice.message || {};
    var tc = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : null;
    return {
      content: m.content || '',
      reasoning: m.reasoning_content || m.reasoning || '',
      tool_calls: tc,
      finish_reason: choice.finish_reason || null,
      usage: (json && json.usage) || null,
      raw: json
    };
  }

  function createClient(cfg) {
    if (!cfg || !cfg.baseUrl || !cfg.model) throw new Error('llm-client: config needs {baseUrl, model}');
    var http = require('http'), https = require('https');
    var endpoint = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    function chat(messages, tools) {
      return new Promise(function (resolve, reject) {
        var body = JSON.stringify(buildRequestBody(cfg, messages, tools));
        var u = new URL(endpoint);
        var lib = u.protocol === 'https:' ? https : http;
        var headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
        var req = lib.request(
          { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: headers, timeout: cfg.timeout_ms || 120000 },
          function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
              if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('llm-client HTTP ' + res.statusCode + ': ' + data.slice(0, 300))); return; }
              try { resolve(parseChatResponse(JSON.parse(data))); }
              catch (e) { reject(new Error('llm-client parse error: ' + e.message + ' | body=' + data.slice(0, 300))); }
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('llm-client timeout after ' + (cfg.timeout_ms || 120000) + 'ms')); });
        req.write(body); req.end();
      });
    }
    // OpenAI-compatible embeddings (POST /embeddings). For the RAG-dense baseline (LM Studio
    // `text-embedding-nomic`). input = string | string[]; resolves to number[][] aligned to input order.
    // model defaults to cfg.embedModel (fall back to cfg.model). Only invoked when the tunnel is up — never in CI.
    function embed(input, modelOverride) {
      var arrInput = Array.isArray(input) ? input : [input];
      var ep = cfg.baseUrl.replace(/\/+$/, '') + '/embeddings';
      return new Promise(function (resolve, reject) {
        var body = JSON.stringify({ model: modelOverride || cfg.embedModel || cfg.model, input: arrInput });
        var u = new URL(ep), lib = u.protocol === 'https:' ? https : http;
        var headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
        var req = lib.request(
          { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: headers, timeout: cfg.timeout_ms || 120000 },
          function (res) {
            var data = ''; res.on('data', function (c) { data += c; });
            res.on('end', function () {
              if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('llm-client/embed HTTP ' + res.statusCode + ': ' + data.slice(0, 300))); return; }
              try { var j = JSON.parse(data); resolve((j.data || []).map(function (d) { return d.embedding; })); }
              catch (e) { reject(new Error('llm-client/embed parse error: ' + e.message + ' | body=' + data.slice(0, 300))); }
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('llm-client/embed timeout after ' + (cfg.timeout_ms || 120000) + 'ms')); });
        req.write(body); req.end();
      });
    }
    return { chat: chat, embed: embed, cfg: cfg };
  }

  // Load a gitignored config file; throws a helpful message if absent (CI/stub never needs it).
  function loadConfig(path) {
    var fs = require('fs');
    if (!fs.existsSync(path)) throw new Error('llm-client: config not found at ' + path + ' (copy .llm-config.example.json -> .llm-config.json; it is gitignored)');
    var cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (cfg.temperature == null) cfg.temperature = DEFAULTS.temperature;
    if (!cfg.max_tokens) cfg.max_tokens = DEFAULTS.max_tokens;
    return cfg;
  }

  var API = { createClient: createClient, buildRequestBody: buildRequestBody, parseChatResponse: parseChatResponse, loadConfig: loadConfig, DEFAULTS: DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.OCLLMClient = API;
})();
