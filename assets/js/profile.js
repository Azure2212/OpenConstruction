// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q1 — Profile page renderer. Reads window.OCAccount (demo, localStorage) and shows
// the signed-in identity, bookmarks, contributions, and derived badges.

(function () {
  'use strict';
  var yn = document.getElementById('yearNow'); if (yn) yn.textContent = new Date().getFullYear();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function when(ts) { try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; } }

  function bookmarkRow(b) {
    var url = b.url || '#';
    return '<div class="pf-item">' +
      '<a class="t" href="' + esc(url) + '">' + esc(b.title || b.id) + '</a>' +
      '<span class="d-flex align-items-center gap-2">' +
        '<span class="pf-type">' + esc(b.type || 'item') + '</span>' +
        '<button class="btn btn-sm btn-link text-danger p-0 small" data-unbm="' + esc(b.id) + '">remove</button>' +
      '</span></div>';
  }
  function contribRow(c) {
    return '<div class="pf-item">' +
      '<span class="t">' + esc(c.title || '(untitled)') + '</span>' +
      '<span class="d-flex align-items-center gap-2">' +
        '<span class="pf-type">' + esc(c.type || 'resource') + '</span>' +
        '<span class="small text-muted">' + when(c.ts) + '</span>' +
        '<span class="pf-type" style="background:#fff6e6;color:#9a6b00;border-color:#f3d79a">' + esc(c.status || 'draft') + '</span>' +
      '</span></div>';
  }

  function render() {
    var A = window.OCAccount;
    var u = A && A.getUser();
    var so = document.getElementById('signedOut');
    var si = document.getElementById('signedIn');
    if (!A) return;

    if (!u) {
      so.classList.remove('d-none'); si.classList.add('d-none');
      return;
    }
    so.classList.add('d-none'); si.classList.remove('d-none');

    document.getElementById('pfAvatar').textContent = (u.handle[0] || '?').toUpperCase();
    document.getElementById('pfName').textContent = u.name || u.handle;
    document.getElementById('pfHandle').textContent = '@' + u.handle;

    var badges = A.getBadges();
    document.getElementById('pfBadges').innerHTML = badges.length
      ? badges.map(function (b) { return '<span class="pf-badge">' + b.icon + ' ' + esc(b.label) + '</span>'; }).join('')
      : '<span class="text-muted small">No badges yet — bookmark a resource or contribute one.</span>';

    var bms = A.getBookmarks();
    document.getElementById('bmCount').textContent = bms.length ? '(' + bms.length + ')' : '';
    document.getElementById('bmList').innerHTML = bms.length
      ? bms.map(bookmarkRow).join('')
      : '<div class="pf-empty">No bookmarks yet. Use the 🔖 Save button on a resource or skill page.</div>';

    var cos = A.getContributions();
    document.getElementById('coCount').textContent = cos.length ? '(' + cos.length + ')' : '';
    document.getElementById('coList').innerHTML = cos.length
      ? cos.map(contribRow).join('')
      : '<div class="pf-empty">No contributions yet. Submit one through the no-Git wizard.</div>';
  }

  document.addEventListener('DOMContentLoaded', function () {
    render();
    var A = window.OCAccount;
    if (A) A.onChange(render);

    var si = document.getElementById('pfSignIn');
    if (si) si.addEventListener('click', function () {
      var h = window.prompt('Demo sign-in — enter a GitHub-style handle (no real auth):', 'aec-pro');
      if (h !== null && A) A.signIn(h);
    });
    var so = document.getElementById('pfSignOut');
    if (so) so.addEventListener('click', function () { if (A) A.signOut(); });

    document.getElementById('bmList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-unbm]'); if (!b || !A) return;
      var list = A.getBookmarks().find(function (x) { return x.id === b.dataset.unbm; });
      if (list) A.toggleBookmark(list); // toggles off
    });
  });
})();
