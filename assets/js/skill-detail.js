// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q4 — Single skill detail page: load skills.json, render the selected SKILL.md.

(function () {
  'use strict';
  var yn = document.getElementById('yearNow'); if (yn) yn.textContent = new Date().getFullYear();

  var AI_LABEL = { 'claude-skill': 'Claude (Skill)', 'mcp': 'MCP server', 'cursor': 'Cursor', 'openai': 'OpenAI Agents' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function paths(f) { return ['data/' + f, './data/' + f, '../data/' + f, '/open-construction/data/' + f]; }
  async function load(f) {
    for (var i = 0; i < paths(f).length; i++) {
      try { var r = await fetch(paths(f)[i], { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) {}
    }
    return null;
  }
  function qid() {
    try { return new URLSearchParams(location.search).get('id'); } catch (e) { return null; }
  }

  // Assemble the SKILL.md text from real catalog fields (+ optional rich fields).
  function skillMd(s) {
    var fm = [
      '---',
      'name: ' + s.id,
      'title: ' + s.name,
      'version: ' + s.version,
      'license: ' + s.license,
      'domain: [' + (s.domain || []).join(', ') + ']',
      'phase: [' + (s.phase || []).join(', ') + ']',
      'discipline: [' + (s.discipline || []).join(', ') + ']',
      'ai_target: [' + (s.ai_target || []).join(', ') + ']',
      '---'
    ].join('\n');
    var body = '\n\n# ' + s.name + '\n\n' + (s.long_description || s.description);
    if (s.when_to_use && s.when_to_use.length) {
      body += '\n\n## When to use\n' + s.when_to_use.map(function (w) { return '- ' + w; }).join('\n');
    }
    if (s.inputs && s.inputs.length) {
      body += '\n\n## Inputs\n' + s.inputs.map(function (w) { return '- ' + w; }).join('\n');
    }
    if (s.outputs && s.outputs.length) {
      body += '\n\n## Outputs\n' + s.outputs.map(function (w) { return '- ' + w; }).join('\n');
    }
    return fm + body;
  }

  function chip(v, cls) { return '<span class="skill-chip ' + (cls || '') + '">' + esc(v) + '</span>'; }

  function relLink(name) {
    // Link related catalog resources to the assistant search so the user lands on the real card.
    var href = 'index.html?q=' + encodeURIComponent(name);
    return '<a href="' + href + '" title="Find this resource">🔗 ' + esc(name) + '</a>';
  }

  function example(s) {
    if (!s.example_io || !s.example_io.in) return '';
    return '<div class="sd-card mt-3"><h2>Worked example</h2>' +
      '<div class="sd-eg"><div><span class="u">Prompt →</span> ' + esc(s.example_io.in) + '</div>' +
      '<div class="mt-2"><span class="a">Skill output →</span> ' + esc(s.example_io.out) + '</div></div></div>';
  }

  function render(s) {
    document.title = 'OpenConstruction · ' + s.name;
    var bc = document.getElementById('bcName'); if (bc) bc.textContent = s.name;

    var ai = (s.ai_target || []).map(function (t) { return AI_LABEL[t] || t; }).join(', ');
    var dom = (s.domain || []).map(function (d) { return chip(d, 'dom'); }).join('');
    var disc = (s.discipline || []).map(function (d) { return chip(d); }).join('');
    var sw = (s.software || []).map(function (d) { return chip(d); }).join('');
    var phase = (s.phase || []).map(function (d) { return chip(d); }).join('');
    var authors = (s.authors || []).map(function (a) { return esc(a.name) + (a.affiliation ? ' (' + esc(a.affiliation) + ')' : ''); }).join(', ');

    var rel = (s.related_resources && s.related_resources.length)
      ? '<div class="sd-card mt-3"><h2>Works with these catalog resources</h2><div class="sd-rel">' +
        s.related_resources.map(relLink).join('') + '</div></div>'
      : '';

    var html =
      '<div class="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-2">' +
        '<div>' +
          '<div class="skill-chips mb-2">' + dom + '</div>' +
          '<h1 class="h3 fw-bold mb-1" style="color:#0f2e4b">' + esc(s.name) + '</h1>' +
          '<p class="text-muted mb-2" style="max-width:64ch">' + esc(s.description) + '</p>' +
          '<div class="sd-meta">' +
            '<span><strong>v' + esc(s.version) + '</strong></span>' +
            '<span>' + esc(s.license) + '</span>' +
            '<span>🎯 ' + esc(ai) + '</span>' +
            '<span>⬇ ' + (s.install_count || 0).toLocaleString() + ' installs</span>' +
            (s.has_eval ? '<span class="sd-badge-eval">✓ ships eval</span>' : '<span>' + (s.examples || 0) + ' example(s)</span>') +
          '</div>' +
        '</div>' +
        '<div class="d-flex flex-column gap-2">' +
          '<button id="installBtn" class="btn btn-primary">Install</button>' +
          '<button id="askBtn" class="btn btn-outline-secondary">✨ Ask the assistant</button>' +
          '<button id="bmBtn" class="btn btn-outline-secondary">🔖 Save</button>' +
        '</div>' +
      '</div>' +

      '<div class="row g-3 mt-1">' +
        '<div class="col-lg-7">' +
          '<div class="sd-card"><h2>SKILL.md</h2><div class="sd-mdview">' + esc(skillMd(s)) + '</div></div>' +
          example(s) +
        '</div>' +
        '<div class="col-lg-5">' +
          '<div class="sd-card"><h2>At a glance</h2><ul class="sd-io">' +
            '<li><strong>Project phase:</strong><div class="skill-chips mt-1">' + (phase || '<span class="text-muted">—</span>') + '</div></li>' +
            '<li><strong>Discipline:</strong><div class="skill-chips mt-1">' + (disc || '<span class="text-muted">—</span>') + '</div></li>' +
            '<li><strong>Software:</strong><div class="skill-chips mt-1">' + (sw || '<span class="text-muted">—</span>') + '</div></li>' +
            '<li><strong>Authors:</strong> ' + (authors || '<span class="text-muted">—</span>') + '</li>' +
          '</ul></div>' +
          rel +
        '</div>' +
      '</div>' +

      '<div class="sd-card mt-3"><h2>Install</h2>' +
        '<h6 class="mt-1">Claude Desktop / Code</h6>' +
        '<code class="copyblk">/plugin marketplace add openconstruction/skills\n/plugin install ' + esc(s.id) + '@openconstruction</code>' +
        '<h6 class="mt-2">CLI</h6>' +
        '<code class="copyblk">npx @openconstruction/skills install ' + esc(s.id) + '</code>' +
        '<h6 class="mt-2">Manual</h6>' +
        '<code class="copyblk">git clone the skill folder into ~/.claude/skills/' + esc(s.id) + '/</code>' +
        '<div class="alert alert-light border mt-2 small mb-0">Demo catalog — these commands illustrate the intended UX. ' +
          'Skills are reviewed via pull request like every other OpenConstruction resource.</div>' +
      '</div>';

    var root = document.getElementById('skillRoot');
    root.innerHTML = html;

    var ask = document.getElementById('askBtn');
    if (ask) ask.addEventListener('click', function () {
      var q = 'Tell me how to use the "' + s.name + '" skill and what catalog resources pair with it.';
      if (window.OCChat && window.OCChat.ask) window.OCChat.ask(q);
      else if (window.OCChat && window.OCChat.open) window.OCChat.open();
      else location.href = 'index.html?q=' + encodeURIComponent(s.name);
    });
    var bm = document.getElementById('bmBtn');
    if (bm) {
      var A = window.OCAccount;
      var item = { id: 'skill:' + s.id, type: 'skill', title: s.name, url: 'skill.html?id=' + encodeURIComponent(s.id) };
      var paint = function () {
        var on = A && A.isBookmarked(item.id);
        bm.classList.toggle('btn-outline-secondary', !on);
        bm.classList.toggle('btn-success', !!on);
        bm.textContent = on ? '🔖 Saved' : '🔖 Save';
      };
      paint();
      bm.addEventListener('click', function () {
        if (!A) return;
        if (!A.getUser()) { var h = window.prompt('Sign in (demo) to save bookmarks — handle:', 'aec-pro'); if (h === null) return; A.signIn(h); }
        A.toggleBookmark(item); paint();
      });
    }
    var inst = document.getElementById('installBtn');
    if (inst) inst.addEventListener('click', function () {
      document.querySelector('.sd-card h2').scrollIntoView({ behavior: 'smooth' });
      var blocks = root.querySelectorAll('.sd-card');
      var last = blocks[blocks.length - 1];
      if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var id = qid();
    var data = await load('skills.json');
    var s = (data && Array.isArray(data.skills)) ? data.skills.find(function (x) { return x.id === id; }) : null;
    if (!s) {
      document.getElementById('skillRoot').classList.add('d-none');
      document.getElementById('notFound').classList.remove('d-none');
      return;
    }
    render(s);
  });
})();
