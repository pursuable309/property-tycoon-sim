#!/usr/bin/env node
/**
 * Reusable headless simulation harness for the Property Tycoon CPU AI.
 *
 * Bundles the non-UI game scripts into one Node `vm` context (persist:false, so
 * no browser / localStorage / server needed) and plays full CPU-only games,
 * reporting the metrics that AI-tuning work actually needs:
 *
 *   - winnersByDifficulty  — the difficulty ladder (is d5 > d4 > d3 ...?)
 *   - developersPerGame    — how many players ever build >=1 house, i.e. ever
 *                            COMPLETE + DEVELOP a monopoly (the load-bearing
 *                            metric: CPUs that never develop cannot win)
 *   - trade quality        — total / swaps / cash-buys / set-completing / churn
 *   - invariants           — house-hotel stock, even-building, cash, jail cards
 *
 * Metrics are gathered by INSTRUMENTING PropertyActions.buildHouse and
 * Trading.apply, not by parsing state.log — state.log is a 200-entry ring
 * buffer, so most events in a long game have scrolled off.
 *
 * CLI:
 *   node sim_harness.js [--n 60] [--seed 4242] [--diff 2,3,4,5]
 *        [--balanced] [--delayed] [--tune k=v,k=v] [--arch trader]
 *        [--activity normal] [--flex fair] [--no-counters] [--json] [--quiet]
 *   Progress prints to stderr in flight (per-game tallies + per-rotation
 *   cumulative win%) so long runs are observable; --quiet suppresses it and
 *   --json output on stdout stays parseable either way.
 *   node sim_harness.js --ruleset all           # the 3 configs the history uses
 *   node sim_harness.js --ladder [--n 40] [--diff 2,3,4,5] [--tune ...] [--ruleset all] [--cap 150]
 *        # seat-controlled ladder: Latin-square seat rotations (each difficulty in
 *        # each seat equally) so per-difficulty win% is free of seat/turn-order bias.
 *        # Works for any arity — [3,5] = 2-player head-to-head, [2,3,4,5] = 4-player.
 *        # Reports per difficulty: win% / capWin% / survive% / monopolies-per-survivor /
 *        # dev% / set-completing. capWin% = net-worth leader at the turn cap (--cap,
 *        # default 150) — a quality-adjusted win that attrition grinds do NOT earn, so
 *        # "win% up but capWin% flat + avgSteps up" reads as an attrition confound.
 *
 * Module:
 *   const { runBatch } = require('./sim_harness');
 *   const m = runBatch({ n: 60, seed: 4242, difficulties: [2,3,4,5],
 *                        balancedRents: false, delayedBuy: false, tune: {} });
 *   // -> metrics object (see buildMetrics). Deterministic given seed.
 *
 * A/B pattern: call runBatch twice with the same seed, differing only in `tune`
 * (or in edited source), and diff the metric blocks.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---- locate repo root (dir containing scripts/core/board-data.js) ---- */
function findRoot() {
    let d = __dirname;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(d, 'scripts', 'core', 'board-data.js'))) return d;
        d = path.dirname(d);
    }
    if (fs.existsSync(path.join(process.cwd(), 'scripts/core/board-data.js'))) return process.cwd();
    throw new Error('could not locate scripts/core/board-data.js from ' + __dirname);
}
const ROOT = findRoot();

const FILES = [
    'scripts/core/constants.js',       // defines EventBus, GamePhase, GAME_CONST, GROUP_META
    'scripts/core/rng.js',
    'scripts/core/board-data.js',
    'scripts/core/storage.js',
    'scripts/core/game-state.js',
    'scripts/core/rules-engine.js',
    'scripts/features/cards.js',
    'scripts/features/property-actions.js',
    'scripts/features/auction.js',
    'scripts/features/bankruptcy.js',
    'scripts/features/trading.js',
    'scripts/ai/tuning.js',
    'scripts/ai/evaluator.js',
    'scripts/ai/lookahead.js',
    'scripts/ai/personalities.js',
    'scripts/ai/cpu-player.js',
    'scripts/core/turn-engine.js',
];

/** Build a fresh sandbox with all game globals. Returns the sandbox. */
function loadGame() {
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.console = console;
    sandbox.setTimeout = setTimeout;
    sandbox.document = {
        createElement: () => ({ click() {}, setAttribute() {}, style: {} }),
        body: { appendChild() {} },
    };
    const store = {};
    sandbox.localStorage = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: i => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
    };
    sandbox.fetch = () => Promise.reject(new Error('no network in sim'));
    vm.createContext(sandbox);

    let bundle = FILES.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
    bundle += '\n;window.__sim = { GameState, MonopolyEngine, GamePhase, Personalities, '
        + 'AITuning, Evaluator, Lookahead, Rules, GAME_CONST, GROUP_META, BOARD, PropertyActions, Trading, EventBus, win: window };';
    vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });
    return sandbox.__sim;
}

/* ------------------------------- invariants ------------------------------ */
function invariants(G, state, label, violations) {
    const { GAME_CONST, GROUP_META, Rules, GamePhase } = G;
    let housesOut = 0, hotelsOut = 0;
    Object.keys(state.tiles).forEach(k => {
        const h = state.tiles[k].houses;
        if (h === 5) hotelsOut += 1; else housesOut += h;
    });
    if (state.bank.houses + housesOut !== GAME_CONST.BANK_HOUSES)
        violations.push(`${label}: house stock broken (bank ${state.bank.houses} + board ${housesOut})`);
    if (state.bank.hotels + hotelsOut !== GAME_CONST.BANK_HOTELS)
        violations.push(`${label}: hotel stock broken (bank ${state.bank.hotels} + board ${hotelsOut})`);
    state.players.forEach(p => {
        if (!p.bankrupt && p.cash < 0 && state.phase !== GamePhase.DEBT_SETTLEMENT)
            violations.push(`${label}: ${p.name} negative cash ($${p.cash}) in ${state.phase}`);
    });
    Object.keys(GROUP_META).forEach(group => {
        if (group === 'railroad' || group === 'utility') return;
        const ids = Rules.tilesInGroup(group);
        const counts = ids.map(id => Rules.houseCount(state, id));
        const owners = ids.map(id => Rules.getOwner(state, id));
        const monopoly = owners.every(o => o !== null && o === owners[0]);
        if (monopoly && Math.max(...counts) - Math.min(...counts) > 1)
            violations.push(`${label}: uneven building on ${group} (${counts})`);
    });
    const held = state.players.reduce((s, p) => s + p.getOutCards, 0);
    const flagged = (state.decks.chanceJailCardHeldBy !== null ? 1 : 0) +
        (state.decks.communityJailCardHeldBy !== null ? 1 : 0);
    if (held !== flagged) violations.push(`${label}: jail card mismatch (held ${held}, flagged ${flagged})`);
}

/* --------------------------------- batch --------------------------------- */
function runBatch(opts = {}) {
    const G = opts._game || loadGame();
    const { GameState, MonopolyEngine, GamePhase, Personalities, AITuning,
        Rules, GROUP_META, BOARD, PropertyActions, Trading } = G;

    const n = opts.n || 50;
    const seed = opts.seed !== undefined ? opts.seed : 4242;
    const difficulties = opts.difficulties || [2, 3, 4, 5];
    const maxSteps = opts.maxSteps || 20000;
    // In-flight progress on stderr (stdout stays clean for --json); a long
    // rollout-era batch is otherwise silent for many minutes. --quiet stops it.
    const progress = opts.progress !== false;
    const progEvery = Math.max(5, Math.round(n / 10));
    const progLabel = opts._label || `seed=${seed}`;

    // trade settings live on window.DEV in the real app; the CPU reads them via
    // _tradeConfig from window.DEV. G.win IS the sandbox/window, so set it there.
    const dev = {
        tradeActivity: opts.activity || 'normal',
        tradeFlex: opts.flex || 'fair',
        cpuCounters: opts.counters !== false,
        cpuDelay: 0,
    };
    G.win.DEV = dev;

    // apply AI tuning overrides (clamped to registry bounds by AITuning.set)
    if (opts.tune) for (const k of Object.keys(opts.tune)) AITuning.set(k, opts.tune[k]);

    // ---- instrumentation ----
    let buildEvents;   // per game: {playerId, group}
    let setCompletingTrades, swapTrades, cashBuyTrades, setCompletingByDiff;
    // Trade economics + exposure (2026-09-30, E42/E43): cash moved through
    // trades; "pair-advance handovers" = a side goes 0->1 of a two-tile group
    // (brown/dark blue) in a trade that completes a set for the OTHER side (the
    // mud9g25d t193 shape the mutualDampMinTiles fix targets); shut-out entries
    // = a player holding no colour deed acquires one by trade (E43's target,
    // detected structurally so the base arm's natural entries count too).
    let cashMoved, pairAdvanceHandovers, shutoutEntries, entrants;

    const groupOf = id => BOARD[id] && BOARD[id].group;
    const fullOwnerOf = (state, group) => {
        const ids = Rules.tilesInGroup(group);
        const o = Rules.getOwner(state, ids[0]);
        return o !== null && ids.every(id => Rules.getOwner(state, id) === o) ? o : null;
    };

    // Wrap the PRISTINE originals (stored on the context) so repeated batches
    // sharing one context don't stack wrappers and double-count.
    G._origBuild = G._origBuild || PropertyActions.buildHouse.bind(PropertyActions);
    G._origApply = G._origApply || Trading.apply.bind(Trading);
    const origBuild = G._origBuild;
    // Lookahead rollouts run on throwaway clones through these same globals —
    // skip recording them or d5's simulated builds/trades pollute the metrics.
    const inRollout = () => G.Lookahead && G.Lookahead._active;
    PropertyActions.buildHouse = function (state, playerId, tileId) {
        const r = origBuild(state, playerId, tileId);
        if (!inRollout()) buildEvents.push({ playerId, group: groupOf(tileId) });
        return r;
    };
    // Broker involvement: who took part in a 3-way broker this game (by role),
    // read from the non-enumerable _broker tag _proposeBroker attaches to its
    // leg-1 offer. Lets us answer "do broker-involved CPUs win?" per role
    // (actor A vs recipient B vs leg-1 seller C).
    const CPUPlayer = G.win.CPUPlayer;
    let brokerParties;   // per game: {actor,recipient,seller,any} of playerIds
    G._origBroker = G._origBroker || CPUPlayer._proposeBroker.bind(CPUPlayer);
    const origBroker = G._origBroker;
    CPUPlayer._proposeBroker = function (state, player, cfg) {
        const r = origBroker(state, player, cfg);
        if (r && r._broker && !inRollout() && brokerParties) {
            const b = r._broker;
            brokerParties.actor.add(b.A); brokerParties.recipient.add(b.B); brokerParties.seller.add(b.C);
            [b.A, b.B, b.C].forEach(id => brokerParties.any.add(id));
        }
        return r;
    };
    const origApply = G._origApply;
    Trading.apply = function (state, offer) {
        if (inRollout()) return origApply(state, offer);
        const groups = new Set();
        [...offer.give.properties, ...offer.get.properties].forEach(id => groups.add(groupOf(id)));
        const before = {};
        groups.forEach(g => { before[g] = fullOwnerOf(state, g); });
        const propsBoth = offer.give.properties.length > 0 && offer.get.properties.length > 0;
        const propsOne = (offer.give.properties.length > 0) !== (offer.get.properties.length > 0);
        const colourCount = pid => BOARD.filter(t => t.type === 'property' && Rules.getOwner(state, t.id) === pid).length;
        const pairHeld = pid => ['brown', 'darkblue'].map(g => Rules.tilesInGroup(g).filter(id => Rules.getOwner(state, id) === pid).length);
        const fromPair0 = pairHeld(offer.from), toPair0 = pairHeld(offer.to);
        const fromColour0 = colourCount(offer.from), toColour0 = colourCount(offer.to);
        const r = origApply(state, offer);
        cashMoved += (offer.give.cash || 0) + (offer.get.cash || 0);
        const completedFor = pid => [...groups].some(g => g !== 'railroad' && g !== 'utility' &&
            before[g] === null && fullOwnerOf(state, g) === pid);
        const pairStep = (pid, held0) => pairHeld(pid).some((n, i) => held0[i] === 0 && n === 1);
        if ((pairStep(offer.from, fromPair0) && completedFor(offer.to)) ||
            (pairStep(offer.to, toPair0) && completedFor(offer.from))) pairAdvanceHandovers++;
        [[offer.from, fromColour0], [offer.to, toColour0]].forEach(([pid, n0]) => {
            if (n0 === 0 && colourCount(pid) > 0) { shutoutEntries++; entrants.add(pid); }
        });
        groups.forEach(g => {
            if (before[g] !== null) return;
            const o = fullOwnerOf(state, g);
            if (o === null) return;
            setCompletingTrades++;
            const pd = state.players[o] && state.players[o].difficulty;
            if (pd != null && setCompletingByDiff[pd] !== undefined) setCompletingByDiff[pd]++;
        });
        if (propsBoth) swapTrades++; else if (propsOne) cashBuyTrades++;
        return r;
    };

    // ---- accumulators ----
    const winnersByDifficulty = {}; difficulties.forEach(d => { winnersByDifficulty[d] = 0; });
    const winnersBySeat = difficulties.map(() => 0);
    let winnersNone = 0;
    const violations = [];
    let totalSteps = 0, totalHouses = 0, totalTrades = 0, totalReversals = 0, pingpongGames = 0;
    cashMoved = pairAdvanceHandovers = shutoutEntries = 0;
    let entrantDeveloped = 0, entrantWins = 0;
    const developerCounts = [];   // developers per game
    let loneDeveloperGames = 0;   // games with <=1 developer
    let monopolyDeveloperTotal = 0;
    setCompletingTrades = swapTrades = cashBuyTrades = 0;
    setCompletingByDiff = {}; difficulties.forEach(d => { setCompletingByDiff[d] = 0; });
    // broker involvement vs. actual win (state.winner), by role
    let brokerGames = 0, brokerWinsAny = 0, brokerWinsActor = 0, brokerWinsRecipient = 0, brokerWinsSeller = 0;
    // per-difficulty attribution (valid when difficulties are distinct within a game)
    // capWins: net-worth leader at the turn cap (attrition-blind "who is ahead
    // when the game SHOULD be decided"); developed: games where this difficulty
    // built >=1 house (developed a monopoly at all).
    const byDiff = {}; difficulties.forEach(d => { byDiff[d] = { games: 0, wins: 0, survived: 0, monopolies: 0, capWins: 0, developed: 0 }; });
    // Same per-seat stats keyed by archetype ('builder') and archetype x
    // difficulty ('builder/d5'). Archetypes are rolled per player from the game
    // seed (independent of tune), so arms stay paired seat-for-seat. Per-seat
    // counting also makes byDiff valid when a difficulty repeats (6p/8p tables).
    const byArch = {};
    const archRow = k => (byArch[k] = byArch[k] || { games: 0, wins: 0, survived: 0, monopolies: 0, capWins: 0, developed: 0 });
    // Turn cap for the quality-adjusted "capWin%" metric: a decisive lead by
    // this turn, not an attrition grind, is what a stronger difficulty should
    // show. Read-only (Rules.netWorth is pure) so the rollouts=0 canary is
    // unaffected — this changes reporting, never game execution.
    const TURN_CAP = opts.turnCap || 150;
    const netWorthLeader = (state) => {
        let best = -Infinity, id = null;
        GameState.activePlayers(state).forEach(p => {
            const nw = Rules.netWorth(state, p.id);
            if (nw > best) { best = nw; id = p.id; }
        });
        return id;
    };

    for (let g = 0; g < n; g++) {
        buildEvents = [];
        entrants = new Set();
        brokerParties = { actor: new Set(), recipient: new Set(), seller: new Set(), any: new Set() };
        const seats = difficulties.map((d, i) => {
            const s = { name: `d${d}#${i}`, isCPU: true, difficulty: d };
            if (opts.arch) s.personalityPick = opts.arch;
            return s;
        });
        const state = GameState.createGame({
            seats, seed: seed + g,
            balancedRents: !!opts.balancedRents,
            delayedBuy: !!opts.delayedBuy,
        });
        state.players.forEach(p => Personalities.assign(state, p));
        const sim = new MonopolyEngine(state, { persist: false, autoPump: false, cpuDelay: 0 });

        let steps = 0;
        let capSnapDone = false, capLeaderId = null;
        while (state.phase !== GamePhase.GAME_OVER && steps < maxSteps) {
            if (!sim.step()) break;
            steps += 1;
            // Freeze the net-worth leader the first moment the game reaches the
            // turn cap; if the game ends earlier the real winner stands in.
            if (!capSnapDone && state.turnNumber >= TURN_CAP) {
                capLeaderId = netWorthLeader(state);
                capSnapDone = true;
            }
            if (steps % 200 === 0) invariants(G, state, `g${g} s${steps}`, violations);
            if (violations.length > 30) break;
        }
        invariants(G, state, `g${g} end`, violations);
        totalSteps += steps;
        // Turn-capped winner: leader frozen at the cap, else the actual winner
        // (game decided before the cap), else the final leader (stalled game).
        const capWinnerId = capSnapDone ? capLeaderId
            : state.winner !== null ? state.winner : netWorthLeader(state);

        // developers & monopolies developed (from instrumented build events)
        const devGroups = {};   // playerId -> Set(groups)
        buildEvents.forEach(e => { (devGroups[e.playerId] = devGroups[e.playerId] || new Set()).add(e.group); });
        const developers = Object.keys(devGroups);
        entrants.forEach(pid => {
            if (devGroups[pid] && devGroups[pid].size > 0) entrantDeveloped++;
            if (state.winner === pid) entrantWins++;
        });
        developerCounts.push(developers.length);
        if (developers.length <= 1) loneDeveloperGames++;
        developers.forEach(pid => { monopolyDeveloperTotal += devGroups[pid].size; });
        totalHouses += buildEvents.length;

        // trade churn (reversals of the same tile between the same pair)
        const trades = state.trades || [];
        totalTrades += trades.length;
        const transfers = [];
        for (const t of trades) {
            for (const tile of (t.give.properties || [])) transfers.push({ tile, giver: t.from, receiver: t.to, turn: t.turn });
            for (const tile of (t.get.properties || [])) transfers.push({ tile, giver: t.to, receiver: t.from, turn: t.turn });
        }
        const byTile = {};
        for (const tr of transfers) (byTile[tr.tile] = byTile[tr.tile] || []).push(tr);
        let gRev = 0;
        for (const tile of Object.keys(byTile)) {
            const seq = byTile[tile].sort((a, b) => a.turn - b.turn);
            for (let i = 1; i < seq.length; i++)
                if (seq[i].giver === seq[i - 1].receiver && seq[i].receiver === seq[i - 1].giver) gRev++;
        }
        totalReversals += gRev;
        if (gRev >= 2) pingpongGames++;

        if (state.winner !== null) {
            const w = state.players[state.winner];
            winnersByDifficulty[w.difficulty] += 1;
            winnersBySeat[state.winner] += 1;
        } else winnersNone += 1;

        if (brokerParties.any.size > 0) {
            brokerGames++;
            const w = state.winner;
            if (w !== null) {
                if (brokerParties.any.has(w)) brokerWinsAny++;
                if (brokerParties.actor.has(w)) brokerWinsActor++;
                if (brokerParties.recipient.has(w)) brokerWinsRecipient++;
                if (brokerParties.seller.has(w)) brokerWinsSeller++;
            }
        }

        state.players.forEach(p => {
            const arch = p.personality ? p.personality.archetype : '?';
            [byDiff[p.difficulty], archRow(arch), archRow(`${arch}/d${p.difficulty}`)].forEach(b => {
                if (!b) return;
                b.games++;
                if (state.winner === p.id) b.wins++;
                if (capWinnerId === p.id) b.capWins++;
                if (devGroups[p.id] && devGroups[p.id].size > 0) b.developed++;
                if (!p.bankrupt) { b.survived++; b.monopolies += (devGroups[p.id] ? devGroups[p.id].size : 0); }
            });
        });

        if (progress && ((g + 1) % progEvery === 0 || g + 1 === n)) {
            const wl = Object.entries(winnersByDifficulty).map(([d, w]) => `d${d}:${w}`).join(' ');
            process.stderr.write(`    [${progLabel}] game ${g + 1}/${n}  wins ${wl}  viol ${violations.length}\n`);
        }
    }

    const avg = (x) => Math.round((x / n) * 100) / 100;
    return {
        config: { n, seed, difficulties, balancedRents: !!opts.balancedRents,
            delayedBuy: !!opts.delayedBuy, activity: dev.tradeActivity, flex: dev.tradeFlex,
            counters: dev.cpuCounters, tune: opts.tune || {}, arch: opts.arch || 'random' },
        winnersByDifficulty, winnersBySeat, winnersNone,
        byDifficulty: byDiff, byArchetype: byArch, setCompletingByDiff,
        ladderMonotonic: isMonotonic(difficulties, winnersByDifficulty),
        developers: { avgPerGame: avg(developerCounts.reduce((a, b) => a + b, 0)),
            loneDeveloperGames, lonePct: Math.round((loneDeveloperGames / n) * 100),
            avgMonopoliesDeveloped: avg(monopolyDeveloperTotal) },
        development: { avgHousesPerGame: avg(totalHouses) },
        trades: { total: totalTrades, avgPerGame: avg(totalTrades),
            setCompleting: setCompletingTrades, swaps: swapTrades, cashBuys: cashBuyTrades,
            reversals: totalReversals, pingpongGames, cashMoved, pairAdvanceHandovers,
            shutoutEntries, entrantDeveloped, entrantWins },
        broker: { games: brokerGames, winsAny: brokerWinsAny, winsActor: brokerWinsActor,
            winsRecipient: brokerWinsRecipient, winsSeller: brokerWinsSeller },
        games: { avgSteps: Math.round(totalSteps / n) },
        violations,
    };
}

/** Are wins non-decreasing as difficulty rises? (distinct difficulties only) */
function isMonotonic(difficulties, winsByDiff) {
    const ds = [...new Set(difficulties)].sort((a, b) => a - b);
    for (let i = 1; i < ds.length; i++) if (winsByDiff[ds[i]] < winsByDiff[ds[i - 1]]) return false;
    return true;
}

/**
 * Seat-controlled ladder measurement. Runs the given difficulty set through a
 * Latin square of cyclic seat rotations (each difficulty occupies each seat
 * equally) so per-difficulty win rate is free of seat/turn-order bias. Works
 * for any arity (2-player head-to-head, 4-player, ...). Aggregates the
 * per-difficulty diagnostics (win%, survive%, monopolies developed,
 * set-completing trades) across all rotations.
 */
function runLadder(opts = {}) {
    const G = opts._game || loadGame();
    const ds = (opts.difficulties || [2, 3, 4, 5]).slice();
    const n = opts.n || 40;
    const rotations = ds.map((_, r) => ds.map((__, i) => ds[(i + r) % ds.length]));
    // A difficulty may repeat (6p/8p shapes): aggregate each distinct one ONCE
    // per batch — batch stats are already per seat, so win% = wins / seat-games
    // (a fair share is 1/N seats, e.g. 12.5% at 8p).
    const ud = [...new Set(ds)];
    const agg = {}; ud.forEach(d => { agg[d] = { games: 0, wins: 0, survived: 0, monopolies: 0, setCompleting: 0, capWins: 0, developed: 0 }; });
    const aggArch = {};
    const broker = { games: 0, winsAny: 0, winsActor: 0, winsRecipient: 0, winsSeller: 0 };
    // Trade totals summed over rotations (per-game rates = x / totalGames).
    const trades = { total: 0, setCompleting: 0, swaps: 0, cashBuys: 0, reversals: 0, pingpongGames: 0,
        cashMoved: 0, pairAdvanceHandovers: 0, shutoutEntries: 0, entrantDeveloped: 0, entrantWins: 0 };
    const rules = opts.balancedRents ? 'balanced+delayed' : opts.delayedBuy ? 'delayed' : 'standard';
    const progress = opts.progress !== false;
    let violations = 0, totalSteps = 0, batches = 0;
    rotations.forEach((rot, r) => {
        const m = runBatch({ ...opts, difficulties: rot, n, seed: (opts.seed || 4242) + r * 10000, _game: G,
            _label: `${rules} rot ${r + 1}/${rotations.length}` });
        ud.forEach(d => {
            const b = m.byDifficulty[d], a = agg[d];
            a.games += b.games; a.wins += b.wins; a.survived += b.survived; a.monopolies += b.monopolies;
            a.capWins += b.capWins; a.developed += b.developed;
            a.setCompleting += m.setCompletingByDiff[d] || 0;
        });
        Object.entries(m.byArchetype || {}).forEach(([k, b]) => {
            const a = aggArch[k] = aggArch[k] || { games: 0, wins: 0, survived: 0, monopolies: 0, capWins: 0, developed: 0 };
            Object.keys(a).forEach(f => { a[f] += b[f]; });
        });
        if (m.broker) { broker.games += m.broker.games; broker.winsAny += m.broker.winsAny;
            broker.winsActor += m.broker.winsActor; broker.winsRecipient += m.broker.winsRecipient;
            broker.winsSeller += m.broker.winsSeller; }
        Object.keys(trades).forEach(k => { trades[k] += (m.trades[k] || 0); });
        violations += m.violations.length; totalSteps += m.games.avgSteps; batches++;
        if (progress) {
            const run = ud.map(d => `d${d} ${(100 * agg[d].wins / agg[d].games).toFixed(0)}%`).join('  ');
            process.stderr.write(`  [ladder ${rules}] rotation ${r + 1}/${rotations.length} done — cumulative win% ${run}  viol ${violations}\n`);
        }
    });
    const winPct = d => agg[d].games ? agg[d].wins / agg[d].games : 0;
    const sorted = [...ud].sort((a, b) => a - b);
    let monotonic = true;
    for (let i = 1; i < sorted.length; i++) if (winPct(sorted[i]) < winPct(sorted[i - 1]) - 0.02) monotonic = false;
    return { rules, difficulties: sorted, n, rotations: rotations.length, totalGames: n * rotations.length,
        seats: ds, agg, aggArch, broker, trades, monotonic, violations, avgSteps: Math.round(totalSteps / batches),
        turnCap: opts.turnCap || 150, tune: opts.tune || {} };
}

function printLadder(L) {
    const tune = Object.keys(L.tune).length ? '  tune{' + Object.entries(L.tune).map(([k, v]) => `${k}=${v}`).join(',') + '}' : '';
    console.log(`\nLadder [seat-rotated]  rules=${L.rules}  ${L.totalGames} games (${L.n}×${L.rotations} rot)  avgSteps ${L.avgSteps}  cap@turn ${L.turnCap}  viol ${L.violations}${tune}`);
    console.log('  diff |  win%  | capWin% | survive% | monopolies/surv | dev% | setCompleting');
    L.difficulties.forEach(d => {
        const a = L.agg[d];
        const win = (100 * a.wins / a.games).toFixed(1);
        const cap = (100 * a.capWins / a.games).toFixed(1);
        const sv = (100 * a.survived / a.games).toFixed(0);
        const mo = a.survived ? (a.monopolies / a.survived).toFixed(2) : '0';
        const dev = (100 * a.developed / a.games).toFixed(0);
        console.log(`   d${d}  | ${win.padStart(5)}% | ${cap.padStart(5)}% |   ${sv.padStart(3)}%   |      ${mo.padStart(4)}       | ${dev.padStart(3)}% |   ${a.setCompleting}`);
    });
    console.log(`  ladder win% monotonic (d↑ ⇒ win↑, 2pt tol): ${L.monotonic ? 'YES ✓' : 'NO ✗'}`);
    console.log('  capWin% = net-worth leader at the turn cap (attrition wins do not count); dev% = games this difficulty built ≥1 house.');
}

/* ---------------------------------- CLI ---------------------------------- */
function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--n') o.n = parseInt(next(), 10);
        else if (a === '--seed') o.seed = parseInt(next(), 10);
        else if (a === '--diff') o.difficulties = next().split(',').map(Number);
        else if (a === '--balanced') o.balancedRents = true;
        else if (a === '--delayed') o.delayedBuy = true;
        else if (a === '--activity') o.activity = next();
        else if (a === '--flex') o.flex = next();
        else if (a === '--no-counters') o.counters = false;
        else if (a === '--arch') o.arch = next();
        else if (a === '--json') o.json = true;
        else if (a === '--quiet') o.progress = false;
        else if (a === '--ladder') o.ladder = true;
        else if (a === '--cap') o.turnCap = parseInt(next(), 10);
        else if (a === '--ruleset') o.ruleset = next();
        else if (a === '--tune') {
            o.tune = {};
            next().split(',').forEach(kv => { const [k, v] = kv.split('='); o.tune[k] = parseFloat(v); });
        }
    }
    return o;
}

function printMetrics(m) {
    const c = m.config;
    const rules = [c.balancedRents && 'balancedRents', c.delayedBuy && 'delayedBuy'].filter(Boolean).join('+') || 'standard';
    const wl = Object.entries(m.winnersByDifficulty).map(([d, w]) => `d${d}:${w}`).join('  ');
    const tune = Object.keys(c.tune).length ? '  tune{' + Object.entries(c.tune).map(([k, v]) => `${k}=${v}`).join(',') + '}' : '';
    console.log(`\n── rules=${rules}  n=${c.n} seed=${c.seed} diff=[${c.difficulties}] arch=${c.arch} act=${c.activity}/${c.flex}${tune}`);
    console.log(`   winners  ${wl}  none:${m.winnersNone}   ladderMonotonic:${m.ladderMonotonic ? 'YES' : 'NO'}`);
    console.log(`   developers/game: ${m.developers.avgPerGame}   lone-developer games: ${m.developers.loneDeveloperGames}/${c.n} (${m.developers.lonePct}%)   monopolies-developed/game: ${m.developers.avgMonopoliesDeveloped}`);
    console.log(`   houses/game: ${m.development.avgHousesPerGame}   avgSteps: ${m.games.avgSteps}`);
    console.log(`   trades/game: ${m.trades.avgPerGame} (total ${m.trades.total})  set-completing:${m.trades.setCompleting}  swaps:${m.trades.swaps}  cash-buys:${m.trades.cashBuys}  reversals:${m.trades.reversals}  pingpong-games:${m.trades.pingpongGames}`);
    console.log(`   invariant violations: ${m.violations.length}${m.violations.length ? '  ' + JSON.stringify(m.violations.slice(0, 3)) : ''}`);
}

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    const G = loadGame();
    if (opts.ladder) {
        const presets = opts.ruleset === 'all'
            ? [{}, { delayedBuy: true }, { balancedRents: true, delayedBuy: true }]
            : [{ balancedRents: opts.balancedRents, delayedBuy: opts.delayedBuy }];
        const out = [];
        for (const p of presets) {
            const L = runLadder({ ...opts, ...p, _game: G });
            out.push(L);
            if (!opts.json) printLadder(L);
        }
        if (opts.json) console.log(JSON.stringify(out.length === 1 ? out[0] : out, null, 2));
        return;
    }
    const presets = opts.ruleset === 'all'
        ? [{}, { delayedBuy: true }, { balancedRents: true, delayedBuy: true }]
        : [{ balancedRents: opts.balancedRents, delayedBuy: opts.delayedBuy }];
    const results = [];
    for (const p of presets) {
        const m = runBatch({ ...opts, ...p, _game: G });
        results.push(m);
        if (!opts.json) printMetrics(m);
    }
    if (opts.json) console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

module.exports = { loadGame, runBatch, runLadder, isMonotonic };
