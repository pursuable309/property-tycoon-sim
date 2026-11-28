/**
 * ui-check layout checks, run in the page right before each screenshot.
 *
 * Generic and selector-light: "tappable" means a visible button / input /
 * select / textarea / link / [role=button|tab|switch|checkbox] / summary, or
 * the outermost element with cursor:pointer (board tiles, player cards).
 * Elements inside [inert] or aria-hidden subtrees, hidden ones, and ones a
 * hit test shows to be underneath another layer (a sheet's backdrop) are
 * skipped, so a sheet's checks only see the sheet.
 *
 * Also two accessibility checks: WCAG text contrast (`contrast`) and the
 * 24px target size (`tap-size`), grouped so one bad token is one line.
 *
 * Returns { issues: [{ sev: 'fail'|'warn'|'info', check, msg, el, rect }], info }.
 * 'info' is a note, not an issue (never counted as a warning or failure).
 * The app-specific selectors come from the app's adapter (`checkCfg`),
 * merged over the defaults below; the checks still run (minus the part a
 * missing selector feeds) if they don't match anything.
 */
const CHECK_CFG = {
    toast: '.notification',                       // shared toasts (notifications.js)
    cards: null,                                  // cards toasts must never cover (PT: player cards)
    ignore: null,                                 // harness overlays to leave out
    tol: 2,                                       // px tolerance for every geometric test
    // contrast: content muted on purpose (disabled, out of play): a note, not an issue
    muted: ':disabled, [aria-disabled="true"]',
    dimOpacity: 0.6,                              // contrast: ancestors' opacity at or below this = dimmed on purpose
    // tap-size: targets packed edge to edge that are small by design (PT's board
    // tiles): one note instead of a warning, with tileNote as the reason
    tile: null,
    tileNote: 'small by design',
    // hscroll: rows that scroll sideways on purpose (the shared .ui-chips filter row)
    hscrollOk: '.is-scroll, [data-hscroll], .ui-chips:not(.wrap)',
    // text-ellipsis / text-clamped: text cut with "…" or a line clamp by design
    // (full text a tap away): a note instead of a failure. None by default
    ellipsisOk: null,
};

function runChecks(cfg) {
    const W = window.innerWidth, H = window.innerHeight, T = cfg.tol;
    const issues = [];
    const add = (sev, check, msg, el) => issues.push({ sev, check, msg, el: el ? describe(el) : '', rect: el ? box(el) : null });

    function describe(el) {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        const cls = [...el.classList].filter(c => !/^(is-|show$)/.test(c)).slice(0, 3);
        if (cls.length) s += '.' + cls.join('.');
        const label = (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return label ? `${s} "${label}"` : s;
    }
    function box(el) {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    }
    const inter = (a, b) => {
        const l = Math.max(a.left, b.left), t = Math.max(a.top, b.top);
        const r = Math.min(a.right, b.right), btm = Math.min(a.bottom, b.bottom);
        return r > l && btm > t ? { left: l, top: t, right: r, bottom: btm, width: r - l, height: btm - t } : null;
    };
    const rectOf = el => el.getBoundingClientRect();
    const hiddenTree = el => !!el.closest('[inert], [aria-hidden="true"], [hidden]') || (cfg.ignore && el.closest(cfg.ignore));
    const shown = el => {
        if (hiddenTree(el)) return false;
        const r = rectOf(el);
        if (r.width <= 2 || r.height <= 2) return false;   // hidden, or visually-hidden (sr-only) text
        // Closed <details>, content-visibility, display/visibility/opacity
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
        if (el.closest('details:not([open]) > :not(summary)')) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        let p = el;
        while (p && p !== document.documentElement) {
            if (parseFloat(getComputedStyle(p).opacity) < 0.05) return false;
            p = p.parentElement;
        }
        return true;
    };
    const overflowOf = el => { const cs = getComputedStyle(el); return [cs.overflowX, cs.overflowY]; };
    const scrollable = (el, axis) => {
        const [ox, oy] = overflowOf(el);
        const o = axis === 'x' ? ox : oy;
        if (!/(auto|scroll)/.test(o)) return false;
        return axis === 'x' ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
    };
    const docScrollsY = () => document.scrollingElement.scrollHeight > H + 1 &&
        !/hidden|clip/.test(getComputedStyle(document.body).overflowY) &&
        !/hidden|clip/.test(getComputedStyle(document.documentElement).overflowY);

    /** The part of el not cut off by clipping ancestors or the viewport,
     *  and whether a scroller (or the page) could bring the rest into view. */
    function visiblePart(el) {
        let r = rectOf(el);
        let vis = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        let reachable = false;
        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
            const [ox, oy] = overflowOf(p);
            if (ox === 'visible' && oy === 'visible') continue;
            const pr = p.getBoundingClientRect();
            // clientWidth/clientLeft are in the element's own CSS px; the rects
            // are in viewport px. Under `zoom` (Mission Control's 1.4x cover) or
            // a scale transform the two differ: scale the client box to match.
            const sx = p.offsetWidth ? pr.width / p.offsetWidth : 1, sy = p.offsetHeight ? pr.height / p.offsetHeight : 1;
            const cut = inter(vis, { left: pr.left + p.clientLeft * sx, top: pr.top + p.clientTop * sy,
                right: pr.left + (p.clientLeft + p.clientWidth) * sx, bottom: pr.top + (p.clientTop + p.clientHeight) * sy });
            const clippedHere = !cut || cut.width < vis.right - vis.left - 0.5 || cut.height < vis.bottom - vis.top - 0.5;
            if (clippedHere && (scrollable(p, 'x') || scrollable(p, 'y'))) reachable = true;
            if (!cut) return { vis: null, reachable };
            vis = cut;
        }
        const vp = inter(vis, { left: 0, top: 0, right: W, bottom: H });
        if ((!vp || vp.height < vis.bottom - vis.top - 0.5) && docScrollsY()) reachable = true;
        return { vis: vp, reachable, full: r };
    }

    /* ---------- collect tappables ---------- */
    const TAP = 'button, input:not([type="hidden"]), select, textarea, a[href], summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="slider"]';
    let cands = [...document.querySelectorAll(TAP)];
    // Outermost cursor:pointer elements that aren't already covered by TAP
    const all = document.body.querySelectorAll('*');
    for (const el of all) {
        if (el.matches(TAP) || el.closest(TAP)) continue;
        if (getComputedStyle(el).cursor !== 'pointer') continue;
        const p = el.parentElement;
        if (p && getComputedStyle(p).cursor === 'pointer') continue;
        cands.push(el);
    }
    // Toggle switches style a visually hidden checkbox: test its label instead
    cands = cands.filter(el => !(el.matches('input') && (rectOf(el).width < 2 || getComputedStyle(el).opacity === '0')));

    // Toasts out of the way while hit testing (they are checked on their own)
    const toasts = [...document.querySelectorAll(cfg.toast)].filter(shown);
    const saved = toasts.map(t => t.style.visibility);
    toasts.forEach(t => { t.style.visibility = 'hidden'; });

    const taps = [];
    for (const el of cands) {
        if (!shown(el)) continue;
        const part = visiblePart(el);
        // Topmost? Hit-test a few points of the visible part
        const v = part.vis;
        let top = false;
        if (v) {
            const pts = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8]];
            for (const [fx, fy] of pts) {
                const h = document.elementFromPoint(v.left + (v.right - v.left) * fx, v.top + (v.bottom - v.top) * fy);
                if (h && (el.contains(h) || h.contains(el) || (h.closest('label') && h.closest('label').contains(el)))) { top = true; break; }
            }
        }
        // Not topmost: under another layer (a sheet's backdrop) or scrolled
        // away, so not what the user sees or can tap
        if (!top) continue;
        let scroller = null;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (scrollable(p, 'y') || scrollable(p, 'x')) { scroller = p; break; }
        }
        // Its layer: the nearest pinned (fixed / sticky) ancestor, else its scroller.
        // Only up to the scroller: a field in a sheet's scrolling body is in that
        // scroller's layer (under the sheet's sticky footer), even though the
        // sheet itself sits in a fixed backdrop further out
        let pinned = null;
        for (let p = el; p && p !== document.body && p !== scroller; p = p.parentElement) {
            if (/fixed|sticky/.test(getComputedStyle(p).position)) { pinned = p; break; }
        }
        // A pinned (fixed / sticky) tappable stays put while its scroller or the page
        // scrolls, so it is judged on its own position, never "in a scrolling list"
        taps.push({ el, part, scroller, layer: pinned || scroller || 'page', pinned: !!pinned,
            inScroller: !pinned && (!!scroller || docScrollsY()), control: el.matches(TAP) });
    }
    // Player cards that are actually on screen (not under a sheet)
    const isTop = el => {
        const v = visiblePart(el).vis;
        if (!v) return false;
        const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.85]];
        return pts.some(([fx, fy]) => {
            const h = document.elementFromPoint(v.left + (v.right - v.left) * fx, v.top + (v.bottom - v.top) * fy);
            return h && (el.contains(h) || h.contains(el));
        });
    };
    const cards = cfg.cards ? [...document.querySelectorAll(cfg.cards)].filter(c => shown(c) && isTop(c)) : [];

    /* ---------- 1. sideways scroll ---------- */
    const se = document.scrollingElement;
    if (se.scrollWidth > W + 1 && !/hidden|clip/.test(getComputedStyle(document.body).overflowX + getComputedStyle(document.documentElement).overflowX)) {
        add('fail', 'hscroll', `page scrolls sideways: content ${se.scrollWidth}px in a ${W}px viewport`);
    }
    for (const el of document.body.querySelectorAll('*')) {
        if (!shown(el)) continue;
        const [ox] = overflowOf(el);
        if (!/(auto|scroll)/.test(ox) || el.scrollWidth <= el.clientWidth + T) continue;
        if (cfg.hscrollOk && el.closest(cfg.hscrollOk)) continue; // declared horizontal scrollers
        const r = rectOf(el);
        if (r.width < 40) continue;
        add('warn', 'hscroll', `scrolls sideways: ${el.scrollWidth}px of content in ${el.clientWidth}px`, el);
    }

    /* ---------- 2. tappables off-screen / clipped / overlapping ---------- */
    // A tappable with an animation of its own (a state frozen mid-animation,
    // animAt: a tile pulsing up to 1.25x) is meant to spill over its
    // neighbours for that moment: its box is not where it rests
    // Only in such a frozen frame (cfg.skipMoving): otherwise an animating
    // tappable (a pulse with animations on) is checked like any other
    const moving = el => !!cfg.skipMoving && typeof el.getAnimations === 'function' && el.getAnimations().length > 0;
    for (const { el, part } of taps) {
        if (moving(el)) continue;
        const r = part.full, v = part.vis;
        const lostW = (r.right - r.left) - (v.right - v.left), lostH = (r.bottom - r.top) - (v.bottom - v.top);
        if ((lostW > T || lostH > T) && !part.reachable) {
            const offscreen = r.left < -T || r.top < -T || r.right > W + T || r.bottom > H + T;
            add('fail', offscreen ? 'offscreen' : 'clipped',
                `${offscreen ? 'partly off-screen' : 'partly cut off'} (${Math.round(lostW)}x${Math.round(lostH)}px hidden)`, el);
        }
    }
    // A button drawn inside a text field on purpose (the shared date picker's
    // calendar button, a clear button): a sibling of the field that sits
    // wholly within the field's box is part of it, not overlapping it
    const adornment = (field, btn) => field.matches('input, textarea') && field.parentElement === btn.parentElement && (() => {
        const f = rectOf(field), r = rectOf(btn);
        return r.left >= f.left - T && r.right <= f.right + T && r.top >= f.top - T && r.bottom <= f.bottom + T;
    })();
    for (let i = 0; i < taps.length; i++) {
        for (let j = i + 1; j < taps.length; j++) {
            const a = taps[i], b = taps[j];
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            if (moving(a.el) || moving(b.el)) continue;
            if (adornment(a.el, b.el) || adornment(b.el, a.el)) continue;
            const x = inter(a.part.vis, b.part.vis);
            if (x && x.width > T && x.height > T) {
                // A list scrolled under a pinned bar (or the reverse): the one
                // in the other scroller is simply underneath there, not overlapping
                if (a.layer !== b.layer) {
                    const h = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
                    // (a hit on the pinned bar's own padding, between its buttons, counts as the bar)
                    const inLayer = (t, el) => t.el.contains(el) || (t.pinned && t.layer.contains(el));
                    const under = h && (inLayer(a, h) ? b : inLayer(b, h) ? a : null);
                    if (under && !under.pinned && under.inScroller) continue;
                }
                add('fail', 'overlap', `overlaps ${describe(b.el)} by ${Math.round(x.width)}x${Math.round(x.height)}px`, a.el);
            }
        }
    }
    // Toasts back: the overlap hit tests above must see what is under a toast (a list
    // scrolled under a pinned bar), not the toast itself; they are checked in section 5
    toasts.forEach((t, i) => { t.style.visibility = saved[i]; });

    /* ---------- 3. clipped text ---------- */
    const hasText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    const seenText = new Set();
    for (const el of document.body.querySelectorAll('*')) {
        if (!hasText(el) || !shown(el)) continue;
        const v = visiblePart(el);
        if (!v.vis) continue;
        // Under another layer? (text often has no pointer events: any ancestor/descendant hit counts)
        const cx = (v.vis.left + v.vis.right) / 2, cy = (v.vis.top + v.vis.bottom) / 2;
        const h = document.elementFromPoint(cx, cy);
        if (h && !(el.contains(h) || h.contains(el)) && !toasts.some(t => t.contains(h))) {
            const hz = h.closest('#modal-root, .modal, [role="dialog"]');
            if (hz && !hz.contains(el)) continue;
        }
        const cs = getComputedStyle(el);
        const isBtn = !!el.closest('button, [role="button"], [role="tab"]');
        const btn = isBtn ? el.closest('button, [role="button"], [role="tab"]') : null;
        // How the cut renders (on the element or a near ancestor): a line
        // clamp (a designed N-line box, e.g. the centre feed) or
        // text-overflow: ellipsis on a no-wrap box that clips. The app's rule
        // is that no text is ever cut with "…" (FitText shrinks it instead),
        // so an ellipsis cut is a failure like any other. A line clamp is a
        // warning: Chrome ends every clamp in "…" whatever text-overflow says
        // (the centre feed swaps in short wording first); a note only where
        // the box opens on a tap: the app declares those in ellipsisOk
        // (PT: .lever-clamp "More"; MC: the inbox detail).
        const clampOf = c => !!(c.webkitLineClamp && c.webkitLineClamp !== 'none');
        const ellOf = c => c.textOverflow === 'ellipsis' && !/flex|grid/.test(c.display) && /nowrap|pre/.test(c.whiteSpace + ' ' + (c.textWrapMode || '')) && /(hidden|clip)/.test(c.overflowX);
        let clamp = clampOf(cs), ellipsis = ellOf(cs);
        for (let p = el.parentElement, k = 0; !clamp && !ellipsis && p && k < 3; p = p.parentElement, k++) {
            const pc = getComputedStyle(p);
            clamp = clampOf(pc); ellipsis = ellOf(pc);
        }
        const report = (check, msg) => {
            if (clamp) {
                const ok = cfg.ellipsisOk && el.closest(cfg.ellipsisOk);
                add(ok ? 'info' : 'warn', 'text-clamped', msg + ' (line clamp, ends in "…")' + (ok ? ', declared ellipsisOk' : ''), el);
                return;
            }
            const how = ellipsis ? ' (shown with an ellipsis "…")' : '';
            // An app may declare text it ellipsizes by design (a one-line summary
            // whose full text is a tap away): a note, not a failure
            if (ellipsis && cfg.ellipsisOk && el.closest(cfg.ellipsisOk)) { add('info', 'text-ellipsis', msg + how + ', declared ellipsisOk', el); return; }
            if (isBtn) {
                if (seenText.has(btn)) return;
                seenText.add(btn);
                add('fail', 'label-truncated', msg + how, btn);
            } else add(check === 'text-clipped' || ellipsis ? 'fail' : 'warn', ellipsis ? 'text-ellipsis' : check, msg + how, el);
        };
        const ownClip = /(hidden|clip)/.test(cs.overflowY) || /(hidden|clip)/.test(cs.overflowX);
        if (ownClip && !scrollable(el, 'y') && !scrollable(el, 'x')) {
            const tallBy = el.scrollHeight - el.clientHeight, wideBy = el.scrollWidth - el.clientWidth;
            if (tallBy > T || wideBy > T) {
                report('text-clipped', `text cut off (${tallBy > T ? tallBy + 'px too tall' : ''}${tallBy > T && wideBy > T ? ', ' : ''}${wideBy > T ? wideBy + 'px too wide' : ''})`);
                continue;
            }
        }
        // Text spilling out of its box into a clipping ancestor
        const r = rectOf(el);
        const lost = (r.bottom - r.top) - (v.vis.bottom - v.vis.top) + (r.right - r.left) - (v.vis.right - v.vis.left);
        if (lost > T * 2 && !v.reachable) report('text-cut-by-parent', `text cut by a clipping ancestor (${Math.round(lost)}px hidden)`);
    }

    /* ---------- 3b. text fields too narrow for their value ---------- */
    // Text-node checks never see an input's value: "Alexandra" showing as
    // "Alexa" in a seat's name field. A field scrolls, so it is a warning.
    for (const { el } of taps) {
        if (!el.matches('input:not([type]), input[type="text"], input[type="search"], input[type="number"], textarea') || !el.value) continue;
        const over = el.scrollWidth - el.clientWidth;
        if (over > T && el.matches('input')) add('warn', 'input-clipped', `value "${el.value.slice(0, 30)}" is ${over}px wider than its field`, el);
    }
    // A <select> shows its chosen option in a box no scroll metric covers
    // ("🎲 Ra" for "🎲 Random"): measure that text in the select's font
    // against the box less its padding and (native look) its arrow.
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
    document.body.appendChild(probe);
    for (const { el } of taps) {
        if (!el.matches('select:not([multiple])') || el.selectedIndex < 0) continue;
        const text = (el.options[el.selectedIndex].label || el.options[el.selectedIndex].text || '').trim();
        if (!text) continue;
        const cs = getComputedStyle(el);
        probe.style.font = cs.font;
        probe.style.letterSpacing = cs.letterSpacing;
        probe.textContent = text;
        const arrow = cs.appearance === 'none' ? 0 : 20;
        const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - arrow;
        // offsetWidth, not the rect: under `zoom` (Mission Control's 1.4x cover)
        // the rect is in viewport px while clientWidth is in CSS px
        const over = Math.round(probe.offsetWidth - room);
        if (over > T) add('warn', 'input-clipped', `picker shows "${text.slice(0, 30)}" ${over}px wider than its room`, el);
    }
    probe.remove();

    /* ---------- 4. cover cameras keep-out ---------- */
    const root = document.documentElement;
    let cams = null;
    if (root.classList.contains('cover-cams')) {
        const cs = getComputedStyle(root);
        // The vars are CSS px (cover-cams.js divides by a page zoom); the rects are viewport px
        const zm = parseFloat(cs.zoom) > 0 ? parseFloat(cs.zoom) : 1;
        const left = parseFloat(cs.getPropertyValue('--cam-left')) * zm, top = parseFloat(cs.getPropertyValue('--cam-top')) * zm;
        if (Number.isFinite(left) && Number.isFinite(top)) {
            cams = { left, top, right: W, bottom: H };
            for (const { el, part, inScroller } of taps) {
                const x = inter(part.vis, cams);
                if (x && x.width > T && x.height > T) {
                    // In a scrolling list the user scrolls it out of the cameras: a note, not an issue
                    add(inScroller ? 'info' : 'fail', 'cams', `tappable inside the camera keep-out (${Math.round(x.width)}x${Math.round(x.height)}px)` +
                        (inScroller ? ', in a scrolling list (scrolls through it)' : ''), el);
                }
            }
        }
    }

    /* ---------- 5. toasts over buttons / player cards ---------- */
    for (const t of toasts) {
        const tr = rectOf(t);
        // Caught mid-slide (a *-mid state, just after a sheet opens or
        // closes): not where it rests, so a note instead of a fail
        const moving = t.getAnimations().filter(a => a.playState === 'running'
            && ['top', 'bottom', 'left', 'transform'].includes(a.transitionProperty));
        if (moving.length) {
            add('info', 'toast-moving', `toast "${t.textContent.trim().slice(0, 30)}" mid-move (${moving.map(a => a.transitionProperty).join(', ')}): its rest spot is checked in the settled state`, t);
            continue;
        }
        const hit = new Set();
        const soft = new Set();   // pointer-only targets (board tiles): warn
        // Scrolling content (not pinned, in a scroller or a page that scrolls): the user
        // can scroll it out from under a passing toast, so a note. Pinned controls (a tab
        // bar, a floating + button) can't move: those stay failures.
        const flow = new Set();
        for (const { el, part, control, pinned, inScroller } of taps) {
            if (t.contains(el)) continue;
            const x = inter(tr, part.vis);
            if (x && x.width > T && x.height > T) {
                const card = cards.find(c => c.contains(el));
                hit.add(card || el);
                if (!card && !control) soft.add(el);
                if (!card && !pinned && inScroller) flow.add(el);
            }
        }
        for (const c of cards) {
            const x = inter(tr, rectOf(c));
            if (x && x.width > T && x.height > T) hit.add(c);
        }
        // A long toast (ToastOffset.showLong: trades, tap to dismiss) on the
        // smallest cover keeps its whole text by growing up over the board's
        // edge from the strip under it: by design, one note for all its tiles
        const long = t.classList.contains('toast-long');
        const overBoard = long ? [...hit].filter(el => soft.has(el)) : [];
        if (overBoard.length) add('info', 'toast-over-board', `long toast "${t.textContent.trim().slice(0, 30)}" covers ${overBoard.length} board tile(s) until it goes (by design)`, t);
        for (const el of hit) {
            if (long && soft.has(el)) continue;
            const x = inter(tr, el.getBoundingClientRect());
            if (flow.has(el)) {
                add('info', 'toast-over-content', `toast "${t.textContent.trim().slice(0, 30)}" is over scrolling content by ${x ? Math.round(x.width) + 'x' + Math.round(x.height) : '?'}px (it can be scrolled out from under it)`, el);
                continue;
            }
            add(soft.has(el) ? 'warn' : 'fail', 'toast-covers', `toast "${t.textContent.trim().slice(0, 30)}" covers it by ${x ? Math.round(x.width) + 'x' + Math.round(x.height) : '?'}px`, el);
        }
        if (tr.left < -T || tr.right > W + T || tr.top < -T || tr.bottom > H + T) add('fail', 'offscreen', 'toast partly off-screen', t);
    }

    /* ---------- 6. colour contrast (WCAG 2.x 1.4.3) ---------- */
    // Text colour against the effective background: the ancestors'
    // background-colors composited bottom-up, each element's opacity applied
    // to its whole subtree (a dimmed card fades its text and its fill
    // together). A gradient counts by its worst colour stop; an image (url())
    // between the text and the first opaque fill makes the background
    // unknown (a note). Findings are grouped
    // per (element kind, colour pair) so one bad token is one line.
    const cvs = document.createElement('canvas'); cvs.width = cvs.height = 1;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const colCache = new Map();
    const parseCol = str => {
        if (colCache.has(str)) return colCache.get(str);
        let out = null;
        const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(str);
        if (m) out = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        else if (str === 'transparent') out = [0, 0, 0, 0];
        else {   // oklch(), color(srgb ...), color-mix(): let the canvas resolve it
            ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = str; ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            // getImageData returns un-premultiplied channels already: no divide by alpha
            out = d[3] ? [d[0], d[1], d[2], d[3] / 255] : [0, 0, 0, 0];
        }
        colCache.set(str, out);
        return out;
    };
    const over = (top, under) => {        // source-over, under opaque
        const a = top[3];
        return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const mix = (a, b, t) => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t, 1];
    const lum = c => {
        const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const hex = c => '#' + c.slice(0, 3).map(v => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0')).join('');
    const kind = el => {
        let s = el.tagName.toLowerCase();
        const cls = [...el.classList].filter(c => !/^(is-|show$)/.test(c)).slice(0, 2);
        if (cls.length) s += '.' + cls.join('.');
        const p = el.parentElement;
        if (!cls.length && p && p !== document.body) {
            const pc = [...p.classList].filter(c => !/^(is-|show$)/.test(c)).slice(0, 2);
            s = p.tagName.toLowerCase() + (pc.length ? '.' + pc.join('.') : '') + ' > ' + s;
        }
        return s;
    };
    // Canvas (page) colour: the root's, else the body's when opaque, else white
    const canvasCol = (() => {
        for (const e of [document.documentElement, document.body]) {
            const c = parseCol(getComputedStyle(e).backgroundColor);
            if (c[3] > 0.99) return c;
        }
        return [255, 255, 255, 1];
    })();
    const contrastGroups = new Map();
    const ownText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0);
    const fieldText = el => el.matches('select, input:not([type]), input[type="text"], input[type="search"], input[type="number"], textarea') && (el.value || '').trim();
    for (const el of document.body.querySelectorAll('*')) {
        if (el.closest('svg') || el.matches('script, style, noscript, option, optgroup')) continue;
        if (!(ownText(el) || fieldText(el)) || !shown(el)) continue;
        // Emoji-only text (board tokens, icons) draws in its own colours: the text colour is moot
        if (!fieldText(el) && /^[\p{Extended_Pictographic}\p{Emoji_Component}\u{FE0F}\u{200D}\s]+$/u.test(el.textContent)) continue;
        const v = visiblePart(el).vis;
        if (!v || v.right - v.left < 1 || v.bottom - v.top < 1) continue;
        // On top? (a sheet's backdrop over the board composites a layer the
        // ancestor walk can't see): any of a few points must hit el's own tree
        const pts = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5]];
        const onTop = pts.some(([fx, fy]) => {
            const h = document.elementFromPoint(v.left + (v.right - v.left) * fx, v.top + (v.bottom - v.top) * fy);
            return h && (el.contains(h) || h.contains(el) || (h.closest('label') && h.closest('label').contains(el)));
        });
        if (!onTop) continue;
        const cs = getComputedStyle(el);
        if (parseFloat(cs.fontSize) < 1) continue;          // font-size 0: a label hidden on purpose (a colour strip)
        const fill = cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color;
        const fg = parseCol(fill);
        if (fg[3] < 0.05) continue;                         // transparent text (clip-path / gradient text)
        // Chain root -> el, and whether a background image sits above the first opaque fill
        const chain = [];
        for (let p = el; p; p = p.parentElement) chain.unshift(p);
        let unknown = null, solid = false;
        for (let i = chain.length - 1; i >= 0 && !solid; i--) {
            const pcs = getComputedStyle(chain[i]);
            if (/url\(|image-set|element\(|cross-fade/.test(pcs.backgroundImage) && !chain[i].matches('html, body')) { unknown = chain[i]; break; }
            if (parseCol(pcs.backgroundColor)[3] > 0.99 && pcs.backgroundImage === 'none') solid = true;
        }
        // Gradient colour stops (painted over the layer's background-color)
        const STOP = /(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|hsla?\([^)]*\)|lab\([^)]*\)|lch\([^)]*\)|#[0-9a-f]{3,8}\b|transparent)/gi;
        const layers = chain.map(e => {
            const c = getComputedStyle(e);
            const stops = /gradient\(/.test(c.backgroundImage) && !e.matches('html, body')
                ? [...new Set(c.backgroundImage.match(STOP) || [])].map(parseCol) : null;
            return { bg: parseCol(c.backgroundColor), op: parseFloat(c.opacity), filter: c.filter, stops };
        });
        const gIdx = layers.map((l, i) => l.stops && l.stops.length ? i : -1).filter(i => i >= 0);
        const gradient = gIdx.length > 0;
        // Every combination of one stop per gradient layer (capped)
        let combos = [[]];
        for (const i of gIdx) {
            const next = [];
            for (const cmb of combos) for (const st of layers[i].stops) next.push(cmb.concat([[i, st]]));
            combos = next.slice(0, 64);
        }
        const render = (withText, useOpacity, cmb) => {
            const pick = new Map(cmb || []);
            const rec = (i, under) => {
                let c = over(layers[i].bg, under);
                if (pick.has(i)) c = over(pick.get(i), c);
                c = i === layers.length - 1 ? (withText ? over(fg, c) : c) : rec(i + 1, c);
                return useOpacity && layers[i].op < 1 ? mix(under, c, layers[i].op) : c;
            };
            return rec(0, canvasCol);
        };
        // The worst stop combination decides
        let worst = null;
        for (const cmb of combos) {
            const b = render(false, true, cmb), f = render(true, true, cmb), q = ratio(f, b);
            if (!worst || q < worst.r) worst = { r: q, b, f, cmb };
        }
        const opAll = layers.reduce((m, l) => m * l.op, 1);
        const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const need = large ? 3 : 4.5;
        const bgC = worst.b, fgC = worst.f, r = worst.r;
        if (!unknown && r >= need - 0.005) continue;
        // Why it may be on purpose
        let sev, why = '';
        const muted = cfg.muted && el.closest(cfg.muted);
        const rNoOp = ratio(render(true, false, worst.cmb), render(false, false, worst.cmb));
        if (unknown) { sev = 'info'; why = `unknown background (background image on ${kind(unknown)})`; }
        else if (muted) { sev = 'info'; why = 'muted on purpose (disabled / out of play)'; }
        else if (opAll <= cfg.dimOpacity && rNoOp >= need) { sev = 'info'; why = `dimmed on purpose (opacity ${opAll.toFixed(2)}; ${rNoOp.toFixed(2)}:1 undimmed)`; }
        else if (chain.some(e => typeof e.getAnimations === 'function' && e.getAnimations().some(a => a.playState === 'running')) && rNoOp >= need) {
            sev = 'info'; why = 'mid-animation (a fade in progress)';
        }
        else if (layers.some(l => l.filter && l.filter !== 'none' && /grayscale|brightness|contrast|invert/.test(l.filter))) { sev = 'info'; why = 'filtered (grayscale/brightness): colours approximate'; }
        else sev = r < 3 ? 'warn' : 'info';
        if (unknown) {
            const key = 'u|' + kind(el) + '|' + hex(fg);
            const g = contrastGroups.get(key);
            if (g) { g.n++; continue; }
            contrastGroups.set(key, { sev, el, n: 1, msg: `text ${hex(fg)} on an ${why}: not measured` });
            continue;
        }
        const key = kind(el) + '|' + hex(fgC) + '|' + hex(bgC);
        const g = contrastGroups.get(key);
        if (g) { g.n++; continue; }
        contrastGroups.set(key, { sev, el, n: 1,
            msg: `${r.toFixed(2)}:1 (needs ${need}:1, ${large ? 'large' : 'normal'} text ${Math.round(size * 10) / 10}px${weight >= 600 ? ' ' + weight : ''}): ${hex(fgC)} on ${hex(bgC)}` +
                (opAll < 0.995 ? ` (opacity ${opAll.toFixed(2)})` : '') + (gradient ? ' (gradient: worst stop)' : '') + (why ? ` - ${why}` : '') });
    }
    for (const g of contrastGroups.values()) add(g.sev, 'contrast', g.msg + (g.n > 1 ? ` [${g.n} elements]` : ''), g.el);

    /* ---------- 7. tap-target size (WCAG 2.2 AA 2.5.8) ---------- */
    // A visible, enabled target under 24x24 CSS px warns unless a 24px circle
    // centred on it clears every other target (and every other undersized
    // target's circle): the spacing exception. A label wrapping a control (a
    // segmented option, a toggle row) is the hit box of its control. Inline
    // links in a sentence are exempt; board tiles are a note (see cfg.tile).
    const MIN = 24;
    const targets = [];
    const seenT = new Set();
    for (const t of taps) {
        let el = t.el;
        if (el.matches(':disabled, [aria-disabled="true"]') || el.closest('fieldset:disabled')) continue;
        const lab = el.closest('label');
        if (lab && lab.querySelector('input, select, textarea')) el = lab;
        if (seenT.has(el)) continue;
        seenT.add(el);
        const r = rectOf(el);
        targets.push({ el, r, small: r.width < MIN - 0.5 || r.height < MIN - 0.5, part: t.part });
    }
    // Labels wrapping a visually hidden control (segmented options) are not in taps
    for (const lab of document.querySelectorAll('label')) {
        if (seenT.has(lab) || !lab.querySelector('input:not([type="hidden"])') || !shown(lab)) continue;
        const inp = lab.querySelector('input');
        if (inp.disabled) continue;
        const v = visiblePart(lab).vis;
        if (!v) continue;
        const h = document.elementFromPoint((v.left + v.right) / 2, (v.top + v.bottom) / 2);
        if (!h || !(lab.contains(h) || h.contains(lab))) continue;
        seenT.add(lab);
        const r = rectOf(lab);
        targets.push({ el: lab, r, small: r.width < MIN - 0.5 || r.height < MIN - 0.5 });
    }
    const distToRect = (x, y, r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    const tapGroups = new Map();
    for (const a of targets) {
        if (!a.small) continue;
        const el = a.el;
        // Inline in a sentence: a link or button inside running text
        if (getComputedStyle(el).display === 'inline' && el.parentElement &&
            [...el.parentElement.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
        const cx = (a.r.left + a.r.right) / 2, cy = (a.r.top + a.r.bottom) / 2;
        let clash = null;
        for (const b of targets) {
            if (b === a || b.el.contains(el) || el.contains(b.el)) continue;
            const bx = (b.r.left + b.r.right) / 2, by = (b.r.top + b.r.bottom) / 2;
            const hit = b.small ? Math.hypot(cx - bx, cy - by) < MIN - 0.5 : distToRect(cx, cy, b.r) < MIN / 2 - 0.5;
            if (hit) { clash = b; break; }
        }
        if (!clash) continue;    // spacing exception
        const isTile = cfg.tile && el.matches(cfg.tile);
        const sz = `${Math.round(a.r.width)}x${Math.round(a.r.height)}`;
        const key = isTile ? 'tile' : kind(el) + '|' + sz;
        const g = tapGroups.get(key);
        if (g) { g.n++; if (isTile) { g.minW = Math.min(g.minW, a.r.width); g.minH = Math.min(g.minH, a.r.height); } continue; }
        tapGroups.set(key, { el, n: 1, sev: isTile ? 'info' : 'warn', tile: isTile, minW: a.r.width, minH: a.r.height,
            msg: `tap target ${sz}px, under 24x24 with no room around it (24px circle reaches ${describe(clash.el)})` });
    }
    for (const g of tapGroups.values()) {
        if (g.tile) add('info', 'tap-size', `${g.n} board tile(s) under 24x24 (smallest ${Math.round(g.minW)}x${Math.round(g.minH)}px), packed edge to edge: ` +
            cfg.tileNote, g.el);
        else add(g.sev, 'tap-size', g.msg + (g.n > 1 ? ` [${g.n} elements]` : ''), g.el);
    }

    return {
        issues,
        info: {
            viewport: [W, H],
            screenType: window.ScreenManager ? ScreenManager.getScreenType() : null,
            htmlClass: root.className,
            cams,
            tappables: taps.length,
            toasts: toasts.length,
            modal: !!(document.getElementById('modal-root') && !document.getElementById('modal-root').hidden),
            title: document.getElementById('modal-root') && !document.getElementById('modal-root').hidden
                ? (document.getElementById('modal-title') || {}).textContent || '' : ''
        }
    };
}

module.exports = { CHECK_CFG, runChecks };
