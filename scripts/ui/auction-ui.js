/**
 * UI: Auction
 *
 * Bid dialog shown while an auction awaits a human bidder: list price,
 * a live bidder table (who bid what, who is leading, who passed), an
 * expandable deed card, and Properties / Trade buttons so the bidder can
 * raise cash mid-auction. While CPUs bid, an open modal switches to a
 * spectator view that updates on every bid; it closes itself when the
 * auction resolves. CPUs bid via the engine pump. When no human is left in
 * the auction, the spectator view offers a "Skip to result" button that
 * fast-forwards the remaining CPU bids and jumps straight to the winner.
 *
 * Exports: window.AuctionUI
 */

const AuctionUI = {

    _deedFor: null,
    _deedOpen: false,
    _auctionOpen: false, // an auction view is currently in the modal
    _dismissed: null,    // auction key the human closed the spectator view for
    _tradeNote: null,    // { key, text, cls } answer to a trade made during this auction

    _key(state) {
        return state.auction ? `${state.turnNumber}:${state.auction.tileId}` : null;
    },

    render(state) {
        const a = state.auction;
        const bidderId = Auction.currentBidder(state);
        const bidder = state.players[bidderId];

        if (bidder.isCPU) {
            // Spectator view for humans watching CPU bids: opens as soon as
            // the auction starts, stays closed once dismissed, and never
            // clobbers an unrelated modal (deed / portfolio / trade).
            if (this._dismissed === this._key(state)) return;
            if (Modals.isOpen() && !this._auctionOpen) return;
            this._renderSpectator(state, bidder);
            return;
        }

        const tile = BOARD[a.tileId];
        const steps = Auction.BID_STEPS.filter(step => a.currentBid + step <= bidder.cash);

        const body = this._bodyEl(a);
        body.innerHTML = `
            ${this._tradeNoteHTML(state)}
            ${this._bandHTML(tile)}
            ${this._deedPanelHTML(a)}
            ${this._bidderTable(state, a, bidderId)}`;

        const buttons = steps.map(step => ({
            label: `Bid $${a.currentBid + step}`,
            class: 'btn-primary',
            grow: true,      // share the row equally so 3-digit bids don't reflow
            keepOpen: true, // stay open to watch the rest of the auction
            onClick: () => engine.dispatch({ type: 'AUCTION_BID', playerId: bidderId, amount: a.currentBid + step })
        }));
        // Footer rows: bids, then the side trips (Properties / Owners / Trade),
        // then Pass across the full width. The short cover sheet keeps Pass on
        // the side-trip row instead of spending a row on it.
        const grow = typeof ScreenManager === 'undefined' || ScreenManager.getScreenType() !== 'external';
        if (steps.length) buttons.push({ break: true });
        buttons.push({
            label: '🏠 Properties',
            class: 'btn-secondary btn-side', // one row on the internal display
            info: true,
            grow,
            onClick: () => PropertyUI.showPortfolio(bidderId)
        });
        buttons.push({
            label: '🗺 Owners',
            class: 'btn-secondary btn-side', // one row on the internal display
            info: true,
            grow,
            onClick: () => PropertyUI.showOwnership()
        });
        if (TradeUI.canPropose(state, bidderId)) {
            buttons.push({
                label: '🤝 Trade',
                class: 'btn-secondary btn-side', // one row on the internal display
                grow,
                onClick: () => TradeUI.openBuilder(bidderId)
            });
        }
        if (grow) buttons.push({ break: true });
        buttons.push({
            label: '⏭ Pass',
            class: 'btn-warning', // matches the Auction button on the buy decision
            grow,
            keepOpen: true,
            onClick: () => engine.dispatch({ type: 'AUCTION_PASS', playerId: bidderId })
        });

        this._auctionOpen = true;
        Modals.show({ titleHTML: this._titleHTML(tile), body, buttons });
        this._wireDeed(body);
        this._holdSheet(state, true);
        // ...and its rows: the spectator view reuses this font and row
        // height, so the table doesn't resize every time your turn to bid
        // comes round (its footer is shorter, which would otherwise stretch
        // or rescale the rows)
        const table = body.querySelector('.bidder-table');
        const rows = table ? [...table.querySelectorAll('tbody tr')] : [];
        // Measured with the deed shut: an open deed squeezes the rows
        if (rows.length && !this._deedOpen) {
            this._rowGeom = {
                key: this._key(state),
                font: parseFloat(getComputedStyle(table).fontSize),
                row: Math.max(...rows.map(r => r.getBoundingClientRect().height))
            };
        }
    },

    /** Read-only view while a CPU decides; refreshed on every bid. */
    _renderSpectator(state, bidder) {
        const a = state.auction;
        const tile = BOARD[a.tileId];
        const cpuOnly = a.activeBidders.every(id => state.players[id].isCPU);
        const body = this._bodyEl(a);
        const geom = this._rowGeom;
        // An open deed takes the room the held rows would stretch into
        if (geom && geom.key === this._key(state) && geom.font && geom.row && !this._deedOpenFor(a)) {
            body.classList.add('auction-rows-held');
            body.style.setProperty('--held-font', `${geom.font}px`);
            body.style.setProperty('--held-row', `${geom.row}px`);
        }
        body.innerHTML = `
            ${this._bandHTML(tile)}
            ${this._deedPanelHTML(a)}
            ${this._bidderTable(state, a, null, bidder.id)}`;
        // The cover hides this line (it pushed the sheet into a scrollbar)
        // and marks the deciding row with a spinner instead
        body.appendChild(Controls.thinkingNote(bidder, 'is deciding…'));
        this._auctionOpen = true;
        const buttons = [];
        // No humans left to bid — offer to jump straight to the winner instead
        // of watching every CPU bid tick by. Fast-forward resolves the auction
        // synchronously; the resulting state change closes this modal itself.
        if (cpuOnly) {
            buttons.push({
                label: '⏭ Skip to result',
                class: 'btn-warning', // matches the Pass / Auction button
                keepOpen: true,
                onClick: () => engine.fastForwardAuction()
            });
        }
        buttons.push({ label: '🗺 Owners', class: 'btn-secondary', info: true, onClick: () => { this._auctionOpen = false; PropertyUI.showOwnership(); } });
        buttons.push({ label: 'Close', class: 'btn-secondary', onClick: () => { this._auctionOpen = false; this._dismissed = this._key(state); } });
        Modals.show({
            titleHTML: this._titleHTML(tile),
            body,
            noX: true, // X crowds the title; the Close button below suffices
            buttons
        });
        this._wireDeed(body);
        this._holdSheet(state, false);
    },

    /**
     * Hold the sheet at the tallest height either view (bid sheet or
     * spectator) has reached in this auction, and at least the internal
     * display's cover height, so it never shrinks and grows back as the
     * turn to bid passes round or the bid buttons thin out.
     */
    _holdSheet(state, isBidSheet) {
        const key = this._key(state);
        const held = this._sheetHeight;
        const heldPx = held && held.key === key ? held.px : 0;
        // Before your first bid sheet of this auction, the spectator view
        // borrows the one from earlier auctions (same screen and table size)
        const sig = `${window.innerWidth}x${window.innerHeight}:${state.players.filter(p => !p.bankrupt).length}`;
        const prev = this._bidSheetPx && this._bidSheetPx.sig === sig ? this._bidSheetPx.px : 0;
        Modals.holdHeight(Math.max(heldPx, isBidSheet ? 0 : prev, this._coverPx()));
        const px = Modals.height();
        this._sheetHeight = { key, px: Math.max(heldPx, px) };
        if (isBidSheet) this._bidSheetPx = { sig, px };
        // The held body's height, for the internal sheet's text scaling
        // (cqh reads 0 there: the sheet has a min-height, not a height).
        // Measured once per auction and then kept: the text it sizes makes
        // the body taller, so re-measuring grew the sheet with every bid.
        const mb = document.getElementById('modal-body');
        const ab = mb && mb.querySelector('.auction-body');
        if (ab) {
            if (!this._bodyPx || this._bodyPx.key !== key) this._bodyPx = { key, px: mb.clientHeight };
            ab.style.setProperty('--sheet-h', `${this._bodyPx.px}px`);
        }
    },

    /**
     * Internal display: the sheet's height that reaches just above the board
     * centre's latest-event card, so the bid ticker underneath doesn't repeat
     * what the sheet already shows (0 elsewhere, or with no card).
     */
    _coverPx() {
        if (typeof ScreenManager === 'undefined' || ScreenManager.getScreenType() !== 'internal') return 0;
        const card = document.getElementById('announce');
        const rect = card && card.getBoundingClientRect();
        if (!rect || !rect.height) return 0;
        return window.innerHeight - rect.top + 4;
    },

    /**
     * Record how a mid-auction trade was answered. The bid dialog reopens
     * the instant the trade resolves, covering the log (and outliving the
     * toast), so the outcome is pinned at the top of the dialog until this
     * auction ends.
     */
    noteTrade(state, text, cls) {
        const key = this._key(state);
        if (key) this._tradeNote = { key, text, cls };
    },

    _tradeNoteHTML(state) {
        const n = this._tradeNote;
        if (!n || n.key !== this._key(state)) return '';
        return `<p class="auction-trade-note ${n.cls}">${this._esc(n.text)}</p>`;
    },

    /** Body wrapper. --rows (bidders + the lines around the table) lets the
     *  cover sheet scale the table's text to fill its height. */
    _bodyEl(a) {
        const body = document.createElement('div');
        body.className = 'auction-body';
        body.style.setProperty('--rows', (a.allBidders || a.activeBidders).length);
        return body;
    },

    /** Modal title: a small "Auction" kicker over the property name. The
     *  list price (shown in the title row only on the cover, where the
     *  colour band shrinks to a strip) follows the name. */
    /** The deed under the colour band, open or shut as the ⓘ left it. Both
     *  views (your bid and watching a CPU) carry it, so it stays put
     *  between bids; a new auction starts it shut. */
    _deedPanelHTML(a) {
        if (this._deedFor !== a.tileId) {
            this._deedFor = a.tileId;
            this._deedOpen = false;
        }
        return `<div class="auction-deed" id="auction-deed"${this._deedOpen ? '' : ' hidden'}>` +
            `${PropertyUI.deedHTML(a.tileId)}</div>`;
    },

    /** Is the deed open for this auction (before _deedPanelHTML resets it)? */
    _deedOpenFor(a) {
        return this._deedFor === a.tileId && this._deedOpen;
    },

    /** The ⓘ beside the name shows / hides the deed. */
    _wireDeed(body) {
        const deedBtn = document.querySelector('#modal-title .auction-deed-btn');
        if (!deedBtn) return;
        deedBtn.addEventListener('click', () => {
            const deed = body.querySelector('.auction-deed');
            this._deedOpen = deed.hidden;
            deed.hidden = !this._deedOpen;
            if (this._deedOpen) body.classList.remove('auction-rows-held');
            deedBtn.setAttribute('aria-expanded', String(this._deedOpen));
        });
    },

    /** Title: kicker, the name with its deed ⓘ, list price (cover only). */
    _titleHTML(tile) {
        const deedBtn = `<button type="button" class="auction-deed-btn" aria-controls="auction-deed" ` +
            `aria-expanded="${this._deedOpen}" aria-label="View deed for ${this._esc(tile.name)}">${Icons.svg('info')}</button>`;
        return `<span class="modal-kicker">🔨 Auction</span>` +
            `<span class="modal-title-main"><span class="modal-title-name">${this._esc(tile.name)}</span>${deedBtn}</span>` +
            `<span class="modal-title-price">List $${tile.price}</span>`;
    },

    /** Colour band like the deed's: group name left, list price right. */
    _bandHTML(tile) {
        const meta = tile.group && GROUP_META[tile.group];
        const color = meta ? meta.color : 'var(--text-muted)';
        const label = meta ? meta.label : 'Property';
        return `<div class="auction-band" style="background:${color}">` +
            `<span>${this._esc(label)}</span><span>List $${tile.price}</span></div>`;
    },

    /** Table of everyone in the auction. The bidder whose turn it is gets a
     *  solid accent row with a YOU tag; the leader a 🏆 on a green bid; a
     *  player who passed is struck through. decidingId: the CPU whose bid
     *  it is in the spectator view (a spinner by its bid, cover only). */
    _bidderTable(state, a, bidderId, decidingId = null) {
        const rows = (a.allBidders || a.activeBidders).map(id => {
            const p = state.players[id];
            const passed = !a.activeBidders.includes(id);
            const leading = a.currentWinner === id;
            const current = id === bidderId;
            const amount = a.bids && a.bids[id] !== undefined ? `$${a.bids[id]}` : '—';
            const spin = id === decidingId ? '<span class="cpu-thinking-spinner bidder-spinner" aria-hidden="true"></span>' : '';
            const bid = spin + (leading ? `<span class="bidder-trophy">🏆</span>${amount}` : amount);
            const cash = `$${p.cash || 0}`;   // no thousands comma, as everywhere else in the game
            const you = current ? '<span class="bidder-you">YOU</span>' : '';
            const cls = [passed ? 'bidder-passed' : '', leading ? 'bidder-leading' : '', current ? 'bidder-current' : '',
                id === decidingId ? 'bidder-deciding' : ''].filter(Boolean).join(' ');
            return `<tr class="${cls}"${passed ? ' title="Passed"' : ''}>
                <td class="bidder-name-cell"><span class="bidder-name" style="--token:${BoardRenderer.inkColor(id)}">${BoardRenderer.TOKEN_ICONS[p.token] || ''} ${this._esc(p.name)}</span>${you}</td>
                <td class="bidder-cash">${cash}</td>
                <td class="bidder-bid">${bid}</td>
            </tr>`;
        }).join('');
        return `<table class="bidder-table">
            <thead><tr><th>Bidder</th><th>Cash</th><th>Bid</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    },

    /** Close a lingering auction modal once the auction has resolved. */
    closeIfDone(state) {
        if (this._auctionOpen && !state.auction) {
            this._auctionOpen = false;
            Modals.close();
        }
    },

    /** Reopen the bid dialog after a side modal (deed/portfolio/trade) closes. */
    maybeReopen() {
        if (window.engine && engine.state.phase === GamePhase.AUCTION_IN_PROGRESS) {
            this.render(engine.state);
        }
    },

    _esc(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.AuctionUI = AuctionUI;
}
