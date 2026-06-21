// test_c6_report.js — Bước 2 C6: check_access + get_citation tools + assembleReport (anti-circular).
// Model-free, deterministic.   run: node scripts/test_c6_report.js   (from OpenConstruction/)
var fs = require('fs'), path = require('path');
var ROOT = path.join(__dirname, '..');
var api = require(path.join(ROOT, 'assets/js/data-agent.js'));
var AT = require(path.join(ROOT, 'assets/js/agent-tools.js'));
var taxonomy = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/agent-taxonomy.json'), 'utf8'));
api.setTaxonomy(taxonomy);
var corpus = api.buildCorpus(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/datasets.json'), 'utf8')));
var tk = AT.createTools(api, corpus, taxonomy);

var pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } }
function present(v) { return v != null && String(v).trim() !== '' && !(Array.isArray(v) && v.length === 0); }

var doiRec = corpus.datasets.filter(function (d) { return d.doi; })[0];
var anyRec = corpus.datasets[0];

console.log('\n[1] check_access tool');
var ENUM = ['open', 'gated', 'registration_required', 'restricted', 'unknown'];
var ca = tk.dispatch('check_access', { id: anyRec.id });
check('check_access -> valid status from the enum + evidence field', ENUM.indexOf(ca.access_status) >= 0 && ('evidence' in ca), ca);
check('check_access unknown id -> error', tk.dispatch('check_access', { id: '__nope__' }).error != null);

console.log('\n[2] get_citation tool');
var gc = tk.dispatch('get_citation', { id: doiRec.id });
check('get_citation -> citation text + source_url + matching doi', !!gc.citation && !!gc.source_url && gc.doi === doiRec.doi, { doi: gc.doi });

console.log('\n[3] C6 assembleReport — complete + grounded');
var rep = api.assembleReport([doiRec.id], corpus);
var rc = api.reportCompleteness(rep, doiRec);
check('report has every REPORT_REQUIRED_FIELD present', api.REPORT_REQUIRED_FIELDS.every(function (f) { return present(rep[f]); }), api.REPORT_REQUIRED_FIELDS.filter(function (f) { return !present(rep[f]); }));
check('reference report completeness = 1.0 and provenance = 1.0 (grounded)', rc.completeness === 1 && rc.provenanceCompleteness === 1, rc);
check('per_dataset carries provenance (citation + access_status)', rep.per_dataset.length === 1 && !!rep.per_dataset[0].source_citation && ENUM.indexOf(rep.per_dataset[0].access_status) >= 0, rep.per_dataset[0]);

console.log('\n[4] ANTI-CIRCULARITY (assembleReport is grader-side, metric is not trivially 1.0)');
check('assembleReport is NOT exposed as an agent tool', ['assemble_report', 'report', 'get_report', 'generate_report'].every(function (n) { return tk.toolNames.indexOf(n) < 0; }), tk.toolNames);
var degraded = Object.assign({}, rep); delete degraded.source_citation; // an agent that skipped get_citation
var rcd = api.reportCompleteness(degraded, doiRec);
check('missing source_citation -> completeness < 1 (agent must gather it)', rcd.completeness < 1, rcd);

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
