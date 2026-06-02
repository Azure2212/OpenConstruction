// Copyright (c) 2024-2026 OpenConstruction Open Science Initiative
// SPDX-License-Identifier: Apache-2.0
//
// skill-ratings.js — community "star" rating for the Skill catalog (Q4).
//
// DEMO / $0: a user's stars are stored in localStorage (1 star per browser).
// Each skill carries a synthetic `stars_seed` baseline so the ranking is
// meaningful out of the box. In production this becomes a `skill_ratings`
// table on the professor's Supabase, gated by sign-in (1 star per real user),
// which also removes the gaming/sybil problem this local demo cannot.
//
// Exposes window.OCSkillRate. Reused by skills.js (catalog) and skill-detail.js.

(function () {
  'use strict';
  var KEY = 'oc_skill_stars';

  function mine() {
    try { var a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }

  function isStarred(id) { return mine().indexOf(id) !== -1; }

  function toggle(id) {
    var a = mine(); var i = a.indexOf(id);
    if (i === -1) a.push(id); else a.splice(i, 1);
    save(a);
    return i === -1; // true = now starred
  }

  // Total shown = synthetic community baseline + this browser's own star.
  function total(skill) {
    var seed = +(skill && skill.stars_seed) || 0;
    return seed + (skill && isStarred(skill.id) ? 1 : 0);
  }

  // Composite trust score for "Verified first -> stars" sorting (cold-start fix:
  // a verified-but-new skill still outranks an unverified popular one).
  function trustScore(skill) {
    return (skill && skill.verified ? 100000 : 0) + total(skill);
  }

  function injectStyles() {
    if (document.getElementById('oc-skill-rate-style')) return;
    var css = document.createElement('style');
    css.id = 'oc-skill-rate-style';
    css.textContent =
      '.oc-star-btn{display:inline-flex;align-items:center;gap:.3rem;border:1px solid #e3b341;background:#fffdf5;' +
      'color:#8a6d11;border-radius:999px;padding:.16rem .55rem;font-size:.82rem;font-weight:700;cursor:pointer;line-height:1;}' +
      '.oc-star-btn:hover{background:#fff7df;}' +
      '.oc-star-btn.on{background:#ffe9a8;border-color:#d9a520;color:#6b5300;}' +
      '.oc-star-btn .oc-star-ic{font-size:.95em;}' +
      '.oc-badge-verified{display:inline-flex;align-items:center;gap:.25rem;background:#e7f6ec;color:#1a7f3c;' +
      'border:1px solid #b6e3c5;border-radius:999px;padding:.12rem .5rem;font-size:.74rem;font-weight:800;}' +
      '.oc-badge-origin{display:inline-flex;align-items:center;background:#eef3f8;color:#41566b;border:1px solid #d7e3ef;' +
      'border-radius:999px;padding:.12rem .5rem;font-size:.74rem;font-weight:700;text-transform:capitalize;}' +
      '.oc-badge-origin.official{background:#eaf0fb;}' +
      '.oc-fresh{color:#6b7886;font-size:.78rem;}';
    document.head.appendChild(css);
  }

  // Markup for a star button (caller wires the click via [data-oc-star]).
  function starButtonHtml(skill) {
    var on = isStarred(skill.id);
    return '<button type="button" class="oc-star-btn' + (on ? ' on' : '') + '" data-oc-star="' + skill.id +
      '" aria-pressed="' + (on ? 'true' : 'false') + '" title="Star this skill (demo)">' +
      '<span class="oc-star-ic" aria-hidden="true">' + (on ? '★' : '☆') + '</span>' +
      '<span class="oc-star-count">' + total(skill) + '</span></button>';
  }

  function verifiedBadgeHtml(skill) {
    return skill.verified ? '<span class="oc-badge-verified" title="Ships an automated eval test suite">✓ Verified</span>' : '';
  }
  function originBadgeHtml(skill) {
    var o = skill.origin || 'community';
    return '<span class="oc-badge-origin ' + o + '">' + o + '</span>';
  }
  function freshHtml(skill) {
    return skill.last_reviewed ? '<span class="oc-fresh">Reviewed ' + skill.last_reviewed + '</span>' : '';
  }

  window.OCSkillRate = {
    isStarred: isStarred, toggle: toggle, total: total, trustScore: trustScore,
    injectStyles: injectStyles, starButtonHtml: starButtonHtml,
    verifiedBadgeHtml: verifiedBadgeHtml, originBadgeHtml: originBadgeHtml, freshHtml: freshHtml
  };
})();
