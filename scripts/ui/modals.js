/**
 * UI: Modal Factory
 *
 * Single reusable modal. Usage:
 *   Modals.show({ title, body (HTML string or Node), buttons: [{label, class, onClick}] })
 *   Modals.close()
 *
 * autoAck: true marks a purely informational modal (single acknowledge
 * button, no decision — card draws and the like). When the auto-end-turn
 * setting is on, its button is clicked automatically after a reading pause
 * scaled to CPU speed. Never set it on modals that choose anything.
 *
 * Exports: window.Modals
 */

const Modals = {

    _generation: 0,

    /** How long a `confirm` button stays armed after its first tap. */
    CONFIRM_MS: 3000,

    show(config) {
        this._generation += 1;
        const root = document.getElementById('modal-root');
        const titleEl = document.getElementById('modal-title');
        if (config.titleHTML) { titleEl.innerHTML = config.titleHTML; }
        else { titleEl.textContent = config.title || ''; }
        const body = document.getElementById('modal-body');
        body.innerHTML = '';
        if (typeof config.body === 'string') body.innerHTML = config.body;
        else if (config.body) body.appendChild(config.body);

        // Cover display: the "player cash" strip joins the title row instead
        // of costing a line of the short sheet (it is rebuilt with every body).
        const head = root.querySelector('.modal-head');
        head.querySelectorAll('.modal-cash').forEach(el => el.remove());
        const cashLine = body.querySelector('.modal-cash');
        if (cashLine && typeof ScreenManager !== 'undefined' && ScreenManager.getScreenType() === 'external') {
            head.insertBefore(cashLine, document.getElementById('modal-close'));
        }

        const buttonBox = document.getElementById('modal-buttons');
        buttonBox.innerHTML = '';
        const buttons = config.buttons || [{ label: 'OK', class: 'btn-primary' }];
        // Role tags for layouts that arrange the footer (internal display):
        // btn-main = the one decisive action: the only primary button; with no
        // primary, the only success/danger; with neither, the only warning.
        // btn-dismiss = the plain Close/Cancel/Back button.
        // Sides (internal display grid, cover order): btn-info on the left =
        // the dismiss button and look-only buttons (config `info: true`:
        // Owners, Properties, Game stats); btn-act on the right = any other
        // action. Footers with breaks or growing buttons (auction) keep
        // their own rows. `top: true` = a full-width row of its own above
        // the others, never the main slot (.btn-top: the deed's actions, so
        // Close stays the bottom button and a habitual tap can't mortgage);
        // two adjacent `half: true` top buttons share that row. `confirm: '<label>'` makes the
        // button take two taps (see armConfirm).
        const solo = buttons.filter(b => !b.break && !b.grow && !b.top);
        const main = [/\bbtn-primary\b/, /\bbtn-(success|danger)\b/, /\bbtn-warning\b/].reduce((found, re) => {
            if (found !== undefined) return found;
            const m = solo.filter(b => re.test(b.class || ''));
            return m.length === 0 ? undefined : (m.length === 1 ? m[0] : null);
        }, undefined) || null;
        buttons.forEach(btn => {
            // A break forces the buttons after it onto a fresh footer row, so a
            // group above it (e.g. the auction bid buttons) never splits mid-row.
            if (btn.break) {
                const gap = document.createElement('div');
                gap.className = 'modal-btn-break';
                buttonBox.appendChild(gap);
                return;
            }
            const el = document.createElement('button');
            const isDismiss = !btn.keepOpen && /^(close|cancel|back)$/i.test(btn.label);
            const side = btn === main || btn.grow ? '' : btn.top ? ' btn-top' : (isDismiss || btn.info ? ' btn-info' : ' btn-act');
            el.className = `btn ${btn.class || 'btn-secondary'}${btn.grow ? ' btn-grow' : ''}${btn.top && btn.half ? ' btn-half' : ''}` +
                (btn === main ? ' btn-main' : '') + (isDismiss ? ' btn-dismiss' : '') + side;
            Icons.label(el, btn.label);
            if (btn.disabled) el.disabled = true;
            const run = () => {
                if (!btn.keepOpen) this.close();
                if (btn.onClick) btn.onClick();
            };
            if (btn.confirm) this.armConfirm(el, btn.confirm, run);
            else el.addEventListener('click', run);
            buttonBox.appendChild(el);
        });
        this._pairSides(buttonBox);

        // Dismissible modals (those with a plain Close/Cancel button) get an
        // X in the header and backdrop-click-to-close, both routed through
        // that button so its onClick (e.g. reopening an auction) still runs.
        // Decision modals stay X-free: dismissing them could stall the game.
        // noX: true opts out (e.g. auction spectator, where the X crowds
        // the long title).
        const dismissBtn = config.noX ? null :
            (config.buttons || []).find(b => !b.keepOpen && /close|cancel/i.test(b.label));
        const dismiss = dismissBtn ? () => { this.close(); if (dismissBtn.onClick) dismissBtn.onClick(); } : null;
        const xBtn = document.getElementById('modal-close');
        if (!xBtn.querySelector('.icon')) xBtn.innerHTML = Icons.svg('close');
        xBtn.hidden = !dismiss;
        xBtn.onclick = dismiss;
        root.querySelector('.modal-backdrop').onclick = dismiss;

        // A previous view's held height (see holdHeight) never carries over
        const sheet = root.querySelector('.modal');
        sheet.style.minHeight = '';
        sheet.classList.remove('modal-hold');

        root.hidden = false;

        if (config.autoAck && window.DEV && DEV.autoEndTurn) {
            const gen = this._generation;
            const delay = Math.max((window.DEV.cpuDelay || 700) * 2, 1400);
            setTimeout(() => {
                if (this._generation !== gen || !this.isOpen()) return; // replaced or dismissed
                const first = buttonBox.querySelector('button');
                if (first) first.click();
            }, delay);
        }
    },

    /**
     * Footers with both sides (and no auction-style rows): reorder the
     * buttons row by row, info left / action right, the main action last,
     * and let a button with no partner on its row take the whole row
     * (.btn-wide) instead of leaving half of it empty.
     */
    _pairSides(box) {
        box.classList.remove('modal-paired');
        if (box.querySelector('.modal-btn-break, .btn-grow')) return;
        // Close / Cancel / Back leads the left column
        const info = [...box.querySelectorAll(':scope > .btn-dismiss'),
            ...box.querySelectorAll(':scope > .btn-info:not(.btn-dismiss)')];
        const act = [...box.querySelectorAll(':scope > .btn-act')];
        if (!info.length || !act.length) return;
        const main = [...box.querySelectorAll(':scope > .btn-main')];
        for (let i = 0; i < Math.max(info.length, act.length); i++) {
            const pair = [info[i], act[i]].filter(Boolean);
            if (pair.length === 1) pair[0].classList.add('btn-wide');
            pair.forEach(el => box.appendChild(el));
        }
        main.forEach(el => box.appendChild(el));
        // DOM order is now the row order: the footer `order` rules
        // (sheet.css) would pull Close / Game stats out of their pairs
        box.classList.add('modal-paired');
    },

    /**
     * Two-tap button: the first tap swaps in confirmLabel (.btn-armed) for
     * CONFIRM_MS, a second tap inside that window calls run(); otherwise the
     * button reverts. For actions a stray tap shouldn't trigger (Mortgage).
     */
    armConfirm(el, confirmLabel, run) {
        const content = [...el.childNodes]; // label, with its icon if any
        let armed = null;
        el.addEventListener('click', () => {
            if (!armed) {
                el.textContent = confirmLabel;
                el.classList.add('btn-armed');
                armed = setTimeout(() => {
                    armed = null;
                    el.replaceChildren(...content);
                    el.classList.remove('btn-armed');
                }, this.CONFIRM_MS);
                return;
            }
            clearTimeout(armed);
            armed = null;
            run();
        });
    },

    /** Current height of the open sheet, in px (0 when closed). */
    height() {
        return this.isOpen() ? document.querySelector('#modal-root .modal').offsetHeight : 0;
    },

    /** Keep the open sheet at least px tall (body grows, buttons stay at the
     *  bottom), so a view that swaps to shorter content doesn't jump. Never
     *  past the sheet's own max-height (min-height would beat it), so a held
     *  view is no taller than a full one. Cleared by the next show(). */
    holdHeight(px) {
        if (!px || !this.isOpen()) return;
        const sheet = document.querySelector('#modal-root .modal');
        const cap = parseFloat(getComputedStyle(sheet).maxHeight);
        if (cap > 0) px = Math.min(px, cap);
        sheet.style.minHeight = `min(${Math.round(px)}px, 100%)`;
        sheet.classList.add('modal-hold');
    },

    /** Consistent "player cash" line for modal bodies (HTML string form). */
    cashHTML(player) {
        const esc = document.createElement('div');
        esc.textContent = player.name;
        return `<p class="modal-cash">💵 <strong>${esc.innerHTML}</strong>` +
            `<span class="modal-cash-amount">$${player.cash}</span></p>`;
    },

    /** Node form of cashHTML, for DOM-built modal bodies. */
    cashLine(player) {
        const wrap = document.createElement('div');
        wrap.innerHTML = this.cashHTML(player);
        return wrap.firstElementChild;
    },

    close() {
        document.getElementById('modal-root').hidden = true;
    },

    isOpen() {
        return !document.getElementById('modal-root').hidden;
    }
};

if (typeof window !== 'undefined') {
    window.Modals = Modals;
}
