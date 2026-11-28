/**
 * UI: Toast offset
 *
 * The Motorola layouts pin buttons to the bottom edge (internal: the game's
 * action row and every modal's footer; cover: every modal's footer), which is
 * exactly where the shared toasts (notifications.js, a shared copy that is
 * never edited here) appear. This moves the toasts where they cover the
 * least: inside the board centre just under the dice and turn line, over
 * the feed's older lines (internal: up to 2; cover: newest only), above an
 * open internal sheet, and on the cover above a sheet's buttons (newest
 * only), so a toast never covers a button, the player cards or another toast.
 *
 * Exports: window.ToastOffset
 */

const ToastOffset = {

    GAP: 8,          // px between the toast and the buttons below it
    ROOM_ABOVE: 64,  // internal: px above a sheet needed to show a toast there
    COVER_BOTTOM: 4, // cover board view: toasts' distance from the bottom edge
    CENTRE_PAD: 4,   // px between a toast and the board centre's edge
    POCKET_MIN: 34,  // cover with cameras: px free above a sheet's buttons for a toast there
    BAND_MIN: 28,    // internal: px the band over the feed needs to keep toasts off it
    LONG_MS: 8000,   // how long a long toast (showLong) stays up

    /** A toast that shows its whole text (no line clamp), stays LONG_MS
     *  instead of the shared 3 s, is never dropped for a newer toast, and
     *  goes on a tap. For messages worth reading in full (trades). The
     *  shared notifications.js is never edited: its toast is swapped for a
     *  copy this file times (the shared timers then act on the detached
     *  original, which does nothing). */
    showLong(message, type) {
        showNotification(message, type);
        const orig = document.querySelector('body > .notification:last-of-type');
        if (!orig) return;
        const el = orig.cloneNode(true);
        el.classList.add('toast-long');
        el.setAttribute('role', 'status');
        el.title = 'Tap to dismiss';
        orig.replaceWith(el);
        let gone = false;
        const hide = () => {
            if (gone) return;
            gone = true;
            el.classList.remove('show');
            setTimeout(() => el.remove(), 300);
        };
        el.addEventListener('click', hide);
        setTimeout(() => el.classList.add('show'), 10);
        setTimeout(hide, this.LONG_MS);
    },

    /** True when the board centre's event feed can't be seen (a sheet or
     *  dialog covers it, or the game screen isn't showing): toasts that
     *  only repeat a feed line (payments, CPU cards) show then and only then. */
    boardHidden() {
        const game = document.getElementById('screen-game');
        if (!game || game.hidden) return true;
        return typeof Modals !== 'undefined' && Modals.isOpen();
    },

    /** Settings > Notices is Bottom: on the board view toasts go to the
     *  screen's bottom edge instead of the board centre. */
    atBottom() {
        return typeof SettingsUI !== 'undefined' && SettingsUI.load().toastPos === 'bottom';
    },

    /** Cover with cameras: px from the left edge to the cameras. */
    _camLeft() {
        return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cam-left'))
            || window.innerWidth * ScreenManager.CAM_LEFT_SHARE;
    },

    /** Cover with cameras: px from the top edge to the cameras. */
    _camTop() {
        return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cam-top'))
            || window.innerHeight * ScreenManager.CAM_TOP_SHARE;
    },

    /** Distance (px) from the viewport bottom to the top of a row pinned at
     *  the bottom, or null if it isn't there (hidden, empty or mid-screen). */
    _rowHeight(el) {
        if (!el) return null;
        const fromBottom = window.innerHeight - el.getBoundingClientRect().top;
        return fromBottom > 0 && fromBottom <= window.innerHeight * 0.5 ? fromBottom : null;
    },

    /** Where toasts go (board view: Settings > Notices, see atBottom), or
     *  null to leave the shared default alone:
     *  { edge: 'top'|'bottom', base: px from that edge for the newest,
     *    max: how many show, limit: px from the edge no toast passes,
     *    except the newest, room: px from the edge the newest should stay
     *    within (past it, it is cut to one line) }.
     *  - Board, every display (_boardBand): in the board centre just
     *    under the dice and turn line, over the feed's top (its older
     *    lines), clear of the buttons; up to 2 on internal, 1 on the cover
     *    (internal falls back to above the action row with no centre).
     *  - Internal, sheet open: just above the sheet's top edge (over the
     *    board behind the backdrop), older ones stacking upward. A
     *    near-full-height sheet (trade builder) leaves no room: the newest
     *    alone goes at the screen's top over the title, never its content
     *    or buttons.
     *  - Wide cover (ScreenManager.isCoverWide), board: in the player
     *    column between the cards and its buttons, as many as fit (up to
     *    2; the board centre when the band is too narrow). Sheet open:
     *    the newest just above the sheet (or one line over its title).
     *  - Cover, sheet open, newest only: just above its buttons; with the
     *    cameras in the way (html.cover-cams), across the sheet's width
     *    just above the pocket's buttons and the cameras, or one line over
     *    the title when the content leaves no room there. */
    config() {
        const cfg = this._config();
        // Where toasts would share the default slot (full layout, home
        // screen), stack them while a long one is up so a newer one
        // doesn't cover it
        if (cfg === null && document.querySelector('body > .notification.toast-long')) {
            return { edge: 'bottom', base: 20, max: 2 };
        }
        return cfg;
    },

    _config() {
        if (typeof ScreenManager === 'undefined') return null;
        const type = ScreenManager.getScreenType();
        if (type !== 'internal' && type !== 'external') return null;
        const modalOpen = typeof Modals !== 'undefined' && Modals.isOpen();
        const sheet = modalOpen && document.querySelector('#modal-root .modal');
        // Bottom of the sheet's title row: a toast over the title that
        // would reach past it is cut to one line (see layout)
        const title = sheet && sheet.querySelector('#modal-title');
        const titleEnd = title && title.offsetHeight ? title.getBoundingClientRect().bottom : null;
        if (type === 'external') return this._coverConfig(modalOpen);
        if (modalOpen) {
            const top = sheet ? sheet.getBoundingClientRect().top : 0;
            // Over an auction sheet a stack would cover the bidder rows
            const max = document.querySelector('#modal-body .auction-body') ? 1 : 3;
            if (top >= this.ROOM_ABOVE) {
                // Sat on the sheet's top edge, older ones stacking upward
                // while they stay on screen
                return { edge: 'bottom', base: Math.round(window.innerHeight - top + this.GAP), max,
                    limit: window.innerHeight - this.GAP };
            }
            // No room above the sheet: the newest sits over its title
            return { edge: 'top', base: this.GAP, max: 1, room: titleEnd };
        }
        // Board: in the board centre under the dice and turn line (as on
        // the cover), up to 2 stacked downward over the feed's top; with
        // Notices: Bottom, at the bottom edge (above a pinned button row)
        const game = document.getElementById('screen-game');
        if (!game || game.hidden) return null;
        const band = this.atBottom() ? null : this._boardBand(2);
        if (band) return band;
        const h = this._rowHeight(document.getElementById('controls'));
        return { edge: 'bottom', base: Math.round((h === null ? 0 : h) + this.GAP), max: 2,
            limit: Math.round(window.innerHeight / 2) };
    },

    /** The board centre on the game screen, or null when it isn't showing:
     *  { rect, col: its inner column for the toasts, event: the latest
     *  event card's rect (or null), dice: the dice row's rect (or null) }. */
    _boardCentre() {
        const game = document.getElementById('screen-game');
        if (!game || game.hidden) return null;
        const centre = document.getElementById('board-center');
        const rect = centre && centre.getBoundingClientRect();
        if (!rect || rect.width < 120 || rect.height < 80) return null;
        const vis = el => {
            const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
            return r && r.height ? r : null;
        };
        const pad = this.CENTRE_PAD;
        return {
            rect,
            col: { left: rect.left + pad, width: rect.width - 2 * pad },
            event: vis(document.getElementById('announce')),
            dice: vis(document.getElementById('dice-area'))
        };
    },

    /** Cover: see config(). */
    _coverConfig(modalOpen) {
        const cams = document.documentElement.classList.contains('cover-cams');
        if (modalOpen) {
            const buttons = document.getElementById('modal-buttons');
            // Wide cover: the sheet is a centred box with free board above
            // it, so the newest toast sits just above its top edge
            if (!cams && ScreenManager.isCoverWide()) {
                const above = this._wideAboveSheet();
                if (above) return above;
            }
            if (cams) {
                // The footer fills the bottom-left pocket with its buttons at
                // the bottom: a toast takes the free room above the pocket
                // and the cameras when it fits, else one line over the
                // sheet's title (never the body)
                const first = buttons && buttons.querySelector('.btn');
                const box = buttons && buttons.getBoundingClientRect();
                // Its room reaches up to the pocket's top, or higher, to the
                // end of short content above it (game over, a card)
                // (where its text ends: a card's box fills the sheet with
                // its text centred in it)
                const body = document.getElementById('modal-body');
                if (first && box.height) {
                    const firstTop = first.getBoundingClientRect().top;
                    let contentEnd = box.top;
                    if (body && body.firstChild) {
                        const range = document.createRange();
                        range.selectNodeContents(body);
                        const text = range.getBoundingClientRect();
                        if (text.height) contentEnd = Math.min(text.bottom, body.getBoundingClientRect().bottom);
                    }
                    const ceiling = Math.min(contentEnd, box.top);
                    // The full sheet width, sat on the pocket's buttons and
                    // the cameras' top edge (whichever is higher), so it
                    // isn't squeezed into the pocket's narrow column
                    const floor = Math.min(firstTop, this._camTop());
                    if (floor - ceiling >= this.POCKET_MIN) {
                        return { edge: 'bottom', base: Math.round(window.innerHeight - floor + 4), max: 1,
                            room: Math.round(window.innerHeight - ceiling - 2), col: { left: 4, width: window.innerWidth - 8 } };
                    }
                }
                return this._titleSlot() || { edge: 'top', base: 2, max: 1 };
            }
            const h = this._rowHeight(buttons);
            // Content running down to the buttons (a scrolled portfolio on
            // the smallest cover) leaves no gap above them: one line over
            // the sheet's title instead, never over the rows
            if (h !== null && this._sheetGap(buttons) < this.POCKET_MIN) {
                const slot = this._titleSlot();
                if (slot) return slot;
            }
            return { edge: 'bottom', base: h === null ? this.COVER_BOTTOM : Math.round(h + this.GAP), max: 1 };
        }
        const cfg = { edge: 'bottom', base: this.COVER_BOTTOM, max: 1 };
        const game = document.getElementById('screen-game');
        // Wide cover: the buttons sit under the player cards, so toasts go
        // in the band of that column between the cards and the buttons
        // (as many as fit, the newest cut to one line when it doesn't),
        // never over a card; too narrow a band: the board centre instead
        if (game && !game.hidden && ScreenManager.isCoverWide()) {
            const wide = this._wideBand();
            if (wide) return wide;
            return this._boardBand(1) || cfg;
        }
        // Board: in the board centre under the dice and turn line, newest
        // only; with Notices: Bottom, at the bottom edge (with the cameras,
        // left of them, as over a sheet)
        if (this.atBottom()) {
            if (cams) cfg.col = { left: 4, width: this._camLeft() - 8 };
            return (!cams && this._underBoard()) || cfg;
        }
        // A centre too small for a band (the smallest cover, 270x195): the
        // free strip under the board, beside the player cards
        const band = this._boardBand(1);
        return band || this._underBoard() || cfg;
    },

    /** Cover sheet: one line over the sheet's title row, from its left edge
     *  up to the first button in it (the ✕, an auction's deed button), so a
     *  toast there never covers a button. Null with no title showing. */
    _titleSlot(base = 2) {
        const title = document.getElementById('modal-title');
        if (!title || !title.offsetHeight) return null;
        const head = title.parentElement.getBoundingClientRect();
        let right = head.right;
        title.parentElement.querySelectorAll('button').forEach(b => {
            const r = b.offsetHeight ? b.getBoundingClientRect() : null;
            if (r && r.left > head.left + 40) right = Math.min(right, r.left - 4);
        });
        // An auction's colour strip just under the title is decorative: the
        // toast may cover it too, so its text keeps two lines in the
        // narrower slot instead of being cut to one
        let room = title.getBoundingClientRect().bottom;
        const band = document.querySelector('#modal-body .auction-band');
        const b = band && band.offsetHeight ? band.getBoundingClientRect() : null;
        if (b && b.top - room < 12) room = b.bottom;
        return { edge: 'top', base, max: 1, room: Math.round(room),
            col: { left: head.left, width: right - head.left } };
    },

    /** Cover sheet: px of free room between the end of the body's content
     *  and the top of the button row (its text's end for short content such
     *  as a card, whose box fills the sheet). */
    _sheetGap(buttons) {
        const box = buttons.getBoundingClientRect();
        const body = document.getElementById('modal-body');
        let contentEnd = box.top;
        if (body && body.firstChild) {
            const range = document.createRange();
            range.selectNodeContents(body);
            const text = range.getBoundingClientRect();
            if (text.height) contentEnd = Math.min(text.bottom, body.getBoundingClientRect().bottom);
        }
        return box.top - contentEnd;
    },

    /** Cover board view where the board sits top-left with the player cards
     *  beside it (the smallest cover, 270x195): the strip under the board,
     *  at its width, so a toast covers no button or card. Toasts there are
     *  cut to 2 lines, 1 when 2 don't fit; a long one (trades) keeps its
     *  whole text and grows up over the board's bottom edge until it goes
     *  (8 s or a tap). Null when there is no such strip. */
    _underBoard() {
        const game = document.getElementById('screen-game');
        const board = document.getElementById('board');
        const panels = document.getElementById('player-panels');
        if (!game || game.hidden || !board || !panels) return null;
        const b = board.getBoundingClientRect();
        const p = panels.getBoundingClientRect();
        if (!b.height || !p.height || p.left < b.right - 1) return null;
        const free = window.innerHeight - b.bottom;
        if (free - this.COVER_BOTTOM < this.BAND_MIN) return null;
        // Buttons pinned under the board would share the strip
        const controls = document.getElementById('controls');
        if (controls && controls.offsetHeight && controls.getBoundingClientRect().bottom > b.bottom) return null;
        const room = Math.round(free - 2);
        return { edge: 'bottom', base: 2, max: 1, room, limit: room, clamp: true,
            col: { left: b.left, width: p.left - b.left - 4 } };
    },

    /** Wide cover, board view: the band of the player column between the
     *  last player card and the buttons (the cards sit centred in the
     *  column, so its box reaches the buttons but the cards don't), or
     *  null when it can't hold a one-line toast. */
    _wideBand() {
        const panels = document.getElementById('player-panels');
        const controls = document.getElementById('controls');
        if (!panels || !controls || !controls.offsetHeight) return null;
        const col = panels.getBoundingClientRect();
        let cardsEnd = col.top;
        panels.querySelectorAll('.player-panel').forEach(p => {
            const r = p.getBoundingClientRect();
            if (r.height) cardsEnd = Math.max(cardsEnd, r.bottom);
        });
        cardsEnd = Math.min(cardsEnd, col.bottom);
        const ctlTop = controls.getBoundingClientRect().top;
        if (ctlTop - cardsEnd - this.GAP - 4 < this.BAND_MIN) return null;
        const base = Math.round(window.innerHeight - ctlTop + this.GAP);
        const limit = Math.round(window.innerHeight - cardsEnd - 4);
        return { edge: 'bottom', base, max: 2, room: limit, limit, col: { left: col.left, width: col.width } };
    },

    /** Wide cover, sheet open: the newest toast just above the sheet's top
     *  edge (over the board behind the backdrop), under the status bar, at
     *  the sheet's width; a sheet too tall for that: over its title row
     *  (_titleSlot: clear of its buttons, never over the content). Null when
     *  neither is there. */
    _wideAboveSheet() {
        const sheet = document.querySelector('#modal-root .modal');
        if (!sheet) return null;
        const box = sheet.getBoundingClientRect();
        const bar = document.getElementById('status-bar');
        const barEnd = bar && bar.offsetHeight ? bar.getBoundingClientRect().bottom : 0;
        if (box.top - barEnd - this.GAP - 2 >= this.BAND_MIN) {
            return { edge: 'bottom', base: Math.round(window.innerHeight - box.top + this.GAP), max: 1,
                room: Math.round(window.innerHeight - barEnd - 2), col: { left: box.left, width: box.width } };
        }
        const title = document.getElementById('modal-title');
        if (!title || !title.offsetHeight) return null;
        return this._titleSlot(Math.round(title.getBoundingClientRect().top));
    },

    /** Board view, every display: toasts start just under the dice and
     *  turn line (never over the dice, the name or the buttons); on the
     *  cover they cover the top of the feed, where its older, muted lines
     *  are, on internal they end above the feed's card; the newest is
     *  cut to one line when two would reach the buttons. Null when the
     *  centre isn't showing. */
    _boardBand(max) {
        const c = this._boardCentre();
        if (!c) return null;
        const banner = document.getElementById('turn-banner');
        const turn = banner && banner.offsetParent !== null ? banner.getBoundingClientRect() : null;
        const top = Math.max(c.dice ? c.dice.bottom : c.rect.top, turn && turn.height ? turn.bottom : 0) + this.CENTRE_PAD;
        const controls = document.getElementById('controls');
        const inCentre = controls && controls.parentElement && controls.parentElement.id === 'board-center';
        const ctl = inCentre && controls.offsetHeight ? controls.getBoundingClientRect() : null;
        let end = (ctl ? ctl.top : c.rect.bottom) - this.CENTRE_PAD;
        // Internal: toasts start just under the dice, whatever the turn
        // line beside them does (a debt note or a long square name wraps
        // it onto more lines), so they keep one spot from turn to turn
        // (they may cover the turn line's extra lines while they show).
        // The feed is a card at the bottom of its room: the band ends at
        // its top and toasts never cover it (unless the band is too short
        // for a toast: then over its top).
        // Internal toasts here show their whole text (no one-line cut, no …)
        if (ScreenManager.getScreenType() === 'internal') {
            let base = (c.dice ? c.dice.bottom : top - this.CENTRE_PAD) + this.CENTRE_PAD;
            // A turn line taller than the dice (a long square's name wraps)
            // pushes the toast below it while two lines still fit above the
            // feed (CPU turns, whose pill sits in the feed card)
            if (top > base && c.event && c.event.top - this.CENTRE_PAD - top >= 2 * this.BAND_MIN) base = top;
            if (c.event && c.event.top - this.CENTRE_PAD - base >= this.BAND_MIN) end = c.event.top - this.CENTRE_PAD;
            return { edge: 'top', base: Math.round(base), max, limit: Math.round(end), col: c.col, full: true };
        }
        // Cover, CPU turn: the feed card sits low, leaving a slot under the
        // dice (motorola-external.css); the toast keeps to that slot (cut
        // to one line rather than covering the card) while it holds one
        const room = c.event && c.event.top - this.CENTRE_PAD - top >= this.BAND_MIN
            ? c.event.top - this.CENTRE_PAD : end;
        return { edge: 'top', base: Math.round(top), max, room: Math.round(room), limit: Math.round(end), col: c.col };
    },

    /** Stack the live toasts from the base: newest nearest the edge, older
     *  ones further in; past the limit they fade out until they expire.
     *  Run whenever a toast comes or goes or the pinned rows change. */
    layout() {
        // Newest first, except that a long toast (trade terms) goes first of
        // all: where two don't fit, a newer short one (a rejection, a
        // payment: both in the feed too) gives way rather than hiding it
        const all = Array.from(document.querySelectorAll('body > .notification')).reverse();
        const isLong = el => el.classList.contains('toast-long');
        const toasts = [...all.filter(isLong), ...all.filter(el => !isLong(el))];
        const cfg = this.config();
        if (cfg === null) {
            // Other layouts / nothing pinned: back to the shared default
            toasts.forEach(el => {
                el.style.bottom = ''; el.style.top = ''; el.style.left = ''; el.style.width = '';
                el.classList.remove('toast-overflow', 'toast-gone', 'toast-top', 'toast-1line', 'toast-full', 'toast-clamp');
            });
            return;
        }
        const top = cfg.edge === 'top';
        let at = cfg.base;
        // Wide cover board view: centred over the player column (set first:
        // the width decides the heights measured below)
        toasts.forEach(el => {
            el.classList.toggle('toast-full', !!cfg.full);
            // The strip under the board: slimmer, short toasts clamped (long ones keep their text)
            el.classList.toggle('toast-clamp', !!cfg.clamp);
            el.style.left = cfg.col ? `${Math.round(cfg.col.left + cfg.col.width / 2)}px` : '';
            el.style.width = cfg.col ? `${Math.round(cfg.col.width)}px` : '';
        });
        // Newest: one line instead of two when two would spill past its
        // room (internal: over a sheet's title onto the content; cover:
        // out of the gap under the board onto its bottom row)
        if (toasts[0]) {
            const el = toasts[0];
            el.classList.remove('toast-1line');
            if (cfg.room != null && !el.classList.contains('toast-long') && cfg.base + el.offsetHeight > cfg.room) el.classList.add('toast-1line');
        }
        toasts.slice(1).forEach(el => el.classList.remove('toast-1line'));
        // A long toast doesn't take one of the max slots and isn't pushed
        // out by newer ones (only by the limit), so it stays readable
        let shown = 0;
        toasts.forEach((el, i) => {
            const long = el.classList.contains('toast-long');
            const fits = i === 0 || cfg.limit === undefined || at + el.offsetHeight <= cfg.limit;
            const over = (!long && shown >= cfg.max) || !fits;
            if (!over && !long) shown++;
            el.classList.toggle('toast-overflow', over);
            if (over) {
                // Fades out where it is, no jump, unless it sits on the
                // other edge or (bottom) below the base (shown on the board,
                // then a modal opened): there it would fade over buttons or
                // the sheet, so it goes at once
                const wasTop = el.classList.contains('toast-top');
                const below = !top && !wasTop && parseFloat(el.style.bottom || getComputedStyle(el).bottom) < cfg.base;
                el.classList.toggle('toast-gone', below || wasTop !== top);
                return;
            }
            el.classList.remove('toast-gone');
            el.classList.toggle('toast-top', top);
            el.style.top = top ? `${at}px` : '';
            el.style.bottom = top ? '' : `${at}px`;
            at += el.offsetHeight + 6;
        });
    },

    init() {
        const isToast = n => n.nodeType === 1 && n.classList.contains('notification');
        const obs = new MutationObserver(records => {
            if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(isToast))) this.layout();
        });
        obs.observe(document.body, { childList: true });

        // A toast can show before the buttons do (a turn's buttons render
        // after its announcement; a modal opens right after a toast), so
        // re-stack whenever the pinned rows change size or a modal opens or
        // closes. Only does work while a toast is on screen.
        const relayout = () => {
            if (document.querySelector('body > .notification')) this.layout();
        };
        const watch = () => {
            const ro = new ResizeObserver(relayout);
            ['controls', 'modal-buttons'].forEach(id => {
                const el = document.getElementById(id);
                if (el) ro.observe(el);
            });
            const sheet = document.querySelector('#modal-root .modal');
            if (sheet) ro.observe(sheet);
            const root = document.getElementById('modal-root');
            if (root) new MutationObserver(relayout).observe(root, { attributes: true, attributeFilter: ['hidden'] });
            // Board <-> modal swaps can also just move the rows: catch those
            // on the next frames after any DOM change under the game screen
            const game = document.getElementById('screen-game');
            if (game) new MutationObserver(() => requestAnimationFrame(relayout))
                .observe(game, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
        else watch();
    }
};

if (typeof window !== 'undefined') {
    window.ToastOffset = ToastOffset;
    if (document.body) ToastOffset.init();
    else document.addEventListener('DOMContentLoaded', () => ToastOffset.init());
}
