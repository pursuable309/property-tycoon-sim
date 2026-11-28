/**
 * UI: Property Cards & Management
 *
 * Property detail modal (deed card) with build/sell/mortgage actions for the
 * owner on their turn, and a portfolio list per player.
 *
 * Exports: window.PropertyUI
 */

const PropertyUI = {

    /** Deed card markup (band + rent table), reusable by other dialogs. */
    deedHTML(tileId) {
        const state = engine.state;
        const tile = BOARD[tileId];
        const ts = state.tiles[String(tileId)];
        const owner = ts && ts.owner !== null ? state.players[ts.owner] : null;

        let html = '';
        if (tile.group && GROUP_META[tile.group]) {
            html += `<div class="deed-band" style="background:${GROUP_META[tile.group].color}">${GROUP_META[tile.group].label}</div>`;
        }
        html += `<table class="deed-table">`;
        if (tile.price) html += `<tr class="deed-price"><td>Price</td><td>$${tile.price}</td></tr>`;
        const balanced = Rules.balancedRents(state);
        if (tile.type === 'property') {
            const labels = ['Rent', '1 house', '2 houses', '3 houses', '4 houses', 'Hotel'];
            // When owned (and not mortgaged), highlight the rent row currently in
            // force: index = house count (0 = base rent). A full-group base rent
            // is doubled, so show the doubled amount on the base row.
            const live = owner && ts && !ts.mortgaged;
            const activeIdx = ts ? ts.houses : -1;
            const monopoly = owner && Rules.ownsFullGroup(state, ts.owner, tile.group);
            Rules.rentTable(state, tileId).forEach((r, i) => {
                const active = live && i === activeIdx;
                const doubled = active && i === 0 && monopoly;
                const amount = doubled ? r * 2 : r;
                const note = doubled ? ' <span class="deed-rent-note">×2 monopoly</span>' : '';
                html += `<tr class="deed-rent${active ? ' deed-rent-active' : ''}"><td>${labels[i]}${note}</td><td>$${amount}</td></tr>`;
            });
            html += `<tr><td>House cost</td><td>$${tile.houseCost}</td></tr>`;
        } else if (tile.type === 'railroad' || tile.type === 'utility') {
            // One rent row per number owned, like the house rows on a street;
            // the row in force (owner's count of this group) is highlighted.
            const rail = tile.type === 'railroad';
            const rents = balanced ? BALANCED_RENTS[tileId] : (rail ? [25, 50, 100, 200] : [4, 10]);
            const owned = owner && !ts.mortgaged
                ? Rules.tilesInGroup(tile.group).filter(t => Rules.getOwner(state, t) === ts.owner).length : 0;
            const noun = rail ? ['railroad', 'railroads'] : ['utility', 'utilities'];
            rents.forEach((r, i) => {
                const active = owned === i + 1;
                const label = `Rent, ${i + 1} ${noun[i === 0 ? 0 : 1]}`;
                const amount = rail ? `$${r}` : `${r}× dice`;
                html += `<tr class="deed-rent${active ? ' deed-rent-active' : ''}"><td>${label}</td><td>${amount}</td></tr>`;
            });
        }
        html += `<tr><td>Mortgage</td><td>$${Rules.mortgageValue(tileId)}</td></tr>`;
        html += `<tr class="deed-owner"><td>Owner</td><td>${owner ? this._esc(owner.name) : 'Bank'}</td></tr>`;
        // Buildings need no row of their own: the highlighted rent row says it
        if (ts && ts.mortgaged) html += `<tr class="deed-status"><td>Status</td><td>Mortgaged</td></tr>`;
        html += `</table>`;
        return html;
    },

    /** The player currently allowed to manage property: the bidder during an
     *  auction, the debtor during debt settlement (who may not be the turn
     *  player — e.g. a creditor owing mortgage-transfer interest), otherwise
     *  whoever's turn it is. */
    _actorId(state) {
        if (state.phase === GamePhase.AUCTION_IN_PROGRESS) return Auction.currentBidder(state);
        if (state.phase === GamePhase.DEBT_SETTLEMENT && state.debt) return state.debt.debtorId;
        return state.currentPlayer;
    },

    /** The house manager is offered for a full set with no mortgaged lot:
     *  a mortgaged lot blocks building, and the set then has no houses to
     *  sell either (a lot can only be mortgaged with none in its set). */
    _canManageHouses(state, playerId, group) {
        return Rules.ownsFullGroup(state, playerId, group) &&
            !Rules.tilesInGroup(group).some(id => {
                const ts = state.tiles[String(id)];
                return ts && ts.mortgaged;
            });
    },

    /** onClose: optional "go back" callback for Close (e.g. reopen the trade
     *  modal this deed was viewed from); defaults to the auction reopen check. */
    showTile(tileId, onClose) {
        const state = engine.state;
        const tile = BOARD[tileId];
        const ts = state.tiles[String(tileId)];
        const owner = ts && ts.owner !== null ? state.players[ts.owner] : null;
        const html = this.deedHTML(tileId);

        const buttons = [];
        const inAuction = state.phase === GamePhase.AUCTION_IN_PROGRESS;
        const actorId = this._actorId(state);
        const me = state.players[actorId];
        if (owner && owner.id === actorId && !me.isCPU) {
            // All building goes through the group house manager, which
            // phase-gates build/sell itself (selling stays available while
            // raising cash in auctions and debt settlement).
            // Every deed action gets a full-width row of its own (`top`) above
            // Close, so Close is always the bottom button and nothing moves
            // into a habitual tap's spot. Mortgage also takes two taps.
            // Mortgage and Manage houses together share one row: Mortgage
            // left, Manage houses right (`half`). During an auction only
            // cash-raising actions are allowed.
            const canMortgage = Rules.canMortgage(state, me.id, tileId).ok;
            const canManage = tile.type === 'property' && this._canManageHouses(state, actorId, tile.group);
            if (canMortgage) {
                buttons.push({ label: `🏦 Mortgage (+$${Rules.mortgageValue(tileId)})`, class: 'btn-warning', top: true, half: canManage, confirm: 'Tap again to mortgage', onClick: () => engine.dispatch({ type: 'MORTGAGE', tileId, playerId: actorId }) });
            }
            if (canManage) {
                buttons.push({ label: '🏗 Manage houses', class: 'btn-primary', top: true, half: canMortgage, onClick: () => this.showGroup(tile.group, actorId) });
            }
            if (!inAuction && ts && ts.mortgaged && Rules.canUnmortgage(state, me.id, tileId).ok) {
                buttons.push({ label: `🏦 Unmortgage ($${Rules.unmortgageCost(tileId)})`, class: 'btn-primary', top: true, onClick: () => engine.dispatch({ type: 'UNMORTGAGE', tileId, playerId: actorId }) });
            }
        }
        // Owned by someone else: offer to open a trade asking for this tile
        const tradePhases = [GamePhase.AWAIT_PREROLL, GamePhase.AWAIT_ENDTURN,
            GamePhase.AWAIT_JAIL_CHOICE, GamePhase.AUCTION_IN_PROGRESS];
        if (owner && owner.id !== actorId && !owner.bankrupt && me && !me.isCPU &&
            tradePhases.includes(state.phase) && TradeUI.canPropose(state, actorId) &&
            (!tile.group || !Rules.tilesInGroup(tile.group).some(t => Rules.houseCount(state, t) > 0))) {
            buttons.push({ label: '🤝 Trade for this', class: 'btn-primary', top: true, onClick: () => {
                TradeUI.openBuilder(actorId, {
                    from: actorId, to: owner.id,
                    give: { cash: 0, properties: [], jailCards: 0 },
                    get: { cash: 0, properties: [tileId], jailCards: 0 }
                });
            } });
        }
        buttons.push({ label: 'Close', class: 'btn-secondary', onClick: () => onClose ? onClose() : AuctionUI.maybeReopen() });

        // Human actor with money actions on the table sees their cash up top
        const cash = me && !me.isCPU && owner && owner.id === actorId ? Modals.cashHTML(me) : '';
        Modals.show({ title: tile.name, body: cash + html, buttons });
    },

    /**
     * A square nobody can own (GO, Jail, Free Parking, Go To Jail, the card
     * squares, the taxes), opened by tapping it on the board: what it does
     * under this game's rules, and who stands there. Read-only, one Close.
     */
    showSpace(tileId) {
        const state = engine.state;
        const tile = BOARD[tileId];
        const C = GAME_CONST;
        const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
        const deckLeft = (name) => state.decks && state.decks[name] ? state.decks[name].length : null;
        let rows = '';
        switch (tile.type) {
            case 'go':
                rows = row('Pass or land', `Collect $${C.GO_SALARY}`);
                if (state.rules && state.rules.delayedBuy && state.buyingUnlocked === false) {
                    rows += row('Buying', 'Opens once anyone reaches GO');
                }
                break;
            case 'jail':
                rows = row('Landing here', 'Just visiting') +
                    row('Get out', `Pay $${C.JAIL_FINE}, use a card, or roll doubles`) +
                    row('After 3 turns', `Pay $${C.JAIL_FINE} and move`);
                break;
            case 'parking':
                if (state.rules && state.rules.freeParking) {
                    rows = row('Landing here', 'Collect the jackpot') +
                        row('Jackpot now', `$${state.freeParkingPot || 0}`);
                } else {
                    rows = row('Landing here', 'Nothing happens');
                }
                break;
            case 'gotojail':
                rows = row('Landing here', 'Go straight to Jail') +
                    row('Passing GO', `No $${C.GO_SALARY} on the way`);
                break;
            case 'chance':
            case 'chest': {
                const name = tile.type === 'chance' ? 'chance' : 'community';
                const left = deckLeft(name);
                rows = row('Landing here', `Draw a ${tile.type === 'chance' ? 'Chance' : 'Community Chest'} card`);
                if (left !== null) rows += row('Cards in the deck', String(left));
                break;
            }
            case 'tax':
                rows = row('Landing here', `Pay $${tile.amount}`);
                break;
            default:
                return;
        }
        const here = state.players
            .filter(p => !p.bankrupt && p.position === tileId && !(tile.type === 'jail' && p.inJail))
            .map(p => this._seatName(p));
        const jailed = tile.type === 'jail'
            ? state.players.filter(p => !p.bankrupt && p.inJail).map(p => this._seatName(p)) : [];
        if (jailed.length) rows += row('In jail', jailed.join(', '));
        if (here.length) rows += row(tile.type === 'jail' ? 'Visiting' : 'Here now', here.join(', '));
        Modals.show({
            title: tile.name,
            body: `<table class="deed-table">${rows}</table>`,
            buttons: [{ label: 'Close', class: 'btn-secondary', onClick: () => AuctionUI.maybeReopen() }]
        });
    },

    /** A seat's token and name in its ink colour, escaped. */
    _seatName(p) {
        const div = document.createElement('div');
        div.textContent = p.name;
        return `<span style="color:${BoardRenderer.inkColor(p.id)}">${BoardRenderer.TOKEN_ICONS[p.token] || ''} ${div.innerHTML}</span>`;
    },

    /**
     * Group house manager: per-tile +/- plus bulk "1 on each" rows. Edits
     * build a pending plan against a simulated copy of the state; nothing is
     * bought or sold until the player hits Confirm, which replays the plan
     * through the engine. Even-building order is handled by the simulation.
     */
    showGroup(group, actorId) {
        const targets = {};
        Rules.tilesInGroup(group).forEach(id => { targets[id] = Rules.houseCount(engine.state, id); });
        this._renderGroup(group, actorId, targets);
    },

    /**
     * Try to reach `targets` (tileId -> house count) from the live state on a
     * cloned copy. Each pass sells most-built first and builds least-built
     * first; failed steps fall through, so e.g. breaking a hotel can wait for
     * the houses freed by upgrading another tile. Returns { sim, ops } with
     * the replayable action list, or null if the targets are unreachable
     * (uneven, unaffordable, or blocked by bank stock).
     */
    _planGroup(group, actorId, targets) {
        const sim = JSON.parse(JSON.stringify(engine.state));
        const ids = Rules.tilesInGroup(group);
        const ops = [];
        for (;;) {
            const sell = ids.filter(id => Rules.houseCount(sim, id) > targets[id])
                .sort((a, b) => Rules.houseCount(sim, b) - Rules.houseCount(sim, a))
                .find(id => PropertyActions.sellHouse(sim, actorId, id).ok);
            if (sell !== undefined) { ops.push({ type: 'SELL_HOUSE', tileId: sell }); continue; }
            const build = ids.filter(id => Rules.houseCount(sim, id) < targets[id])
                .sort((a, b) => Rules.houseCount(sim, a) - Rules.houseCount(sim, b))
                .find(id => PropertyActions.buildHouse(sim, actorId, id).ok);
            if (build === undefined) break;
            ops.push({ type: 'BUILD_HOUSE', tileId: build });
        }
        return ids.every(id => Rules.houseCount(sim, id) === targets[id]) ? { sim, ops } : null;
    },

    _renderGroup(group, actorId, targets) {
        const state = engine.state;
        const me = state.players[actorId];
        const ids = Rules.tilesInGroup(group);
        const meta = GROUP_META[group];
        const houseCost = BOARD[ids[0]].houseCost;
        const manageable = [GamePhase.AWAIT_PREROLL, GamePhase.AWAIT_ENDTURN, GamePhase.AWAIT_JAIL_CHOICE];
        const canBuildPhase = manageable.includes(state.phase);
        const canSellPhase = canBuildPhase ||
            state.phase === GamePhase.DEBT_SETTLEMENT ||
            state.phase === GamePhase.AUCTION_IN_PROGRESS;

        const plan = this._planGroup(group, actorId, targets);
        const net = plan.sim.players[actorId].cash - me.cash;
        const pending = plan.ops.length > 0;
        const icons = n => n === 5 ? '🏨' : (n > 0 ? '🏠'.repeat(n) : '—');

        /** New targets after one +/- step on a tile, or null if the step is
         *  not allowed. Steps back toward the current board state (undoing a
         *  pending change) skip the phase gates. */
        const stepped = (base, tileId, delta) => {
            const v = base[tileId] + delta;
            if (v < 0 || v > 5) return null;
            const real = Rules.houseCount(state, tileId);
            const undo = Math.abs(v - real) < Math.abs(base[tileId] - real);
            if (!undo && !(delta > 0 ? canBuildPhase : canSellPhase)) return null;
            const t = Object.assign({}, base, { [tileId]: v });
            return this._planGroup(group, actorId, t) ? t : null;
        };
        /** Bulk step: +/-1 on each tile, skipping tiles where it is illegal. */
        const bulkStepped = (delta) => {
            let t = targets;
            for (let i = 0; i < ids.length; i++) {
                const next = ids.slice()
                    .sort((a, b) => delta > 0 ? t[a] - t[b] : t[b] - t[a])
                    .map(id => stepped(t, id, delta))
                    .find(x => x !== null);
                if (!next) break;
                t = next;
            }
            return t === targets ? null : t;
        };

        const body = document.createElement('div');
        body.className = 'group-manage';

        body.appendChild(Modals.cashLine(me));
        const hint = document.createElement('p');
        hint.className = 'group-cash';
        hint.textContent = `Houses $${houseCost} each (sell +$${houseCost / 2})`;
        body.appendChild(hint);

        // Bank-stock block: when the next legal build in this group is stopped
        // only because the bank ran out of the piece it needs (32 houses / 12
        // hotels), say so — the + buttons otherwise just grey out silently.
        // Evaluated against the pending plan's sim so it reacts as queued
        // builds draw the stock down.
        let stockBlock = null;
        for (const id of ids) {
            const r = Rules.canBuildHouse(plan.sim, actorId, id);
            if (!r.ok && (r.reason === 'No houses left in the bank' ||
                          r.reason === 'No hotels left in the bank')) {
                stockBlock = r.reason;
                break;
            }
        }
        if (stockBlock) {
            const warn = document.createElement('p');
            warn.className = 'group-stock-warning';
            warn.textContent = `⚠ ${stockBlock} — cannot build here`;
            body.appendChild(warn);
        }

        ids.forEach(tileId => {
            const current = Rules.houseCount(state, tileId);
            const planned = targets[tileId];
            const row = document.createElement('div');
            row.className = 'group-row' + (planned !== current ? ' group-row-pending' : '');

            const name = document.createElement('span');
            name.className = 'group-row-name';
            name.textContent = BOARD[tileId].name;
            const marks = document.createElement('span');
            marks.className = 'group-row-houses';
            marks.textContent = icons(planned);
            if (planned !== current) {
                const d = planned - current;
                const badge = document.createElement('span');
                badge.className = 'group-delta ' + (d > 0 ? 'group-delta-plus' : 'group-delta-minus');
                badge.textContent = (d > 0 ? '+' : '−') + Math.abs(d);
                marks.appendChild(badge);
            }

            const mkBtn = (label, cls, delta, aria) => {
                const el = document.createElement('button');
                el.className = `btn ${cls} group-btn`;
                el.textContent = label;
                el.setAttribute('aria-label', aria);
                const next = stepped(targets, tileId, delta);
                el.disabled = next === null;
                el.addEventListener('click', () => { if (next) this._renderGroup(group, actorId, next); });
                return el;
            };
            const minus = mkBtn('−', 'btn-warning', -1, `Plan to sell a house on ${BOARD[tileId].name}`);
            const plus = mkBtn('+', 'btn-primary', 1, `Plan to build a house on ${BOARD[tileId].name}`);

            row.append(name, marks, minus, plus);
            body.appendChild(row);
        });

        const bulk = document.createElement('div');
        bulk.className = 'group-bulk';
        [[`−1 each (+$${(houseCost / 2) * ids.length})`, 'btn-warning', -1],
         [`+1 each ($${houseCost * ids.length})`, 'btn-primary', 1]].forEach(([label, cls, delta]) => {
            const el = document.createElement('button');
            el.className = `btn ${cls}`;
            el.textContent = label;
            const next = bulkStepped(delta);
            el.disabled = next === null;
            el.addEventListener('click', () => { if (next) this._renderGroup(group, actorId, next); });
            bulk.appendChild(el);
        });
        body.appendChild(bulk);

        // The summary and the Confirm/Reset buttons are ALWAYS rendered (idle
        // ones muted/disabled) so the modal keeps a constant height as taps flip
        // it in and out of the pending state — otherwise it would recenter and
        // slide the +/- button out from under a repeating finger.
        const summary = document.createElement('p');
        summary.className = 'group-plan-summary' + (pending ? '' : ' group-plan-summary-idle');
        if (pending) {
            const builds = plan.ops.filter(o => o.type === 'BUILD_HOUSE').length;
            const sells = plan.ops.length - builds;
            summary.innerHTML = 'Pending: ' +
                [builds && `build ${builds}`, sells && `sell ${sells}`].filter(Boolean).join(', ') +
                ` — cash after: <strong>$${plan.sim.players[actorId].cash}</strong>`;
        } else {
            summary.textContent = 'No pending changes';
        }
        body.appendChild(summary);

        const buttons = [];
        buttons.push({ label: pending ? 'Cancel' : 'Close', class: 'btn-secondary', onClick: () => AuctionUI.maybeReopen() });
        buttons.push({
            label: '↩ Reset', class: 'btn-warning', keepOpen: true,
            disabled: !pending,
            onClick: () => this.showGroup(group, actorId)
        });
        buttons.push({
            label: pending ? `✅ Confirm (${net >= 0 ? '+$' + net : '−$' + (-net)})` : '✅ Confirm',
            class: 'btn-success group-confirm-btn',
            disabled: !pending,
            onClick: () => this._applyPlan(group, actorId, plan.ops)
        });

        Modals.show({ title: `${meta.label} — houses`, body, buttons });
    },

    /** Replay a confirmed build plan through the engine (real mutations). */
    _applyPlan(group, actorId, ops) {
        for (const op of ops) {
            if (!engine.dispatch({ type: op.type, tileId: op.tileId, playerId: actorId }).ok) {
                showNotification('Could not apply the full build plan', 'error');
                break;
            }
        }
        AuctionUI.maybeReopen();
    },

    /**
     * "Who owns what" overview: every color group with each tile's owner,
     * buildings and mortgage state. Full sets are flagged with the owner;
     * contested groups show per-player count chips (2/3 etc.) so it is easy
     * to spot which trades would complete a monopoly. Tapping a row opens
     * the deed (with its Trade-for-this button). Available at any time.
     * onClose: optional "go back" callback threaded to Close and to deeds
     * opened from rows (used to return to the trade modal it was opened from).
     * highlightTiles: optional array of tile ids to flag as "in this trade"
     * (opened from the trade builder/offer), mirroring the auction highlight.
     */
    showOwnership(onClose, highlightTiles) {
        const state = engine.state;
        const body = document.createElement('div');
        body.className = 'ownership';

        // Mid-auction: jump to and highlight the group being bid on
        const auctionTile = state.auction ? state.auction.tileId : null;
        const auctionGroup = auctionTile !== null ? BOARD[auctionTile].group : null;

        // Opened from a trade: flag the properties on the table (and their groups)
        const tradeTiles = new Set(highlightTiles || []);
        const tradeGroups = new Set([...tradeTiles].map(id => BOARD[id].group));

        Object.keys(GROUP_META).forEach(group => {
            const meta = GROUP_META[group];
            const inAuction = group === auctionGroup;
            const inTrade = tradeGroups.has(group);
            const ids = Rules.tilesInGroup(group);
            const owners = ids.map(id => Rules.getOwner(state, id));
            const monopolist = owners.every(o => o !== null && o === owners[0]) ? owners[0] : null;

            const counts = {};
            owners.forEach(o => { if (o !== null) counts[o] = (counts[o] || 0) + 1; });
            const chips = monopolist !== null
                ? `<span class="ownership-chip ownership-full" style="color:${BoardRenderer.inkColor(monopolist)}">` +
                  `${BoardRenderer.TOKEN_ICONS[state.players[monopolist].token] || ''} FULL SET</span>`
                : Object.keys(counts).map(id =>
                    `<span class="ownership-chip" style="color:${BoardRenderer.inkColor(id)}">` +
                    `${BoardRenderer.TOKEN_ICONS[state.players[id].token] || ''} ${counts[id]}/${meta.size}</span>`
                  ).join('');

            const head = document.createElement('div');
            head.className = 'trade-group-label' + (inAuction ? ' ownership-auction' : '') +
                (inTrade ? ' ownership-trade' : '');
            const badge = inAuction ? '<span class="ownership-auction-badge">🔨 Auction</span>'
                : (inTrade ? '<span class="ownership-trade-badge">🤝 In trade</span>' : '');
            head.innerHTML = `<span class="swatch" style="background:${meta.color}"></span>` +
                `${meta.label}${badge}` +
                `<span class="ownership-chips">${chips}</span>`;
            body.appendChild(head);

            ids.forEach(tileId => {
                const ts = state.tiles[String(tileId)];
                const owner = ts && ts.owner !== null ? state.players[ts.owner] : null;
                const houses = ts ? ts.houses : 0;
                const row = document.createElement('button');
                row.className = 'ownership-row' + (ts && ts.mortgaged ? ' mortgaged' : '') +
                    (inAuction ? ' ownership-auction' : '') +
                    (tileId === auctionTile ? ' ownership-auction-tile' : '') +
                    (inTrade ? ' ownership-trade' : '') +
                    (tradeTiles.has(tileId) ? ' ownership-trade-tile' : '');
                row.innerHTML = `<span class="ownership-tile">${this._esc(BOARD[tileId].name)}</span>
                    <span class="ownership-houses">${houses === 5 ? '🏨' : (houses > 0 ? '🏠'.repeat(houses) : '')}</span>
                    <span class="ownership-owner"${owner ? ` style="color:${BoardRenderer.inkColor(owner.id)}"` : ''}>` +
                    `${owner ? `${BoardRenderer.TOKEN_ICONS[owner.token] || ''}<span class="ownership-owner-name"> ${this._esc(owner.name)}</span>` : '<em>Bank</em>'}</span>`;
                // The smallest cover shows the owner as a token only: keep the name readable
                if (owner) {
                    const label = `${BOARD[tileId].name}, ${owner.name}${ts && ts.mortgaged ? ', mortgaged' : ''}`;
                    row.title = label;
                    row.setAttribute('aria-label', label);
                }
                row.addEventListener('click', () => { Modals.close(); this.showTile(tileId, onClose && (() => this.showOwnership(onClose))); });
                body.appendChild(row);
            });
        });

        Modals.show({
            title: '🗺 Who owns what',
            body,
            buttons: [{ label: 'Close', class: 'btn-secondary', onClick: () => onClose ? onClose() : AuctionUI.maybeReopen() }]
        });
        if (auctionGroup || tradeGroups.size) {
            requestAnimationFrame(() => {
                const target = body.querySelector('.ownership-auction, .ownership-trade');
                if (target) target.scrollIntoView({ block: 'start' });
            });
        }
    },

    showPortfolio(playerId) {
        const state = engine.state;
        const player = state.players[playerId];
        const props = GameState.propertiesOf(state, playerId);

        const list = document.createElement('div');
        list.className = 'portfolio';
        list.appendChild(Modals.cashLine(player));
        if (props.length === 0) {
            list.innerHTML = '<p>No properties yet.</p>';
        }
        // Grouped by color, same order and header style as the trade builder
        Object.keys(GROUP_META).forEach(group => {
            const ids = props.filter(id => BOARD[id].group === group);
            if (ids.length === 0) return;

            const head = document.createElement('div');
            head.className = 'trade-group-label';
            head.innerHTML = `<span class="swatch" style="background:${GROUP_META[group].color}"></span>` +
                `${GROUP_META[group].label} (${ids.length}/${GROUP_META[group].size})`;
            // Own full color group: shortcut to the group house manager
            if (BOARD[ids[0]].type === 'property' && !player.isCPU &&
                playerId === this._actorId(state) &&
                this._canManageHouses(state, playerId, group)) {
                const manage = document.createElement('button');
                manage.className = 'group-manage-btn';
                Icons.label(manage, '🏗 Houses');
                manage.setAttribute('aria-label', `Manage houses on ${GROUP_META[group].label}`);
                manage.addEventListener('click', () => this.showGroup(group, playerId));
                head.appendChild(manage);
            }
            list.appendChild(head);

            ids.forEach(tileId => {
                const tile = BOARD[tileId];
                const ts = state.tiles[String(tileId)];
                const row = document.createElement('button');
                row.className = 'portfolio-row' + (ts.mortgaged ? ' mortgaged' : '');
                // The name (with its (M) / houses) ellipsizes; the rent stays whole
                row.innerHTML = `<span class="swatch" style="background:${GROUP_META[group].color}"></span>
                    <span class="portfolio-name">${this._esc(tile.name)}${ts.mortgaged ? ' <em>(M)</em>' : ''}${ts.houses > 0 ? (ts.houses === 5 ? ' 🏨' : ' 🏠×' + ts.houses) : ''}</span>
                    <span class="portfolio-rent">${this._rentLabel(state, tileId)}</span>`;
                row.addEventListener('click', () => { Modals.close(); this.showTile(tileId); });
                list.appendChild(row);
            });
        });

        Modals.show({
            title: `${player.name} — properties`,
            body: list,
            buttons: [{ label: 'Close', class: 'btn-secondary', onClick: () => AuctionUI.maybeReopen() }]
        });
    },

    /** What landing on an owned tile costs right now ("$90", "10× dice"),
     *  or '' when mortgaged. Shown in the portfolio on the wide cover. */
    _rentLabel(state, tileId) {
        const tile = BOARD[tileId];
        const ts = state.tiles[String(tileId)];
        if (!ts || ts.owner === null || ts.mortgaged) return '';
        if (tile.type === 'utility') {
            const n = Rules.countOwnedInGroup(state, ts.owner, 'utility');
            const x = Rules.balancedRents(state) ? BALANCED_RENTS[tileId][n - 1] : (n === 2 ? 10 : 4);
            return `rent ${x}× dice`;
        }
        return `rent $${Rules.calcRent(state, tileId, null, 0)}`;
    },

    _esc(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.PropertyUI = PropertyUI;
}
