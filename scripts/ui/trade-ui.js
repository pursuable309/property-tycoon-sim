/**
 * UI: Trading
 *
 * Two-column give/get trade builder for humans (properties grouped by color
 * with swatches, inline expandable deeds, cash clamped to what each side
 * actually has), and the incoming-offer dialog (accept / counter / reject).
 * Counter-offers prefill the builder with the countered trade.
 *
 * Exports: window.TradeUI
 */

const TradeUI = {

    _playerTagHTML(player) {
        const esc = document.createElement('span');
        esc.textContent = player.name;
        const icon = BoardRenderer.TOKEN_ICONS[player.token] || '●';
        const color = BoardRenderer.inkColor(player.id);
        return `<span class="trade-player-tag" style="color:${color}">${icon} ${esc.innerHTML}</span>`;
    },

    /** Whether playerId may still propose a trade this turn (engine limit). */
    canPropose(state, playerId) {
        const used = (state.tradeAttempts && state.tradeAttempts[playerId]) || 0;
        return !window.engine || used < engine.tradeLimit;
    },

    /**
     * Open the builder. prefill: optional offer to seed the form with; when
     * prefill.counter is set it answers a pending trade (sends COUNTER_TRADE,
     * cancelling rejects), otherwise it is just a pre-checked new proposal.
     */
    openBuilder(fromId, prefill) {
        const isCounter = !!(prefill && prefill.counter);
        const state = engine.state;
        const me = state.players[fromId];
        const partners = GameState.activePlayers(state).filter(p => p.id !== fromId);
        if (partners.length === 0) return;

        const wrap = document.createElement('div');
        wrap.className = 'trade-builder';

        // Partner picker: segmented pills for a handful of opponents, a dropdown
        // for a crowded table, and just the name when there's only one choice.
        const initialPartner = (prefill && prefill.to != null) ? prefill.to : partners[0].id;
        let partnerId;
        const partnerRow = document.createElement('div');
        partnerRow.className = 'trade-partner-row';
        const partnerLabel = document.createElement('span');
        partnerLabel.className = 'trade-partner-label';
        partnerLabel.textContent = 'Trade with: ';
        partnerRow.appendChild(partnerLabel);
        if (partners.length === 1) {
            const only = document.createElement('strong');
            only.innerHTML = this._playerTagHTML(partners[0]);
            partnerRow.appendChild(only);
            partnerId = () => partners[0].id;
        } else if (partners.length <= 4) {
            const seg = Segmented.el('trade-partner',
                partners.map(p => [p.id, this._playerTagHTML(p)]), initialPartner, 'Trade partner');
            seg.classList.add('trade-partner-seg');
            seg.addEventListener('change', () => build());
            partnerRow.appendChild(seg);
            partnerId = () => Number(Segmented.value(seg, 'trade-partner'));
        } else {
            const sel = document.createElement('select');
            sel.className = 'trade-partner';
            partners.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = `${BoardRenderer.TOKEN_ICONS[p.token] || '●'} ${p.name}`;
                if (p.id === initialPartner) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => build());
            partnerRow.appendChild(sel);
            partnerId = () => Number(sel.value);
        }
        wrap.appendChild(partnerRow);

        // A counter-offer must go back to the player who made the offer. Other
        // players can still be picked to browse their holdings for context, but
        // their deeds/cash are shown read-only and cannot be pulled into the
        // counter (that would be a brand-new proposal, not a counter).
        const counterTargetId = isCounter ? prefill.to : null;
        const browsing = () => isCounter && partnerId() !== counterTargetId;

        const columns = document.createElement('div');
        columns.className = 'trade-columns';

        // Side tabs (shown only where the two columns stack, i.e. the internal
        // display): one side at a time, each tab summarising its selection so
        // the other side is never a long scroll away.
        const tabs = document.createElement('div');
        tabs.className = 'trade-tabs';
        tabs.setAttribute('role', 'tablist');
        const showSide = role => {
            columns.dataset.show = role;
            tabs.querySelectorAll('.trade-tab').forEach(t =>
                t.setAttribute('aria-selected', String(t.dataset.role === role)));
        };
        const mkTab = role => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'trade-tab';
            b.dataset.role = role;
            b.setAttribute('role', 'tab');
            b.addEventListener('click', () => showSide(role));
            tabs.appendChild(b);
            return b;
        };
        const giveTab = mkTab('give');
        const getTab = mkTab('get');
        const sideSummary = role => {
            const col = columns.querySelector(`.trade-col[data-role="${role}"]`);
            if (!col) return '';
            const n = col.querySelectorAll('.trade-prop input:checked').length
                + (col.querySelector('.trade-jail-cb:checked') ? 1 : 0);
            const cashIn = col.querySelector('.trade-cash-input');
            const c = cashIn ? Number(cashIn.value) || 0 : 0;
            const parts = [];
            if (n) parts.push(`${n} item${n > 1 ? 's' : ''}`);
            if (c) parts.push(`$${c}`);
            return parts.join(' + ') || 'nothing yet';
        };
        const refreshTabs = () => {
            giveTab.innerHTML = `<span class="trade-tab-title">You give</span>` +
                `<span class="trade-tab-sum">${sideSummary('give')}</span>`;
            getTab.innerHTML = `<span class="trade-tab-title">${this._playerTagHTML(state.players[partnerId()])} gives</span>` +
                `<span class="trade-tab-sum">${sideSummary('get')}</span>`;
        };
        showSide('give');
        wrap.appendChild(tabs);
        wrap.appendChild(columns);

        // Live give/get value estimate (gated by the setting). Recomputed from
        // the current selection on every checkbox/cash edit via delegation.
        const balance = document.createElement('div');
        balance.className = 'trade-balance';
        wrap.appendChild(balance);
        const updateBalance = () => {
            refreshTabs();
            // While browsing another player's holdings, there is no offer to
            // score — just remind the human where the counter is actually going.
            if (browsing()) {
                balance.hidden = false;
                balance.className = 'trade-balance';
                balance.innerHTML = '<span class="trade-browse-note">Viewing '
                    + this._playerTagHTML(state.players[partnerId()])
                    + '’s properties for reference — your counter still goes to '
                    + this._playerTagHTML(state.players[counterTargetId]) + '.</span>';
                return;
            }
            const offer = this._collect(wrap, fromId, partnerId());
            if (DEV.tradeValueHint === false) { balance.hidden = true; }
            else { balance.hidden = false; this._renderBalance(balance, engine.state, offer); }
            // Proposer receives the "get" side; refresh its deeds' Off/On cash lines.
            this._refreshLiftLines(wrap, engine.state.players[fromId].cash, offer.get.cash - offer.give.cash);
        };

        // One-sided offer (a gift either way): the first Propose press shows
        // this warning instead of sending, so the human can review it; a second
        // press sends it. Any edit or partner switch disarms it again.
        const giftWarn = document.createElement('div');
        giftWarn.className = 'trade-gift-warning';
        giftWarn.hidden = true;
        wrap.appendChild(giftWarn);
        let giftArmed = false;
        const disarmGift = () => { giftArmed = false; giftWarn.hidden = true; };

        // Your own column is built once and kept, so switching partner only
        // swaps theirs and your selections (cash, deeds, jail card) survive.
        columns.appendChild(this._side(state, me, 'You give', 'give', prefill));
        const build = () => {
            const toId = partnerId();
            const old = columns.querySelector('.trade-col[data-role="get"]');
            if (old) old.remove();
            columns.appendChild(this._side(state, state.players[toId], 'You get', 'get', prefill, browsing()));
            disarmGift();
            updateBalance();
        };
        wrap.addEventListener('input', () => { disarmGift(); updateBalance(); });
        wrap.addEventListener('change', () => { disarmGift(); updateBalance(); });
        build();

        // Re-showable so the ownership overview can be consulted mid-build:
        // wrap keeps its checkbox/cash state while detached from the modal.
        const showBuilderModal = () => Modals.show({
            title: isCounter ? '🤝 Counter-offer' : '🤝 Propose Trade',
            body: wrap,
            buttons: [
                {
                    label: isCounter ? '📤 Send Counter' : '📤 Propose',
                    class: 'btn-primary',
                    keepOpen: true,
                    onClick: () => {
                        if (browsing()) {
                            showNotification(`Switch back to ${state.players[counterTargetId].name} to send your counter-offer.`, 'warning');
                            return;
                        }
                        const offer = this._collect(wrap, fromId, partnerId());
                        const check = Trading.validate(engine.state, offer);
                        if (!check.ok) { showNotification(check.reason, 'warning'); return; }
                        const empty = (s) => s.cash === 0 && s.properties.length === 0 && s.jailCards === 0;
                        if (!giftArmed && (empty(offer.give) || empty(offer.get))) {
                            const partnerTag = this._playerTagHTML(state.players[offer.to]);
                            giftWarn.innerHTML = '⚠️ ' + (empty(offer.give)
                                ? `You give nothing — this asks ${partnerTag} for a gift.`
                                : `${partnerTag} gives nothing — this is a donation from you.`)
                                + ` Review it, then press <strong>${isCounter ? 'Send Counter' : 'Propose'}</strong> again to send.`;
                            giftWarn.hidden = false;
                            giftArmed = true;
                            giftWarn.scrollIntoView({ block: 'nearest' });
                            return;
                        }
                        Modals.close();
                        if (isCounter) {
                            engine.dispatch({ type: 'COUNTER_TRADE', playerId: fromId, offer });
                        } else {
                            engine.dispatch({ type: 'PROPOSE_TRADE', offer });
                        }
                    }
                },
                { label: '🗺 Owners', class: 'btn-secondary', info: true, onClick: () => {
                    const tiles = Array.from(wrap.querySelectorAll('.trade-prop input:checked')).map(cb => Number(cb.value));
                    PropertyUI.showOwnership(showBuilderModal, tiles);
                } },
                // On a counter, backing out returns to the incoming-offer
                // dialog (still pending) rather than rejecting the whole trade.
                { label: isCounter ? 'Back' : 'Cancel', class: 'btn-secondary', onClick: () => {
                    if (isCounter) this.showIncoming(engine.state);
                    else AuctionUI.maybeReopen();
                } }
            ]
        });
        showBuilderModal();
    },

    _side(state, player, label, role, prefill, viewOnly) {
        const col = document.createElement('div');
        col.className = 'trade-col' + (viewOnly ? ' trade-col-viewonly' : '');
        col.dataset.role = role;
        col.dataset.playerId = player.id;

        // Prefill only applies when the column matches the countered offer's side
        const pre = prefill &&
            ((role === 'give' && prefill.from === player.id) ||
             (role === 'get' && prefill.to === player.id)) ? prefill[role] : null;

        const h = document.createElement('h3');
        if (role === 'get') {
            h.innerHTML = `${TradeUI._playerTagHTML(player)} gives`;
        } else {
            h.innerHTML = `${label} (${TradeUI._playerTagHTML(player)})`;
        }
        col.appendChild(h);

        // Browsing a non-counterparty: their holdings are shown for reference
        // only and every control below is disabled (see the end of this fn).
        if (viewOnly) {
            const tag = document.createElement('div');
            tag.className = 'trade-viewonly-tag';
            tag.textContent = 'View only';
            col.appendChild(tag);
        }

        // Cash: exact entry, plus a slider to scrub the whole 0..cash range with
        // round ± steppers — far more useful than fixed ½ / Max presets.
        const cashWrap = document.createElement('div');
        cashWrap.className = 'trade-cash';

        const cashTop = document.createElement('div');
        cashTop.className = 'trade-cash-top';
        const cashLabel = document.createElement('span');
        cashLabel.className = 'trade-cash-label';
        cashLabel.textContent = 'Cash $';
        cashTop.appendChild(cashLabel);

        const cash = document.createElement('input');
        cash.type = 'number';
        cash.min = 0;
        cash.max = player.cash;
        cash.step = 1;
        cash.value = pre ? Math.min(pre.cash, player.cash) : 0;
        cash.className = 'trade-cash-input';
        cashTop.appendChild(cash);

        const cashMax = document.createElement('span');
        cashMax.className = 'trade-cash-max';
        cashMax.textContent = `/ $${player.cash}`;
        cashTop.appendChild(cashMax);
        cashWrap.appendChild(cashTop);

        const clampCash = v => Math.max(0, Math.min(player.cash, Math.round(Number(v) || 0)));
        let cashSlider = null;
        const setCash = v => {
            cash.value = clampCash(v);
            if (cashSlider) cashSlider.value = cash.value;
            cash.dispatchEvent(new Event('input', { bubbles: true })); // refresh value estimate
        };
        // Typing / native spinner mirrors into the slider; the wrap's own input
        // listener already refreshes the estimate, so no re-dispatch here.
        cash.addEventListener('input', () => { if (cashSlider) cashSlider.value = clampCash(cash.value); });
        cash.addEventListener('change', () => setCash(cash.value));

        if (player.cash > 0) {
            const step = player.cash >= 2000 ? 100
                : (player.cash >= 500 ? 50
                : (player.cash >= 100 ? 10 : 5));
            const scrub = document.createElement('div');
            scrub.className = 'trade-cash-scrub';
            const stepBtn = (text, dir) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'trade-cash-step';
                b.textContent = text;
                b.setAttribute('aria-label', `${dir < 0 ? 'Less' : 'More'} cash ($${step})`);
                b.addEventListener('click', () => setCash(clampCash(cash.value) + dir * step));
                return b;
            };
            cashSlider = document.createElement('input');
            cashSlider.type = 'range';
            cashSlider.className = 'trade-cash-slider';
            cashSlider.min = 0;
            cashSlider.max = player.cash;
            cashSlider.step = step; // snap the scrub to round Monopoly increments; type an exact value in the field if needed
            cashSlider.value = clampCash(cash.value);
            cashSlider.setAttribute('aria-label', 'Cash amount');
            cashSlider.addEventListener('input', () => { cash.value = clampCash(cashSlider.value); });
            scrub.appendChild(stepBtn('−', -1));
            scrub.appendChild(cashSlider);
            scrub.appendChild(stepBtn('+', 1));
            cashWrap.appendChild(scrub);
        }

        col.appendChild(cashWrap);

        // Properties grouped by color. Groups with buildings are not tradeable:
        // shown locked + dimmed on both sides so built-up monopolies stay
        // visible for context.
        const props = GameState.propertiesOf(state, player.id);
        Object.keys(GROUP_META).forEach(group => {
            const built = Rules.tilesInGroup(group).some(t => Rules.houseCount(state, t) > 0);
            const ids = props.filter(id => BOARD[id].group === group);
            if (ids.length === 0) return;

            const head = document.createElement('div');
            head.className = 'trade-group-label' + (built ? ' locked' : '');
            head.innerHTML = `<span class="swatch" style="background:${GROUP_META[group].color}"></span>${GROUP_META[group].label}`
                + (built ? '<span class="trade-locked-tag" title="Buildings must be sold before this group can be traded">🔒 Built</span>' : '');
            col.appendChild(head);

            ids.forEach(tileId => {
                const tile = BOARD[tileId];
                const ts = state.tiles[String(tileId)];
                const item = document.createElement('div');
                item.className = 'trade-prop-wrap';

                const row = document.createElement('label');
                row.className = 'trade-prop' + (ts.mortgaged ? ' mortgaged' : '') + (built ? ' locked' : '');
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = tileId;
                if (built) cb.disabled = true;
                else if (pre && pre.properties.includes(tileId)) cb.checked = true;
                row.appendChild(cb);
                const houses = Rules.houseCount(state, tileId);
                row.append(` ${tile.name}${ts.mortgaged ? ' (M)' : ''}${houses === 5 ? ' 🏨' : (houses > 0 ? ' 🏠×' + houses : '')}`);
                item.appendChild(row);

                const info = document.createElement('button');
                info.type = 'button';
                info.className = 'trade-deed-btn';
                info.setAttribute('aria-label', `View deed for ${tile.name}`);
                info.innerHTML = Icons.svg('info');
                item.appendChild(info);

                const deed = document.createElement('div');
                deed.className = 'trade-deed';
                deed.hidden = true;
                item.appendChild(deed);
                info.addEventListener('click', () => {
                    if (deed.hidden && !deed.innerHTML) deed.innerHTML = PropertyUI.deedHTML(tileId);
                    deed.hidden = !deed.hidden;
                });

                // Only the receiving side (the proposer's "You get") decides
                // whether to lift a mortgaged deed on receipt; the toggle is
                // meaningful only while its property is actually selected, and
                // vanishes entirely under the simplified (no-fee) house rule.
                if (ts.mortgaged && role === 'get' && !(state.rules && state.rules.simpleMortgageTransfer)) {
                    const { row: liftRow, cb: liftCb } = this._liftToggle(tileId);
                    if (pre && pre.liftNow && pre.liftNow.includes(tileId)) liftCb.checked = true;
                    // Hide the toggle until its property is actually selected; the
                    // wrap-level change listener refreshes the Off/On lines/cash.
                    const sync = () => { liftRow.hidden = !cb.checked; if (!cb.checked) liftCb.checked = false; };
                    cb.addEventListener('change', sync);
                    sync();
                    item.appendChild(liftRow);
                }

                col.appendChild(item);
            });
        });

        if (player.getOutCards > 0) {
            const row = document.createElement('label');
            row.className = 'trade-jailcard';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'trade-jail-cb';
            if (pre && pre.jailCards > 0) cb.checked = true;
            row.appendChild(cb);
            row.append(' Get Out of Jail Free card');
            col.appendChild(row);
        }

        // View-only column (browsing a player who isn't the counter target):
        // deeds stay expandable via the ⓘ buttons, but nothing is selectable.
        if (viewOnly) {
            col.querySelectorAll('input').forEach(el => { el.disabled = true; });
            col.querySelectorAll('.trade-cash-step').forEach(el => { el.disabled = true; });
        }
        return col;
    },

    /**
     * A "lift the mortgage now" toggle for a mortgaged deed the player will
     * receive: a title + toggle, then an Off line and an On line spelling out
     * each choice's cost and resulting cash. The line text/cash is filled in by
     * _refreshLiftLines (which knows the whole offer); this just builds the DOM.
     */
    _liftToggle(tileId) {
        const row = document.createElement('div');
        row.className = 'trade-lift';

        const top = document.createElement('label');
        top.className = 'trade-lift-top';
        const title = document.createElement('span');
        title.className = 'trade-lift-title';
        title.textContent = 'Lift mortgage now';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'toggle trade-lift-cb';
        cb.dataset.tile = tileId;
        top.append(title, cb);

        const off = document.createElement('div');
        off.className = 'trade-lift-line trade-lift-off';
        const on = document.createElement('div');
        on.className = 'trade-lift-line trade-lift-on';

        row.append(top, off, on);
        return { row, cb };
    },

    /** Clone an offer with the answerer's lift choices set on the side they get. */
    _withLift(offer, liftNow) {
        const recv = offer.awaiting === offer.to ? 'give' : 'get';
        return { ...offer, [recv]: { ...offer[recv], liftNow } };
    },

    /**
     * Fill in every visible lift toggle's Off/On lines within `container`. Each
     * line ends with the receiver's cash AFTER the whole trade for that choice —
     * netting cash both ways plus every OTHER received mortgaged deed at its
     * current toggle state — so the amounts move as the offer is edited and as
     * other deeds are flipped. The active choice is highlighted. Only visible
     * rows count (in the builder, a deed's row is hidden until it's selected).
     */
    _refreshLiftLines(container, receiverCash, netCash) {
        const money = (n) => `<strong class="${n < 0 ? 'neg' : ''}">$${n}</strong>`;
        const rows = Array.from(container.querySelectorAll('.trade-lift')).filter(r => !r.hidden);
        let sumCurrent = 0;
        const info = rows.map(r => {
            const cb = r.querySelector('.trade-lift-cb');
            const id = Number(cb.dataset.tile);
            const fee = Rules.mortgageTransferFee(id);
            const un = Rules.unmortgageCost(id);
            const cur = cb.checked ? un : fee;   // this deed's cost at its current setting
            sumCurrent += cur;
            return { r, cb, fee, un, cur };
        });
        const base = receiverCash + netCash;     // cash after the deal, before mortgage costs
        info.forEach(({ r, cb, fee, un, cur }) => {
            const other = sumCurrent - cur;      // cost of the OTHER deeds, held fixed
            const offCash = base - other - fee;
            const onCash = base - other - un;
            const off = r.querySelector('.trade-lift-off');
            const on = r.querySelector('.trade-lift-on');
            off.innerHTML = `<span class="k">Off</span> pay $${fee} fee now, keep mortgaged — lift later for $${un} · cash after ${money(offCash)}`;
            on.innerHTML = `<span class="k">On</span> pay $${un} now — deed transfers unmortgaged · cash after ${money(onCash)}`;
            off.classList.toggle('active', !cb.checked);
            on.classList.toggle('active', cb.checked);
        });
    },

    _collect(wrap, fromId, toId) {
        const read = (col) => ({
            cash: Number(col.querySelector('.trade-cash-input').value) || 0,
            properties: Array.from(col.querySelectorAll('.trade-prop input:checked')).map(cb => Number(cb.value)),
            jailCards: col.querySelector('.trade-jail-cb:checked') ? 1 : 0,
            liftNow: Array.from(col.querySelectorAll('.trade-lift-cb:checked')).map(cb => Number(cb.dataset.tile))
        });
        const cols = wrap.querySelectorAll('.trade-col');
        return { from: fromId, to: toId, give: read(cols[0]), get: read(cols[1]) };
    },

    /**
     * Rough list-value comparison of the two sides, from the proposer's view.
     * Deliberately transparent (list/mortgage prices, cash at face, a nominal
     * jail-card value) rather than the CPU's strategic valuation — it exists to
     * flag lopsided swaps and spare the human mental arithmetic, not to price
     * monopolies. Mortgage transfer fees the proposer would owe on received
     * deeds are netted out of "you get".
     */
    _renderBalance(el, state, offer) {
        const JAIL_CARD_VALUE = 50;
        const assets = (side) => side.cash
            + side.properties.reduce((sum, id) =>
                sum + (state.tiles[String(id)].mortgaged ? Rules.mortgageValue(id) : BOARD[id].price), 0)
            + side.jailCards * JAIL_CARD_VALUE;
        const fees = (props) => (state.rules && state.rules.simpleMortgageTransfer) ? 0
            : props.reduce((sum, id) =>
                sum + (state.tiles[String(id)].mortgaged ? Rules.mortgageTransferFee(id) : 0), 0);

        const give = assets(offer.give);
        const get = assets(offer.get) - fees(offer.get.properties);
        if (give === 0 && get === 0) { el.innerHTML = ''; return; }

        const ratio = (give + get) > 0 ? (get - give) / (give + get) : 0;
        let verdict, cls;
        if (Math.abs(ratio) < 0.08) { verdict = 'looks even'; cls = 'fair'; }
        else if (ratio > 0) { verdict = 'in your favor'; cls = 'good'; }
        else { verdict = 'against you'; cls = 'bad'; }

        el.className = 'trade-balance ' + cls;
        el.innerHTML =
            `<span class="trade-balance-give">You give ≈ $${give}</span>` +
            `<span class="trade-balance-get">You get ≈ $${get}</span>` +
            `<span class="trade-balance-verdict">${verdict}</span>`;
    },

    /** Incoming offer dialog for the human in state.trade.awaiting. */
    showIncoming(state) {
        const offer = state.trade;
        const me = state.players[offer.awaiting];
        const other = state.players[offer.awaiting === offer.to ? offer.from : offer.to];
        const iAmTo = offer.awaiting === offer.to;
        const iGet = iAmTo ? offer.give : offer.get;
        const iGive = iAmTo ? offer.get : offer.give;

        const rounds = offer.counters || 0;
        const isCounter = rounds > 0;
        const canCounter = rounds < 3; // engine caps COUNTER_TRADE at 3 rounds

        const body = document.createElement('div');
        body.className = 'offer-body';
        // Rows on the longer side: the cover scales the text to fit them
        const rows = s => Math.max(1, (s.cash > 0 ? 1 : 0) + s.properties.length + (s.jailCards > 0 ? 1 : 0));
        body.style.setProperty('--items', Math.max(rows(iGet), rows(iGive)));
        if (isCounter) {
            const note = document.createElement('div');
            note.className = 'trade-counter-note';
            note.textContent = canCounter
                ? `Counter-offer · round ${rounds} of 3`
                : `Counter-offer · round ${rounds} of 3 (no counters left)`;
            body.appendChild(note);
        }
        body.appendChild(Modals.cashLine(me));
        const ctx = { me, other, iGet, iGive };
        const receiveBox = this._offerSide('You get', iGet, state, true, ctx, 'get');
        body.appendChild(receiveBox);
        body.appendChild(this._offerSide('You give', iGive, state, false, ctx, 'give'));
        // Same rough value check as the builder, from the answerer's side,
        // unless Settings → "Show trade value estimate" is off
        if (DEV.tradeValueHint !== false) {
            const balance = document.createElement('div');
            this._renderBalance(balance, state, { give: iGive, get: iGet });
            if (balance.innerHTML) body.appendChild(balance);
        }

        // Live per-deed Off/On cash lines while the receiver flips lift toggles.
        if (receiveBox.querySelector('.trade-lift-cb')) {
            const refreshLift = () => this._refreshLiftLines(receiveBox, me.cash, iGet.cash - iGive.cash);
            receiveBox.addEventListener('change', refreshLift);
            refreshLift();
        }

        const buttons = [
            { label: '✅ Accept', class: 'btn-primary', keepOpen: true, onClick: () => {
                const liftNow = Array.from(receiveBox.querySelectorAll('.trade-lift-cb:checked')).map(cb => Number(cb.dataset.tile));
                // Lifting on receipt raises the immediate cost; make sure it's affordable.
                if (liftNow.length) {
                    const check = Trading.validate(engine.state, this._withLift(offer, liftNow));
                    if (!check.ok) { showNotification(check.reason, 'warning'); return; }
                }
                Modals.close();
                engine.dispatch({ type: 'ACCEPT_TRADE', playerId: me.id, liftNow });
            } }
        ];
        buttons.push({ label: '🗺 Owners', class: 'btn-secondary', info: true, onClick: () => PropertyUI.showOwnership(() => this.showIncoming(engine.state), [...offer.give.properties, ...offer.get.properties]) });
        if (canCounter) {
            buttons.push({ label: '🤝 Counter', class: 'btn-secondary', onClick: () => {
                this.openBuilder(me.id, { counter: true, from: me.id, to: other.id, give: iGive, get: iGet });
            } });
        }
        buttons.push({ label: '✕ Reject', class: 'btn-danger', onClick: () => engine.dispatch({ type: 'REJECT_TRADE', playerId: me.id }) });

        const otherTag = this._playerTagHTML(other);
        Modals.show({
            titleHTML: isCounter ? `🤝 Counter-offer from ${otherTag}` : `🤝 Trade offer from ${otherTag}`,
            body,
            buttons
        });
    },

    /**
     * One side of an incoming offer as a column of mini deed cards: a colour
     * bar, the name, the price and what the card does to a set (counted after
     * the whole trade, so a two-for-one in the same colour reads right). Tap a
     * card to open its deed under it. When canLift is set (the side the
     * answerer receives), each mortgaged deed gets a "lift the mortgage now"
     * toggle. ctx: { me, other, iGet, iGive }; role: 'get' | 'give'.
     */
    _offerSide(label, side, state, canLift, ctx, role) {
        const box = document.createElement('div');
        box.className = `offer-side offer-${role}`;
        const h = document.createElement('h3');
        h.textContent = label;
        box.appendChild(h);

        const card = (cls, bar, name, sub) => {
            const el = document.createElement('div');
            el.className = `offer-card ${cls}`;
            el.style.setProperty('--bar', bar);
            const n = document.createElement('span');
            n.className = 'offer-card-name';
            n.textContent = name;
            el.appendChild(n);
            if (sub) el.appendChild(sub);
            return el;
        };
        const subLine = (parts, tone) => {
            const el = document.createElement('span');
            el.className = 'offer-card-sub' + (tone ? ` ${tone}` : '');
            el.textContent = parts.filter(Boolean).join(' · ');
            return el;
        };

        let any = false;
        if (side.cash > 0) {
            box.appendChild(card('offer-cash', 'var(--success)', `$${side.cash}`, subLine(['cash'])));
            any = true;
        }
        // Set count after the trade for whoever ends up holding the deed
        const holderAfter = (group) => {
            const holder = role === 'get' ? ctx.me : ctx.other;
            const inGroup = ids => ids.filter(id => BOARD[id].group === group).length;
            const moved = role === 'get'
                ? inGroup(ctx.iGet.properties) - inGroup(ctx.iGive.properties)
                : inGroup(ctx.iGive.properties) - inGroup(ctx.iGet.properties);
            return Rules.countOwnedInGroup(state, holder.id, group) + moved;
        };
        side.properties.forEach(tileId => {
            const tile = BOARD[tileId];
            const ts = state.tiles[String(tileId)] || {};
            const meta = tile.group && GROUP_META[tile.group];
            const price = ts.mortgaged ? `mortgaged ($${Rules.mortgageValue(tileId)})` : `$${tile.price}`;
            let setNote = '', tone = '';
            if (meta) {
                const n = holderAfter(tile.group);
                const full = n >= meta.size;
                const street = tile.group !== 'railroad' && tile.group !== 'utility';
                if (role === 'get') {
                    setNote = full && street ? 'completes your set' : `you'd own ${n}/${meta.size}`;
                    if (full && street) tone = 'good';
                } else {
                    setNote = full && street ? `gives ${ctx.other.name} a set` : `they'd own ${n}/${meta.size}`;
                    if (full && street) tone = 'bad';
                }
            }
            const wrap = document.createElement('div');
            wrap.className = 'offer-card-wrap';
            const c = card('offer-prop' + (ts.mortgaged ? ' mortgaged' : ''), meta ? meta.color : '#888', tile.name,
                subLine([price, setNote], tone));
            c.setAttribute('role', 'button');
            c.tabIndex = 0;
            c.setAttribute('aria-label', `${tile.name}: view deed`);
            c.setAttribute('aria-expanded', 'false');
            wrap.appendChild(c);
            const deed = document.createElement('div');
            deed.className = 'trade-deed';
            deed.hidden = true;
            wrap.appendChild(deed);
            const toggle = () => {
                if (deed.hidden && !deed.innerHTML) deed.innerHTML = PropertyUI.deedHTML(tileId);
                deed.hidden = !deed.hidden;
                c.setAttribute('aria-expanded', String(!deed.hidden));
            };
            c.addEventListener('click', toggle);
            c.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            });
            if (canLift && ts.mortgaged && !(state.rules && state.rules.simpleMortgageTransfer)) {
                wrap.appendChild(this._liftToggle(tileId).row);
            }
            box.appendChild(wrap);
            any = true;
        });
        if (side.jailCards > 0) {
            const name = side.jailCards > 1 ? `${side.jailCards}× Get Out of Jail Free` : 'Get Out of Jail Free';
            box.appendChild(card('offer-jail', 'var(--warning, #f0ad4e)', name, subLine(['card'])));
            any = true;
        }
        if (!any) {
            const row = document.createElement('div');
            row.className = 'offer-nothing';
            row.textContent = 'nothing';
            box.appendChild(row);
        }
        return box;
    }
};

if (typeof window !== 'undefined') {
    window.TradeUI = TradeUI;
}
