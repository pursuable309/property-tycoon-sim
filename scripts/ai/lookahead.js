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
        // E84: who a human seat is in the rollouts (tagged before _active mutes _fire)
        const proxy = AITuning.knob('evaluator.lookaheadHumanProxy');
        const humanSeats = state.players.filter(p => Evaluator.actsHuman(p)).map(p => p.id);
        if (proxy && humanSeats.length) {
            Evaluator._fire('E84', proxy === 2 ? 'rollout plays the human as the benchmark clone'
                : proxy === 1 ? 'rollout plays the human as a stock d4' : 'rollout plays the human with no difficulty');
        }
        const wasMuted = EventBus.muted;
        EventBus.muted = true; // clone events must never reach the UI
        this._active = true;
        try {
            let sum = 0;
            for (let k = 0; k < K; k++) {
                const clone = JSON.parse(JSON.stringify(state));
                clone.rngState = (seedBase + k * 0x9E3779B9) | 0;
                clone.players.forEach(p => { p.isCPU = true; p.humanProxy = false; });
                if (proxy) humanSeats.forEach(id => this._modelHuman(clone, clone.players[id], proxy));
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
     * E84 (knob evaluator.lookaheadHumanProxy): who a seat that acts human in the
     * live state is inside a rollout. A real human has no difficulty, so without
     * this its skill and cash floor are NaN there: it never buys or bids.
     *   1: a stock d4 with a rolled archetype (the sims' clone seat too);
     *   2: the pinned benchmark clone at d4 (a seat that already has a
     *      difficulty, i.e. the sims' clone, keeps its own model);
     *  -1: sim arm only, strip difficulty and personality (the real-game model).
     * The game RNG is restored after the archetype roll, so the rollout's dice
     * are the same as without the knob.
     */
    _modelHuman(clone, p, proxy) {
        if (!p) return;
        if (proxy < 0) {
            delete p.difficulty; delete p.personality; delete p.personalityPick;
            return;
        }
        if (proxy === 2 && p.difficulty) return;
        const rng = clone.rngState;
        p.difficulty = 4;
        p.personalityPick = proxy === 2 ? Personalities.CLONE_BENCHMARK : null;
        p.cloneSeat = false;
        Personalities.assign(clone, p);
        clone.rngState = rng;
    },

    /**
     * Pick among candidate actions by rollout, or null when the gate is off,
     * a candidate is infeasible, or no candidate is DECISIVELY ahead (then
     * the caller keeps its heuristic choice — the margin is what stops MC
     * noise from flipping close calls).
     */
    choose(state, playerId, candidates) {
        if (this._active || this.disabled) return null;
        let K = AITuning.knob('evaluator.lookaheadRollouts');
        if (K < 1) return null;
        // E52: more rollouts pay only at small tables. 3x the samples gave d5
        // +3.3 win / +2.75 capWin heads-up (18 cells, 13 up / 3 down) and nothing
        // at 5p/8p, where the rollout sees ~1 own turn and noise isn't the limit.
        // Widened to 4 active: 4p d5 +1.8 then +2.6 on fresh seeds (capWin
        // +0.7/+2.2), 5p -0.3 ±0.4 with capWin flat.
        // Gated on ACTIVE players, so a bigger game's late field gets it too.
        if (GameState.activePlayers(state).length <= AITuning.knob('evaluator.lookaheadSmallMaxPlayers')) {
            K = Math.max(K, AITuning.knob('evaluator.lookaheadRolloutsSmall'));
        }
        // Horizon scales with the field: ~4 of MY turns ahead whatever the
        // player count. A flat step budget looks rounds ahead head-to-head
        // but barely one in a 5-player game — there the gate saw a declined
        // buy as "cash saved" and never the rival set it seeded, handing d4
        // the ladder top (5p sim: d4 34/d5 23 flat vs 26/32 scaled). 20/player
        // over 15: flipped the two 5p cells where d4 still edged d5 (−3.3pp
        // each) to d5-top (+2.0/+2.7) without hurting the rest.
        const T = AITuning.knob('evaluator.lookaheadHorizon') *
            GameState.activePlayers(state).length;
        const margin = AITuning.knob('evaluator.lookaheadMargin');
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
