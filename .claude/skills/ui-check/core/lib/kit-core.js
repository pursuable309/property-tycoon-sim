/**
 * ui-check in-page helper kit, shared by every app: evaluated in the page
 * after every load, before the app's own kit (adapter kitSrc), which adds its
 * helpers onto the same object and may replace freeze() / pauseAnimations().
 * Defines window.__uic; state steps get it as `kit`.
 *
 * Nothing here edits the app's files or calls its server.
 */
(() => {
    if (window.__uic) return 'already';
    const kit = {
        wait(ms) { return new Promise(r => setTimeout(r, ms)); },
        frames(n = 2) {
            return new Promise(r => {
                const step = k => (k <= 0 ? r() : requestAnimationFrame(() => step(k - 1)));
                step(n);
            });
        },

        /** Stop whatever would change the page during the screenshot. The
         *  runner calls it right before the checks; an app kit replaces it
         *  (PT: stops the CPU players). */
        freeze() {},

        /** Freeze every running animation (CSS and Web Animations) at ms
         *  into its own timeline. Returns how many were frozen. */
        pauseAnimations(ms) {
            const anims = document.getAnimations();
            anims.forEach(a => { a.pause(); a.currentTime = ms; });
            return anims.length;
        },

        /** True once sel matches a shown element (with children when
         *  withChildren), false after ms: a step returning false is flagged. */
        async waitFor(sel, ms = 3000, withChildren = false) {
            const end = performance.now() + ms;  // not Date: an adapter may freeze the page clock
            while (performance.now() < end) {
                const el = document.querySelector(sel);
                if (el && (!withChildren || el.children.length) && el.getClientRects().length) return true;
                await this.wait(60);
            }
            return false;
        },

        /** Click the first element matching sel whose accessible label (or
         *  text) starts with label. Throws if there is none, so the case
         *  shows as a harness error instead of a screenshot of the wrong thing. */
        clickByLabel(sel, label) {
            const el = [...document.querySelectorAll(sel)]
                .find(e => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/^\W+/, '').startsWith(label));
            if (!el) throw new Error(`nothing in ${sel} labelled "${label}"`);
            el.click();
            return true;
        },

        /** Click the element matching sel (throws if missing). */
        click(sel) {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`no ${sel}`);
            el.click();
            return true;
        }
    };
    window.__uic = kit;
    return 'ok';
})();
