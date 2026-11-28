/* Subtabs: one section of a screen at a time, picked from an icon + one-word-label bar.
   Shared copy: edit .shared/js/subtabs.js, then python3 .scripts/sync_shared.py --apply.
   Guideline and markup: .shared/README.md "Subtabs".

   Markup, inside one root element (a tab panel, a page section):
     <div class="ui-seg ui-subtabs" role="group" aria-label="Claude sections">
       <button type="button" data-view="usage"><i data-icon="chart"></i><span>Usage</span>
         <span class="ui-subtab-count"></span></button>
       …
     </div>
     <section class="ui-view" data-view="usage">…</section>   (data-view may list several views)

   Subtabs.init('claude', { root, onShow(view) {…}, aliases: { old: 'new' }, storageKey })
     root        element or selector holding the bar and its sections (default #tab-<id>)
     onShow      runs after every switch (load data lazily, redraw charts that measure their box)
     aliases     old view names still accepted from links and saved state
     storageKey  localStorage key for the last view (default <prefix>-<id>-view, where <prefix>
                 is this script tag's data-prefix, else "subtabs")
   The first view is ?view= (or ?sub=) when ?tab=<id> names this group, then the last one used,
   then the first button. Buttons switch on click by themselves (no handler needed); an app may
   also call Subtabs.show(id, view). One subtab group per root; a section may hold another
   group (its own root inside the section), which the outer group leaves alone.
   Subtabs.setCount(id, view, n, kind) puts a count on a button: kind '' (warning), 'quiet'
   (a total) or 'danger' (an alarm); 0 or '' clears it.
   On the full layout a bar too wide for its box (a card, a side panel) gets .stacked: the
   phone layout, icon over label (css/ui.css); re-checked whenever the box resizes.
   Pure helper resolveView is exported for Node. */
(function () {
    'use strict';

    /** First candidate that names a known view (after aliasing), else the first view. */
    function resolveView(views, candidates, aliases) {
        for (const raw of candidates || []) {
            if (!raw) continue;
            const v = (aliases && Object.prototype.hasOwnProperty.call(aliases, raw)) ? aliases[raw] : raw;
            if (views.includes(v)) return v;
        }
        return views[0];
    }

    const hasDom = typeof document !== 'undefined';
    const script = hasDom ? document.currentScript : null;
    const prefix = (script && script.dataset && script.dataset.prefix) || 'subtabs';
    const groups = Object.create(null);   // id -> { root, views, opts, key, view }

    function rootOf(id, opts) {
        const r = opts && opts.root;
        if (r && typeof r === 'object') return r;
        return document.querySelector(r || '#tab-' + id);
    }

    // A group may hold another group inside one of its sections (a home screen's Stats section
    // with its own Overview / CPUs bar): a bar or section belongs to this group only when no
    // .ui-view of this group lies between it and the root.
    function own(root, el) {
        const v = el.parentElement && el.parentElement.closest('.ui-view');
        return !v || v === root || !root.contains(v);
    }

    function buttons(root) {
        return Array.from(root.querySelectorAll('.ui-subtabs > button[data-view]')).filter(b => own(root, b.parentElement));
    }

    function button(root, view) {
        return buttons(root).find(b => b.dataset.view === view) || null;
    }

    function paint(g) {
        // A section may serve several views (data-view="jobs problems pinned"): shown for any of them.
        g.root.querySelectorAll('.ui-view[data-view]').forEach(sec => {
            if (!own(g.root, sec)) return;
            sec.hidden = !sec.dataset.view.split(/\s+/).includes(g.view);
        });
        buttons(g.root).forEach(b => {
            const on = b.dataset.view === g.view;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function show(id, view, opts) {
        const g = groups[id];
        if (!g) return;
        const next = resolveView(g.views, [view], g.opts.aliases);
        const changed = next !== g.view;
        g.view = next;
        paint(g);
        try { localStorage.setItem(g.key, next); } catch (e) { /* private mode */ }
        if (changed && !(opts && opts.keepScroll)) window.scrollTo({ top: 0 });
        if (typeof g.opts.onShow === 'function') g.opts.onShow(next);
    }

    function init(id, opts) {
        opts = opts || {};
        const root = rootOf(id, opts);
        if (!root) return null;
        const views = buttons(root).map(b => b.dataset.view);
        if (!views.length) return null;
        const g = groups[id] = { root, views, opts, key: opts.storageKey || prefix + '-' + id + '-view', view: null };
        buttons(root).forEach(b => {
            if (!b.hasAttribute('type')) b.type = 'button';
            if (b.dataset.subtabsBound) return;
            b.dataset.subtabsBound = '1';
            b.addEventListener('click', () => show(id, b.dataset.view));
        });
        const q = new URLSearchParams(location.search);
        const fromUrl = q.get('tab') === id ? (q.get('view') || q.get('sub')) : null;
        let saved = null;
        try { saved = localStorage.getItem(g.key); } catch (e) { /* private mode */ }
        show(id, resolveView(views, [fromUrl, saved], opts.aliases), { keepScroll: true });
        new Set(buttons(root).map(b => b.parentElement)).forEach(watchFit);
        return g.view;
    }

    // — Full layout in a narrow box: stack the bar when its row doesn't fit —
    const FULL = '(min-width: 481px) and (min-height: 500px)';
    const fitted = hasDom ? new WeakSet() : null;
    function fit(bar) {
        const full = window.matchMedia && window.matchMedia(FULL).matches;
        bar.classList.remove('stacked');
        if (full && bar.clientWidth && bar.scrollWidth > bar.clientWidth + 1) bar.classList.add('stacked');
    }
    function watchFit(bar) {
        if (fitted.has(bar)) return fit(bar);
        fitted.add(bar);
        fit(bar);
        // The parent's width, not the bar's own (stacking changes the bar, which would loop)
        if (typeof ResizeObserver === 'function' && bar.parentElement) {
            new ResizeObserver(() => fit(bar)).observe(bar.parentElement);
        }
        if (window.matchMedia) {
            const mq = window.matchMedia(FULL);
            if (mq.addEventListener) mq.addEventListener('change', () => fit(bar));
        }
    }

    function current(id) { return groups[id] ? groups[id].view : null; }

    /** Set (or clear, with 0/'') the small count on a subtab button; kind: '', 'quiet', 'danger'. */
    function setCount(id, view, n, kind) {
        const g = groups[id];
        const root = g ? g.root : rootOf(id, null);
        const b = root && button(root, view);
        if (!b) return;
        let el = b.querySelector('.ui-subtab-count');
        if (!el) {
            el = document.createElement('span');
            el.className = 'ui-subtab-count';
            b.appendChild(el);
        }
        if (kind !== undefined) {
            el.classList.toggle('quiet', kind === 'quiet');
            el.classList.toggle('danger', kind === 'danger');
        }
        el.textContent = n ? String(n) : '';
        if (fitted && fitted.has(b.parentElement)) fit(b.parentElement);   // a count widens the row
    }

    const api = { init, show, current, setCount, resolveView };
    if (typeof window !== 'undefined') window.Subtabs = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
