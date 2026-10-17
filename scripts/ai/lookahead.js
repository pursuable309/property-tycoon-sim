/**
 * AI: Lookahead
 *
 * Monte Carlo rollout gate for top-difficulty CPUs — the capability that
 * separates d5 from d4. At a gated decision (buy/decline, trade respond, and —
 * heads-up only — trade propose-vs-roll-on) the
 * CPU clones the state, forces each candidate action, plays the clone forward
 * ~6-8 turns with the ordinary heuristic AI, and overrides the heuristic only
 * when one candidate's outcome is decisively better. Everything runs on the
 * real engine, so auctions, cards and bankruptcies are played out exactly and
 * no second copy of the valuation logic exists to drift.
 *
 * Determinism: rollout seeds derive from state.rngState without advancing the
 * live RNG, so a reload mid-phase replays the same decision (autosave replay
 * invariant). Candidates share the same seed vector (common random numbers) so
 * the score DIFFERENCE carries far less variance than either estimate.
 *
 * Dependencies: constants, game-state, rules-engine, turn-engine (at call
 *               time), tuning
 * Exports: window.Lookahead
 */

const Lookahead = {

    _active: false,   // recursion guard: rollout players stay heuristic
    disabled: false,  // escape hatch for DEV.simulate / fast regressions

    _knob(path, def) {
        return window.AITuning ? AITuning.get(path, def) : def;
    },

    /**
     * Terminal score of a rollout for one player: share of the table's
     * (net worth + developable-monopoly premium) held by the player.
     * Winner scores 1, bankrupt 0. The 0.5x monopoly term credits a completed
     * color set beyond its deed prices (netWorth carries deeds at face), so a
     * rollout that ends just after completing a set is not scored flat.
     */
    score(state, playerId) {
        if (state.players[playerId].bankrupt) return 0;
        if (state.winner === playerId) return 1;
        let total = 0, mine = 0;
        GameState.activePlayers(state).forEach(p => {
            let v = Rules.netWorth(state, p.id);
            for (const group of Object.keys(GROUP_META)) {
                if (group === 'railroad' || group === 'utility') continue;
                if (Rules.ownsFullGroup(state, p.id, group)) {
                    v += 0.5 * Rules.tilesInGroup(group)
                        .reduce((sum, id) => sum + BOARD[id].price, 0);
                }
            }
            total += v;
            if (p.id === playerId) mine = v;
        });
        return total > 0 ? mine / total : 0;
    },

    /**
     * Mean score of `action` over K rollouts of T engine steps. Human seats
     * are flipped to CPU in the clone (heuristic play as their proxy — the
     * pump stalls on humans otherwise). Returns null when the forced action
     * is rejected by the engine (caller falls back to the heuristic).
     */
    simulate(state, playerId, action, seedBase, K, T) {
        const wasMuted = EventBus.muted;
        EventBus.muted = true; // clone events must never reach the UI
        this._active = true;
        try {
            let sum = 0;
            for (let k = 0; k < K; k++) {
                const clone = JSON.parse(JSON.stringify(state));
                clone.rngState = (seedBase + k * 0x9E3779B9) | 0;
                clone.players.forEach(p => { p.isCPU = true; });
                const engine = new MonopolyEngine(clone,
                    { persist: false, autoPump: false, cpuDelay: 0 });
                const forced = engine.dispatch(action);
                if (!forced.ok) return null;
                let steps = 0;
                while (clone.phase !== GamePhase.GAME_OVER && steps < T) {
                    if (!engine.step()) break;
                    steps += 1;
                }
                sum += this.score(clone, playerId);
            }
            return sum / K;
        } finally {
            this._active = false;
            EventBus.muted = wasMuted;
        }
    },

    /**
     * Pick among candidate actions by rollout, or null when the gate is off,
     * a candidate is infeasible, or no candidate is DECISIVELY ahead (then
     * the caller keeps its heuristic choice — the margin is what stops MC
     * noise from flipping close calls).
     */
    choose(state, playerId, candidates) {
        if (this._active || this.disabled) return null;
        const K = this._knob('evaluator.lookaheadRollouts', 8);
        if (K < 1) return null;
        // Horizon scales with the field: ~4 of MY turns ahead whatever the
        // player count. A flat step budget looks rounds ahead head-to-head
        // but barely one in a 5-player game — there the gate saw a declined
        // buy as "cash saved" and never the rival set it seeded, handing d4
        // the ladder top (5p sim: d4 34/d5 23 flat vs 26/32 scaled). 20/player
        // over 15: flipped the two 5p cells where d4 still edged d5 (−3.3pp
        // each) to d5-top (+2.0/+2.7) without hurting the rest.
        const T = this._knob('evaluator.lookaheadHorizon', 20) *
            GameState.activePlayers(state).length;
        const margin = this._knob('evaluator.lookaheadMargin', 0.012);
        const seedBase = (state.rngState ^ 0x5DEECE66) | 0;

        let best = null, bestScore = -Infinity, second = -Infinity;
        for (const action of candidates) {
            const s = this.simulate(state, playerId, action, seedBase, K, T);
            if (s === null) return null;
            if (s > bestScore) { second = bestScore; bestScore = s; best = action; }
            else if (s > second) { second = s; }
        }
        return bestScore - second > margin ? best : null;
    }
};

if (typeof window !== 'undefined') {
    window.Lookahead = Lookahead;
}
