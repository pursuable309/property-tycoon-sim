/**
 * AI: CPU Player: Clone of T (E54)
 *
 * Every path only the clone seat takes (Personalities clone weights fitted
 * to the human player T): contextual valuation, auctions, the bursty build
 * floor, trade answers, proposal odds, offer shapes and asks. Called from
 * the core and the trade files behind _isClone / a clone weights check.
 *
 * Part of CPUPlayer: the members below are added to the object cpu-player.js
 * defines, so `this` and CPUPlayer.x work across the files.
 *
 * Dependencies: cpu-player (load after it), evaluator, lookahead,
 *               personalities, tuning, rules-engine, game-state
 * Exports: none (extends window.CPUPlayer)
 */

Object.assign(CPUPlayer, {

    /** E54 clone: list x (value/list)^k — k=1 is the CPU's full contextual value, 0 is list price. */
    _cloneContext(value, price, k) {
        return value > 0 && price > 0 ? price * Math.pow(value / price, k) : value;
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
            // The fitted human has no decliner cap, but a pass the d5 rollout forced on
            // the strong clone is not the fitted model's choice: bidding past list for
            // the tile it just refused is incoherent (game mwe4hq59 t6: passed Boardwalk
            // at $400, won it at $451). Cap at list unless the tile completes its own set.
            const completesMine = !!tile.group &&
                Rules.countOwnedInGroup(state, player.id, tile.group) === GROUP_META[tile.group].size - 1;
            const capped = a.byRollout && a.declinedBy === player.id && !completesMine
                ? Math.min(ceiling, tile.price) : ceiling;
            c = a.clone[player.id] = { engage, ceiling: Math.round(capped) };
        }
        if (player.id === a.currentWinner) return { type: 'AUCTION_PASS', playerId: player.id };
        if (!c.engage) {
            // Not contesting still isn't letting a deed go for $1 (knob evaluator.cloneLowballCeiling,
            // def 1): bid up to the tile's mortgage value, from spare cash only (game mwa7afun: the human
            // took both utilities and Pacific for $1 and Pennsylvania for $10). 0 = pass at once (old clone).
            if (!AITuning.knob('evaluator.cloneLowballCeiling')) {
                return { type: 'AUCTION_PASS', playerId: player.id };
            }
            const low = Math.min(Rules.mortgageValue(a.tileId), player.cash - this._acquireFloor(state, player) * 0.5);
            const bid = this._auctionRaise(a.currentBid, low, player.cash, state, player.id);
            return bid !== null ? { type: 'AUCTION_BID', playerId: player.id, amount: bid } : { type: 'AUCTION_PASS', playerId: player.id };
        }
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
        if (AITuning.knob('evaluator.cloneShapeMix') > 0) return true;
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
        return this._isClone(player) && AITuning.knob('evaluator.cloneSetDeals') > 0;
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
});
