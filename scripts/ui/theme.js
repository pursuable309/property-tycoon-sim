/*
 * Shared theme switch: System / Light / Dark for the web apps.
 * Canonical copy in .shared/js/; edit it there and run .scripts/sync_shared.py --apply.
 *
 * Load it in <head>, before the stylesheets and without defer/async, so a forced theme is set
 * before the first paint:
 *   <script src="js/theme.js" data-key="myapp-theme"></script>
 * data-key    localStorage key holding 'system' | 'light' | 'dark' (default 'theme').
 * data-field  optional: the key holds a JSON object and the choice is this field of it (the
 *             app owns that object; 'auto' reads as 'system'). Call Theme.refresh() after saving it.
 *
 * What it sets on <html>:
 *   data-theme="light|dark" only when forced (System removes it), so CSS keys dark tokens on
 *     @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {...} }
 *     :root[data-theme="dark"] {...}
 *   data-bs-theme = the resolved theme, only if <html> already has data-bs-theme (Bootstrap).
 * <meta name="theme-color" data-light="#..." data-dark="#..."> gets the resolved colour.
 *
 * API: Theme.get() -> preference, Theme.resolved() -> 'light' | 'dark', Theme.set(pref),
 * Theme.refresh(). A 'themechange' event ({detail: {pref, theme}}) fires on document.
 */
(function () {
  'use strict';
  var PREFS = ['system', 'light', 'dark'];
  var script = document.currentScript;
  var KEY = (script && script.getAttribute('data-key')) || 'theme';
  var FIELD = script && script.getAttribute('data-field');
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function clean(v) {
    if (v === 'auto') return 'system';
    return PREFS.indexOf(v) >= 0 ? v : 'system';
  }

  function readObject() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (e) { return null; }
  }

  function get() {
    try {
      if (FIELD) { var o = readObject(); return clean(o ? o[FIELD] : null); }
      return clean(localStorage.getItem(KEY));
    } catch (e) { return 'system'; }
  }

  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return mq && mq.matches ? 'dark' : 'light';
  }

  function paintMeta(theme) {
    var metas = document.querySelectorAll('meta[name="theme-color"][data-light]');
    for (var i = 0; i < metas.length; i++) {
      var c = metas[i].getAttribute(theme === 'dark' ? 'data-dark' : 'data-light');
      if (c) metas[i].setAttribute('content', c);
    }
  }

  var last = null;
  function apply() {
    var pref = current();
    var theme = resolve(pref);
    if (pref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    if (root.hasAttribute('data-bs-theme')) root.setAttribute('data-bs-theme', theme);
    paintMeta(theme);
    var sig = pref + '/' + theme;
    if (sig !== last) {
      last = sig;
      try { document.dispatchEvent(new CustomEvent('themechange', { detail: { pref: pref, theme: theme } })); } catch (e) { /* old browser */ }
    }
    return theme;
  }

  // Remembers the choice when storage refuses the write, so this page still follows it.
  var override = null;
  function current() { return override || get(); }

  function set(pref) {
    pref = clean(pref);
    override = null;
    try {
      if (FIELD) {
        var o = readObject() || {};
        o[FIELD] = pref;
        localStorage.setItem(KEY, JSON.stringify(o));
      } else {
        localStorage.setItem(KEY, pref);
      }
    } catch (e) { override = pref; }
    return apply();
  }

  window.Theme = {
    get: current,
    resolved: function () { return resolve(current()); },
    set: set,
    refresh: function () { override = null; return apply(); },
  };

  apply();
  // The meta tags after this script aren't parsed yet: paint them once the head is in.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  if (mq) {
    var onChange = function () { if (current() === 'system') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  // Another tab of the same app changed it.
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(); });
})();
