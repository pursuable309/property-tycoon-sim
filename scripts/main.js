/**
 * Boot: home screen (setup, with a Continue card for a saved game), engine
 * wiring, DEV harness.
 *
 * Load order (index.html): constants -> rng -> board-data -> storage ->
 * game-state -> rules-engine -> features -> ai -> ui -> turn-engine -> main
 *
 * Exports: window.engine (active MonopolyEngine), window.DEV
 */

function startNewGame(config) {
    const state = GameState.createGame(config);
    state.players.forEach(p => { if (p.isCPU) Personalities.assign(state, p); });
    window.engine = new MonopolyEngine(state, { cpuDelay: DEV.cpuDelay, tradeLimit: DEV.tradeLimit });
    GameState.save(state);
    if (typeof ScreenManager !== 'undefined') ScreenManager.showGame();
    EventBus.emit('stateChanged', state);
    // Present the opening roll-off; the first turn starts once it is dismissed
    if (typeof Modals !== 'undefined' && state.rollOff && state.rollOff.length) {
        showRollOff(state, () => window.engine.pump());
    } else {
        window.engine.pump();
    }
    return window.engine;
}

/** Modal presenting the opening roll-off rounds and who goes first. */
function showRollOff(state, onDone) {
    const body = document.createElement('div');
    body.className = 'rolloff';
    state.rollOff.forEach((round, i) => {
        if (state.rollOff.length > 1) {
            const h = document.createElement('h3');
            h.className = 'rolloff-round';
            h.textContent = i === 0 ? 'Everyone rolls…' : `Tie — roll again (round ${i + 1})`;
            body.appendChild(h);
        }
        round.forEach(r => {
            const p = state.players[r.id];
            const row = document.createElement('div');
            row.className = 'rolloff-row';
            row.innerHTML = `<span class="rolloff-name" style="color:${BoardRenderer.inkColor(r.id)}">` +
                `${BoardRenderer.TOKEN_ICONS[p.token] || ''} ${LogUI._esc(p.name)}</span>` +
                `<span class="rolloff-dice">🎲 ${r.dice[0]} + ${r.dice[1]} = <strong>${r.total}</strong></span>`;
            body.appendChild(row);
        });
    });
    const winner = state.players[state.currentPlayer];
    const foot = document.createElement('p');
    foot.className = 'rolloff-winner';
    foot.innerHTML = `<strong style="color:${BoardRenderer.inkColor(winner.id)}">${LogUI._esc(winner.name)}</strong> goes first!`;
    body.appendChild(foot);

    Modals.show({
        title: 'Who goes first?',
        body,
        buttons: [{ label: '▶ Start', class: 'btn-primary btn-lg', onClick: onDone }]
    });
}

/**
 * Staggered toasts: the shared toasts all sit in the same bottom-center slot,
 * so back-to-back calls would cover each other. Each queued message waits for
 * the previous one's 3s display (plus its slide-out) before showing.
 */
const _toastQueue = [];
let _toastBusy = false;
function queueNotification(message, type) {
    _toastQueue.push([message, type]);
    if (!_toastBusy) _nextToast();
}
function _nextToast() {
    const next = _toastQueue.shift();
    _toastBusy = !!next;
    if (!next) return;
    showNotification(next[0], next[1]);
    setTimeout(_nextToast, 3400);
}

function resumeGame() {
    const state = GameState.load();
    if (!state) return null;
    window.engine = new MonopolyEngine(state, { cpuDelay: DEV.cpuDelay, tradeLimit: DEV.tradeLimit });
    if (typeof ScreenManager !== 'undefined') ScreenManager.showGame();
    EventBus.emit('stateChanged', state);
    window.engine.pump(); // continue a game saved mid-CPU-turn
    return window.engine;
}

/* ==================== DEV HARNESS ==================== */

/**
 * Headless invariant-checking simulator. Run in the console:
 *   DEV.simulate(10)  - play 10 full CPU games, report violations & winners
 */
const DEV = {
    cpuDelay: 700,
    tradeLimit: 2,
    autoRoll: false,
    autoRollJail: true,
    autoEndTurn: false,
    autoDelay: 1000,          // ms before a human's auto-roll / auto-end fires
    tradeActivity: 'normal',  // off | rare | normal | eager
    tradeFlex: 'fair',        // strict | fair | generous
    cpuCounters: true,
    tradeValueHint: true,     // human-facing give/get value estimate in the trade builder
    autoRejectCpuTrades: false, // silently reject incoming CPU trade offers (still logged/toasted)

    /** Layout check: a red box over the cover's camera keep-out
     *  (html.cover-cams), drawn above everything and click-through, so a
     *  screenshot shows anything tappable under the cameras. Call again to
     *  remove it. Not saved. */
    showCams() {
        const old = document.getElementById('dev-cams');
        if (old) { old.remove(); return false; }
        const box = document.createElement('div');
        box.id = 'dev-cams';
        box.style.cssText = 'position:fixed;right:0;bottom:0;z-index:99999;pointer-events:none;'
            + 'left:var(--cam-left, 47vw);top:var(--cam-top, 75dvh);background:rgba(255,0,0,0.45)';
        document.body.appendChild(box);
        return true;
    },

    _invariants(state, gameLabel, violations) {
        // House/hotel stock conservation
        let housesOut = 0, hotelsOut = 0;
        Object.keys(state.tiles).forEach(k => {
            const h = state.tiles[k].houses;
            if (h === 5) hotelsOut += 1;
            else housesOut += h;
        });
        if (state.bank.houses + housesOut !== GAME_CONST.BANK_HOUSES) {
            violations.push(`${gameLabel}: house count broken (bank ${state.bank.houses} + board ${housesOut})`);
        }
        if (state.bank.hotels + hotelsOut !== GAME_CONST.BANK_HOTELS) {
            violations.push(`${gameLabel}: hotel count broken (bank ${state.bank.hotels} + board ${hotelsOut})`);
        }
        // No negative cash outside debt settlement
        state.players.forEach(p => {
            if (!p.bankrupt && p.cash < 0 && state.phase !== GamePhase.DEBT_SETTLEMENT) {
                violations.push(`${gameLabel}: ${p.name} has negative cash ($${p.cash}) in ${state.phase}`);
            }
        });
        // Even building
        Object.keys(GROUP_META).forEach(group => {
            if (group === 'railroad' || group === 'utility') return;
            const counts = Rules.tilesInGroup(group).map(id => Rules.houseCount(state, id));
            const owners = Rules.tilesInGroup(group).map(id => Rules.getOwner(state, id));
            const monopoly = owners.every(o => o !== null && o === owners[0]);
            if (monopoly && Math.max(...counts) - Math.min(...counts) > 1) {
                violations.push(`${gameLabel}: uneven building on ${group} (${counts})`);
            }
        });
        // Jail card ledger
        const held = state.players.reduce((sum, p) => sum + p.getOutCards, 0);
        const flagged = (state.decks.chanceJailCardHeldBy !== null ? 1 : 0) +
                        (state.decks.communityJailCardHeldBy !== null ? 1 : 0);
        if (held !== flagged) {
            violations.push(`${gameLabel}: jail card mismatch (held ${held}, flagged ${flagged})`);
        }
    },

    /** Play n full CPU-only games headlessly. Returns a summary.
     *  d5 rollout lookahead is OFF by default here (a ~7x slowdown that the
     *  invariant check doesn't need); pass { lookahead: true } to include it. */
    simulate(n = 5, options = {}) {
        EventBus.muted = true;
        const prevLookahead = window.Lookahead ? Lookahead.disabled : null;
        if (window.Lookahead) Lookahead.disabled = !options.lookahead;
        try {
            return this._simulate(n, options);
        } finally {
            EventBus.muted = false;
            if (window.Lookahead) Lookahead.disabled = prevLookahead;
        }
    },

    _simulate(n, options) {
        const violations = [];
        const difficulties = options.difficulties || [1, 3, 3, 5];
        const winners = { none: 0 };
        difficulties.forEach(d => { winners[d] = 0; });
        const maxSteps = options.maxSteps || 20000;

        for (let g = 0; g < n; g++) {
            const seats = difficulties.map((d, i) => ({ name: `CPU d${d} #${i + 1}`, isCPU: true, difficulty: d }));
            const state = GameState.createGame({
                seats,
                seed: options.seed !== undefined ? options.seed + g : undefined,
                balancedRents: !!(options.balanced || options.balancedRents),
                delayedBuy: !!(options.balanced || options.delayedBuy)
            });
            state.players.forEach(p => Personalities.assign(state, p));
            const sim = new MonopolyEngine(state, { persist: false, autoPump: false, cpuDelay: 0 });

            let steps = 0;
            while (state.phase !== GamePhase.GAME_OVER && steps < maxSteps) {
                if (!sim.step()) break;
                steps += 1;
                if (steps % 50 === 0) this._invariants(state, `game ${g + 1} step ${steps}`, violations);
                if (violations.length > 20) break;
            }
            this._invariants(state, `game ${g + 1} end`, violations);

            if (state.winner !== null) {
                winners[state.players[state.winner].difficulty] += 1;
            } else {
                winners.none += 1;
            }
            console.log(`game ${g + 1}: ${steps} steps, winner: ${state.winner !== null ? state.players[state.winner].name : 'none (cap reached)'}`);
        }

        const summary = { games: n, violations, winnersByDifficulty: winners };
        console.log('DEV.simulate summary:', JSON.stringify(summary, null, 2));
        return summary;
    }
};

/* ==================== NOTIFICATION PACING ==================== */

/**
 * Back-to-back toasts (e.g. a Chance card followed by the payment it causes)
 * are unreadable when they land in the same instant. Wrap the shared
 * showNotification in a queue: the first shows immediately, the rest follow
 * one per CPU-speed interval so cause and effect stay distinguishable.
 */
if (typeof window !== 'undefined' && window.showNotification) {
    const rawNotify = window.showNotification;
    const queue = [];
    let draining = false;
    const drain = () => {
        const next = queue.shift();
        if (!next) { draining = false; return; }
        rawNotify(next[0], next[1]);
        setTimeout(drain, Math.max(DEV.cpuDelay, 400));
    };
    window.showNotification = (message, type) => {
        queue.push([message, type]);
        if (!draining) { draining = true; drain(); }
    };
}

/* ==================== BOOT ==================== */

function renderAll(state) {
    BoardRenderer.render(state);
    Panels.render(state);
    Controls.render(state);
    LogUI.render(state);
    DiceUI.render(state);
}

function boot() {
    if (typeof ScreenManager === 'undefined') return; // headless (tests)

    document.body.dataset.screenType = ScreenManager.getScreenType();
    if (typeof Sound !== 'undefined') Sound.init();
    SettingsUI.apply(SettingsUI.load());

    EventBus.on('stateChanged', renderAll);
    if (typeof Motion !== 'undefined') Motion.init(); // after the renderers: it decorates their DOM
    EventBus.on('actionRejected', ({ result }) => {
        if (result && result.reason) showNotification(result.reason, 'warning');
    });
    // Money-transfer toasts (rent, tax, cards, GO salary, jail fine) — only
    // when a human is involved and a sheet hides the board centre's feed,
    // which already shows every payment; CPU-to-CPU stays in the log.
    // Mortgage interest only follows a bankruptcy; its toast would bury the
    // bankruptcy toast, and the payment is in the game log.
    EventBus.on('moneyMoved', ({ from, to, amount, reason }) => {
        if (reason === 'mortgage interest' || !ToastOffset.boardHidden()) return;
        const humanFrom = from && !from.isCPU;
        const humanTo = to && !to.isCPU;
        if (!humanFrom && !humanTo) return;
        const label = n => n ? n.name : 'the Bank';
        if (humanFrom) {
            showNotification(`${from.name} pays $${amount} ${reason} to ${label(to)}`, 'warning');
        } else {
            showNotification(`${to.name} receives $${amount} (${reason}) from ${label(from)}`, 'success');
        }
    });
    // A CPU stretch-mortgaging to fund an auction bid: the auction dialog
    // covers the board-center announcement, so toast each mortgage, queued so
    // a run of them shows one after another instead of stacked.
    EventBus.on('propertyMortgaged', ({ playerId, tileId }) => {
        const p = engine.state.players[playerId];
        if (!engine.state.auction || !p.isCPU) return;
        queueNotification(`🏦 ${p.name} mortgages ${BOARD[tileId].name} for $${Rules.mortgageValue(tileId)}`, 'info');
    });
    // Board cues: GO pulses whenever salary is paid — long card moves teleport
    // the token, so the flash shows the forward wrap past GO actually happened.
    // Jail pulses on any arrest (Go To Jail tile, card, or third double).
    EventBus.on('moneyMoved', ({ reason }) => {
        if (reason === 'salary') BoardRenderer.flashTile(0, 'go');
    });
    EventBus.on('sentToJail', () => BoardRenderer.flashTile(GAME_CONST.JAIL_TILE, 'jail'));
    // Free Parking jackpot collected: pulse the tile; toast CPU wins while
    // the feed is hidden (humans already get a moneyMoved toast for it).
    EventBus.on('freeParkingCollected', ({ playerId, amount }) => {
        BoardRenderer.flashTile(20, 'parking');
        const p = engine.state.players[playerId];
        if (p.isCPU && ToastOffset.boardHidden()) showNotification(`🅿️ ${p.name} collects $${amount} from Free Parking`, 'success');
    });
    // Every completed trade gets one readable summary toast.
    EventBus.on('tradeCompleted', ({ offer }) => {
        const name = id => engine.state.players[id].name;
        const desc = side => {
            const parts = side.properties.map(id => BOARD[id].name);
            if (side.cash > 0) parts.push(`$${side.cash}`);
            if (side.jailCards > 0) parts.push(side.jailCards > 1 ? `${side.jailCards} jail cards` : 'jail card');
            return parts.length ? parts.join(' + ') : 'nothing';
        };
        ToastOffset.showLong(`🤝 ${name(offer.from)} gives ${desc(offer.give)} ⇄ ${name(offer.to)} gives ${desc(offer.get)}`, 'info');
    });
    // A human's offer turned down by a CPU: say so (a rejection otherwise
    // only reaches the log, which the auction dialog hides mid-auction).
    EventBus.on('tradeRejected', ({ by, offer }) => {
        const s = engine.state;
        const proposer = s.players[offer.from];
        if (proposer.isCPU || !s.players[by].isCPU) return;
        const text = `🤝 ${s.players[by].name} rejected ${proposer.name}'s trade`;
        showNotification(text, 'warning');
        if (s.auction) AuctionUI.noteTrade(s, text, 'rejected');
    });
    EventBus.on('tradeCompleted', ({ offer }) => {
        const s = engine.state;
        if (!s.auction) return;
        const [a, b] = [s.players[offer.from], s.players[offer.to]];
        if (a.isCPU && b.isCPU) return;
        AuctionUI.noteTrade(s, `🤝 Trade with ${(a.isCPU ? a : b).name} went through`, 'accepted');
    });
    EventBus.on('playerBankrupt', ({ playerId, creditorId }) => {
        const debtor = engine.state.players[playerId];
        const to = creditorId === null ? 'the Bank' : engine.state.players[creditorId].name;
        ToastOffset.showLong(`💀 ${debtor.name} is bankrupt! Assets go to ${to}`, 'error');
    });
    EventBus.on('cardDrawn', ({ player, deck, card }) => {
        const p = engine.state.players[player];
        const deckName = deck === 'chance' ? 'Chance' : 'Community Chest';
        if (p.isCPU) {
            // The feed shows the draw; toast it only when a sheet hides the feed
            if (ToastOffset.boardHidden()) showNotification(`${p.name} — ${deckName}: ${card.text}`, 'info');
        } else {
            Modals.show({
                title: deckName,
                body: `<p class="card-text">${card.text}</p>`,
                buttons: [{ label: 'OK', class: 'btn-primary' }],
                autoAck: true // informational only — safe to click through on auto-end
            });
        }
    });

    // Home is always the setup screen: a game in progress shows there as a
    // Continue card (SetupUI), so History / Stats / Lab stay reachable.
    ScreenManager.showSetup();
    // Game Over → Rematch reloads with this flag: start straight away from
    // the remembered lineup (SetupUI restores it from monopoly_setup_v1).
    try {
        if (sessionStorage.getItem(SetupUI.REMATCH_KEY)) {
            sessionStorage.removeItem(SetupUI.REMATCH_KEY);
            if (!GameState.load()) SetupUI.startFromForm();
        }
    } catch (e) { /* storage blocked: stay on setup */ }
    // Save states → Load in a game reloads first; restore the slot now
    SaveStatesUI.loadPending();
}

if (typeof window !== 'undefined') {
    window.startNewGame = startNewGame;
    window.resumeGame = resumeGame;
    window.DEV = DEV;
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('DOMContentLoaded', boot);
    }
}
