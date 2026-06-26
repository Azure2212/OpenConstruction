// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// repro_rerank.js — reproduce the Vercel proxy's LLM rerank step on a live vLLM 7B, using the EXACT deploy
// prompt (api/agent.js) + the EXACT same BM25 12-candidate shortlist, for two queries (keyword vs natural-
// language). Reports raw model output, whether parseRanking caught JSON, #ids parsed/resolved, and whether the
// floor would fire (rank empty -> BM25 top-8). Headless; needs --base <vLLM /v1>.  Same model id as the HF-router
// demo (Qwen2.5-7B-Instruct); difference noted in the report (HF-router serving vs OSC vLLM fp16).
//   node scripts/repro_rerank.js --base http://<node>:<port>/v1 [--model M]

var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var rag = require(path.join(ROOT, 'assets/js/rag-baseline.js'));
var LLM = require(path.join(ROOT, 'assets/js/llm-client.js'));
function argVal(f, d) { var i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; }
function ckey(id) { return String(id == null ? '' : id).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

var BASE = argVal('--base'); if (!BASE) { console.error('need --base'); process.exit(1); }
var MODEL = argVal('--model', 'Qwen2.5-7B-Instruct');
var client = LLM.createClient({ baseUrl: BASE, model: MODEL, temperature: 0, max_tokens: 512, timeout_ms: 120000 });

var tax = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(tax);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var lexIndex = rag.buildBM25Index(corpus, {});

// EXACT copy of api/agent.js parseRanking (deploy d4f746d/c0bcfad)
function parseRanking(txt) {
  var rank = [];
  try { var mm = String(txt).match(/\{[\s\S]*\}/); var pj = JSON.parse(mm ? mm[0] : txt); if (pj && pj.ranking) rank = pj.ranking; } catch (e) {}
  if (!rank.length) { var re = /"id"\s*:\s*"([^"]+)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?/g, x; while ((x = re.exec(String(txt)))) rank.push({ id: x[1], reason: x[2] || '' }); }
  return rank;
}
// EXACT copy of api/agent.js shortlist→candidate shape (oc-methods.js agentShortlist) + resolveId
function shortlist(q) {
  return rag.bm25Rank(lexIndex, q).slice(0, 12).map(function (r) {
    var rec = corpus.byId.get(ckey(r.id));
    return { id: r.id, name: rec && rec.name, modality: rec && rec.modalityRaw, tasks: (rec && rec.tasksRaw || []).slice(0, 3).join(', ') };
  });
}

(async function () {
  for (var qi = 0; qi < 2; qi++) {
    var query = ['object detection', 'I need a dataset for object detection'][qi];
    var cands = shortlist(query);
    var validIds = {}; cands.forEach(function (c) { validIds[ckey(c.id)] = c.id; if (c.name) validIds[ckey(c.name)] = c.id; });
    function tokMatch(h, n) { return n && (' ' + h + ' ').indexOf(' ' + n + ' ') >= 0; }
    function resolveId(s) { var k = ckey(s); if (!k) return null; if (validIds[k]) return validIds[k]; for (var i = 0; i < cands.length; i++) { var c = cands[i], ik = ckey(c.id), nk = ckey(c.name || ''); if (tokMatch(k, ik) || tokMatch(ik, k)) return c.id; if (nk && (tokMatch(k, nk) || tokMatch(nk, k))) return c.id; } return null; }
    var messages = [
      { role: 'system', content: 'You help engineers find AEC (architecture/engineering/construction) datasets. From the CANDIDATES (real catalog ids), pick the best matches for the QUERY, most relevant first. Reply ONLY with compact JSON {"ranking":[{"id":"<exact id from candidates>","reason":"<short>"}]}. Use only ids present in the candidates; never invent ids.' },
      { role: 'user', content: 'QUERY: ' + query + '\n\nCANDIDATES:\n' + cands.map(function (c) { return '- ' + c.id + (c.name ? (' | ' + c.name) : '') + (c.modality ? (' | ' + c.modality) : '') + (c.tasks ? (' | ' + c.tasks) : ''); }).join('\n') }
    ];
    console.log('\n================ QUERY (' + (qi === 0 ? 'a/keyword' : 'b/natural-language') + '): "' + query + '" ================');
    console.log('candidates (12):', cands.map(function (c) { return c.id; }).join(', '));
    var resp;
    try { resp = await client.chat(messages, undefined); } catch (e) { console.log('CHAT ERROR: ' + (e && e.message || e)); continue; }
    var content = resp.content || '';
    console.log('--- RAW model output (full) ---\n' + content + '\n--- end raw ---');
    var strictJSON = (function () { try { var mm = String(content).match(/\{[\s\S]*\}/); return !!(JSON.parse(mm ? mm[0] : content) || {}).ranking; } catch (e) { return false; } })();
    var rank = parseRanking(content);
    var seen = {}, resolved = [];
    rank.forEach(function (it) { var id = resolveId(it && it.id); if (id && !seen[ckey(id)]) { seen[ckey(id)] = 1; resolved.push(id); } });
    var floorFires = resolved.length === 0 && cands.length > 0;
    console.log('parseRanking caught JSON-with-ranking: ' + strictJSON + ' | rank entries: ' + rank.length + ' | resolved valid ids: ' + resolved.length);
    console.log('resolved ids: ' + (resolved.join(', ') || '(none)'));
    console.log('FLOOR FIRES? ' + floorFires + (floorFires ? ' -> returns BM25 top-8: ' + cands.slice(0, 8).map(function (c) { return c.id; }).join(', ') : ' -> agent returns ' + Math.min(resolved.length, 8) + ' LLM-selected'));
  }
})().catch(function (e) { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
