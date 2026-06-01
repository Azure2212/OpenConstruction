// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q1 — No-Git contributor wizard. A friendly web form that produces schema-valid
// catalog JSON and (in production) opens a Pull Request via a GitHub App, so a
// non-technical contributor never has to clone, edit JSON, or use git. This is a
// front-end demo: it builds and validates the JSON and simulates the PR step.

(function () {
  'use strict';
  var root = document.getElementById('no-git-wizard');
  if (!root) return;

  // Field definitions per resource type. `req` = required; `opts` = dropdown.
  var SCHEMAS = {
    dataset: [
      { k: 'name', label: 'Dataset name', req: true },
      { k: 'authors', label: 'Authors (comma-separated)', req: true },
      { k: 'year', label: 'Year', type: 'number', req: true },
      { k: 'data_modality', label: 'Data modality', opts: ['Ground RGB', 'Aerial RGB', 'Point Cloud', 'BIM models (IFC)', 'Thermal', 'Satellite RGB', 'Video', 'Sensor/Time-series'], req: true },
      { k: 'potential_tasks', label: 'Task', opts: ['Object Detection', 'Semantic Segmentation', 'Image Classification', 'Point Cloud Segmentation', 'Scan-to-BIM', 'Damage Classification'], req: true },
      { k: 'license', label: 'License', opts: ['CC BY 4.0', 'CC BY-NC 4.0', 'CC BY-SA 4.0', 'Apache-2.0', 'MIT', 'Not Specified'], req: true },
      { k: 'doi', label: 'DOI or paper URL', req: false },
      { k: 'access', label: 'Download / access URL', req: true }
    ],
    model: [
      { k: 'title', label: 'Model title', req: true },
      { k: 'authors', label: 'Authors (comma-separated)', req: true },
      { k: 'year', label: 'Year', type: 'number', req: true },
      { k: 'tasks', label: 'Task', opts: ['Object Detection', 'Semantic Segmentation', 'Scan-to-BIM', 'Pose Estimation', 'Damage Classification', 'BIM Object Classification'], req: true },
      { k: 'license', label: 'License', opts: ['Apache-2.0', 'MIT', 'GPL-3.0', 'CC BY 4.0', 'CC BY-NC 4.0', 'Unspecified'], req: true },
      { k: 'paper_url', label: 'Paper URL', req: false },
      { k: 'code_url', label: 'Code repository URL', req: true }
    ],
    oer: [
      { k: 'title', label: 'Resource title', req: true },
      { k: 'provider', label: 'Author / provider', req: true },
      { k: 'year', label: 'Year', type: 'number', req: true },
      { k: 'topics', label: 'Topic', opts: ['Project Management', 'Construction Estimating', 'BIM', 'Structural Analysis', 'Construction Safety', 'Sustainability'], req: true },
      { k: 'license', label: 'License', opts: ['CC BY 4.0', 'CC BY-NC-SA 4.0', 'CC BY-ND 4.0', 'All Rights Reserved'], req: true },
      { k: 'source', label: 'Source URL', req: true }
    ],
    skill: [
      { k: 'name', label: 'Skill name', req: true },
      { k: 'description', label: 'One-line description', req: true },
      { k: 'domain', label: 'Domain', opts: ['Estimating', 'BIM/CAD', 'Safety/Inspection', 'Project Management', 'Code & Standards', 'Materials', 'Sustainability', 'Geo/Survey'], req: true },
      { k: 'ai_target', label: 'AI target', opts: ['claude-skill', 'mcp', 'cursor'], req: true },
      { k: 'license', label: 'License', opts: ['Apache-2.0', 'CC BY 4.0', 'MIT'], req: true }
    ]
  };
  var ARRAY_FIELDS = { authors: 1, potential_tasks: 1, tasks: 1, topics: 1, domain: 1, ai_target: 1 };

  var state = { type: null, signedIn: false };
  function $(sel) { return root.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  function setStep(n) {
    $all('.wiz-step').forEach(function (s) { s.classList.toggle('active', +s.dataset.step === n); });
    $all('.wiz-pane').forEach(function (p) { p.hidden = +p.dataset.pane !== n; });
  }

  // Sign-in (demo: no real OAuth, just illustrates the flow)
  $('#ghSignin').addEventListener('click', function () {
    state.signedIn = true;
    $('#ghStatus').hidden = false;
    this.disabled = true; this.textContent = 'Signed in';
  });

  // Step 1: pick type
  $all('.type-pick').forEach(function (btn) {
    btn.addEventListener('click', function () {
      $all('.type-pick').forEach(function (b) { b.classList.remove('sel'); });
      btn.classList.add('sel');
      state.type = btn.dataset.type;
      buildForm(state.type);
      setStep(2);
    });
  });

  function buildForm(type) {
    var fields = SCHEMAS[type];
    $('#wizForm').innerHTML = fields.map(function (f) {
      var input;
      if (f.opts) {
        input = '<select class="form-select" data-k="' + f.k + '"' + (f.req ? ' required' : '') + '>' +
          '<option value="">Choose…</option>' +
          f.opts.map(function (o) { return '<option>' + o + '</option>'; }).join('') + '</select>';
      } else {
        input = '<input class="form-control" type="' + (f.type || 'text') + '" data-k="' + f.k + '"' + (f.req ? ' required' : '') + '>';
      }
      return '<div class="col-md-6"><label class="form-label small fw-semibold">' + f.label +
        (f.req ? ' <span class="text-danger">*</span>' : '') + '</label>' + input + '</div>';
    }).join('');
  }

  function collect() {
    var obj = {};
    $all('#wizForm [data-k]').forEach(function (el) {
      var v = el.value.trim();
      if (!v) return;
      var k = el.dataset.k;
      if (ARRAY_FIELDS[k]) obj[k] = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      else if (el.type === 'number') obj[k] = +v;
      else obj[k] = v;
    });
    // id slug from name/title
    var base = obj.name || obj.title || '';
    if (base) obj.id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    return obj;
  }

  function validate(obj) {
    var missing = SCHEMAS[state.type].filter(function (f) { return f.req && (obj[f.k] == null || obj[f.k] === '' || (Array.isArray(obj[f.k]) && !obj[f.k].length)); });
    return missing.map(function (f) { return f.label; });
  }

  $('#toReview').addEventListener('click', function () {
    var obj = collect();
    var missing = validate(obj);
    var preview = {}; preview[state.type] = obj;
    $('#jsonPreview').textContent = JSON.stringify(state.type === 'skill' ? { skills: [obj] } : obj, null, 2);
    var msg = $('#validateMsg');
    if (missing.length) {
      msg.className = 'small mb-2 text-danger';
      msg.textContent = '⚠ Please fill required fields: ' + missing.join(', ') + ' (go back to step 2).';
      $('#openPR').disabled = true;
    } else {
      msg.className = 'small mb-2 text-success';
      msg.textContent = '✓ Looks valid against the ' + state.type + ' schema.';
      $('#openPR').disabled = false;
    }
    setStep(3);
  });

  $all('[data-go]').forEach(function (b) { b.addEventListener('click', function () { setStep(+b.dataset.go); }); });

  $('#openPR').addEventListener('click', function () {
    var box = $('#prResult');
    box.hidden = false;
    if (!state.signedIn) {
      box.className = 'alert alert-warning mt-3 small';
      box.innerHTML = 'Please <strong>Sign in with GitHub</strong> first so we can attribute the Pull Request to you.';
      return;
    }
    box.className = 'alert alert-success mt-3 small';
    box.innerHTML = '✓ <strong>Pull Request prepared.</strong> In production, an OpenConstruction GitHub App ' +
      'commits this JSON to a new branch and opens a PR (you are added as co-author), where CI validates the ' +
      'schema and a maintainer reviews it. <em>This demo stops here — no PR is actually created.</em>';

    // Record the (demo) submission on the user's profile so the contributor portal
    // shows their activity. Real PRs would be the source of truth in production.
    if (window.OCAccount) {
      var obj = collect();
      if (!window.OCAccount.getUser()) window.OCAccount.signIn('aec-pro');
      window.OCAccount.addContribution({
        type: state.type,
        title: obj.name || obj.title || '(untitled ' + state.type + ')',
        status: 'PR prepared'
      });
      box.innerHTML += ' <a href="profile.html#contributions" class="alert-link">See it on your profile →</a>';
    }
  });
})();
