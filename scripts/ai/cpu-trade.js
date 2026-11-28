/**
 * AI: CPU Player: trading
 *
 * Answering an offer (_tradeRespond, counters), the proposal turn
 * (_maybeProposeTrade: the generator chain, the E74 premium pass, the d5
 * rollout gate), cash pricing inside the zone of agreement (_zopaCash,
 * _exactZone), the refusal ledger and the decision-trace lines.
 *
 * Part of CPUPlayer: the members below are added to the object cpu-player.js
 * defines, so `this` and CPUPlayer.x work across the files.
 *
 * Dependencies: cpu-player (load after it), evaluator, lookahead,
 *               personalities, tuning, rules-engine, game-state
 * Exports: none (extends window.CPUPlayer)
 */

Object.assign(CPUPlayer, {

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
        // Lever fires while judging this offer belong to it (its accept / counter / reject line)
        return this._withOffer(state.trade, () => this._tradeRespondOn(state, player));
    },

    _tradeRespondOn(state, player) {
        const cw = Personalities.weights(player);
        if (cw.tradeBase != null) return this._cloneTradeRespond(state, player, cw);
        const offer = state.trade;
        const p = this._params(player);
        const cfg = this._tradeConfig();
        const rawUtility = Evaluator.tradeUtility(state, offer, player.id,
            { handoverPenalty: cfg.handoverPenalty, skill: this._skill(player) }) +
            this._prospectUtility(state, player, offer,
                AITuning.knob('evaluator.setSwapResponderSplitDrop') ? { dropSplitForfeit: true } : undefined) +
            this._responseTemperament(state, player, offer);
        const utility = rawUtility * (1 + RNG.gauss(state, 0, p.noise));
        this._traceRace(state, player, offer);

        // Scale: total value changing hands, so the margin is proportional
        const scale = this._tradeScale(offer);
        const threshold = p.tradeMargin * cfg.marginMul * scale;

        let accept = utility > threshold;
        // The blunder roll may not turn a reject into handing a human a colour
        // set: every re-sent offer rolls again, so a human could fish for the
        // flip (game mwdrb8ju t61: d3 Harper accepted at -133 vs 0 on the 7th
        // response and T's orange won the game). The roll is still drawn, so
        // the RNG stream is unchanged; flips to reject and CPU-CPU flips stay.
        if (this._blunders(state, player) &&
            (accept || !(Evaluator.actsHuman(state.players[offer.from]) &&
                this._completesSetFor(state, offer, offer.from)))) accept = !accept;
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
            // 1 = any proposer (default since E90, 2026-11-21); 2 = human
            // proposers only (E45's original scope: all-CPU play unchanged).
            const veto = AITuning.knob('evaluator.lookaheadHandoverVeto');
            if (wantsAccept && !accept && veto &&
                (veto === 1 || Evaluator.actsHuman(state.players[offer.from])) &&
                this._completesSetFor(state, offer, offer.from)) {
                giveawayOverride = true;
                this._fire('E45', 'rollout may not hand over a set');
            }
            if (pick && (wantsAccept || accept) && !giveawayOverride) {
                this._fire('E18', wantsAccept === accept ? 'lookahead confirms' : 'lookahead overrides');
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
        // firehose, and distinctness is handled by the _snubbed cooldown, stamped
        // below once an offer is really sent (a shape already sent is skipped
        // this turn, so attempt #2 falls deeper into the chain instead of
        // re-offering the same deal). Gating on tradeAttempts — the engine's authoritative per-turn
        // counter — means the CPU never emits a proposal the engine would reject
        // (a rejected action stalls the turn: dispatch doesn't re-pump).
        const cpuMax = AITuning.knob('evaluator.cpuMaxProposalsPerTurn');
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
        const setMoveNudge = AITuning.knob('evaluator.setMoveNudge');
        let nudged = false;
        if (w.propRate == null && frequency < setMoveNudge && this._skill(player) >= 0.5) {
            const assign = this._assignTargets(state);
            const hasSetMove = this._oneAwayGroups(state, player.id).length > 0 ||
                (this._targetGroupsFor(state, player.id, assign).size > 0 &&
                    this._straysFor(state, player.id, assign).length > 0);
            if (hasSetMove) { frequency = setMoveNudge; nudged = true; }
        }
        // Decaying odds on each proposal beyond the first: a 2nd+ attempt only
        // sometimes fires, so maxing the budget is the exception. The first
        // proposal (used === 0) uses the full nudged frequency, unchanged.
        if (used > 0 && w.propRate == null) {
            const decay = AITuning.knob('evaluator.extraProposalOdds');
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
            const e74MinActive = AITuning.knob('evaluator.tradeCompletionGainMinActive');
            // E77 (knob evaluator.tradeCompletionGainMaxActive, 8 = any size): E75 was A/B'd up to 6p
            // only; at 7-8 active the rollout check rarely decides (mw7218im t44: d5 Devon paid $1030
            // on an undecided check and never built red).
            const e74MaxActive = AITuning.knob('evaluator.tradeCompletionGainMaxActive');
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
        // The cooldown key rides on the generated offer (the clone's shading below
        // builds a new object) and is stamped only once the offer survives the
        // drops that follow.
        const snubKey = offer._snubKey;
        // E54 clone (win-game habit): mostly opens with deals that complete its own set
        if (!shapeMix && w.propOtherKeep != null && !this._completesSetFor(state, offer, player.id) &&
            RNG.float(state) >= w.propOtherKeep) return null;
        if (w.propSlack != null) {
            const ask = this._askOffers && this._askOffers.has(offer);
            offer = this._cloneShadeOffer(state, player, offer, w, ask ? this.CLONE_ASK_SLACK : 0);
            if (ask) Object.defineProperty(offer, '_ask', { value: true, enumerable: false, configurable: true });
        }
        const decision = { type: 'PROPOSE_TRADE', offer: offer };
        if (nudged) this._fire('E12', 'set-move nudge', offer);
        if (used > 0) this._fire('E33', `proposal ${used + 1} this turn`, offer);
        if (offer._e74) this._fire('E74', 'last-resort completion premium', offer);
        const GEN_EFFORT = { CedeSwap: ['E56', 'cede swap'], MultiSwap: ['E57', 'multi-deed swap'],
            Broker: ['E32', 'broker leg 1'], EntryBuy: ['E43', 'shut-out re-entry'] };
        const ge = GEN_EFFORT[String(gen).replace('_E74', '')];
        if (ge) this._fire(ge[0], ge[1], offer);

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
        // Stamped before the gate so its rollouts see the offer as sent, as they
        // always did; a hold-back below takes the stamp off again.
        const snubPrior = this._stampSnub(state, player, snubKey);
        // E75 (knob evaluator.tradeCompletionGainLookahead, 0 = off): an E74 last-resort
        // premium offer is the one place a high price needs a second opinion, so it is
        // rollout-checked at ANY table size (E23 kept the general gate heads-up because
        // it mostly held back routine deals at 5p).
        const e74Level = AITuning.knob('evaluator.tradeCompletionGainLookahead');
        const e74Check = !!offer._e74 && e74Level > 0;
        const gateOn = AITuning.knob('evaluator.lookaheadProposalGate') > 0 &&
            (GameState.activePlayers(state).length <= 2 || e74Check);
        if (gateOn && p.lookahead && window.Lookahead) {
            const pick = Lookahead.choose(state, player.id,
                [decision, { type: 'ROLL_DICE' }]);
            if (pick && pick.type !== 'PROPOSE_TRADE') {
                this._fire(e74Check ? 'E75' : 'E23', 'lookahead holds back the proposal', offer);
                this._trace(state, `${player.name} — lookahead holds back a trade to ${state.players[offer.to].name} (rolls on instead).`, offer);
                this._unstampSnub(player, snubKey, snubPrior);
                return null;
            }
            // E77 level 2: a premium offer needs a DECISIVE endorsement; an undecided
            // rollout (null: neither side ahead by lookaheadMargin) holds it back too.
            // Real decisions only (inside a rollout choose() is null by design).
            if (!pick && e74Check && e74Level >= 2 && !Lookahead._active && !Lookahead.disabled &&
                AITuning.knob('evaluator.lookaheadRollouts') >= 1) {
                this._fire('E77', 'undecided rollout holds back a premium offer', offer);
                this._trace(state, `${player.name} — lookahead is undecided on a premium trade to ${state.players[offer.to].name} (rolls on instead).`, offer);
                this._unstampSnub(player, snubKey, snubPrior);
                return null;
            }
            if (pick) {
                this._fire(e74Check ? 'E75' : 'E23', 'lookahead endorses the proposal', offer);
            }
        }
        if (offer._e74) this._e74StampHumanAsk(state, player, offer);
        this._tracePricing(state, player, offer, gen);
        return decision;
    },

    /** Don't nag: the same ask (same counterparty + tile) is re-proposed at
     *  most once every 10 turns. A generator only CHECKS the cooldown here and
     *  leaves its key on the offer; _maybeProposeTrade stamps it when the offer
     *  is really sent. An offer dropped after this check (unfundable, not the
     *  cheapest premium bundle, the clone's shape or habit filter, the E75
     *  human cooldown, a lookahead hold-back) was never seen by the partner,
     *  so it starts no cooldown. An accepted trade changes ownership so its
     *  key never recurs. */
    _snubbed(state, player, key, offer) {
        const last = player.tradeSnubs && player.tradeSnubs[key];
        if (last !== undefined && state.turnNumber - last < 10) return true;
        // A/B arm snubold (knob evaluator.snubStampOnGenerate 1): the pre-2026-11-13
        // stamp at generation time; no key rides on the offer, so nothing is stamped later.
        if (AITuning.knob('evaluator.snubStampOnGenerate') >= 1) {
            player.tradeSnubs = player.tradeSnubs || {};
            player.tradeSnubs[key] = state.turnNumber;
            return false;
        }
        if (offer) Object.defineProperty(offer, '_snubKey', { value: key, enumerable: false, configurable: true });
        return false;
    },

    /** Start the cooldown for a sent offer; returns the stamp it replaces. */
    _stampSnub(state, player, key) {
        if (key === undefined) return undefined;
        player.tradeSnubs = player.tradeSnubs || {};
        const prior = player.tradeSnubs[key];
        player.tradeSnubs[key] = state.turnNumber;
        return prior;
    },

    /** Undo _stampSnub for an offer that was held back after all. */
    _unstampSnub(player, key, prior) {
        if (key === undefined || !player.tradeSnubs) return;
        if (prior === undefined) delete player.tradeSnubs[key];
        else player.tradeSnubs[key] = prior;
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
        const cap = AITuning.knob('evaluator.tradeRefusalCap');
        if (cap <= 0) return false;                            // feature off
        const r = player.tradeRefusals && player.tradeRefusals[`${ownerId}:${tileId}`];
        if (!r) return false;
        if (this._ownerMightSell(state, ownerId)) return false; // distress re-opens it
        const base = AITuning.knob('evaluator.tradeRefusalBackoff');
        const blocked = this._refusalBlocks(state, r, base);
        if (blocked) this._fire('E31', `skips an ask ${state.players[ownerId] ? state.players[ownerId].name : ownerId} refused`);
        return blocked;
    },

    _refusalBlocks(state, r, base) {
        const cap = AITuning.knob('evaluator.tradeRefusalCap');
        // Exponential backoff with no hard stop (E50): wait base × 2^(n-1)
        // after the n-th no, capped at 8× base, so a holder's circumstances
        // can still change and a deedless CPU keeps an occasional ask alive
        // (mv2jir3q: Lane's only re-entry line). The cap then only switches
        // the ledger on. 0 = the old escalate-then-stop schedule.
        if (AITuning.knob('evaluator.tradeRefusalExp')) {
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
        const k = AITuning.knob('evaluator.tradeCompletionGainMul');
        if (!(k > 1) || this._isClone(player)) return 1;
        if ((player.difficulty || 0) < AITuning.knob('evaluator.tradeCompletionGainMinDifficulty')) return 1;
        return k;
    },

    /**
     * E79 (knob evaluator.tradeCompletionGainFundHouses k, def 0 = off): a premium offer must leave
     * the cash to develop the set it completes. True (drop the offer) when the proposer's cash after
     * the trade is under k houses on every tile of that set. Cash only: mortgaging outside deeds to
     * build stays allowed but does not count here. mw7218im t44: d5 Devon paid $1030 + Reading for
     * Indiana with $1330, kept $300 against $450 for one house per red tile, bankrupt t140.
     */
    _e74Unfunded(state, player, offer) {
        const k = AITuning.knob('evaluator.tradeCompletionGainFundHouses');
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
                // state.tiles holds a record only once a tile was touched (GameState.tileState
                // creates it on demand; a read-only check must not), so an untouched tile is unowned.
                ((state.tiles[m] || {}).owner === player.id && !gives.includes(m)));
            if (mineAfter) need += k * BOARD[id].houseCost * members.length;
        });
        if (!need) return false;
        const cashAfter = player.cash - (offer.give.cash || 0) + (offer.get.cash || 0);
        return cashAfter < need;
    },

    /**
     * E75 human cooldown (knob evaluator.tradeCompletionGainHumanCooldown, turns;
     * 0 = off). A premium offer to a human (or the clone seat) that was turned
     * down blocks further premium offers to that partner for N turns. The ask is
     * stamped on the proposer (serializable) and counted refused when the
     * REJECT_TRADE refusal ledger (tradeRefusals) holds one of its asked tiles
     * at or after the ask turn; an accepted ask leaves no cooldown.
     */
    _e74HumanCooling(state, player, offer) {
        const n = AITuning.knob('evaluator.tradeCompletionGainHumanCooldown');
        if (!(n > 0) || !Evaluator.actsHuman(state.players[offer.to])) return false;
        const ask = player.e74HumanAsk && player.e74HumanAsk[offer.to];
        if (!ask) return false;
        let refusedAt = -1;
        for (const tid of ask.tiles) {
            const r = player.tradeRefusals && player.tradeRefusals[`${offer.to}:${tid}`];
            if (r && r.turn >= ask.turn) refusedAt = Math.max(refusedAt, r.turn);
        }
        const cooling = refusedAt >= 0 && state.turnNumber - refusedAt < n;
        if (cooling) this._fire('E75', `premium offer to ${state.players[offer.to].name} cooling down`);
        return cooling;
    },

    _e74StampHumanAsk(state, player, offer) {
        if (!Evaluator.actsHuman(state.players[offer.to])) return;
        player.e74HumanAsk = player.e74HumanAsk || {};
        player.e74HumanAsk[offer.to] = { turn: state.turnNumber, tiles: (offer.get.properties || []).slice() };
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
        if (bonus > 0) this._fire('E74', `completion premium x${k}`, offer);
        return bonus;
    },

    /** E63: the human's handover weight on a mutual completion (fits: 0.41, then 0.20, then 0). */
    HUMAN_MUTUAL_HANDOVER: 0.2,

    /**
     * E63: true when evaluator.humanMutualHandover is on and the offer completes
     * a colour set (railroads and utilities excluded) for BOTH sides.
     */
    _humanMutualHandover(state, offer) {
        const on = AITuning.knob('evaluator.humanMutualHandover');
        if (!on) return false;
        const after = {};
        Object.keys(state.tiles).forEach(id => { after[id] = Rules.getOwner(state, +id); });
        offer.give.properties.forEach(id => { after[id] = offer.to; });
        offer.get.properties.forEach(id => { after[id] = offer.from; });
        const completes = pid => Object.keys(GROUP_META).some(g => {
            if (g === 'railroad' || g === 'utility') return false;
            const ids = Rules.tilesInGroup(g);
            return ids.every(id => after[id] === pid) && !ids.every(id => Rules.getOwner(state, id) === pid);
        });
        return completes(offer.from) && completes(offer.to);
    },

    /**
     * Pick a cash sweetener that lands inside the zone of agreement: enough
     * that the responder should accept, little enough that the trade is still
     * good for me. Positive = I pay, negative = they pay. Returns null when
     * no such price exists (then the trade is not worth proposing).
     * myBonus: extra utility only the proposer sees (e.g. set prospects).
     */
    _zopaCash(state, player, offer, cfg, myBonus) {
        return this._withOffer(offer, () => this._zopaCashOn(state, player, offer, cfg, myBonus));
    },

    _zopaCashOn(state, player, offer, cfg, myBonus) {
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
        const modelSkill = AITuning.knob('evaluator.zopaResponderSkill');
        if (modelSkill && !Evaluator.actsHuman(other)) theirOpts.skill = this._skill(other);
        // E63: a human answering a MUTUAL completion (the deal completes a colour
        // set for both sides) charges far less for handing the CPU its set than
        // the CPU's own 0.85: the E54 fit of T's answers puts that weight at
        // 0.41 (clone c) and 0-0.20 in every refit since. Level 1 prices the
        // human's side of a mutual completion at HUMAN_MUTUAL_HANDOVER; pure
        // handovers keep the CPU's weight (T refuses those outright, which the
        // full charge approximates). Human partners only; default 1 since
        // 2026-11-12, 0 = off.
        if (Evaluator.actsHuman(other) && this._humanMutualHandover(state, offer)) {
            theirOpts.handoverPenalty = Math.min(theirOpts.handoverPenalty, this.HUMAN_MUTUAL_HANDOVER);
            this._fire('E63', `human handover ${this.HUMAN_MUTUAL_HANDOVER} on a mutual completion`);
        }
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
        const exact = AITuning.knob('evaluator.zopaExactCash');
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
                if (h - l >= scale * 0.1) {
                    if (h < high - 1) this._fire('E46', 'solved cash zone lowers the price');
                    low = l; high = h; usedExact = true;
                }
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
        const selfCheck = AITuning.knob('evaluator.zopaSelfCheck');
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

    /** E49: one decision-trace line when the development-race charge moved a
     *  trade decision (the respond path, or a priced proposal/counter). */
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
    _tracePricing(state, player, offer, gen) {
        const to = state.players[offer.to] ? state.players[offer.to].name : String(offer.to);
        const n = this._pricing && this._pricing.get(offer);
        const r = v => Math.round(v);
        this._traceRace(state, player, offer);
        this._trace(state, n
            ? `${player.name} — prices trade to ${to} [${gen}]: zone $${r(n.low)}..$${r(n.high)}, ` +
              `spot ${n.frac.toFixed(3)} -> $${n.cash} (cash $${n.has}, bonus ${r(n.bonus)}, ${n.exact ? 'exact' : 'linear'}).`
            : `${player.name} — prices trade to ${to} [${gen}]: unpriced (cash $${player.cash}).`, offer);
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
});
