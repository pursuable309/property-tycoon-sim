/**
 * UI: Fit text
 *
 * Nothing in the game is cut short with "…": text that doesn't fit its box
 * shrinks until it does. The stylesheets keep their one-line / few-line
 * boxes (white-space: nowrap or -webkit-line-clamp, overflow hidden) with
 * `text-overflow: clip`; this file finds every rule that sets clip or a
 * line clamp, and after each DOM change or resize shrinks the font of any
 * matching element whose text overflows, down to MIN_SCALE of its own size
 * (past that it is clipped, never ellipsised). A box that holds a player
 * name (9 characters, maybe all W) can set `--fit-min: 0.45` to go further
 * for that worst case. Text fields fit too, and refit as you type.
 * Inside a data-fit-group
 * container (the turn buttons) every label takes the smallest share, so a
 * row of equal buttons keeps one type size. Cosmetic only: never touches
 * game state.
 *
 * Exports: window.FitText
 */

const FitText = {

    MIN_SCALE: 0.6,  // smallest font, as a share of the element's styled size
    STEP: 0.93,      // shrink factor per try once the first guess overflows
    _selector: null,
    _queued: false,

    /** One selector list from every same-origin rule (media and container
     *  rules included) that sets text-overflow: clip or a line clamp. */
    _collect() {
        const sels = new Set();
        const walk = rules => {
            for (const r of rules) {
                // styles.css pulls the rest in with @import
                if (r.styleSheet) {
                    try { walk(r.styleSheet.cssRules); } catch (e) { /* not loaded */ }
                    continue;
                }
                if (r.cssRules && !r.style) walk(r.cssRules);
                if (!r.style || !r.selectorText) continue;
                const st = r.style;
                const clamp = st.getPropertyValue('-webkit-line-clamp').trim();
                if (st.getPropertyValue('text-overflow').trim() !== 'clip' && !/^\d+$/.test(clamp)) continue;
                r.selectorText.split(',').forEach(sel => {
                    sel = sel.trim();
                    if (!sel || sel.includes('::')) return;
                    try { document.querySelector(sel); sels.add(sel); } catch (e) { /* unsupported: skip */ }
                });
            }
        };
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }   // cross-origin
            if (rules) walk(rules);
        }
        this._selector = [...sels].join(',') || null;
    },

    _overflows(el) {
        return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    },

    /** Re-fit every matching element (resets earlier fits first). */
    run() {
        this._queued = false;
        if (this._selector === null) this._collect();
        if (!this._selector) return;
        document.querySelectorAll('[data-fit]').forEach(el => {
            el.style.fontSize = '';
            delete el.dataset.fit;
        });
        const over = [...document.querySelectorAll(this._selector)]
            .filter(el => el.clientWidth > 0 && this._overflows(el));
        over.forEach(el => {
            const cs = getComputedStyle(el);
            const base = parseFloat(cs.fontSize);
            if (!base) return;
            const min = Math.min(this.MIN_SCALE, parseFloat(cs.getPropertyValue('--fit-min')) || this.MIN_SCALE);
            // First guess: width shrinks in proportion, wrapped lines about
            // with the square root of the height ratio
            const w = el.clientWidth / el.scrollWidth;
            const h = Math.sqrt(el.clientHeight / el.scrollHeight);
            let scale = Math.max(min, Math.min(1, w, h) * 0.99);
            el.dataset.fit = '1';
            el._fitBase = base;
            el.style.fontSize = `${(base * scale).toFixed(2)}px`;
            while (this._overflows(el) && scale > min) {
                scale = Math.max(min, scale * this.STEP);
                el.style.fontSize = `${(base * scale).toFixed(2)}px`;
            }
        });
        // A fit group (data-fit-group: the turn buttons) shares one size:
        // its other labels shrink by the same share as the most shrunk
        document.querySelectorAll('[data-fit-group]').forEach(group => {
            const members = [...group.querySelectorAll(this._selector)].filter(el => el.clientWidth > 0);
            const fitted = members.filter(el => el.dataset.fit);
            if (!fitted.length) return;
            const share = Math.min(...fitted.map(el => parseFloat(el.style.fontSize) / el._fitBase));
            const bases = fitted.map(el => el._fitBase);
            members.forEach(el => {
                if (el.dataset.fit) return;
                // Only labels styled the same size (the side buttons, not
                // the big main action under them)
                const base = parseFloat(getComputedStyle(el).fontSize);
                if (!bases.some(b => Math.abs(b - base) < 0.1)) return;
                el.dataset.fit = '1';
                el.style.fontSize = `${(base * share).toFixed(2)}px`;
            });
        });
    },

    /** Fit on the next frame (batches a burst of DOM changes). */
    schedule() {
        if (this._queued) return;
        this._queued = true;
        requestAnimationFrame(() => this.run());
    },

    init() {
        // Our own font-size writes are style attributes, which the
        // observer ignores, so a fit never triggers another
        new MutationObserver(() => this.schedule()).observe(document.body, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ['class', 'hidden']
        });
        window.addEventListener('resize', () => this.schedule());
        // A typed value is no DOM change: refit the field (seat names)
        document.addEventListener('input', e => { if (e.target.matches && e.target.matches('input[type="text"]')) this.schedule(); }, true);
        // Imported sheets may still be loading at init: list the rules again
        window.addEventListener('load', () => { this._selector = null; this.schedule(); });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.schedule());
        this.schedule();
    }
};

if (typeof window !== 'undefined') {
    window.FitText = FitText;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => FitText.init());
    else FitText.init();
}
