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
 * This file is the core: the difficulty table, the decision entry, the lever
 * log, valuation and reserves, turn management (build / mortgage / jail),
 * buying, auctions and debt. Three files loaded after it add the rest to the
 * same object: cpu-trade.js (answering, proposing and pricing trades),
 * cpu-trade-generators.js (the offer generators) and cpu-clone.js (the E54
 * Clone of T paths).
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
        const live = !(window.Lookahead && Lookahead._active);
        if (live) { this._lev = null; this._levScope = []; }
        const action = this._decide(state, playerId);
        if (live && this._lev && this._lev.size) this._flushLevers(state, state.players[playerId], action);
        return action;
    },

    _decide(state, playerId) {
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

    _trace(state, text, offer) {
        if (window.Lookahead && Lookahead._active) return;
        const levers = this._takeLevers(offer || this._levScope[this._levScope.length - 1]);
        GameState.addLog(state, text, levers.length ? { detail: true, cat: 'ai', levers } : { detail: true, cat: 'ai' });
    },

    /* ---------- Lever log (2026-11-12) ----------

     * Which catalogued efforts (docs/ai/) changed a CPU decision, so /review-games can tie a decision
     * to the lever behind it without re-running the code. A lever calls _fire('E63', 'note') on the
     * branch where it changes a value or a choice (not where it merely reads its knob). Fires go to the
     * innermost scope:
     * - an OFFER (trade pricing and answers: _zopaCash, Evaluator.tradeUtility and the generators push
     *   the offer they are working on), read back by the trace line for that offer;
     * - else the decision in progress (one nextAction call), attached to the next trace line, or, if
     *   the decision wrote none, to one "levers:" line after it (deduped per auction / per turn).
     * Log entries carry them as `levers: ["E63 mutual handover 0.2", ...]`; the text never changes, so
     * the replay scripts' patterns and the A/B counters are unaffected. Nothing here touches the RNG or
     * the state's game data: sims stay byte-identical apart from the log. Silent in lookahead rollouts. */
    _lev: null,

    _levScope: [],

    _levOffer: typeof WeakMap !== 'undefined' ? new WeakMap() : null,

    _levSeen: typeof WeakMap !== 'undefined' ? new WeakMap() : null,

    _fire(tag, note, offer) {
        if (window.Lookahead && Lookahead._active) return;
        const key = offer || this._levScope[this._levScope.length - 1];
        let m;
        if (key && this._levOffer) {
            m = this._levOffer.get(key);
            if (!m) { m = new Map(); this._levOffer.set(key, m); }
        } else {
            m = this._lev || (this._lev = new Map());
        }
        if (!m.has(tag)) m.set(tag, note || '');
    },

    /** Run fn with fires routed to this offer (trade candidates priced but never proposed stay out of the log). */
    _withOffer(offer, fn) {
        if (!offer || (window.Lookahead && Lookahead._active)) return fn();
        this._levScope.push(offer);
        try { return fn(); } finally { this._levScope.pop(); }
    },

    /** The levers for a trace line: the offer's (kept, a later line may repeat them) plus the decision's (consumed). */
    _takeLevers(offer) {
        const out = [];
        const add = m => m && m.forEach((note, tag) => { const t = note ? `${tag} ${note}` : tag; if (!out.includes(t)) out.push(t); });
        if (offer && this._levOffer) add(this._levOffer.get(offer));
        add(this._lev);
        this._lev = null;
        return out;
    },

    // Decisions that get a "levers:" line of their own: the ones about a deed, a bid, a house, a mortgage or
    // jail. A roll or end of turn changes nothing a lever could own (valuation side-reads only), and trade
    // decisions carry their levers on their own trace lines.
    LEVER_LINE_ACTIONS: ['BUY_PROPERTY', 'DECLINE_BUY', 'AUCTION_BID', 'AUCTION_PASS', 'BUILD_HOUSE', 'SELL_HOUSE',
        'MORTGAGE', 'UNMORTGAGE', 'JAIL_PAY', 'JAIL_CARD', 'JAIL_ROLL', 'PAY_DEBT', 'DECLARE_BANKRUPTCY'],

    // Levers that only matter when the decision actually takes that action (E71's mortgage order is also
    // computed to size a stretch bid that raises no cash)
    LEVER_ONLY_ON: { E71: ['MORTGAGE'], E80: ['MORTGAGE'], E30: ['UNMORTGAGE'] },

    _flushLevers(state, player, action) {
        const levers = this._takeLevers(null).filter(l => {
            const only = this.LEVER_ONLY_ON[l.split(' ')[0]];
            return !only || (action && only.includes(action.type));
        });
        if (!levers.length || !player || !action || !this.LEVER_LINE_ACTIONS.includes(action.type)) return;
        const tile = action && action.tileId != null ? BOARD[action.tileId]
            : state.auction ? BOARD[state.auction.tileId]
            : state.pendingAction && state.pendingAction.tileId != null ? BOARD[state.pendingAction.tileId] : null;
        const what = ({
            BUY_PROPERTY: 'buys', DECLINE_BUY: 'passes', AUCTION_BID: `bids $${action.amount}`, AUCTION_PASS: 'drops out',
            BUILD_HOUSE: 'builds', SELL_HOUSE: 'sells a house', MORTGAGE: 'mortgages', UNMORTGAGE: 'lifts a mortgage',
            JAIL_PAY: 'pays the jail fine', JAIL_CARD: 'uses a jail card', JAIL_ROLL: 'rolls for doubles in jail',
            PAY_DEBT: 'pays the debt', DECLARE_BANKRUPTCY: 'declares bankruptcy',
        }[action.type] || action.type.toLowerCase());
        // One line per auction (per bidder) and per turn phase while the set of levers stays the same
        if (this._levSeen) {
            const scope = state.auction || state;
            let seen = this._levSeen.get(scope);
            if (!seen) { seen = new Map(); this._levSeen.set(scope, seen); }
            const k = `${player.id}|${state.auction ? 'a' : state.turnNumber + state.phase}`, sig = levers.join(';');
            if (seen.get(k) === sig) return;
            seen.set(k, sig);
        }
        GameState.addLog(state, `${player.name} — levers: ${what}${tile ? ' ' + tile.name : ''}.`,
            { detail: true, cat: 'ai', levers });
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
        const k = AITuning.knob('evaluator.d5FocusBias');
        if (k <= 0 || group === 'railroad' || group === 'utility') return 1;
        // Heads-up only by default; evaluator.d5FocusMaxPlayers re-opens wider
        // tables for the 2026-10-17 re-test of the 5p closure (6 cells, pre-E38).
        const maxPlayers = AITuning.knob('evaluator.d5FocusMaxPlayers');
        if (GameState.activePlayers(state).length > maxPlayers) return 1;
        const focus = this._focusGroups(state, player.id);
        if (!focus.size) return 1;               // no foothold yet — don't restrict
        if (focus.has(group)) { this._fire('E24', 'd5 focus group'); return 1 + k; }      // concentrate here
        const mine = Rules.tilesInGroup(group)
            .filter(id => Rules.getOwner(state, id) === player.id).length;
        if (mine === 0) { this._fire('E24', 'd5 focus: new group discounted'); return 1 - k * 0.6; }     // discourage opening a NEW group
        return 1;
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
        const level = AITuning.knob('evaluator.deferBuildToTurnEnd');
        if (!level || state.currentPlayer !== player.id) return false;
        if (Personalities.weights(player).buildGo != null) return false; // E54 clone: pinned benchmark
        if (state.phase === GamePhase.AWAIT_PREROLL) {
            const wait = level >= 2 || state.doublesCount > 0;
            if (wait) this._fire('E72', 'building waits for the last roll');
            return wait;
        }
        if (state.phase === GamePhase.AWAIT_ENDTURN) {
            // Mirrors TurnEngine END_TURN: doubles grant another roll unless jailed.
            const wait = !!(state.rollMeta && state.rollMeta.doubles && !player.inJail && !player.bankrupt);
            if (wait) this._fire('E72', 'building waits for the last roll');
            return wait;
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
        let buildFloor = floor;
        if (this._skill(player) >= 0.5) {
            const ahead = Evaluator.threatAhead(state, player.id);
            const worstBoard = Evaluator.maxThreatRent(state, player.id);
            if (worstBoard >= 200 && ahead.worst < worstBoard * 0.35) {
                buildFloor = floor * AITuning.knob('evaluator.greenLightFloorMul');
                this._fire('E62', 'green-light build reserve');
            }
        }
        if ((player.difficulty || 0) >= AITuning.knob('evaluator.buildFloorMinDifficulty')) {
            buildFloor *= AITuning.knob('evaluator.buildFloorScale');
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
            this._fire('E30', 'unfreeze before building');
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
        // Clone no-build turn (knob evaluator.cloneNoBuildMortgage, def 1): the clone's
        // build floor is Infinity, so no house will be bought this turn; don't mortgage a
        // deed to fund one (game mwa7afun: Reese mortgaged North Carolina, Atlantic and
        // Ventnor with $221-$551 in hand and built nothing). 0 = the old behaviour.
        const cloneIdle = w.buildGo != null && buildFloor === Infinity &&
            AITuning.knob('evaluator.cloneNoBuildMortgage') >= 1;
        if (this._skill(player) >= 0.5 && !cloneIdle) {
            const starved = this._starvedBuild(state, player);
            if (starved) {
                const eq = this._stretchEquity(state, player);
                if (eq.tiles.length &&
                    player.cash + Rules.mortgageValue(eq.tiles[0]) - starved.houseCost >= floor) {
                    return { type: 'MORTGAGE', tileId: eq.tiles[0], playerId: player.id };
                }
            }
            // E80 (knob evaluator.starvedBuildFund, def 2, d5 only; shipped 2026-11-09): the cases the
            // stretch-build above misses. Management path only, so trade offers
            // (which also read _starvedBuild) are unchanged.
            const funded = this._e80FundTile(state, player, floor);
            if (funded != null) { this._fire('E80', 'mortgages a spare deed to fund a starved set'); return { type: 'MORTGAGE', tileId: funded, playerId: player.id }; }
        }

        // Unmortgage monopoly members first, then singles (each in board
        // order). One list in board order let a spare single ahead of a
        // frozen set member take the cash that member needed.
        const inSet = id => !!(BOARD[id].group && Rules.ownsFullGroup(state, player.id, BOARD[id].group));
        const held = props.filter(id => state.tiles[id].mortgaged);
        const mortgaged = held.filter(inSet).concat(held.filter(id => !inSet(id)));
        for (const tileId of mortgaged) {
            const cost = Rules.unmortgageCost(tileId);
            if (player.cash - cost < floor * 1.3) continue;
            const inMonopoly = inSet(tileId);
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
            .filter(id => Rules.getOwner(state, id) === player.id && state.tiles[id].mortgaged);
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
        const last = AITuning.knob('evaluator.stretchTargetLast');
        if (last && target && target.type === 'property' && target.group) {
            const g = target.group;
            const outside = tiles.filter(id => BOARD[id].group !== g);
            const inside = tiles.filter(id => BOARD[id].group === g);
            if (inside.length && outside.length) this._fire('E71', `mortgages outside ${g} first`);
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
        const k = AITuning.knob('evaluator.unfreezeSetPriority');
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
     * E80: a stretch-build mortgage the shipped rule misses (the knob's only
     * effect; null when off or nothing qualifies). Level 1: the house costs
     * more than the cash on hand (canBuildHouse refuses, so _starvedBuild
     * never saw it; msiy5u5q Kit held yellow bare t42-t68 with $435 of spare
     * deeds). Level 2: also when no single spare deed clears the reserve but
     * the first k together do (mvlqa1mf t43 Gale, two $130 deeds). E21's rule
     * holds: each deed is mortgaged into real cash before the house is bought,
     * and only if the deeds actually mortgaged leave the full floor after the
     * house; untapped equity never counts as reserve.
     */
    _e80FundTile(state, player, floor) {
        const level = AITuning.knob('evaluator.starvedBuildFund');
        if (!(level >= 1)) return null;
        // E80 narrowing (round 1): the full A/B had d3 seats gaining at d5's cost
        // (sbf2 4p d3 +2.4 / d5 -3.0), so the knob can be limited to strong seats.
        const minD = AITuning.knob('evaluator.starvedBuildFundMinDifficulty');
        if ((player.difficulty || 0) < minD) return null;
        // E80 narrowing (round 2): d5-only was promising at 5p (+2.3, 7/8) but
        // failed the quality gate at CPU-only 4p (steps +14.1%), so it can be gated
        // on the number of players still in the game.
        const minA = AITuning.knob('evaluator.starvedBuildFundMinActive');
        if (minA > 0 && GameState.activePlayers(state).length < minA) return null;
        const starved = this._starvedBuild(state, player, true);
        if (!starved) return null;
        const eq = this._stretchEquity(state, player);
        if (!eq.tiles.length) return null;
        let raised = 0;
        const deeds = level >= 2 ? eq.tiles.length : 1;
        for (let i = 0; i < deeds; i++) {
            raised += Rules.mortgageValue(eq.tiles[i]);
            if (player.cash + raised - starved.houseCost >= floor) return eq.tiles[0];
        }
        return null;
    },

    /**
     * The best house I could legally build right now but cannot fund, or
     * null when no legal build exists / some build is already affordable
     * (then _bestManagement handles it normally).
     */
    _starvedBuild(state, player, belowCash) {
        const floor = this._floor(state, player);
        let best = null, anyAffordable = false;
        GameState.propertiesOf(state, player.id).forEach(tileId => {
            const can = Rules.canBuildHouse(state, player.id, tileId);
            // E80 level 1: a build refused ONLY for cash under one house is
            // still a starved build (canBuildHouse checks cash last).
            if (!can.ok && !(belowCash && can.reason === 'Not enough cash')) return;
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
        const lift = AITuning.knob('evaluator.multiplayerBuyLift');
        if (lift > 0 && w.buyBias < 1 && GameState.activePlayers(state).length >= 3) {
            this._fire('E38', `buy lift +${lift}`);
            return w.buyBias + lift;
        }
        return w.buyBias;
    },

    /** Colour deeds (not railroads / utilities) a player holds. */
    _colourDeedCount(state, playerId) {
        return BOARD.filter(t => t.type === 'property' && Rules.getOwner(state, t.id) === playerId).length;
    },

    /**
     * E82 thin-seat entry premium (knob evaluator.thinSeatPremium, 0 = off; GATED 2026-11-12: 0.5 for d5 only).
     * A d3+ CPU that holds at most one colour deed and has cash of at least 2x
     * its floor adds k x list price to what a colour deed it does not own is
     * worth to it: at the bank, in its auction ceiling and in its BuyToward
     * offers. In 126 recorded games, 62 d3+ seats that were this thin through
     * t40-60 won 0 (other seats 19%); 56 of them sat on $1000+ (deedless_exposure.py).
     * Reserve rules are unchanged, and the premium ends at two colour deeds.
     * Clone seats are excluded (their play is the pinned E54 model).
     */
    // E82: evaluator.thinSeatMinSkill (0.5 = d3+, 1 = d5 only; shipped 1).
    _thinSkillOk(player) {
        const m = AITuning.knob('evaluator.thinSeatMinSkill');
        return this._skill(player) >= m;
    },

    _thinPremium(state, player, tileId) {
        const k = AITuning.knob('evaluator.thinSeatPremium');
        if (!(k > 0) || !this._thinSkillOk(player) || this._isClone(player)) return 0;
        const t = BOARD[tileId];
        if (!t || t.type !== 'property' || Rules.getOwner(state, tileId) === player.id) return 0;
        if (player.cash < this._floor(state, player) * 2) return 0;
        if (this._colourDeedCount(state, player.id) > 1) return 0;
        this._fire('E82', `thin-seat premium $${Math.round(t.price * k)}`);
        return t.price * k;
    },

    /** E82 sim tag on an offer the thin-seat premium shaped (non-enumerable, like _e74:
     *  invisible to records and serialization, inert for play). */
    _tagThin(offer) {
        Object.defineProperty(offer, '_thin', { value: true, enumerable: false, configurable: true });
    },

    /** E67: finish a started stretch-buy/bid, in fields bigger than the buy-veto gate. */
    _stretchCommits(state) {
        if (!AITuning.knob('evaluator.stretchCommit')) return false;
        const vetoMax = AITuning.knob('evaluator.lookaheadBuyVetoMaxPlayers');
        return GameState.activePlayers(state).length > vetoMax;
    },

    _buyOrAuction(state, player) {
        const tileId = state.pendingAction.tileId;
        const price = BOARD[tileId].price;
        const w = Personalities.weights(player);
        const value = this._value(state, player, tileId,
            { cashAfter: player.cash - price, skill: this._skill(player) }) * this._buyBias(state, w) +
            this._thinPremium(state, player, tileId);
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
            this._fire('E67', 'stretch commit');
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
        const clearRatio = AITuning.knob('evaluator.lookaheadBuyClearRatio');
        const vetoMax = AITuning.knob('evaluator.lookaheadBuyVetoMaxPlayers');
        const bigField = GameState.activePlayers(state).length > vetoMax;
        // ...and in a big field never let it veto a wanted buy that completes
        // MY OWN set (E67). The heuristic already demanded value > price and a
        // funded build or a stretch; at ~1 own turn the rollout never sees the
        // monopoly pay and scores the deed at face, so it reads "keep the cash"
        // and hands the completer to the auction (Alex, 5p, passed Boardwalk
        // holding Park Place). Same bigField gate as above: ungated, it cost d5
        // heads-up -2.4 win / -3.0 capWin (A/B 20261029-1501), where the rollout
        // is accurate, and was null at 4p/5p.
        const setVeto = AITuning.knob('evaluator.lookaheadSetBuyVeto');
        const clearBuy = wantBuy && ((!setVeto && completesSet && bigField) || (player.cash - price > floor &&
            (bigField || (clearRatio > 0 && value >= price * clearRatio))));
        if (clearBuy && p.lookahead && window.Lookahead && player.cash >= price) {
            if (!setVeto && completesSet && bigField) this._fire('E67', 'own completer: no rollout veto');
            else if (bigField) this._fire('E27', 'no rollout buy veto past heads-up');
            else this._fire('E19', 'clear buy, rollout skipped');
        }
        if (p.lookahead && window.Lookahead && player.cash >= price && !clearBuy) {
            const pick = Lookahead.choose(state, player.id,
                [{ type: 'BUY_PROPERTY' }, { type: 'DECLINE_BUY' }]);
            if (pick) {
                const wantsBuy = pick.type === 'BUY_PROPERTY';
                this._fire('E18', wantsBuy === wantBuy ? 'lookahead confirms' : 'lookahead overrides');
                this._trace(state, `${player.name} — lookahead ${wantsBuy === wantBuy ? 'confirms' : 'overrides to'} ` +
                    `${wantsBuy ? 'buy' : 'pass'} on ${tile.name} ($${price}, valued $${Math.round(value)}).`);
                // Mark a pass the rollout forced on a seat that wanted to buy: the clone's
                // auction model has no decliner cap of its own (see _cloneAuctionBid).
                if (!wantsBuy && wantBuy) return Object.assign({}, pick, { byRollout: true });
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

    /**
     * E89 (knob evaluator.auctionCompletionPremium d, def 0.5 since 2026-11-21; 0 = old behaviour): on a tile that completes the
     * bidder's own colour set, add d x the E75 trade completion premium ((K - 1) x its value), so the
     * auction ceiling matches what the same d5 would pay for the tile in a trade. E75's gates: d5
     * (tradeCompletionGainMinDifficulty), players left within its min/max, never the Clone of T.
     * mwp105bd t90: Nico passed Indiana at $511 holding $2512, then paid Devon $1470 for it at t91.
     */
    _auctionCompletionPremium(state, player, baseValue) {
        const d = AITuning.knob('evaluator.auctionCompletionPremium');
        if (!(d > 0) || !(baseValue > 0) || this._isClone(player)) return 0;
        const k = AITuning.knob('evaluator.tradeCompletionGainMul');
        if (!(k > 1)) return 0;
        if ((player.difficulty || 0) < AITuning.knob('evaluator.tradeCompletionGainMinDifficulty')) return 0;
        const active = GameState.activePlayers(state).length;
        if (active < AITuning.knob('evaluator.tradeCompletionGainMinActive') ||
            active > AITuning.knob('evaluator.tradeCompletionGainMaxActive')) return 0;
        const premium = d * (k - 1) * baseValue;
        this._fire('E89', `auction completion premium +$${Math.round(premium)}`);
        return premium;
    },

    /**
     * E91 (knob evaluator.auctionPremiumCashOnly, def 0 = today): the stretch (mortgage-funded) auction
     * ceiling. At 1 the E89 completion premium is left out of it, so the premium is paid from cash only and
     * never with mortgaged deeds (mwsn62er t38: Marley paid $823 for Pennsylvania on the premium, mortgaging
     * both other greens, and never built; mwqr0rs6 t80 Tate, Park Place mortgaged for Boardwalk).
     */
    _auctionStretchCeiling(state, player, value, premium, reach, cashCeil) {
        const full = Math.min(value, reach);
        if (!(premium > 0) || !AITuning.knob('evaluator.auctionPremiumCashOnly')) return full;
        const cut = Math.min(value - premium, reach);
        if (full > cashCeil && cut < full) this._fire('E91', `stretch ceiling without the premium $${Math.round(Math.max(cut, cashCeil))}`);
        return cut;
    },

    /**
     * E85 (knobs evaluator.auctionMortgageFloor, def 0 = off; auctionMortgageFloorMinDifficulty, def 3):
     * a stock CPU's auction ceiling is at least min(mortgage value, cash). A deed won at or under its
     * mortgage value can be mortgaged straight back for at least the price, so the reserve that capped
     * the bid is not at risk. Without it a CPU under half its reserve passes at any price (mwe4yz32 t91:
     * the human took Indiana Avenue for $10 while d5 Lennon held $122). The Clone of T has its own
     * version (cloneLowballCeiling) and never reaches this path.
     */
    _auctionMortgageFloor(state, player, maxWill) {
        if (!AITuning.knob('evaluator.auctionMortgageFloor') || this._isClone(player)) return maxWill;
        if ((player.difficulty || 0) < AITuning.knob('evaluator.auctionMortgageFloorMinDifficulty')) return maxWill;
        const low = Math.min(Rules.mortgageValue(state.auction.tileId), player.cash);
        if (!(low > maxWill)) return maxWill;
        this._fire('E85', `auction mortgage floor to $${Math.round(low)}`);
        return low;
    },

    _auctionBid(state, player) {
        const a = state.auction;
        const w = Personalities.weights(player);
        if (w.engageBias != null) return this._cloneAuctionBid(state, player, w);
        const aTile = BOARD[a.tileId];
        const completesMine = aTile.group && !['railroad', 'utility'].includes(aTile.group) &&
            Rules.countOwnedInGroup(state, player.id, aTile.group) === GROUP_META[aTile.group].size - 1;
        const baseValue = this._value(state, player, a.tileId,
            { cashAfter: player.cash - a.currentBid, skill: this._skill(player) });
        const premium = completesMine ? this._auctionCompletionPremium(state, player, baseValue) : 0;
        const value = baseValue * w.bidBias + this._thinPremium(state, player, a.tileId) + premium;
        const floor = this._floor(state, player);
        let maxWill = Math.min(value, player.cash - floor * 0.5, player.cash);

        // Stretch funding (d3+): for a set-completing or set-denying tile,
        // spare-single mortgage equity extends the bid ceiling past cash.
        let stretch = null;
        if (this._skill(player) >= 0.5 && this._stretchWorthy(state, player, a.tileId)) {
            const eq = this._stretchEquity(state, player, a.tileId);
            if (eq.tiles.length) {
                stretch = eq;
                maxWill = Math.max(maxWill, this._auctionStretchCeiling(state, player, value, premium,
                    player.cash + eq.total - floor * 0.25, maxWill));
            }
        }


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
        const setBluff = AITuning.knob('evaluator.auctionSetBluff');
        const p = this._params(player);
        if (p.auctionSmarts >= 1 && a.currentWinner !== null && a.currentWinner !== player.id &&
            !setBluff && completesMine) this._fire('E67', 'no bluff bid on own completer');
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

        // E85: never below min(mortgage value, cash) when the knob is on (after the bluff and the
        // decliner cap, which can only lower it; the mortgage value is always under list price).
        maxWill = this._auctionMortgageFloor(state, player, maxWill);

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
        const blockK = AITuning.knob('evaluator.auctionBlockValue');
        const seats = state.players.length;
        const blockSeats = seats >= AITuning.knob('evaluator.auctionBlockMinSeats') &&
            seats <= AITuning.knob('evaluator.auctionBlockMaxSeats');
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
                    this._fire('E51', `block-bid vs ${denied.name}`);
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
    _auctionRaise(currentBid, maxWill, reach, state, playerId) {
        const mode = AITuning.knob('evaluator.auctionHumanSteps');
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
