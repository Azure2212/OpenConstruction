// OC_DATA_1 — stub test for Category-C RETRIEVE metrics (no model). A reference detector reads the
// SYNTHETIC fixtures and runs through benchmarkRetrieve → must reproduce GT (1.0); a wrong agent → lower.
// Proves the fixtures + GT are self-consistent and the metric is deterministic. Run: node scripts/test_category_C_scoring.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const C = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/benchmark-category-C.json'), 'utf8'));
const fails = [], assert = (c, m) => { if (!c) fails.push(m); };

// Reference detect_format (mirrors gen_category_C_fixtures.py + the documented contract).
function refFormat(abs) {
  const b = fs.readFileSync(abs), name = path.basename(abs), ext = (name.indexOf('.') >= 0 ? name.split('.').pop() : '').toLowerCase();
  let fmt;
  if (b.length === 0) return 'empty';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) fmt = 'png';
  else if (b.slice(0, 3).toString('latin1') === 'ply') fmt = 'ply';
  else if (b[0] === 0x7b || b[0] === 0x5b) { try { const j = JSON.parse(b.toString('utf8')); fmt = (j && j.images && j.annotations && j.categories) ? 'coco' : 'json'; } catch (e) { fmt = 'json-invalid'; } }
  else if (ext === 'csv' || (b.slice(0, 200).includes(0x2c) && b.slice(0, 400).includes(0x0a))) fmt = 'csv';
  else if (ext === 'labels' || ext === 'txt') fmt = 'text';
  else fmt = 'unknown';
  if ((ext === 'png' || ext === 'ply') && fmt !== ext) return 'corrupted';
  return fmt;
}
function refInventory(reldir) {
  const d = path.join(ROOT, reldir);
  const files = fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isFile() && f !== '_FIXTURE.json').sort();
  const by = {}; files.forEach(f => { const fmt = refFormat(path.join(d, f)); by[fmt] = (by[fmt] || 0) + 1; });
  return { file_count: files.length, by_format: by };
}
const perfect = input => input.subtype === 'inventory' ? { inventory: refInventory(input.path) } : { format: refFormat(path.join(ROOT, input.path)) };
const wrong = () => ({ format: 'csv', inventory: { file_count: 0, by_format: {} } });

// (1) perfect reference detector -> all 1.0
const p = API.benchmarkRetrieve(perfect, C);
console.log('(1) perfect:', JSON.stringify({ format: p.formatAccuracy, invExact: p.inventoryExactAccuracy, corruptMissing: p.corruptMissingDetection, counts: p.counts }));
assert(p.formatAccuracy === 1.0, 'perfect formatAccuracy should be 1.0, got ' + p.formatAccuracy);
assert(p.inventoryExactAccuracy === 1.0, 'perfect inventoryExactAccuracy should be 1.0, got ' + p.inventoryExactAccuracy);
assert(p.corruptMissingDetection === 1.0, 'perfect corrupt/empty detection should be 1.0, got ' + p.corruptMissingDetection);

// (2) wrong agent -> below 1.0 everywhere
const w = API.benchmarkRetrieve(wrong, C);
console.log('(2) wrong  :', JSON.stringify({ format: w.formatAccuracy, invExact: w.inventoryExactAccuracy, corruptMissing: w.corruptMissingDetection }));
assert(w.formatAccuracy < 1.0, 'wrong formatAccuracy should be < 1.0');
assert(w.inventoryExactAccuracy === 0.0, 'wrong inventoryExactAccuracy should be 0.0');
assert(w.corruptMissingDetection === 0.0, 'wrong corrupt/missing detection should be 0.0');

// (3) unit checks
assert(API.scoreFormatDetection('coco', 'coco').correct && !API.scoreFormatDetection('json', 'coco').correct, 'scoreFormatDetection exact-match');
assert(API.scoreInventory({ file_count: 2, by_format: { ply: 1, text: 1 } }, { file_count: 2, by_format: { ply: 1, text: 1 } }).correct, 'scoreInventory exact');
assert(API.scoreInventory({ file_count: 3, by_format: { ply: 1, text: 1 } }, { file_count: 2, by_format: { ply: 1, text: 1 } }).accuracy === 0.5, 'scoreInventory wrong count -> 0.5');

if (fails.length) { console.error('\n✗ CATEGORY-C TEST FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\n✓ Category-C OK — reference detector reproduces fixture GT (1.0/1.0/1.0); wrong agent scores lower; corrupted+empty detected.');
