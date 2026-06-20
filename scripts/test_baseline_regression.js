// OC_DATA_1 — G1.5 regression test. FAILS (exit 1) when the taxonomy, the golden set,
// or the engine drifts away from the blessed v1 baseline. Run in CI:  node scripts/test_baseline_regression.js
// To RE-BLESS after an intentional change: re-run run_baseline.js --write, review, then update LOCK below.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data');
const rd = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));

// ---- baseline lock ----
// PENDING_REBASELINE: golden set is now v1.2 (exact+descendant GT, OC round-4) but the engine
// `related`-clause fix is NOT yet landed. Structural invariants are locked to v1.2 NOW
// (deterministic, engine-independent); the 6 METRIC locks are SUSPENDED until the engine fix
// lands and OC_DATA_1 re-baselines + re-blesses (next turn). When re-blessing: set
// PENDING_REBASELINE=false and fill metrics from run_baseline.js --write.
const PENDING_REBASELINE = true;
const LOCK = {
  metrics: { /* re-bless after engine related-fix */ },
  structure: { cases: 144, k: 5, taxonomy_commercial_ok: 78, modality_buckets: 15,
               fitness_total: 44, fitness_positives: 22, fitness_negatives: 22 }
};

const tax = rd('agent-taxonomy.json'), datasets = rd('datasets.json'), golden = rd('data-agent-goldenset.json');
const fails = [];
const eq = (name, got, want) => { if (got !== want) fails.push(`${name}: got ${got}, expected ${want}`); };

// structural invariants (catch taxonomy / golden-set drift directly)
eq('taxonomy.commercial_ok', tax.license_rights.summary.commercial_ok, LOCK.structure.taxonomy_commercial_ok);
eq('taxonomy.modality_buckets', tax.modality_buckets.buckets.length, LOCK.structure.modality_buckets);
eq('golden.cases', golden.cases.length, LOCK.structure.cases);
eq('golden.k', golden.k, LOCK.structure.k);
const fitCases = golden.cases.filter(c => c.fitnessExpect);
eq('golden.fitness_total', fitCases.length, LOCK.structure.fitness_total);
eq('golden.fitness_positives', fitCases.filter(c => c.fitnessExpect.verdict === 'fit').length, LOCK.structure.fitness_positives);
eq('golden.fitness_negatives', fitCases.filter(c => c.fitnessExpect.verdict === 'unfit').length, LOCK.structure.fitness_negatives);
// every expect-id / fitness-id must exist in the catalog (no orphan GT)
const ids = new Set(Object.entries(datasets).map(([k, v]) => (v.id || k)));
const orphan = [];
golden.cases.forEach(c => { (c.expect || []).forEach(e => { if (!ids.has(e)) orphan.push(e); });
  if (c.fitnessExpect && !ids.has(c.fitnessExpect.datasetId)) orphan.push(c.fitnessExpect.datasetId); });
if (orphan.length) fails.push(`golden orphan ids (not in catalog): ${orphan.slice(0, 5).join(', ')}${orphan.length > 5 ? '…' : ''}`);

// engine metrics (catch engine drift) — SUSPENDED while PENDING_REBASELINE
API.setTaxonomy(tax);
const res = API.benchmarkOn(API.buildCorpus(datasets), golden);
if (PENDING_REBASELINE) {
  console.log('⏳ PENDING_REBASELINE: golden set v1.2 (exact+descendant); engine `related`-fix not yet landed.');
  console.log('   current (pre-fix) metrics — informational only, NOT asserted:');
  console.log('   ', JSON.stringify({ precisionAtK: res.precisionAtK, ndcgAtK: res.ndcgAtK, fitnessAccuracy: res.fitnessAccuracy,
    licenseCorrectness: res.licenseCorrectness, abstentionCorrectness: res.abstentionCorrectness, hallucinationRate: res.hallucinationRate }));
} else {
  for (const [m, want] of Object.entries(LOCK.metrics)) eq(`metric.${m}`, res[m], want);
}

if (fails.length) { console.error('✗ BASELINE REGRESSION — drift detected:\n  - ' + fails.join('\n  - ') +
  '\n\nIf intentional: re-run run_baseline.js --write, review the new numbers, then update LOCK in this file.'); process.exit(1); }
console.log(`✓ structural invariants OK — taxonomy + golden set v1.2 (144 cases, fitness 22/22)${PENDING_REBASELINE ? ' [metrics pending re-bless]' : `; metrics blessed`}.`);
