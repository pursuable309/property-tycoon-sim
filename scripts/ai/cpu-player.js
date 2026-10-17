/**
 * AI: CPU Player
 *
 * Single entry point: CPUPlayer.nextAction(state, playerId) returns the next
 * action a CPU owes for the current phase (the engine pump calls it once per
 * decision). Decisions are utility-based with three unpredictability layers:
 *   1. per-game per-group valuation bias (personalities.js)
 *   2. per-decision Gaussian noise scaled by difficulty
 *   3. outright blunders at low difficulty
 *
 * Difficulty 1 (easiest) .. 5 (hardest).
 *
 * Dependencies: constants, rng, board-data, game-state, rules-engine,
 *               evaluator, personalities
 * Exports: window.CPUPlayer
 */

const CPUPlayer = {

    // tradeMargin trends NEUTRAL->NEGATIVE with difficulty ("smarter, not
    // greedier"): the old +0.03/+0.08/+0.10 made strong CPUs demand a cut and
    // decline set-completing deals the generous low tiers grabbed, so they
    // completed fewer monopolies and won no more than d2. Stronger CPUs now
    // deal more readily (the evaluator still prices the deal). Low end steepened
    // (d1/d2 noise+blunder) so d1<d2 separates.
    // d5 noise 0.05: at 0.10 it matched d4's 0.11, so the two judged value
    // near-identically and d5's ONLY edge was the situational lookahead, which
    // barely moved the ladder (d5 merely tied d3/d4 across 3-8p sim). Sharpening
    // d5's judgment is its always-on separator: 0.10->0.05 lifts d5 to a clear
    // ladder top in 2p (47->55% vs d4) and 5p (28->34%, ladder made monotonic)
    // and is neutral at 8p. Tuned via seat-controlled sim; see sim_harness.js.
    // lookahead: rollout-gated decisions (scripts/ai/lookahead.js) — now gates
    // only MARGINAL buys / trade responses; a clear, affordable +EV buy skips
    // the rollout (evaluator.lookaheadBuyClearRatio), since the short-horizon
    // score credits only completed sets and otherwise vetoed acquisitions d5
    // never invested out of (games mrwv7aee/mrwwyngr/mrwswdij).
    // focus: d5-only "focus plan" (P3) — concentrate buy/auction pricing on the
    // 1-2 best developable color groups (evaluator.d5FocusBias). Meant as the
    // always-on 4-5p fix but the A/B put it with the lookahead levers: a clean
    // 2p win, a 5p quality FAIL (mono/srv down) — concentration is a low-
    // opponent strategy. Shipped HEADS-UP only (<=2 active), stacks on P2.
    // Ladder re-spacing (2026-07-29): d4 noise 0.11->0.22, d3 0.20->0.30, and
    // d4 auctionSmarts demoted to 0.5 — sharp auction play (price-anchored
    // pre-bids + bluff-drain) is now d5-EXCLUSIVE. Eight attempts to widen the
    // d4/d5 gap by giving d5 MORE (lookahead rescoring, focus, trade gates,
    // auction block-bids) failed at 4-5p; spacing d4 DOWN is what worked:
    // 5p d5-d4 gap +0.9 -> +4.6 with d5's own win/capWin/dev% all UP, d4-d3
    // margin +3.3, h2h d5 59-76%. A/B'd 3 seeds x 3 rulesets (arms D/E/F/G:
    // pure noise +3.8 / +blunder overshoots, d4 sinks into d3 / this arm);
    // full record: chats/2026-07-28-d5-differentiation-analysis.md section 13.
    DIFFICULTY: {
        1: { noise: 0.50, blunder: 0.18, tradeMargin: -0.15, auctionSmarts: 0, lookahead: 0 },
        2: { noise: 0.32, blunder: 0.10, tradeMargin: -0.06, auctionSmarts: 0, lookahead: 0 },
        3: { noise: 0.30, blunder: 0.02, tradeMargin: 0.00,  auctionSmarts: 0.5, lookahead: 0 },
        4: { noise: 0.22, blunder: 0.00, tradeMargin: -0.02, auctionSmarts: 0.5, lookahead: 0 },
        5: { noise: 0.05, blunder: 0.00, tradeMargin: -0.05, auctionSmarts: 1, lookahead: 1, focus: 1 }
    },

    nextAction(state, playerId) {
        const player = state.players[playerId];
        if (!player.personality) Personalities.assign(state, player);

        switch (state.phase) {
            case GamePhase.AWAIT_PREROLL: return this._preRoll(state, player);
            case GamePhase.AWAIT_JAIL_CHOICE: return this._jailChoice(state, player);
            case GamePhase.AWAIT_DECISION: return this._buyOrAuction(state, player);
            case GamePhase.AUCTION_IN_PROGRESS: return this._auctionBid(state, player);
            case GamePhase.TRADE_PENDING: return this._tradeRespond(state, player);
            case GamePhase.DEBT_SETTLEMENT: return this._raiseCash(state, player);
            case GamePhase.AWAIT_ENDTURN: return this._postRoll(state, player);
            default: return null;
        }
    },

    /* ==================== HELPERS ==================== */

    /**
     * Record a CPU-reasoning line to the game log (filter category 'ai', so it
     * stays out of the board spotlight and off by default in the feed, but is
     * inspectable live and persisted for review tooling). Suppressed inside
     * lookahead rollouts — those clones must not narrate their own play.
     */
    _pricing: typeof WeakMap !== 'undefined' ? new WeakMap() : null,

    _trace(state, text) {
        if (window.Lookahead && Lookahead._active) return;
        GameState.addLog(state, text, { detail: true, cat: 'ai' });
    },

    _params(player) {
        const d = this.DIFFICULTY[player.difficulty] ? player.difficulty : 3;
        const base = this.DIFFICULTY[d];
        return window.AITuning ? AITuning.merged(`difficulty.${d}`, base) : base;
    },

    _skill(player) {
        return (player.difficulty - 1) / 4;
    },

    /** Noisy contextual value of a tile for this CPU. `opts` (optional) carries
     *  buildability context (cashAfter/skill) so a set-completing tile the CPU
     *  couldn't afford to develop isn't valued at the full completion premium. */
    _value(state, player, tileId, opts) {
        const tile = BOARD[tileId];
        const p = this._params(player);
        const w = Personalities.weights(player);
        const bias = player.personality.groupBias[tile.group] || 1;
        let base = Evaluator.propertyValue(state, tileId, player.id, opts) * bias;
        if (p.focus) base *= this._focusMul(state, player, tile.group); // d5 concentration (P3)
        return base * (1 + RNG.gauss(state, 0, p.noise));
    },

    /**
     * d5-only "focus plan" reweighting (P3), HEADS-UP only (<=2 active
     * players), magnitude evaluator.d5FocusBias. Once the CPU has a color
     * foothold it names its 1-2 best developable groups (see _focusGroups) and
     * boosts their tiles at buy/auction while mildly de-prioritizing tiles in a
     * color group it owns NONE of — so it finishes the sets it started instead
     * of scattering cash and arriving at its own key auction broke. The boost
     * is larger than the penalty on purpose: the goal is to DEVELOP the focus
     * groups more, not merely buy less. Railroads/utilities are a separate
     * engine and never de-prioritized here (they have _railOppFactor).
     *   Gated to <=2 players by the two-seed x 3-ruleset A/B: at 2p a clean
     *   +5.7pp d5 win% (all 6 cells positive, capWin corroborated, dev% flat
     *   -to-up, no avgSteps inflation) — a real skill gain that STACKS on P2.
     *   But at 5p it fails the quality gate: d5 win flat-to-negative (-0.75
     *   mean) AND monopolies/survivor DOWN in all 6 cells. Concentration is an
     *   intrinsically low-opponent strategy — in a fragmented 5p board you
     *   can't dictate which sets you complete, so "don't open new groups" just
     *   suppresses d5's own development. activePlayers (not seat count) so a
     *   larger game that attrites to 1v1 re-enables it, where it pays.
     */
    _focusMul(state, player, group) {
        const k = window.AITuning ? AITuning.get('evaluator.d5FocusBias', 0) : 0;
        if (k <= 0 || group === 'railroad' || group === 'utility') return 1;
        // Heads-up only by default; evaluator.d5FocusMaxPlayers re-opens wider
        // tables for the 2026-10-17 re-test of the 5p closure (6 cells, pre-E38).
        const maxPlayers = window.AITuning ? AITuning.get('evaluator.d5FocusMaxPlayers', 2) : 2;
        if (GameState.activePlayers(state).length > maxPlayers) return 1;
        const focus = this._focusGroups(state, player.id);
        if (!focus.size) return 1;               // no foothold yet — don't restrict
        if (focus.has(group)) return 1 + k;      // concentrate here
        const mine = Rules.tilesInGroup(group)
            .filter(id => Rules.getOwner(state, id) === player.id).length;
        return mine === 0 ? 1 - k * 0.6 : 1;     // discourage opening a NEW group
    },

    /**
     * The 1-2 color groups a player should concentrate on: owned monopolies
     * (keep developing them) and the partial closest to completion, ranked by
     * ownership fraction with landing frequency as the tie-break. Returns a Set
     * of group keys, empty when the player owns no color tile yet (early game —
     * a player with nothing shouldn't be told to focus). Cheap: ~8 groups.
     */
    _focusGroups(state, playerId) {
        const scored = [];
        for (const g of Object.keys(GROUP_META)) {
            if (g === 'railroad' || g === 'utility') continue;
            const ids = Rules.tilesInGroup(g);
            const mine = ids.filter(id => Rules.getOwner(state, id) === playerId).length;
            if (mine === 0) continue;
            const freq = ids.reduce((s, id) => s + LANDING_FREQ[id], 0) / ids.length;
            // completion progress dominates; owned monopoly floored above any
            // partial; landing frequency only breaks ties between equal progress.
            const score = (mine / ids.length) * 100 + (mine === ids.length ? 50 : 0) + freq;
            scored.push({ g, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return new Set(scored.slice(0, 2).map(x => x.g));
    },

    _floor(state, player) {
        const w = Personalities.weights(player);
        return Evaluator.cashFloor(state, player.id, this._skill(player)) * w.cashFloorMul;
    },

    /** True if, after paying `price` for a set-completing tile, the CPU could
     *  still put a first house on each tile of the set while keeping a light
     *  reserve. Gates the below-floor completion buy so premium sets aren't
     *  completed into an undevelopable, cash-starved monopoly. */
    _canFundFirstBuild(state, player, tileId, price) {
        return this._canFundFirstBuildAfter(state, player, BOARD[tileId].group, player.cash - price);
    },

    /** Generalised funding gate: left with `cashAfter` after some acquisition,
     *  could the CPU still fund a first round of houses on `group` and keep a
     *  light reserve? `strength` scales how much of the first build round must be
     *  covered (1 = the full buy-path bar; <1 = a softer reserve). Shared by the
     *  buy path (_canFundFirstBuild) and the trade-completion path
     *  (_tradeCompletionFundable) so the two funding checks never drift. */
    _canFundFirstBuildAfter(state, player, group, cashAfter, strength = 1) {
        const ids = Rules.tilesInGroup(group);
        const firstRound = BOARD[ids[0]].houseCost * ids.length;
        return cashAfter >= firstRound * strength + this._floor(state, player) * 0.5;
    },

    /** Liquidity discipline for TRADE-driven set completion (knob
     *  evaluator.tradeCompletionReserve, default 0 = off). If `offer` would newly
     *  complete one of MY colour sets but leave me unable to fund a first round of
     *  houses on it, that's an unfundable monopoly — undevelopable, strip-
     *  mortgaged, the source of d5's distress fire-sales (analysis §8, the 2.5×
     *  CashOut signal). Returns false so the generator skips that candidate;
     *  fundable completions, deed-funded completions (cash preserved) and plain
     *  advances all pass through. Reserve strength scales with skill (k × _skill)
     *  so sharper CPUs — which over-commit ~2.5× more — keep the tighter
     *  discipline; this is the trade-path twin of the buy-path _canFundFirstBuild
     *  gate (memory two-valuation-copies-drift: reuse the helper, don't fork it). */
    _tradeCompletionFundable(state, player, offer) {
        const k = window.AITuning ? AITuning.get('evaluator.tradeCompletionReserve', 0) : 0;
        if (k <= 0) return true;
        const after = Evaluator._ownershipAfter(state, offer);
        let group = null;
        for (const g of Object.keys(GROUP_META)) {
            if (g === 'railroad' || g === 'utility') continue;
            const ids = Rules.tilesInGroup(g);
            if (ids.every(id => after[id] === player.id) &&
                !ids.every(id => Rules.getOwner(state, id) === player.id)) { group = g; break; }
        }
        if (!group) return true; // this offer doesn't newly complete a set of mine
        const cashAfter = player.cash - (offer.give.cash || 0) + (offer.get.cash || 0);
        return this._canFundFirstBuildAfter(state, player, group, cashAfter, k * this._skill(player));
    },

    _blunders(state, player) {
        return RNG.float(state) < this._params(player).blunder;
    },

    /* ==================== TURN PHASES ==================== */

    _preRoll(state, player) {
        const manage = this._bestManagement(state, player);
        if (manage) return manage;
        const trade = this._maybeProposeTrade(state, player);
        if (trade) return trade;
        return { type: 'ROLL_DICE' };
    },

    _postRoll(state, player) {
        const manage = this._bestManagement(state, player);
        if (manage) return manage;
        return { type: 'END_TURN' };
    },

    /** Best build / unmortgage move, or null when nothing is worth doing. */
    _bestManagement(state, player) {
        const w = Personalities.weights(player);
        const floor = this._floor(state, player);
        const props = GameState.propertiesOf(state, player.id);

        // Green light (d3+): just past the board's dangerous stretch —
        // nothing scary within the next roll while big rents exist elsewhere.
        // Exposure is at its lap minimum, so cash earns most as houses now;
        // loosen the reserve for building decisions only.
        let buildFloor = floor;
        if (this._skill(player) >= 0.5) {
            const ahead = Evaluator.threatAhead(state, player.id);
            const worstBoard = Evaluator.maxThreatRent(state, player.id);
            if (worstBoard >= 200 && ahead.worst < worstBoard * 0.35) {
                buildFloor = floor * 0.55;
            }
        }

        // Build: highest ROI legal house we can afford above the floor
        let bestBuild = null, bestROI = 0;
        props.forEach(tileId => {
            if (!Rules.canBuildHouse(state, player.id, tileId).ok) return;
            if (player.cash - BOARD[tileId].houseCost < buildFloor) return;
            const roi = Evaluator.buildROI(state, tileId) * w.buildBias;
            if (roi > bestROI) { bestROI = roi; bestBuild = tileId; }
        });
        // Repair before expansion (d3+, knob evaluator.unfreezeSetPriority,
        // def 0 = off): if one of my own colour monopolies is FROZEN by my
        // mortgage, lifting it can beat buying another house outright.
        const unfreeze = this._bestUnfreeze(state, player, buildFloor);
        if (unfreeze && unfreeze.perDollar > bestROI) {
            this._trace(state, `${player.name} — lifts the mortgage freezing the ` +
                `${BOARD[unfreeze.tileId].group} set instead of building elsewhere.`);
            return { type: 'UNMORTGAGE', tileId: unfreeze.tileId };
        }

        if (bestBuild !== null && !this._blunders(state, player)) {
            return { type: 'BUILD_HOUSE', tileId: bestBuild };
        }

        // Stretch-build (d3+): a legal build exists but cash is short —
        // mortgage spare singles (never monopoly members, never houses)
        // to put the idle monopoly to work. Guard against a PAPER reserve:
        // only mortgage this deed if the cash it raises still leaves a real
        // working reserve after funding the house (full `floor`, against THIS
        // mortgage's proceeds — not the old `cash + eq.total`, which counted
        // every un-tapped deed as reserve and let a CPU convert its whole
        // portfolio into houses and end the turn at ~$0, then fold to a routine
        // rent/tax the next turn: ms4tkvha Uma t30 built to $0, $100 tax t34).
        if (this._skill(player) >= 0.5) {
            const starved = this._starvedBuild(state, player);
            if (starved) {
                const eq = this._stretchEquity(state, player);
                if (eq.tiles.length &&
                    player.cash + Rules.mortgageValue(eq.tiles[0]) - starved.houseCost >= floor) {
                    return { type: 'MORTGAGE', tileId: eq.tiles[0], playerId: player.id };
                }
            }
        }

        // Unmortgage monopoly members first, then hot singles
        const mortgaged = props.filter(id => state.tiles[String(id)].mortgaged);
        for (const tileId of mortgaged) {
            const cost = Rules.unmortgageCost(tileId);
            if (player.cash - cost < floor * 1.3) continue;
            const tile = BOARD[tileId];
            const inMonopoly = tile.group && Rules.ownsFullGroup(state, player.id, tile.group);
            if (inMonopoly || player.cash - cost > floor * 2.5) {
                return { type: 'UNMORTGAGE', tileId: tileId };
            }
        }
        return null;
    },

    _jailChoice(state, player) {
        // Danger: opponents' built-up boards make leaving jail costly
        let oppBuildings = 0;
        GameState.activePlayers(state).forEach(p => {
            if (p.id === player.id) return;
            GameState.propertiesOf(state, p.id).forEach(id => { oppBuildings += Rules.houseCount(state, id); });
        });
        const dangerous = oppBuildings >= 8;
        const smart = this._skill(player) >= 0.5 && !this._blunders(state, player);

        if (smart && dangerous) return { type: 'JAIL_ROLL' };      // hide in jail late game
        if (player.getOutCards > 0) return { type: 'JAIL_CARD' };
        if (player.cash > GAME_CONST.JAIL_FINE + this._floor(state, player) * 0.5 && (smart || RNG.float(state) < 0.6)) {
            return { type: 'JAIL_PAY' };
        }
        return { type: 'JAIL_ROLL' };
    },

    /**
     * Is this tile worth mortgaging OTHER deeds to afford? Only when it
     * completes MY OWN color group — a monopoly is an income engine that
     * repays the temporary leverage. A pure block (denying an opponent who
     * owns the rest of the group) generates no income, so funding one with
     * mortgages just strips the portfolio and leaves no reserve: a d5 hoarder
     * mortgaged Pennsylvania Avenue into an undevelopable Boardwalk block and
     * was bankrupt 12 turns later (game mrzds97s). Blocks are still bought
     * when affordable from cash on hand.
     */
    _stretchWorthy(state, player, tileId) {
        const tile = BOARD[tileId];
        if (tile.type !== 'property' || !tile.group) return false;
        const size = GROUP_META[tile.group].size;
        if (Rules.countOwnedInGroup(state, player.id, tile.group) !== size - 1) return false;
        // Realizability: a completed set earns nothing — and can't take a house —
        // while ANY member is mortgaged. If members of the target group are
        // already frozen and the CPU is so short it must stretch (mortgage still
        // MORE) just to afford the completer, it cannot lift them either: the set
        // is born frozen with no cash to reclaim it (game msiy5u5q t51, Tate
        // stretched into orange with St. James already mortgaged, mortgaged
        // Tennessee for the bid, then folded with both partners never lifted).
        // Require lifting every already-mortgaged member from cash on hand, or
        // the completion is worthless. NOT a ban on mortgaging a set member to
        // complete a set — that line is legitimate when a reclaim path exists
        // (msmea97e Bailey; evaluator.unfreezeSetPriority now drives the repair).
        const frozenMembers = Rules.tilesInGroup(tile.group)
            .filter(id => Rules.getOwner(state, id) === player.id && state.tiles[String(id)].mortgaged);
        if (frozenMembers.length) {
            const liftCost = frozenMembers.reduce((sum, id) => sum + Rules.unmortgageCost(id), 0);
            if (player.cash < liftCost) return false;
        }
        return true;
    },

    /**
     * Equity a CPU may tap to fund a stretch purchase: mortgageable deeds
     * that are NOT part of a group it fully owns (a monopoly member stays
     * sacred — mortgaging one blocks building the set). Houses are never
     * sold to fund a purchase (a 50% haircut on the rent engine). Ordered
     * cheapest strategic loss first: least contextual value per dollar raised.
     */
    _stretchEquity(state, player) {
        const tiles = GameState.propertiesOf(state, player.id)
            .filter(id => Rules.canMortgage(state, player.id, id).ok)
            .filter(id => {
                const g = BOARD[id].group;
                return !(g && Rules.ownsFullGroup(state, player.id, g));
            })
            .sort((a, b) =>
                Evaluator.propertyValue(state, a, player.id) / Rules.mortgageValue(a) -
                Evaluator.propertyValue(state, b, player.id) / Rules.mortgageValue(b));
        return { tiles: tiles, total: tiles.reduce((sum, id) => sum + Rules.mortgageValue(id), 0) };
    },

    /**
     * The most valuable mortgage lift that would UNFREEZE one of my colour
     * monopolies, or null. Official rules block building on a group with any
     * mortgaged member, so a single mortgaged deed idles the entire set — and
     * `_bestManagement` used to rank EVERY legal build above every mortgage
     * lift, so the freeze never healed: cash trickled into whatever cheap group
     * happened to be buildable while a premium set sat dead. Diagnostic
     * (5p, sampled every 20 steps, scratchpad/dev_depth.js): the largest single
     * reason a d5 monopoly is under-built is exactly this self-inflicted freeze
     * — 43.6% of d5's under-built sets, ahead of its own cash reserve (30.7%)
     * and real poverty (18.6%); bank stock is never the binding constraint.
     * The freeze itself is legitimate damage (`_raiseCash` only mortgages set
     * members once the singles are gone, under real duress) — what was missing
     * is the REPAIR.
     *
     * Ranked in `Evaluator.buildROI` units so the caller can compare it with
     * buying a house: rent the frozen deeds resume earning per dollar of lift,
     * plus the build ROI the lift unlocks weighted by knob
     * `evaluator.unfreezeSetPriority` x skill (so sharper CPUs keep the tighter
     * balance-sheet discipline; d1/d2 stay sloppy). Only starts an unlock it can
     * finish AND still build on — a half-lifted group buys nothing — and never
     * dips under the (possibly loosened) build floor. 0 = off, the old
     * always-build-first behavior.
     */
    _bestUnfreeze(state, player, buildFloor) {
        const k = window.AITuning ? AITuning.get('evaluator.unfreezeSetPriority', 0) : 0;
        if (k <= 0 || this._skill(player) < 0.5) return null;
        const kEff = k * this._skill(player);
        let best = null;
        for (const group of Object.keys(GROUP_META)) {
            const fz = Evaluator.frozenSetValue(state, player.id, group);
            if (!fz) continue;
            const houseCost = BOARD[Rules.tilesInGroup(group)[0]].houseCost;
            // Lifting a frozen monopoly restores its DOUBLED base rent even with
            // no house on it, so the lift is worthwhile as soon as the CPU can
            // afford the lift itself above the reserve — it need NOT also fund a
            // first house the same turn. When a house IS affordable, additionally
            // credit the build ROI the lift unlocks (knob-weighted); when it is
            // not, value the lift on the restored doubled rent alone. This
            // repairs a completed-but-frozen premium set for a cash-poor CPU that
            // can never simultaneously afford lift + a $200 house (game msmea97e
            // Bailey: green stayed dead ~100 turns) once its cheaper builds are
            // exhausted, rather than the old "lift only if you can also build".
            if (player.cash - fz.unlockCost < buildFloor) continue;
            const canBuild = player.cash - fz.unlockCost - houseCost >= buildFloor;
            const perDollar = fz.restoredROI + (canBuild ? kEff * fz.unlockedROI : 0);
            // Restore the highest-earning frozen deed first.
            const tileId = fz.frozen.slice().sort((a, b) =>
                Rules.rentTable(state, b)[0] - Rules.rentTable(state, a)[0])[0];
            if (!best || perDollar > best.perDollar) {
                best = { tileId: tileId, group: group, perDollar: perDollar, unlockCost: fz.unlockCost };
            }
        }
        return best;
    },

    /**
     * The best house I could legally build right now but cannot fund, or
     * null when no legal build exists / some build is already affordable
     * (then _bestManagement handles it normally).
     */
    _starvedBuild(state, player) {
        const floor = this._floor(state, player);
        let best = null, anyAffordable = false;
        GameState.propertiesOf(state, player.id).forEach(tileId => {
            if (!Rules.canBuildHouse(state, player.id, tileId).ok) return;
            if (player.cash - BOARD[tileId].houseCost >= floor) { anyAffordable = true; return; }
            const roi = Evaluator.buildROI(state, tileId);
            if (!best || roi > best.roi) {
                best = { tileId: tileId, roi: roi, houseCost: BOARD[tileId].houseCost };
            }
        });
        return anyAffordable ? null : best;
    },

    /** Buy-bias for the buy/auction value, with the MULTIPLAYER acquisition
     *  lift (evaluator.multiplayerBuyLift, def 0=off). In a 3+ active-player
     *  field the under-buying archetypes (base buyBias < 1: cautious 0.85,
     *  builder 0.95) were measured to under-acquire and lose with cash in hand
     *  (mu6c4jg6, mu4t9i9k). An additive lift raises them toward parity there
     *  (0.85+0.15=1.0, 0.95+0.15=1.1). Gated to >=3 players because the same
     *  raise is a clean d5 win at 5p (A/B bt56zo1rr: +3.4, dev up, not
     *  attrition) but hurts heads-up (-1.9), where the <=2p lookahead already
     *  optimizes acquisition — the mirror of the buy-veto/proposal-gate/focus
     *  scoping. Bids are untouched (the bidBias raise measured inert). */
    _buyBias(state, w) {
        const lift = window.AITuning ? AITuning.get('evaluator.multiplayerBuyLift', 0) : 0;
        if (lift > 0 && w.buyBias < 1 && GameState.activePlayers(state).length >= 3) {
            return w.buyBias + lift;
        }
        return w.buyBias;
    },

    _buyOrAuction(state, player) {
        const tileId = state.pendingAction.tileId;
        const price = BOARD[tileId].price;
        const w = Personalities.weights(player);
        const value = this._value(state, player, tileId,
            { cashAfter: player.cash - price, skill: this._skill(player) }) * this._buyBias(state, w);
        const floor = this._floor(state, player);
        const tile = BOARD[tileId];
        const completesSet = tile.group && !['railroad', 'utility'].includes(tile.group) &&
            Rules.countOwnedInGroup(state, player.id, tile.group) === GROUP_META[tile.group].size - 1;
        // Completing a set justifies dipping below the working reserve — but
        // only if we can still fund a first round of houses afterward.
        // Completing a premium set (dark blue) down to near-zero just buys an
        // undevelopable monopoly that strip-mortgages and dies (games
        // mrtqw1oj Finley, mrtwus9v Lennon). Cheap sets clear this easily.
        const fundableCompletion = completesSet && this._canFundFirstBuild(state, player, tileId, price);

        // Stretch funding (d3+): short on cash for a set-completing or
        // set-denying tile, mortgage spare singles first (the engine allows
        // managing during AWAIT_DECISION; the pump re-asks after each one).
        const stretching = this._skill(player) >= 0.5 &&
            this._stretchWorthy(state, player, tileId) && value > price;
        if (stretching && player.cash < price) {
            const eq = this._stretchEquity(state, player);
            if (eq.tiles.length && player.cash + eq.total >= price) {
                return { type: 'MORTGAGE', tileId: eq.tiles[0], playerId: player.id };
            }
        }

        let wantBuy = player.cash >= price &&
            value > price &&
            (player.cash - price > floor || fundableCompletion || stretching);

        // Sharp CPUs sometimes decline and try to win the auction cheap
        const p = this._params(player);
        if (wantBuy && p.auctionSmarts >= 1) {
            const othersPoor = GameState.activePlayers(state)
                .filter(o => o.id !== player.id)
                .every(o => o.cash < price * 0.6);
            if (othersPoor && RNG.float(state) < 0.25) wantBuy = false;
        }

        if (this._blunders(state, player)) wantBuy = !wantBuy && player.cash >= price;

        // Rollout gate: play both branches forward and keep the heuristic
        // call unless one is decisively better (the decline branch rolls the
        // ensuing auction for real, so "pass and win it cheap" is priced).
        // Reserve it for MARGINAL calls: the rollout's terminal score credits
        // only net worth (deeds at face) + COMPLETED-monopoly premium, so a
        // non-set-completing single tile bought at value >> price adds nothing
        // inside the ~4-of-my-turns horizon and the gate systematically vetoes
        // clear, affordable acquisitions — the d5 then hoards cash to a
        // bankruptcy it never invested out of (games mrwv7aee Lane 1 buy,
        // mrwwyngr Yuri passed NY Ave $200/$340, mrwswdij Nico 0 buys; all
        // finished with starvedTurns~0). A comfortably-+EV buy that still
        // clears the reserve is not a close call — take it, skip the rollout.
        // ...and in a BIG FIELD, skip it for any wanted, reserve-clearing buy.
        // The rollout's edge dilutes with player count (it sees ~4 of my turns
        // head-to-head, ~1 at five players), so past `lookaheadBuyVetoMaxPlayers`
        // active players its veto is mostly noise applied to a decision the
        // heuristic already priced. A/B 2026-07-30 (9 cells x 2 shapes, 0 viol):
        // disabling the veto raised the 5p d5-d4 gap +4.4 -> +5.2 (wider in 6/9
        // cells) with dev% +0.9 — it buys more, so it develops more — while the
        // SAME change cost -0.6 win / -0.6 capWin head-to-head (wider in 3/9),
        // where the rollout is accurate. So it is gated, not removed: the
        // heads-up veto stays, the 4-5p veto goes. Turning the rollout off
        // entirely was measured too and is catastrophic (h2h d5 -16.0, gap
        // +31.7 -> -0.4) — this subsystem IS d5's edge; only the buy veto is
        // the diluted part. Set the knob to 8 to restore the old behavior.
        // The rollout is still consulted when the heuristic wants to PASS, at
        // every player count, so it can still override a bad decline into a buy.
        const clearRatio = window.AITuning ? AITuning.get('evaluator.lookaheadBuyClearRatio', 1.15) : 1.15;
        const vetoMax = window.AITuning ? AITuning.get('evaluator.lookaheadBuyVetoMaxPlayers', 2) : 2;
        const bigField = GameState.activePlayers(state).length > vetoMax;
        const clearBuy = wantBuy && player.cash - price > floor &&
            (bigField || (clearRatio > 0 && value >= price * clearRatio));
        if (p.lookahead && window.Lookahead && player.cash >= price && !clearBuy) {
            const pick = Lookahead.choose(state, player.id,
                [{ type: 'BUY_PROPERTY' }, { type: 'DECLINE_BUY' }]);
            if (pick) {
                const wantsBuy = pick.type === 'BUY_PROPERTY';
                this._trace(state, `${player.name} — lookahead ${wantsBuy === wantBuy ? 'confirms' : 'overrides to'} ` +
                    `${wantsBuy ? 'buy' : 'pass'} on ${tile.name} ($${price}, valued $${Math.round(value)}).`);
                return pick;
            }
        }
        // An affordable pass is a deliberate decline (not a can't-afford one):
        // record why, since only the ensuing auction would otherwise show it.
        if (!wantBuy && player.cash >= price) {
            this._trace(state, `${player.name} passes on ${tile.name} ($${price}) — values it at $${Math.round(value)}.`);
        }
        return { type: wantBuy ? 'BUY_PROPERTY' : 'DECLINE_BUY' };
    },

    _auctionBid(state, player) {
        const a = state.auction;
        const w = Personalities.weights(player);
        const value = this._value(state, player, a.tileId,
            { cashAfter: player.cash - a.currentBid, skill: this._skill(player) }) * w.bidBias;
        const floor = this._floor(state, player);
        let maxWill = Math.min(value, player.cash - floor * 0.5, player.cash);

        // Stretch funding (d3+): for a set-completing or set-denying tile,
        // spare-single mortgage equity extends the bid ceiling past cash.
        let stretch = null;
        if (this._skill(player) >= 0.5 && this._stretchWorthy(state, player, a.tileId)) {
            const eq = this._stretchEquity(state, player);
            if (eq.tiles.length) {
                stretch = eq;
                maxWill = Math.max(maxWill,
                    Math.min(value, player.cash + eq.total - floor * 0.25));
            }
        }

        // Sharp CPUs bluff-bid to drain a rival, bounded well below their max
        const p = this._params(player);
        if (p.auctionSmarts >= 1 && a.currentWinner !== null && a.currentWinner !== player.id) {
            const rival = state.players[a.currentWinner];
            const rivalValue = Evaluator.propertyValue(state, a.tileId, rival.id);
            if (rivalValue > value && RNG.float(state) < 0.3) {
                maxWill = Math.min(player.cash * 0.5, rivalValue * 0.7);
            }
        }

        // Coherence guard (game mry2sj9x): an auction only starts from a
        // decline, so a bidder who is the decliner already judged this tile
        // not worth its list price on the buy path — where the d5 lookahead
        // rollout and the FULL cash floor apply. This bid path consults
        // neither (it reserves only floor*0.5), so without this it can bid
        // PAST the list price and win the very tile it just refused
        // ("decline at $140, then pay $161"). Cap the decliner at list price —
        // unless the tile completes its OWN set, which is worth stretching
        // past face for (a plain single or a pure block is not).
        const aTile = BOARD[a.tileId];
        const completesMine = aTile.group && !['railroad', 'utility'].includes(aTile.group) &&
            Rules.countOwnedInGroup(state, player.id, aTile.group) === GROUP_META[aTile.group].size - 1;
        if (a.declinedBy === player.id && !completesMine) {
            maxWill = Math.min(maxWill, aTile.price);
        }

        // Leader-denial block-bidding (knob evaluator.auctionBlockValue, def 0=off;
        // ≥3 active players; skill-scaled). The shared propertyValue already prices
        // blocking a one-away opponent, but FLAT — no skill term, no leader weight,
        // so d3=d4=d5 and it doesn't grow with the field (analysis §10). Here a sharp
        // CPU in a multi-player field ESCALATES its ceiling to deny the tile that
        // would COMPLETE a LEADING opponent's set, up to a bounded slice of the value
        // they'd gain × how far ahead they are. Placed AFTER the decliner cap: unlike
        // buying it for myself, denying a runaway leader justifies bidding past face
        // even having declined. Bounded (≤70% cash, keep ¼ floor) and leader-weighted,
        // so it is NOT the removed auction-STEAL bug (unbounded win-for-self). Null at
        // 2p (no field to lead → protects the P2/P3 heads-up wins).
        const blockK = window.AITuning ? AITuning.get('evaluator.auctionBlockValue', 0) : 0;
        if (blockK > 0 && !completesMine && this._skill(player) >= 0.5 &&
            GameState.activePlayers(state).length >= 3 &&
            aTile.group && !['railroad', 'utility'].includes(aTile.group)) {
            const size = GROUP_META[aTile.group].size;
            let denyBonus = 0;
            for (const opp of GameState.activePlayers(state)) {
                if (opp.id === player.id) continue;
                if (Rules.countOwnedInGroup(state, opp.id, aTile.group) !== size - 1) continue;
                const groupValue = Rules.tilesInGroup(aTile.group).reduce((s, id) => s + BOARD[id].price, 0);
                const bonus = groupValue * (0.4 + 0.6 * Evaluator.exploitability(state, opp.id, aTile.group)) *
                    Evaluator._leadFactor(state, opp.id) * this._skill(player) * blockK;
                if (bonus > denyBonus) denyBonus = bonus;
            }
            if (denyBonus > 0) {
                const ceiling = Math.min(value + denyBonus, player.cash * 0.7, player.cash - floor * 0.25);
                if (ceiling > maxWill) {
                    this._trace(state, `${player.name} — block-bids to deny a leading rival the ${aTile.group} set at auction.`);
                    maxWill = ceiling;
                }
            }
        }

        // Already leading yet asked to bid (everyone else passed): a winner's
        // pass accepts the standing bid, ending the auction. Never return null
        // here - the pump would stall with no one left to act.
        if (player.id === a.currentWinner) return { type: 'AUCTION_PASS', playerId: player.id };
        const step = a.currentBid < 100 ? 10 : (a.currentBid < 300 ? 25 : 50);
        const reach = player.cash + (stretch ? stretch.total : 0);
        const nextBid = Math.min(a.currentBid + step, reach);
        if (nextBid > a.currentBid && nextBid <= maxWill) {
            // Raise the cash before raising the bid: the engine lets the
            // current bidder mortgage mid-auction, then re-asks for a bid.
            if (nextBid > player.cash && stretch) {
                return { type: 'MORTGAGE', tileId: stretch.tiles[0], playerId: player.id };
            }
            return { type: 'AUCTION_BID', playerId: player.id, amount: nextBid };
        }
        return { type: 'AUCTION_PASS', playerId: player.id };
    },

    /* ==================== TRADING ==================== */

    /**
     * Settings-driven trade behavior (Settings modal → DEV.*). Headless runs
     * without the settings UI fall back to normal / fair / counters on.
     */
    _tradeConfig() {
        const dev = (typeof window !== 'undefined' && window.DEV) || {};
        const ACTIVITY = { off: 0, rare: 0.4, normal: 1, eager: 2.2 };
        const FLEX = {
            strict:   { marginMul: 1.0, handoverPenalty: 1.2 },
            fair:     { marginMul: 1.0, handoverPenalty: 0.85 },
            generous: { marginMul: 0.5, handoverPenalty: 0.55 }
        };
        const activity = ACTIVITY[dev.tradeActivity] !== undefined ? ACTIVITY[dev.tradeActivity] : 1;
        const flex = FLEX[dev.tradeFlex] || FLEX.fair;
        const counters = dev.cpuCounters !== undefined ? !!dev.cpuCounters : true;
        return { activity: activity, marginMul: flex.marginMul, handoverPenalty: flex.handoverPenalty, counters: counters };
    },

    /** Margin (per $1 of trade scale) a responder likely demands on top of neutral. */
    _respondMargin(state, otherId, cfg) {
        const other = state.players[otherId];
        const margin = other.isCPU ? this._params(other).tradeMargin : 0.05;
        return margin * cfg.marginMul;
    },

    // Deal size for proportional margins: the VALUE of goods changing hands,
    // not the cash. Cash carries no valuation uncertainty, so counting it
    // makes the demanded margin balloon on a cash-heavy ask - a proposer
    // prices its opening bid with cash still 0 (scale = property value), but
    // a responder prices its counter with the cash filled in (scale ~4x),
    // so the counter demands a bigger cushion and lands BELOW the opening.
    // Excluding cash keeps both paths on the same basis.
    _tradeScale(offer) {
        return Math.max(200,
            offer.give.properties.concat(offer.get.properties)
                .reduce((sum, id) => sum + BOARD[id].price, 0));
    },

    /**
     * Archetype disposition folded into an incoming offer's value - the
     * response path is otherwise personality-blind (it sees only difficulty
     * and the flex setting). Reluctant sellers demand more to give up a deed
     * (hoarder 1.5, cautious 1.2); eager traders shave (0.8). Acquisitive
     * archetypes pay up for deeds they gain (buyBias). The per-game group
     * bias is honored too, so a CPU that overvalues a color trades for it at
     * the same price it would pay the bank. Mirrors the proposal side
     * (_proposeSellSpare's sellReluctance temperament, _value's groupBias).
     */
    _responseTemperament(state, player, offer, publicOnly) {
        const w = Personalities.weights(player);
        const gain = offer.from === player.id ? offer.get : offer.give;
        const lose = offer.from === player.id ? offer.give : offer.get;
        // publicOnly: a proposer modelling this responder sees its archetype,
        // not its private per-game colour bias.
        const bias = id => publicOnly ? 1 : (player.personality.groupBias[BOARD[id].group] || 1);
        let t = 0;
        lose.properties.forEach(id => {
            t -= BOARD[id].price * 0.3 * (w.sellReluctance - 1);   // reluctant to part with it
            t -= BOARD[id].price * 0.2 * (bias(id) - 1);           // and more so if I overvalue it
        });
        gain.properties.forEach(id => {
            t += BOARD[id].price * 0.2 * (w.buyBias - 1);          // acquisitive archetypes pay up
            t += BOARD[id].price * 0.2 * (bias(id) - 1);           // as do lovers of this color
        });
        return t;
    },

    /** True if the offer hands `pid` a colour set they don't already own. */
    _completesSetFor(state, offer, pid) {
        const after = Evaluator._ownershipAfter(state, offer);
        return Object.keys(GROUP_META).some(g => {
            if (g === 'railroad' || g === 'utility') return false;
            const ids = Rules.tilesInGroup(g);
            return ids.every(id => after[id] === pid) &&
                !ids.every(id => Rules.getOwner(state, id) === pid);
        });
    },

    _tradeRespond(state, player) {
        const offer = state.trade;
        const p = this._params(player);
        const cfg = this._tradeConfig();
        const rawUtility = Evaluator.tradeUtility(state, offer, player.id,
            { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) }) +
            this._prospectUtility(state, player, offer) +
            this._responseTemperament(state, player, offer);
        const utility = rawUtility * (1 + RNG.gauss(state, 0, p.noise));
        this._traceRace(state, player, offer);

        // Scale: total value changing hands, so the margin is proportional
        const scale = this._tradeScale(offer);
        const threshold = p.tradeMargin * cfg.marginMul * scale;

        let accept = utility > threshold;
        if (this._blunders(state, player)) accept = !accept;
        const from = state.players[offer.from].name;

        // Rollout gate on property-bearing offers: a decisive accept takes
        // the deal the margin math undervalued; a decisive reject overrides
        // only a heuristic accept — otherwise fall through so the counter
        // path stays intact.
        if (p.lookahead && window.Lookahead &&
            offer.give.properties.length + offer.get.properties.length > 0) {
            const pick = Lookahead.choose(state, player.id, [
                { type: 'ACCEPT_TRADE', playerId: player.id },
                { type: 'REJECT_TRADE', playerId: player.id }
            ]);
            const wantsAccept = pick && pick.type === 'ACCEPT_TRADE';
            // The ACCEPT override is meant to rescue a deal the margin math
            // slightly UNDER-valued — not to gift real value away. When the
            // heuristic decisively rejects (utility far below threshold), a
            // rollout that returns ACCEPT is almost always failing to tell a
            // trivial-asset handover apart from a hold and defaulting to
            // accept; don't let it flip a clear reject into handing a deed over
            // for nothing (memory degenerate-counter-offer-wart, mshmqone t98).
            let giveawayOverride = wantsAccept && !accept &&
                utility < threshold - scale * 0.5;
            // The rollout score is blind to what a completed set earns past
            // its ~4-turn horizon (deeds at face + 0.5x set bonus), so it
            // reads "I get more face value, you get a monopoly" as a win.
            // With the veto on, it may not flip a heuristic reject when the
            // offer completes a colour set for the proposer (game mud9g25d
            // t193: d5 Ira handed T red via "lookahead overrides").
            // 1 = any proposer; 2 = human proposers only (CPUs don't probe
            // the override band, and all-CPU play then stays unchanged).
            const veto = window.AITuning ? AITuning.get('evaluator.lookaheadHandoverVeto', 2) : 2;
            if (wantsAccept && !accept && veto &&
                (veto === 1 || !state.players[offer.from].isCPU) &&
                this._completesSetFor(state, offer, offer.from)) giveawayOverride = true;
            if (pick && (wantsAccept || accept) && !giveawayOverride) {
                this._trace(state, `${player.name} — lookahead ${wantsAccept === accept ? 'confirms' : 'overrides to'} ` +
                    `${wantsAccept ? 'accept' : 'reject'} (utility ${utility.toFixed(2)} vs ${threshold.toFixed(2)}).`);
                return pick;
            }
        }
        if (accept) {
            this._trace(state, `${player.name} accepts ${from}'s trade (utility ${utility.toFixed(2)} vs ${threshold.toFixed(2)}).`);
            return { type: 'ACCEPT_TRADE', playerId: player.id };
        }

        // Counter instead of rejecting when the gap is bridgeable. Try the
        // cheap fix first — ask the proposer for more cash — then fall back to
        // pulling one of their spare deeds when cash alone can't (or won't) do
        // it (typically a cash-poor package proposer).
        if (cfg.counters && offer.counters < 3 && this._skill(player) >= 0.25) {
            const deficit = threshold - rawUtility;
            if (deficit > 0) {
                if (deficit < scale * 0.5) {
                    const cash = this._cashCounter(state, player, offer, deficit, scale);
                    if (cash) {
                        this._trace(state, `${player.name} counters ${from} for cash (utility ${rawUtility.toFixed(2)} short of ${threshold.toFixed(2)}).`);
                        return cash;
                    }
                }
                const deed = this._deedCounter(state, player, offer, cfg);
                if (deed) {
                    this._trace(state, `${player.name} counters ${from} for a deed (utility ${rawUtility.toFixed(2)} short of ${threshold.toFixed(2)}).`);
                    return deed;
                }
            }
        }
        this._trace(state, `${player.name} rejects ${from}'s trade (utility ${utility.toFixed(2)} vs ${threshold.toFixed(2)}).`);
        return { type: 'REJECT_TRADE', playerId: player.id };
    },

    /** Same-deeds counter: keep the property structure, ask the proposer to pay
     *  enough more cash to clear my threshold plus a small skim (sharper CPUs
     *  skim more). Null when the proposer can't afford the resulting cash. */
    _cashCounter(state, player, offer, deficit, scale) {
        const skim = scale * 0.03 * (0.5 + this._skill(player));
        const extra = Math.ceil((deficit + skim) / 10) * 10;
        const counter = {
            from: player.id,
            to: offer.from,
            give: { cash: offer.get.cash, properties: offer.get.properties.slice(), jailCards: offer.get.jailCards },
            get: { cash: offer.give.cash + extra, properties: offer.give.properties.slice(), jailCards: offer.give.jailCards }
        };
        // Collapse cash flowing both ways into a single net figure. Mirroring
        // the prior offer leaves cash on both sides, and successive counters
        // accumulate it into nonsensical offers ("gives $580, gets Kentucky +
        // $210" instead of "$370 for Kentucky"). A trade never needs cash
        // moving in both directions.
        const netCash = counter.get.cash - counter.give.cash;
        counter.get.cash = Math.max(0, netCash);
        counter.give.cash = Math.max(0, -netCash);
        if (counter.get.cash <= state.players[offer.from].cash &&
            Trading.validate(state, counter).ok) {
            return { type: 'COUNTER_TRADE', playerId: player.id, offer: counter };
        }
        return null;
    },

    /**
     * Deed-augmented counter (d3+): the offer falls short of my margin and a
     * pure-cash counter is infeasible — usually a cash-poor package proposer,
     * so "pay me more" dies. Pull one of THEIR spare deeds into what I receive
     * (least-disruptive first) and let _zopaCash settle the residual cash,
     * reusing phase-1 pricing so the counter still clears both margins. Passing
     * my prospect + temperament as the bonus keeps the counter's valuation in
     * step with how I'd re-judge it on a bounce-back. The engine's 3-counter
     * cap bounds the exchange, so no snub is needed.
     */
    _deedCounter(state, player, offer, cfg) {
        if (this._skill(player) < 0.5) return null;
        // give.properties is copied verbatim from what the proposer demanded;
        // never build a counter that hands over one of MY own set-pieces (a
        // color I'm one/two-away on). Pricing usually kills these post-fix,
        // but refuse structurally too so we don't reshuffle away a scheme for
        // a big enough cash sweetener (game mrtqw1oj: Morgan giving Atlantic).
        const mySchemed = this._schemedTiles(state, player.id);
        if (offer.get.properties.some(id => mySchemed.has(id))) return null;
        const inPlay = new Set(offer.give.properties.concat(offer.get.properties));
        const schemed = this._schemedTiles(state, offer.from); // don't strip THEIR sets
        const spares = GameState.propertiesOf(state, offer.from)
            .filter(id => !inPlay.has(id))
            .filter(id => {
                const g = BOARD[id].group;
                return !(g && Rules.ownsFullGroup(state, offer.from, g)) && !schemed.has(id);
            })
            .sort((a, b) =>
                Evaluator.propertyValue(state, a, player.id) -
                Evaluator.propertyValue(state, b, player.id));
        for (const deedId of spares) {
            const counter = {
                from: player.id,
                to: offer.from,
                give: { cash: 0, properties: offer.get.properties.slice(), jailCards: offer.get.jailCards },
                get: { cash: 0, properties: offer.give.properties.concat(deedId), jailCards: offer.give.jailCards }
            };
            const bonus = this._prospectUtility(state, player, counter) +
                this._responseTemperament(state, player, counter);
            const cash = this._zopaCash(state, player, counter, cfg, bonus);
            if (cash === null) continue; // this deed can't bridge — try the next
            if (cash > 0) counter.give.cash = cash;
            else counter.get.cash = -cash;
            if (!Trading.validate(state, counter).ok) continue;
            this._tracePricing(state, player, counter, 'Counter');
            return { type: 'COUNTER_TRADE', playerId: player.id, offer: counter };
        }
        return null;
    },

    _maybeProposeTrade(state, player) {
        const cfg = this._tradeConfig();
        if (cfg.activity === 0) return null;
        const w = Personalities.weights(player);
        // Per-turn proposal budget. The engine enforces a hard `tradeLimit`
        // (state.tradeLimit) per player per turn, shared with humans. A CPU
        // used to self-limit to a SINGLE proposal (`lastTradeTurn`), leaving
        // that budget — and the deep generators (broker/package/sell) that only
        // fire once the earlier chain comes up empty — mostly untapped. Allow up
        // to `min(tradeLimit, cpuMax)` proposals per turn; the extra ones are on
        // decaying odds (below) so a CPU turn reads as busier, not a modal
        // firehose, and distinctness is handled by the generators' own per-turn
        // _snubbed side-effect (an already-tried shape is skipped this turn, so
        // attempt #2 falls deeper into the chain instead of re-offering the same
        // deal). Gating on tradeAttempts — the engine's authoritative per-turn
        // counter — means the CPU never emits a proposal the engine would reject
        // (a rejected action stalls the turn: dispatch doesn't re-pump).
        const cpuMax = window.AITuning ? AITuning.get('evaluator.cpuMaxProposalsPerTurn', 2) : 2;
        const engineLimit = state.tradeLimit !== undefined ? state.tradeLimit : 2;
        const budget = Math.min(engineLimit, cpuMax);
        const used = (state.tradeAttempts && state.tradeAttempts[player.id]) || 0;
        if (used >= budget) return null;
        let frequency = Math.min(0.9, w.tradeFrequency * (0.5 + 0.5 * this._skill(player)) * cfg.activity);
        // Distress overrides temperament: a monopoly waiting on cash justifies
        // shopping a spare deed around even for trade-shy archetypes.
        if (frequency < 0.4 && this._skill(player) >= 0.5 && this._starvedBuild(state, player)) {
            frequency = 0.4;
        }
        // Monopoly-move override: a skilled CPU shouldn't let a reluctant
        // archetype (hoarder/cautious) sit on an obvious set deal — being one
        // tile from a set (a completion to broker) or holding fodder for a
        // colour it's collecting (a consolidation to propose). Raise the gate
        // so the deal actually gets attempted; the generator chain still
        // decides whether a sound offer exists, and _snubbed stops re-nagging.
        // Knob-controlled (0 = off: reluctant archetypes keep their base rate).
        const setMoveNudge = window.AITuning ? AITuning.get('evaluator.setMoveNudge', 0.85) : 0.85;
        if (frequency < setMoveNudge && this._skill(player) >= 0.5) {
            const assign = this._assignTargets(state);
            const hasSetMove = this._oneAwayGroups(state, player.id).length > 0 ||
                (this._targetGroupsFor(state, player.id, assign).size > 0 &&
                    this._straysFor(state, player.id, assign).length > 0);
            if (hasSetMove) frequency = setMoveNudge;
        }
        // Decaying odds on each proposal beyond the first: a 2nd+ attempt only
        // sometimes fires, so maxing the budget is the exception. The first
        // proposal (used === 0) uses the full nudged frequency, unchanged.
        if (used > 0) {
            const decay = window.AITuning ? AITuning.get('evaluator.extraProposalOdds', 0.5) : 0.5;
            frequency *= Math.pow(decay, used);
        }
        if (RNG.float(state) > frequency) return null;

        // First generator with an offer wins (same order as the old || chain);
        // its name goes into the pricing trace.
        const GENERATORS = ['SetSwap', 'CashForSet', 'ConsolidationSwap', 'BuyPair', 'BuyToward',
            'EntryBuy', 'Broker', 'Package', 'SellSpare', 'CashOut'];
        let offer = null, gen = null;
        for (const g of GENERATORS) {
            offer = this['_propose' + g](state, player, cfg);
            if (offer) { gen = g; break; }
        }
        this._traceNoTrade(state, player, !offer);
        if (!offer) return null;
        const decision = { type: 'PROPOSE_TRADE', offer: offer };

        // Rollout gate on the PROPOSAL itself (d5, HEADS-UP only). The heuristic
        // chain above chose this offer on a myopic utility read; the lookahead —
        // which otherwise has ZERO influence on trade GENERATION (it only ever
        // gated buy/decline and accept/reject) — plays "propose it" vs "just roll
        // on" several turns forward and suppresses the offer only when rolling on
        // scores decisively higher (it catches the tradeUtility myopia of handing
        // a rival the tile that completes ITS set faster than mine). The
        // wealth-share `Lookahead.score` is unchanged on purpose: P1 proved
        // re-scoring an already-gated decision isn't the lever, so P2 aims the
        // same estimator at the untouched proposal surface.
        //   Restricted to ≤2 active players by the two-seed × 3-ruleset A/B:
        //   a clean +8.5pp d5 win% at 2p (capWin corroborated, mono/srv + dev
        //   held, 0 violations) but a −0.9pp wash-to-slight-negative at 5p —
        //   the lookahead's leverage dilutes with player count (analysis doc
        //   finding #2), so beyond heads-up the gate just suppressed proposals
        //   without converting them to d5 wins. `activePlayers` (not seat count)
        //   means a larger game that attrites to a 1v1 endgame re-enables it,
        //   which is exactly where it pays. Knob `evaluator.lookaheadProposalGate`
        //   (1=on, 0=off) still forces it off for A/B.
        const p = this._params(player);
        const gateOn = (window.AITuning ? AITuning.get('evaluator.lookaheadProposalGate', 1) : 1) > 0 &&
            GameState.activePlayers(state).length <= 2;
        if (gateOn && p.lookahead && window.Lookahead) {
            const pick = Lookahead.choose(state, player.id,
                [decision, { type: 'ROLL_DICE' }]);
            if (pick && pick.type !== 'PROPOSE_TRADE') {
                this._trace(state, `${player.name} — lookahead holds back a trade to ${state.players[offer.to].name} (rolls on instead).`);
                return null;
            }
            if (pick) {
                this._trace(state, `${player.name} — lookahead endorses the trade to ${state.players[offer.to].name}.`);
            }
        }
        this._tracePricing(state, player, offer, gen);
        return decision;
    },

    /**
     * Distress sale (d3+): a buildable monopoly is waiting, but cash AND
     * spare mortgage equity are exhausted — sell a spare single to an
     * opponent for cash and fund houses with the proceeds. Last resort in
     * the proposal chain; sellReluctance tempers how cheap the CPU goes.
     */
    _proposeCashOut(state, player, cfg) {
        if (this._skill(player) < 0.5) return null;
        const starved = this._starvedBuild(state, player);
        if (!starved) return null;
        if (this._stretchEquity(state, player).total >= starved.houseCost) return null; // mortgage first
        const w = Personalities.weights(player);
        const spares = GameState.propertiesOf(state, player.id)
            .filter(id => {
                const g = BOARD[id].group;
                return !(g && Rules.ownsFullGroup(state, player.id, g));
            })
            .sort((a, b) =>
                Evaluator.propertyValue(state, a, player.id) -
                Evaluator.propertyValue(state, b, player.id));
        // The hidden upside of the sale: it unlocks the stalled build-out
        const desperation = starved.houseCost * 0.75 / w.sellReluctance;
        for (const tileId of spares) {
            const buyers = GameState.activePlayers(state)
                .filter(o => o.id !== player.id)
                .sort((a, b) => b.cash - a.cash);
            for (const other of buyers) {
                const offer = {
                    from: player.id,
                    to: other.id,
                    give: { cash: 0, properties: [tileId], jailCards: 0 },
                    get: { cash: 0, properties: [], jailCards: 0 }
                };
                const cash = this._zopaCash(state, player, offer, cfg, desperation);
                if (cash === null || cash >= 0) continue; // only sales where THEY pay
                offer.get.cash = -cash;
                // A sale that nets less than the deed's mortgage value is
                // pointless (mortgaged spares just need to net anything real)
                const minNet = state.tiles[String(tileId)].mortgaged ? 30 : Rules.mortgageValue(tileId);
                if (offer.get.cash <= minNet) continue;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._snubbed(state, player, `cashout:${other.id}:${tileId}`)) continue;
                return offer;
            }
        }
        return null;
    },

    /** Don't nag: the same ask (same counterparty + tile) is re-proposed at
     *  most once every 10 turns. Stamped at proposal time; an accepted trade
     *  changes ownership so its key never recurs. */
    _snubbed(state, player, key) {
        player.tradeSnubs = player.tradeSnubs || {};
        const last = player.tradeSnubs[key];
        if (last !== undefined && state.turnNumber - last < 10) return true;
        player.tradeSnubs[key] = state.turnNumber;
        return false;
    },

    /** Real refusal ledger (distinct from the per-SHAPE _snubbed cooldown):
     *  once an owner has said no to buying a given tile enough times, stop
     *  re-proposing for that (owner, tile) through ANY offer shape and free
     *  the one-proposal-per-turn budget for an achievable line — a gated
     *  generator returns null, so the proposal chain falls through to the
     *  consolidation / two-away generators it used to starve. The ledger is
     *  written by TurnEngine on REJECT_TRADE (keyed `${ownerId}:${tileId}`,
     *  shape-independent) so rotating cash/package/swap variants can't dodge
     *  it. Escalating backoff then a hard cap; re-opens on owner distress.
     *  Cap 0 = off: behaves exactly like the pre-ledger code. */
    _refusedRecently(state, player, ownerId, tileId) {
        const cap = window.AITuning ? AITuning.get('evaluator.tradeRefusalCap', 0) : 0;
        if (cap <= 0) return false;                            // feature off
        const r = player.tradeRefusals && player.tradeRefusals[`${ownerId}:${tileId}`];
        if (!r) return false;
        if (this._ownerMightSell(state, ownerId)) return false; // distress re-opens it
        const base = window.AITuning ? AITuning.get('evaluator.tradeRefusalBackoff', 12) : 12;
        // Exponential backoff with no hard stop (E50): wait base × 2^(n-1)
        // after the n-th no, capped at 8× base, so a holder's circumstances
        // can still change and a deedless CPU keeps an occasional ask alive
        // (mv2jir3q: Lane's only re-entry line). The cap then only switches
        // the ledger on. 0 = the old escalate-then-stop schedule.
        if (window.AITuning ? AITuning.get('evaluator.tradeRefusalExp', 1) : 1) {
            return state.turnNumber - r.turn < base * Math.min(8, 2 ** (r.count - 1));
        }
        if (r.count >= cap) return true;                       // given up for good
        const backoff = r.count >= 2 ? Math.round(base * 2.5) : base; // 1st no → base, 2nd+ → 2.5×
        return state.turnNumber - r.turn < backoff;
    },

    /** An owner scraping the bottom of its cash, or already settling a debt,
     *  may finally part with a blocker — worth re-asking despite past nos.
     *  Deliberately coarse (a flat threshold, not a per-owner reserve calc)
     *  so it holds for human owners too. */
    _ownerMightSell(state, ownerId) {
        const o = state.players[ownerId];
        if (!o || o.bankrupt) return false;
        if (state.debt && state.debt.debtorId === ownerId) return true;
        return o.cash < 75;
    },

    /** Groups where `playerId` owns all but one house-free tile (colors plus
     *  railroads; utilities are never worth scheming toward); returns
     *  [{ group, missing, ownerId }] for tiles held by another active player. */
    _oneAwayGroups(state, playerId) {
        const out = [];
        for (const group of ['orange', 'red', 'lightblue', 'yellow', 'pink', 'darkblue', 'green', 'brown', 'railroad']) {
            const ids = Rules.tilesInGroup(group);
            if (ids.some(id => Rules.houseCount(state, id) > 0)) continue;
            const mine = ids.filter(id => Rules.getOwner(state, id) === playerId);
            if (mine.length !== GROUP_META[group].size - 1) continue;
            const missing = ids.find(id => !mine.includes(id));
            const ownerId = Rules.getOwner(state, missing);
            if (ownerId === null || ownerId === playerId) continue;
            if (state.players[ownerId].bankrupt) continue;
            out.push({ group: group, missing: missing, ownerId: ownerId });
        }
        return out;
    },

    /**
     * Pick a cash sweetener that lands inside the zone of agreement: enough
     * that the responder should accept, little enough that the trade is still
     * good for me. Positive = I pay, negative = they pay. Returns null when
     * no such price exists (then the trade is not worth proposing).
     * myBonus: extra utility only the proposer sees (e.g. set prospects).
     */
    _zopaCash(state, player, offer, cfg, myBonus) {
        const myU0 = Evaluator.tradeUtility(state, offer, player.id,
            { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) }) + (myBonus || 0);
        // Price the responder the way it will actually judge: a CPU answers at
        // its OWN skill (the leader-aware handover penalty and mutual damping
        // scale with it), as _respondMargin already assumes. The flat 0.75
        // default over-priced weak CPUs — d5 Zane paid $490 for a swap d2
        // Frankie would have taken for ~$0 (game mungupgq t64) — and
        // under-priced d5 responders. Humans keep the 0.75 read.
        const other = state.players[offer.to];
        const theirOpts = { handoverPenalty: cfg.handoverPenalty };
        const modelSkill = window.AITuning ? AITuning.get('evaluator.zopaResponderSkill', 1) : 1;
        if (modelSkill && other.isCPU) theirOpts.skill = this._skill(other);
        // Level 2: also the rest of what _tradeRespond adds — the responder's
        // set-prospect bonus and its archetype temperament (public part only).
        // Level 1 alone under-priced weak CPUs' asks: accept rates on offers to
        // d1-d3 fell 4-8pp in the E42 A/B (20260930-0301).
        const theirExtra = (modelSkill >= 2 && other.isCPU)
            ? this._prospectUtility(state, other, offer) + this._responseTemperament(state, other, offer, true)
            : 0;
        const theirU0 = Evaluator.tradeUtility(state, offer, offer.to, theirOpts) + theirExtra;
        const scale = this._tradeScale(offer);
        const myMargin = this._params(player).tradeMargin * cfg.marginMul * scale;
        const theirMargin = this._respondMargin(state, offer.to, cfg) * scale;

        let low = theirMargin - theirU0;              // least I can pay and still be accepted
        let high = myU0 - myMargin;                   // most I can pay and still profit
        low = Math.max(low, -(other.cash * 0.8));     // they can only pay what they have
        high = Math.min(high, player.cash - this._floor(state, player) * 0.5);

        // myU0 credited any set-completing tile I'd GAIN at its full build-out
        // premium — but priced with give.cash still 0, i.e. as if the cash I'm
        // about to spend were still in hand. Evaluator.completionMul scales that
        // premium by cashAfter, so paying `high` collapses it: an undevelopable
        // monopoly I strip-mortgage and die on (game msfec7ac: Hollis proposed
        // $1220 for Park Place, then never built dark blue). Re-price `high` at
        // the actual outlay so the propose path keeps the buy-path
        // _canFundFirstBuild discipline (memory proposal-completion-premium-
        // unfunded; two-valuation-copies-drift: dock the shared premium, don't
        // fork the valuation). Fixed-point iterate — cheap, 2-3 steps.
        const exact = window.AITuning ? AITuning.get('evaluator.zopaExactCash', 2) : 2;
        // Full exact zone toward CPU partners at level 2, everyone at level 3;
        // a human partner below level 3 gets the price-only form (level 1).
        const fullExact = exact >= 3 || (exact === 2 && other.isCPU);
        if (!fullExact && high > 0 && offer.get.properties.length) {
            const skill = this._skill(player);
            const gainAt = c => offer.get.properties.reduce((s, id) =>
                s + Evaluator.propertyValue(state, id, player.id,
                    { cashAfter: player.cash - c, skill, tradePartner: offer.to, tradeSide: 'gain' }), 0);
            const gain0 = gainAt(0);
            for (let i = 0; i < 3; i++) {
                const drop = gain0 - gainAt(Math.max(0, high));
                if (drop <= 1) break;
                const next = (myU0 - drop) - myMargin;
                if (next >= high - 1) break;
                high = next;
            }
        }
        // Exact-cash zone (E46). Both utilities above were taken at $0 and
        // extrapolated as if every dollar moved them by one dollar, but
        // tradeUtility is steeper than that in cash: the liquidity penalty
        // once cashAfter drops below the floor (x1.2), the enemy-fuel charge
        // on cash handed to a player with a buildable set (x0.5), and the
        // completion premium shrinking with what I have left to build with.
        // Game muwp487y t106: d4 Kai offered $760 + Connecticut for Park Place
        // to a $62 human with built pinks — its own tradeUtility for the deal
        // was -485 (break-even ~$530), and the human's modelled accept point
        // was ~$450, not the linear ~$706. Solve each edge on the real curve
        // instead (my utility falls in c, theirs rises; c > 0 = I pay).
        // Subsumes the E29 fixed-point above, which re-priced only the gained
        // tile's value. Level 1 applies only toward a HUMAN partner and only
        // to the price (below). Level 2 (default) also takes the zone as
        // solved toward CPU partners (A/B 2026-10-06, E47 run: d5 win +0.5/
        // +0.1/+0.4 at 5p/6p/8p, capWin +1.5 at 8p in 9/9 cells, no dev%
        // loss) while humans keep the price-only form. Level 3 = solved zone
        // for humans too (not A/B-able: humans are absent from sims). 0 = the
        // old linear zone.
        const exactHere = fullExact || (exact >= 1 && !other.isCPU);
        let usedExact = false;
        if (exactHere) {
            const zone = this._exactZone(state, player, offer, cfg, myBonus, theirOpts, theirExtra,
                myMargin, theirMargin, Math.round(theirMargin - theirU0));
            if (fullExact) {
                if (!zone) return null;
                low = zone.low; high = zone.high; usedExact = true;
            } else if (zone && zone.high - zone.low >= scale * 0.1) {
                // Level 1 is price-only: the same deals get proposed, but where
                // the real curve shows I was overpaying I pay its (lower)
                // price, and I never ask a person for less than the old ask.
                // An empty/thin real zone falls back to the old linear zone —
                // dropping deals my evaluator calls marginal is a strategy
                // change (E46 replay: it cut ms93ug2p t139, part of d5 Sage's
                // winning line); CPU partners get that at level 2 (A/B'd).
                const l = Math.min(low, zone.low), h = Math.min(high, zone.high);
                if (h - l >= scale * 0.1) { low = l; high = h; usedExact = true; }
            }
        }
        // A razor-thin zone gets rejected by decision noise anyway — don't
        // propose unless there is real room for both sides to feel good.
        if (high - low < scale * 0.1) return null;

        // Sharp CPUs pay near the bottom of the zone; naive ones drift upward
        const spot = 0.15 + (1 - this._skill(player)) * 0.4 * RNG.float(state);
        const frac = Math.min(1, Math.max(0, spot + RNG.gauss(state, 0, this._params(player).noise * 0.3)));
        const cash = Math.round((low + (high - low) * frac) / 10) * 10;
        // Kept for the pricing trace (_tracePricing) so a replay can check the
        // zone it rebuilds against the one actually used. Keyed by the offer
        // object the generator goes on to return; never read by decisions.
        if (this._pricing) this._pricing.set(offer, {
            low: low, high: high, frac: frac, cash: cash, has: player.cash,
            bonus: myBonus || 0, exact: usedExact });
        return cash;
    },

    /**
     * Log how a proposed/countered offer's cash leg was priced (category
     * 'ai'): the generator, the zone, where in it the CPU landed, and its cash
     * at that moment. Decision replays (review-games trade_replay.js) read
     * this line to reproduce the decision exactly — the per-turn snapshots
     * miss mid-turn cash and the zone's random draw. Format is parsed; keep
     * it stable: "<name> — prices trade to <name> [<gen>]: zone $L..$H,
     * spot F -> $C (cash $X, bonus B, linear|exact)." / "... [<gen>]:
     * unpriced (cash $X)." C > 0 = the CPU pays.
     */
    /** E49: one decision-trace line when the development-race charge moved a
     *  trade decision (the respond path, or a priced proposal/counter). */
    /**
     * Log (category 'ai') when a skilled CPU one tile from a set runs the
     * whole generator chain and finds no offer, so a review can tell "tried,
     * no deal" from "never tried" (game mva3ubxf: d5 Sage sat one-away on
     * yellow for ~210 silent turns). Throttled per player: logs once per
     * episode, again only when the one-away groups or their blockers change;
     * a found offer ends the episode. Logging only, never read by decisions.
     */
    _traceNoTrade(state, player, empty) {
        if (!empty) { player.noTradeTrace = null; return; }
        if (this._skill(player) < 0.5) return;
        const groups = this._oneAwayGroups(state, player.id);
        if (!groups.length) return;
        const key = groups.map(g => `${g.group}:${g.ownerId}`).join(',');
        if (player.noTradeTrace === key) return;
        player.noTradeTrace = key;
        const name = g => (GROUP_META[g] && GROUP_META[g].label) || g;
        this._trace(state, `${player.name} — no trade found (one-away: ` +
            groups.map(g => `${name(g.group)}, blocker ${state.players[g.ownerId].name}`).join('; ') + ').');
    },

    _traceRace(state, player, offer) {
        const race = Evaluator.raceCharge(state, offer, player.id, this._skill(player));
        if (!race) return;
        const lvl = l => (l === 5 ? 'hotels' : l === 0 ? 'no houses' : `${l} house${l > 1 ? 's' : ''}`);
        const other = state.players[race.otherId].name;
        const name = g => (GROUP_META[g] && GROUP_META[g].label) || g;
        const theirs = race.theirs.map(b => `${name(b.group)} to ${lvl(b.level)}`).join(', ');
        this._trace(state, `${player.name} — development race vs ${other}: my ${name(race.mine.group)} builds to ` +
            `${lvl(race.mine.level)} now, ${other}'s ${theirs} (rent gap $${race.gap.toFixed(1)}/turn x ` +
            `${race.opponents} opponents x ${race.rounds} rounds): -$${Math.round(race.charge)}.`);
    },

    _tracePricing(state, player, offer, gen) {
        const to = state.players[offer.to] ? state.players[offer.to].name : String(offer.to);
        const n = this._pricing && this._pricing.get(offer);
        const r = v => Math.round(v);
        this._traceRace(state, player, offer);
        this._trace(state, n
            ? `${player.name} — prices trade to ${to} [${gen}]: zone $${r(n.low)}..$${r(n.high)}, ` +
              `spot ${n.frac.toFixed(3)} -> $${n.cash} (cash $${n.has}, bonus ${r(n.bonus)}, ${n.exact ? 'exact' : 'linear'}).`
            : `${player.name} — prices trade to ${to} [${gen}]: unpriced (cash $${player.cash}).`);
    },

    /**
     * E46: the cash zone of an offer solved on the real tradeUtility curves
     * (c > 0 = I pay). low = least c the responder accepts, high = most c I
     * can pay and still profit; null when no c satisfies both. `guess` (the
     * linear estimate of low) only seeds the bracket.
     */
    _exactZone(state, player, offer, cfg, myBonus, theirOpts, theirExtra, myMargin, theirMargin, guess) {
        const other = state.players[offer.to];
        const mySkill = this._skill(player);
        const withCash = c => ({
            from: offer.from, to: offer.to,
            give: Object.assign({}, offer.give, { cash: (offer.give.cash || 0) + Math.max(0, c) }),
            get: Object.assign({}, offer.get, { cash: (offer.get.cash || 0) + Math.max(0, -c) })
        });
        const mine = c => Evaluator.tradeUtility(state, withCash(c), player.id,
            { handoverPenalty: cfg.handoverPenalty, skill: mySkill }) + (myBonus || 0) - myMargin;
        const theirs = c => Evaluator.tradeUtility(state, withCash(c), offer.to, theirOpts) +
            theirExtra - theirMargin;
        const cMin = -Math.round(other.cash * 0.8);
        const cMax = Math.round(player.cash - this._floor(state, player) * 0.5);
        if (cMax < cMin || theirs(cMax) < 0) return null;
        // least c they accept (their utility rises with c)
        let lo = cMin, hi = cMax;
        const g = Math.max(cMin, Math.min(cMax, guess));
        if (theirs(g) >= 0) hi = g; else lo = g;
        if (theirs(lo) >= 0) hi = lo;
        for (let i = 0; i < 9 && hi - lo > 5; i++) {
            const mid = (lo + hi) / 2;
            if (theirs(mid) >= 0) hi = mid; else lo = mid;
        }
        const low = hi;
        // most c I can pay and still profit (my utility falls with c)
        if (mine(low) < 0) return null;
        lo = low; hi = cMax;
        if (mine(hi) >= 0) lo = hi;
        for (let i = 0; i < 9 && hi - lo > 5; i++) {
            const mid = (lo + hi) / 2;
            if (mine(mid) >= 0) lo = mid; else hi = mid;
        }
        return { low: low, high: lo };
    },

    /** Win-win package: my set-completing tile for yours, cash to balance. */
    _proposeSetSwap(state, player, cfg) {
        for (const mine of this._oneAwayGroups(state, player.id)) {
            for (const theirs of this._oneAwayGroups(state, mine.ownerId)) {
                // Same group means we hold each other's blocker: swapping
                // them changes nothing and would be re-proposed forever
                if (theirs.group === mine.group) continue;
                if (Rules.getOwner(state, theirs.missing) !== player.id) continue;
                const offer = {
                    from: player.id,
                    to: mine.ownerId,
                    give: { cash: 0, properties: [theirs.missing], jailCards: 0 },
                    get: { cash: 0, properties: [mine.missing], jailCards: 0 }
                };
                const cash = this._zopaCash(state, player, offer, cfg);
                if (cash === null) continue;
                if (cash > 0) offer.give.cash = cash;
                else offer.get.cash = -cash;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._refusedRecently(state, player, mine.ownerId, mine.missing)) continue;
                if (this._snubbed(state, player, `swap:${mine.ownerId}:${mine.missing}:${theirs.missing}`)) continue;
                if (!this._tradeCompletionFundable(state, player, offer)) continue;
                return offer;
            }
        }
        return null;
    },

    /**
     * Discounted value of ending up one-away on a color group: a slice of the
     * completion premium, haircut by how gettable the last tile looks.
     * Measured conversion rates (20-game sample): last tile held by the same
     * counterparty ~100% (the one-away buy finishes it next turn), in the
     * bank ~30% (opponents snipe it), held by a third party ~30%.
     */
    _prospectBonus(group, lastOwner, otherId) {
        const groupValue = Rules.tilesInGroup(group).reduce((sum, id) => sum + BOARD[id].price, 0);
        let gettable;
        if (lastOwner === otherId) gettable = 0.6;
        else if (lastOwner === null || lastOwner === undefined) gettable = 0.25;
        else gettable = 0.15;
        // Rails carry a smaller completion premium (no hotel scaling), so
        // the prospect slice shrinks to match tradeUtility's 0.35 factor.
        const slice = group === 'railroad' ? 0.4 : 0.9;
        return groupValue * slice * gettable;
    },

    /**
     * Extra utility (sharp CPUs only, d3+) for offers whose gained tiles move
     * a color group from two-away to one-away — the "scheme toward a set"
     * value that plain tradeUtility doesn't see. Used both when proposing
     * such buys and when responding to them.
     */
    _prospectUtility(state, player, offer) {
        if (this._skill(player) < 0.5) return 0;
        const after = Evaluator._ownershipAfter(state, offer);
        const otherId = offer.from === player.id ? offer.to : offer.from;
        let bonus = 0;
        for (const group of Object.keys(GROUP_META)) {
            if (group === 'utility') continue;
            const ids = Rules.tilesInGroup(group);
            const size = GROUP_META[group].size;
            const before = ids.filter(id => Rules.getOwner(state, id) === player.id).length;
            const afterN = ids.filter(id => after[id] === player.id).length;
            if (afterN === size - 1 && before < size - 1) {
                const missing = ids.find(id => after[id] !== player.id);
                // Don't credit a completion prospect for a tile we're handing
                // to the counterparty in this very trade: giving away our own
                // last-needed tile doesn't make it "gettable" (0.6), it makes
                // it gone — the recipient has every reason to sit on the
                // blocker. Guards against paying cash to reshuffle within a
                // color while forfeiting the set-piece (game mrtqw1oj: Morgan,
                // a hoarder, offering Atlantic + $640 to hand T its own yellow).
                if (Rules.getOwner(state, missing) === player.id) continue;
                bonus += this._prospectBonus(group, after[missing], otherId);
            } else if (before === size - 1 && afterN < size - 1) {
                // Symmetric loss: giving up a piece of a set I'm one-away on
                // drops me back to two-away and forfeits that completion
                // prospect. Without this a one-away CPU happily sells an
                // assembled set-piece for a small premium and two players
                // ping-pong the same tile (game mrt8w40f, light-blue t31-t64).
                const missing = ids.find(id => Rules.getOwner(state, id) !== player.id);
                bonus -= this._prospectBonus(group, Rules.getOwner(state, missing), otherId);
            }
        }
        return bonus;
    },

    /** Groups where `playerId` is two tiles short (3-tile colors: owns one;
     *  railroads: owns two); returns [{ group, tileId, ownerId }] for each
     *  missing tile that another active player holds (candidates to buy
     *  toward the set). */
    _twoAwayGroups(state, playerId) {
        const out = [];
        for (const group of ['orange', 'red', 'lightblue', 'yellow', 'pink', 'green', 'railroad']) {
            const ids = Rules.tilesInGroup(group);
            if (ids.some(id => Rules.houseCount(state, id) > 0)) continue;
            const mine = ids.filter(id => Rules.getOwner(state, id) === playerId);
            if (mine.length !== GROUP_META[group].size - 2) continue;
            ids.forEach(tileId => {
                const ownerId = Rules.getOwner(state, tileId);
                if (ownerId === null || ownerId === playerId) return;
                if (state.players[ownerId].bankrupt) return;
                out.push({ group: group, tileId: tileId, ownerId: ownerId });
            });
        }
        return out;
    },

    /** Tiles I own that belong to a group I'm one- or two-away on — the
     *  set-pieces I'm actively assembling. Never spendable as package fodder
     *  (giving one back sabotages my own scheme); excluded from _proposePackage
     *  spares. Derived from the same detectors the buy generators use. */
    _schemedTiles(state, playerId) {
        const out = new Set();
        const add = group => Rules.tilesInGroup(group)
            .filter(id => Rules.getOwner(state, id) === playerId)
            .forEach(id => out.add(id));
        this._oneAwayGroups(state, playerId).forEach(g => add(g.group));
        this._twoAwayGroups(state, playerId).forEach(t => add(t.group));
        return out;
    },

    /** One opponent holds both missing tiles of a two-away group: offer cash
     *  for the pair outright (d3+ only). tradeUtility prices the completion
     *  bonus and the seller's handover penalty, so no prospect bonus needed. */
    _proposeBuyPair(state, player, cfg) {
        if (this._skill(player) < 0.5) return null;
        const candidates = this._twoAwayGroups(state, player.id);
        const myTargets = this._targetGroupsFor(state, player.id);
        const ordered = candidates.slice() // buy toward a colour I'm collecting first
            .sort((a, b) => (myTargets.has(b.group) ? 1 : 0) - (myTargets.has(a.group) ? 1 : 0));
        for (const target of ordered) {
            const pair = candidates.filter(c => c.group === target.group && c.ownerId === target.ownerId);
            if (pair.length !== 2 || pair[0].tileId !== target.tileId) continue; // handle each pair once
            const offer = {
                from: player.id,
                to: target.ownerId,
                give: { cash: 0, properties: [], jailCards: 0 },
                get: { cash: 0, properties: [pair[0].tileId, pair[1].tileId], jailCards: 0 }
            };
            const cash = this._zopaCash(state, player, offer, cfg);
            if (cash === null || cash <= 0) continue;
            offer.give.cash = cash;
            if (!Trading.validate(state, offer).ok) continue;
            if (this._refusedRecently(state, player, target.ownerId, pair[0].tileId) &&
                this._refusedRecently(state, player, target.ownerId, pair[1].tileId)) continue;
            if (this._snubbed(state, player, `pair:${target.ownerId}:${pair[0].tileId}:${pair[1].tileId}`)) continue;
            if (!this._tradeCompletionFundable(state, player, offer)) continue;
            return offer;
        }
        return null;
    },

    /** Scheme toward a set two tiles away (d3+ only): buy one of the two
     *  missing tiles for cash, priced with the discounted set prospect. Once
     *  it lands the one-away generators take over on a later turn. */
    _proposeBuyToward(state, player, cfg) {
        if (this._skill(player) < 0.5) return null;
        // Speculative spend — only from a comfortable cash position
        if (player.cash < this._floor(state, player) * 2) return null;
        const myTargets = this._targetGroupsFor(state, player.id);
        const cands = this._twoAwayGroups(state, player.id) // colour I'm collecting first
            .sort((a, b) => (myTargets.has(b.group) ? 1 : 0) - (myTargets.has(a.group) ? 1 : 0));
        for (const target of cands) {
            // If a single opponent holds BOTH missing tiles, buying just one
            // leaves me one-away and them one-away - a standoff that invites
            // endless re-trading. Completing the pair is the only sound line
            // (_proposeBuyPair ran first); if it didn't fire, don't nibble.
            const missing = Rules.tilesInGroup(target.group)
                .filter(id => Rules.getOwner(state, id) !== player.id);
            if (missing.length === 2 &&
                Rules.getOwner(state, missing[0]) === Rules.getOwner(state, missing[1])) continue;
            const offer = {
                from: player.id,
                to: target.ownerId,
                give: { cash: 0, properties: [], jailCards: 0 },
                get: { cash: 0, properties: [target.tileId], jailCards: 0 }
            };
            const bonus = this._prospectUtility(state, player, offer);
            const cash = this._zopaCash(state, player, offer, cfg, bonus);
            if (cash === null || cash <= 0) continue; // buying always costs something
            offer.give.cash = cash;
            // Don't start a scheme I plainly can't finish — but don't demand I
            // could complete it THIS turn at a worst-case premium either.
            // Reaching one-away has standalone value (already gettability-
            // discounted by _prospectUtility above) and cash recovers between
            // now and the last buy, so require only that the final tile stays
            // within reach at a modest premium while keeping a light reserve.
            // The old 2.5x + full-floor bar froze nearly every mid-game scheme.
            const last = Rules.tilesInGroup(target.group)
                .find(id => id !== target.tileId && Rules.getOwner(state, id) !== player.id);
            const lastCost = Rules.getOwner(state, last) === null ? BOARD[last].price : BOARD[last].price * 1.6;
            if (player.cash - cash < lastCost + this._floor(state, player) * 0.5) continue;
            if (!Trading.validate(state, offer).ok) continue;
            if (this._refusedRecently(state, player, target.ownerId, target.tileId)) continue;
            if (this._snubbed(state, player, `toward:${target.ownerId}:${target.tileId}`)) continue;
            return offer;
        }
        return null;
    },

    /**
     * Shut-out re-entry (d3+, knob evaluator.shutoutEntryPremium, 0 = off).
     * A CPU that holds no colour deed on a board with none left in the bank has
     * no way back in: every buy generator keys off tiles it already owns
     * (_oneAwayGroups / _twoAwayGroups), so it idles its cash until rent
     * attrition kills it (game mud9g25d: Bailey, d4, ~236 turns deedless on
     * $1300-1700 with 0 proposals). Offer cash for one opponent's lone colour
     * single — a foothold the two-away/one-away generators can build on next.
     * A lone single prices at ~face on both sides, so margins alone leave no
     * zone; the premium (x price) is what idle cash earning nothing is worth,
     * and it also caps the markup (never above price x (1 + premium)) — a
     * foothold is not worth a blocker's price.
     */
    _proposeEntryBuy(state, player, cfg) {
        const premium = window.AITuning ? AITuning.get('evaluator.shutoutEntryPremium', 0) : 0;
        if (premium <= 0 || this._skill(player) < 0.5) return null;
        const floor = this._floor(state, player);
        if (player.cash < floor * 2) return null;
        const colourIds = BOARD.filter(t => t.type === 'property').map(t => t.id);
        if (colourIds.some(id => Rules.getOwner(state, id) === player.id)) return null;
        // "Sold out" allows a straggler or two: one unowned tile is ~2.5% a
        // turn to land on (mud9g25d: Mediterranean sat unbought ~120 turns).
        if (colourIds.filter(id => Rules.getOwner(state, id) === null).length > 2) return null;
        const cands = [];
        for (const id of colourIds) {
            const ownerId = Rules.getOwner(state, id);
            if (ownerId === null || state.players[ownerId].bankrupt) continue;
            const ids = Rules.tilesInGroup(BOARD[id].group);
            if (ids.some(t => Rules.houseCount(state, t) > 0)) continue;
            if (ids.every(t => Rules.getOwner(state, t) === ownerId)) continue;       // their monopoly
            // A pure blocker (one opponent holds the rest of a three-set) is a
            // standoff, not a foothold: it prices at the blocker premium and
            // leaves me no one to trade toward.
            const rest = ids.filter(t => t !== id).map(t => Rules.getOwner(state, t));
            if (ids.length === 3 && rest[0] !== null && rest[0] === rest[1]) continue;
            const offer = {
                from: player.id,
                to: ownerId,
                give: { cash: 0, properties: [], jailCards: 0 },
                get: { cash: 0, properties: [id], jailCards: 0 }
            };
            const cash = this._zopaCash(state, player, offer, cfg, BOARD[id].price * premium);
            if (cash === null || cash <= 0) continue;
            if (cash > BOARD[id].price * (1 + premium)) continue;
            if (player.cash - cash < floor * 1.5) continue;
            offer.give.cash = cash;
            cands.push({ offer, ownerId, id, ratio: cash / BOARD[id].price });
        }
        // Cheapest markup first; ties go to the pricier (higher-rent) tile.
        cands.sort((a, b) => (a.ratio - b.ratio) || (BOARD[b.id].price - BOARD[a.id].price));
        for (const c of cands) {
            if (!Trading.validate(state, c.offer).ok) continue;
            if (this._refusedRecently(state, player, c.ownerId, c.id)) continue;
            if (this._snubbed(state, player, `entry:${c.ownerId}:${c.id}`)) continue;
            this._trace(state, `${player.name} — holds no colour deed and the bank is sold out; ` +
                `bids for a foothold (${BOARD[c.id].name}).`);
            return c.offer;
        }
        return null;
    },

    /**
     * Broker acquisition — leg 1 of a 3-way unlock (knob
     * evaluator.brokerMinDifficulty, 0 = off; else min player.difficulty).
     * I'm one-away on a set but holder B won't sell me the missing tile M
     * directly (no zone — B blocks the leader). If B is ITSELF one-away on a
     * different set, missing tile P held by a third owner C, then buying P from
     * C turns the deadlock into a mutual set-completion swap: next turn
     * _proposeSetSwap (earlier in the chain) offers B "P (completes your set)
     * for M (completes mine)". This generator fires ONLY leg 1, and only when
     * that downstream swap is PRE-VERIFIED to clear — _zopaCash on the
     * hypothetical P-for-M swap is non-null (_ownershipAfter reassigns tiles
     * regardless of who holds them now, so the swap prices faithfully before I
     * own P). So P is never bought speculatively: if B wouldn't accept the
     * swap, I don't start the broker. Even if leg 2 later slips (B's state
     * changed), the downside is bounded — I hold P, which now blocks B's set
     * and can be resold. Evidence: game mst4jmfb, a 185-turn Alex/Uma/Quinn
     * stalemate no direct generator could break (memory monopoly-broker-trade-idea).
     */
    _proposeBroker(state, player, cfg) {
        const minDiff = window.AITuning ? AITuning.get('evaluator.brokerMinDifficulty', 3) : 3;
        if (minDiff <= 0 || player.difficulty < minDiff) return null;
        const floor = this._floor(state, player);
        if (player.cash < floor * 2) return null;  // speculative spend from comfort only
        for (const mine of this._oneAwayGroups(state, player.id)) {
            const B = mine.ownerId, M = mine.missing;
            // Only broker when the DIRECT buy from B is a genuine dead end. If a
            // plain cash-for-set with B had a zone, _proposeCashForSet (earlier)
            // already returned it — don't broker around a merely-snubbed ask.
            const directBuy = { from: player.id, to: B,
                give: { cash: 0, properties: [], jailCards: 0 },
                get: { cash: 0, properties: [M], jailCards: 0 } };
            if (this._zopaCash(state, player, directBuy, cfg) !== null) continue;
            for (const bTarget of this._oneAwayGroups(state, B)) {
                if (bTarget.group === mine.group) continue;  // same-colour mutual blocker, not a broker
                const C = bTarget.ownerId, P = bTarget.missing;
                if (C === player.id || C === B) continue;    // P must be held by a third party
                // Leg 2 (next turn): would B swap M for P once I hold P?
                const swap = { from: player.id, to: B,
                    give: { cash: 0, properties: [P], jailCards: 0 },
                    get: { cash: 0, properties: [M], jailCards: 0 } };
                const swapCash = this._zopaCash(state, player, swap, cfg);
                if (swapCash === null) continue;             // the safety gate: no swap => no broker
                // Leg 1 (now): buy P from C, valued by the set I'll get to
                // complete — gettability-discounted (0.6, last tile with the
                // counterparty) and haircut 0.7 for broker-leg risk.
                const bonus = this._prospectBonus(mine.group, B, B) * 0.7;
                const buyP = { from: player.id, to: C,
                    give: { cash: 0, properties: [], jailCards: 0 },
                    get: { cash: 0, properties: [P], jailCards: 0 } };
                const cash = this._zopaCash(state, player, buyP, cfg, bonus);
                if (cash === null || cash <= 0) continue;    // buying always costs something
                buyP.give.cash = cash;
                // Keep a reserve AND stay able to fund a first build after the
                // whole broker (buy P + the swap's cash), so I don't broker my
                // way into an undevelopable, cash-starved monopoly.
                const cashAfterBroker = player.cash - cash - Math.max(0, swapCash);
                if (cashAfterBroker < floor) continue;
                if (!this._canFundFirstBuildAfter(state, player, mine.group, cashAfterBroker, this._skill(player))) continue;
                if (!Trading.validate(state, buyP).ok) continue;
                if (this._refusedRecently(state, player, C, P)) continue;
                if (this._snubbed(state, player, `broker:${C}:${P}`)) continue;
                this._trace(state, `${player.name} — brokers ${BOARD[P].name} from ${state.players[C].name} ` +
                    `to unlock ${mine.group} (then swaps it to ${state.players[B].name} for ${BOARD[M].name}).`);
                // Non-enumerable party tag for sim instrumentation (invisible to
                // JSON/trade records/serialization; inert for game logic).
                Object.defineProperty(buyP, '_broker', { value: { A: player.id, B, C, P, M, group: mine.group }, enumerable: false, configurable: true });
                return buyP;
            }
        }
        return null;
    },

    /**
     * Deed-funded acquisition (d3+): I want a tile that completes or advances
     * one of my groups but can't reach the seller's cash price — fund the gap
     * with spare deeds (strays I'm not building toward), fewest and cheapest
     * first, so the package lands inside the zone with little or no cash on
     * top. Runs after the pure-cash buyers as their "pay with deeds instead"
     * fallback; capped at two deeds so offers stay legible. Leaking my own
     * set-pieces is filtered by _schemedTiles (and priced by _prospectUtility
     * as a backstop); handing the seller a set is priced out by tradeUtility's
     * handover penalty — so neither needs an explicit guard here.
     */
    _proposePackage(state, player, cfg) {
        if (this._skill(player) < 0.5) return null;
        const schemed = this._schemedTiles(state, player.id);
        const assign = this._assignTargets(state);
        const isStray = id => { const c = assign[BOARD[id].group]; return c !== undefined && c !== player.id; };
        const pool = GameState.propertiesOf(state, player.id)
            .filter(id => {
                const g = BOARD[id].group;
                if (g && Rules.ownsFullGroup(state, player.id, g)) return false;
                return !schemed.has(id);
            })
            // Spend true strays (a colour someone else is collecting) first —
            // pure fodder I'll never build on — then the cheapest of the rest.
            .sort((a, b) =>
                (isStray(b) ? 1 : 0) - (isStray(a) ? 1 : 0) ||
                Evaluator.propertyValue(state, a, player.id) -
                Evaluator.propertyValue(state, b, player.id))
            .slice(0, 6);
        if (pool.length === 0) return null;

        // Candidate packages, fewest+cheapest deeds first: every single spare,
        // then every pair. Enumerating (rather than growing one prefix) means a
        // lone bad spare — e.g. one that completes the seller's set — just
        // prices itself out instead of poisoning every larger package.
        const packages = pool.map(id => [id]);
        for (let i = 0; i < pool.length; i++)
            for (let j = i + 1; j < pool.length; j++) packages.push([pool[i], pool[j]]);

        // Targets worth acquiring: reuse the set-scheming detectors. Skip a
        // two-away tile whose partner sits with the SAME owner — that's a
        // buy-pair standoff (_proposeBuyPair's job); nibbling one leaves both
        // of us one-away and invites endless re-trading.
        const targets = this._oneAwayGroups(state, player.id)
            .map(g => ({ ownerId: g.ownerId, tileId: g.missing }));
        for (const t of this._twoAwayGroups(state, player.id)) {
            const missing = Rules.tilesInGroup(t.group)
                .filter(id => Rules.getOwner(state, id) !== player.id);
            if (missing.length === 2 &&
                Rules.getOwner(state, missing[0]) === Rules.getOwner(state, missing[1])) continue;
            targets.push({ ownerId: t.ownerId, tileId: t.tileId });
        }
        // Acquire toward a colour I'm collecting before any other.
        const myTargets = this._targetGroupsFor(state, player.id, assign);
        targets.sort((a, b) =>
            (myTargets.has(BOARD[b.tileId].group) ? 1 : 0) - (myTargets.has(BOARD[a.tileId].group) ? 1 : 0));

        for (const target of targets) {
            for (const give of packages) {
                const offer = {
                    from: player.id,
                    to: target.ownerId,
                    give: { cash: 0, properties: give.slice(), jailCards: 0 },
                    get: { cash: 0, properties: [target.tileId], jailCards: 0 }
                };
                const cash = this._zopaCash(state, player, offer, cfg,
                    this._prospectUtility(state, player, offer));
                if (cash === null) continue; // no room yet — try a bigger/other package
                if (cash > 0) offer.give.cash = cash;
                else offer.get.cash = -cash;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._refusedRecently(state, player, target.ownerId, target.tileId)) continue;
                const key = `pkg:${target.ownerId}:${target.tileId}:` +
                    give.slice().sort((a, b) => a - b).join(',');
                if (this._snubbed(state, player, key)) continue;
                if (!this._tradeCompletionFundable(state, player, offer)) continue;
                return offer;
            }
        }
        return null;
    },

    /**
     * Deterministic "who is collecting which color" map, computed identically
     * by every CPU from the current board so they agree without coordinating.
     * Each contested color group is assigned to exactly one collector — the
     * player owning the most tiles in it, ties broken by fixed per-game
     * groupBias, then buyBias, then seat — so no two CPUs fight over the same
     * color and every stray single has a well-defined destination. Groups
     * already monopolized (by anyone) are left unassigned. Returns { group: playerId }.
     */
    _assignTargets(state) {
        const assign = {};
        for (const group of ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue']) {
            const ids = Rules.tilesInGroup(group);
            let best = null, bestKey = -Infinity, taken = false;
            for (const o of GameState.activePlayers(state)) {
                const c = ids.filter(id => Rules.getOwner(state, id) === o.id).length;
                if (c === ids.length) { taken = true; break; }
                if (c === 0) continue;
                const bias = o.personality ? (o.personality.groupBias[group] || 1) : 1;
                const buy = o.personality ? Personalities.weights(o).buyBias : 1;
                const key = c * 1e6 + bias * 1e3 + buy * 10 - o.id; // count, then temperament, then seat
                if (key > bestKey) { bestKey = key; best = o.id; }
            }
            if (!taken && best !== null) assign[group] = best;
        }
        return assign;
    },

    /** Colour singles `playerId` holds in a group somebody ELSE is collecting —
     *  fodder that belongs in that collector's hands, tradeable without
     *  sabotaging any set of my own. House-bearing (i.e. already-monopolized)
     *  groups are excluded by the ownsFullGroup guard. */
    _straysFor(state, playerId, assign) {
        return GameState.propertiesOf(state, playerId).filter(id => {
            const tile = BOARD[id];
            if (tile.type !== 'property') return false;
            if (Rules.ownsFullGroup(state, playerId, tile.group)) return false;
            const collector = assign[tile.group];
            return collector !== undefined && collector !== playerId;
        });
    },

    /** Colour groups this player is the assigned collector of — the sets a
     *  target-aware buy pursues first, and whose singles are never fodder.
     *  Reads the same map as _straysFor. */
    _targetGroupsFor(state, playerId, assign) {
        assign = assign || this._assignTargets(state);
        const out = new Set();
        for (const g in assign) if (assign[g] === playerId) out.add(g);
        return out;
    },

    /**
     * Consolidation swap (d4+): the move that untangles a multi-way colour
     * split into monopolies for everyone, which today only the human ever
     * makes. Hand a stray single to the player collecting that colour and take
     * back one of THEIR strays in a colour I'm collecting — advancing us both
     * toward a set (leg 1 is advance<->advance, a later leg completes via
     * _proposeSetSwap). The mutual-advance damping in Evaluator.tradeUtility is
     * what lets both sides price this as the fair rotation leg it is instead of
     * a giveaway. _prospectUtility credits my advance, _zopaCash settles the
     * residual cash, _snubbed bounds re-proposals.
     */
    _proposeConsolidationSwap(state, player, cfg) {
        if (this._skill(player) < 0.75) return null;
        const assign = this._assignTargets(state);
        for (const myTile of this._straysFor(state, player.id, assign)) {
            const collector = assign[BOARD[myTile].group];
            // Take back one of the collector's strays that sits in a colour I'm
            // the one collecting — the swap then carries us both forward.
            const theirTiles = this._straysFor(state, collector, assign)
                .filter(id => assign[BOARD[id].group] === player.id);
            for (const theirTile of theirTiles) {
                const offer = {
                    from: player.id,
                    to: collector,
                    give: { cash: 0, properties: [myTile], jailCards: 0 },
                    get: { cash: 0, properties: [theirTile], jailCards: 0 }
                };
                // Sharp-player discipline: never hand a collector a FINISHED
                // monopoly while I only advance — that's the leg where the
                // mutual-advance damping would otherwise let me subsidize a
                // rival (it inverts the difficulty ladder). Completing their
                // set is only acceptable when this same swap completes mine too
                // (a true win-win), which _proposeSetSwap already brokers.
                const after = Evaluator._ownershipAfter(state, offer);
                const completes = (pid) => Object.keys(GROUP_META).some(g => {
                    if (g === 'utility' || g === 'railroad') return false;
                    const gids = Rules.tilesInGroup(g);
                    return gids.every(id => after[id] === pid) &&
                        !gids.every(id => Rules.getOwner(state, id) === pid);
                });
                if (completes(collector) && !completes(player.id)) continue;
                const bonus = this._prospectUtility(state, player, offer);
                const cash = this._zopaCash(state, player, offer, cfg, bonus);
                if (cash === null) continue;
                if (cash > 0) offer.give.cash = cash;
                else offer.get.cash = -cash;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._refusedRecently(state, player, collector, theirTile)) continue;
                if (this._snubbed(state, player, `consol:${collector}:${myTile}:${theirTile}`)) continue;
                if (!this._tradeCompletionFundable(state, player, offer)) continue;
                return offer;
            }
        }
        return null;
    },

    /** Buy the tile that completes one of my groups, priced into the zone. */
    _proposeCashForSet(state, player, cfg) {
        for (const mine of this._oneAwayGroups(state, player.id)) {
            const offer = {
                from: player.id,
                to: mine.ownerId,
                give: { cash: 0, properties: [], jailCards: 0 },
                get: { cash: 0, properties: [mine.missing], jailCards: 0 }
            };
            const cash = this._zopaCash(state, player, offer, cfg);
            if (cash === null || cash <= 0) continue; // buying always costs something
            offer.give.cash = cash;
            if (!Trading.validate(state, offer).ok) continue;
            if (this._refusedRecently(state, player, mine.ownerId, mine.missing)) continue;
            if (this._snubbed(state, player, `buy:${mine.ownerId}:${mine.missing}`)) continue;
            if (!this._tradeCompletionFundable(state, player, offer)) continue;
            return offer;
        }
        return null;
    },

    /** Opportunistic sale (d3+): an opponent sits one tile from a set and I
     *  hold that tile as a stray. 2-tile groups are exempt - holding half of
     *  brown/dark-blue IS the block and is never shopped. _zopaCash prices my
     *  side with the full handover penalty, so the offer only materializes
     *  when their completion surplus clears my blocker value with room to
     *  spare; sellReluctance shifts my ask (hoarders demand extra, traders
     *  shave). */
    _proposeSellSpare(state, player, cfg) {
        if (this._skill(player) < 0.5) return null;
        const w = Personalities.weights(player);
        for (const other of GameState.activePlayers(state)) {
            if (other.id === player.id) continue;
            for (const target of this._oneAwayGroups(state, other.id)) {
                if (target.ownerId !== player.id) continue;
                if (GROUP_META[target.group].size < 3) continue;
                const tileId = target.missing;
                const offer = {
                    from: player.id,
                    to: other.id,
                    give: { cash: 0, properties: [tileId], jailCards: 0 },
                    get: { cash: 0, properties: [], jailCards: 0 }
                };
                const temperament = -BOARD[tileId].price * 0.3 * (w.sellReluctance - 1);
                const cash = this._zopaCash(state, player, offer, cfg, temperament);
                if (cash === null || cash >= 0) continue; // only sales where THEY pay
                offer.get.cash = -cash;
                // A sale netting less than the deed's mortgage value is
                // pointless (mortgaged strays just need to net anything real)
                const minNet = state.tiles[String(tileId)].mortgaged ? 30 : Rules.mortgageValue(tileId);
                if (offer.get.cash <= minNet) continue;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._snubbed(state, player, `sell:${other.id}:${tileId}`)) continue;
                return offer;
            }
        }
        return null;
    },

    /* ==================== DEBT ==================== */

    _raiseCash(state, player) {
        const debt = state.debt;
        if (debt.debtorId !== player.id) return null;
        if (player.cash >= debt.amount) return { type: 'PAY_DEBT' };
        if (Rules.liquidationValue(state, player.id) < debt.amount) {
            return { type: 'DECLARE_BANKRUPTCY' };
        }

        const props = GameState.propertiesOf(state, player.id);
        const naive = this._skill(player) < 0.3;

        // Mortgage non-monopoly singles first (naive CPUs mortgage at random)
        const mortgageable = props.filter(id => Rules.canMortgage(state, player.id, id).ok);
        if (mortgageable.length > 0) {
            if (naive) {
                return { type: 'MORTGAGE', tileId: mortgageable[RNG.int(state, 0, mortgageable.length - 1)] };
            }
            const singles = mortgageable.filter(id => {
                const g = BOARD[id].group;
                return !g || !Rules.ownsFullGroup(state, player.id, g);
            });
            const pick = (singles.length > 0 ? singles : mortgageable)
                .sort((a, b) => Evaluator.propertyValue(state, a, player.id) - Evaluator.propertyValue(state, b, player.id))[0];
            return { type: 'MORTGAGE', tileId: pick };
        }

        // Then sell houses (lowest ROI group first for smart CPUs)
        const sellable = props.filter(id => Rules.canSellHouse(state, player.id, id).ok);
        if (sellable.length > 0) {
            const pick = naive
                ? sellable[RNG.int(state, 0, sellable.length - 1)]
                : sellable.sort((a, b) => Evaluator.buildROI(state, a) - Evaluator.buildROI(state, b))[0];
            return { type: 'SELL_HOUSE', tileId: pick };
        }

        return { type: 'DECLARE_BANKRUPTCY' };
    }
};

if (typeof window !== 'undefined') {
    window.CPUPlayer = CPUPlayer;
}
