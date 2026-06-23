// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// api/agent.js — Vercel serverless proxy for the LLM-agent demo mode.
// Receives { query, candidates } (candidates = a BM25 shortlist of REAL catalog ids built on the
// frontend), asks a hosted OpenAI-compatible chat model to re-rank them, and returns
// { rows: [{ id, reason }], model }. The API key lives ONLY in the HF_API_KEY env var (never in code
// or the repo). CORS is restricted to the demo origins.
//
// Swap providers by editing PROVIDER below — the frontend never changes.

'use strict';

// ---- provider config (one place to change; e.g. switch to Groq if HF is flaky) ----
var PROVIDER = {
  name: 'huggingface',
  url: 'https://router.huggingface.co/v1/chat/completions',
  model: 'Qwen/Qwen2.5-7B-Instruct',   // same family as the OC-AgentBench scaling ladder
  apiKeyEnv: 'HF_API_KEY',
  // To use Groq instead: url 'https://api.groq.com/openai/v1/chat/completions',
  // model 'llama-3.1-8b-instant' (or a Qwen on Groq), apiKeyEnv 'GROQ_API_KEY'.
};
var REQUEST_TIMEOUT_MS = 25000;
var MAX_CANDIDATES = 20;

function allowedOrigin(origin) {
  if (!origin) return null;
  try {
    var h = new URL(origin).hostname;
    if (origin === 'https://azure2212.github.io') return origin;
    if (/(^|\.)vercel\.app$/.test(h)) return origin;
    if (/(^|\.)openconstruction\.org$/.test(h)) return origin;
    if (h === 'localhost' || h === '127.0.0.1') return origin;
  } catch (e) {}
  return null;
}
function setCors(req, res) {
  var o = allowedOrigin(req.headers && req.headers.origin) || 'https://azure2212.github.io';
  res.setHeader('Access-Control-Allow-Origin', o);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, code, obj) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); }
function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Robust parse: strict JSON first, then per-item {"id","reason"} extraction (small models emit fragile JSON).
function parseRanking(txt) {
  var rank = [];
  try { var mm = String(txt).match(/\{[\s\S]*\}/); var pj = JSON.parse(mm ? mm[0] : txt); if (pj && pj.ranking) rank = pj.ranking; } catch (e) {}
  if (!rank.length) { var re = /"id"\s*:\s*"([^"]+)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?/g, x; while ((x = re.exec(String(txt)))) rank.push({ id: x[1], reason: x[2] || '' }); }
  return rank;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') { return send(res, 405, { error: 'Method not allowed — use POST.' }); }

  var apiKey = process.env[PROVIDER.apiKeyEnv];
  if (!apiKey) { return send(res, 500, { error: 'Server is missing the ' + PROVIDER.apiKeyEnv + ' environment variable.' }); }

  // body may already be parsed (Vercel) or a raw string.
  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body.query !== 'string' || !Array.isArray(body.candidates)) {
    return send(res, 400, { error: 'Expected JSON { query: string, candidates: array }.' });
  }
  var query = body.query.trim().slice(0, 500);
  var cands = body.candidates.slice(0, MAX_CANDIDATES).map(function (c) {
    if (typeof c === 'string') return { id: c };
    return { id: String(c && c.id || ''), name: c && c.name, modality: c && c.modality, tasks: c && c.tasks };
  }).filter(function (c) { return c.id; });
  if (!query || !cands.length) { return send(res, 400, { error: 'query and candidates must be non-empty.' }); }
  var validIds = {}; cands.forEach(function (c) { validIds[ckey(c.id)] = c.id; });

  var messages = [
    { role: 'system', content: 'You help engineers find AEC (architecture/engineering/construction) datasets. From the CANDIDATES (real catalog ids), pick the best matches for the QUERY, most relevant first. Reply ONLY with compact JSON {"ranking":[{"id":"<exact id from candidates>","reason":"<short>"}]}. Use only ids present in the candidates; never invent ids.' },
    { role: 'user', content: 'QUERY: ' + query + '\n\nCANDIDATES:\n' + cands.map(function (c) { return '- ' + c.id + (c.name ? (' | ' + c.name) : '') + (c.modality ? (' | ' + c.modality) : '') + (c.tasks ? (' | ' + c.tasks) : ''); }).join('\n') }
  ];

  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    var r = await fetch(PROVIDER.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: PROVIDER.model, messages: messages, temperature: 0, max_tokens: 512, stream: false }),
      signal: ctrl ? ctrl.signal : undefined
    });
    var text = await r.text();
    clearTimeout(timer);
    if (!r.ok) { return send(res, 502, { error: 'Upstream model error (' + r.status + ').', detail: text.slice(0, 300) }); }
    var data; try { data = JSON.parse(text); } catch (e) { return send(res, 502, { error: 'Upstream returned non-JSON.' }); }
    var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    var rank = parseRanking(content);
    var seen = {}, rows = [];
    rank.forEach(function (it) { var k = ckey(it && it.id); if (validIds[k] && !seen[k]) { seen[k] = 1; rows.push({ id: validIds[k], reason: (it.reason || '').slice(0, 200) }); } });
    return send(res, 200, { rows: rows, model: PROVIDER.model, provider: PROVIDER.name });
  } catch (e) {
    clearTimeout(timer);
    var aborted = e && (e.name === 'AbortError');
    return send(res, aborted ? 504 : 502, { error: aborted ? 'Upstream model timed out.' : 'Proxy request failed.', detail: String(e && e.message || e).slice(0, 200) });
  }
};
