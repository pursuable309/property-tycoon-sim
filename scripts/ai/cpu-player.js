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
        // E54 clone: pays only part of the board-context premium over list
        if (w.valueContext != null) base = this._cloneContext(base, tile.price, w.valueContext);
        if (p.focus) base *= this._focusMul(state, player, tile.group); // d5 concentration (P3)
        return base * (1 + RNG.gauss(state, 0, w.noise != null ? w.noise : p.noise));
    },

    /** E54 clone: list x (value/list)^k — k=1 is the CPU's full contextual value, 0 is list price. */
    _cloneContext(value, price, k) {
        return value > 0 && price > 0 ? price * Math.pow(value / price, k) : value;
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
        const k = window.AITuning ? AITuning.get('evaluator.d5FocusBias', 0.30) : 0.30;
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

    /** Floor at buy/bid time. Stock CPUs use _floor; an E54 clone has its own (fitted) multiplier. */
    _acquireFloor(state, player) {
        const w = Personalities.weights(player);
        if (w.acquireFloorMul == null) return this._floor(state, player);
        return Evaluator.cashFloor(state, player.id, this._skill(player)) * w.acquireFloorMul;
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
        const manage = this._rollStillToCome(state, player) ? null : this._bestManagement(state, player);
        if (manage) return manage;
        const trade = this._maybeProposeTrade(state, player);
        if (trade) return trade;
        return { type: 'ROLL_DICE' };
    },

    _postRoll(state, player) {
        const manage = this._rollStillToCome(state, player) ? null : this._bestManagement(state, player);
        if (manage) return manage;
        return { type: 'END_TURN' };
    },

    /**
     * E72 (knob evaluator.deferBuildToTurnEnd): does this player still have a roll
     * to make this turn? If so, building, unmortgaging and stretch-mortgaging wait
     * for the turn's last post-roll. Nobody else moves before my turn ends, so a
     * house bought before my own roll earns nothing extra; it can only be sold
     * back at half price if that roll lands on a big rent (game mw3ncmvv t107:
     * Yuri built light blue to two hotels before a doubles re-roll, landed on a
     * $750 hotel and sold all 14 builds). Level 1 (default) defers while a
     * doubles re-roll is pending; 2 also defers the pre-roll at the start of a
     * turn; 0 = old behavior. The Clone of T seat keeps T's own timing.
     */
    _rollStillToCome(state, player) {
        const level = window.AITuning ? AITuning.get('evaluator.deferBuildToTurnEnd', 1) : 1;
        if (!level || state.currentPlayer !== player.id) return false;
        if (Personalities.weights(player).buildGo != null) return false; // E54 clone: pinned benchmark
        if (state.phase === GamePhase.AWAIT_PREROLL) return level >= 2 || state.doublesCount > 0;
        if (state.phase === GamePhase.AWAIT_ENDTURN) {
            // Mirrors TurnEngine END_TURN: doubles grant another roll unless jailed.
            return !!(state.rollMeta && state.rollMeta.doubles && !player.inJail && !player.bankrupt);
        }
        return false;
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
        // E62: evaluator.buildFloorScale / greenLightFloorMul scale the build
        // reserve only (defaults 1 / 0.55 = the old fixed floor).
        const tune = (k, d) => (window.AITuning ? AITuning.get(k, d) : d);
        let buildFloor = floor;
        if (this._skill(player) >= 0.5) {
            const ahead = Evaluator.threatAhead(state, player.id);
            const worstBoard = Evaluator.maxThreatRent(state, player.id);
            if (worstBoard >= 200 && ahead.worst < worstBoard * 0.35) {
                buildFloor = floor * tune('evaluator.greenLightFloorMul', 0.55);
            }
        }
        if ((player.difficulty || 0) >= tune('evaluator.buildFloorMinDifficulty', 0)) {
            buildFloor *= tune('evaluator.buildFloorScale', 1);
        }

        // E54 clone: bursty building replaces the reserve rule (own turn only)
        if (w.buildGo != null) {
            buildFloor = state.currentPlayer === player.id ? this._cloneBuildFloor(state, player, w) : Infinity;
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
     *
     * `targetTileId` (E71, knob evaluator.stretchTargetLast): when the stretch
     * buys a tile that completes its colour group, that group's own deeds go
     * after every other candidate. Mortgaging one of them freezes the set the
     * CPU is buying (no house until it is lifted), and in 7 of 8 recorded
     * cases a deed outside the set would have paid (mvxbm455 t62: Emery
     * mortgaged Boardwalk for Park Place with Pennsylvania Avenue spare; dark
     * blue stayed frozen 95 turns). They stay in the list and in `total`, so
     * what the CPU can raise, and every buy/bid decision, is unchanged; when
     * nothing else is left they are still used (msmea97e Bailey, E30).
     */
    _stretchEquity(state, player, targetTileId) {
        const tiles = GameState.propertiesOf(state, player.id)
            .filter(id => Rules.canMortgage(state, player.id, id).ok)
            .filter(id => {
                const g = BOARD[id].group;
                return !(g && Rules.ownsFullGroup(state, player.id, g));
            })
            .sort((a, b) =>
                Evaluator.propertyValue(state, a, player.id) / Rules.mortgageValue(a) -
                Evaluator.propertyValue(state, b, player.id) / Rules.mortgageValue(b));
        const target = targetTileId != null ? BOARD[targetTileId] : null;
        const last = window.AITuning ? AITuning.get('evaluator.stretchTargetLast', 1) : 1;
        if (last && target && target.type === 'property' && target.group) {
            const g = target.group;
            const outside = tiles.filter(id => BOARD[id].group !== g);
            const inside = tiles.filter(id => BOARD[id].group === g);
            tiles.length = 0;
            tiles.push(...outside, ...inside);
        }
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
        const k = window.AITuning ? AITuning.get('evaluator.unfreezeSetPriority', 1) : 1;
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
     *  lift (evaluator.multiplayerBuyLift, def 0.15; 0 = off). In a 3+ active-player
     *  field the under-buying archetypes (base buyBias < 1: cautious 0.85,
     *  builder 0.95) were measured to under-acquire and lose with cash in hand
     *  (mu6c4jg6, mu4t9i9k). An additive lift raises them toward parity there
     *  (0.85+0.15=1.0, 0.95+0.15=1.1). Gated to >=3 players because the same
     *  raise is a clean d5 win at 5p (A/B bt56zo1rr: +3.4, dev up, not
     *  attrition) but hurts heads-up (-1.9), where the <=2p lookahead already
     *  optimizes acquisition — the mirror of the buy-veto/proposal-gate/focus
     *  scoping. Bids are untouched (the bidBias raise measured inert). */
    _buyBias(state, w) {
        const lift = window.AITuning ? AITuning.get('evaluator.multiplayerBuyLift', 0.15) : 0.15;
        if (lift > 0 && w.buyBias < 1 && GameState.activePlayers(state).length >= 3) {
            return w.buyBias + lift;
        }
        return w.buyBias;
    },

    /** E67: finish a started stretch-buy/bid, in fields bigger than the buy-veto gate. */
    _stretchCommits(state) {
        if (!(window.AITuning ? AITuning.get('evaluator.stretchCommit', 1) : 1)) return false;
        const vetoMax = window.AITuning ? AITuning.get('evaluator.lookaheadBuyVetoMaxPlayers', 2) : 2;
        return GameState.activePlayers(state).length > vetoMax;
    },

    _buyOrAuction(state, player) {
        const tileId = state.pendingAction.tileId;
        const price = BOARD[tileId].price;
        const w = Personalities.weights(player);
        const value = this._value(state, player, tileId,
            { cashAfter: player.cash - price, skill: this._skill(player) }) * this._buyBias(state, w);
        const floor = this._acquireFloor(state, player);
        const tile = BOARD[tileId];
        const completesSet = tile.group && !['railroad', 'utility'].includes(tile.group) &&
            Rules.countOwnedInGroup(state, player.id, tile.group) === GROUP_META[tile.group].size - 1;
        // Completing a set justifies dipping below the working reserve — but
        // only if we can still fund a first round of houses afterward.
        // Completing a premium set (dark blue) down to near-zero just buys an
        // undevelopable monopoly that strip-mortgages and dies (games
        // mrtqw1oj Finley, mrtwus9v Lennon). Cheap sets clear this easily.
        const fundableCompletion = completesSet && this._canFundFirstBuild(state, player, tileId, price);

        // A stretch already under way is a commitment (E67): the mortgages are
        // paid for, so finish the plan. Re-deciding on every re-ask redrew the
        // valuation noise and, once the cash was in hand, let the d5 rollout
        // veto the buy, leaving the CPU mortgaged with no deed (Alex mortgaged
        // Park Place + North Carolina to $450, then auctioned Boardwalk).
        // Big fields only, like the buy veto below: heads-up the re-decision is
        // the accurate rollout, and committing cost d5 -2.3 win / -2.6 capWin
        // (A/B 20261029-1712, null at 4p/5p).
        const commit = this._stretchCommits(state);
        if (commit && state.pendingAction.stretched) {
            if (player.cash >= price) {
                this._trace(state, `${player.name} completes the stretch: buys ${tile.name} ($${price}).`);
                return { type: 'BUY_PROPERTY' };
            }
            const eq = this._stretchEquity(state, player, tileId);
            if (eq.tiles.length && player.cash + eq.total >= price) {
                return { type: 'MORTGAGE', tileId: eq.tiles[0], playerId: player.id, stretch: true };
            }
        }

        // Stretch funding (d3+): short on cash for a set-completing or
        // set-denying tile, mortgage spare singles first (the engine allows
        // managing during AWAIT_DECISION; the pump re-asks after each one).
        const stretching = this._skill(player) >= 0.5 &&
            this._stretchWorthy(state, player, tileId) && value > price;
        if (stretching && player.cash < price) {
            const eq = this._stretchEquity(state, player, tileId);
            if (eq.tiles.length && player.cash + eq.total >= price) {
                return { type: 'MORTGAGE', tileId: eq.tiles[0], playerId: player.id, stretch: true };
            }
        }

        let wantBuy = player.cash >= price &&
            value > price &&
            (player.cash - price > floor || fundableCompletion || stretching);
        // E54 clone (win-game habit): takes every affordable deed that completes or blocks a set
        if (w.buySets && player.cash >= price && tile.type === 'property' && (completesSet ||
            GameState.activePlayers(state).some(o => o.id !== player.id &&
                Rules.countOwnedInGroup(state, o.id, tile.group) === GROUP_META[tile.group].size - 1))) wantBuy = true;

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
        // ...and in a big field never let it veto a wanted buy that completes
        // MY OWN set (E67). The heuristic already demanded value > price and a
        // funded build or a stretch; at ~1 own turn the rollout never sees the
        // monopoly pay and scores the deed at face, so it reads "keep the cash"
        // and hands the completer to the auction (Alex, 5p, passed Boardwalk
        // holding Park Place). Same bigField gate as above: ungated, it cost d5
        // heads-up -2.4 win / -3.0 capWin (A/B 20261029-1501), where the rollout
        // is accurate, and was null at 4p/5p.
        const setVeto = window.AITuning ? AITuning.get('evaluator.lookaheadSetBuyVeto', 0) : 0;
        const clearBuy = wantBuy && ((!setVeto && completesSet && bigField) || (player.cash - price > floor &&
            (bigField || (clearRatio > 0 && value >= price * clearRatio))));
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
        if (w.engageBias != null) return this._cloneAuctionBid(state, player, w);
        const value = this._value(state, player, a.tileId,
            { cashAfter: player.cash - a.currentBid, skill: this._skill(player) }) * w.bidBias;
        const floor = this._floor(state, player);
        let maxWill = Math.min(value, player.cash - floor * 0.5, player.cash);

        // Stretch funding (d3+): for a set-completing or set-denying tile,
        // spare-single mortgage equity extends the bid ceiling past cash.
        let stretch = null;
        if (this._skill(player) >= 0.5 && this._stretchWorthy(state, player, a.tileId)) {
            const eq = this._stretchEquity(state, player, a.tileId);
            if (eq.tiles.length) {
                stretch = eq;
                maxWill = Math.max(maxWill,
                    Math.min(value, player.cash + eq.total - floor * 0.25));
            }
        }

        const aTile = BOARD[a.tileId];
        const completesMine = aTile.group && !['railroad', 'utility'].includes(aTile.group) &&
            Rules.countOwnedInGroup(state, player.id, aTile.group) === GROUP_META[aTile.group].size - 1;

        // A bid already funded by mortgages is placed (E67): re-deciding here
        // redrew the bluff roll below and folded the bid the mortgages were for.
        const commit = this._stretchCommits(state);
        const sb = a.stretchBid;
        if (commit && sb && sb.playerId === player.id && sb.amount > a.currentBid &&
            player.id !== a.currentWinner) {
            if (player.cash >= sb.amount) return { type: 'AUCTION_BID', playerId: player.id, amount: sb.amount };
            if (stretch) return { type: 'MORTGAGE', tileId: stretch.tiles[0], playerId: player.id, stretchBid: sb.amount };
        }

        // Sharp CPUs bluff-bid to drain a rival, bounded well below their max.
        // Not on a tile that completes MY set (E67): the cap (half my cash) is
        // then a fold, handing my completer to its blocker (Alex passed
        // Boardwalk at $520 after mortgaging to $600 for it).
        const setBluff = window.AITuning ? AITuning.get('evaluator.auctionSetBluff', 0) : 0;
        const p = this._params(player);
        if (p.auctionSmarts >= 1 && a.currentWinner !== null && a.currentWinner !== player.id &&
            (setBluff || !completesMine)) {
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
        if (a.declinedBy === player.id && !completesMine) {
            maxWill = Math.min(maxWill, aTile.price);
        }

        // Leader-denial block-bidding (knob evaluator.auctionBlockValue, def 1 at 5-6
        // seats via auctionBlockMin/MaxSeats; ≥3 active players; skill-scaled).
        // The shared propertyValue already prices blocking a one-away opponent, but FLAT — no skill term, no leader weight,
        // so d3=d4=d5 and it doesn't grow with the field (analysis §10). Here a sharp
        // CPU in a multi-player field ESCALATES its ceiling to deny the tile that
        // would COMPLETE a LEADING opponent's set, up to a bounded slice of the value
        // they'd gain × how far ahead they are. Placed AFTER the decliner cap: unlike
        // buying it for myself, denying a runaway leader justifies bidding past face
        // even having declined. Bounded (≤70% cash, keep ¼ floor) and leader-weighted,
        // so it is NOT the removed auction-STEAL bug (unbounded win-for-self). Null at
        // 2p (no field to lead → protects the P2/P3 heads-up wins).
        // E51: shipped at 1.0 for 5-6 seat tables only. Gated on SEATS, not
        // active players, so it stays on after bankruptcies exactly as measured
        // (5p d5 +0.75 / capWin +0.6 over 18 cells; null at 4p and 8p).
        const blockK = window.AITuning ? AITuning.get('evaluator.auctionBlockValue', 1) : 1;
        const seats = state.players.length;
        const blockSeats = seats >= (window.AITuning ? AITuning.get('evaluator.auctionBlockMinSeats', 5) : 5) &&
            seats <= (window.AITuning ? AITuning.get('evaluator.auctionBlockMaxSeats', 6) : 6);
        if (blockK > 0 && blockSeats && !completesMine && this._skill(player) >= 0.5 &&
            GameState.activePlayers(state).length >= 3 &&
            aTile.group && !['railroad', 'utility'].includes(aTile.group)) {
            const size = GROUP_META[aTile.group].size;
            let denyBonus = 0, denied = null;
            // Only a leader still in THIS auction can be denied: once they pass,
            // blockers would just bid each other up (game mw30aud7 t53 showed
            // the shape with the leader still bidding). Older saves without
            // activeBidders fall back to everyone still in the game.
            const stillBidding = a.activeBidders || null;
            for (const opp of GameState.activePlayers(state)) {
                if (opp.id === player.id) continue;
                if (stillBidding && !stillBidding.includes(opp.id)) continue;
                if (Rules.countOwnedInGroup(state, opp.id, aTile.group) !== size - 1) continue;
                const groupValue = Rules.tilesInGroup(aTile.group).reduce((s, id) => s + BOARD[id].price, 0);
                const bonus = groupValue * (0.4 + 0.6 * Evaluator.exploitability(state, opp.id, aTile.group)) *
                    Evaluator._leadFactor(state, opp.id) * this._skill(player) * blockK;
                if (bonus > denyBonus) { denyBonus = bonus; denied = opp; }
            }
            if (denyBonus > 0) {
                const ceiling = Math.min(value + denyBonus, player.cash * 0.7, player.cash - floor * 0.25);
                if (ceiling > maxWill) {
                    const label = (GROUP_META[aTile.group] && GROUP_META[aTile.group].label) || aTile.group;
                    this._trace(state, `${player.name} — block-bids to deny ${denied.name} (leading) the ${label} set at auction.`);
                    maxWill = ceiling;
                }
            }
        }

        // Already leading yet asked to bid (everyone else passed): a winner's
        // pass accepts the standing bid, ending the auction. Never return null
        // here - the pump would stall with no one left to act.
        if (player.id === a.currentWinner) return { type: 'AUCTION_PASS', playerId: player.id };
        const reach = player.cash + (stretch ? stretch.total : 0);
        const nextBid = this._auctionRaise(a.currentBid, maxWill, reach, state, player.id);
        if (nextBid !== null) {
            // Raise the cash before raising the bid: the engine lets the
            // current bidder mortgage mid-auction, then re-asks for a bid.
            if (nextBid > player.cash && stretch) {
                return { type: 'MORTGAGE', tileId: stretch.tiles[0], playerId: player.id, stretchBid: nextBid };
            }
            return { type: 'AUCTION_BID', playerId: player.id, amount: nextBid };
        }
        return { type: 'AUCTION_PASS', playerId: player.id };
    },

    /**
     * Next bid using only the raises a human gets (Auction.BID_STEPS: +1/+10/+50),
     * or null when not even +1 fits under the limit. Level 1 raises +10 while the bid
     * is under $200 and +50 from there, then drops to the largest step still
     * under the ceiling, so a CPU closes out its last dollars in +10/+1 bids.
     * E66: evaluator.auctionHumanSteps 0 restores the old +10/+25/+50 ladder
     * (with an all-in bid capped at reach), for A/B only. Level 2 (E66
     * follow-up) picks the step by headroom instead of bid level: +50 only
     * while the limit is >= $100 above the bid, so a CPU never jumps near
     * its ceiling, then +10, then +1. Level 3 (mixed, the default since 2026-10-30) draws the step at
     * random from those that fit under the limit (+50 / +10 / +1 weighted
     * 45 / 45 / 10, from the game RNG so saves and sims replay), so a small
     * step no longer tells a human the CPU is near its limit. Level 4 adds
     * two more draws: each CPU picks its own step weights once per auction
     * (stored on state.auction.mix), and once only +1 fits it passes half
     * the time instead of creeping to its last dollar (gives up < $10).
     * Level 5 centres that per-auction draw on the CPU's personality
     * (AUCTION_STYLE: aggressive jumps, traders and cautious CPUs haggle in
     * small steps) with the same spread, so style is a tendency, not a tell.
     */
    /** E66 level 5: per-archetype centre of the per-auction step weights
     *  (w1 = share of +$1, w50 = share of +$50 in the rest). Clones and
     *  unknown archetypes keep the level-4 centre (0.175 / 0.5). */
    AUCTION_STYLE: {
        aggressive: { w1: 0.05, w50: 0.75 },
        hoarder:    { w1: 0.15, w50: 0.5 },
        builder:    { w1: 0.15, w50: 0.5 },
        trader:     { w1: 0.3,  w50: 0.35 },
        cautious:   { w1: 0.25, w50: 0.25 },
    },

    _auctionRaise(currentBid, maxWill, reach, state, playerId) {
        const mode = window.AITuning ? AITuning.get('evaluator.auctionHumanSteps', 3) : 3;
        if (!mode) {
            const old = Math.min(currentBid + (currentBid < 100 ? 10 : (currentBid < 300 ? 25 : 50)), reach);
            return old > currentBid && old <= maxWill ? old : null;
        }
        const limit = Math.min(maxWill, reach);
        if (mode >= 3 && state) {
            let W = { 1: 0.10, 10: 0.45, 50: 0.45 };
            const a = state.auction;
            if (mode >= 4 && a && playerId != null) {
                a.mix = a.mix || {};
                if (!a.mix[playerId]) {
                    let w1 = 0.05 + 0.25 * RNG.float(state), w50 = 0.2 + 0.6 * RNG.float(state);
                    const arch = mode >= 5 && state.players[playerId] && state.players[playerId].personality
                        ? state.players[playerId].personality.archetype : null;
                    const c = arch && this.AUCTION_STYLE[arch];
                    if (c) {   // same spread as level 4 (+/-0.125, +/-0.3), re-centred
                        w1 = Math.min(0.4, Math.max(0.02, c.w1 + (w1 - 0.175)));
                        w50 = Math.min(0.9, Math.max(0.05, c.w50 + (w50 - 0.5)));
                    }
                    a.mix[playerId] = { 1: w1, 10: 1 - w50, 50: w50 };
                }
                W = a.mix[playerId];
            }
            const fits = Auction.BID_STEPS.filter(s => currentBid + s <= limit);
            if (!fits.length) return null;
            if (mode >= 4 && fits.length === 1 && RNG.float(state) < 0.5) return null;
            const total = fits.reduce((t, s) => t + W[s], 0);
            let r = RNG.float(state) * total;
            for (const s of fits) { r -= W[s]; if (r < 0) return currentBid + s; }
            return currentBid + fits[fits.length - 1];
        }
        const preferred = mode >= 2
            ? (limit - currentBid >= 100 ? 50 : 10)
            : (currentBid < 200 ? 10 : 50);
        const step = Auction.BID_STEPS.filter(s => s <= preferred && currentBid + s <= limit).pop();
        return step ? currentBid + step : null;
    },

    /**
     * E54 clone auction policy (the fitted human shape, docs/ai/efforts/E54-*):
     * decide ONCE per auction whether to contest it at all — judged like a buy,
     * on the context value (valueContext), less keen on a tile it declined
     * itself — then bid up to a ceiling anchored near list price (bidContext),
     * drawn once per auction. Stretch funding for a set-completer as the CPU
     * does; no bluff-bids, no decliner cap, no block-bids (the human shows none).
     */
    _cloneAuctionBid(state, player, w) {
        const a = state.auction;
        const tile = BOARD[a.tileId];
        a.clone = a.clone || {};
        let c = a.clone[player.id];
        if (!c) {
            const base = Evaluator.propertyValue(state, a.tileId, player.id,
                { cashAfter: player.cash - a.currentBid, skill: this._skill(player) }) *
                (player.personality.groupBias[tile.group] || 1);
            const keen = a.declinedBy === player.id ? w.declinedEngage : 1;
            const engage = this._cloneContext(base, tile.price, w.valueContext) * w.engageBias * keen *
                Math.exp(this._cloneSignal(state, player, w, 'engage')) *
                (1 + RNG.gauss(state, 0, w.noise)) > tile.price;
            const early = w.earlyBid && state.turnNumber <= 30 ? w.earlyBid : 1;   // win-game habit
            const ceiling = this._cloneContext(base, tile.price, w.bidContext) * w.bidBias * early *
                (1 + RNG.gauss(state, 0, w.bidNoise));
            c = a.clone[player.id] = { engage, ceiling: Math.round(ceiling) };
        }
        if (player.id === a.currentWinner || !c.engage) return { type: 'AUCTION_PASS', playerId: player.id };
        const floor = this._acquireFloor(state, player);
        let cap = player.cash - floor * 0.5;
        let stretch = null;
        if (this._skill(player) >= 0.5 && this._stretchWorthy(state, player, a.tileId)) {
            const eq = this._stretchEquity(state, player, a.tileId);
            if (eq.tiles.length) { stretch = eq; cap = Math.max(cap, player.cash + eq.total - floor * 0.25); }
        }
        const maxWill = Math.min(c.ceiling, cap);
        const nextBid = this._auctionRaise(a.currentBid, maxWill, player.cash + (stretch ? stretch.total : 0), state, player.id);
        if (nextBid !== null) {
            if (nextBid > player.cash && stretch) return { type: 'MORTGAGE', tileId: stretch.tiles[0], playerId: player.id };
            return { type: 'AUCTION_BID', playerId: player.id, amount: nextBid };
        }
        return { type: 'AUCTION_PASS', playerId: player.id };
    },

    /**
     * E54 clone build policy: builds in bursts. Once per turn it decides whether
     * to build at all — more likely the closer opponents are to landing on its
     * sets — and if so, builds down to a reserve drawn for that turn. Returns the
     * build floor for this call, or Infinity on a no-build turn.
     */
    _cloneBuildFloor(state, player, w) {
        // memo is plain JSON (autosave / rollout clones): no Infinity in it
        let memo = player.cloneBuild;
        if (!memo || memo.turn !== state.turnNumber) {
            const go = RNG.float(state) < this._phi(w.buildGo + w.buildGoExposure * this._setExposure(state, player) +
                this._cloneSignal(state, player, w, 'build'));
            memo = player.cloneBuild = { turn: state.turnNumber, go,
                reserve: go ? Math.round(w.buildReserve * Math.exp(w.buildNoise * RNG.gauss(state, 0, 1))) : 0 };
        }
        return memo.go ? memo.reserve : Infinity;
    },

    /**
     * E54 board-signal term: sum of w.signals[slot][name] x signal, with the
     * signals scaled as fit_human.js feats() does (cash /1500 capped at 2; ahead =
     * my share of active net worth x players - 1, in [-1, 1]; unowned deeds / 28;
     * crowd = (active players - 2) / 3). 0 for a clone without signals.
     */
    _cloneSignal(state, player, w, slot) {
        const b = w.signals && w.signals[slot];
        if (!b) return 0;
        const act = GameState.activePlayers(state);
        const sig = {
            cash: () => Math.min(2, Math.max(0, player.cash) / 1500),
            ahead: () => {
                const tot = act.reduce((a, p) => a + Rules.netWorth(state, p.id), 0) || 1;
                return Math.max(-1, Math.min(1, Rules.netWorth(state, player.id) / tot * act.length - 1));
            },
            unowned: () => BOARD.filter(t => t.price && Rules.getOwner(state, t.id) == null).length / 28,
            crowd: () => (act.length - 2) / 3,
        };
        let s = 0;
        for (const k of Object.keys(b)) s += b[k] * (sig[k] ? sig[k]() : 0);
        return s;
    },

    /** Expected opponent landings on my complete colour sets within one roll of 2d6. */
    _setExposure(state, player) {
        const mine = new Set(GameState.propertiesOf(state, player.id).filter(id => {
            const t = BOARD[id];
            return t.type === 'property' && Rules.ownsFullGroup(state, player.id, t.group);
        }));
        if (!mine.size) return 0;
        let e = 0;
        for (const o of GameState.activePlayers(state)) {
            if (o.id === player.id) continue;
            for (let d = 2; d <= 12; d++) if (mine.has((o.position + d) % 40)) e += (6 - Math.abs(d - 7)) / 36;
        }
        return e;
    },

    /** Standard normal CDF (Abramowitz-Stegun 26.2.17). */
    _phi(x) {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const p = 0.3989423 * Math.exp(-x * x / 2) *
            t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - p : p;
    },

    /**
     * E54 clone answer to an offer (the fitted human shape): accept with
     * P = Phi(tradeBase + tradeSlope*U/scale + set terms + heads-up term), where
     * U is the offer's value with the cash leg and the handover cost re-weighted
     * (tradeCash, tradeHandover). Not accepting, it counters with
     * P = Phi(ctrBase + ...), asking cash up to a surplus of ctrTarget x scale
     * on the same deeds; otherwise rejects. No lookahead, no deed counters.
     */
    _cloneTradeRespond(state, player, w) {
        const offer = state.trade;
        const me = player.id, skill = this._skill(player);
        const otherId = offer.from === me ? offer.to : offer.from;
        const gain = offer.from === me ? offer.get : offer.give;
        const lose = offer.from === me ? offer.give : offer.get;
        const u0 = Evaluator.tradeUtility(state, offer, me, { handoverPenalty: 0, skill });
        const u1 = Evaluator.tradeUtility(state, offer, me, { handoverPenalty: 1, skill });
        const cashNet = gain.cash - lose.cash + 40 * (gain.jailCards - lose.jailCards);
        const U = w.tradeCash * cashNet + (u0 - cashNet) - w.tradeHandover * (u0 - u1);
        const scale = this._tradeScale(offer);
        const mine = this._completesSetFor(state, offer, me);
        const theirs = !mine && this._completesSetFor(state, offer, otherId);
        const both = mine && w.tradeBoth != null && this._completesSetFor(state, offer, otherId);
        const h2h = GameState.activePlayers(state).length === 2;
        const from = state.players[offer.from].name;
        const pA = this._phi(w.tradeBase + w.tradeSlope * Math.max(-3, Math.min(3, U / scale)) +
            (mine ? w.tradeMine : 0) + (theirs ? w.tradeTheirs : 0) + (both ? w.tradeBoth : 0) + (h2h ? w.tradeH2H : 0));
        if (RNG.float(state) < pA) {
            this._trace(state, `${player.name} accepts ${from}'s trade (clone, P ${pA.toFixed(2)}).`);
            return { type: 'ACCEPT_TRADE', playerId: me };
        }
        const pC = this._phi(w.ctrBase + (mine ? w.ctrMine : 0) + (theirs ? w.ctrTheirs : 0) + (h2h ? w.ctrH2H : 0));
        if (this._tradeConfig().counters && offer.counters < 3 && RNG.float(state) < pC) {
            const extra = Math.ceil((w.ctrTarget * scale - U) / w.tradeCash / 10) * 10;
            const counter = extra > 0 ? this._cashCounterOffer(state, player, offer, extra) : null;
            if (counter) {
                this._trace(state, `${player.name} counters ${from} for $${extra} more (clone).`);
                return counter;
            }
        }
        this._trace(state, `${player.name} rejects ${from}'s trade (clone, P ${pA.toFixed(2)}).`);
        return { type: 'REJECT_TRADE', playerId: me };
    },

    /**
     * E54 clone proposal odds: decide once per turn whether this is a trading
     * turn (propRate, or propRateH2H heads-up); on one, the first proposal
     * always goes and each further one with propMore. No set-move nudge.
     */
    _cloneProposeOdds(state, player, w, used) {
        let memo = player.clonePropose;
        if (!memo || memo.turn !== state.turnNumber) {
            let rate = GameState.activePlayers(state).length <= 2 ? w.propRateH2H : w.propRate;
            // Shape mode almost always finds a deal (asks), so the calibration boost to propRate comes back off
            if (this._cloneShapeMix(player)) rate *= this.CLONE_SHAPE_RATE;
            memo = player.clonePropose = { turn: state.turnNumber, go: RNG.float(state) < rate };
        }
        if (!memo.go) return 0;
        return used > 0 ? w.propMore : 1;
    },

    /**
     * E54 clone pricing: re-price a generated offer to a CPU partner so that
     * partner's respond rule sees it at a drawn slack (propSlack +- propSlackSd,
     * in units of deal size) above its margin, by moving the net cash. The
     * human prices openings well below CPU acceptance (median slack -0.84).
     * Offers to a human partner are left as generated.
     */
    _cloneShadeOffer(state, player, offer, w, extra) {
        const partner = state.players[offer.to];
        if (!partner || !partner.isCPU) return offer;
        const cfg = this._tradeConfig();
        const scale = this._tradeScale(offer);
        const uThem = Evaluator.tradeUtility(state, offer, partner.id,
            { handoverPenalty: cfg.handoverPenalty, skill: this._skill(partner) });
        const slack = (uThem - this._params(partner).tradeMargin * cfg.marginMul * scale) / scale;
        const target = w.propSlack - (extra || 0) + w.propSlackSd * RNG.gauss(state, 0, 1);
        const net = offer.get.cash - offer.give.cash + Math.round((slack - target) * scale / 10) * 10;
        const shaded = {
            ...offer,
            give: { ...offer.give, cash: Math.max(0, Math.min(-net, player.cash)) },
            get: { ...offer.get, cash: Math.max(0, Math.min(net, partner.cash)) },
        };
        const empty = side => side.cash === 0 && side.properties.length === 0 && side.jailCards === 0;
        if (empty(shaded.give) && empty(shaded.get)) return offer;
        return Trading.validate(state, shaded).ok ? shaded : offer;
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
        const margin = !Evaluator.actsHuman(other) ? this._params(other).tradeMargin : 0.05;
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
        const cw = Personalities.weights(player);
        if (cw.tradeBase != null) return this._cloneTradeRespond(state, player, cw);
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
                (veto === 1 || Evaluator.actsHuman(state.players[offer.from])) &&
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
        return this._cashCounterOffer(state, player, offer, extra);
    },

    /** Same deeds back, asking `extra` more net cash; null if the proposer can't pay it. */
    _cashCounterOffer(state, player, offer, extra) {
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
        if (w.propRate != null) frequency = this._cloneProposeOdds(state, player, w, used);
        // Distress overrides temperament: a monopoly waiting on cash justifies
        // shopping a spare deed around even for trade-shy archetypes.
        if (w.propRate == null && frequency < 0.4 && this._skill(player) >= 0.5 && this._starvedBuild(state, player)) {
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
        if (w.propRate == null && frequency < setMoveNudge && this._skill(player) >= 0.5) {
            const assign = this._assignTargets(state);
            const hasSetMove = this._oneAwayGroups(state, player.id).length > 0 ||
                (this._targetGroupsFor(state, player.id, assign).size > 0 &&
                    this._straysFor(state, player.id, assign).length > 0);
            if (hasSetMove) frequency = setMoveNudge;
        }
        // Decaying odds on each proposal beyond the first: a 2nd+ attempt only
        // sometimes fires, so maxing the budget is the exception. The first
        // proposal (used === 0) uses the full nudged frequency, unchanged.
        if (used > 0 && w.propRate == null) {
            const decay = window.AITuning ? AITuning.get('evaluator.extraProposalOdds', 0.5) : 0.5;
            frequency *= Math.pow(decay, used);
        }
        if (RNG.float(state) > frequency) return null;

        // First generator with an offer wins (same order as the old || chain);
        // its name goes into the pricing trace.
        const GENERATORS = ['SetSwap', 'CashForSet', 'CedeSwap', 'MultiSwap', 'ConsolidationSwap', 'BuyPair', 'BuyToward',
            'EntryBuy', 'Broker', 'Package', 'SellSpare', 'CashOut'];
        let offer = null, gen = null;
        const shapeMix = this._cloneShapeMix(player);
        if (shapeMix) {
            const pick = this._cloneShapeOffer(state, player, cfg);
            if (pick) { offer = pick.offer; gen = pick.gen; }
        } else {
            for (const g of GENERATORS) {
                offer = this['_propose' + g](state, player, cfg);
                if (offer) { gen = g; break; }
            }
            // E74 last resort: nothing priced at the normal valuation, so retry the
            // generators that acquire a set's last tile with the trade completion
            // premium on (Package then also tries 3-deed bundles). Off at K = 1.
            // E75 ship: only while >= 3 players are active (heads-up it leaned negative, h2h -1.1).
            const e74MinActive = window.AITuning ? AITuning.get('evaluator.tradeCompletionGainMinActive', 3) : 3;
            // E77 (knob evaluator.tradeCompletionGainMaxActive, 8 = any size): E75 was A/B'd up to 6p
            // only; at 7-8 active the rollout check rarely decides (mw7218im t44: d5 Devon paid $1030
            // on an undecided check and never built red).
            const e74MaxActive = window.AITuning ? AITuning.get('evaluator.tradeCompletionGainMaxActive', 8) : 8;
            const e74Active = GameState.activePlayers(state).length;
            if (!offer && e74Active >= e74MinActive && e74Active <= e74MaxActive &&
                this._tradeCompletionGainMul(player, true) > 1) {
                this._e74Pass = true;
                try {
                    for (const g of ['SetSwap', 'CashForSet', 'BuyPair', 'BuyToward', 'Package']) {
                        offer = this['_propose' + g](state, player, cfg);
                        if (offer && this._e74HumanCooling(state, player, offer)) { offer = null; continue; }
                        if (offer && this._e74Unfunded(state, player, offer)) { offer = null; continue; }
                        if (offer) {
                            gen = g + '_E74';
                            // Non-enumerable sim tag (invisible to records/serialization; inert for play)
                            Object.defineProperty(offer, '_e74', { value: { gen: g, deeds: offer.give.properties.length },
                                enumerable: false, configurable: true });
                            break;
                        }
                    }
                } finally { this._e74Pass = false; }
            }
        }
        this._traceNoTrade(state, player, !offer);
        if (!offer) return null;
        // E54 clone (win-game habit): mostly opens with deals that complete its own set
        if (!shapeMix && w.propOtherKeep != null && !this._completesSetFor(state, offer, player.id) &&
            RNG.float(state) >= w.propOtherKeep) return null;
        if (w.propSlack != null) {
            const ask = this._askOffers && this._askOffers.has(offer);
            offer = this._cloneShadeOffer(state, player, offer, w, ask ? this.CLONE_ASK_SLACK : 0);
            if (ask) Object.defineProperty(offer, '_ask', { value: true, enumerable: false, configurable: true });
        }
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
        // E75 (knob evaluator.tradeCompletionGainLookahead, 0 = off): an E74 last-resort
        // premium offer is the one place a high price needs a second opinion, so it is
        // rollout-checked at ANY table size (E23 kept the general gate heads-up because
        // it mostly held back routine deals at 5p).
        const e74Level = window.AITuning ? AITuning.get('evaluator.tradeCompletionGainLookahead', 1) : 1;
        const e74Check = !!offer._e74 && e74Level > 0;
        const gateOn = (window.AITuning ? AITuning.get('evaluator.lookaheadProposalGate', 1) : 1) > 0 &&
            (GameState.activePlayers(state).length <= 2 || e74Check);
        if (gateOn && p.lookahead && window.Lookahead) {
            const pick = Lookahead.choose(state, player.id,
                [decision, { type: 'ROLL_DICE' }]);
            if (pick && pick.type !== 'PROPOSE_TRADE') {
                this._trace(state, `${player.name} — lookahead holds back a trade to ${state.players[offer.to].name} (rolls on instead).`);
                return null;
            }
            // E77 level 2: a premium offer needs a DECISIVE endorsement; an undecided
            // rollout (null: neither side ahead by lookaheadMargin) holds it back too.
            // Real decisions only (inside a rollout choose() is null by design).
            if (!pick && e74Check && e74Level >= 2 && !Lookahead._active && !Lookahead.disabled &&
                (window.AITuning ? AITuning.get('evaluator.lookaheadRollouts', 8) : 8) >= 1) {
                this._trace(state, `${player.name} — lookahead is undecided on a premium trade to ${state.players[offer.to].name} (rolls on instead).`);
                return null;
            }
            if (pick) {
                this._trace(state, `${player.name} — lookahead endorses the trade to ${state.players[offer.to].name}.`);
            }
        }
        if (offer._e74) this._e74StampHumanAsk(state, player, offer);
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
        const cap = window.AITuning ? AITuning.get('evaluator.tradeRefusalCap', 3) : 3;
        if (cap <= 0) return false;                            // feature off
        const r = player.tradeRefusals && player.tradeRefusals[`${ownerId}:${tileId}`];
        if (!r) return false;
        if (this._ownerMightSell(state, ownerId)) return false; // distress re-opens it
        const base = window.AITuning ? AITuning.get('evaluator.tradeRefusalBackoff', 6) : 6;
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
     * E74 (knob evaluator.tradeCompletionGainMul, def 1 = off): extra credit, in
     * tradeUtility dollars, for a trade that COMPLETES one of my own colour sets.
     * completionMul prices a completion from the last tile's own value, so a cheap
     * tile that finishes a strong set looks barely better than the strays it costs
     * (mw3ncmvv t73: T paid three strays + $220 for Virginia and won with pink; a
     * CPU in T's seat valued Virginia $437 vs the strays $821 and could not offer
     * it). Adds (K - 1) x my gain-side value of each completing tile. Only my own
     * pricing (proposals, counters) sees it; how I RESPOND is unchanged. d3+ by
     * default (evaluator.tradeCompletionGainMinDifficulty); never the Clone of T.
     */
    /**
     * E74 multiplier in effect for this CPU (1 = off): knob, min difficulty, never
     * the Clone of T. Only inside the last-resort proposal pass (_e74Pass, set by
     * _maybeProposeTrade after the normal chain found nothing), so a deal that
     * prices at the normal valuation is never offered with the premium, and
     * counters to other players' offers never use it. `anyPass` asks "would it
     * apply?" outside that pass.
     */
    _tradeCompletionGainMul(player, anyPass) {
        if (!anyPass && !this._e74Pass) return 1;
        const tune = (k, d) => (window.AITuning ? AITuning.get(k, d) : d);
        const k = tune('evaluator.tradeCompletionGainMul', 2);
        if (!(k > 1) || this._isClone(player)) return 1;
        if ((player.difficulty || 0) < tune('evaluator.tradeCompletionGainMinDifficulty', 5)) return 1;
        return k;
    },

    /**
     * E75 human cooldown (knob evaluator.tradeCompletionGainHumanCooldown, turns;
     * 0 = off). A premium offer to a human (or the clone seat) that was turned
     * down blocks further premium offers to that partner for N turns. The ask is
     * stamped on the proposer (serializable) and counted refused when the
     * REJECT_TRADE refusal ledger (tradeRefusals) holds one of its asked tiles
     * at or after the ask turn; an accepted ask leaves no cooldown.
     */
    /**
     * E79 (knob evaluator.tradeCompletionGainFundHouses k, def 0 = off): a premium offer must leave
     * the cash to develop the set it completes. True (drop the offer) when the proposer's cash after
     * the trade is under k houses on every tile of that set. Cash only: mortgaging outside deeds to
     * build stays allowed but does not count here. mw7218im t44: d5 Devon paid $1030 + Reading for
     * Indiana with $1330, kept $300 against $450 for one house per red tile, bankrupt t140.
     */
    _e74Unfunded(state, player, offer) {
        const k = window.AITuning ? AITuning.get('evaluator.tradeCompletionGainFundHouses', 0) : 0;
        if (!(k > 0)) return false;
        const gets = offer.get.properties || [], gives = offer.give.properties || [];
        let need = 0;
        const seen = new Set();
        gets.forEach(id => {
            const g = BOARD[id].group;
            if (!g || seen.has(g) || !BOARD[id].houseCost) return;
            seen.add(g);
            const members = BOARD.filter(t => t.group === g).map(t => t.id);
            const mineAfter = members.every(m => gets.includes(m) ||
                (state.tiles[String(m)].owner === player.id && !gives.includes(m)));
            if (mineAfter) need += k * BOARD[id].houseCost * members.length;
        });
        if (!need) return false;
        const cashAfter = player.cash - (offer.give.cash || 0) + (offer.get.cash || 0);
        return cashAfter < need;
    },

    _e74HumanCooling(state, player, offer) {
        const n = window.AITuning ? AITuning.get('evaluator.tradeCompletionGainHumanCooldown', 15) : 15;
        if (!(n > 0) || !Evaluator.actsHuman(state.players[offer.to])) return false;
        const ask = player.e74HumanAsk && player.e74HumanAsk[offer.to];
        if (!ask) return false;
        let refusedAt = -1;
        for (const tid of ask.tiles) {
            const r = player.tradeRefusals && player.tradeRefusals[`${offer.to}:${tid}`];
            if (r && r.turn >= ask.turn) refusedAt = Math.max(refusedAt, r.turn);
        }
        return refusedAt >= 0 && state.turnNumber - refusedAt < n;
    },

    _e74StampHumanAsk(state, player, offer) {
        if (!Evaluator.actsHuman(state.players[offer.to])) return;
        player.e74HumanAsk = player.e74HumanAsk || {};
        player.e74HumanAsk[offer.to] = { turn: state.turnNumber, tiles: (offer.get.properties || []).slice() };
    },

    _tradeCompletionGainBonus(state, player, offer) {
        const k = this._tradeCompletionGainMul(player);
        if (k <= 1 || offer.from !== player.id) return 0;
        const gets = offer.get.properties || [], gives = offer.give.properties || [];
        let bonus = 0;
        for (const id of gets) {
            const g = BOARD[id].group;
            if (!g || g === 'railroad' || g === 'utility') continue;
            const ids = Rules.tilesInGroup(g);
            if (ids.every(t => Rules.getOwner(state, t) === player.id)) continue; // already mine
            const mineAfter = ids.every(t => gets.includes(t) ||
                (Rules.getOwner(state, t) === player.id && !gives.includes(t)));
            if (!mineAfter) continue;
            bonus += (k - 1) * Evaluator.propertyValue(state, id, player.id,
                { cashAfter: player.cash, skill: this._skill(player), tradePartner: offer.to, tradeSide: 'gain' });
        }
        return bonus;
    },

    /**
     * Pick a cash sweetener that lands inside the zone of agreement: enough
     * that the responder should accept, little enough that the trade is still
     * good for me. Positive = I pay, negative = they pay. Returns null when
     * no such price exists (then the trade is not worth proposing).
     * myBonus: extra utility only the proposer sees (e.g. set prospects).
     */
    _zopaCash(state, player, offer, cfg, myBonus) {
        if (this._cloneAsk) {
            this._cloneAsk = false;
            let cash;
            try { cash = this._zopaCash(state, player, offer, cfg, myBonus); } finally { this._cloneAsk = true; }
            return cash !== null ? cash : this._cloneAskCash(state, player, offer, cfg, myBonus);
        }
        myBonus = (myBonus || 0) + this._tradeCompletionGainBonus(state, player, offer); // E74 (0 when off)
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
        if (modelSkill && !Evaluator.actsHuman(other)) theirOpts.skill = this._skill(other);
        // Level 2: also the rest of what _tradeRespond adds — the responder's
        // set-prospect bonus and its archetype temperament (public part only).
        // Level 1 alone under-priced weak CPUs' asks: accept rates on offers to
        // d1-d3 fell 4-8pp in the E42 A/B (20260930-0301).
        const theirExtra = (modelSkill >= 2 && !Evaluator.actsHuman(other))
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
        const fullExact = exact >= 3 || (exact === 2 && !Evaluator.actsHuman(other));
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
        const exactHere = fullExact || (exact >= 1 && Evaluator.actsHuman(other));
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
        // E55 self-check: toward a human the level-1 fallback above keeps the
        // old linear zone when the solved one is empty or thin. The linear zone
        // is read at $0 and extrapolated, so it misses charges that grow with
        // the cash (E49 race, enemy fuel), and it can name a price my own
        // tradeUtility calls a clear loss (mvd65sat t58: d5 Bailey offered T
        // New York + $450 at its own -627 vs margin -30, then rejected those
        // terms from T at t60; mvcvcpgm t95: d5 Oakley $560 at -289 vs -19).
        // Drop such an offer instead of proposing it. Prices that came from
        // the solved zone already clear this. 1 = on (default, shipped E55), 0 = off.
        const selfCheck = window.AITuning ? AITuning.get('evaluator.zopaSelfCheck', 1) : 1;
        if (selfCheck && !usedExact && Evaluator.actsHuman(other)) {
            const priced = {
                from: offer.from, to: offer.to,
                give: Object.assign({}, offer.give, { cash: (offer.give.cash || 0) + Math.max(0, cash) }),
                get: Object.assign({}, offer.get, { cash: (offer.get.cash || 0) + Math.max(0, -cash) })
            };
            const mine = Evaluator.tradeUtility(state, priced, player.id,
                { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) }) + (myBonus || 0);
            if (mine < myMargin) return null;
        }
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
     * Cede-one-set swap (E56, knob evaluator.cedeSwapMinDifficulty, 0 = off):
     * I'm one tile from two colour sets A and B and the SAME opponent holds
     * both missing tiles. Neither a cash buy (they won't hand me a set for
     * cash I have) nor _proposeSetSwap (they aren't one-away on anything I
     * hold) can move, so offer my B tiles — completing B for them — for their
     * A tile, which completes A for me, cash to balance. Game mvenfm71 t121:
     * d5 Finley sat one-away on orange and green (both blocked by T) for 75
     * turns; Pacific + Pennsylvania Ave for St. James had a real zone. The
     * handover penalty, mutual damping and E49 race price the set they get.
     * Only 3-tile groups are ceded (a 2-tile cede is a SetSwap). Candidates
     * are tried best-first by my $0 utility (no RNG until priced).
     */
    _proposeCedeSwap(state, player, cfg) {
        const minDiff = window.AITuning ? AITuning.get('evaluator.cedeSwapMinDifficulty', 5) : 5;
        if (minDiff <= 0 || (player.difficulty < minDiff && !this._cloneSetDeals(player))) return null;
        const groups = this._oneAwayGroups(state, player.id).filter(g => g.group !== 'railroad');
        const cands = [];
        for (const keep of groups) {
            for (const cede of groups) {
                if (cede === keep || cede.ownerId !== keep.ownerId) continue;
                // Ceding a 2-tile group is one deed for one: the holder is then
                // one-away on it too, which is _proposeSetSwap's offer exactly
                // (its own snub key, so re-offering it here would double-nag).
                if (GROUP_META[cede.group].size < 3) continue;
                const give = Rules.tilesInGroup(cede.group).filter(id => Rules.getOwner(state, id) === player.id);
                const offer = {
                    from: player.id,
                    to: keep.ownerId,
                    give: { cash: 0, properties: give, jailCards: 0 },
                    get: { cash: 0, properties: [keep.missing], jailCards: 0 }
                };
                const u = Evaluator.tradeUtility(state, offer, player.id,
                    { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) });
                cands.push({ offer, keep, cede, u });
            }
        }
        cands.sort((a, b) => b.u - a.u);
        const strandTurns = window.AITuning ? AITuning.get('evaluator.cedeStrandedTurns', 0) : 0;
        if (strandTurns > 0) this._trackStranded(state, player, groups, cfg);
        for (const { offer, keep, cede } of cands) {
            const bonus = strandTurns > 0 ? this._strandedDiscount(state, player, offer, cede.group, strandTurns) : 0;
            const cash = this._zopaCash(state, player, offer, cfg, bonus);
            if (cash === null) continue;
            if (cash > 0) offer.give.cash = cash;
            else offer.get.cash = -cash;
            if (!Trading.validate(state, offer).ok) continue;
            if (this._refusedRecently(state, player, keep.ownerId, keep.missing)) continue;
            if (this._snubbed(state, player, `cede:${keep.ownerId}:${keep.missing}:${cede.group}`)) continue;
            if (!this._tradeCompletionFundable(state, player, offer)) continue;
            // Non-enumerable tag for sim instrumentation (inert for game logic)
            Object.defineProperty(offer, '_cede', { value: { keep: keep.group, cede: cede.group, strand: bonus > 0 }, enumerable: false, configurable: true });
            return offer;
        }
        return null;
    },

    /**
     * E54 clone upgrade, steps 2b + 2 (knob evaluator.cloneShapeMix or the
     * version's shapeMix weight; clone seats only). On a trading turn the clone picks the KIND of deal first,
     * drawn from T's recorded opening-shape mix (fit_human, n 166), and only
     * then looks for one: that shape's generators priced as usual first, then
     * as a zone-less ask (_cloneAskCash). A shape with no candidate is dropped
     * and another drawn. The stock chain takes the first priced deal in its
     * fixed order, so the clone opened cash buys (32%) where T pays with deeds
     * for a completing tile (33%), and took priced multi-deed swaps ~10x as
     * readily as T while never asking for an unpriced one (calibrations
     * 20261019-1406 / -1506).
     */
    // Draw weights, fitted at reach 1 (ai-lab/e54_shapemix_probe.js --fit, 716 T turns) so the OPENED mix
    // matches T's (swap 9.8 / multi 16.8 / buyComplete 4.2 / buy 5.4 / tradeComplete 32.5 / trade 17.4 /
    // sell 13.9%): a shape with no candidate is redrawn, so rarely available shapes weigh more
    // trade / sell then scaled (x0.66 / x1.75) by validation 2's in-sim mix (trade 29% vs 17%, sell 7% vs 14%)
    CLONE_SHAPES: { swap: 0.123, multi: 0.089, buyComplete: 0.001, buy: 0.023, tradeComplete: 0.556, trade: 0.040, sell: 0.261 },
    CLONE_SHAPE_GENS: {
        swap: ['SetSwap'], multi: ['CedeSwap', 'MultiSwap'], buyComplete: ['CashForSet', 'BuyPair'],
        buy: ['BuyToward', 'Broker', 'EntryBuy'], tradeComplete: ['Package'],
        trade: ['ConsolidationSwap', 'Package'], sell: ['SellSpare', 'CashOut'],
    },
    // Generators whose only gate is the zone; Broker / EntryBuy / CashOut gate on more, so they never ask
    CLONE_ASK_GENS: ['SetSwap', 'CedeSwap', 'MultiSwap', 'CashForSet', 'BuyPair', 'BuyToward', 'Package',
        'ConsolidationSwap', 'SellSpare'],

    // Trading-turn rate multiplier in shape mode, set so the clone proposes at T's 4.7 per 100 turns
    // (validation 1: 15.6% of turns at x1 with reach 2; reach 1 finds a deal on 60% vs 67% of trading turns)
    CLONE_SHAPE_RATE: 0.33,
    // Zone-less asks are shaded like priced openings (T's fitted slack, either direction) but aimed this many
    // deal sizes further below the partner's accept point: T's asks run deeper than T's priced openings
    CLONE_ASK_SLACK: 0.5,
    CLONE_ASK_REACH: 1,   // asks further than this many deal sizes below the partner's accept point are not made

    _cloneShapeMix(player) {
        if (!this._isClone(player)) return false;
        if ((window.AITuning ? AITuning.get('evaluator.cloneShapeMix', 0) : 0) > 0) return true;
        const w = Personalities.weights(player);
        return !!(w && w.shapeMix);
    },

    /** Opening shape, classified as fit_human's openingShape() does. */
    _offerShape(state, offer) {
        const me = this._completesSetFor(state, offer, offer.from), them = this._completesSetFor(state, offer, offer.to);
        const offers = offer.give.properties.length, asks = offer.get.properties.length;
        if (me && them) return offers + asks >= 3 ? 'multi' : 'swap';
        if (offers === 0) return me ? 'buyComplete' : 'buy';
        if (asks === 0) return 'sell';
        return me ? 'tradeComplete' : 'trade';
    },

    _cloneShapeOffer(state, player, cfg) {
        const left = Object.assign({}, this.CLONE_SHAPES);
        this._askOffers = this._askOffers || new WeakSet();
        while (Object.keys(left).length) {
            const total = Object.values(left).reduce((a, b) => a + b, 0);
            let r = RNG.float(state) * total, shape = null;
            for (const k in left) { shape = k; if ((r -= left[k]) < 0) break; }
            delete left[shape];
            for (const ask of [false, true]) {
                this._cloneAsk = ask;
                this._cloneWant = shape;
                try {
                    for (const g of this.CLONE_SHAPE_GENS[shape]) {
                        if (ask && !this.CLONE_ASK_GENS.includes(g)) continue;
                        const offer = this['_propose' + g](state, player, cfg);
                        if (offer && this._offerShape(state, offer) === shape) return { offer, gen: g };
                    }
                } finally {
                    this._cloneAsk = false;
                    this._cloneWant = null;
                }
            }
        }
        return null;
    },

    /**
     * Zone-less ask (clone shape mix only): when no price suits both sides, T
     * still asks and lets the partner counter. Start from my own limit (the
     * most I'd pay, or the least I'd take, solved on my tradeUtility curve);
     * _cloneShadeOffer then prices it at T's slack less CLONE_ASK_SLACK. An ask
     * the partner is more than CLONE_ASK_REACH deal sizes from accepting is not made.
     */
    _cloneAskCash(state, player, offer, cfg, myBonus) {
        const other = state.players[offer.to];
        const scale = this._tradeScale(offer);
        const myMargin = this._params(player).tradeMargin * cfg.marginMul * scale;
        const opts = { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) };
        const surplus = c => Evaluator.tradeUtility(state, {
            ...offer,
            give: { ...offer.give, cash: offer.give.cash + Math.max(0, c) },
            get: { ...offer.get, cash: offer.get.cash + Math.max(0, -c) },
        }, player.id, opts) + (myBonus || 0) - myMargin;
        const hi = player.cash - this._floor(state, player) * 0.5, lo = -(other.cash * 0.8);
        let c = Math.max(lo, Math.min(hi, surplus(0)));
        for (let i = 0; i < 6; i++) {
            const u = surplus(c);
            if (u >= 0 && u < 10) break;
            c = Math.max(lo, Math.min(hi, c + u));
        }
        c = Math.floor(c / 10) * 10;
        if (surplus(c) < 0) return null;
        const theirOpts = { handoverPenalty: cfg.handoverPenalty };
        if (!Evaluator.actsHuman(other)) theirOpts.skill = this._skill(other);
        const need = this._respondMargin(state, offer.to, cfg) * scale -
            Evaluator.tradeUtility(state, offer, offer.to, theirOpts);
        if (need - c > scale * this.CLONE_ASK_REACH) return null;
        this._askOffers.add(offer);
        return c;
    },

    /**
     * E54: the human clone (a d4 seat standing in for T) may open the cede and
     * multi-deed swaps that are otherwise gated to d5. They are about one in six
     * of T's recorded openings (fit_human "opening shapes"); without this the
     * clone never makes them. Only clone seats (_isClone), so real CPUs keep their
     * difficulty gate. Each generator's own knob still has to be on.
     */
    _cloneSetDeals(player) {
        return this._isClone(player) && (window.AITuning ? AITuning.get('evaluator.cloneSetDeals', 1) : 1) > 0;
    },

    /**
     * A seat playing an E54 clone version: the sims' humanProxy stand-in for T,
     * or a real game's "Clone of T" seat (`cloneSeat`; humanProxy off, so CPUs
     * treat it as a CPU). Not keyed on the personality: rollouts clear
     * humanProxy, and sims must keep playing their clone seat as before there.
     */
    _isClone(player) {
        return !!(player.humanProxy || player.cloneSeat);
    },

    /**
     * E57 #3: multi-deed mutual completion. For a colour group X that only I
     * and one opponent own, where they hold 2 tiles (I hold the third), and
     * another group Y split only between us, offer my tiles of Y (completing
     * Y for them) for their 2 tiles of X (completing X for me). The 1-for-2
     * form is E56's cede seen from the receiving side, so the deal no longer
     * waits for the opponent to offer it; 2-for-2 is new. SetSwap and
     * CedeSwap cover every shape where I get one tile, so this one only
     * builds offers that get 2. Gated by `evaluator.multiSwapMinDifficulty`
     * (0 = off); priced, guarded and ordered like the cede swap.
     */
    _proposeMultiSwap(state, player, cfg) {
        const minDiff = window.AITuning ? AITuning.get('evaluator.multiSwapMinDifficulty', 5) : 5;
        if (minDiff <= 0 || (player.difficulty < minDiff && !this._cloneSetDeals(player))) return null;
        const cands = [];
        for (const other of state.players) {
            if (other.id === player.id || other.bankrupt) continue;
            const split = [];
            for (const group of Object.keys(GROUP_META)) {
                if (group === 'railroad' || group === 'utility') continue;
                const ids = Rules.tilesInGroup(group);
                if (ids.some(id => Rules.houseCount(state, id) > 0)) continue;
                const owners = ids.map(id => Rules.getOwner(state, id));
                if (owners.some(o => o !== player.id && o !== other.id)) continue;
                const mine = ids.filter((id, i) => owners[i] === player.id);
                const theirs = ids.filter((id, i) => owners[i] === other.id);
                if (mine.length && theirs.length) split.push({ group, mine, theirs });
            }
            for (const x of split) {
                if (x.theirs.length < 2) continue;
                for (const y of split) {
                    if (y === x) continue;
                    const offer = {
                        from: player.id,
                        to: other.id,
                        give: { cash: 0, properties: y.mine.slice(), jailCards: 0 },
                        get: { cash: 0, properties: x.theirs.slice(), jailCards: 0 }
                    };
                    const u = Evaluator.tradeUtility(state, offer, player.id,
                        { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) });
                    cands.push({ offer, x, y, u });
                }
            }
        }
        cands.sort((a, b) => b.u - a.u);
        for (const { offer, x, y } of cands) {
            const cash = this._zopaCash(state, player, offer, cfg);
            if (cash === null) continue;
            if (cash > 0) offer.give.cash = cash;
            else offer.get.cash = -cash;
            if (!Trading.validate(state, offer).ok) continue;
            if (x.theirs.every(id => this._refusedRecently(state, player, offer.to, id))) continue;
            if (this._snubbed(state, player, `multi:${offer.to}:${x.group}:${y.group}`)) continue;
            if (!this._tradeCompletionFundable(state, player, offer)) continue;
            // Non-enumerable tag for sim instrumentation (inert for game logic)
            Object.defineProperty(offer, '_multi', { value: { get: x.group, give: y.group }, enumerable: false, configurable: true });
            return offer;
        }
        return null;
    },

    /**
     * E58: stamp when each of my 3-tile one-away colour groups became
     * "stranded" (no zone for buying the last tile from its holder) and clear
     * groups that are buyable again or no longer one away. Sampled only when
     * the cede generator runs. The probe's zone draw is undone (rngState
     * restored), so tracking never moves the game's dice.
     */
    _trackStranded(state, player, groups, cfg) {
        const since = player.strandedSince = player.strandedSince || {};
        const live = new Set();
        for (const g of groups) {
            if (GROUP_META[g.group].size < 3) continue;
            const direct = {
                from: player.id,
                to: g.ownerId,
                give: { cash: 0, properties: [], jailCards: 0 },
                get: { cash: 0, properties: [g.missing], jailCards: 0 }
            };
            const rng = state.rngState;
            const zone = this._zopaCash(state, player, direct, cfg);
            state.rngState = rng;
            if (zone !== null) continue;
            live.add(g.group);
            if (since[g.group] === undefined) since[g.group] = state.turnNumber;
        }
        for (const group of Object.keys(since)) if (!live.has(group)) delete since[group];
    },

    /**
     * E58: a near-set stranded for `turns`+ turns is really a pair of strays,
     * so when ceding it I drop propertyValue's 1.4x progressing premium on its
     * pieces (passed to _zopaCash as my bonus). Give-up side only: what I pay
     * to acquire anything is unchanged.
     */
    _strandedDiscount(state, player, offer, group, turns) {
        const t = player.strandedSince && player.strandedSince[group];
        if (t === undefined || state.turnNumber - t < turns) return 0;
        const v = offer.give.properties.reduce((sum, id) => sum + Evaluator.propertyValue(state, id, player.id,
            { tradePartner: offer.to, tradeSide: 'lose' }), 0);
        return v - v / 1.4;
    },

    /**
     * Discounted value of ending up one-away on a color group: a slice of the
     * completion premium, haircut by how gettable the last tile looks.
     * Measured conversion rates (20-game sample): last tile held by the same
     * counterparty ~100% (the one-away buy finishes it next turn), in the
     * bank ~30% (opponents snipe it), held by a third party ~30%.
     */
    _prospectBonus(group, lastOwner, otherId, state) {
        // E68: a human sitting on the last tile sells it only on their own terms
        // (one-away overpays with a human holder won 0.17x fair share in 102
        // recorded games), so evaluator.oneAwayHumanHolder >= 1 credits no
        // prospect for it. Default 0 = unchanged; CPU holders are never affected.
        if (state && lastOwner !== null && lastOwner !== undefined && this._humanHolderOff(state, lastOwner)) return 0;
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

    /** E68 level >= 1: the one-away prospect is not credited when this holder acts human. */
    _humanHolderOff(state, ownerId) {
        const level = window.AITuning ? AITuning.get('evaluator.oneAwayHumanHolder', 0) : 0;
        return level >= 1 && Evaluator.actsHuman(state.players[ownerId]);
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
                bonus += this._prospectBonus(group, after[missing], otherId, state);
            } else if (before === size - 1 && afterN < size - 1) {
                // Symmetric loss: giving up a piece of a set I'm one-away on
                // drops me back to two-away and forfeits that completion
                // prospect. Without this a one-away CPU happily sells an
                // assembled set-piece for a small premium and two players
                // ping-pong the same tile (game mrt8w40f, light-blue t31-t64).
                const missing = ids.find(id => Rules.getOwner(state, id) !== player.id);
                bonus -= this._prospectBonus(group, Rules.getOwner(state, missing), otherId, state);
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
        const premium = window.AITuning ? AITuning.get('evaluator.shutoutEntryPremium', 0.5) : 0.5;
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
        const minDiff = window.AITuning ? AITuning.get('evaluator.brokerMinDifficulty', 4) : 4;
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
        // Clone shape mix: T pays with pieces of a weaker near-set to finish a stronger one (41 of
        // T's 48 deed-for-completion openings), so the clone's pool keeps schemed tiles, priced
        // by _prospectUtility; only the target's own group is left out (below)
        // E60: CPUs at or above evaluator.packageSchemedMinDifficulty may do the same (0 = off)
        const want = this._cloneWant;
        const schemedMin = window.AITuning ? AITuning.get('evaluator.packageSchemedMinDifficulty', 0) : 0;
        const widen = !!want || (schemedMin > 0 && player.difficulty >= schemedMin);
        const pool = GameState.propertiesOf(state, player.id)
            .filter(id => {
                const g = BOARD[id].group;
                if (g && Rules.ownsFullGroup(state, player.id, g)) return false;
                return widen || !schemed.has(id);
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
        // Clone shape mix: one-away targets make a tradeComplete, two-away a trade
        const targets = want === 'trade' ? [] : this._oneAwayGroups(state, player.id)
            .map(g => ({ ownerId: g.ownerId, tileId: g.missing }));
        for (const t of want === 'tradeComplete' ? [] : this._twoAwayGroups(state, player.id)) {
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

        // E74: with the trade completion premium on, a one-away target is paid
        // with up to three deeds, ranked by what the holder gains over what I
        // lose (a deed that advances the holder's own set first), as T did at
        // mw3ncmvv t73. Off (K = 1) this is the old list, unchanged.
        const e74 = !want && this._tradeCompletionGainMul(player) > 1;
        const oneAway = new Set(this._oneAwayGroups(state, player.id).map(g => g.missing));
        const packagesFor = target => {
            if (!e74 || !oneAway.has(target.tileId)) return packages;
            const ranked = pool.filter(id => BOARD[id].group !== BOARD[target.tileId].group)
                .map(id => ({ id, gain: Evaluator.propertyValue(state, id, target.ownerId) -
                    Evaluator.propertyValue(state, id, player.id) }))
                .sort((a, b) => b.gain - a.gain).map(e => e.id);
            const out = ranked.map(id => [id]);
            for (let i = 0; i < ranked.length; i++)
                for (let j = i + 1; j < ranked.length; j++) out.push([ranked[i], ranked[j]]);
            for (let i = 0; i < ranked.length; i++)
                for (let j = i + 1; j < ranked.length; j++)
                    for (let m = j + 1; m < ranked.length; m++) out.push([ranked[i], ranked[j], ranked[m]]);
            return out;
        };

        for (const target of targets) {
            // E74 pass: price every bundle for a set's last tile and offer the one
            // that costs me least (my own utility after the price), not the first
            // that fits; the old first-fit order is kept everywhere else.
            const cheapest = e74 && oneAway.has(target.tileId);
            let best = null, bestU = -Infinity;
            for (const give of packagesFor(target)) {
                if (widen && give.some(id => BOARD[id].group === BOARD[target.tileId].group)) continue;
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
                if (!cheapest) return offer;
                const u = Evaluator.tradeUtility(state, offer, player.id,
                    { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) });
                if (u > bestU) { bestU = u; best = offer; }
            }
            if (best) return best;
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
