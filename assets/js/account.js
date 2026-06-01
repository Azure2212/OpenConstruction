// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q1 — Lightweight account layer (DEMO, client-side only). Models the three things the
// open question raises: (1) user login via multiple providers, (2) user management with
// roles, (3) a contributor portal (bookmarks + contributions). Everything is stored in
// localStorage ($0, no backend) and clearly labelled demo; production replaces this with
// real OAuth (GitHub / ORCID / email) and a server-side profile + roles service.

(function () {
  'use strict';

  var K_USER = 'oc_account_v1';
  var K_BM = 'oc_bookmarks_v1';
  var K_CONTRIB = 'oc_contributions_v1';
  var K_USERS = 'oc_users_v1';
  var listeners = [];

  var ROLES = ['Contributor', 'Reviewer', 'Maintainer'];
  var PROVIDERS = {
    github: { label: 'GitHub', icon: '🐙' },
    orcid: { label: 'ORCID', icon: '🆔' },
    email: { label: 'Email', icon: '✉️' }
  };

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} fire(); }
  function fire() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  // Relative path to root (detail pages live under datasets/ , models/).
  var PREFIX = /\/(datasets|models)\//.test(location.pathname) ? '../' : '';

  // Seed a few demo users so the user-management view has something to manage.
  function seedUsers() {
    if (read(K_USERS, null)) return;
    write(K_USERS, [
      { handle: 'ruoxinx', name: 'Ruoxin X.', provider: 'github', role: 'Maintainer', contributions: 24, demo: true },
      { handle: 'jane-eng', name: 'Jane Eng', provider: 'orcid', role: 'Reviewer', contributions: 11, demo: true },
      { handle: 'bim-lab', name: 'BIM Lab', provider: 'github', role: 'Contributor', contributions: 7, demo: true },
      { handle: 'site-safety', name: 'Site Safety', provider: 'email', role: 'Contributor', contributions: 3, demo: true }
    ]);
  }
  function upsertUser(u) {
    seedUsers();
    var list = read(K_USERS, []);
    var i = list.findIndex(function (x) { return x.handle === u.handle; });
    if (i >= 0) { list[i] = Object.assign({}, list[i], { provider: u.provider, name: u.name }); }
    else { list.unshift({ handle: u.handle, name: u.name, provider: u.provider, role: 'Contributor', contributions: 0, demo: true }); }
    write(K_USERS, list);
    return list.find(function (x) { return x.handle === u.handle; });
  }

  var API = {
    ROLES: ROLES,
    PROVIDERS: PROVIDERS,

    getUser: function () { return read(K_USER, null); },
    signIn: function (provider, handle) {
      provider = PROVIDERS[provider] ? provider : 'github';
      handle = (handle || '').replace(/^@/, '').trim() || 'aec-pro';
      var rec = upsertUser({ handle: handle, name: handle.replace(/[-_]/g, ' '), provider: provider });
      var u = { handle: handle, name: rec.name, provider: provider, role: rec.role || 'Contributor', since: Date.now(), demo: true };
      write(K_USER, u); return u;
    },
    signOut: function () { try { localStorage.removeItem(K_USER); } catch (e) {} fire(); },
    onChange: function (cb) { listeners.push(cb); },

    getBookmarks: function () { return read(K_BM, []); },
    isBookmarked: function (id) { return API.getBookmarks().some(function (b) { return b.id === id; }); },
    toggleBookmark: function (item) {
      var list = API.getBookmarks();
      var i = list.findIndex(function (b) { return b.id === item.id; });
      if (i >= 0) { list.splice(i, 1); } else { list.unshift(Object.assign({ ts: Date.now() }, item)); }
      write(K_BM, list);
      return i < 0;
    },

    getContributions: function () { return read(K_CONTRIB, []); },
    addContribution: function (c) {
      var list = API.getContributions();
      list.unshift(Object.assign({ ts: Date.now() }, c));
      write(K_CONTRIB, list);
    },

    // ---- user management (demo) ----
    getUsers: function () { seedUsers(); return read(K_USERS, []); },
    setUserRole: function (handle, role) {
      var list = API.getUsers();
      var i = list.findIndex(function (x) { return x.handle === handle; });
      if (i >= 0) { list[i].role = role; write(K_USERS, list); }
      var u = API.getUser();
      if (u && u.handle === handle) { u.role = role; write(K_USER, u); }
    },

    getBadges: function () {
      var bm = API.getBookmarks().length, co = API.getContributions().length, u = API.getUser(), out = [];
      if (u) out.push({ key: 'member', label: 'Member', icon: '🪪' });
      if (u && u.role && u.role !== 'Contributor') out.push({ key: 'role', label: u.role, icon: '🛡️' });
      if (bm >= 1) out.push({ key: 'curator', label: 'Curator', icon: '🔖' });
      if (bm >= 10) out.push({ key: 'collector', label: 'Collector', icon: '📚' });
      if (co >= 1) out.push({ key: 'contributor', label: 'Contributor', icon: '✍️' });
      if (co >= 5) out.push({ key: 'steward', label: 'Steward', icon: '🏅' });
      return out;
    },

    profileUrl: function () { return PREFIX + 'profile.html'; },
    adminUrl: function () { return PREFIX + 'admin.html'; },

    // ---- sign-in modal ----
    openSignIn: function () {
      if (!window.bootstrap) { // fallback if Bootstrap JS not present
        var h = window.prompt('Demo sign-in — enter a handle (no real auth):', 'aec-pro');
        if (h !== null) API.signIn('github', h);
        return;
      }
      var id = 'ocSignInModal';
      var old = document.getElementById(id); if (old) old.remove();
      var wrap = document.createElement('div');
      wrap.className = 'modal fade'; wrap.id = id; wrap.tabIndex = -1;
      wrap.innerHTML =
        '<div class="modal-dialog modal-dialog-centered"><div class="modal-content p-2">' +
        '<div class="modal-header"><h5 class="modal-title">Sign in ' +
          '<span style="font-size:.65rem;font-weight:700;color:#9a6b00;background:#fff6e6;border:1px solid #f3d79a;border-radius:999px;padding:.1rem .5rem;vertical-align:middle">demo</span></h5>' +
          '<button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>' +
        '<div class="modal-body">' +
          '<p class="small text-muted">No real authentication — this previews the login UX. ' +
          'Production would use real OAuth. Pick a provider:</p>' +
          '<label class="form-label small fw-semibold">Handle / ID</label>' +
          '<input id="ocSiHandle" class="form-control mb-3" value="aec-pro">' +
          '<div class="d-grid gap-2">' +
            '<button class="btn btn-dark" data-prov="github">🐙 Continue with GitHub</button>' +
            '<button class="btn" style="background:#a6ce39;color:#063b00;font-weight:600" data-prov="orcid">🆔 Continue with ORCID</button>' +
            '<button class="btn btn-outline-secondary" data-prov="email">✉️ Email magic link</button>' +
          '</div>' +
          '<p class="small text-muted mt-3 mb-0">GitHub stays the primary identity (source of truth); ' +
          'ORCID suits researchers and email covers everyone else.</p>' +
        '</div></div></div>';
      document.body.appendChild(wrap);
      var m = new window.bootstrap.Modal(wrap);
      wrap.addEventListener('hidden.bs.modal', function () { wrap.remove(); });
      wrap.querySelectorAll('[data-prov]').forEach(function (b) {
        b.addEventListener('click', function () {
          var handle = (document.getElementById('ocSiHandle').value || 'aec-pro');
          API.signIn(b.dataset.prov, handle);
          m.hide();
        });
      });
      m.show();
    }
  };
  window.OCAccount = API;

  // ---- Navbar control ----------------------------------------------------
  function navHtml() {
    var u = API.getUser();
    if (!u) return '<a class="nav-link plain" href="#" id="ocSignIn">Sign in</a>';
    var initial = (u.handle[0] || '?').toUpperCase();
    var prov = (PROVIDERS[u.provider] || PROVIDERS.github).icon;
    return '<a class="nav-link plain dropdown-toggle d-flex align-items-center gap-2" href="#" id="ocAcctMenu" ' +
      'role="button" data-bs-toggle="dropdown" aria-expanded="false">' +
      '<span class="oc-avatar">' + esc(initial) + '</span>' +
      '<span class="d-none d-lg-inline">' + prov + ' @' + esc(u.handle) + '</span></a>' +
      '<ul class="dropdown-menu dropdown-menu-end" aria-labelledby="ocAcctMenu">' +
        '<li><span class="dropdown-item-text small text-muted">Role: <strong>' + esc(u.role || 'Contributor') + '</strong></span></li>' +
        '<li><hr class="dropdown-divider"></li>' +
        '<li><a class="dropdown-item" href="' + API.profileUrl() + '">My profile</a></li>' +
        '<li><a class="dropdown-item" href="' + API.profileUrl() + '#bookmarks">Bookmarks</a></li>' +
        '<li><a class="dropdown-item" href="' + API.adminUrl() + '">User management</a></li>' +
        '<li><hr class="dropdown-divider"></li>' +
        '<li><a class="dropdown-item" href="#" id="ocSignOut">Sign out</a></li>' +
      '</ul>';
  }

  function renderNav() {
    var nav = document.querySelector('.navbar-nav');
    if (!nav) return;
    var li = document.getElementById('ocAcctItem');
    if (!li) { li = document.createElement('li'); li.className = 'nav-item dropdown'; li.id = 'ocAcctItem'; nav.appendChild(li); }
    li.innerHTML = navHtml();
    var si = document.getElementById('ocSignIn');
    if (si) si.addEventListener('click', function (e) { e.preventDefault(); API.openSignIn(); });
    var so = document.getElementById('ocSignOut');
    if (so) so.addEventListener('click', function (e) { e.preventDefault(); API.signOut(); });
  }

  var css = document.createElement('style');
  css.textContent = '.oc-avatar{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:999px;' +
    'background:#0f2e4b;color:#fff;font-size:.78rem;font-weight:700;}';
  document.head.appendChild(css);

  seedUsers();
  API.onChange(renderNav);
  document.addEventListener('DOMContentLoaded', renderNav);
})();
