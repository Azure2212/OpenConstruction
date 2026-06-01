// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
// Q1 — Lightweight account layer (DEMO, client-side only). Stores a demo identity,
// bookmarks, and contribution stubs in localStorage ($0, no backend) and injects an
// account control into the navbar. In production this is replaced by real GitHub
// OAuth + a profile service. Exposes window.OCAccount.

(function () {
  'use strict';

  var K_USER = 'oc_account_v1';
  var K_BM = 'oc_bookmarks_v1';
  var K_CONTRIB = 'oc_contributions_v1';
  var listeners = [];

  function read(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} fire(); }
  function fire() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }

  // Relative path to root (detail pages live under datasets/ , models/).
  var PREFIX = /\/(datasets|models)\//.test(location.pathname) ? '../' : '';

  var API = {
    getUser: function () { return read(K_USER, null); },
    signIn: function (handle) {
      handle = (handle || '').replace(/^@/, '').trim() || 'aec-pro';
      var u = { handle: handle, name: handle.replace(/[-_]/g, ' '), since: Date.now(), demo: true };
      write(K_USER, u); return u;
    },
    signOut: function () { try { localStorage.removeItem(K_USER); } catch (e) {} fire(); },
    onChange: function (cb) { listeners.push(cb); },

    getBookmarks: function () { return read(K_BM, []); },
    isBookmarked: function (id) { return API.getBookmarks().some(function (b) { return b.id === id; }); },
    toggleBookmark: function (item) {
      // item: { id, type, title, url }
      var list = API.getBookmarks();
      var i = list.findIndex(function (b) { return b.id === item.id; });
      if (i >= 0) { list.splice(i, 1); } else { list.unshift(Object.assign({ ts: Date.now() }, item)); }
      write(K_BM, list);
      return i < 0; // true if now bookmarked
    },

    getContributions: function () { return read(K_CONTRIB, []); },
    addContribution: function (c) {
      var list = API.getContributions();
      list.unshift(Object.assign({ ts: Date.now() }, c));
      write(K_CONTRIB, list);
    },

    // Badges are derived from activity (illustrative thresholds).
    getBadges: function () {
      var bm = API.getBookmarks().length, co = API.getContributions().length, out = [];
      if (API.getUser()) out.push({ key: 'member', label: 'Member', icon: '🪪' });
      if (bm >= 1) out.push({ key: 'curator', label: 'Curator', icon: '🔖' });
      if (bm >= 10) out.push({ key: 'collector', label: 'Collector', icon: '📚' });
      if (co >= 1) out.push({ key: 'contributor', label: 'Contributor', icon: '✍️' });
      if (co >= 5) out.push({ key: 'steward', label: 'Steward', icon: '🛡️' });
      return out;
    },

    profileUrl: function () { return PREFIX + 'profile.html'; }
  };
  window.OCAccount = API;

  // ---- Navbar control ----------------------------------------------------
  function navHtml() {
    var u = API.getUser();
    if (!u) {
      return '<a class="nav-link plain" href="#" id="ocSignIn">Sign in</a>';
    }
    var initial = (u.handle[0] || '?').toUpperCase();
    return '<a class="nav-link plain dropdown-toggle d-flex align-items-center gap-2" href="#" id="ocAcctMenu" ' +
      'role="button" data-bs-toggle="dropdown" aria-expanded="false">' +
      '<span class="oc-avatar">' + initial + '</span><span class="d-none d-lg-inline">@' + esc(u.handle) + '</span></a>' +
      '<ul class="dropdown-menu dropdown-menu-end" aria-labelledby="ocAcctMenu">' +
        '<li><a class="dropdown-item" href="' + API.profileUrl() + '">My profile</a></li>' +
        '<li><a class="dropdown-item" href="' + API.profileUrl() + '#bookmarks">Bookmarks</a></li>' +
        '<li><hr class="dropdown-divider"></li>' +
        '<li><a class="dropdown-item" href="#" id="ocSignOut">Sign out</a></li>' +
      '</ul>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  function promptSignIn() {
    var h = window.prompt('Demo sign-in — enter a GitHub-style handle (no real auth):', 'aec-pro');
    if (h !== null) API.signIn(h);
  }

  function renderNav() {
    var nav = document.querySelector('.navbar-nav');
    if (!nav) return;
    var li = document.getElementById('ocAcctItem');
    if (!li) {
      li = document.createElement('li');
      li.className = 'nav-item dropdown';
      li.id = 'ocAcctItem';
      nav.appendChild(li);
    }
    li.innerHTML = navHtml();
    var si = document.getElementById('ocSignIn');
    if (si) si.addEventListener('click', function (e) { e.preventDefault(); promptSignIn(); });
    var so = document.getElementById('ocSignOut');
    if (so) so.addEventListener('click', function (e) { e.preventDefault(); API.signOut(); });
  }

  // Minimal styles for the avatar chip.
  var css = document.createElement('style');
  css.textContent = '.oc-avatar{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:999px;' +
    'background:#0f2e4b;color:#fff;font-size:.78rem;font-weight:700;}';
  document.head.appendChild(css);

  API.onChange(renderNav);
  document.addEventListener('DOMContentLoaded', renderNav);
})();
