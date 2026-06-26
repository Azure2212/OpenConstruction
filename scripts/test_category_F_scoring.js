// OC_DATA_1 — stub test for Category-F USE metrics (no model). The "perfect" agent runs INDEPENDENT
// converters / splitter / validator (NOT echoing GT — the Critic G4.0 lesson) → production benchmarkPrep
// must score 1.0. A wrong agent scores lower. Deterministic. Run: node scripts/test_category_F_scoring.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const API = require(path.join(ROOT, 'assets/js/data-agent.js'));
const F = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/benchmark-category-F.json'), 'utf8'));
const fails = [], assert = (c, m) => { if (!c) fails.push(m); };

function loadCoco(input) { return input.inline_source || JSON.parse(fs.readFileSync(path.join(ROOT, 'data/samples', input.source))); }
function convert(input) {
  const c = loadCoco(input), dim = {}, ci = {};
  c.images.forEach(im => dim[im.id] = [im.width, im.height]); c.categories.forEach((x, i) => ci[x.id] = i);
  const anns = c.annotations.map(a => {
    const [W, H] = dim[a.image_id], [x, y, w, h] = a.bbox, cls = ci[a.category_id];
    if (input.target === 'yolo') return { image_id: a.image_id, class_id: cls, cx: (x + w / 2) / W, cy: (y + h / 2) / H, w: w / W, h: h / H };
    if (input.target === 'pascal_voc') return { image_id: a.image_id, class_id: cls, xmin: x, ymin: y, xmax: x + w, ymax: y + h };
    const cx = (x + w / 2) / W, cy = (y + h / 2) / H, nw = w / W, nh = h / H;          // coco->yolo->coco roundtrip
    return { image_id: a.image_id, class_id: cls, bbox: [(cx - nw / 2) * W, (cy - nh / 2) * H, nw * W, nh * H] };
  });
  return { format: input.target, annotations: anns };
}
function validate(input) {
  const c = loadCoco(input), dim = {}, cat = {};
  c.images.forEach(im => dim[im.id] = [im.width, im.height]); c.categories.forEach(x => cat[x.id] = 1);
  let valid = true;
  c.annotations.forEach(a => { const d = dim[a.image_id]; if (!d || !cat[a.category_id]) { valid = false; return; }
    const [W, H] = d, [x, y, w, h] = a.bbox; if (x < 0 || y < 0 || x + w > W || y + h > H) valid = false; });
  return { valid };
}
function fnv(s) { let x = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x; }
function split(input) {                                  // deterministic, seeded, reproducible
  const items = (input.items || []).slice().sort((a, b) => fnv(input.seed + '_' + a) - fnv(input.seed + '_' + b));
  const n = items.length, nTr = Math.round(n * input.ratios.train), nVal = Math.round(n * input.ratios.val);
  return { splits: { train: items.slice(0, nTr), val: items.slice(nTr, nTr + nVal), test: items.slice(nTr + nVal) }, seed: input.seed };
}
const perfect = input => input.subtype === 'annotation-conversion' ? convert(input) : input.subtype === 'dataset-split' ? split(input) : validate(input);
const wrong = input => input.subtype === 'annotation-conversion' ? { format: input.target, annotations: [{ image_id: 1, class_id: 9, bbox: [9, 9, 9, 9] }] }
  : input.subtype === 'dataset-split' ? { splits: { train: (input.items || []).slice(), val: (input.items || []).slice(0, 1), test: [] } }  // leakage
  : { valid: true };  // always-valid → wrong on the invalid case

const p = API.benchmarkPrep(perfect, F);
console.log('(1) perfect:', JSON.stringify({ convert: p.conversionAccuracy, split: p.splitCorrectness, validity: p.annotationValidityAccuracy, scored: p.scoredCases, counts: p.counts }));
assert(p.conversionAccuracy === 1.0, 'perfect conversionAccuracy should be 1.0, got ' + p.conversionAccuracy);
assert(p.splitCorrectness === 1.0, 'perfect splitCorrectness should be 1.0, got ' + p.splitCorrectness);
assert(p.annotationValidityAccuracy === 1.0, 'perfect annotationValidityAccuracy should be 1.0, got ' + p.annotationValidityAccuracy);
assert(p.scoredCases === 8, 'should score 8 cases, got ' + p.scoredCases);

const w = API.benchmarkPrep(wrong, F);
console.log('(2) wrong  :', JSON.stringify({ convert: w.conversionAccuracy, split: w.splitCorrectness, validity: w.annotationValidityAccuracy }));
assert(w.conversionAccuracy < 1.0, 'wrong conversionAccuracy should be < 1.0');
assert(w.splitCorrectness < 1.0, 'wrong splitCorrectness should be < 1.0 (leakage)');
assert(w.annotationValidityAccuracy < 1.0, 'wrong annotationValidityAccuracy should be < 1.0');

// unit: leakage + ratio detection
const leaky = API.scoreSplit({ splits: { train: ['a', 'b'], val: ['b'], test: ['c'] } }, { items: ['a', 'b', 'c'], ratios: { train: 0.6, val: 0.2, test: 0.2 }, tolerance: 0.5 });
assert(leaky.noLeakage === false && leaky.valid === false, 'scoreSplit must flag leakage (b in train+val)');
const clean = API.scoreSplit({ splits: { train: ['a', 'b'], val: ['c'], test: ['d'] } }, { items: ['a', 'b', 'c', 'd'], ratios: { train: 0.5, val: 0.25, test: 0.25 }, tolerance: 0.1 });
assert(clean.valid === true, 'scoreSplit clean disjoint+complete+ratio should be valid');

// G + H recorded as deferred specs
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/benchmark-category-G.json'))), H = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/benchmark-category-H.json')));
assert(G._meta.status === 'deferred' && H._meta.status === 'deferred', 'G and H must be recorded as deferred');
console.log('(3) deferred specs: G=' + G._meta.status + ' H=' + H._meta.status);

if (fails.length) { console.error('\n✗ CATEGORY-F TEST FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('\n✓ Category-F OK — convert validity + split (no-leakage/ratio/reproducible) + annotation validity deterministic; perfect 1.0, wrong lower; G/H deferred.');
