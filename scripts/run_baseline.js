// OC_DATA_1 — G1.5 official v1 baseline runner (Node/CI, no fetch).
// Runs the WIRED engine (assets/js/data-agent.js) on the committed v1.1 golden set.
// Usage: node scripts/run_baseline.js [--write]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data');
const rd = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));

const tax = rd('agent-taxonomy.json'), datasets = rd('datasets.json'), golden = rd('data-agent-goldenset.json');
API.setTaxonomy(tax);
const corpus = API.buildCorpus(datasets);
const res = API.benchmarkOn(corpus, golden);

// headline metrics
const M = {
  precisionAtK: res.precisionAtK, ndcgAtK: res.ndcgAtK, fitnessAccuracy: res.fitnessAccuracy,
  licenseCorrectness: res.licenseCorrectness, abstentionCorrectness: res.abstentionCorrectness,
  hallucinationRate: res.hallucinationRate
};
console.log('=== OFFICIAL v1 BASELINE (golden v1.1, engine abd3376) ===');
console.log('k =', res.k, '| cases =', res.cases, '| counts =', JSON.stringify(res.counts));
console.log(JSON.stringify(M, null, 2));

// fitness diagnosis: every mismatch, with reason
const fit = res.perCase.filter(p => p.family === 'fitness');
const mis = fit.filter(p => !p.ok);
console.log(`\n=== FITNESS: ${fit.length} cases, ${fit.length - mis.length} correct, ${mis.length} mismatches ===`);
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const byId = {}; for (const [k, v] of Object.entries(datasets)) byId[v.id || k] = v;
for (const p of mis) {
  const raw = (byId[p.dataset] || {}).potential_tasks || [];
  console.log(`  ${p.dataset}: expected=${p.expected} got=${p.got}  rawTasks=${JSON.stringify(raw)}`);
}
// split fitness accuracy by fit vs unfit (expected)
const exFit = fit.filter(p => p.expected === 'fit'), exUnfit = fit.filter(p => p.expected === 'unfit');
const accFit = exFit.filter(p => p.ok).length / (exFit.length || 1);
const accUnfit = exUnfit.filter(p => p.ok).length / (exUnfit.length || 1);
console.log(`\n  fitness-acc on POSITIVES (expected fit):   ${exFit.filter(p=>p.ok).length}/${exFit.length} = ${accFit.toFixed(3)}`);
console.log(`  fitness-acc on NEGATIVES (expected unfit): ${exUnfit.filter(p=>p.ok).length}/${exUnfit.length} = ${accUnfit.toFixed(3)}`);

if (process.argv.includes('--write')) {
  const out = {
    _meta: {
      title: 'OpenConstruction Data Agent — official v1 reference baseline',
      owner: 'OC_DATA_1', generated: new Date().toISOString().slice(0, 10),
      engine_commit: 'abd3376', golden_set: 'data-agent-goldenset.json (v1.1, hard negatives)',
      taxonomy: 'agent-taxonomy.json', method: 'Node/CI, no fetch, no LLM-judge; scored on C4-selected',
      note: 'Reference rule-based agent. fitnessAccuracy reflects a SEMANTICS GAP on related-task near-misses: the engine taskIdMatch counts `related` tasks as fit, while the v1.1 GT counts related-only datasets as unfit. This is a measured divergence, not a bug to mask. See golden-set-audit-G1.3.md + baseline writeup.'
    },
    metrics: M, counts: res.counts, k: res.k, cases: res.cases,
    fitness_breakdown: { positives: { correct: exFit.filter(p=>p.ok).length, total: exFit.length, acc: +accFit.toFixed(3) },
                         negatives: { correct: exUnfit.filter(p=>p.ok).length, total: exUnfit.length, acc: +accUnfit.toFixed(3) } },
    perCase: res.perCase
  };
  fs.writeFileSync(path.join(DATA, 'benchmark-baseline-v1.json'), JSON.stringify(out, null, 2));
  console.log('\nWROTE data/benchmark-baseline-v1.json');
}
