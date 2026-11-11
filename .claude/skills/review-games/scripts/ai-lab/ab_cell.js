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
    roll48: { 'evaluator.lookaheadRollouts': 48 },   // E52 wave 2: does the h2h gain keep climbing?
    // 2026-10-17 ship check: both E51 block-bids (5-6 seats) and E52 small-table rollouts OFF
    preship: { 'evaluator.auctionBlockValue': 0, 'evaluator.lookaheadSmallMaxPlayers': 0 },
    small4:  { 'evaluator.lookaheadSmallMaxPlayers': 4 },   // E52: 24 rollouts at <=4 active (4p passed wave 1)
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
    // the user's persisted AITuning overrides (history record.tuning,
    // 2026-07-22 .. 2026-10-27 12:30; real games since 2026-10-27 20:42 run the
    // defaults, see E40's 2026-11-02 update) so the sim played the config the
    // real games used then; note
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
    hof1:     { 'evaluator.handoverLandingWeight': 1 },   // E76: set-handover penalty x (landing freq / avg)^1
    hof2:     { 'evaluator.handoverLandingWeight': 2 },   // E76: ^2
    hof1d5:   { 'evaluator.handoverLandingWeight': 1, 'evaluator.handoverLandingWeightMinDifficulty': 5 },  // E76 narrow round 1: d5 only
    race1:    { 'evaluator.mutualDevSpeedScope': 1 },  // E49 shipped scope 3 / <=5 active 2026-11-07; this arm = the old human-only scope
    race5d5:  { 'evaluator.mutualDevSpeed': 4, 'evaluator.mutualDevSpeedScope': 3, 'evaluator.mutualDevSpeedD5MaxActive': 5 }, // E49 retest 2026-11-06: scope 3 only while <= 5 active
    e50off:   { 'evaluator.tradeNagFix': 0, 'evaluator.tradeRefusalExp': 0 },   // all of E50 reverted = pre-2026-10-10 ledger
    // E51 (2026-10-17): re-test of closed directions on current code.
    //   focusall — E24's d5 focus plan (buy-less/concentrate, d5-only) at every table size, not just heads-up
    //   overbuy  — buy-less on the two OVER-buying archetypes (E22 only ever cut builder; E38 raised the under-buyers)
    //   block10  — E25 leader-denial block-bids at the original dose (18 cells, 5p only, era 4)
    focusall: { 'evaluator.d5FocusMaxPlayers': 8 },
    overbuy:  { 'archetype.aggressive.buyBias': 1.10, 'archetype.hoarder.buyBias': 1.15 },
    overbuy2: { 'archetype.aggressive.buyBias': 0.95, 'archetype.hoarder.buyBias': 1.00 },   // E51 wave 2: two rungs
    block10:  { 'evaluator.auctionBlockValue': 1.0 },
    // E53 (2026-10-17): big-table check of era-5 trade levers only ever A/B'd at 4p/5p/h2h
    // (phone-era shapes). Each arm reverts one lever: broker off, one proposal per turn.
    nobroker: { 'evaluator.brokerMinDifficulty': 0 },
    oneprop:  { 'evaluator.cpuMaxProposalsPerTurn': 1 },
    // E54: seat a different clone version in the 'T' seat (_clone is stripped from the tuning)
    cloneb:   { _clone: 'T@2026-10-17b' },
    clonec:   { _clone: 'T@2026-10-17c' },
    cloned:   { _clone: 'T@2026-10-17d' },          // c recalibrated to T's buy/build/proposal rates
    clonedswaps: { _clone: 'T@2026-10-17d+swaps' }, // + mutual set swaps at T's win-game selectivity
    clonedasks:  { _clone: 'T@2026-10-17d+asks' },  // + win-game openings (own-set focus, wide asks)
    cloneddeeds: { _clone: 'T@2026-10-17d+deeds' }, // + always takes completing/blocking deeds, early auctions 1.09x
    clonew:   { _clone: 'T@2026-10-17w' },          // fitted on T's wins only
    clonedwval:   { _clone: 'T@2026-10-17d+wval' },   // d + w's buy/auction valuation
    clonedwbuild: { _clone: 'T@2026-10-17d+wbuild' }, // d + w's building
    clonedwtrade: { _clone: 'T@2026-10-17d+wtrade' }, // d + w's trade answers/offers
    // E54 human-rule re-test at t4p (clone seat = humanProxy): each removes ONE shipped
    // human-only rule; CPU-to-CPU play is unchanged in every arm
    hrrace0:  { 'evaluator.mutualDevSpeed': 0 },         // E49 off
    hrzopa3:  { 'evaluator.zopaExactCash': 3 },          // E46: human gets the CPU partners' solved zone
    hrveto0:  { 'evaluator.lookaheadHandoverVeto': 0 },  // E45 off
    hrpost0:  { 'evaluator.exploitPostTradeCash': 0 },   // E46 post-trade cash off
    hrliq0:   { 'evaluator.liquidityPenaltyMode': 0 },   // E47 off (CPU partners already 0 under mode 2)
    hrblock0: { 'evaluator.blockTransferShare': 1 },     // E44 off
    // E55: offers to a human that fell back to the linear zone must clear the CPU's own margin
    selfchk:  { 'evaluator.zopaSelfCheck': 1 },
    // E56: cede-one-set swap (give my one-away set B to the holder of my set A's last tile), by min difficulty
    cede3:    { 'evaluator.cedeSwapMinDifficulty': 3 },
    cede4:    { 'evaluator.cedeSwapMinDifficulty': 4 },
    cede5:    { 'evaluator.cedeSwapMinDifficulty': 5 },
    cede5s20: { 'evaluator.cedeSwapMinDifficulty': 5, 'evaluator.cedeStrandedTurns': 20 },   // E58 companion
    cede5m5:  { 'evaluator.cedeSwapMinDifficulty': 5, 'evaluator.multiSwapMinDifficulty': 5 },   // E57 #3 on top of cede5
    noclonedeals: { 'evaluator.cloneSetDeals': 0 },   // E54: clone keeps the d4 gate (no cede / multi openings)
    pkgs4:    { 'evaluator.packageSchemedMinDifficulty': 4 },   // E60: Package may pay with weaker near-set pieces, d4+
    pkgs5:    { 'evaluator.packageSchemedMinDifficulty': 5 },
    shapemix: { 'evaluator.cloneShapeMix': 1 },      // E54 steps 2b + 2: clone draws the deal shape from T's mix, asks zone-less
    // E62: lower build floor (build reserve only)
    bf75:     { 'evaluator.buildFloorScale': 0.75 },
    bf50:     { 'evaluator.buildFloorScale': 0.5 },
    gl35:     { 'evaluator.greenLightFloorMul': 0.35 },
    bf75d5:   { 'evaluator.buildFloorScale': 0.75, 'evaluator.buildFloorMinDifficulty': 5 },   // E62 wave 2: d5 only
    bf50d5:   { 'evaluator.buildFloorScale': 0.5, 'evaluator.buildFloorMinDifficulty': 5 },
    oldsteps: { 'evaluator.auctionHumanSteps': 0 },   // E66: the pre-E66 +10/+25/+50 auction ladder
    humansteps: { 'evaluator.auctionHumanSteps': 1 },  // E66: the pre-mixed default (fixed human steps by bid level)
    headroom: { 'evaluator.auctionHumanSteps': 2 },   // E66 follow-up: +50 only with >= $100 headroom, then +10/+1
    mixsteps: { 'evaluator.auctionHumanSteps': 3 },   // E66 follow-up: random step among those that fit (45/45/10)
    mixsteps2: { 'evaluator.auctionHumanSteps': 4 },  // E66 follow-up: mixed + per-auction weights + 50% pass when only +1 fits
    mixpers:   { 'evaluator.auctionHumanSteps': 5 },  // E66 follow-up: mixsteps2 with the draw centred on the personality
    oahh1:     { 'evaluator.oneAwayHumanHolder': 1 },  // E68: no one-away prospect credit when a human holds the last tile
    oahh2:     { 'evaluator.oneAwayHumanHolder': 2 },  // E68: also the advancing tile at 1.0x, not 1.4x
    oldbuy: { 'evaluator.stretchCommit': 0, 'evaluator.lookaheadSetBuyVeto': 1, 'evaluator.auctionSetBluff': 1 },   // E67: re-decide mid-stretch, rollout may veto / bluff-cap may fold a set completer
    nocommit: { 'evaluator.stretchCommit': 0 },          // E67 split: follow-through off only
    stl0:     { 'evaluator.stretchTargetLast': 0 },    // E71: old stretch order (target-set deeds not held back)
    setbluff: { 'evaluator.auctionSetBluff': 1 },        // E67 split: bluff cap back on own set completer
    defer0:   { 'evaluator.deferBuildToTurnEnd': 0 },  // E72: old timing (build before a pending doubles re-roll)
    defer2:   { 'evaluator.deferBuildToTurnEnd': 2 },  // E72: also skip the turn-start pre-roll (all management after the roll)
    tcg125:   { 'evaluator.tradeCompletionGainMul': 1.25 },  // E74: own trade-completion premium x1.25 (+ 3-deed Package)
    tcg15:    { 'evaluator.tradeCompletionGainMul': 1.5 },   // E74: x1.5
    tcg2:     { 'evaluator.tradeCompletionGainMul': 2 },     // E74: x2 (the level that prices T's t73 package)
    // E75: why E74 lost (premium cash keeps weak sellers alive). d5-only control, + rollout check, + lifeline charge
    tcg2d5:   { 'evaluator.tradeCompletionGainMul': 2, 'evaluator.tradeCompletionGainMinDifficulty': 5 },
    tcg2la:   { 'evaluator.tradeCompletionGainMul': 2, 'evaluator.tradeCompletionGainMinDifficulty': 5, 'evaluator.tradeCompletionGainLookahead': 1 },
    tcg0:     { 'evaluator.tradeCompletionGainMul': 1 },     // E75 shipped default-on; this arm = premium pass off (pre-E75 behaviour)
    tcg2lc:   { 'evaluator.tradeCompletionGainMul': 2, 'evaluator.tradeCompletionGainMinDifficulty': 5, 'evaluator.tradeCompletionGainLookahead': 1, 'evaluator.tradeCompletionGainHumanCooldown': 15 }, // + 15-turn cooldown after a human refuses
    tcg2fw:   { 'evaluator.tradeCompletionGainMul': 2, 'evaluator.weakSellerFuel': 0.25 },
    fuelw:    { 'evaluator.weakSellerFuel': 0.25 },
    // E77: d5 premium at 7-8 active (E75 tested to 6p): no premium pass above 6 active / only on a decisive rollout
    tcgmax6:  { 'evaluator.tradeCompletionGainMaxActive': 6 },
    tcgdec:   { 'evaluator.tradeCompletionGainLookahead': 2 },
    // E79: drop a d5 premium offer that leaves under k houses per tile of the set it completes
    fund1:    { 'evaluator.tradeCompletionGainFundHouses': 1 },
    fund2:    { 'evaluator.tradeCompletionGainFundHouses': 2 },
    sbf1:     { 'evaluator.starvedBuildFund': 1 },
    sbf2:     { 'evaluator.starvedBuildFund': 2 },
    sbf2d5:   { 'evaluator.starvedBuildFund': 2, 'evaluator.starvedBuildFundMinDifficulty': 5 },
    sbfoff:   { 'evaluator.starvedBuildFund': 0 },   // E80 old behaviour (shipped default: 2, d5 only)
    sbf2d5a5: { 'evaluator.starvedBuildFund': 2, 'evaluator.starvedBuildFundMinDifficulty': 5, 'evaluator.starvedBuildFundMinActive': 5 },
    // E82: thin-seat entry premium (d3+, at most one colour deed, cash >= 2x floor), k x list price
    thin25:   { 'evaluator.thinSeatPremium': 0.25 },
    thin50:   { 'evaluator.thinSeatPremium': 0.5 },
    thin50d5: { 'evaluator.thinSeatPremium': 0.5, 'evaluator.thinSeatMinSkill': 1 },
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
    // E54: the fitted T-clone at the user's most common table (4 seats: T + 3 CPUs)
    't4p': { difficulties: ['T', 3, 4, 5], n: 40 },
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
// = a d5 focus reweight applied at a >2-player table, `blockTarget` = the
// difficulty of the leader whose set a block-bid denied. base reads {}.
// E56 cede-swap mechanism (real decisions only), keyed by proposer difficulty:
// prop = generator fired, acc/ctr/rej = how the opening offer was answered,
// strand = proposals priced with the E58 stranded discount.
// Base arms must read {} (generator off by default).
const cedeFires = {};
const cedeKeys = new Map();
const cbump = (d, f) => { const m = cedeFires['d' + d] = cedeFires['d' + d] || {}; m[f] = (m[f] || 0) + 1; };
if (typeof CPUPlayer._proposeCedeSwap === 'function') {
    const origCede = CPUPlayer._proposeCedeSwap.bind(CPUPlayer);
    CPUPlayer._proposeCedeSwap = function (state, player, cfg) {
        const r = origCede(state, player, cfg);
        if (r && !(G.Lookahead && G.Lookahead._active)) {
            cbump(player.difficulty, 'prop');
            if (r._cede && r._cede.strand) cbump(player.difficulty, 'strand');   // E58: priced with the stranded discount
            cedeKeys.set(`${state.turnNumber}:${r.from}:${r.to}:${r.get.properties.join(',')}`, { d: player.difficulty, pre: '' });
        }
        return r;
    };
}
// E57 #3 multi-swap: same counters with an 'm' prefix (mprop / macc / mctr / mrej)
if (typeof CPUPlayer._proposeMultiSwap === 'function') {
    const origMulti = CPUPlayer._proposeMultiSwap.bind(CPUPlayer);
    CPUPlayer._proposeMultiSwap = function (state, player, cfg) {
        const r = origMulti(state, player, cfg);
        if (r && !(G.Lookahead && G.Lookahead._active)) {
            cbump(player.difficulty, 'mprop');
            cedeKeys.set(`${state.turnNumber}:${r.from}:${r.to}:${r.get.properties.join(',')}`, { d: player.difficulty, pre: 'm' });
        }
        return r;
    };
}
// E79: premium offers dropped by the funding check (efund; real decisions only, not rollouts)
if (typeof CPUPlayer._e74Unfunded === 'function') {
    const origUnf = CPUPlayer._e74Unfunded.bind(CPUPlayer);
    CPUPlayer._e74Unfunded = function (state, player, offer) {
        const r = origUnf(state, player, offer);
        if (r && !(G.Lookahead && G.Lookahead._active)) cbump(player.difficulty, 'efund');
        return r;
    };
}
// E80: stretch-build mortgages only the knob allowed (esbf), and houses those players then build in the
// same turn (esbfb, approximate: any BUILD_HOUSE decision after an esbf mortgage that turn). Real decisions only.
if (typeof CPUPlayer._e80FundTile === 'function') {
    const origFund = CPUPlayer._e80FundTile.bind(CPUPlayer);
    const fundedTurn = new Map();
    CPUPlayer._e80FundTile = function (state, player, floor) {
        const r = origFund(state, player, floor);
        if (r != null && !(G.Lookahead && G.Lookahead._active)) {
            cbump(player.difficulty, 'esbf');
            fundedTurn.set(player.id, state.turnNumber);
        }
        return r;
    };
    const origMgmt = CPUPlayer._bestManagement.bind(CPUPlayer);
    CPUPlayer._bestManagement = function (state, player) {
        const r = origMgmt(state, player);
        if (r && r.type === 'BUILD_HOUSE' && !(G.Lookahead && G.Lookahead._active) &&
            fundedTurn.get(player.id) === state.turnNumber) cbump(player.difficulty, 'esbfb');
        return r;
    };
}
// E82 thin-seat premium (real decisions only, keyed by difficulty, in cedeFires): tq = decisions priced
// with the premium (bank buy or auction bid), tbuy = bank buys made with it, tbid = auction bids placed
// with it, tauc = auctions then won by a seat that bid with it, tprop / tacc / tctr / trej = offers it
// shaped (BuyToward with the premium, EntryBuy from a one-deed seat) and how they were answered.
// Base arms must read no t* keys.
if (typeof CPUPlayer._thinPremium === 'function') {
    const LAx = () => !!(G.Lookahead && G.Lookahead._active);
    let thinHit = null;
    const origThin = CPUPlayer._thinPremium.bind(CPUPlayer);
    CPUPlayer._thinPremium = function (state, player, tileId) {
        const v = origThin(state, player, tileId);
        if (v > 0 && !LAx()) { cbump(player.difficulty, 'tq'); thinHit = { pid: player.id, tileId }; }
        return v;
    };
    const origBuy = CPUPlayer._buyOrAuction.bind(CPUPlayer);
    CPUPlayer._buyOrAuction = function (state, player) {
        thinHit = null;
        const r = origBuy(state, player);
        if (r && r.type === 'BUY_PROPERTY' && thinHit && thinHit.pid === player.id && !LAx()) cbump(player.difficulty, 'tbuy');
        return r;
    };
    const thinBidders = new Map();   // tileId -> Set of player ids that bid with the premium this auction
    const origBid = CPUPlayer._auctionBid.bind(CPUPlayer);
    CPUPlayer._auctionBid = function (state, player) {
        thinHit = null;
        const r = origBid(state, player);
        if (r && r.type === 'AUCTION_BID' && thinHit && thinHit.pid === player.id && !LAx()) {
            cbump(player.difficulty, 'tbid');
            const s = thinBidders.get(state.auction.tileId) || new Set();
            s.add(player.id); thinBidders.set(state.auction.tileId, s);
        }
        return r;
    };
    const Auc = G.win.Auction;
    const origFinish = Auc._finish.bind(Auc);
    Auc._finish = function (state) {
        const a = state.auction;
        const tileId = a && a.tileId, w = a && a.currentWinner;
        const r = origFinish(state);
        if (!LAx() && tileId != null) {
            const s = thinBidders.get(tileId);
            if (s && w != null && s.has(w)) cbump(state.players[w].difficulty, 'tauc');
            thinBidders.delete(tileId);
        }
        return r;
    };
    const origMaybeT = CPUPlayer._maybeProposeTrade.bind(CPUPlayer);
    CPUPlayer._maybeProposeTrade = function (state, player) {
        const r = origMaybeT(state, player);
        const o = r && r.offer;
        if (o && o._thin && !LAx()) {
            cbump(player.difficulty, 'tprop');
            cedeKeys.set(`${state.turnNumber}:${o.from}:${o.to}:${o.get.properties.join(',')}`, { d: player.difficulty, pre: 't' });
        }
        return r;
    };
}
// E74 last-resort premium offers: same counters with an 'e' prefix (eprop / eacc / ectr / erej), plus
// ehum = offers to a human or clone seat and e3 = bundles of 3 deeds. A falling eacc share = junk offers.
{
    const origMaybe = CPUPlayer._maybeProposeTrade.bind(CPUPlayer);
    CPUPlayer._maybeProposeTrade = function (state, player) {
        const r = origMaybe(state, player);
        const o = r && r.offer;
        if (o && o._e74 && !(G.Lookahead && G.Lookahead._active)) {
            cbump(player.difficulty, 'eprop');
            const to = state.players[o.to];
            if (to && (!to.isCPU || to.humanProxy || to.cloneSeat)) cbump(player.difficulty, 'ehum');
            if (o._e74.deeds >= 3) cbump(player.difficulty, 'e3');
            // E77: premium offers sent with 7+ active (eprop7; answers e7acc / e7ctr / e7rej)
            const big = G.GameState.activePlayers(state).length >= 7;
            if (big) cbump(player.difficulty, 'eprop7');
            cedeKeys.set(`${state.turnNumber}:${o.from}:${o.to}:${o.get.properties.join(',')}`, { d: player.difficulty, pre: 'e', big });
        }
        return r;
    };
}
// E75 human cooldown: premium offers to a human/clone dropped because it refused one recently (ecool).
if (typeof CPUPlayer._e74HumanCooling === 'function') {
    const origCool = CPUPlayer._e74HumanCooling.bind(CPUPlayer);
    CPUPlayer._e74HumanCooling = function (state, player, offer) {
        const r = origCool(state, player, offer);
        if (r && !(G.Lookahead && G.Lookahead._active)) cbump(player.difficulty, 'ecool');
        return r;
    };
}
// E75: E74 offers put to the rollout check (ela) and held back by it (eheld), real decisions only.
if (G.Lookahead && G.Lookahead.choose) {
    const origChoose = G.Lookahead.choose.bind(G.Lookahead);
    G.Lookahead.choose = function (state, pid, decisions) {
        const pick = origChoose(state, pid, decisions);
        const d0 = decisions && decisions[0];
        if (d0 && d0.type === 'PROPOSE_TRADE' && d0.offer && d0.offer._e74 && !G.Lookahead._active) {
            const p = state.players[pid];
            cbump(p.difficulty, 'ela');
            if (pick && pick.type !== 'PROPOSE_TRADE') cbump(p.difficulty, 'eheld');
            // E77: undecided rollouts on a premium offer (enull; enull7 with 7+ active). At level 2 these are held back.
            if (!pick) {
                cbump(p.difficulty, 'enull');
                if (G.GameState.activePlayers(state).length >= 7) cbump(p.difficulty, 'enull7');
            }
        }
        return pick;
    };
}
// E71 exposure (real decisions only, keyed by difficulty): a stretch MORTGAGE toward buying/bidding on a
// tile that completes the CPU's set. `stretch` = such episodes; `diff` = the old order (stretchTargetLast 0)
// would have mortgaged a deed of the target set first while the decision mortgaged something else (the
// E71 change acting); `target` = a target-set deed was mortgaged (no outside deed left, or arm stl0).
// One count per (turn, player, tile) episode.
const e71Fires = {};
const e71Seen = new Set();
const e71Wrap = (fn, tileOf) => {
    if (typeof CPUPlayer[fn] !== 'function') return;
    const orig = CPUPlayer[fn].bind(CPUPlayer);
    CPUPlayer[fn] = function (state, player, ...rest) {
        const r = orig(state, player, ...rest);
        if (!r || r.type !== 'MORTGAGE' || (G.Lookahead && G.Lookahead._active)) return r;
        const tid = tileOf(state);
        const t = tid != null ? G.BOARD[tid] : null;
        if (!t || t.type !== 'property' || !t.group) return r;
        const ids = G.Rules.tilesInGroup(t.group);
        if (ids.filter(id => G.Rules.getOwner(state, id) === player.id).length !== ids.length - 1) return r;
        const key = `${state.turnNumber}:${player.id}:${tid}`;
        const m = e71Fires['d' + player.difficulty] = e71Fires['d' + player.difficulty] || {};
        if (!e71Seen.has(key)) { e71Seen.add(key); m.stretch = (m.stretch || 0) + 1; }
        const old = CPUPlayer._stretchEquity(state, player).tiles[0];
        if (G.BOARD[r.tileId].group === t.group) m.target = (m.target || 0) + 1;
        else if (old != null && G.BOARD[old].group === t.group) m.diff = (m.diff || 0) + 1;
        return r;
    };
};
e71Wrap('_buyOrAuction', state => state.pendingAction && state.pendingAction.tileId);
e71Wrap('_auctionBid', state => state.auction && state.auction.tileId);
e71Wrap('_cloneAuctionBid', state => state.auction && state.auction.tileId);
// E76: set handovers that actually happened (a CPU gave a partner the last tile of a colour set), by group
// (`ho`, plus `hoHum` toward a human/clone seat), and handover penalties priced with weight != 1 on real
// decisions (`w`). Hooks the pristine Trading.apply that sim_harness wraps (G._origApply), so its own
// trade metrics still see every trade.
const e76Fires = {};
const e76b = (k, g) => { const m = e76Fires[k] = e76Fires[k] || {}; m[g] = (m[g] || 0) + 1; };
{
    const T = G.win.Trading, R = G.win.Rules;
    const pristine = G._origApply || T.apply.bind(T);
    const fullOwner = (state, g) => { const ids = R.tilesInGroup(g); const o = R.getOwner(state, ids[0]);
        return o != null && ids.every(id => R.getOwner(state, id) === o) ? o : null; };
    G._origApply = function (state, offer) {
        if (G.Lookahead && G.Lookahead._active) return pristine(state, offer);
        const moved = [...offer.give.properties.map(id => [id, offer.from]), ...offer.get.properties.map(id => [id, offer.to])];
        const groups = new Set(moved.map(([id]) => G.BOARD[id].group).filter(g => g && g !== 'railroad' && g !== 'utility'));
        const before = {}; groups.forEach(g => { before[g] = fullOwner(state, g); });
        const r = pristine(state, offer);
        groups.forEach(g => {
            const o = fullOwner(state, g);
            if (o == null || before[g] === o) return;
            const giver = moved.find(([id, from]) => G.BOARD[id].group === g && from !== o);
            const gp = giver && state.players[giver[1]], op = state.players[o];
            if (!gp || !gp.isCPU) return;
            e76b('ho', g);
            if (op && (!op.isCPU || op.humanProxy)) e76b('hoHum', g);
        });
        return r;
    };
    const origW = Evaluator._handoverWeight.bind(Evaluator);
    Evaluator._handoverWeight = function (group, state, forPlayerId) {
        const w = origW(group, state, forPlayerId);
        if (w !== 1 && !(G.Lookahead && G.Lookahead._active)) e76b('w', group);
        return w;
    };
}
const e51Fires = {};
const bumpE51 = (k, d) => { const m = e51Fires[k] = e51Fires[k] || {}; m[d] = (m[d] || 0) + 1; };
const origTraceE51 = CPUPlayer._trace.bind(CPUPlayer);
CPUPlayer._trace = function (state, text) {
    if (!(G.Lookahead && G.Lookahead._active) && text.includes(' — block-bids to deny ')) {
        const p = state.players.find(q => text.startsWith(q.name + ' — '));
        if (p) bumpE51('block', p.difficulty);
        // E51 wave 4: whose set was denied (by difficulty) — is d5 the blocker or the target?
        const t = state.players.find(q => text.includes(' to deny ' + q.name + ' (leading)'));
        if (t) bumpE51('blockTarget', t.difficulty);
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
// Lift the registry clamp for any arm that probes past it (deep 96, roll48).
// Was gated on arm === 'deep' alone, so E52 wave 2's roll48 silently ran at 24
// and came out byte-identical to roll24.
if ((TUNE['evaluator.lookaheadRollouts'] || 0) > 24) {
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
    if (!LA() && r && !(offer.counters || 0)) {
        const ck = `${state.turnNumber}:${offer.from}:${offer.to}:${(offer.get.properties || []).join(',')}`;
        if (cedeKeys.has(ck)) {
            const ck0 = cedeKeys.get(ck);
            cbump(ck0.d, ck0.pre + (r.type === 'ACCEPT_TRADE' ? 'acc' : r.type === 'COUNTER_TRADE' ? 'ctr' : 'rej'));
            if (ck0.big) cbump(ck0.d, 'e7' + (r.type === 'ACCEPT_TRADE' ? 'acc' : r.type === 'COUNTER_TRADE' ? 'ctr' : 'rej'));
            cedeKeys.delete(ck);
        }
    }
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
// E54 clone behaviour, to validate against the human's real rates (fit_human.js):
// buys of affordable landings, auctions contested, build-possible turns built
// on, proposals per own turn, and trade answers both ways (offers to the clone
// it accepts/counters; its own offers a CPU accepts/counters). Rollouts excluded.
const clone = { buyAfford: 0, bought: 0, auctions: 0, engaged: 0, turns: 0, buildable: 0, builtTurns: 0, proposals: 0,
    offersIn: 0, acceptedIn: 0, counteredIn: 0, offersOut: 0, acceptedOut: 0, counteredOut: 0 };
{
    const C = G.win.CPUPlayer, R = G.win.Rules, isT = p => p && p.statKey === 'T';
    let builtNow = null;
    const oBuy = C._buyOrAuction.bind(C);
    C._buyOrAuction = function (state, player) {
        const r = oBuy(state, player);
        if (isT(player) && !LA() && player.cash >= G.BOARD[state.pendingAction.tileId].price) {
            if (r.type === 'BUY_PROPERTY') { clone.buyAfford++; clone.bought++; } else if (r.type === 'DECLINE_BUY') clone.buyAfford++;
        }
        return r;
    };
    const oAuc = C._cloneAuctionBid.bind(C);
    C._cloneAuctionBid = function (state, player, w) {
        const fresh = !(state.auction.clone && state.auction.clone[player.id]);
        const r = oAuc(state, player, w);
        if (fresh && isT(player) && !LA() && player.cash >= G.BOARD[state.auction.tileId].price) {
            clone.auctions++; if (state.auction.clone[player.id].engage) clone.engaged++;
        }
        return r;
    };
    const oFloor = C._cloneBuildFloor.bind(C);
    C._cloneBuildFloor = function (state, player, w) {
        const fresh = !(player.cloneBuild && player.cloneBuild.turn === state.turnNumber);
        if (fresh && isT(player) && !LA()) {
            clone.turns++;
            const legal = G.GameState.propertiesOf(state, player.id).some(id => R.canBuildHouse(state, player.id, id).ok);
            if (legal) { clone.buildable++; builtNow = { turn: state.turnNumber, id: player.id, done: false }; } else builtNow = null;
        }
        return oFloor(state, player, w);
    };
    const oHouse = G.win.PropertyActions.buildHouse.bind(G.win.PropertyActions);
    G.win.PropertyActions.buildHouse = function (state, playerId, tileId) {
        const r = oHouse(state, playerId, tileId);
        if (!LA() && builtNow && !builtNow.done && builtNow.id === playerId && builtNow.turn === state.turnNumber) { builtNow.done = true; clone.builtTurns++; }
        return r;
    };
    const oResp = C._tradeRespond.bind(C);
    C._tradeRespond = function (state, player) {
        const r = oResp(state, player);
        if (!LA() && state.trade) {
            const inbound = isT(player), outbound = !isT(player) && isT(state.players[state.trade.from]);
            if (inbound || outbound) {
                const dir = inbound ? 'In' : 'Out';
                clone['offers' + dir]++;
                if (r.type === 'ACCEPT_TRADE') clone['accepted' + dir]++;
                else if (r.type === 'COUNTER_TRADE') clone['countered' + dir]++;
            }
        }
        return r;
    };
    // Opportunity (E54, matches clone_opportunity.js on T's games): on the clone's first proposal
    // check of a turn, is a cede / multi (multiAvail) or only a 1-for-1 set swap (swapOnly) available?
    // The probe restores rngState and the snub ledger, so it never changes the game. Per class:
    // opp_<cls> turns, opp_<cls>_mutual / _multi = turns the clone opened that shape.
    const oppTurn = {};
    const oProp = C._maybeProposeTrade.bind(C);
    C._maybeProposeTrade = function (state, player) {
        if (isT(player) && !LA() && (!oppTurn[player.id] || oppTurn[player.id].turn !== state.turnNumber)) {
            const rng = state.rngState, snubs = JSON.stringify(player.tradeSnubs || {});
            const cfg = C._tradeConfig(), has = g => { try { return !!C['_propose' + g](state, player, cfg); } catch (e) { return false; } };
            const cls = has('CedeSwap') || has('MultiSwap') ? 'multiAvail' : has('SetSwap') ? 'swapOnly' : 'none';
            state.rngState = rng; player.tradeSnubs = JSON.parse(snubs);
            oppTurn[player.id] = { turn: state.turnNumber, cls, mutual: false, multi: false };
            clone['opp_' + cls] = (clone['opp_' + cls] || 0) + 1;
        }
        const r = oProp(state, player);
        if (r && isT(player) && !LA()) {
            clone.proposals++;
            // Opening shape, classified like fit_human's openingShape() so the mix compares with T's
            const o = r.offer, me = C._completesSetFor(state, o, player.id), them = C._completesSetFor(state, o, o.to);
            const offers = o.give.properties.length, asks = o.get.properties.length;
            const k = me && them ? (offers + asks >= 3 ? 'multi' : 'swap') : offers === 0 ? (me ? 'buyComplete' : 'buy')
                : asks === 0 ? 'sell' : me ? 'tradeComplete' : 'trade';
            clone['shp_' + k] = (clone['shp_' + k] || 0) + 1;
            if (o._ask) clone.shp_ask = (clone.shp_ask || 0) + 1;
            const ot = oppTurn[player.id];
            if (ot && ot.turn === state.turnNumber) {
                if ((k === 'multi' || k === 'swap') && !ot.mutual) { ot.mutual = true; clone[`opp_${ot.cls}_mutual`] = (clone[`opp_${ot.cls}_mutual`] || 0) + 1; }
                if (k === 'multi' && !ot.multi) { ot.multi = true; clone[`opp_${ot.cls}_multi`] = (clone[`opp_${ot.cls}_multi`] || 0) + 1; }
            }
        }
        return r;
    };
}
// Per-game outcome recorder (2026-11-07, record-only). One compact record per
// game, every seat, so loss shapes can be mined per difficulty (d5 losses vs how
// the others win and lose). Reads state at events that already fire (the
// EventBus is muted inside Lookahead rollouts), draws no RNG and changes no
// decision, so every arm plays byte-identically with or without it. Fields
// (read with ai-lab/games_report.js):
//   game: s seed, t last turn, end 'over'|'cap' (maxSteps), w winner seat index|null
//   seat: k key (difficulty or 'T'), a archetype, r 'W' won | 'B' bankrupt | 'S' alive, not won,
//         o turn out, by creditor seat index (-1 = bank),
//         sets [[group, turn, how]] each colour set the seat came to own outright
//           (how: t trade | b buy | a auction | k bankruptcy transfer),
//         gave [[group, turn, toSeat]] trades by this seat that completed a partner's set,
//         b1 first turn with a house, pk [peak net worth, turn], r150 net-worth rank at turn 150
//         (1 = leader, 0 = out by then), rp / rr rent paid / received, dr seat that took most of its rent.
const gameRecs = [];
let rec = null, recState = null, recCause = null, recTurn = -1;
const COLOUR_GROUPS = [...new Set(G.BOARD.filter(t => t.type === 'property').map(t => t.group))];
const R = G.win.Rules;
const COLOUR_TILES = G.BOARD.filter(t => t.type === 'property').map(t => t.id);
const seatOfName = name => { const m = /#(\d+)$/.exec(name || ''); return m ? +m[1] : -1; };
const fullOwner = (state, g) => {
    const ids = R.tilesInGroup(g), o = R.getOwner(state, ids[0]);
    return o !== null && ids.every(id => R.getOwner(state, id) === o) ? o : null;
};
const recFinish = () => {
    if (!rec) return;
    const s = recState;
    rec.t = s.turnNumber;
    if (rec.end !== 'over') rec.end = 'cap';
    s.players.forEach((p, i) => {
        const q = rec.p[i]; q.k = p.statKey || p.difficulty; q.a = archOf(p);
        if (q.r !== 'B') q.r = s.winner === p.id ? 'W' : 'S';
    });
    rec.p.forEach(q => {
        const top = Object.entries(q._drain).sort((x, y) => y[1] - x[1])[0];
        q.dr = top ? +top[0] : -1; delete q._drain;
        if (q.pk[0] === -Infinity) q.pk = [null, 0];
        if (q.r150 === undefined) q.r150 = q.r === 'B' ? 0 : null;
    });
    gameRecs.push(rec); rec = null;
};
const recScan = (state) => {
    if (!rec || state !== recState) return;
    const turn = state.turnNumber;
    COLOUR_GROUPS.forEach(g => {
        const o = fullOwner(state, g), prev = rec._full[g];
        if (o === prev) return;
        rec._full[g] = o;
        if (o !== null) rec.p[o].sets.push([g, turn, recCause ? recCause.how : '?']);
    });
    COLOUR_TILES.forEach(id => {
        if (R.houseCount(state, id) < 1) return;
        const q = rec.p[R.getOwner(state, id)];
        if (q && q.b1 === undefined) q.b1 = turn;
    });
    if (turn !== recTurn) {
        recTurn = turn;
        const nw = state.players.map(p => p.bankrupt ? -Infinity : R.netWorth(state, p.id));
        nw.forEach((v, i) => { const q = rec.p[i]; if (v > q.pk[0]) q.pk = [v, turn]; });
        if (turn >= 150 && !rec._r150) {
            rec._r150 = true;
            const order = nw.map((v, i) => [v, i]).filter(x => x[0] > -Infinity).sort((a, b) => b[0] - a[0]);
            rec.p.forEach((q, i) => { const k = order.findIndex(x => x[1] === i); q.r150 = k < 0 ? 0 : k + 1; });
        }
    }
    recCause = null;
};
const origCreateRec = GS.createGame.bind(GS);
GS.createGame = function (cfg) {
    recFinish();
    const st = origCreateRec(cfg);
    recState = st; recCause = null; recTurn = -1;
    rec = { s: cfg.seed, t: 0, end: null, w: null, _full: {}, _r150: false,
        p: st.players.map(() => ({ k: null, a: null, r: null, sets: [], gave: [], pk: [-Infinity, 0], rp: 0, rr: 0, _drain: {} })) };
    COLOUR_GROUPS.forEach(g => { rec._full[g] = null; });
    return st;
};
EB.on('propertyPurchased', ({ tileId }) => { recCause = { how: 'b', g: G.BOARD[tileId].group }; });
EB.on('auctionEnded', ({ tileId }) => { recCause = { how: 'a', g: G.BOARD[tileId] && G.BOARD[tileId].group }; });
EB.on('tradeCompleted', ({ offer }) => {
    if (!rec) return;
    recCause = { how: 't', g: null };
    // Which colour sets did this trade complete, and for whom? (a set newly owned outright)
    COLOUR_GROUPS.forEach(g => {
        const o = fullOwner(recState, g);
        if (o === null || rec._full[g] === o) return;
        const giver = o === offer.to ? offer.from : o === offer.from ? offer.to : null;
        if (giver !== null) rec.p[giver].gave.push([g, recState.turnNumber, o]);
    });
});
EB.on('playerBankrupt', ({ playerId, creditorId }) => {
    if (!rec) return;
    const q = rec.p[playerId]; q.r = 'B'; q.o = recState.turnNumber; q.by = creditorId === null ? -1 : creditorId;
    recCause = { how: 'k', g: null };
});
EB.on('moneyMoved', ({ from, to, amount, reason }) => {
    if (!rec || reason !== 'rent' || !from || !to) return;
    const a = seatOfName(from.name), b = seatOfName(to.name);
    if (a < 0 || b < 0) return;
    rec.p[a].rp += amount; rec.p[b].rr += amount;
    rec.p[a]._drain[b] = (rec.p[a]._drain[b] || 0) + amount;
});
EB.on('stateChanged', s => recScan(s));
EB.on('gameOver', ({ winnerId }) => { if (rec) { recScan(recState); rec.end = 'over'; rec.w = winnerId; } });
const { _clone, ...tuneKeys } = TUNE;
const L = runLadder({ _game: G, difficulties: SH.difficulties, n: SH.n, seed,
    progress: false, tune: tuneKeys, clone: _clone, ...RS });
tally(); recFinish();
require('fs').writeFileSync(out, JSON.stringify({ seed, shape, rules, arm, cloneVersion: SH.difficulties.includes('T') ? (_clone || G.win.Personalities.CLONE_BENCHMARK) : undefined, clone, fires, brokerFires, entryFires, e51Fires, cedeFires, e71Fires, e76Fires, flow, idle, games: gameRecs, L }));
process.stderr.write(`[cell ${seed} ${shape} ${rules} arm=${arm}] done ${((Date.now() - t0) / 1000).toFixed(0)}s` +
    `  viol ${L.violations}  latentFires ${JSON.stringify(fires)}  brokerFires ${JSON.stringify(brokerFires)}  entryFires ${JSON.stringify(entryFires)}\n`);
