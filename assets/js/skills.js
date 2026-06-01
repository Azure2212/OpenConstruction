// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q4 — AEC Skill catalog: load skills.json, filter/search/sort, render, install UX.

(function () {
  'use strict';
  var yn = document.getElementById('yearNow'); if (yn) yn.textContent = new Date().getFullYear();

  var FACETS = ['domain', 'phase', 'discipline', 'software', 'ai_target'];
  var AI_LABEL = { 'claude-skill': 'Claude (Skill)', 'mcp': 'MCP server', 'cursor': 'Cursor', 'openai': 'OpenAI Agents' };
  var state = { q: '', sort: 'popular', filters: {} };
  FACETS.forEach(function (f) { state.filters[f] = new Set(); });
  var SKILLS = [];

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

  function uniqueValues(field) {
    var counts = {};
    SKILLS.forEach(function (s) { (s[field] || []).forEach(function (v) { counts[v] = (counts[v] || 0) + 1; }); });
    return Object.keys(counts).sort().map(function (v) { return { value: v, count: counts[v] }; });
  }

  function buildFacet(field) {
    var host = document.getElementById('filter-' + field);
    if (!host) return;
    host.innerHTML = uniqueValues(field).map(function (o) {
      var id = 'f-' + field + '-' + o.value.replace(/[^a-z0-9]/gi, '');
      var label = (field === 'ai_target' && AI_LABEL[o.value]) ? AI_LABEL[o.value] : o.value;
      return '<div class="form-check">' +
        '<input class="form-check-input" type="checkbox" value="' + esc(o.value) + '" id="' + id + '" data-field="' + field + '">' +
        '<label class="form-check-label" for="' + id + '">' + esc(label) + ' <span class="text-muted">(' + o.count + ')</span></label>' +
        '</div>';
    }).join('');
  }

  function matches(s) {
    if (state.q) {
      var hay = (s.name + ' ' + s.description + ' ' + (s.domain || []).join(' ') + ' ' +
        (s.discipline || []).join(' ') + ' ' + (s.software || []).join(' ')).toLowerCase();
      if (state.q.toLowerCase().split(/\s+/).some(function (t) { return t && hay.indexOf(t) === -1; })) return false;
    }
    return FACETS.every(function (f) {
      if (!state.filters[f].size) return true;
      return (s[f] || []).some(function (v) { return state.filters[f].has(v); });
    });
  }

  function card(s) {
    var domChips = (s.domain || []).map(function (d) { return '<span class="skill-chip dom">' + esc(d) + '</span>'; }).join('');
    var sw = (s.software || []).slice(0, 3).map(function (d) { return '<span class="skill-chip">' + esc(d) + '</span>'; }).join('');
    var ai = (s.ai_target || []).map(function (t) { return AI_LABEL[t] || t; }).join(', ');
    var rel = (s.related_resources && s.related_resources.length)
      ? '<div class="skill-meta"><span>🔗 Linked: ' + esc(s.related_resources.slice(0, 2).join(', ')) + '</span></div>' : '';
    return '<div class="col"><div class="skill-card h-100" data-skill="' + esc(s.id) + '" style="cursor:pointer">' +
      '<div class="skill-chips mb-2">' + domChips + '</div>' +
      '<h3 class="skill-title h6"><a href="skill.html?id=' + encodeURIComponent(s.id) + '" class="stretched-link-skill">' + esc(s.name) + '</a></h3>' +
      '<p class="skill-desc">' + esc(s.description) + '</p>' +
      '<div class="skill-chips">' + sw + '</div>' +
      '<div class="skill-meta">' +
        '<span>v' + esc(s.version) + '</span>' +
        '<span>' + esc(s.license) + '</span>' +
        '<span>🎯 ' + esc(ai) + '</span>' +
        '<span>⬇ ' + (s.install_count || 0).toLocaleString() + '</span>' +
        (s.has_eval ? '<span class="skill-badge-eval">✓ has eval</span>' : '') +
      '</div>' + rel +
      '<div class="skill-actions">' +
        '<button class="btn btn-sm btn-primary" data-install="' + esc(s.id) + '">Install</button>' +
        '<a class="btn btn-sm btn-outline-secondary" href="skill.html?id=' + encodeURIComponent(s.id) + '">View SKILL.md</a>' +
      '</div></div></div>';
  }

  function render() {
    var list = SKILLS.filter(matches);
    if (state.sort === 'name-asc') list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    else list.sort(function (a, b) { return (b.install_count || 0) - (a.install_count || 0); });

    document.getElementById('resultCount').textContent = list.length;
    var grid = document.getElementById('skillGrid');
    grid.innerHTML = list.map(card).join('');
    document.getElementById('emptyState').classList.toggle('d-none', list.length !== 0);
  }

  function showInstall(id) {
    var s = SKILLS.find(function (x) { return x.id === id; });
    if (!s) return;
    document.getElementById('installTitle').textContent = s.name;
    var body = document.getElementById('installBody');
    var related = (s.related_resources && s.related_resources.length)
      ? '<p class="small text-muted mb-3">Works well with catalog resources: <strong>' + esc(s.related_resources.join(', ')) + '</strong></p>' : '';
    body.innerHTML =
      '<p class="text-muted">' + esc(s.description) + '</p>' + related +
      '<h6 class="mt-3">Claude Desktop / Code</h6>' +
      '<code class="copyblk">/plugin marketplace add openconstruction/skills\n/plugin install ' + esc(s.id) + '@openconstruction</code>' +
      '<h6 class="mt-3">CLI</h6>' +
      '<code class="copyblk">npx @openconstruction/skills install ' + esc(s.id) + '</code>' +
      '<h6 class="mt-3">Manual</h6>' +
      '<code class="copyblk">git clone the skill folder into ~/.claude/skills/' + esc(s.id) + '/</code>' +
      '<p class="small text-muted mt-3 mb-0">Frontmatter: <code>domain=' + esc((s.domain || []).join(',')) +
        '</code> · <code>ai_target=' + esc((s.ai_target || []).join(',')) + '</code> · ' +
        (s.has_eval ? 'ships automated eval test cases.' : 'includes ' + (s.examples || 0) + ' worked example(s).') + '</p>' +
      '<div class="alert alert-light border mt-3 small mb-0">Demo catalog — install commands illustrate the intended UX. ' +
        'Skills are reviewed via PR like every other OpenConstruction resource.</div>';
    new bootstrap.Modal(document.getElementById('installModal')).show();
  }

  function bind() {
    document.getElementById('skillSearch').addEventListener('input', function (e) { state.q = e.target.value.trim(); render(); });
    document.getElementById('sortBy').addEventListener('change', function (e) { state.sort = e.target.value; render(); });
    document.querySelectorAll('.facet-list').forEach(function (host) {
      host.addEventListener('change', function (e) {
        var cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
        var set = state.filters[cb.dataset.field];
        if (cb.checked) set.add(cb.value); else set.delete(cb.value);
        render();
      });
    });
    document.getElementById('clearFilters').addEventListener('click', function () {
      FACETS.forEach(function (f) { state.filters[f].clear(); });
      document.querySelectorAll('.facet-list input:checked').forEach(function (c) { c.checked = false; });
      render();
    });
    document.getElementById('skillGrid').addEventListener('click', function (e) {
      var b = e.target.closest('[data-install]');
      if (b) { showInstall(b.dataset.install); return; }
      if (e.target.closest('a')) return; // let the title / "View SKILL.md" links navigate
      var card = e.target.closest('[data-skill]');
      if (card) location.href = 'skill.html?id=' + encodeURIComponent(card.dataset.skill);
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var data = await load('skills.json');
    if (!data || !Array.isArray(data.skills)) { document.getElementById('errorState').classList.remove('d-none'); return; }
    SKILLS = data.skills;
    FACETS.forEach(buildFacet);
    bind();
    render();
  });
})();
