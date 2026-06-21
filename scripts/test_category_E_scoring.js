// OC_DATA_1 — stub test for the Category-E compare-select scoring path (no model).
// Verifies benchmarkAgentCompare: perfect-ranking agent → 1.0; reversed → low; a known
// hand-crafted ranking → deterministic Kendall-τ; gt_ties are either-order; missing-id handling.
// Run: node scripts/test_category_E_scoring.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data');
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const E = JSON.parse(fs.readFileSync(path.join(DATA, 'benchmark-category-E.json'), 'utf8'));
const fails = [], approx = (a, b, e) => Math.abs(a - b) < (e || 1e-9);
const assert = (c, m) => { if (!c) fails.push(m); };

// Build per-task lookups of the GT ranking (the test is allowed to peek to simulate a given agent).
const byTask = {}; E.cases.forEach(c => { byTask[c.need.task] = c; });
const mkAgent = transform => (input => ({ ranking: transform(byTask[input.need.task]) }));

// (1) PERFECT agent: returns gt_ranking exactly
const perfect = API.benchmarkAgentCompare(mkAgent(c => c.gt_ranking.slice()), E);
console.log('(1) perfect :', JSON.stringify({ top1: perfect.top1Accuracy, tau: perfect.meanTau, cases: perfect.cases }));
assert(perfect.top1Accuracy === 1.0, 'perfect top1Accuracy should be 1.0, got ' + perfect.top1Accuracy);
assert(perfect.meanTau === 1.0, 'perfect meanTau should be 1.0, got ' + perfect.meanTau);

// (2) REVERSED agent: returns gt_ranking reversed
const reversed = API.benchmarkAgentCompare(mkAgent(c => c.gt_ranking.slice().reverse()), E);
console.log('(2) reversed:', JSON.stringify({ top1: reversed.top1Accuracy, tau: reversed.meanTau }));
assert(reversed.top1Accuracy === 0.0, 'reversed top1Accuracy should be 0.0, got ' + reversed.top1Accuracy);
assert(reversed.meanTau <= -0.9, 'reversed meanTau should be ~ -1, got ' + reversed.meanTau);

// (3) gt_ties either-order: swapping a tied pair must NOT lower the score (use instance-seg HBD~UrbanTwin)
const tieCase = E.cases.find(c => (c.gt_ties || []).length > 0);
if (tieCase) {
  const swapTie = c => { const r = c.gt_ranking.slice(); const g = c.gt_ties[0]; // swap the first tied group's members
    const i = r.indexOf(g[0]), j = r.indexOf(g[1]); [r[i], r[j]] = [r[j], r[i]]; return r; };
  const s = API.scoreCompareSelect(tieCase, swapTie(tieCase));
  console.log('(3) swap-tied-pair on', tieCase.need.task, '->', JSON.stringify(s));
  assert(s.tau === 1.0, 'swapping a gt_ties pair should keep tau=1.0, got ' + s.tau);
  assert(s.top1Correct === true, 'swapping a top tied pair should keep top1 correct (either-order)');
}

// (4) DETERMINISTIC known-τ: 4 distinct items, swap the last adjacent pair -> 1 discordant of 6 pairs -> τ=4/6=0.6667
const synth = { need: { task: '_synth' }, gt_ranking: ['a', 'b', 'c', 'd'], gt_ties: [], gt_top1_set: ['a'], gt_best: 'a' };
const sFull = API.scoreCompareSelect(synth, ['a', 'b', 'd', 'c']); // one inversion (c,d)
console.log('(4) known-τ [a,b,d,c] vs [a,b,c,d]:', JSON.stringify(sFull));
assert(approx(sFull.tau, 0.6667, 1e-4), 'expected τ=0.6667 (5C-1D of 6), got ' + sFull.tau);
assert(sFull.top1Correct === true, 'top1 a∈{a} should be correct');
// reversed synth -> τ=-1, top1 wrong
const sRev = API.scoreCompareSelect(synth, ['d', 'c', 'b', 'a']);
assert(sRev.tau === -1 && sRev.top1Correct === false, 'reversed synth: τ=-1 & top1 wrong, got ' + JSON.stringify(sRev));

// (5) MISSING ids: agent omits 'd' -> treated as last (deterministic); still scorable
const sMiss = API.scoreCompareSelect(synth, ['a', 'b', 'c']);
console.log('(5) omit last id:', JSON.stringify(sMiss));
assert(sMiss.tau === 1.0 && sMiss.top1Correct === true, 'omitting the GT-last id should still be τ=1.0');

if (fails.length) { console.error('\n✗ CATEGORY-E SCORING TEST FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\n✓ Category-E scoring OK — perfect=1.0/1.0, reversed=0.0/~-1, ties either-order, known-τ deterministic.');
