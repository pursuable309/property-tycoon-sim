/**
 * AI: CPU Player: trade generators
 *
 * The offer generators _maybeProposeTrade runs in chain order (_propose*:
 * SetSwap, CashForSet, CedeSwap, MultiSwap, ConsolidationSwap, BuyPair,
 * BuyToward, EntryBuy, Broker, Package, SellSpare, CashOut) and the board
 * reads they share (one-away / two-away groups, set prospects, stranded
 * sets, target assignment).
 *
 * Part of CPUPlayer: the members below are added to the object cpu-player.js
 * defines, so `this` and CPUPlayer.x work across the files.
 *
 * Dependencies: cpu-player (load after it), evaluator, lookahead,
 *               personalities, tuning, rules-engine, game-state
 * Exports: none (extends window.CPUPlayer)
 */

Object.assign(CPUPlayer, {

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
        const k = AITuning.knob('evaluator.tradeCompletionReserve');
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
                const minNet = state.tiles[tileId].mortgaged ? 30 : Rules.mortgageValue(tileId);
                if (offer.get.cash <= minNet) continue;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._snubbed(state, player, `cashout:${other.id}:${tileId}`, offer)) continue;
                return offer;
            }
        }
        return null;
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
                const cash = this._zopaCash(state, player, offer, cfg, this._setSwapProspect(state, player, offer));
                if (cash === null) continue;
                if (cash > 0) offer.give.cash = cash;
                else offer.get.cash = -cash;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._refusedRecently(state, player, mine.ownerId, mine.missing)) continue;
                if (this._snubbed(state, player, `swap:${mine.ownerId}:${mine.missing}:${theirs.missing}`, offer)) continue;
                if (!this._tradeCompletionFundable(state, player, offer)) continue;
                return offer;
            }
        }
        return null;
    },

    /**
     * E83: proposer-side set prospect for a set swap (knob evaluator.setSwapProspect,
     * shipped default 1 on 2026-11-12). _tradeRespond adds _prospectUtility, so a CPU answering a swap
     * counts the one-away prospect it forfeits; proposing the same swap it used
     * to count nothing, valuing identical terms ~$900 apart (game mwa5c082 t94-95:
     * d3 Yuri rejected Oriental + $400 for Park Place at -510, then offered the
     * same swap for Oriental + $430). 1 = charge it; 0 = the old read (no bonus, arm ssp0).
     */
    _setSwapProspect(state, player, offer) {
        const on = AITuning.knob('evaluator.setSwapProspect');
        const b = on ? this._prospectUtility(state, player, offer) : 0;
        if (b) this._fire('E83', `own set prospect ${Math.round(b)}`, offer);
        return b;
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
        const minDiff = AITuning.knob('evaluator.cedeSwapMinDifficulty');
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
        const strandTurns = AITuning.knob('evaluator.cedeStrandedTurns');
        if (strandTurns > 0) this._trackStranded(state, player, groups, cfg);
        for (const { offer, keep, cede } of cands) {
            const bonus = strandTurns > 0 ? this._strandedDiscount(state, player, offer, cede.group, strandTurns) : 0;
            const cash = this._zopaCash(state, player, offer, cfg, bonus);
            if (cash === null) continue;
            if (cash > 0) offer.give.cash = cash;
            else offer.get.cash = -cash;
            if (!Trading.validate(state, offer).ok) continue;
            if (this._refusedRecently(state, player, keep.ownerId, keep.missing)) continue;
            if (this._snubbed(state, player, `cede:${keep.ownerId}:${keep.missing}:${cede.group}`, offer)) continue;
            if (!this._tradeCompletionFundable(state, player, offer)) continue;
            // Non-enumerable tag for sim instrumentation (inert for game logic)
            Object.defineProperty(offer, '_cede', { value: { keep: keep.group, cede: cede.group, strand: bonus > 0 }, enumerable: false, configurable: true });
            return offer;
        }
        return null;
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
        const minDiff = AITuning.knob('evaluator.multiSwapMinDifficulty');
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
            if (this._snubbed(state, player, `multi:${offer.to}:${x.group}:${y.group}`, offer)) continue;
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
        const level = AITuning.knob('evaluator.oneAwayHumanHolder');
        return level >= 1 && Evaluator.actsHuman(state.players[ownerId]);
    },

    /**
     * Extra utility (sharp CPUs only, d3+) for offers whose gained tiles move
     * a color group from two-away to one-away — the "scheme toward a set"
     * value that plain tradeUtility doesn't see. Used both when proposing
     * such buys and when responding to them.
     */
    // opts.dropSplitForfeit (E83 arm ssp0r, evaluator.setSwapResponderSplitDrop,
    // responder only): skip the forfeit term for a two-tile set whose other
    // tile the counterparty holds (a 1-1 split; the handover penalty prices it).
    _prospectUtility(state, player, offer, opts) {
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
                if (opts && opts.dropSplitForfeit && size === 2 && Rules.getOwner(state, missing) === otherId) continue;
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
            if (this._snubbed(state, player, `pair:${target.ownerId}:${pair[0].tileId}:${pair[1].tileId}`, offer)) continue;
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
            const thin = this._thinPremium(state, player, target.tileId);   // E82
            const bonus = this._prospectUtility(state, player, offer) + thin;
            const cash = this._zopaCash(state, player, offer, cfg, bonus);
            if (cash === null || cash <= 0) continue; // buying always costs something
            offer.give.cash = cash;
            if (thin > 0) this._tagThin(offer);
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
            if (this._snubbed(state, player, `toward:${target.ownerId}:${target.tileId}`, offer)) continue;
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
        const premium = AITuning.knob('evaluator.shutoutEntryPremium');
        if (premium <= 0 || this._skill(player) < 0.5) return null;
        const floor = this._floor(state, player);
        if (player.cash < floor * 2) return null;
        const colourIds = BOARD.filter(t => t.type === 'property').map(t => t.id);
        // E82 (evaluator.thinSeatPremium > 0): a seat with ONE colour deed is
        // as stuck as a deedless one, so the foothold hunt opens to it too.
        const owned = colourIds.filter(id => Rules.getOwner(state, id) === player.id).length;
        const thinOn = AITuning.knob('evaluator.thinSeatPremium') > 0 && this._thinSkillOk(player);
        if (owned > (thinOn ? 1 : 0)) return null;
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
            if (owned === 1) this._fire('E82', 'thin-seat foothold ask', offer);
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
            if (this._snubbed(state, player, `entry:${c.ownerId}:${c.id}`, c.offer)) continue;
            if (owned) this._tagThin(c.offer);
            this._trace(state, `${player.name} — holds ${owned ? 'one colour deed' : 'no colour deed'} and the bank is sold out; ` +
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
        const minDiff = AITuning.knob('evaluator.brokerMinDifficulty');
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
                const swapCash = this._zopaCash(state, player, swap, cfg, this._setSwapProspect(state, player, swap));
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
                if (this._snubbed(state, player, `broker:${C}:${P}`, buyP)) continue;
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
        const schemedMin = AITuning.knob('evaluator.packageSchemedMinDifficulty');
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
                if (this._snubbed(state, player, key, offer)) continue;
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
                if (this._snubbed(state, player, `consol:${collector}:${myTile}:${theirTile}`, offer)) continue;
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
            if (this._snubbed(state, player, `buy:${mine.ownerId}:${mine.missing}`, offer)) continue;
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
                const minNet = state.tiles[tileId].mortgaged ? 30 : Rules.mortgageValue(tileId);
                if (offer.get.cash <= minNet) continue;
                if (!Trading.validate(state, offer).ok) continue;
                if (this._snubbed(state, player, `sell:${other.id}:${tileId}`, offer)) continue;
                return offer;
            }
        }
        return null;
    },

    /* ==================== DEBT ==================== */
});
