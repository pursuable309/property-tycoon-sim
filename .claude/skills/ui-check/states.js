/**
 * ui-check state catalog: every window and modal the harness can reach.
 *
 * A state is plain data plus in-page steps:
 *   id      unique, kebab-case; screenshots are named <id>__<size>__<variant>.png
 *   group   home | game | auction | sheet | toast (report rows are grouped by it)
 *   title   one line for the report
 *   base    'home'  : fresh page on the home screen (no saved game)
 *           'game'  : a seeded game, roll-off dismissed, CPUs frozen, seat 0
 *                     (human) on a pre-roll turn
 *           'rolloff': a seeded game with the roll-off modal still open
 *   seats   fixed seat count (else the matrix's --seats; home states that
 *           don't depend on seats take 4 and ignore the axis)
 *   minSeats  lowest seat count that makes sense (matrix values below it are raised)
 *   steps   array of in-page functions `(kit, arg) => ...` (may be async;
 *           kit = window.__uic, arg = { seats }) and the string 'reload'
 *           (reload the page, keep localStorage, re-inject the kit).
 *   settle  extra ms to wait before the checks and screenshot (default 120)
 *   settings  monopoly_settings this state always uses (e.g. { ownership:
 *           'tokens', animations: 'full' }); they override the matrix axes
 *   animAt  freeze all running animations this many ms into their timelines
 *           right after the steps (kit.pauseAnimations) and screenshot that
 *           frame; for checking an animation mid-flight. Needs animations on.
 *
 * Step functions are serialized into the page: they can't close over
 * anything in this file. Prefer public UI calls and clicks (kit.clickControl,
 * kit.clickStatus, kit.clickModal) over poking state, and keep every state
 * deterministic (seeded game, scripted dice via kit.dice).
 *
 * To add a state: append an object here, then
 *   node .claude/skills/ui-check/core/ui_check.js --states <id> --sizes cover-cams
 */

// Shared step fragments (still serialized one by one, so each is self-contained)
const holdings = kit => { kit.holdings(); kit.refresh(); };
const rollTo = (pairs) => {
    // returns an in-page step that queues dice then presses Roll
    const fn = new Function('kit', `kit.dice(...${JSON.stringify(pairs)}); kit.clickControl('Roll');`);
    return fn;
};
const waitFor = (sel, ms = 3000) => new Function('kit', `
    const end = Date.now() + ${ms};
    return (async () => {
        while (Date.now() < end) {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (el && el.children.length) return true;
            await kit.wait(60);
        }
        return false;
    })();`);

/** Human owes rent on Boardwalk (held by seat 1). houses 3 = can raise it, 5 = can't. */
const debtSetup = (houses, cash) => new Function('kit', `
    kit.holdings();
    const s = engine.state;
    s.tiles['39'].houses = 0; s.tiles['37'].houses = 0;
    kit.give(1, [37, 39], { houses: ${houses} });
    s.players[0].cash = ${cash};
    s.players[0].position = 28;
    kit.refresh();
    kit.dice([5, 6]);
    kit.clickControl('Roll');`);

/** Mid-game holdings, then Bo (seat 1) trades Electric Company for
 *  Alexandra's two railroads and she accepts: three tiles change hands. */
const tradeSwap = kit => { kit.holdings(); kit.refresh(); kit.acceptTradeFromCpu([12], [5, 25]); };

/** A game with save states and the game in progress paused: what the home
 *  screen lists under "Paused games" and in its Save states sheet. */
const pausedHome = kit => {
    kit.holdings(); kit.refresh();
    kit.saveSlots([4, 9]);
    const r = GameState.pauseLive();
    if (!r.ok) throw new Error('pause refused: ' + r.reason);
};
/** A recorded game (localStorage buffer, never the server) a few turns in,
 *  dates pinned, then back to the home screen's History tab. */
const historyGame = [kit => { kit.recordHistory(); return kit.playUntil(s => s.turnNumber >= 8, 4000); },
    kit => kit.pinHistoryTimes(), 'reload',
    () => document.querySelector('.home-subtabs > button[data-view="history"]').click(),
    waitFor('#history-root')];
const clickBtn = (scope, re) => new Function('kit', `
    const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(el => ${re}.test(el.textContent));
    if (!b) throw new Error('no button ' + ${JSON.stringify(String(re))} + ' in ' + ${JSON.stringify(scope)});
    b.click();`);

const STATES = [
    /* ---------------- Home ---------------- */
    { id: 'home-new-2', group: 'home', title: 'New Game, 2 seats', base: 'home', seats: 2,
        steps: [kit => kit.setupLineup(2), 'reload'] },
    { id: 'home-new-4', group: 'home', title: 'New Game, 4 seats', base: 'home', seats: 4,
        steps: [kit => kit.setupLineup(4), 'reload'] },
    { id: 'home-new-8', group: 'home', title: 'New Game, 8 seats', base: 'home', seats: 8,
        steps: [kit => kit.setupLineup(8), 'reload'] },
    { id: 'home-rules', group: 'home', title: 'New Game, house rules open', base: 'home', seats: 4,
        steps: [kit => kit.setupLineup(4, { freeParking: true }), 'reload', () => {
            const d = document.querySelector('#tab-setup details');
            if (!d) throw new Error('no house rules block');
            d.querySelector('summary').click();
            if (!d.open) d.open = true;
        }] },
    { id: 'home-continue', group: 'home', title: 'Continue card (saved game)', base: 'home', seats: 4,
        steps: [kit => kit.setupLineup(4), kit => { kit.startGame({ seats: 4 }); }, 'reload'] },
    { id: 'home-history', group: 'home', title: 'History tab', base: 'home', seats: 4, settle: 300,
        steps: [() => document.querySelector('.home-subtabs > button[data-view="history"]').click(), waitFor('#history-root')] },
    { id: 'home-stats', group: 'home', title: 'Stats tab', base: 'home', seats: 4, settle: 400,
        steps: [() => document.querySelector('.home-subtabs > button[data-view="stats"]').click(), waitFor('#stats-root', 6000)] },
    { id: 'home-lab', group: 'home', title: 'Lab tab', base: 'home', seats: 4, settle: 400,
        steps: [() => document.querySelector('.home-subtabs > button[data-view="lab"]').click(), waitFor('#lab-root')] },
    { id: 'home-lab-runs', group: 'home', title: 'Lab: a running and a finished job', base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-card')] },
    { id: 'home-lab-job', group: 'home', title: 'Lab: job detail (results, raw report)', base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-row'), () => document.querySelector('#lab-root .lab-row').click(), waitFor('#modal-body')] },
    { id: 'home-lab-effort', group: 'home', title: 'Lab: effort detail', base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-card'), () => LabUI.openEffort('E40'), waitFor('#modal-body')] },
    { id: 'home-lab-levers', group: 'home', title: 'Lab: Levers (a proposal, a ship ask, one running)', base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-card'), () => document.querySelector('#lab-root .ui-subtabs > button[data-view="proposals"]').click(),
            waitFor('#lab-root .lab-proposal')] },
    { id: 'home-lab-reject', group: 'home', title: 'Lab: Reject with a reason', base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-card'), () => document.querySelector('#lab-root .ui-subtabs > button[data-view="proposals"]').click(),
            waitFor('#lab-root .lab-proposal'), clickBtn('#lab-root .lab-actions button', /^Reject$/), waitFor('#modal-body')] },
    { id: 'home-lab-dontship', group: 'home', title: "Lab: Don't ship with a reason", base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-card'), () => document.querySelector('#lab-root .ui-subtabs > button[data-view="proposals"]').click(),
            waitFor('#lab-root .lab-proposal'), clickBtn('#lab-root .lab-actions button', /^Don.t ship$/), waitFor('#modal-body')] },
    { id: 'home-lab-signin', group: 'home', title: 'Lab: Sign in to decide', base: 'home', seats: 4, settle: 400,
        steps: [kit => kit.labFixture(), () => document.querySelector('.home-subtabs > button[data-view="lab"]').click(),
            waitFor('#lab-root .lab-card'), () => document.querySelector('#lab-root .ui-subtabs > button[data-view="proposals"]').click(),
            waitFor('#lab-root .lab-proposal'), clickBtn('#lab-root .lab-actions button', /^Approve$/), waitFor('#modal-body')] },
    { id: 'home-start-over', group: 'home', title: 'Start Game with a game in progress (confirm)', base: 'home', seats: 4,
        steps: [kit => kit.setupLineup(4), kit => { kit.startGame({ seats: 4 }); }, 'reload',
            () => document.getElementById('btn-start-game').click()] },
    { id: 'home-discard', group: 'home', title: 'Discard saved game? (confirm)', base: 'home', seats: 4,
        steps: [kit => kit.setupLineup(4), kit => { kit.startGame({ seats: 4 }); }, 'reload',
            clickBtn('.continue-card button', /Discard/)] },
    { id: 'home-express', group: 'home', title: 'Express is on (confirm before a new game)', base: 'home', seats: 4,
        settings: { cpuSpeed: 'fast', autoRoll: true, autoRollJail: true, autoEndTurn: true },
        steps: [kit => kit.setupLineup(4), 'reload', () => document.getElementById('btn-start-game').click()] },
    { id: 'home-paused', group: 'home', title: 'Paused games + Save states link', base: 'game',
        steps: [pausedHome, 'reload'] },
    { id: 'home-saves', group: 'home', title: 'Save states sheet (home)', base: 'game',
        steps: [pausedHome, 'reload', () => document.querySelector('.saves-link').click()] },
    { id: 'home-history-games', group: 'home', title: 'History tab with a recorded game', base: 'game', settle: 300,
        steps: historyGame },
    { id: 'home-history-detail', group: 'home', title: 'History: game detail', base: 'game', settle: 300,
        steps: [...historyGame, () => document.querySelector('#history-root [aria-label$="Open details"]').click(),
            kit => kit.wait(200)] },
    { id: 'home-history-log', group: 'home', title: 'History: the game\'s replay log', base: 'game', settle: 300,
        steps: [...historyGame, () => document.querySelector('#history-root [aria-label$="Open details"]').click(),
            kit => kit.wait(200), clickBtn('#modal-buttons button', /Game log/), kit => kit.wait(300)] },
    { id: 'home-history-delete', group: 'home', title: 'History: Delete game? (confirm)', base: 'game', settle: 300,
        // The recorded game is the live save: drop it, or Delete refuses ("in progress or paused")
        steps: [...historyGame, () => StorageManager.remove(STORAGE_KEYS.SAVE), () => document.querySelector('#history-root [aria-label$="Open details"]').click(),
            kit => kit.wait(200), clickBtn('#modal-buttons button', /Delete/), kit => kit.wait(200)] },
    { id: 'home-history-note', group: 'home', title: 'History: game note', base: 'game', settle: 300,
        steps: [...historyGame, () => {
            const id = StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, [])[0];
            if (!id) throw new Error('no recorded game');
            HistoryUI.noteModal(id);
        }, kit => kit.wait(200)] },
    { id: 'home-settings-display', group: 'home', title: 'Settings: Display', base: 'home', seats: 4,
        steps: [() => document.getElementById('btn-setup-settings').click(),
            () => document.querySelector('.settings-tabs > button[data-view="display"]').click()] },
    { id: 'home-settings-flow', group: 'home', title: 'Settings: Turn flow', base: 'home', seats: 4,
        steps: [() => document.getElementById('btn-setup-settings').click(),
            () => document.querySelector('.settings-tabs > button[data-view="flow"]').click()] },
    { id: 'home-settings-trading', group: 'home', title: 'Settings: Trading', base: 'home', seats: 4,
        steps: [() => document.getElementById('btn-setup-settings').click(),
            () => document.querySelector('.settings-tabs > button[data-view="trading"]').click()] },

    /* ---------------- Game turns ---------------- */
    { id: 'game-rolloff', group: 'game', title: 'Roll-off modal', base: 'rolloff', steps: [] },
    { id: 'game-preroll', group: 'game', title: 'Pre-roll (mid-game holdings)', base: 'game', steps: [holdings] },
    { id: 'game-buy', group: 'game', title: 'Buy decision', base: 'game', steps: [rollTo([[5, 6]])] },
    { id: 'game-buy-short', group: 'game', title: "Buy decision, can't afford", base: 'game',
        steps: [kit => { engine.state.players[0].cash = 100; kit.refresh(); }, rollTo([[5, 6]])] },
    { id: 'game-jail', group: 'game', title: 'Jail choice (with a card)', base: 'game',
        steps: [kit => {
            const s = engine.state, p = s.players[0];
            p.inJail = true; p.jailTurns = 1; p.position = 10; p.getOutCards = 1;
            s.decks.chanceJailCardHeldBy = 0;
            s.phase = GamePhase.AWAIT_JAIL_CHOICE;
            kit.refresh();
        }] },
    { id: 'game-debt', group: 'game', title: 'Debt settlement (can raise)', base: 'game', steps: [debtSetup(3, 400)] },
    { id: 'game-debt-bankrupt', group: 'game', title: "Debt settlement (can't raise: Bankruptcy)", base: 'game',
        steps: [debtSetup(5, 300)] },
    { id: 'game-bankrupt-toast', group: 'game', title: 'After declaring bankruptcy (toast)', base: 'game', minSeats: 3,
        steps: [debtSetup(5, 300), kit => { kit.clickControl('Bankruptcy'); kit.freeze(); }], settle: 250 },
    { id: 'game-over', group: 'game', title: 'Game over', base: 'game', seats: 2,
        steps: [debtSetup(5, 300), kit => { kit.clickControl('Bankruptcy'); kit.freeze(); }], settle: 250 },
    { id: 'game-over-stats', group: 'game', title: 'Game over: Game stats', base: 'game', seats: 2, settle: 300,
        steps: [kit => kit.recordHistory(), debtSetup(5, 300), kit => { kit.clickControl('Bankruptcy'); kit.freeze(); },
            kit => { kit.pinHistoryTimes(); kit.clickModal('Game stats'); return kit.wait(200); }] },
    { id: 'game-cpu-turn', group: 'game', title: 'CPU turn, multi-line feed', base: 'game',
        steps: [kit => { engine.state.currentPlayer = 1; kit.refresh(); },
            kit => kit.playUntil(s => s.turnNumber >= 3 && s.players[s.currentPlayer].isCPU
                && s.phase !== GamePhase.AWAIT_PREROLL && kit.headlines() >= 3, 5000)] },
    { id: 'game-endturn', group: 'game', title: 'End turn', base: 'game',
        steps: [rollTo([[1, 2]]), kit => kit.clickControl('Buy')] },
    // Ownership marks: the board in Tokens mode on every size (the matrix
    // default is Dots; --ownership tokens,tint runs every state in the others)
    { id: 'game-owned-tokens', group: 'game', title: 'Board, ownership as token emoji', base: 'game',
        settings: { ownership: 'tokens' }, steps: [holdings] },
    // A trade's owner swap, frozen mid-turn (animAt: ms after the accept).
    // Deeds land at 750 ms (Normal flight); at 1150 the first tiles are
    // mid-pulse with their marks edge-on, the second railroad just starting.
    { id: 'game-trade-flight', group: 'game', title: 'Trade accepted: deeds in flight', base: 'game',
        settings: { animations: 'full', ownership: 'tokens' }, animAt: 400, steps: [tradeSwap] },
    { id: 'game-trade-swap-tokens', group: 'game', title: 'Trade: owner swap mid-turn (Tokens)', base: 'game',
        settings: { animations: 'full', ownership: 'tokens' }, animAt: 1150, steps: [tradeSwap] },
    { id: 'game-trade-swap-dots', group: 'game', title: 'Trade: owner swap mid-turn (Dots)', base: 'game',
        settings: { animations: 'full', ownership: 'dots' }, animAt: 1150, steps: [tradeSwap] },
    { id: 'game-trade-swap-tint', group: 'game', title: 'Trade: owner swap mid-turn (Tinted tiles)', base: 'game',
        settings: { animations: 'full', ownership: 'tint' }, animAt: 1150, steps: [tradeSwap] },
    { id: 'game-roll-again', group: 'game', title: 'Roll again (doubles)', base: 'game',
        steps: [rollTo([[3, 3]]), kit => kit.clickControl('Buy')] },

    /* ---------------- Auction ---------------- */
    { id: 'auction-spectator', group: 'auction', title: 'Auction, watching a CPU bid', base: 'game', minSeats: 3,
        steps: [rollTo([[5, 6]]), kit => kit.clickControl('Auction'),
            kit => { kit.act('AUCTION_BID', { playerId: Auction.currentBidder(engine.state), amount: kit.n(10, 10020) }); kit.freeze(); }] },
    { id: 'auction-bid', group: 'auction', title: 'Auction, own bid turn', base: 'game',
        steps: [rollTo([[5, 6]]), kit => kit.clickControl('Auction'), kit => kit.bidsUntilHuman()] },
    { id: 'auction-bid-8', group: 'auction', title: 'Auction, own bid turn, 8 bidders', base: 'game', seats: 8,
        steps: [rollTo([[5, 6]]), kit => kit.clickControl('Auction'), kit => kit.bidsUntilHuman()] },

    { id: 'auction-cpu-only', group: 'auction', title: 'Auction, human passed (CPUs only: fast-forward)', base: 'game', minSeats: 3,
        steps: [rollTo([[5, 6]]), kit => kit.clickControl('Auction'), kit => kit.bidsUntilHuman(),
            kit => { kit.act('AUCTION_PASS', { playerId: 0 }); kit.freeze(); }] },

    /* ---------------- Sheets ---------------- */
    { id: 'sheet-deed', group: 'sheet', title: 'Deed (own, with houses)', base: 'game',
        steps: [holdings, () => document.querySelector('.tile[data-tile-id="19"]').click()] },
    { id: 'sheet-deed-other', group: 'sheet', title: "Deed (another player's)", base: 'game',
        steps: [holdings, () => document.querySelector('.tile[data-tile-id="39"]').click()] },
    { id: 'sheet-portfolio', group: 'sheet', title: 'Portfolio', base: 'game',
        steps: [holdings, kit => kit.clickControl('Properties')] },
    { id: 'sheet-owners', group: 'sheet', title: 'Ownership map', base: 'game',
        steps: [holdings, kit => kit.clickStatus('.btn-owners')] },
    { id: 'sheet-log', group: 'sheet', title: 'Game log (after a few turns)', base: 'game', settle: 250,
        steps: [kit => kit.playUntil(s => s.turnNumber >= 6 && s.currentPlayer === 0 && s.phase === GamePhase.AWAIT_PREROLL, 5000),
            kit => kit.clickStatus('.btn-log')] },
    { id: 'sheet-note', group: 'sheet', title: 'Game note', base: 'game', settle: 200,
        steps: [kit => {
            // No record is ever pushed (history stubbed): hand the sheet one
            GameHistory.get = id => Promise.resolve({ id, gameId: id, note: 'Bo refused every trade for the orange set; check the counter logic.' });
            kit.clickStatus('.btn-note');
            return kit.wait(150);
        }] },
    { id: 'sheet-card-chance', group: 'sheet', title: 'Chance card', base: 'game',
        steps: [kit => kit.topCard('chance', 'ch11'), rollTo([[3, 4]])] },
    { id: 'sheet-card-chest', group: 'sheet', title: 'Community Chest card', base: 'game',
        steps: [kit => kit.topCard('community', 'cc2'), rollTo([[1, 1]])] },
    { id: 'sheet-trade-builder', group: 'sheet', title: 'Trade builder', base: 'game',
        steps: [holdings, kit => kit.clickControl('Trade')] },
    { id: 'sheet-trade-offer', group: 'sheet', title: 'Incoming trade offer', base: 'game',
        steps: [holdings, kit => {
            const s = engine.state;
            s.currentPlayer = 1;
            kit.refresh();
            const r = kit.act('PROPOSE_TRADE', { offer: {
                from: 1, to: 0,
                give: { properties: kit.n([12], [12, 37, 39]), cash: kit.n(50, 12350), jailCards: 0 },
                get: { properties: kit.n([5], [5, 25, 1]), cash: kit.n(0, 9870), jailCards: 0 } } });
            kit.freeze();
            if (!r.ok) throw new Error('trade refused: ' + r.reason);
        }] },
    { id: 'sheet-trade-counter', group: 'sheet', title: 'Counter-offer builder', base: 'game',
        steps: [holdings, kit => {
            engine.state.currentPlayer = 1;
            kit.refresh();
            const r = kit.act('PROPOSE_TRADE', { offer: { from: 1, to: 0,
                give: { properties: kit.n([12], [12, 37, 39]), cash: kit.n(50, 12350), jailCards: 0 },
                get: { properties: kit.n([5], [5, 25, 1]), cash: kit.n(0, 9870), jailCards: 0 } } });
            kit.freeze();
            if (!r.ok) throw new Error('trade refused: ' + r.reason);
        }, kit => kit.clickModal('Counter')] },
    { id: 'sheet-saves', group: 'sheet', title: 'Save states (in game)', base: 'game',
        steps: [holdings, kit => kit.saveSlots([4, 9]), kit => kit.clickStatus('.btn-settings[aria-label="Settings"]'),
            kit => kit.clickModal('Saves')] },
    { id: 'sheet-saves-rewind', group: 'sheet', title: 'Save states: Go back? (rewind confirm)', base: 'game',
        steps: [holdings, kit => kit.saveSlots([4, 9]), kit => kit.clickStatus('.btn-settings[aria-label="Settings"]'),
            kit => kit.clickModal('Saves'), clickBtn('#modal-body .save-row .btn-primary', /Load/)] },
    { id: 'sheet-history', group: 'sheet', title: 'Game history (in game, Settings → History)', base: 'game', settle: 300,
        steps: [kit => kit.recordHistory(), holdings, kit => kit.pinHistoryTimes(),
            kit => kit.clickStatus('.btn-settings[aria-label="Settings"]'), kit => kit.clickModal('History'),
            waitFor('#modal-body')] },
    { id: 'sheet-houses', group: 'sheet', title: 'House manager', base: 'game',
        steps: [holdings, () => document.querySelector('.tile[data-tile-id="16"]').click(),
            kit => kit.clickModal('Manage houses')] },
    { id: 'sheet-settings-game', group: 'sheet', title: 'Settings in game', base: 'game',
        steps: [holdings, kit => kit.clickStatus('.btn-settings[aria-label="Settings"]')] },

    /* ---------------- Toasts ---------------- */
    { id: 'toast-board', group: 'toast', title: 'Toasts on the board', base: 'game', settle: 200,
        steps: [holdings, kit => {
            const P = i => engine.state.players[i].name;
            ToastOffset.showLong(kit.n(`🤝 ${P(1)} gives Kentucky Avenue + $120 ⇄ ${P(0)} gives Reading Railroad`,
                `🤝 ${P(1)} gives Electric Company + Park Place + Boardwalk + $12350 ⇄ ${P(0)} gives Reading Railroad + B&O Railroad + Mediterranean Avenue + $9870`), 'info');
            return kit.wait(50);
        }, kit => {
            const P = i => engine.state.players[i].name;
            showNotification(`🤝 ${P(2)} rejected ${P(0)}'s trade`, 'warning');
            return kit.wait(500);
        }] },
    // A CPU's turn: the cover drops the feed to the bottom, leaving the
    // toast its own slot under the dice
    { id: 'toast-cpu-turn', group: 'toast', title: 'Toast on a CPU turn', base: 'game', settle: 200,
        steps: [kit => { engine.state.currentPlayer = 1; kit.refresh(); },
            kit => kit.playUntil(s => s.turnNumber >= 3 && s.players[s.currentPlayer].isCPU
                && s.phase !== GamePhase.AWAIT_PREROLL && kit.headlines() >= 3, 5000),
            kit => {
                const P = i => engine.state.players[i].name;
                showNotification(`🤝 ${P(2)} rejected ${P(1)}'s trade`, 'warning');
                return kit.wait(300);
            }] },
    { id: 'toast-cpu-card', group: 'toast', title: 'CPU draws a card while a sheet hides the feed', base: 'game', settle: 200,
        steps: [holdings, kit => kit.clickControl('Properties'),
            kit => { EventBus.emit('cardDrawn', { player: 1, deck: 'chance', card: CHANCE_CARDS[0] }); return kit.wait(300); }] },
    { id: 'toast-sheet', group: 'toast', title: 'Toast over a sheet', base: 'game', settle: 200,
        steps: [holdings, kit => kit.clickControl('Properties'),
            kit => {
                const P = i => engine.state.players[i].name;
                showNotification(`${P(0)} pays $${kit.n(28, 2000)} rent to ${P(1)}`, 'warning');
                return kit.wait(100);
            }] },
    // A toast shown on a sheet, then the sheet closed with its ✕: where the
    // toast lands back on the board (settled)
    { id: 'toast-sheet-close', group: 'toast', title: 'Toast over a sheet, then the sheet closed', base: 'game', settle: 400,
        steps: [holdings, kit => kit.clickControl('Properties'),
            kit => {
                const P = i => engine.state.players[i].name;
                showNotification(`${P(0)} pays $${kit.n(28, 2000)} rent to ${P(1)}`, 'warning');
                return kit.wait(400);
            },
            () => document.getElementById('modal-close').click()] },
    // A toast on the board, then a sheet opened over it
    { id: 'toast-board-open', group: 'toast', title: 'Toast on the board, then a sheet opened', base: 'game', settle: 400,
        steps: [holdings,
            kit => {
                const P = i => engine.state.players[i].name;
                showNotification(`${P(0)} pays $${kit.n(28, 2000)} rent to ${P(1)}`, 'warning');
                return kit.wait(400);
            },
            kit => kit.clickControl('Properties')] }
];

// The same two, caught mid-move (about 60 ms after the close / open):
// does the toast slide, jump or flash on the way?
['toast-sheet-close', 'toast-board-open'].forEach(id => {
    const st = STATES.find(x => x.id === id);
    STATES.push(Object.assign({}, st, { id: id + '-mid', title: st.title + ' (mid-move)', settle: 60 }));
});

// A toast over each kind of modal (the same steps as that modal's own state)
const TOAST_OVER = ['auction-spectator', 'auction-bid', 'sheet-deed', 'sheet-card-chance',
    'sheet-trade-builder', 'sheet-trade-offer', 'sheet-houses', 'sheet-log', 'game-debt', 'game-over'];
TOAST_OVER.forEach(id => {
    const st = STATES.find(x => x.id === id);
    STATES.push(Object.assign({}, st, {
        id: 'toast-over-' + id, group: 'toast', title: 'Toast over: ' + st.title, settle: Math.max(st.settle || 0, 200),
        steps: [...st.steps, kit => {
            const P = i => engine.state.players[i].name;
            // (game-over has 2 seats)
            showNotification(`${P(engine.state.players.length - 1)} pays $${kit.n(28, 2000)} rent to ${P(0)}`, 'warning');
            return kit.wait(300);
        }]
    }));
});

module.exports = { STATES };
