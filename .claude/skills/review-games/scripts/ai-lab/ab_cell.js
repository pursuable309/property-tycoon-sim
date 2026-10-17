'use strict';
// One ladder cell for the 2026-07-30 overnight run, on top of the shipped
// Arm G ladder (d4 noise 0.22 / auctionSmarts 0.5, d3 0.30).
//   --seed --rules standard|delayed|bd --arm base|noscar|uf05|uf10|uf15
//   [--shape 5p|4p|h2h] --out <file>
// Arms:
//   base   tonight's code with the repair lever OFF (the reference)
//   noscar bank-scarcity valuation fix DISABLED (guardrail: did the fix,
//          which is now default-on, move anything? exposure is ~1% of steps)
//   uf05/uf10/uf15  evaluator.unfreezeSetPriority 0.5 / 1.0 / 1.5 — rank
//          lifting a mortgage that FREEZES one of my own colour monopolies
//          against buying another house. Measured cause: 43.6% of d5's
//          under-built monopolies are frozen by its own mortgage and the
//          management order never repaired them.
const { loadGame, runLadder } = require('../sim_harness.js');
const A = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const seed = parseInt(A('seed', '4242'), 10);
const rules = A('rules', 'standard');
const arm = A('arm', 'base');
const out = A('out');
const RS = { standard: {}, delayed: { delayedBuy: true }, bd: { balancedRents: true, delayedBuy: true } }[rules];
const LIVE = {
    'archetype.builder.cashFloorMul': 0.95, 'archetype.aggressive.cashFloorMul': 0.75,
    'archetype.trader.tradeFrequency': 0.6, 'archetype.cautious.buyBias': 1,
    'archetype.hoarder.cashFloorMul': 1.05, 'archetype.hoarder.tradeFrequency': 0.2,
};
const TUNE = {
    base: {},
    noscar: { 'evaluator.bankScarcityAware': 0 },
    uf05: { 'evaluator.unfreezeSetPriority': 0.5 },
    uf10: { 'evaluator.unfreezeSetPriority': 1.0 },
    uf15: { 'evaluator.unfreezeSetPriority': 1.5 },
    // Round 2 (2026-07-30): is d5's exclusive Monte Carlo rollout earning its
    // keep at all? nola kills the whole subsystem; noveto keeps the trade
    // accept/reject + P2 proposal gate but disables the BUY veto only (a tiny
    // positive clearRatio makes every wanted, reserve-clearing buy "clear", so
    // the rollout is never consulted on buys - documented defect: it passes
    // +EV properties while cash-rich).
    // CEILING probe (2026-07-30): how much 5p win% can MORE SEARCH buy at all?
    // Only d5 has lookahead:1, so cranking these boosts d5 alone. deep24 uses
    // the shipped knob ceiling; deep blows past it (bounds raised below) to
    // ~12x rollouts x 2x horizon. If a d5 with 24x the search budget barely
    // moves at 5p, the 4-5p headroom is variance, not missing AI - and that
    // number ends the guessing instead of lever #12.
    deep24: { 'evaluator.lookaheadRollouts': 24, 'evaluator.lookaheadHorizon': 40 },
    deep: { 'evaluator.lookaheadRollouts': 96, 'evaluator.lookaheadHorizon': 40 },
    // E52 (2026-10-17): rollouts alone at the shipped horizon — separates "less
    // sampling noise" (more rollouts) from "sees further" (longer horizon).
    roll24: { 'evaluator.lookaheadRollouts': 24 },
    nola: { 'evaluator.lookaheadRollouts': 0 },
    noveto: { 'evaluator.lookaheadBuyClearRatio': 0.01 },
    // 2026-08-03: railOpportunityMul — discount on the railroad SET premium
    // when the buyer already has a developable colour position (owned monopoly
    // short of hotels, or a colour one tile from completion). Default 0.55.
    // Games msb8njda (Reese) / mscksm94 (Uma, paid $290 for a 3rd rail while
    // one-away on green from the SAME opponent holding the green completer)
    // show d5 builders still over-buying rails over colour at 0.55. rail45 is
    // the reviewed rec; rail35 is a strong-dose ceiling probe (is the direction
    // even worth a full rung?).
    rail45: { 'evaluator.railOpportunityMul': 0.45 },
    rail35: { 'evaluator.railOpportunityMul': 0.35 },
    // 2026-08-25: latentLeadWeight — forward-looking _leadFactor. Adds a
    // player's about-to-complete colour sets into the "how far ahead is the
    // trade counterparty" measure, so the handover penalty (leaderMul +
    // lead-scaled mutualDamp) fires against a cash-rich near-monopolist BEFORE
    // it builds. Shared evaluator lever (all handover trades, not just brokers).
    // Motivating game mt5a09ba: broker fed green to Sage while Sage read as
    // non-leader (fractionally behind Quinn on nw); Sage built it and won.
    lead05: { 'evaluator.latentLeadWeight': 0.5 },
    lead10: { 'evaluator.latentLeadWeight': 1.0 },
    // 2026-09-18: ACQUISITION-UP dose-response (chats/2026-09-18-cpu-winning-levers-ranked.md).
    // The 2026-07 campaign closed the buy-LESS pole (buyBias-down/orphan-discount/reserves-up);
    // buy-MORE was never tested, and the two newest HEAD games lost on under-acquisition with
    // cash in hand — mu6c4jg6 (d5 bid 51/won 2) and mu4t9i9k (d4 won 0/24 auctions, idle cash).
    // L1 (bidup): raise the auction bid ceiling for the two lowest bidders (cautious 0.85,
    // builder 0.95) — value*bidBias IS the ceiling (cpu-player.js:560-562), so they lose
    // set-relevant auctions by a dollar while solvent. acqboth adds L2 builder.buyBias (the
    // idle-builder passes tiles valued at face, ms40evwf/ms0t9kwx). acqstrong is the ceiling
    // probe. Predicted hump from the closed buy-LESS deltas (2p -13.7/4p +8.1/5p -4.2): buy-more
    // should be + at 2p/5p, - at 4p (the 4p cell is the falsification check). KILL-METRIC:
    // dev% / monopolies-per-survivor must rise or hold — a win% gain with dev% flat + avgSteps
    // up is a hollow attrition win (how every buy-focus lever died).
    bidup:     { 'archetype.cautious.bidBias': 1.0,  'archetype.builder.bidBias': 1.1 },
    acqboth:   { 'archetype.cautious.bidBias': 1.0,  'archetype.builder.bidBias': 1.1,  'archetype.builder.buyBias': 1.05 },
    acqstrong: { 'archetype.cautious.bidBias': 1.15, 'archetype.builder.bidBias': 1.2,  'archetype.builder.buyBias': 1.1, 'archetype.cautious.buyBias': 1.0 },
    // Round 2 (2026-09-19): isolate the buy-side driver from acqstrong (bids are
    // inert per bidup) and gate it. buyboth = the two buy raises UNGATED (all
    // player counts); buyboth_g3 = the SAME raises via the ≥3-player-gated knob
    // (additive 0.15: cautious 0.85→1.0, builder 0.95→1.1). They are identical
    // at ≥3p (5p/4p) and diverge only heads-up — so h2h shows the gate zeroing
    // out acqstrong's −1.9/2p cost while 5p keeps the +3.4.
    buyboth:    { 'archetype.cautious.buyBias': 1.0, 'archetype.builder.buyBias': 1.1 },
    buyboth_g3: { 'evaluator.multiplayerBuyLift': 0.15 },
    // 2026-09-29: idle-cash check at HEAD. Real 5+p games (Jul 30 - Sep 18 code)
    // show builder/cautious declining deeds while flush (>= price + $300) and
    // rarely winning them back; a replay put the cause in valuation noise, not
    // the reserve. nolift = the shipped ≥3p buy-lift OFF on defaults. live =
    // the user's persisted AITuning overrides (history record.tuning, unchanged
    // since 2026-07-22) so the sim plays the config the real games use; note
    // cautious.buyBias 1 there sits at the lift gate (< 1), so live cautious
    // gets no lift. livenolift = live with the lift off. Read the `idle`
    // instrument below with ai-lab/idle_report.js.
    nolift:     { 'evaluator.multiplayerBuyLift': 0 },
    live:       LIVE,
    livenolift: { ...LIVE, 'evaluator.multiplayerBuyLift': 0 },
    // 2026-09-30 review fixes (games mud9g25d, mungupgq). base = both trade
    // correctness fixes ON (their new defaults); the old* arms revert them so
    // the A/B reads each fix's effect vs the pre-fix HEAD. entry* dose the
    // shut-out re-entry generator (default off) — 0.25 found no deal on the
    // motivating Bailey replay, 0.5 offered 1.5x for a split-group single.
    oldpair:  { 'evaluator.mutualDampMinTiles': 1 },
    oldzopa:  { 'evaluator.zopaResponderSkill': 0 },
    oldboth:  { 'evaluator.mutualDampMinTiles': 1, 'evaluator.zopaResponderSkill': 0 },
    entry05:  { 'evaluator.shutoutEntryPremium': 0.5 },
    entry10:  { 'evaluator.shutoutEntryPremium': 1.0 },
    // Round 2 (2026-09-30): attribute E42's 5p gain (oldpair / oldzopa each
    // revert one fix) and test the fuller responder model (zfull) aimed at the
    // 4-8pp accept-rate drop on offers to d1-d3 seen in round 1.
    zfull:    { 'evaluator.zopaResponderSkill': 2 },
    // E44 (2026-09-30): share of the blocker premium kept when a trade moves
    // an existing block between third parties (default 1 = full, old).
    // blockTransferScope 0 pins these to the all-partner form A/B'd in E44
    // (the knob's default scope became 1 = human partners, receiving side).
    bt50:     { 'evaluator.blockTransferShare': 0.5, 'evaluator.blockTransferScope': 0 },
    bt25:     { 'evaluator.blockTransferShare': 0.25, 'evaluator.blockTransferScope': 0 },
    // E45 (2026-09-30): d5 lookahead may not overturn a heuristic reject of an
    // offer that completes a colour set for the proposer (default 0 = off).
    hveto:    { 'evaluator.lookaheadHandoverVeto': 1 },
    bt50hv:   { 'evaluator.blockTransferShare': 0.5, 'evaluator.blockTransferScope': 0, 'evaluator.lookaheadHandoverVeto': 1 },
    // Option 1 (human-scoped): both fixes only touch trades with a human, so in
    // all-CPU sims this arm must be byte-identical to base (a scoping canary).
    human:    { 'evaluator.blockTransferShare': 0.5, 'evaluator.blockTransferScope': 1, 'evaluator.lookaheadHandoverVeto': 2 },
    // E47 (2026-10-06): liquidity penalty charges only the shortfall a trade
    // adds (default 0 = old absolute charge). E46 level 2: exact-cash pricing
    // (zx2) and post-trade-cash handover read (pc2) for EVERY partner — base
    // runs them at level 1 (human-scoped), which is inert in all-CPU sims.
    liqd:     { 'evaluator.liquidityPenaltyMode': 1 },
    zx2:      { 'evaluator.zopaExactCash': 2 },
    pc2:      { 'evaluator.exploitPostTradeCash': 2 },
    zx2pc2:   { 'evaluator.zopaExactCash': 2, 'evaluator.exploitPostTradeCash': 2 },
    // E48 (2026-10-07): mutual-completion damping lifted by the partner's
    // build-funding lead over mine (default 0 = off). Two doses.
    mdp1:     { 'evaluator.mutualDevelopParity': 1 },
    mdp2:     { 'evaluator.mutualDevelopParity': 2 },
    // 2026-10-10 (E49/E50, game mv2jir3q). nag0 reverts the rejected-counter
    // refusal ledger (E50, default on: the one change here that touches
    // CPU-only play). race4all/race8all run the E49 development-race charge
    // on EVERY partner (scope 2); the shipped form is human-only (scope 1),
    // which sims cannot exercise, so base already equals 'race off' here.
    nag0:     { 'evaluator.tradeNagFix': 0 },
    race4all: { 'evaluator.mutualDevSpeed': 4, 'evaluator.mutualDevSpeedScope': 2 },
    race8all: { 'evaluator.mutualDevSpeed': 8, 'evaluator.mutualDevSpeedScope': 2 },
    // refcap: the old E31 escalate-then-stop schedule (E50 ships exponential,
    // no hard stop). race4d5: E49 for CPU partners too, but only when the
    // deciding CPU is d5 (scope 3).
    refcap:   { 'evaluator.tradeRefusalExp': 0 },
    race4d5:  { 'evaluator.mutualDevSpeed': 4, 'evaluator.mutualDevSpeedScope': 3 },
    e50off:   { 'evaluator.tradeNagFix': 0, 'evaluator.tradeRefusalExp': 0 },   // all of E50 reverted = pre-2026-10-10 ledger
    // E51 (2026-10-17): re-test of closed directions on current code.
    //   focusall — E24's d5 focus plan (buy-less/concentrate, d5-only) at every table size, not just heads-up
    //   overbuy  — buy-less on the two OVER-buying archetypes (E22 only ever cut builder; E38 raised the under-buyers)
    //   block10  — E25 leader-denial block-bids at the original dose (18 cells, 5p only, era 4)
    focusall: { 'evaluator.d5FocusMaxPlayers': 8 },
    overbuy:  { 'archetype.aggressive.buyBias': 1.10, 'archetype.hoarder.buyBias': 1.15 },
    block10:  { 'evaluator.auctionBlockValue': 1.0 },
}[arm];
const shape = A('shape', '5p');
const SH = {
    '5p': { difficulties: [1, 2, 3, 4, 5], n: 40 },
    '4p': { difficulties: [2, 3, 4, 5], n: 40 },
    'h2h': { difficulties: [4, 5], n: 60 },
    // Big tables (2026-09-30). Difficulties REPEAT, so ladder stats are per seat
    // (fair share 1/N). Mixes follow the user's real 6-8p games: 6p tables lean
    // d4/d5 (CPU mean ~3.8), 8p tables spread wider (~3.1).
    '6p': { difficulties: [2, 3, 4, 4, 5, 5], n: 40 },
    '8p': { difficulties: [1, 2, 2, 3, 3, 4, 5, 5], n: 40 },
}[shape];
if (!TUNE || !SH || !out) { console.error('bad args'); process.exit(2); }
if (A('n')) SH.n = parseInt(A('n'), 10);   // smoke-test override

// Count how often the repair lever actually fires, per difficulty — a
// game-level wash with zero firings means something different from a wash
// with thousands (the §9 liquidity lesson: always measure the mechanism).
const t0 = Date.now();
const G = loadGame();
const CPUPlayer = G.win.CPUPlayer;
const Evaluator = G.win.Evaluator;
const fires = {};        // latent-lead exposure: _latentSetValue > 0, by player difficulty
const brokerFires = {};  // broker-line exposure: _proposeBroker returned an offer, by actor difficulty
// Mechanism instrument for the latentLeadWeight experiment. `fires` = how often
// the new latent term is NONZERO on a real state (the lever's exposure — the §1
// "measure exposure first" rule: near-zero => no-op, thousands => a real null).
// At the base arm (w=0) the harness short-circuits _latentSetValue so it is
// never called; the instrument still wraps it, so base `fires` MUST be {} — a
// nonzero base count is a bug (the short-circuit leaked).
// _latentSetValue was removed when the latentLead experiment was reverted
// (memory ab-run-latentlead-inflight); guard so this instrument is a no-op on
// HEAD instead of crashing every cell. `fires` stays {} for non-latentLead arms.
if (typeof Evaluator._latentSetValue === 'function') {
    const origLatent = Evaluator._latentSetValue.bind(Evaluator);
    Evaluator._latentSetValue = function (state, id) {
        const v = origLatent(state, id);
        if (v > 0) { const d = state.players[id].difficulty; fires[d] = (fires[d] || 0) + 1; }
        return v;
    };
}
// Broker exposure: the pathology the fix targets rides the 3-way broker, which
// is rare (~7-21/240 games). Count its firings so a win-neutral result can be
// read as "safe on the rare broker path" vs "the broker never fired here".
const origBroker = CPUPlayer._proposeBroker.bind(CPUPlayer);
CPUPlayer._proposeBroker = function (state, player, cfg) {
    const r = origBroker(state, player, cfg);
    if (r) brokerFires[player.difficulty] = (brokerFires[player.difficulty] || 0) + 1;
    return r;
};
// Shut-out re-entry exposure (2026-09-30): how often a deedless CPU on a
// sold-out board actually bids for a foothold, by actor difficulty. base/old*
// arms must read {} (generator off by default). Real decisions only — unlike
// brokerFires, which also counts lookahead rollouts (kept for comparability).
const entryFires = {};
const origEntry = CPUPlayer._proposeEntryBuy.bind(CPUPlayer);
CPUPlayer._proposeEntryBuy = function (state, player, cfg) {
    const r = origEntry(state, player, cfg);
    if (r && !(G.Lookahead && G.Lookahead._active)) entryFires[player.difficulty] = (entryFires[player.difficulty] || 0) + 1;
    return r;
};
// E51 mechanism counters (real decisions only, record-only): `block` = an
// auction ceiling raised by leader-denial block-bidding (its trace line), `focus`
// = a d5 focus reweight applied at a >2-player table. base reads {}.
const e51Fires = {};
const bumpE51 = (k, d) => { const m = e51Fires[k] = e51Fires[k] || {}; m[d] = (m[d] || 0) + 1; };
const origTraceE51 = CPUPlayer._trace.bind(CPUPlayer);
CPUPlayer._trace = function (state, text) {
    if (!(G.Lookahead && G.Lookahead._active) && text.includes(' — block-bids to deny ')) {
        const p = state.players.find(q => text.startsWith(q.name + ' — '));
        if (p) bumpE51('block', p.difficulty);
    }
    return origTraceE51(state, text);
};
const origFocus = CPUPlayer._focusMul.bind(CPUPlayer);
CPUPlayer._focusMul = function (state, player, group) {
    const r = origFocus(state, player, group);
    if (r !== 1 && !(G.Lookahead && G.Lookahead._active) && G.GameState.activePlayers(state).length > 2) bumpE51('focus', player.difficulty);
    return r;
};
// Idle-cash instrument (record-only: wraps call the originals, draw no RNG, and
// ignore Lookahead rollouts — the EventBus is muted inside them anyway). Per
// archetype: buy offers, buys, declines, FLUSH declines (cash >= price + 300),
// the CPU's own traced value on a declined deed (<= price vs above it, i.e.
// valuation vs reserve/smarts/blunder), flush declines it won back at the
// ensuing auction, and games/wins. Per archetype+difficulty too (key 'arch/dN').
const idle = {};
const bump = (k, f, v = 1) => { (idle[k] = idle[k] || {})[f] = (idle[k][f] || 0) + v; };
const EB = G.EventBus, GS = G.GameState, LA = () => G.Lookahead && G.Lookahead._active;
let lastTrace = null, pendingFlush = {}, curState = null, tallied = true;
const archOf = p => p.personality ? p.personality.archetype : '?';
const bumpBoth = (p, f, v) => { bump(archOf(p), f, v); bump(`${archOf(p)}/d${p.difficulty}`, f, v); };
const origTrace = CPUPlayer._trace.bind(CPUPlayer);
CPUPlayer._trace = function (state, text) {
    const m = !LA() && /passes on .+ \(\$(\d+)\) — values it at \$(-?\d+)/.exec(text);
    if (m) lastTrace = { price: +m[1], value: +m[2] };
    return origTrace(state, text);
};
const origBuy = CPUPlayer._buyOrAuction.bind(CPUPlayer);
CPUPlayer._buyOrAuction = function (state, player) {
    lastTrace = null;
    const cash = player.cash;
    const r = origBuy(state, player);
    if (LA() || !r || (r.type !== 'BUY_PROPERTY' && r.type !== 'DECLINE_BUY')) return r;
    const tileId = state.pendingAction.tileId, price = G.BOARD[tileId].price;
    bumpBoth(player, 'offers');
    if (r.type === 'BUY_PROPERTY') { bumpBoth(player, 'buys'); return r; }
    bumpBoth(player, 'decl');
    if (cash >= price + 300) {
        bumpBoth(player, 'flush'); bumpBoth(player, 'flushCash', cash);
        if (lastTrace) bumpBoth(player, lastTrace.value <= price ? 'flushValLE' : 'flushValGT');
        else bumpBoth(player, 'flushLookahead');   // d5 rollout pick (no pass trace)
        pendingFlush[tileId] = player;
    }
    return r;
};
EB.on('auctionEnded', ({ winnerId, tileId }) => {
    const p = pendingFlush[tileId]; if (!p) return;
    delete pendingFlush[tileId];
    if (winnerId === p.id) bumpBoth(p, 'wonBack');
});
const tally = () => {
    if (tallied || !curState) return;
    tallied = true;
    curState.players.forEach(p => { if (p.isCPU) bumpBoth(p, 'games'); });
};
EB.on('gameOver', ({ winnerId }) => {
    if (!curState) return;
    tally(); bumpBoth(curState.players[winnerId], 'wins');
});
const origCreate = GS.createGame.bind(GS);
GS.createGame = function (cfg) {
    tally();                      // a previous game that hit maxSteps still counts
    curState = origCreate(cfg); tallied = false; pendingFlush = {};
    return curState;
};
if (arm === 'deep') {   // lift the registry clamp for the ceiling probe only
    const AT = G.AITuning || G.win.AITuning;
    AT.get('evaluator.lookaheadRollouts', 8);          // force registry build
    AT._registry['evaluator.lookaheadRollouts'].max = 256;
}
// Trade-flow instrument (2026-09-30, E42 zopaResponderSkill): per RESPONDER
// difficulty, CPU proposals received and how they were answered, plus the
// cash leg (|give.cash - get.cash|) of proposals and of accepted deals. The
// fix should raise accept rates on offers to sharp CPUs and cut the cash paid
// to weak ones. Real decisions only (rollouts skipped via LA()).
const flow = {};
const fbump = (d, f, v = 1) => { const k = `d${d}`; (flow[k] = flow[k] || {})[f] = (flow[k][f] || 0) + v; };
const netCash = o => Math.abs((o.give.cash || 0) - (o.get.cash || 0));
const origPropose = CPUPlayer._maybeProposeTrade.bind(CPUPlayer);
CPUPlayer._maybeProposeTrade = function (state, player) {
    const r = origPropose(state, player);
    if (!LA() && r && r.offer) {
        const d = state.players[r.offer.to].difficulty;
        fbump(d, 'prop'); fbump(d, 'propCash', netCash(r.offer));
    }
    return r;
};
// Counter rounds (2026-09-30, E45): the totals above mix answers to OPENING
// offers with answers to counter-offers (which come from the original
// proposer), so they are also split by round — acc0/ctr0/rej0 (opening,
// counters === 0) vs accC/ctrC/rejC (a counter-offer) — each keyed by the
// difficulty of whoever answers. Chain outcome is keyed by the OPENING
// responder: deal0 = accepted as opened, dealC = accepted after >= 1 counter
// (counter k was answered by the opening responder when k is even, by the
// opening proposer when k is odd — counters alternate between the two).
const origRespond = CPUPlayer._tradeRespond.bind(CPUPlayer);
CPUPlayer._tradeRespond = function (state, player) {
    const offer = state.trade;
    const r = origRespond(state, player);
    if (!LA() && r) {
        const d = player.difficulty;
        const k = offer.counters || 0, rd = k ? 'C' : '0';
        if (r.type === 'ACCEPT_TRADE') {
            fbump(d, 'acc'); fbump(d, 'accCash', netCash(offer)); fbump(d, 'acc' + rd);
            const opener = k % 2 === 0 ? player.id : offer.from;
            fbump(state.players[opener].difficulty, k ? 'dealC' : 'deal0');
        } else if (r.type === 'COUNTER_TRADE') { fbump(d, 'ctr'); fbump(d, 'ctr' + rd); }
        else { fbump(d, 'rej'); fbump(d, 'rej' + rd); }
    }
    return r;
};
// E45 mechanism: how often the set-handover veto overturns a rollout ACCEPT.
// _completesSetFor is only reached when the veto is on and the rollout wants
// an accept the heuristic rejected, so a true return IS a veto firing.
if (typeof CPUPlayer._completesSetFor === 'function') {
    const origHandover = CPUPlayer._completesSetFor.bind(CPUPlayer);
    CPUPlayer._completesSetFor = function (state, offer, pid) {
        const v = origHandover(state, offer, pid);
        if (v && !LA()) fbump(state.players[offer.to].difficulty, 'veto');
        return v;
    };
}
const L = runLadder({ _game: G, difficulties: SH.difficulties, n: SH.n, seed,
    progress: false, tune: TUNE, ...RS });
tally();
require('fs').writeFileSync(out, JSON.stringify({ seed, shape, rules, arm, fires, brokerFires, entryFires, e51Fires, flow, idle, L }));
process.stderr.write(`[cell ${seed} ${shape} ${rules} arm=${arm}] done ${((Date.now() - t0) / 1000).toFixed(0)}s` +
    `  viol ${L.violations}  latentFires ${JSON.stringify(fires)}  brokerFires ${JSON.stringify(brokerFires)}  entryFires ${JSON.stringify(entryFires)}\n`);
