// OC_DATA_1 — B4 stub-test for the agent-agnostic scoring adapter benchmarkAgent().
// No real model. Verifies: (1) the produce-hook refactor is behaviour-preserving (benchmarkOn
// 2-arg == blessed baseline v2); (2) ROUND-TRIP: feeding the baseline engine's own outputs through
// benchmarkAgent reproduces baseline v2 EXACTLY (so the G1.6 bless carries over); (3) hardcoded
// fake agents produce DISTINCT, sensible metrics (proves it scores AGENT output, not the engine).
// Run: node scripts/test_benchmark_agent.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data');
const rd = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const tax = rd('agent-taxonomy.json'), datasets = rd('datasets.json'), golden = rd('data-agent-goldenset.json');
API.setTaxonomy(tax);
const corpus = API.buildCorpus(datasets);
const BASE = { precisionAtK: 0.993, ndcgAtK: 0.996, fitnessAccuracy: 1, licenseCorrectness: 1, abstentionCorrectness: 0.96, hallucinationRate: 0 };
const M = r => ({ precisionAtK: r.precisionAtK, ndcgAtK: r.ndcgAtK, fitnessAccuracy: r.fitnessAccuracy, licenseCorrectness: r.licenseCorrectness, abstentionCorrectness: r.abstentionCorrectness, hallucinationRate: r.hallucinationRate });
const fails = [];
const eqMetrics = (name, got, want) => Object.keys(want).forEach(k => { if (got[k] !== want[k]) fails.push(`${name}.${k}: ${got[k]} != ${want[k]}`); });
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

// (1) behaviour-preserving refactor: benchmarkOn(corpus, golden) [2-arg] == blessed baseline v2
const engineRes = API.benchmarkOn(corpus, golden);
eqMetrics('benchmarkOn(2-arg)', M(engineRes), BASE);
console.log('(1) behaviour-preserving benchmarkOn :', JSON.stringify(M(engineRes)));

// (2) ROUND-TRIP: the baseline engine, expressed as an agent (contract output), through benchmarkAgent
function engineAsAgent(input) {
  const need = API.parseNeed(input.need); need.raw = input.q || '';
  if (input.fitness_target) {
    const r0 = corpus.byId.get(norm(input.fitness_target));
    return { fitness_verdict: { id: input.fitness_target, verdict: r0 ? API.c3Fitness(r0, need).verdict : 'missing' }, abstained: false };
  }
  const c1 = API.c1Discovery(corpus, need);
  const cmp = API.c4CompareSelect(c1.slice(0, Math.max(input.k, 8)), need);
  const c5 = API.c5Reliability(cmp, need, corpus);
  return { selected_ids: cmp.selected.slice(0, input.k).map(s => s.rec.id), abstained: c5.abstained };
}
const rt = API.benchmarkAgent(engineAsAgent, golden, corpus);
eqMetrics('benchmarkAgent(engine-replay)', M(rt), BASE);
console.log('(2) engine-replay via benchmarkAgent:', JSON.stringify(M(rt)), '| scoredOn=', rt.scoredOn);

// (3) hardcoded fake agents (output cứng) — must yield DISTINCT, sensible numbers
const ghostAgent     = () => ({ selected_ids: ['GHOST-NONEXISTENT-DATASET'], fitness_verdict: { verdict: 'fit' }, abstained: false });
const abstainAgent   = () => ({ selected_ids: [], fitness_verdict: { verdict: 'unfit' }, abstained: true });
const ghost   = M(API.benchmarkAgent(ghostAgent, golden, corpus));
const abst    = M(API.benchmarkAgent(abstainAgent, golden, corpus));
console.log('(3) ghostAgent   :', JSON.stringify(ghost));
console.log('(3) abstainAgent :', JSON.stringify(abst));
// ghost: every selection is a fabricated id -> hallucination 1.0, precision 0; verdict always 'fit' -> 22/44 right
assert(ghost.hallucinationRate === 1, 'ghost hallucinationRate should be 1, got ' + ghost.hallucinationRate);
assert(ghost.precisionAtK === 0, 'ghost precisionAtK should be 0, got ' + ghost.precisionAtK);
assert(ghost.fitnessAccuracy === 0.5, 'ghost fitnessAccuracy should be 0.5, got ' + ghost.fitnessAccuracy);
// abstain-always: selects nothing -> precision 0, no ids -> hallucination 0; verdict always 'unfit' -> 22/44 right
assert(abst.precisionAtK === 0, 'abstain precisionAtK should be 0, got ' + abst.precisionAtK);
assert(abst.hallucinationRate === 0, 'abstain hallucinationRate should be 0, got ' + abst.hallucinationRate);
assert(abst.fitnessAccuracy === 0.5, 'abstain fitnessAccuracy should be 0.5, got ' + abst.fitnessAccuracy);
// abstain-always abstains on everything: correct only on the true-abstain cases -> < engine's 0.96
assert(abst.abstentionCorrectness < BASE.abstentionCorrectness, 'abstain-always abstentionCorrectness should be < baseline');
// the fakes must differ from the engine baseline (proves it scores AGENT output)
assert(JSON.stringify(ghost) !== JSON.stringify(BASE) && JSON.stringify(abst) !== JSON.stringify(BASE), 'fake agents must not equal baseline');

if (fails.length) { console.error('\n✗ B4 ADAPTER TEST FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\n✓ B4 OK — benchmarkAgent shares the blessed metric math (round-trip == baseline v2) and scores arbitrary agent output by contract.');
