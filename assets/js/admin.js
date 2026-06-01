// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q1 — User management page (DEMO). Lists users from window.OCAccount and lets a
// maintainer change roles. Client-side only; production is server-backed.

(function () {
  'use strict';
  var yn = document.getElementById('yearNow'); if (yn) yn.textContent = new Date().getFullYear();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  function row(u, A, isMe) {
    var prov = (A.PROVIDERS[u.provider] || A.PROVIDERS.github);
    var opts = A.ROLES.map(function (r) {
      return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
    }).join('');
    return '<tr>' +
      '<td><span class="d-flex align-items-center gap-2">' +
        '<span class="ad-avatar">' + esc((u.handle[0] || '?').toUpperCase()) + '</span>' +
        '<span><span class="fw-semibold" style="color:#0f2e4b">' + esc(u.name || u.handle) + '</span>' +
        (isMe ? ' <span class="badge bg-light text-dark border">you</span>' : '') +
        '<br><span class="small text-muted">@' + esc(u.handle) + '</span></span>' +
      '</span></td>' +
      '<td class="small">' + prov.icon + ' ' + esc(prov.label) + '</td>' +
      '<td class="small">' + (u.contributions || 0) + '</td>' +
      '<td><select class="form-select form-select-sm" data-role-for="' + esc(u.handle) + '">' + opts + '</select></td>' +
      '</tr>';
  }

  function render() {
    var A = window.OCAccount; if (!A) return;
    var me = A.getUser();
    document.getElementById('needSignin').classList.toggle('d-none', !!me);
    document.getElementById('adminBody').classList.toggle('d-none', !me);
    if (!me) return;

    var users = A.getUsers();
    document.getElementById('userCount').textContent = '(' + users.length + ')';
    document.getElementById('userRows').innerHTML = users.map(function (u) {
      return row(u, A, u.handle === me.handle);
    }).join('');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var A = window.OCAccount;
    render();
    if (A) A.onChange(render);

    var si = document.getElementById('adSignIn');
    if (si) si.addEventListener('click', function () { if (A) A.openSignIn(); });

    document.getElementById('userRows').addEventListener('change', function (e) {
      var sel = e.target.closest('[data-role-for]'); if (!sel || !A) return;
      A.setUserRole(sel.dataset.roleFor, sel.value);
    });
  });
})();
