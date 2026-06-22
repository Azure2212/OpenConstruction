// OC_DATA_1 — stub test for Category-D UNDERSTAND metrics (no model). perfect→1.0, wrong→lower;
// tolerance behaviour (float within 1% ok, count exact); defined-only cases skipped. Deterministic.
// Run: node scripts/test_category_D_scoring.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/benchmark-category-D.json'), 'utf8'));
const fails = [], assert = (c, m) => { if (!c) fails.push(m); };

// perfect agent peeks GT for profiles/edges, but for tool-selection it returns the ANALYST'S REAL
// tool names from an independent modality map (NOT echoing gt_tools) — so production benchmarkProfile
// (no alias) only scores 1.0 if the GT actually carries the canonical names. This is the regression
// guard for the Critic G4.0 tool-name mismatch.
const REAL_TOOLS = { point_cloud: ['profile_pointcloud'], image: ['profile_images', 'profile_annotations'], tabular: ['profile_table'] };
const gt = {}; D.cases.filter(c => c.status !== 'defined-only').forEach(c => { gt[c.path + '|' + c.subtype] = c; });
const perfect = input => { const c = gt[input.path + '|' + input.subtype] || {};
  if (input.subtype === 'numeric-profile') return { profile: c.gt_profile };
  if (input.subtype === 'tool-selection') return { tools: REAL_TOOLS[input.modality] };   // real names, independent of GT
  return { result: c.gt_result }; };
const wrong = input => input.subtype === 'numeric-profile' ? { profile: { num_points: 999 } }
  : input.subtype === 'tool-selection' ? { tools: ['profile_tabular'] } : { result: 'ok' };

// (1) perfect -> 1.0 across the board
const p = API.benchmarkProfile(perfect, D);
console.log('(1) perfect:', JSON.stringify({ profile: p.profileAccuracy, tool: p.toolSelectionAccuracy, edge: p.edgeCaseAccuracy, scored: p.scoredCases, counts: p.counts }));
assert(p.profileAccuracy === 1.0, 'perfect profileAccuracy should be 1.0, got ' + p.profileAccuracy);
assert(p.toolSelectionAccuracy === 1.0, 'perfect toolSelectionAccuracy should be 1.0, got ' + p.toolSelectionAccuracy);
assert(p.edgeCaseAccuracy === 1.0, 'perfect edgeCaseAccuracy should be 1.0, got ' + p.edgeCaseAccuracy);
assert(p.scoredCases === 10, 'should score 10 (4 profile + 3 tool + 3 edge), got ' + p.scoredCases);

// (2) wrong -> below 1.0 everywhere
const w = API.benchmarkProfile(wrong, D);
console.log('(2) wrong  :', JSON.stringify({ profile: w.profileAccuracy, tool: w.toolSelectionAccuracy, edge: w.edgeCaseAccuracy }));
assert(w.profileAccuracy < 1.0, 'wrong profileAccuracy should be < 1.0');
assert(w.toolSelectionAccuracy < 1.0, 'wrong toolSelectionAccuracy should be < 1.0');
assert(w.edgeCaseAccuracy < 1.0, 'wrong edgeCaseAccuracy should be < 1.0');

// (3) tolerance: float within 1% OK, beyond NOT; integer count must be exact
const gtP = { num_rows: 3, mean: 1000.0 };
assert(API.scoreProfile({ num_rows: 3, mean: 1005 }, gtP, 0.01).accuracy === 1.0, 'mean within 1% should be correct');
assert(API.scoreProfile({ num_rows: 3, mean: 1100 }, gtP, 0.01).perField.mean === false, 'mean off 10% should be wrong');
assert(API.scoreProfile({ num_rows: 4, mean: 1000.0 }, gtP, 0.01).perField.num_rows === false, 'integer count must be exact');

// (3b) GT tool names must be the Analyst's CANONICAL names (Critic G4.0 guard)
const tcase = m => D.cases.find(c => c.subtype === 'tool-selection' && c.modality === m);
assert(JSON.stringify(tcase('point_cloud').gt_tools) === JSON.stringify(['profile_pointcloud']), 'point_cloud gt_tools must be [profile_pointcloud]');
assert(JSON.stringify(tcase('image').gt_tools) === JSON.stringify(['profile_images', 'profile_annotations']), 'image gt_tools must be [profile_images, profile_annotations]');
assert(JSON.stringify(tcase('tabular').gt_tools) === JSON.stringify(['profile_table']), 'tabular gt_tools must be [profile_table]');

// (4) defined-only modalities are present but NOT scored
const defOnly = D.cases.filter(c => c.status === 'defined-only').map(c => c.modality);
console.log('(4) defined-only (not scored):', JSON.stringify(defOnly));
assert(defOnly.length === 4 && p.scoredCases === D.cases.length - 4, 'defined-only must be excluded from scoring');

if (fails.length) { console.error('\n✗ CATEGORY-D TEST FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\n✓ Category-D OK — oracle-profile/tool-selection/edge all deterministic; tolerance respected; defined-only skipped.');
