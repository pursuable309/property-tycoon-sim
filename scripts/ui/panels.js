/**
 * UI: Player Panels
 *
 * Compact per-player dashboards: cash, property count, jail status, turn
 * highlight. Tapping a panel opens that player's property list.
 *
 * Exports: window.Panels
 */

const Panels = {

    _prevCash: null,

    _prevCurrent: null,

    render(state) {
        const box = document.getElementById('player-panels');
        const keepScroll = box.scrollTop;   // the cover display's column scrolls
        box.innerHTML = '';
        // Compact the cards once there are enough seats to overflow the tall
        // internal display (see motorola-internal.css .panels-compact rules);
        // with fewer, _chooseCompact() below decides by the board's size.
        box.classList.toggle('panels-compact', state.players.length >= 5);
        const animate = Anim.on('highlights');
        const countUp = Anim.on('countUp') && !(window.engine && window.engine.fastForwarding);
        // A re-render replaces the cards: stop counters aimed at the old ones
        this._counters.forEach(id => cancelAnimationFrame(id));
        this._counters = [];
        state.players.forEach(p => {
            const el = document.createElement('div');
            el.className = 'player-panel';
            if (p.id === state.currentPlayer) el.classList.add('panel-current');
            if (p.bankrupt) el.classList.add('panel-bankrupt');
            // In jail: the card shows bars and a dimmed name (player-panel.css)
            else if (p.inJail) el.classList.add('panel-jailed');
            el.style.borderLeftColor = BoardRenderer.TOKEN_COLORS[p.id];

            const propCount = GameState.propertiesOf(state, p.id).length;
            const badges = [];
            if (p.getOutCards > 0) badges.push(`🔑×${p.getOutCards}`);
            if (p.bankrupt) badges.push('Bankrupt');

            el.innerHTML = `
                <div class="panel-top">
                    <div class="panel-name"><span class="panel-token">${BoardRenderer.TOKEN_ICONS[p.token] || '●'}</span> <span class="panel-name-text">${this._esc(p.name)}</span></div>
                    <div class="panel-cash">$${p.cash}</div>
                    <div class="panel-props" title="${propCount} properties">🏷${propCount}</div>
                </div>
                <div class="panel-meta">${propCount} props${badges.length ? ' · ' + badges.join(' · ') : ''}</div>
                ${this._setsHTML(state, p)}
            `;
            // Flash + delta chip when cash changed since the last render
            const prev = this._prevCash ? this._prevCash[p.id] : undefined;
            const changed = prev !== undefined && prev !== p.cash;
            const cashEl = el.querySelector('.panel-cash');
            if (animate && changed) {
                const delta = p.cash - prev;
                cashEl.classList.add(delta > 0 ? 'cash-up' : 'cash-down');
                const chip = document.createElement('span');
                chip.className = `cash-delta ${delta > 0 ? 'delta-up' : 'delta-down'}`;
                chip.textContent = `${delta > 0 ? '+' : '−'}$${Math.abs(delta)}`;
                cashEl.appendChild(chip);
            }
            // Cash count-up (Full, or Custom): the figure counts from the old amount
            if (countUp && changed) this._countUp(cashEl.firstChild, prev, p.cash);

            el.addEventListener('click', () => {
                if (typeof PropertyUI !== 'undefined' && !p.bankrupt) PropertyUI.showPortfolio(p.id);
            });
            box.appendChild(el);
        });
        this._chooseCompact(box, state.players.length);
        this._fit(box);
        this._fillRoom();

        // Rebuilding resets the scroll: restore it, and when the turn passes
        // bring the new current player's card into view (cover display, 5+
        // seats). Scrolls only the column, never the page.
        box.scrollTop = keepScroll;
        const cur = box.querySelector('.panel-current');
        if (cur && state.currentPlayer !== this._prevCurrent && box.scrollHeight > box.clientHeight) {
            const b = box.getBoundingClientRect();
            const c = cur.getBoundingClientRect();
            if (c.top < b.top) box.scrollTop -= b.top - c.top;
            else if (c.bottom > b.bottom) box.scrollTop += c.bottom - b.bottom;
        }
        this._prevCurrent = state.currentPlayer;

        this._prevCash = {};
        state.players.forEach(p => { this._prevCash[p.id] = p.cash; });
    },

    /**
     * Internal display, 2-4 seats: the two-line cards are taller than the
     * compact ones, so on a short or wide screen they squeeze the board more
     * than 5-6 seats' compact cards do (480x560: 334px board vs 370px).
     * Measure the board both ways and keep the compact cards when they leave
     * it bigger. Cached per seat count and window size (one measure per
     * layout, not per render); re-checked when the window resizes.
     */
    _chooseCompact(box, n) {
        if (n >= 5) return;
        const internal = typeof ScreenManager !== 'undefined' && ScreenManager.getScreenType() === 'internal';
        const board = document.getElementById('board');
        if (!internal || !board) { box.classList.remove('panels-compact'); return; }
        const key = `${n}:${window.innerWidth}x${window.innerHeight}`;
        if (this._compactKey !== key) {
            box.classList.remove('panels-compact');
            const roomy = board.getBoundingClientRect().width;
            box.classList.add('panels-compact');
            const compact = board.getBoundingClientRect().width;
            if (!roomy) { box.classList.remove('panels-compact'); return; }   // not laid out yet: decide next render
            this._compactKey = key;
            this._compactFor = compact > roomy + 1;
        }
        box.classList.toggle('panels-compact', this._compactFor);
        if (!this._compactResize) {
            this._compactResize = true;
            window.addEventListener('resize', () => {
                const b = document.getElementById('player-panels');
                const count = b ? b.querySelectorAll('.player-panel').length : 0;
                if (!count || count >= 5) return;
                this._chooseCompact(b, count);
                this._fillRoom();
            });
        }
    },

    _compactKey: null,
    _compactFor: false,

    /**
     * Cover display: when the cards miss fitting the column by a few px, the
     * column would scroll for nothing. Tighten them (panels-tight: no gaps,
     * no vertical padding; motorola-external.css) only when they overflow
     * at normal spacing, re-checked when the column resizes (fold, split
     * handle). A real overflow (8 seats, small zoom) still scrolls.
     */
    _fit(box) {
        box.classList.remove('panels-tight');
        if (box.scrollHeight > box.clientHeight) box.classList.add('panels-tight');
        if (!this._fitObserver && typeof ResizeObserver !== 'undefined') {
            let lastW = box.clientWidth, lastH = box.clientHeight;
            this._fitObserver = new ResizeObserver(() => {
                if (box.clientWidth === lastW && box.clientHeight === lastH) return;
                lastW = box.clientWidth; lastH = box.clientHeight;
                this._fit(box);
            });
            this._fitObserver.observe(box);
        }
    },

    /**
     * Internal display: the cards share the fixed room between the board and
     * the button spacer (motorola-internal.css), so they never change with
     * the turn. Below the name and cash lines a card shows its chips and
     * its CPU / Jail / 🔑 labels in place of the meta line (.panels-roomy)
     * when there is room for them at least as small squares (else the meta
     * line stays). The squares
     * are then as large as that room allows: one size for every card, the
     * largest at which each card's chips still fit (so they shrink only
     * when a player's holdings would no longer fit). Re-checked on every
     * render and when the column resizes (fold, zoom).
     */
    _fillRoom() {
        const box = document.getElementById('player-panels');
        if (!box) return;
        const internal = typeof ScreenManager !== 'undefined' && ScreenManager.getScreenType() === 'internal';
        const card = internal && box.querySelector('.player-panel');
        let room = 0;
        if (card) {
            // Under the name / cash lines, less the gap and the bottom inset
            const top = card.querySelector('.panel-top');
            const cs = getComputedStyle(card);
            room = card.clientHeight - parseFloat(cs.paddingTop) - top.offsetHeight - this.SETS_INSET;
        }
        // Try the chips; the meta line keeps its space either way (only
        // hidden), so the cards' and the board's sizes never depend on it
        let roomy = room >= this.PIP_MIN;
        box.classList.toggle('panels-roomy', roomy);
        if (roomy) {
            box.style.setProperty('--sets-h', `${room}px`);
            const sets = [...box.querySelectorAll('.panel-sets')];
            const fits = h => {
                this._pipSize(box, h);
                return sets.every(el => el.scrollHeight <= el.clientHeight + 0.5 && el.scrollWidth <= el.clientWidth + 0.5);
            };
            if (!fits(this.PIP_MIN)) roomy = false;   // too many chips: back to the meta line
            else {
                // Largest size that fits every card (binary search)
                let lo = this.PIP_MIN, hi = Math.min(this.PIP_MAX, Math.floor(room));
                if (fits(hi)) lo = hi;
                else {
                    while (hi - lo > 1) {
                        const mid = (lo + hi) >> 1;
                        if (fits(mid)) lo = mid; else hi = mid;
                    }
                }
                this._pipSize(box, lo);
            }
            box.classList.toggle('panels-roomy', roomy);
        }
        if (!this._roomObserver && typeof ResizeObserver !== 'undefined') {
            this._roomObserver = new ResizeObserver(() => this._fillRoom());
            this._roomObserver.observe(box);
        }
    },

    /** Square height h px (internal): width, digit and label sizes follow */
    _pipSize(box, h) {
        box.style.setProperty('--pip-h', `${h}px`);
        box.style.setProperty('--pip-w', `${Math.round(h * 0.8)}px`);
        box.style.setProperty('--pip-font', `${Math.max(7, Math.round(h * 0.72))}px`);
        box.style.setProperty('--flag-font', `${Math.min(13, Math.max(8, Math.round(h * 0.8)))}px`);
    },

    /** Internal chip squares: smallest worth showing, largest, and the px
     *  under the cash line kept clear (gap above + inset below) */
    PIP_MIN: 7,
    PIP_MAX: 22,
    SETS_INSET: 7,

    _counters: [],

    /** One chip per group the player holds part of, in board order (the
     *  colour groups, then railroads and utilities): a square per deed in
     *  the group, in board order, filled in the group colour for the ones
     *  they own (Baltic alone fills the second brown square), with their
     *  building count (1-4, H = hotel), under the board's see-through grey hatching when mortgaged; a
     *  ring around a whole set held with nothing mortgaged. The
     *  chips wrap only when a line can't hold them. Then any Get Out of
     *  Jail cards (jail itself is the card's look, .panel-jailed). Shown only where the cards have room (wide cover; internal
     *  .panels-roomy). */
    _setsHTML(state, p) {
        const owned = {};
        GameState.propertiesOf(state, p.id).forEach(id => {
            const g = BOARD[id].group;
            owned[g] = (owned[g] || 0) + 1;
        });
        const pip = id => {
            if (Rules.getOwner(state, id) !== p.id) return '<i></i>';
            if (state.tiles[String(id)].mortgaged) return '<i class="on mortgaged"></i>';
            const h = Rules.houseCount(state, id);
            return h ? `<i class="on" data-b="${h === 5 ? 'H' : h}"></i>` : '<i class="on"></i>';
        };
        const chips = Object.keys(GROUP_META).filter(g => owned[g]).map(g => {
            const meta = GROUP_META[g];
            const ids = Rules.tilesInGroup(g);
            // Ringed: the whole set held, none of it mortgaged
            const full = owned[g] === meta.size && !ids.some(id => state.tiles[String(id)].mortgaged);
            return `<span class="set-chip${full ? ' set-full' : ''}" style="--chip:${meta.color}"` +
                ` title="${meta.label} ${owned[g]}/${meta.size}">${ids.map(pip).join('')}</span>`;
        });
        if (p.getOutCards > 0) chips.push(`<span class="panel-flag">🔑×${p.getOutCards}</span>`);
        return chips.length ? `<div class="panel-sets">${chips.join('')}</div>` : '';
    },

    /** Count a cash figure (a "$123" text node) from one amount to another. */
    _countUp(node, from, to) {
        if (!node || node.nodeType !== 3 || typeof requestAnimationFrame === 'undefined') return;
        const MS = 550;
        const slot = this._counters.length;
        let start = null;
        const step = now => {
            if (start === null) start = now;
            const t = Math.min(1, (now - start) / MS);
            const eased = 1 - Math.pow(1 - t, 3);
            node.nodeValue = `$${Math.round(from + (to - from) * eased)}`;
            if (t < 1) this._counters[slot] = requestAnimationFrame(step);
        };
        node.nodeValue = `$${from}`;
        this._counters[slot] = requestAnimationFrame(step);
    },

    _esc(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.Panels = Panels;
}
