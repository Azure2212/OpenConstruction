// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q3 — "Closing the last mile". OpenConstruction indexes rather than hosts, so
// after discovery the user normally leaves for Zenodo/HF/GitHub. This injects a
// lightweight, no-host action bar onto resource detail pages: an "Open in Colab"
// starter notebook, an in-browser preview for AEC formats (IFC / point cloud),
// and a one-click citation — value-add that does not require us to host data.

(function () {
  'use strict';
  var isModel = /\/models\//.test(location.pathname);
  var TYPE = isModel ? 'model' : 'dataset';
  var id = new URLSearchParams(location.search).get('id') || '';

  var css = document.createElement('style');
  css.textContent =
    '.oc-lastmile{border:1px solid #e7edf3;border-radius:14px;background:linear-gradient(180deg,#fbfdff,#fff);' +
    'box-shadow:0 8px 24px rgba(15,46,75,.06);padding:1rem 1.1rem;margin:0 0 1.2rem;}' +
    '.oc-lastmile h4{font-size:.95rem;font-weight:800;color:#0f2e4b;margin:0 0 .15rem;}' +
    '.oc-lastmile .sub{font-size:.8rem;color:#4f5d6c;margin:0 0 .7rem;}' +
    '.oc-lastmile .acts{display:flex;flex-wrap:wrap;gap:.5rem;}' +
    '.oc-lm-btn{display:inline-flex;align-items:center;gap:.4rem;border:1px solid #e7edf3;background:#fff;' +
    'border-radius:999px;padding:.4rem .9rem;font-size:.85rem;font-weight:700;color:#0f2e4b;cursor:pointer;}' +
    '.oc-lm-btn:hover{border-color:#f2a238;background:#fffaf2;}' +
    '.oc-lm-btn.primary{background:#f2a238;border-color:#f2a238;color:#3a2606;}' +
    '.oc-lm-viewer{height:300px;border:1px dashed #cfd9e4;border-radius:10px;display:grid;place-items:center;' +
    'text-align:center;color:#4f5d6c;background:repeating-linear-gradient(45deg,#fbfdff,#fbfdff 10px,#f3f7fb 10px,#f3f7fb 20px);}' +
    '.oc-code{display:block;background:#0f2e4b;color:#e9f1f8;padding:.7rem .9rem;border-radius:8px;font-size:.8rem;white-space:pre-wrap;overflow:auto;}';
  document.head.appendChild(css);

  function titleFromPage() {
    var h = document.querySelector('#detailRoot h1, #detailRoot h2, h1');
    return (h && h.textContent.trim()) || id || (TYPE === 'model' ? 'this model' : 'this dataset');
  }

  function notebookText(name) {
    if (TYPE === 'model') {
      return '# OpenConstruction — starter notebook\n' +
        '# Model: ' + name + '\n\n' +
        '# 1. Install deps\n!pip -q install torch torchvision\n\n' +
        '# 2. Load the model from its code repository (see the "Code" link on this page)\n' +
        '# 3. Run inference on a sample image\n' +
        '# 4. Compare against the matching benchmark in the OpenConstruction catalog\n';
    }
    return '# OpenConstruction — starter notebook\n' +
      '# Dataset: ' + name + '\n\n' +
      '# 1. Download from the access URL listed on this page\n' +
      '# 2. Load + preview a few samples\n' +
      '# 3. Train a quick baseline\n' +
      '# 4. Link to a pretrained model in the OpenConstruction Models catalog\n';
  }

  function modal(title, inner) {
    var wrap = document.createElement('div');
    wrap.className = 'modal fade';
    wrap.tabIndex = -1;
    wrap.innerHTML = '<div class="modal-dialog modal-dialog-centered modal-lg"><div class="modal-content p-1">' +
      '<div class="modal-header"><h5 class="modal-title">' + title + '</h5>' +
      '<button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
      '<div class="modal-body">' + inner + '</div></div></div>';
    document.body.appendChild(wrap);
    var m = new bootstrap.Modal(wrap);
    wrap.addEventListener('hidden.bs.modal', function () { wrap.remove(); });
    m.show();
  }

  function buildBar() {
    var name = titleFromPage();
    var bar = document.createElement('div');
    bar.className = 'oc-lastmile';
    bar.innerHTML =
      '<h4>⚡ Work with this ' + TYPE + '</h4>' +
      '<p class="sub">OpenConstruction indexes resources rather than hosting them — these tools help you go from “found it” to “using it” without leaving the page.</p>' +
      '<div class="acts">' +
        '<button class="oc-lm-btn primary" id="lmColab">▶ Open in Colab</button>' +
        '<button class="oc-lm-btn" id="lmPreview">👁 Preview in browser</button>' +
        '<button class="oc-lm-btn" id="lmCite">❝ Cite</button>' +
        '<button class="oc-lm-btn" id="lmSave">🔖 Save</button>' +
      '</div>';
    return bar;
  }

  function wire(bar) {
    var name = titleFromPage();
    bar.querySelector('#lmColab').addEventListener('click', function () {
      modal('Open in Colab — starter notebook',
        '<p class="small text-muted">A templated notebook scaffolds the common path for this ' + TYPE +
        ' (load → ' + (TYPE === 'model' ? 'inference → benchmark' : 'preview → baseline → linked model') + '). ' +
        'It links straight to a model/benchmark already in the catalog.</p>' +
        '<code class="oc-code">' + notebookText(name).replace(/</g, '&lt;') + '</code>' +
        '<a class="btn btn-sm btn-primary mt-3" target="_blank" rel="noopener" ' +
        'href="https://colab.research.google.com/#create=true">Open a Colab notebook ↗</a>' +
        '<p class="small text-muted mt-2 mb-0">Demo: the published notebook would ship in the repo so the button opens it pre-filled.</p>');
    });
    bar.querySelector('#lmPreview').addEventListener('click', function () {
      var viewerUrl = '../viewer.html?title=' + encodeURIComponent(name);
      modal('In-browser preview',
        '<div class="oc-lm-viewer">' +
        '<div><div style="font-size:2rem">🧱</div><strong>IFC / point-cloud viewer</strong>' +
        '<div class="small mt-1" style="max-width:48ch">Renders BIM (IFC) and point clouds right here in the browser — ' +
        'something Hugging Face / Zenodo cannot do for AEC formats. Open the viewer and load an ' +
        '<code>.ifc</code> / <code>.xyz</code> file (yours or the one from this resource).</div></div>' +
        '</div>' +
        '<a class="btn btn-sm btn-primary mt-3" target="_blank" rel="noopener" href="' + viewerUrl + '">Open the viewer ↗</a>' +
        '<p class="small text-muted mt-2 mb-0">The viewer runs fully client-side ($0 hosting). Once a resource ships a ' +
        'viewable asset URL, this button loads it directly.</p>');
    });
    bar.querySelector('#lmCite').addEventListener('click', function () {
      var key = (id || name).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'openconstruction';
      var bib = '@misc{' + key + ',\n  title  = {' + name + '},\n  year   = {' + new Date().getFullYear() + '},\n' +
        '  note   = {Indexed by OpenConstruction, https://www.openconstruction.org},\n  url    = {' + location.href + '}\n}';
      modal('Cite this ' + TYPE,
        '<p class="small text-muted">BibTeX (also available via the MCP <code>cite()</code> tool):</p>' +
        '<code class="oc-code" id="bibBox">' + bib.replace(/</g, '&lt;') + '</code>' +
        '<button class="btn btn-sm btn-outline-secondary mt-2" onclick="navigator.clipboard.writeText(document.getElementById(\'bibBox\').innerText)">Copy</button>');
    });

    var saveBtn = bar.querySelector('#lmSave');
    if (saveBtn) {
      var A = window.OCAccount;
      var item = { id: TYPE + ':' + (id || name), type: TYPE, title: name, url: location.href };
      var paint = function () {
        var on = A && A.isBookmarked(item.id);
        saveBtn.textContent = on ? '🔖 Saved' : '🔖 Save';
        saveBtn.classList.toggle('primary', !!on);
      };
      paint();
      saveBtn.addEventListener('click', function () {
        if (!A) return;
        if (!A.getUser()) { var h = window.prompt('Sign in (demo) to save bookmarks — handle:', 'aec-pro'); if (h === null) return; A.signIn(h); }
        A.toggleBookmark(item); paint();
      });
    }
  }

  function inject() {
    var rootEl = document.getElementById('detailRoot');
    if (!rootEl || rootEl.querySelector('.oc-lastmile')) return false;
    if (!rootEl.children.length) return false; // wait until detail.js has rendered
    var bar = buildBar();
    rootEl.insertBefore(bar, rootEl.firstChild);
    wire(bar);
    return true;
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (inject()) return;
    var rootEl = document.getElementById('detailRoot');
    if (!rootEl) return;
    var obs = new MutationObserver(function () { if (inject()) obs.disconnect(); });
    obs.observe(rootEl, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 8000); // safety stop
  });
})();
