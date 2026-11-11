/**
 * AI: Personalities
 *
 * Archetypes are weight-multiplier maps over evaluator outputs, assigned
 * randomly per CPU per game. Combined with a per-game valuation bias
 * (seeded per player) and per-decision softmax noise, two CPUs of the same
 * difficulty play visibly differently.
 *
 * Dependencies: rng.js
 * Exports: window.Personalities
 */

const Personalities = {

    ARCHETYPES: {
        aggressive: { buyBias: 1.25, bidBias: 1.2,  cashFloorMul: 0.6, buildBias: 1.1, tradeFrequency: 0.25, sellReluctance: 1.0 },
        hoarder:    { buyBias: 1.3,  bidBias: 1.05, cashFloorMul: 0.9, buildBias: 0.9, tradeFrequency: 0.08, sellReluctance: 1.5 },
        builder:    { buyBias: 0.95, bidBias: 0.95, cashFloorMul: 0.8, buildBias: 1.5, tradeFrequency: 0.18, sellReluctance: 1.1 },
        trader:     { buyBias: 1.1,  bidBias: 1.0,  cashFloorMul: 1.0, buildBias: 1.0, tradeFrequency: 0.45, sellReluctance: 0.8 },
        cautious:   { buyBias: 0.85, bidBias: 0.85, cashFloorMul: 1.5, buildBias: 0.9, tradeFrequency: 0.12, sellReluctance: 1.2 }
    },

    /**
     * Fitted human clones (E54, docs/ai/efforts/E54-human-player-model.md).
     * Seated only by an explicit pick, never rolled, so a stock CPU's random
     * archetype draw is unchanged. Fitted by fit_human.js on the human's
     * recorded decisions (docs/ai/human/<id>.json). The extra fields switch on
     * the clone code paths in cpu-player.js:
     *   acquireFloorMul  cash floor at buy/bid time only (cashFloorMul stays for everything else)
     *   noise            valuation noise (replaces the difficulty's)
     *   valueContext     share of the Evaluator's board-context premium paid on buys and
     *                    when deciding to contest an auction (0 = list price, 1 = CPU)
     *   engageBias, declinedEngage  contest an auction iff context value x engageBias
     *                    (x declinedEngage on a tile it declined itself) beats list
     *   bidContext, bidNoise  bid ceiling = list x (value/list)^bidContext x bidBias, one draw per auction
     *   buildGo, buildGoExposure  per turn, build at all with P = Phi(go + k x exposure)
     *                    (exposure = expected opponent landings on its sets next roll)
     *   buildReserve, buildNoise  then build down to a lognormal dollar reserve
     *   groupBias        fixed colour taste (stock CPUs roll theirs per game)
     *   tradeCash, tradeHandover, tradeBase, tradeSlope, tradeMine, tradeTheirs, tradeH2H
     *                    answer an offer: accept with P = Phi(base + slope x U/scale + set and
     *                    heads-up terms), U = the offer's value re-weighted (_cloneTradeRespond)
     *   ctrBase, ctrMine, ctrTheirs, ctrH2H, ctrTarget  not accepting, counter with
     *                    P = Phi(...) for cash up to a surplus of ctrTarget x deal size
     *   propRate, propRateH2H, propMore  trading turns per turn (3+ / 2 active), then
     *                    odds of each further proposal that turn (_cloneProposeOdds)
     *   propSlack, propSlackSd  price openings to a CPU at this slack over its margin (_cloneShadeOffer)
     *   signals          board-signal weights per slot (engage, build): cash, ahead, unowned,
     *                    crowd (_cloneSignal; scaled as fit_human.js feats())
     * Without the trade fields (T@2026-10-17) trading is stock, with tradeFrequency
     * set so the clone proposes about as often as the human (3.1% of turns). buildReserve/buildNoise
     * are not identifiable by the likelihood (its noise pins at the grid edge), so
     * they come from the cash the human actually left after building with a
     * legal house still unbought (median $381, log-sd 1.0).
     */
    CLONES: {
        'T@2026-10-17': {
            buyBias: 1.326, bidBias: 1.326, cashFloorMul: 1.0, buildBias: 1.0, tradeFrequency: 0.08, sellReluctance: 1.0,
            acquireFloorMul: 0, noise: 0.3, valueContext: 0.54,
            engageBias: 1.2, declinedEngage: 0.77, bidContext: 0.72, bidNoise: 0.3,
            buildGo: -1.14, buildGoExposure: 1.12, buildReserve: 380, buildNoise: 1.0,
            groupBias: { brown: 1.2, lightblue: 1.8, pink: 1.5, orange: 1.35, red: 1.1, yellow: 1.0,
                green: 0.8, darkblue: 0.9, railroad: 1.2, utility: 0.8 },
        },
        // + trades (2026-10-17, same 78 games): answers, counters, proposal rate and pricing.
        // Sim-calibrated against step 3 (20261017-1828-base): buildGo -1.14 -> -0.64 (the clone
        // built on 10.5% of build-possible turns vs T's 19%), and propRate/propRateH2H doubled
        // (on a trading turn the stock generators often find no deal; smoke: 2.2 vs 4.7 per 100 turns).
        'T@2026-10-17b': {
            buyBias: 1.326, bidBias: 1.326, cashFloorMul: 1.0, buildBias: 1.0, tradeFrequency: 0.08, sellReluctance: 1.0,
            acquireFloorMul: 0, noise: 0.3, valueContext: 0.54,
            engageBias: 1.2, declinedEngage: 0.77, bidContext: 0.72, bidNoise: 0.3,
            buildGo: -0.64, buildGoExposure: 1.12, buildReserve: 380, buildNoise: 1.0,
            groupBias: { brown: 1.2, lightblue: 1.8, pink: 1.5, orange: 1.35, red: 1.1, yellow: 1.0,
                green: 0.8, darkblue: 0.9, railroad: 1.2, utility: 0.8 },
            tradeCash: 0.72, tradeHandover: 0.41, tradeBase: -1.06, tradeSlope: 1.04, tradeMine: 0.51, tradeTheirs: -3, tradeH2H: -1.12,
            ctrBase: -0.728, ctrMine: 0.6, ctrTheirs: -0.2, ctrH2H: -0.98, ctrTarget: 0.63,
            propRate: 0.088, propRateH2H: 0.006, propMore: 0.5, propSlack: -0.84, propSlackSd: 1.02,
        },
        // + board signals (2026-10-17): contest more with cash and when ahead; build more
        // readily while deeds are unowned and at bigger tables (fit_human.js --beta, each
        // signal kept only if it helped holdouts of 10/20/30 games). buildGo is the fit's
        // -2.08 plus the same +0.5 sim calibration as b (pending b's validation).
        'T@2026-10-17c': {
            buyBias: 1.372, bidBias: 1.4, cashFloorMul: 1.0, buildBias: 1.0, tradeFrequency: 0.08, sellReluctance: 1.0,
            acquireFloorMul: 0, noise: 0.235, valueContext: 0.576,
            engageBias: 0.816, declinedEngage: 0.867, bidContext: 0.686, bidNoise: 0.275,
            buildGo: -1.58, buildGoExposure: 1.5, buildReserve: 380, buildNoise: 1.0,
            groupBias: { brown: 1.1, lightblue: 1.35, pink: 1.2, orange: 1.2, red: 1.0, yellow: 1.0,
                green: 0.8, darkblue: 0.9, railroad: 1.1, utility: 0.7 },
            signals: { engage: { cash: 0.75, ahead: 0.375 }, build: { unowned: 3, crowd: 1.375 } },
            tradeCash: 0.72, tradeHandover: 0.41, tradeBase: -1.06, tradeSlope: 1.04, tradeMine: 0.51, tradeTheirs: -3, tradeH2H: -1.12,
            ctrBase: -0.728, ctrMine: 0.6, ctrTheirs: -0.2, ctrH2H: -0.98, ctrTarget: 0.63,
            propRate: 0.165, propRateH2H: 0.011, propMore: 0.5, propSlack: -0.84, propSlackSd: 1.02,
        },
    },

    /** Assign an archetype (the seat's pick, or random) + per-group
     *  valuation bias to a CPU player. */
    assign(state, player) {
        // Random (no pick) rolls the archetypes only, never a CLONES version (Clone of T is an explicit pick)
        const names = Object.keys(this.ARCHETYPES);
        const rolled = names[RNG.int(state, 0, names.length - 1)];
        const clone = this.CLONES[player.personalityPick];
        const archetype = (this.ARCHETYPES[player.personalityPick] || clone) ? player.personalityPick : rolled;
        const noiseSeed = RNG.int(state, 1, 2147483646);

        // Fixed per-game valuation bias per property group - reads as
        // "personality" (this CPU consistently overvalues railroads), not dice noise.
        const stream = RNG.makeStream(noiseSeed);
        const skill = (player.difficulty - 1) / 4;                 // 0..1
        const biasSigma = 0.35 - 0.32 * skill;                     // d1 +/-35% ... d5 +/-3%
        const groupBias = {};
        Object.keys(GROUP_META).forEach(group => {
            groupBias[group] = 1 + stream.gauss(0, biasSigma);
            groupBias[group] = Math.max(0.4, Math.min(1.8, groupBias[group]));
        });

        if (clone) Object.keys(groupBias).forEach(g => { groupBias[g] = clone.groupBias[g] || 1; });
        player.personality = { archetype: archetype, noiseSeed: noiseSeed, groupBias: groupBias };
        return player.personality;
    },

    weights(player) {
        const arch = player.personality.archetype;
        const base = this.ARCHETYPES[arch];
        if (!base) return this.CLONES[arch];
        return window.AITuning ? AITuning.merged(`archetype.${arch}`, base) : base;
    }
};

// E54 clone d and the win-game probes (2026-10-17). d = c recalibrated against the
// clonec validation (buys 91.9% vs T's 85%, builds 15.3% vs 19%, 3.8 vs 4.7 proposals
// per 100 turns). Each +variant adds one habit T shows in won games but not lost ones
// (fit_human.js --surprise): tradeBoth (P(accept) offset on swaps that complete a set
// for both sides, fitted so the clone keeps T's win-game selectivity), propOtherKeep
// (chance to still open a deal that completes no set of its own) with the win-game
// slack spread, buySets (always takes an affordable deed that completes or blocks a
// set) and earlyBid (auction ceiling multiplier up to turn 30). w is a refit on T's
// wins only (--wins-only), with the same sim calibrations as d.
(function () {
    const C = Personalities.CLONES;
    const d = C['T@2026-10-17d'] = { ...C['T@2026-10-17c'],
        buyBias: 1.30, buildGo: -1.33, propRate: 0.206, propRateH2H: 0.014 };
    C['T@2026-10-17d+swaps'] = { ...d, tradeBoth: -0.33 };
    C['T@2026-10-17d+asks'] = { ...d, propOtherKeep: 0.7, propSlack: -0.80, propSlackSd: 1.55 };
    C['T@2026-10-17d+deeds'] = { ...d, buySets: true, earlyBid: 1.09 };
    // The pinned benchmark clone for CPU A/Bs (the T seat in t4p): the clone matching T's
    // habits, not the strongest one. Change it only by deliberate promotion (log in TIMELINE);
    // refits on /review-games make research versions and never move it.
    // s = d with the shape-first proposer (cloneShapeMix) built in; validation 3
    // (20261019-2130) matched T's proposal rate, CPU accept/counter and multi rate.
    C['T@2026-10-19s'] = { ...d, shapeMix: true };
    Personalities.CLONE_BENCHMARK = 'T@2026-10-19s';
    C['T@2026-10-17w'] = {
        buyBias: 1.20, bidBias: 1.428, cashFloorMul: 0, buildBias: 1.0, tradeFrequency: 0.08, sellReluctance: 1.0,
        acquireFloorMul: 0, noise: 0.225, valueContext: 0.784,
        engageBias: 0.768, declinedEngage: 0.884, bidContext: 0.644, bidNoise: 0.23,
        buildGo: -1.0, buildGoExposure: 0.59, buildReserve: 180, buildNoise: 4.48,
        groupBias: { brown: 1.8, lightblue: 1.8, pink: 1.0, orange: 1.5, red: 1.1, yellow: 1.0,
            green: 0.8, darkblue: 0.8, railroad: 1.1, utility: 0.8 },
        signals: { engage: { cash: 0.75, ahead: 0.125 }, build: { unowned: 3, crowd: 1.625 } },
        tradeCash: 0.51, tradeHandover: 0, tradeBase: -0.98, tradeSlope: 1.02, tradeMine: 0, tradeTheirs: -3, tradeH2H: -0.825,
        ctrBase: -0.714, ctrMine: 0.6, ctrTheirs: 0, ctrH2H: -1.32, ctrTarget: 0.66,
        propRate: 0.101, propRateH2H: 0.0087, propMore: 0.5, propSlack: -0.88, propSlackSd: 1.04,
    };
    // w split into parts, each grafted onto d (which part carries w's +2.9?)
    const w = C['T@2026-10-17w'];
    const pick = keys => Object.fromEntries(keys.map(k => [k, w[k]]));
    C['T@2026-10-17d+wval'] = { ...d, ...pick(['buyBias', 'bidBias', 'cashFloorMul', 'noise', 'valueContext',
        'engageBias', 'declinedEngage', 'bidContext', 'bidNoise', 'groupBias']),
        signals: { ...d.signals, engage: w.signals.engage } };
    C['T@2026-10-17d+wbuild'] = { ...d, ...pick(['buildGo', 'buildGoExposure', 'buildReserve', 'buildNoise']),
        signals: { ...d.signals, build: w.signals.build } };
    C['T@2026-10-17d+wtrade'] = { ...d, ...pick(['tradeCash', 'tradeHandover', 'tradeBase', 'tradeSlope', 'tradeMine',
        'tradeTheirs', 'tradeH2H', 'ctrBase', 'ctrMine', 'ctrTheirs', 'ctrH2H', 'ctrTarget',
        'propRate', 'propRateH2H', 'propMore', 'propSlack', 'propSlackSd']) };
})();

if (typeof window !== 'undefined') {
    window.Personalities = Personalities;
}
