/**
 * Core: Seeded RNG (mulberry32)
 *
 * All game randomness (dice, deck shuffles, AI noise) flows through the
 * rngState stored on the game state, so saves replay deterministically and
 * reloading the page cannot reroll dice.
 *
 * Exports:
 *   - window.RNG
 */

const RNG = {
    /** Returns a float in [0, 1) and advances state.rngState. */
    float(state) {
        state.rngState = (state.rngState + 0x6D2B79F5) | 0;
        let t = state.rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },

    /** Integer in [min, max] inclusive. */
    int(state, min, max) {
        return min + Math.floor(RNG.float(state) * (max - min + 1));
    },

    rollDie(state) {
        return RNG.int(state, 1, 6);
    },

    rollDice(state) {
        return [RNG.rollDie(state), RNG.rollDie(state)];
    },

    /** In-place Fisher-Yates shuffle. Returns the array. */
    shuffle(state, arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = RNG.int(state, 0, i);
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    },

    /** Gaussian via Box-Muller. */
    gauss(state, mean = 0, sigma = 1) {
        let u = 0, v = 0;
        while (u === 0) u = RNG.float(state);
        while (v === 0) v = RNG.float(state);
        return mean + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    },

    /** Standalone generator (own state object) for AI personality seeds. */
    makeStream(seed) {
        const s = { rngState: seed | 0 };
        return {
            float: () => RNG.float(s),
            int: (min, max) => RNG.int(s, min, max),
            gauss: (mean, sigma) => RNG.gauss(s, mean, sigma)
        };
    }
};

if (typeof window !== 'undefined') {
    window.RNG = RNG;
}
