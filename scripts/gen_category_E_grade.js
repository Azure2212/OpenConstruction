// OC_DATA_1 — Category-E GT re-grade against the FIXED shared instrument (manifest v13:
// num() K/M/B fix, de-circularized compare_resources). GT = AGREEMENT WITH A TRANSPARENT REFERENCE
// INSTRUMENT (data-agent-compare.js rankBySuitability), NOT hand-labeled human ranks.
// Adds: modality-constraint where data allows · margin-tolerance + tie handling · ±50% single-weight
// sensitivity. Reports old→new diffs. Run: node scripts/gen_category_E_grade.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'data');
const rd = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const CMP = require(path.join(ROOT, 'assets/js/data-agent-compare.js'));
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const EPS = 0.02;  // margin tolerance: |Δtotal| < EPS => near-tie (either-order / any acceptable as top-1)

API.setTaxonomy(rd('agent-taxonomy.json'));
const corpus = API.buildCorpus(rd('datasets.json'));
const comparer = CMP.createComparer(API);
const W = {}; comparer.CRITERIA.forEach(c => W[c.key] = c.weight);   // base weights (authoritative)
const E = rd('benchmark-category-E.json');
const catIds = new Set(corpus.datasets.map(d => norm(d.id)));

// recompute a weighted total from a per-criterion breakdown with an arbitrary weight map (renormalized over non-null)
function totalWith(breakdown, weights) {
  let acc = 0, wsum = 0;
  breakdown.forEach(b => { if (b.score != null) { const w = weights[b.criterion]; acc += w * b.score; wsum += w; } });
  return wsum ? acc / wsum : 0;
}

const diffs = [], orphans = [];
let constrained = 0, mixed = 0, anyFlipCases = 0;
const flipByCriterion = {};

for (const c of E.cases) {
  const old = { best: c.gt_best, ranking: (c.gt_ranking || []).slice() };

  // (4) modality-constraint where data allows: if a single bucket covers >=3 candidates, restrict to it
  let cand = c.candidate_ids.slice();
  const mc = {};
  cand.forEach(id => { (corpus.byId.get(norm(id)).modality || []).forEach(m => { mc[m] = (mc[m] || 0) + 1; }); });
  const dom = Object.entries(mc).sort((a, b) => b[1] - a[1])[0];
  if (dom && dom[1] >= 3) {
    cand = cand.filter(id => (corpus.byId.get(norm(id)).modality || []).includes(dom[0]));
    c.need.modality = dom[0]; c.modality_controlled = true; constrained++;
  } else {
    c.need.modality = ''; c.modality_controlled = false; mixed++;
  }
  c.candidate_ids = cand.slice().sort();
  cand.forEach(id => { if (!catIds.has(norm(id))) orphans.push(id); });

  const need = API.parseNeed(c.need);
  const recs = cand.map(id => corpus.byId.get(norm(id)));
  const ranked = comparer.rankBySuitability(recs, need);   // [{id,total,breakdown}]
  c.gt_ranking = ranked.map(r => r.id);
  c.gt_best = ranked[0].id;
  c.gt_scores = ranked.map(r => ({ id: r.id, total: r.total }));
  c.gt_breakdown = {}; const bdById = {};
  ranked.forEach(r => { bdById[r.id] = r.breakdown; c.gt_breakdown[r.id] = {}; r.breakdown.forEach(b => { c.gt_breakdown[r.id][b.criterion] = b.score; }); });

  // (3) margins + ties
  const tops = ranked.map(r => r.total);
  c.gt_margin = ranked.length > 1 ? +(tops[0] - tops[1]).toFixed(4) : null;
  c.gt_top1_set = ranked.filter(r => Math.abs(r.total - tops[0]) < EPS).map(r => r.id);   // any acceptable as top-1
  const ties = [];
  for (let i = 0; i < ranked.length;) {
    let j = i + 1; while (j < ranked.length && Math.abs(ranked[j].total - ranked[i].total) < EPS) j++;
    if (j - i > 1) ties.push(ranked.slice(i, j).map(r => r.id));
    i = j;
  }
  c.gt_ties = ties;   // each group = either-order-correct for rank agreement

  // (4) ±50% single-weight sensitivity: does top-1 flip under any one weight scaled 0.5x or 1.5x?
  let caseFlips = 0;
  for (const k of Object.keys(W)) {
    for (const f of [0.5, 1.5]) {
      const w2 = Object.assign({}, W); w2[k] = W[k] * f;
      let bestId = null, bestT = -1;
      ranked.forEach(r => { const t = totalWith(bdById[r.id], w2); if (t > bestT + 1e-9) { bestT = t; bestId = r.id; } });
      if (bestId !== c.gt_best && Math.abs(bestT - tops[0]) >= EPS) { caseFlips++; flipByCriterion[k] = (flipByCriterion[k] || 0) + 1; }
    }
  }
  c.gt_weight_sensitivity = { top1_flips_under_single_weight_pm50: caseFlips, of_perturbations: Object.keys(W).length * 2 };
  if (caseFlips > 0) anyFlipCases++;

  c._gt_method = 'rankBySuitability (data-agent-compare.js, 10 .doc criteria, exact+descendant task_align). GT = agreement with this TRANSPARENT REFERENCE INSTRUMENT, not human-labeled ranks.';
  if (old.best !== c.gt_best || JSON.stringify(old.ranking) !== JSON.stringify(c.gt_ranking))
    diffs.push({ task: c.need.task, old_best: old.best, new_best: c.gt_best, old: old.ranking, new: c.gt_ranking });
}

E._meta.gt_rule = 'gt_ranking = rankBySuitability (transparent reference instrument; 10 criteria, exact+descendant task_align). Agent sees per-criterion EVIDENCE only (compare_resources) and must weigh itself.';
E._meta.gt_nature = 'AGREEMENT WITH A TRANSPARENT REFERENCE INSTRUMENT — NOT hand-labeled human expert ranks. The instrument operationalizes the .doc suitability criteria deterministically.';
E._meta.scoring_policy = { top1: 'correct if pick ∈ gt_top1_set (within margin EPS=' + EPS + ' of the max)', ranking: 'Kendall-τ vs gt_ranking, with gt_ties groups treated as either-order-correct', margin_tolerance: EPS };
E._meta.weight_status = 'The 10 criteria weights are a DESIGN DECISION (pending Critic sign-off). Sensitivity reported per case (gt_weight_sensitivity).';
E._meta.LIMITATION_phase2 = 'HUMAN-EXPERT validation of the rankings is NOT done — explicitly a Phase-2 limitation. Current GT trusts the transparent instrument.';
E._meta.modality_control = constrained + ' of ' + E.cases.length + ' compare-sets constrained to a single modality (>=3 candidates share it); rest are mixed-modality (flagged per case).';
E._meta.instrument_commit = 'data-agent-compare.js v13 (num() K/M/B fix)';
fs.writeFileSync(path.join(DATA, 'benchmark-category-E.json'), JSON.stringify(E, null, 1));

// ---- report ----
console.log('=== Category-E re-grade (fixed instrument v13) ===');
console.log('cases:', E.cases.length, '| modality-constrained:', constrained, '| mixed-modality:', mixed, '| orphan IDs:', orphans.length || 'none');
console.log('\nCHANGED cases (' + diffs.length + '):');
diffs.forEach(d => console.log(`  ${d.task}\n     old: ${d.old_best}  [${d.old.join(' > ')}]\n     new: ${d.new_best}  [${d.new.join(' > ')}]`));
console.log('\nUNCHANGED:', E.cases.filter(c => !diffs.find(d => d.task === c.need.task)).map(c => c.need.task).join(', '));
console.log('\n=== weight-sensitivity (±50% single weight) ===');
console.log('cases whose top-1 flips under some single ±50% weight change:', anyFlipCases, '/', E.cases.length);
console.log('flip-inducing criteria (count):', JSON.stringify(flipByCriterion));
console.log('\nties / near-ties (EPS=' + EPS + '):');
E.cases.forEach(c => { if (c.gt_ties.length) console.log(`  ${c.need.task}: ${JSON.stringify(c.gt_ties)} (margin ${c.gt_margin})`); });
