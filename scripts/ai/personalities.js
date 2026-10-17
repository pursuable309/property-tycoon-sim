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

    /** Assign an archetype (the seat's pick, or random) + per-group
     *  valuation bias to a CPU player. */
    assign(state, player) {
        const names = Object.keys(this.ARCHETYPES);
        const rolled = names[RNG.int(state, 0, names.length - 1)];
        const archetype = this.ARCHETYPES[player.personalityPick] ? player.personalityPick : rolled;
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

        player.personality = { archetype: archetype, noiseSeed: noiseSeed, groupBias: groupBias };
        return player.personality;
    },

    weights(player) {
        const arch = player.personality.archetype;
        const base = this.ARCHETYPES[arch];
        return window.AITuning ? AITuning.merged(`archetype.${arch}`, base) : base;
    }
};

if (typeof window !== 'undefined') {
    window.Personalities = Personalities;
}
