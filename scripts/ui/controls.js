/**
 * UI: Controls & Status Bar
 *
 * Context-sensitive action bar driven by the game phase, plus the one-line
 * status bar. Renders on every stateChanged; also routes phase-driven modals
 * (auction / incoming trade / buy decision / game over) for human players.
 *
 * Exports: window.Controls
 */

const Controls = {

    _autoRollTimer: null,

    render(state) {
        this._statusBar(state);
        AuctionUI.closeIfDone(state);
        clearTimeout(this._autoRollTimer);
        const box = document.getElementById('controls');
        box.innerHTML = '';
        const centreNote = document.getElementById('centre-note');
        if (centreNote) centreNote.innerHTML = '';

        // The acting player: during debt settlement the debtor may not be the
        // turn player (a bankruptcy creditor can owe mortgage-transfer interest)
        const player = state.phase === GamePhase.DEBT_SETTLEMENT && state.debt
            ? state.players[state.debt.debtorId]
            : state.players[state.currentPlayer];
        const make = (label, cls, action, icon) => {
            const el = document.createElement('button');
            el.className = `btn ${cls}`;
            // icon: the emoji key of a line icon (icons.js); label: fixed UI text
            el.innerHTML = icon ? `<span class="btn-icon">${Icons.html(icon)}</span><span class="btn-text">${label}</span>` : label;
            el.setAttribute('aria-label', label);
            el.addEventListener('click', () => {
                if (typeof action === 'function') action();
                else engine.dispatch(action);
            });
            return el;
        };
        const btn = (...args) => box.appendChild(make(...args));
        this._fillGhost(make);
        // Only CPUs left (every human bankrupt): any CPU's move shows who is
        // thinking plus Skip to end as the main action, including CPU-only
        // auctions (no spectator sheet) and CPU-to-CPU trades. Mustard, like
        // the auction's Skip to result.
        const cpuOnly = this._humansOut(state) && !engine.fastForwarding;
        const cpuMove = who => {
            this._thinkingNote(box, who, !cpuOnly);
            if (cpuOnly) btn('Skip to end', 'btn-warning btn-lg ctl-main', () => this._skipToEnd(), '⏩');
        };

        if (state.phase === GamePhase.GAME_OVER) {
            this._gameOver(state);
            btn('New Game', 'btn-primary btn-lg ctl-main', () => { GameState.clearSave(); location.reload(); }, '🔄');
            return;
        }

        // Phase-driven human modals
        if (state.phase === GamePhase.AUCTION_IN_PROGRESS) {
            const bidder = state.players[Auction.currentBidder(state)];
            if (cpuOnly) cpuMove(bidder);
            else {
                // The board says who is bidding too, for when the spectator
                // sheet is closed or covered (Owners, a deed)
                if (bidder.isCPU) box.appendChild(this.thinkingNote(bidder, 'is deciding…'));
                AuctionUI.render(state);
            }
            return;
        }
        if (state.phase === GamePhase.TRADE_PENDING) {
            const awaiting = state.players[state.trade.awaiting];
            if (!awaiting.isCPU) {
                const proposer = state.players[state.trade.from];
                // Auto-reject: skip the dialog but still surface what the CPU wanted
                if (DEV.autoRejectCpuTrades && proposer.isCPU) this._autoRejectTrade(state);
                else TradeUI.showIncoming(state);
            } else {
                // A CPU is answering (often my own offer): say so, as on its turn
                cpuMove(awaiting);
            }
            return;
        }

        if (engine.fastForwarding) {
            const note = document.createElement('div');
            note.className = 'cpu-thinking ff-progress';
            note.innerHTML = '<span class="cpu-thinking-spinner" aria-hidden="true"></span><span class="ff-text"></span>';
            note.lastChild.textContent = this._ffText(state);
            box.appendChild(note);
            btn('Stop', 'btn-secondary ctl-main', () => { this._ffStop = true; }, '⏹');
            return;
        }

        if (player.isCPU) {
            cpuMove(player);
            return;
        }

        // Button grid: each row pairs an informational button on the left
        // (Properties, Deed) with an action on the right (Trade, Auction,
        // Pay fine, Bankruptcy); the turn's main action (Roll / Buy / End
        // Turn) takes the full-width bottom row. Built here as slots and
        // appended row by row, so the DOM order already reads left, right,
        // ..., main; layouts place .ctl-left / .ctl-right / .ctl-main, and
        // a button alone on its row (.ctl-wide) spans it.
        const left = [], right = [], main = [];
        const slot = (list, side) => (label, cls, action, icon) => list.push(make(label, `${cls} ${side}`, action, icon));
        const info = slot(left, 'ctl-left');
        const act = slot(right, 'ctl-right');
        const primary = slot(main, 'ctl-main');
        const props = () => info('Properties', 'btn-secondary ctl-props', () => PropertyUI.showPortfolio(player.id), '🏠');
        const trade = () => {
            if (TradeUI.canPropose(state, player.id)) act('Trade', 'btn-secondary ctl-trade', () => TradeUI.openBuilder(player.id), '🤝');
        };

        switch (state.phase) {
            case GamePhase.AWAIT_PREROLL:
                props(); trade();
                primary('Roll', 'btn-primary btn-lg', { type: 'ROLL_DICE' }, '🎲');
                if (DEV.autoRoll) this._scheduleAuto(state, GamePhase.AWAIT_PREROLL, 'ROLL_DICE');
                break;

            case GamePhase.AWAIT_JAIL_CHOICE:
                // Both ways out of jail share the second row (no info button
                // to pair with): Use card left, Pay right
                props(); trade();
                if (player.getOutCards > 0) info('Use card', 'btn-secondary', { type: 'JAIL_CARD' }, '🔑');
                if (player.cash >= GAME_CONST.JAIL_FINE) act(`Pay $${GAME_CONST.JAIL_FINE}`, 'btn-warning', { type: 'JAIL_PAY' }, '💵');
                primary('Roll for doubles', 'btn-primary btn-lg', { type: 'JAIL_ROLL' }, '🎲');
                if (DEV.autoRoll && DEV.autoRollJail) this._scheduleAuto(state, GamePhase.AWAIT_JAIL_CHOICE, 'JAIL_ROLL');
                break;

            case GamePhase.AWAIT_DECISION: {
                const tileId = state.pendingAction.tileId;
                const tile = BOARD[tileId];
                if (player.cash < tile.price) {
                    const note = document.createElement('div');
                    note.className = 'debt-banner debt-banner-buy';
                    note.textContent = `${tile.name} costs $${tile.price} — you have $${player.cash}. Mortgage, sell or trade to afford it, or send it to auction.`;
                    box.appendChild(note);
                }
                props(); trade();
                info('Deed', 'btn-secondary', () => PropertyUI.showTile(tileId), '📋');
                act('Auction', 'btn-warning', { type: 'DECLINE_BUY' }, '🔨');
                if (player.cash >= tile.price) primary(`Buy $${tile.price}`, 'btn-primary btn-lg', { type: 'BUY_PROPERTY' }, '💰');
                break;
            }

            case GamePhase.DEBT_SETTLEMENT: {
                const debt = state.debt;
                const canRaise = Rules.liquidationValue(state, player.id) >= debt.amount;
                const note = document.createElement('div');
                note.className = 'debt-banner debt-banner-owed';
                note.textContent = `${player.name} owes $${debt.amount} (cash $${player.cash}). Sell or mortgage to raise it.`;
                box.appendChild(note);
                props(); trade();
                // Bankruptcy is never the main (bottom) action: it has no
                // confirm step
                if (!canRaise) act('Bankruptcy', 'btn-danger ctl-bankrupt', { type: 'DECLARE_BANKRUPTCY' }, '💀');
                if (player.cash >= debt.amount) {
                    primary(`Pay $${debt.amount}`, 'btn-primary btn-lg', { type: 'PAY_DEBT' }, '💵');
                } else if (Rules.liquidationValue(state, player.id) > player.cash) {
                    // One-tap CPU-style liquidation up to the amount owed
                    primary(canRaise ? 'Auto Sell/Mortgage' : 'Raise all I can', 'btn-warning btn-lg ctl-raise',
                        { type: 'AUTO_RAISE_CASH', playerId: player.id }, '🏦');
                }
                break;
            }

            case GamePhase.AWAIT_ENDTURN: {
                // After rolling doubles, END_TURN grants another roll for the same
                // player instead of ending the turn (see TurnEngine); label the
                // button to match. Auto-end-turn still applies as usual.
                const rollsAgain = state.rollMeta && state.rollMeta.doubles && !player.inJail && !player.bankrupt;
                props(); trade();
                primary(rollsAgain ? 'Roll Again' : 'End Turn', 'btn-primary btn-lg',
                    { type: 'END_TURN' }, rollsAgain ? '🎲' : '⏭');
                if (DEV.autoEndTurn) this._scheduleAuto(state, GamePhase.AWAIT_ENDTURN, 'END_TURN');
                break;
            }
        }

        // A button with no partner on its row takes the whole row
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            const pair = [left[i], right[i]].filter(Boolean);
            if (pair.length === 1) pair[0].classList.add('ctl-wide');
            pair.forEach(el => box.appendChild(el));
        }
        main.forEach(el => box.appendChild(el));
    },

    /**
     * Auto-reject an incoming CPU trade (setting opt-in). The dialog is
     * skipped, but the human still sees what was offered via a toast and the
     * log, so they can watch CPU dealmaking without being interrupted. A short
     * delay lets the offer toast land before the rejection; the key guard stops
     * re-renders of the same pending offer from scheduling it twice.
     */
    _autoRejectTrade(state) {
        const keyOf = s => `${s.gameId}:${s.turnNumber}:${s.trade.from}:${s.trade.counters}`;
        const key = keyOf(state);
        if (this._autoRejectKey === key) return;
        this._autoRejectKey = key;
        const me = state.trade.awaiting;
        ToastOffset.showLong(`🤝 Auto-rejected — ${Trading.describeOffer(state, state.trade)}`, 'info');
        setTimeout(() => {
            const s = engine.state;
            if (s.phase === GamePhase.TRADE_PENDING && s.trade && keyOf(s) === key) {
                engine.dispatch({ type: 'REJECT_TRADE', playerId: me });
            }
        }, 600);
    },

    /**
     * Auto-roll / auto-end-turn for humans (settings opt-in): dispatch after
     * the auto-action pause (DEV.autoDelay, Settings → Turn flow) unless the state moved on or a modal is open (card /
     * trade / portfolio / settings), in which case check again shortly.
     */
    _scheduleAuto(state, phase, actionType) {
        const key = `${state.turnNumber}:${state.currentPlayer}`;
        this._autoRollTimer = setTimeout(() => {
            const s = engine.state;
            if (s.phase !== phase) return;
            if (`${s.turnNumber}:${s.currentPlayer}` !== key) return;
            if (s.players[s.currentPlayer].isCPU) return;
            if (Modals.isOpen()) { this._scheduleAuto(s, phase, actionType); return; }
            engine.dispatch({ type: actionType });
        }, DEV.autoDelay ?? 1000);
    },

    /** Every human seat is bankrupt (and there was one): only CPUs remain. */
    _humansOut(state) {
        const humans = state.players.filter(p => !p.isCPU);
        return humans.length > 0 && humans.every(p => p.bankrupt);
    },

    _ffText(state) {
        return `Fast-forwarding… turn ${state.turnNumber}`;
    },

    /** Play the remaining CPU-only game out at full speed (see engine.fastForwardToEnd). */
    _skipToEnd() {
        if (engine.fastForwarding) return;
        this._ffStop = false;
        Modals.close();
        engine.fastForwardToEnd({
            shouldStop: () => this._ffStop,
            onProgress: s => {
                const el = document.querySelector('#controls .ff-progress .ff-text');
                if (el) el.textContent = this._ffText(s);
            }
        });
        this.render(engine.state); // swap in the progress line + Stop
    },

    /** The "X is thinking…" line, with a spinner (cpu-thinking.css) that
     *  keeps turning through a d5 lookahead's main-thread freeze. As a
     *  pill it holds the main button's slot; plain (pill false) it is a
     *  line above a real main button (Skip to end). */
    /** The internal layout's spacer (#controls-ghost): the tallest button
     *  set (two paired rows + the main button, as on a Buy decision), built
     *  once with the real buttons' markup so it measures the same in every
     *  style. The real buttons sit over its bottom edge. */
    _fillGhost(make) {
        const ghost = document.getElementById('controls-ghost');
        if (!ghost || ghost.childElementCount) return;
        [['Properties', 'btn-secondary ctl-left', '🏠'], ['Trade', 'btn-secondary ctl-right', '🤝'],
         ['Deed', 'btn-secondary ctl-left', '📋'], ['Auction', 'btn-warning ctl-right', '🔨'],
         ['Buy $400', 'btn-primary btn-lg ctl-main', '💰']].forEach(([label, cls, icon]) => {
            const el = make(label, cls, null, icon);
            el.tabIndex = -1;
            ghost.appendChild(el);
        });
    },

    /** The pill goes in the turn buttons' box, except on the internal
     *  display with Settings > Buttons > Bottom: there it stays in the
     *  board centre (#centre-note, where the centred buttons would be), as
     *  with Buttons: Centre, instead of dropping to the bottom row. */
    _thinkingNote(box, player, pill = true) {
        const note = this.thinkingNote(player, 'is thinking…', pill);
        const centre = document.getElementById('centre-note');
        const inBoard = pill && centre && typeof ScreenManager !== 'undefined'
            && ScreenManager.getScreenType() === 'internal' && !ScreenManager.controlsInCentre();
        (inBoard ? centre : box).appendChild(note);
    },

    /** The thinking pill as an element (also the auction spectator sheet's
     *  "is deciding…" line, so both read the same): seat-colour edge,
     *  spinner, token, name. */
    thinkingNote(player, verb, pill = true) {
        const note = document.createElement('div');
        note.className = pill ? 'cpu-thinking cpu-thinking-pill' : 'cpu-thinking';
        // The seat's colour + token, so it reads as that player's slot
        note.style.setProperty('--seat', BoardRenderer.TOKEN_COLORS[player.id]);
        note.innerHTML = '<span class="cpu-thinking-spinner" aria-hidden="true"></span>';
        const token = document.createElement('span');
        token.className = 'cpu-thinking-token';
        token.textContent = BoardRenderer.TOKEN_ICONS[player.token] || '●';
        note.append(token, `${player.name} ${verb}`);
        return note;
    },

    _statusBar(state) {
        const bar = document.getElementById('status-bar');
        const p = state.players[state.currentPlayer];
        bar.innerHTML = `<img src="logo.png" alt="" class="status-logo">
            <span class="status-turn">T${state.turnNumber}</span>
            <button class="btn-settings btn-note" aria-label="Game note">${Icons.svg('note')}<span class="status-label">Note</span></button>
            <button class="btn-settings btn-log" aria-label="Game log">${Icons.svg('log')}<span class="status-label">Log</span></button>
            <button class="btn-settings btn-owners" aria-label="Who owns what">${Icons.svg('map')}<span class="status-label">Owners</span></button>
            <button class="btn-settings" aria-label="Settings">${Icons.svg('settings')}<span class="status-label">Settings</span></button>`;
        bar.querySelector('.btn-note').addEventListener('click', () => HistoryUI.noteModal(state.gameId));
        bar.querySelector('.btn-log').addEventListener('click', () => LogUI.showFull(engine.state));
        bar.querySelector('.btn-owners').addEventListener('click', () => PropertyUI.showOwnership());
        bar.querySelector('.btn-settings:not(.btn-owners):not(.btn-log):not(.btn-note)').addEventListener('click', () => SettingsUI.open({ inGame: true }));
        const banner = document.getElementById('turn-banner');
        if (banner) {
            // "Turn: " and the name as spans, so each layout can style or
            // hide them (the cover shows just the name, big)
            banner.textContent = '';
            const prefix = document.createElement('span');
            prefix.className = 'turn-prefix';
            prefix.textContent = 'Turn';
            const sep = document.createElement('span');
            sep.className = 'turn-sep';
            sep.textContent = ': ';
            const name = document.createElement('span');
            name.className = 'turn-name';
            name.textContent = p.name;
            name.style.setProperty('--ink', BoardRenderer.inkColor(p.id));
            banner.append(prefix, sep, name);
            // Where they stand (under the name; the cover hides it)
            if (!p.bankrupt && state.phase !== GamePhase.GAME_OVER) {
                const where = document.createElement('span');
                where.className = 'turn-where';
                where.textContent = p.inJail ? 'in Jail'
                    : p.position === 10 ? 'just visiting Jail' : `on ${BOARD[p.position].name}`;
                banner.appendChild(where);
            }
            const owed = this._shortLine(state);
            if (owed) banner.appendChild(owed);
        }
    },

    /** The turn line's money note (.turn-debt; hidden on the full ring): on
     *  the internal display it replaces the red banner over the buttons, on
     *  the cover it sits under the turn line beside the dice. Settling a debt: the amount
     *  owed and the shortfall, which counts down as they sell or mortgage
     *  (the feed's "cannot pay" line scrolls away). A purchase they can't
     *  afford yet: the price and the shortfall. The two halves are spans
     *  joined by a " · " (.turn-debt-sep; stacked on the internal display),
     *  the cover drops the separator and stacks them. */
    _shortLine(state) {
        const line = (first, second) => {
            const el = document.createElement('span');
            el.className = 'turn-debt';
            [first, ' · ', second].forEach((text, i) => {
                const part = document.createElement('span');
                part.className = i === 1 ? 'turn-debt-sep' : 'turn-debt-part';
                part.textContent = text;
                el.appendChild(part);
            });
            return el;
        };
        if (state.phase === GamePhase.AWAIT_DECISION && state.pendingAction) {
            const p = state.players[state.currentPlayer];
            const tile = BOARD[state.pendingAction.tileId];
            const short = tile && tile.price - p.cash;
            return short > 0 ? line(`Costs $${tile.price}`, `$${short} short`) : null;
        }
        if (state.phase === GamePhase.DEBT_SETTLEMENT && state.debt) {
            const debtor = state.players[state.debt.debtorId];
            const short = state.debt.amount - debtor.cash;
            // The turn line already names the turn player; name the debtor
            // only when it's someone else (a bankruptcy creditor's interest)
            const who = debtor.id === state.currentPlayer ? 'Owes' : `${debtor.name} owes`;
            return line(`${who} $${state.debt.amount}`,
                short > 0 ? `$${short} short` : 'ready to pay');
        }
        return null;
    },

    _gameOver(state) {
        if (this._gameOverShown) return;
        this._gameOverShown = true;
        this._showGameOverModal(state);
    },

    _showGameOverModal(state) {
        const winner = state.players[state.winner];
        Modals.show({
            title: '🏆 Game Over',
            body: `<p class="gameover-line"><strong style="color:${BoardRenderer.inkColor(winner.id)}">${BoardRenderer.TOKEN_ICONS[winner.token] || ''} ${LogUI._esc(winner.name)}</strong> wins with a net worth of $${Rules.netWorth(state, winner.id)}!</p>`,
            buttons: [
                { label: '🔄 New Game', class: 'btn-primary', onClick: () => { GameState.clearSave(); location.reload(); } },
                // Same lineup and house rules again, straight into the roll-off
                // (main.js boot reads the flag; SetupUI restores the lineup)
                { label: '🔁 Rematch', class: 'btn-secondary', onClick: () => {
                    GameState.clearSave();
                    try { sessionStorage.setItem(SetupUI.REMATCH_KEY, '1'); } catch (e) { /* plain new game */ }
                    location.reload();
                } },
                { label: '📊 Game stats', class: 'btn-secondary', info: true, keepOpen: true,
                    onClick: () => HistoryUI.showStats(state.gameId, { onClose: () => this._showGameOverModal(state) }) },
                { label: '📝 Add note', class: 'btn-secondary', keepOpen: true,
                    onClick: () => {
                        const back = () => this._showGameOverModal(state);
                        HistoryUI.noteModal(state.gameId, { onSaved: back, onCancel: back });
                    } },
                { label: 'Close', class: 'btn-secondary' }
            ]
        });
    }
};

if (typeof window !== 'undefined') {
    window.Controls = Controls;
}
