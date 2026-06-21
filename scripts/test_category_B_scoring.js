// OC_DATA_1 — stub test for Category-B metrics (no model). Verifies access-status-accuracy,
// license-correctness, report/provenance-completeness, citation presence/accuracy — all deterministic.
// Run: node scripts/test_category_B_scoring.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data');
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const B = JSON.parse(fs.readFileSync(path.join(DATA, 'benchmark-category-B.json'), 'utf8'));
const fails = [], assert = (c, m) => { if (!c) fails.push(m); };

// per-dataset GT maps the test peeks (to simulate a perfect / wrong agent)
const gtA = B.access_status_gt;
const gtC = {}; B.cases.forEach(c => { if ('gt_commercial_ok' in c) gtC[c.dataset_id] = c.gt_commercial_ok; });
const perfect = input => ({ access_status: gtA[input.dataset_id], commercial_ok: gtC[input.dataset_id] });
const wrong = () => ({ access_status: 'open', commercial_ok: true });   // always-open / always-commercial

// (1) perfect agent -> 1.0 on both
const p = API.benchmarkAccessLicense(perfect, B);
console.log('(1) perfect :', JSON.stringify({ access: p.accessStatusAccuracy, license: p.licenseCorrectness, counts: p.counts }));
assert(p.accessStatusAccuracy === 1.0, 'perfect accessStatusAccuracy should be 1.0, got ' + p.accessStatusAccuracy);
assert(p.licenseCorrectness === 1.0, 'perfect licenseCorrectness should be 1.0, got ' + p.licenseCorrectness);

// (2) always-open/commercial agent -> below 1.0 (misses non-open access + NC/unknown license cases)
const w = API.benchmarkAccessLicense(wrong, B);
console.log('(2) wrong   :', JSON.stringify({ access: w.accessStatusAccuracy, license: w.licenseCorrectness }));
assert(w.accessStatusAccuracy < 1.0, 'wrong agent access accuracy should be < 1.0, got ' + w.accessStatusAccuracy);
assert(w.licenseCorrectness < 1.0, 'wrong agent license correctness should be < 1.0, got ' + w.licenseCorrectness);

// (3) access-status exact-match
assert(API.scoreAccessStatus('open', 'open').correct === true, 'scoreAccessStatus open==open');
assert(API.scoreAccessStatus('open', 'unknown').correct === false, 'scoreAccessStatus open!=unknown');

// (4) report/provenance completeness — grounded vs a known rec
const rec = { license: 'CC BY 4.0', rights: { cls: 'permissive' }, access: 'https://github.com/x/y', doi: '10.5281/zenodo.123', paper: 'A Great Dataset' };
const fullReport = { datasets: ['X'], rationale: 'fits the task', source_citation: 'A Great Dataset (10.5281/zenodo.123)',
  license: 'CC BY 4.0', access: 'https://github.com/x/y', limitations: 'declared only', residual_risks: 'license per-subset' };
const rcFull = API.reportCompleteness(fullReport, rec);
console.log('(4) full report :', JSON.stringify(rcFull));
assert(rcFull.completeness === 1.0, 'full grounded report completeness should be 1.0, got ' + rcFull.completeness);
assert(rcFull.provenanceCompleteness === 1.0, 'full provenanceCompleteness should be 1.0');

// missing fields + UNGROUNDED license (wrong value) -> lower; license not credited
const badReport = { datasets: ['X'], rationale: 'x', source_citation: 'A Great Dataset', license: 'MIT', access: 'https://github.com/x/y' };
const rcBad = API.reportCompleteness(badReport, rec);
console.log('(4) bad report  :', JSON.stringify({ completeness: rcBad.completeness, prov: rcBad.provenanceCompleteness, missing: rcBad.missing, grounded: rcBad.grounded }));
assert(rcBad.missing.indexOf('limitations') >= 0 && rcBad.missing.indexOf('residual_risks') >= 0, 'badReport should miss limitations+residual_risks');
assert(rcBad.grounded.indexOf('license') < 0, 'wrong license value must NOT be grounded');
assert(rcBad.completeness < rcFull.completeness, 'bad report completeness must be lower');

// (5) citation presence + accuracy
const cOk = API.citationScore('A Great Dataset 10.5281/zenodo.123', rec);
const cNo = API.citationScore('', rec);
const cWrong = API.citationScore('Some Other Paper', rec);
console.log('(5) citation ok/none/wrong:', JSON.stringify([cOk.score, cNo.score, cWrong.score]));
assert(cOk.present && cOk.accurate && cOk.score === 1.0, 'matching citation should score 1.0');
assert(cNo.score === 0, 'empty citation should score 0');
assert(cWrong.present && !cWrong.accurate && cWrong.score === 0.5, 'present-but-wrong citation should score 0.5');

if (fails.length) { console.error('\n✗ CATEGORY-B TEST FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\n✓ Category-B OK — access-status accuracy + license + report/provenance completeness + citation all deterministic.');
