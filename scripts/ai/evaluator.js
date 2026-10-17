/**
 * AI: Evaluator
 *
 * Shared valuation core used by every CPU decision: how much is a property
 * worth to a specific player, how much cash should be kept in reserve, and
 * how good is a trade for a side. Personality/difficulty noise is applied
 * by cpu-player.js on top of these base values.
 *
 * Dependencies: constants, board-data, game-state, rules-engine
 * Exports: window.Evaluator
 */

const Evaluator = {

    /**
     * How much of a 3-house build-out on `group` the BANK can physically
     * supply right now: 1 = ample stock, 0 = no houses left, so a monopoly
     * here cannot be developed at any price. The official 32-house / 12-hotel
     * limit is enforced by the rules engine (and even priced into
     * `Rules.liquidationValue`), but every CPU VALUATION ignored it: a
     * completed set was priced on its full build-out prospect with an empty
     * bank, and an opponent one tile from a set was feared just as much when
     * they could not buy a house either. Houses do come back (a hotel upgrade
     * returns 4, a bankruptcy returns the board), so this discounts the
     * DEVELOPMENT premium only — value never drops below the completion
     * baseline, which still earns the doubled undeveloped-monopoly rent.
     * Knob evaluator.bankScarcityAware (1 = on, 0 = the old blind behavior).
     */
    houseSupplyFactor(state, group) {
        if (window.AITuning && !AITuning.get('evaluator.bankScarcityAware', 1)) return 1;
        if (!state.bank || group === 'railroad' || group === 'utility') return 1;
        // Hotels cannot start a build-out: the first house on a virgin
        // monopoly must come from house stock, so price against that alone.
        const need = GROUP_META[group].size * 3;
        return Math.max(0, Math.min(1, state.bank.houses / need));
    },

    /** Could the bank actually sell a building for one of `ids` right now?
     *  Houses for a tile under 4, a hotel for a tile sitting at 4. Used where
     *  the question is binary (is cash handed over really "house money"?)
     *  rather than a matter of degree. */
    _canBankSupply(state, ids) {
        if (window.AITuning && !AITuning.get('evaluator.bankScarcityAware', 1)) return true;
        if (!state.bank) return true;
        return ids.some(id => {
            const h = Rules.houseCount(state, id);
            if (h < 4) return state.bank.houses > 0;
            if (h === 4) return state.bank.hotels > 0;
            return false;
        });
    },

    /**
     * How well an opponent could exploit completing this color group right
     * now: 0 (broke, couldn't build for laps) .. 1 (can fund a full 3-house
     * build-out immediately from cash plus quick mortgage equity).
     * Drives blocker pricing: denying a set to a player who can't develop
     * it anyway is worth much less than strangling the cash-rich leader.
     * Cash is not the only constraint — a rival with $3000 and an empty bank
     * cannot develop either, so bank stock caps exploitability too.
     */
    exploitability(state, oppId, group, cashDelta) {
        const ids = Rules.tilesInGroup(group);
        const buildOut = BOARD[ids[0]].houseCost * ids.length * 3;
        if (!buildOut) return 0;
        const opp = state.players[oppId];
        let equity = 0;
        GameState.propertiesOf(state, oppId).forEach(id => {
            const ts = state.tiles[String(id)];
            if (!ts.mortgaged && Rules.houseCount(state, id) === 0 && !ids.includes(id)) {
                equity += Rules.mortgageValue(id);
            }
        });
        const funded = Math.max(0, Math.min(1, (opp.cash + (cashDelta || 0) + equity * 0.5) / buildOut));
        return Math.min(funded, this.houseSupplyFactor(state, group));
    },

    /**
     * E49: expected rent per opponent-turn a player's colour set earns once
     * built evenly to the level they can fund now — cash (plus the cash
     * delta of a pending trade and half their spare mortgage equity, as in
     * exploitability) — capped by the bank's house/hotel stock. Level 0 is
     * the doubled monopoly rent.
     */
    devRentRate(state, playerId, group, cashDelta) {
        return this._devBuild(state, playerId, group, cashDelta).rate;
    },

    _devBuild(state, playerId, group, cashDelta) {
        const ids = Rules.tilesInGroup(group);
        const p = state.players[playerId];
        let equity = 0;
        GameState.propertiesOf(state, playerId).forEach(id => {
            const ts = state.tiles[String(id)];
            if (!ts.mortgaged && Rules.houseCount(state, id) === 0 && !ids.includes(id)) {
                equity += Rules.mortgageValue(id);
            }
        });
        const budget = Math.max(0, p.cash + (cashDelta || 0) + equity * 0.5);
        let level = Math.min(5, Math.floor(budget / (BOARD[ids[0]].houseCost * ids.length)));
        const bank = state.bank || { houses: 32, hotels: 12 };
        if (level === 5 && bank.hotels < ids.length) level = 4;
        if (level <= 4) level = Math.min(level, Math.floor(bank.houses / ids.length));
        const rate = ids.reduce((sum, id) => {
            const rents = Rules.rentTable(state, id);
            const rent = level === 0 ? rents[0] * 2 : rents[level];
            return sum + rent * LANDING_FREQ[id] / 100;
        }, 0);
        return { level, rate };
    },

    /**
     * E49 development race. When one trade completes a colour set for BOTH
     * sides, tradeUtility's handover penalty is priced on face value and
     * damped to 25%, as if the two sets were equal. They aren't when one side
     * can build theirs up at once and the other can't: a cheap set its new
     * owner can hotel tomorrow out-earns an expensive one stuck at one house
     * (game mv2jir3q t86: d4 Bailey completed $200-house green on $692 while
     * handing the human light blue; T hotel'd it at t89 and Bailey died paying
     * $550 light-blue hotel rents). The charge is the gap in the rent each new
     * set earns at the build level its owner can fund right after the trade,
     * over a short horizon of table rounds. Returns null when it doesn't apply
     * or is zero; otherwise the pieces the CPU decision trace prints.
     * Knob evaluator.mutualDevSpeed = horizon in rounds (0 = off); scope
     * evaluator.mutualDevSpeedScope (1 = human partners, 2 = everyone,
     * 3 = human partners + any partner when I am d5).
     */
    raceCharge(state, offer, forPlayerId, skill) {
        const raceRounds = window.AITuning ? AITuning.get('evaluator.mutualDevSpeed', 4) : 4;
        const raceScope = window.AITuning ? AITuning.get('evaluator.mutualDevSpeedScope', 1) : 1;
        const iAmFrom = offer.from === forPlayerId;
        const gain = iAmFrom ? offer.get : offer.give;
        const lose = iAmFrom ? offer.give : offer.get;
        const otherId = iAmFrom ? offer.to : offer.from;
        const raceOn = !state.players[otherId].isCPU || raceScope === 2 ||
            (raceScope === 3 && state.players[forPlayerId].difficulty >= 5);
        if (!(raceRounds > 0 && raceOn)) return null;
        const afterTiles = this._ownershipAfter(state, offer);
        const newSets = pid => Object.keys(GROUP_META).filter(g => {
            if (g === 'railroad' || g === 'utility') return false;
            const gids = Rules.tilesInGroup(g);
            return gids.every(id => afterTiles[id] === pid) &&
                !gids.every(id => Rules.getOwner(state, id) === pid);
        });
        const mine = newSets(forPlayerId);
        const theirs = newSets(otherId);
        if (!mine.length || !theirs.length) return null;
        const best = mine.map(g => Object.assign({ group: g },
            this._devBuild(state, forPlayerId, g, gain.cash - lose.cash)))
            .reduce((a, b) => (b.rate > a.rate ? b : a));
        const theirBuilds = theirs.map(g => Object.assign({ group: g },
            this._devBuild(state, otherId, g, lose.cash - gain.cash)));
        const theirRate = theirBuilds.reduce((sum, b) => sum + b.rate, 0);
        const opponents = Math.max(1, GameState.activePlayers(state).length - 1);
        const charge = skill * raceRounds * opponents * Math.max(0, theirRate - best.rate);
        if (charge <= 0) return null;
        return { charge, rounds: raceRounds, opponents, mine: best, theirs: theirBuilds,
            gap: theirRate - best.rate, otherId };
    },

    /**
     * Contextual value of a tile for a player (>= 0). Face price scaled by:
     *  - landing frequency (hot tiles worth more)
     *  - monopoly completion (owning n of N in the group)
     *  - blocking an opponent who holds the rest of the group
     *  - railroad/utility set synergy
     */
    propertyValue(state, tileId, playerId, opts) {
        const tile = BOARD[tileId];
        if (!Rules.isOwnable(tileId)) return 0;

        const freq = LANDING_FREQ[tileId] / 2.5; // ~1.0 for an average tile
        // The balanced-rents house rule bakes the landing-frequency premium
        // into the rent tables (equal ROI per property), so a hot tile is no
        // longer worth more per dollar at acquisition. Price by the flattened
        // curve under that rule, the standard hot/cold spread otherwise.
        let value = tile.price *
            (Rules.balancedRents(state) ? (0.85 + 0.15 * freq) : (0.6 + 0.4 * freq));

        const group = tile.group;
        const groupTiles = Rules.tilesInGroup(group);
        const ownedByMe = groupTiles.filter(id => id !== tileId && Rules.getOwner(state, id) === playerId).length;
        const size = GROUP_META[group].size;

        if (tile.type === 'property') {
            // Completing / progressing toward a monopoly
            if (ownedByMe === size - 1) value *= this.completionMul(state, group, size, playerId, opts); // completes the set
            else if (ownedByMe > 0) value *= 1.4;
            // Blocking: someone else holds all the rest of the group. Worth
            // more the better that opponent could exploit the completed set.
            for (const opp of GameState.activePlayers(state)) {
                if (opp.id === playerId) continue;
                const oppOwned = groupTiles.filter(id => id !== tileId && Rules.getOwner(state, id) === opp.id).length;
                if (oppOwned === size - 1) {
                    let blockMul = 1.2 + 1.0 * this.exploitability(state, opp.id, group);
                    // A trade with a THIRD party (not the blocked opponent)
                    // only moves an existing block between holders: the set
                    // stays split either way, so only a share of the premium
                    // (control — they can no longer sell it on) changes hands.
                    // Game mud9g25d t193: d5 Ira took over T's Boardwalk
                    // (vs Reese) and North Carolina (vs Lennon) blocks at
                    // +$605 of full premium and handed T red.
                    // Scope 1 (human partners, receiving side only): the
                    // pattern is a human bundling blocks a CPU over-values.
                    // CPU<->CPU stays full (all-CPU A/B: the shared discount
                    // helped d4 as much as d5, 6p d5 -1.0/-1.4), and GIVING a
                    // block to a human stays full — they can resell it to the
                    // blocked player. Scope 0 = any third party, both sides.
                    if (opts && opts.tradePartner !== undefined && opts.tradePartner !== opp.id) {
                        const scope = window.AITuning ? AITuning.get('evaluator.blockTransferScope', 1) : 1;
                        const partner = state.players[opts.tradePartner];
                        if (!scope || (opts.tradeSide === 'gain' && partner && !partner.isCPU)) {
                            const share = window.AITuning ? AITuning.get('evaluator.blockTransferShare', 0.5) : 0.5;
                            blockMul = 1 + (blockMul - 1) * share;
                        }
                    }
                    value *= blockMul;
                    break;
                }
            }
            // Cheap-to-build groups punch above their price
            value *= 1 + 0.1 * (Rules.rentTable(state, tileId)[3] / tile.price / 3);
        } else if (tile.type === 'railroad') {
            value *= 1 + 0.35 * ownedByMe * this._railOppFactor(state, playerId, opts);
        } else if (tile.type === 'utility') {
            value *= 0.85 + 0.35 * ownedByMe;
        }

        return value;
    },

    /**
     * Set-completion multiplier, discounted by how much of the group the
     * player could actually develop right after acquiring the tile. A
     * monopoly only pays once it has houses: completing an expensive set
     * (dark blue) down to empty pockets yields an undevelopable monopoly that
     * strip-mortgages and dies (games mrtqw1oj, mrtwus9v). Callers that pass
     * opts.cashAfter (their liquid cash after paying for the tile) get the
     * buildability-scaled premium, blended from the one-away value (1.4x) up
     * to the full multiplier; paper and blocker valuations pass no context
     * and keep the full multiplier.
     */
    completionMul(state, group, size, playerId, opts) {
        const mul = window.AITuning ? AITuning.get('evaluator.setCompletionMul', 2.6) : 2.6;
        if (!opts || opts.cashAfter === undefined) return mul;
        const ids = Rules.tilesInGroup(group);
        const buildOut = BOARD[ids[0]].houseCost * size * 3;
        if (!buildOut) return mul;
        const skill = opts.skill !== undefined ? opts.skill : 0.75;
        const floor = this.cashFloor(state, playerId, skill);
        const budget = Math.max(0, opts.cashAfter - floor * 0.5);
        const affordable = Math.min(1, budget / buildOut);
        // Cash is only half the constraint: the bank must have the houses to
        // sell. Whichever binds harder caps the development premium; with an
        // empty bank this falls to the 1.4x one-away baseline, which still
        // credits the doubled rent an undeveloped monopoly earns.
        const limited = Math.min(affordable, this.houseSupplyFactor(state, group));
        return 1.4 + (mul - 1.4) * limited;
    },

    /**
     * A colour monopoly of mine that is FROZEN by my own mortgage. Official
     * rules forbid building on a group with any mortgaged member, so one
     * mortgaged deed idles the whole set: that deed collects no rent AND no
     * house can go up on any of its partners. Returns what lifting the
     * mortgage(s) is worth, in `buildROI` units (freq-weighted rent per dollar)
     * so a caller can rank the repair against buying an ordinary house:
     *   { frozen, unlockCost, restoredROI, unlockedROI }
     * `restoredROI` is the doubled undeveloped rent the frozen deeds resume
     * earning per dollar of lift; `unlockedROI` is the best build ROI the set
     * offers once buildable again. Null when the group is not mine, not fully
     * owned, or has nothing mortgaged.
     */
    frozenSetValue(state, playerId, group) {
        if (group === 'railroad' || group === 'utility') return null;
        if (!Rules.ownsFullGroup(state, playerId, group)) return null;
        const ids = Rules.tilesInGroup(group);
        const frozen = ids.filter(id => {
            const ts = state.tiles[String(id)];
            return ts && ts.mortgaged;
        });
        if (!frozen.length) return null;
        let unlockCost = 0, restoredRent = 0;
        frozen.forEach(id => {
            unlockCost += Rules.unmortgageCost(id);
            // A monopoly's undeveloped rent is doubled; freq-weight it the way
            // buildROI does so the two numbers are comparable.
            restoredRent += Rules.rentTable(state, id)[0] * 2 * (LANDING_FREQ[id] / 2.5);
        });
        if (unlockCost <= 0) return null;
        return {
            frozen: frozen,
            unlockCost: unlockCost,
            restoredROI: restoredRent / unlockCost,
            unlockedROI: Math.max(...ids.map(id => this.buildROI(state, id))),
        };
    },

    /**
     * Opportunity discount on the railroad SET premium. Railroads are a real
     * but capped ($200/tile), UNdevelopable engine. When the acquiring player
     * has a higher-ceiling use for the same cash — an owned color monopoly not
     * yet at hotels, or a color group one tile from completion — pouring cash
     * into the 3rd/4th railroad is the wrong call: games mrtpxhxp (Cameron paid
     * $630 for the 4th rail while one-away green) and mrv958po (Noel paid $640
     * for it while one-away yellow) both chased rails and left a developable set
     * unfinished. Returns a factor in [railOpportunityMul, 1] applied to the
     * per-rail completion premium, so the discount grows with each extra
     * railroad. Only fires in a real decision (opts.cashAfter present); paper
     * and blocker valuations keep full value, and a pure-rail line with no
     * competing color set is left untouched — mirrors completionMul.
     */
    _railOppFactor(state, playerId, opts) {
        if (!opts || opts.cashAfter === undefined) return 1;
        if (!this._colorDevCompeting(state, playerId)) return 1;
        return window.AITuning ? AITuning.get('evaluator.railOpportunityMul', 0.55) : 0.55;
    },

    /** True if the player has a developable color position competing with rail
     *  spending: an owned color monopoly still short of hotels, or a color
     *  group one tile short of completion. */
    _colorDevCompeting(state, playerId) {
        for (const g of Object.keys(GROUP_META)) {
            if (g === 'railroad' || g === 'utility') continue;
            const ids = Rules.tilesInGroup(g);
            const mine = ids.filter(id => Rules.getOwner(state, id) === playerId).length;
            if (mine === ids.length) {
                if (ids.some(id => Rules.houseCount(state, id) < 5)) return true;
            } else if (mine === ids.length - 1) {
                return true;
            }
        }
        return false;
    },

    /** Highest rent an opponent's board position could charge this player. */
    maxThreatRent(state, playerId) {
        let max = 0;
        for (let tileId = 0; tileId < 40; tileId++) {
            const owner = Rules.getOwner(state, tileId);
            if (owner === null || owner === playerId) continue;
            const rent = Rules.calcRent(state, tileId, playerId, 7, {});
            if (rent > max) max = rent;
        }
        return max;
    },

    /** Dice-total counts (out of 36) for sums 2..12, indexed by sum. */
    DICE_WAYS: [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1],

    /**
     * Rent danger within the player's next roll: probability-weighted
     * expected rent plus the single worst tile reachable in 2..12 steps.
     * This is what makes a hotel sitting just ahead demand cash NOW.
     */
    threatAhead(state, playerId) {
        const player = state.players[playerId];
        let expected = 0, worst = 0;
        for (let steps = 2; steps <= 12; steps++) {
            const tileId = (player.position + steps) % 40;
            const owner = Rules.getOwner(state, tileId);
            if (owner === null || owner === playerId) continue;
            const rent = Rules.calcRent(state, tileId, playerId, 7, {});
            expected += rent * this.DICE_WAYS[steps] / 36;
            if (rent > worst) worst = rent;
        }
        return { expected: expected, worst: worst };
    },

    /**
     * Desired cash reserve. Scales with overall board danger plus what the
     * very next roll can actually hit (so CPUs don't build themselves broke
     * right in front of an opponent's hotel row).
     * skill 0..1 - low-skill CPUs underestimate the reserve they need. The
     * skill term is deliberately COMPRESSED (0.5 + 0.3*skill, not 0.3 + 0.7):
     * the wider curve made top-difficulty CPUs hoard ~21% more cash and, in a
     * developed field, that over-reserving cost them games — d5 landed at or
     * below d4 in seat-controlled sim. Compressing it removes that inversion
     * (d5 >= d4) without thinning the cushion enough to raise bankruptcies.
     */
    cashFloor(state, playerId, skill) {
        const threat = this.maxThreatRent(state, playerId);
        const ahead = this.threatAhead(state, playerId);
        const base = Math.max(100,
            Math.min(600, threat * 1.2),
            Math.min(1200, ahead.expected * 2 + ahead.worst * 0.35));
        return base * (0.5 + 0.3 * skill) *
            (window.AITuning ? AITuning.get('evaluator.cashFloorScale', 1.0) : 1.0);
    },

    /**
     * Utility of an offer for one side ("me"). Positive = good for me.
     * Accounts for monopolies completed/handed away post-trade.
     * opts.handoverPenalty scales how much handing the opponent a completed
     * monopoly hurts (default 1.2; the CPU deal-flexibility setting lowers it).
     */
    tradeUtility(state, offer, forPlayerId, opts) {
        const handoverPenalty = opts && opts.handoverPenalty !== undefined ? opts.handoverPenalty : 1.2;
        const skill = opts && opts.skill !== undefined ? opts.skill : 0.75;
        const iAmFrom = offer.from === forPlayerId;
        const gain = iAmFrom ? offer.get : offer.give;
        const lose = iAmFrom ? offer.give : offer.get;
        const otherId = iAmFrom ? offer.to : offer.from;
        const cashAfter = state.players[forPlayerId].cash + gain.cash - lose.cash;
        const floor = this.cashFloor(state, forPlayerId, skill);

        let utility = gain.cash - lose.cash;
        const jailCard = window.AITuning ? AITuning.get('evaluator.jailCardValue', 40) : 40;
        utility += gain.jailCards * jailCard - lose.jailCards * jailCard;

        gain.properties.forEach(id => {
            utility += this.propertyValue(state, id, forPlayerId, { cashAfter: cashAfter, skill: skill, tradePartner: otherId, tradeSide: 'gain' });
            if (state.tiles[String(id)] && state.tiles[String(id)].mortgaged) {
                // No transfer fee under the simplified house rule; the "still
                // mortgaged, costs cash to reactivate" penalty always applies.
                const fee = (state.rules && state.rules.simpleMortgageTransfer) ? 0 : Rules.mortgageTransferFee(id);
                utility -= fee + Rules.mortgageValue(id) * 0.4;
            }
        });
        lose.properties.forEach(id => {
            utility -= this.propertyValue(state, id, forPlayerId, { tradePartner: otherId, tradeSide: 'lose' });
        });

        // Penalty for handing the opponent a completed monopoly (or the
        // 4-railroad engine). Utilities stay out: 10x-dice is never worth
        // pricing as a set.
        const afterTiles = this._ownershipAfter(state, offer);

        // Mutual-advance damping. A swap that ALSO carries me toward a color
        // monopoly (two-away -> one-away, or completes one) is a fair leg of a
        // rotation, not a one-sided giveaway — so the "I advanced/handed my
        // opponent" penalties below are softened. Not erased: a handed monopoly
        // still stings (residual DAMP), and the fee stays value-scaled by
        // exploitability/leaderMul, so gifting the runaway leader a buildable
        // set is still priced out. Restricted to COLOR self-advances so a
        // throwaway railroad can't buy the discount. This is what lets skilled
        // CPUs untangle 3-way splits into monopolies for everyone (leg 1 is
        // advance<->advance, leg 2 is complete-one/advance-other) instead of
        // leaving that work to the human.
        const MUTUAL_DAMP = window.AITuning ? AITuning.get('evaluator.mutualAdvanceDamp', 0.25) : 0.25;
        // "One-away" must mean holding real set-pieces: in a two-tile group
        // (brown, dark blue) 0 -> 1 is a lone foothold, not an advance — it
        // let a single Boardwalk forgive 75% of handing the human red (game
        // mud9g25d t193). Floor of 2 tiles; three-tile groups are unchanged.
        const minTiles = window.AITuning ? AITuning.get('evaluator.mutualDampMinTiles', 2) : 2;
        let iAdvanceColor = false;
        for (const g of Object.keys(GROUP_META)) {
            if (g === 'railroad' || g === 'utility') continue;
            const gids = Rules.tilesInGroup(g);
            const now = gids.filter(id => Rules.getOwner(state, id) === forPlayerId).length;
            const aft = gids.filter(id => afterTiles[id] === forPlayerId).length;
            if (aft > now && aft >= Math.max(minTiles, gids.length - 1)) { iAdvanceColor = true; break; }
        }
        // Relative-advantage discipline — the top-difficulty lever. A
        // self-advancing swap normally forgives most of the "I also helped my
        // opponent" penalty (MUTUAL_DAMP) so CPUs will untangle colour splits
        // into monopolies. But a "fair" mutual swap that also completes/advances
        // a set for the table LEADER dilutes my own edge: in a mixed field it
        // develops a strong rival as much as me. Sharper CPUs forgive LESS as
        // the counterparty's lead grows — at high skill vs a runaway leader the
        // damping lifts back toward the full penalty, so d5/d4 decline feeding
        // the leader a set they'd otherwise wave through, while still trading
        // freely with an even or trailing field. "Smarter, not greedier": same
        // asking price, better counterparty selection. This is what converts
        // d5's surplus set-completions (it already trades and develops MORE than
        // d4 yet wins no more — a ~26% three-way tie at the top) into a real
        // d3<d4<d5 gradient the shared evaluator otherwise caps flat.
        // The counterparty's ability to build on a set I hand them is judged
        // on their cash AFTER this trade: the cash I pay them is build money
        // (game muwp487y t106: T at $62 read as 0.73-funded for light blue,
        // 1.0 once Kai's $760 is counted). E46: 1 = toward a human only, and
        // only cash flowing TO them (cash a human pays me never makes a set I
        // hand them look cheaper — mse3hmqt t75 would flip to an accept);
        // CPU-only play unchanged. 2 = both directions, any partner. 0 = off.
        const postCash = window.AITuning ? AITuning.get('evaluator.exploitPostTradeCash', 1) : 1;
        const otherCashDelta = postCash >= 2 ? lose.cash - gain.cash
            : (postCash === 1 && !state.players[otherId].isCPU) ? Math.max(0, lose.cash - gain.cash) : 0;
        const leadLift = skill * this._leadFactor(state, otherId);
        const mutualDamp = iAdvanceColor ? MUTUAL_DAMP + (1 - MUTUAL_DAMP) * leadLift : 1;
        // Development parity (E48): when the swap completes a set for BOTH of
        // us, the damping above treats the two sets as equal. They aren't when
        // one side can build at once and the other can't (game muxf4uxb t104:
        // d4 Reese gave d5 Tate orange + $390 for Boardwalk; Tate, paid to do
        // it, hotel'd $100-house orange while Reese, left with $734, funded two
        // dark-blue houses and was bankrupted by orange). Lift the damping back
        // toward the full penalty by how much better-funded the partner is to
        // build their new set than I am mine, both on post-trade cash. Skill-
        // scaled like the leader lift. 0 = off (default; A/B'd doses 1/2 win-neutral, closed).
        const parity = window.AITuning ? AITuning.get('evaluator.mutualDevelopParity', 0) : 0;
        let myDev = -1;
        if (parity > 0 && iAdvanceColor) {
            for (const g of Object.keys(GROUP_META)) {
                if (g === 'railroad' || g === 'utility') continue;
                const gids = Rules.tilesInGroup(g);
                if (gids.every(id => afterTiles[id] === forPlayerId) &&
                    !gids.every(id => Rules.getOwner(state, id) === forPlayerId)) {
                    myDev = Math.max(myDev, this.exploitability(state, forPlayerId, g, gain.cash - lose.cash));
                }
            }
        }
        const groupDamp = group => {
            if (myDev < 0 || mutualDamp >= 1) return mutualDamp;
            const theirDev = this.exploitability(state, otherId, group, lose.cash - gain.cash);
            const lag = Math.max(0, theirDev - myDev);
            return MUTUAL_DAMP + (1 - MUTUAL_DAMP) * Math.min(1, leadLift + parity * skill * lag);
        };

        for (const group of Object.keys(GROUP_META)) {
            if (group === 'utility') continue;
            const isRail = group === 'railroad';
            const ids = Rules.tilesInGroup(group);
            const oppOwnsAllAfter = ids.every(id => afterTiles[id] === otherId);
            const oppOwnsAllNow = ids.every(id => Rules.getOwner(state, id) === otherId);
            if (oppOwnsAllAfter && !oppOwnsAllNow) {
                const groupValue = ids.reduce((sum, id) => sum + BOARD[id].price, 0);
                // Handing a set to someone who can build on it immediately
                // hurts full price; to someone broke, roughly half. Rails
                // earn without houses but cap at $200 rent: flat factor.
                const factor = isRail ? 0.45
                    : 0.5 + 0.7 * this.exploitability(state, otherId, group, otherCashDelta);
                // Completing a set for the table leader is worse than the
                // same deal with a trailing player: the cash received cannot
                // out-earn their engine. Sharper CPUs weigh this more.
                const leaderMul = 1 + 0.8 * skill * this._leadFactor(state, otherId);
                utility -= groupValue * handoverPenalty * factor * leaderMul *
                    (isRail ? mutualDamp : groupDamp(group));
            }
            // Advancing an opponent two-away -> one-away hands them a completion
            // prospect (not a finished set): penalize well below a full handover
            // but enough that an idle set-piece isn't sold to a rival for pocket
            // change - the sell side of the ping-pong (game mrt8w40f).
            const oppOwnedAfter = ids.filter(id => afterTiles[id] === otherId).length;
            const oppOwnedNow = ids.filter(id => Rules.getOwner(state, id) === otherId).length;
            if (oppOwnedAfter === ids.length - 1 && oppOwnedNow < ids.length - 1 && !oppOwnsAllNow) {
                const groupValue = ids.reduce((sum, id) => sum + BOARD[id].price, 0);
                const factor = isRail ? 0.45 : 0.5 + 0.7 * this.exploitability(state, otherId, group, otherCashDelta);
                const leaderMul = 1 + 0.8 * skill * this._leadFactor(state, otherId);
                utility -= groupValue * handoverPenalty * factor * 0.3 * skill * leaderMul * mutualDamp;
            }
            const iOwnAllAfter = ids.every(id => afterTiles[id] === forPlayerId);
            const iOwnAllNow = ids.every(id => Rules.getOwner(state, id) === forPlayerId);
            if (iOwnAllAfter && !iOwnAllNow) {
                const groupValue = ids.reduce((sum, id) => sum + BOARD[id].price, 0);
                if (isRail) {
                    // No build-out needed - the doubled rents start immediately,
                    // but the engine caps at $200 and can't scale; discount the
                    // completion reward when a developable color set competes
                    // for the same cash (finding: undevelopable-rail-engine).
                    utility += groupValue * 0.35 *
                        this._railOppFactor(state, forPlayerId, { cashAfter: cashAfter, skill: skill });
                } else {
                    // A monopoly only pays once developed: scale the completion
                    // premium by how much of a 3-house build-out I could fund
                    // right after the trade without eating my reserve.
                    const buildOut = BOARD[ids[0]].houseCost * ids.length * 3;
                    const budget = Math.max(0, cashAfter - floor * 0.5);
                    const affordable = Math.min(1, budget / buildOut);
                    // ...and by whether the bank can supply those houses at all
                    // (paying a premium for a monopoly you cannot build on is
                    // exactly the trade that strip-mortgages a d5 late game).
                    const limited = Math.min(affordable, this.houseSupplyFactor(state, group));
                    utility += groupValue * (0.35 + 0.55 * limited);
                }
            }
        }

        // Development race (E49): see raceCharge.
        const race = this.raceCharge(state, offer, forPlayerId, skill);
        if (race) utility -= race.charge;

        // Liquidity: a trade that leaves me below my working reserve is worth
        // far less than its paper value — one rent hit forces a fire sale.
        // liquidityPenaltyMode (E47): charge only the shortfall this trade
        // adds — a CPU already below its floor shouldn't pay it on every offer
        // (muoxzvh6 t157: d3 Noel countered a FREE Baltic asking $30). 2
        // (default) = trades with a human only; 1 = every counterparty (A/B'd:
        // more CPU-CPU trading, d5 -1.2 at 6p — rejected); 0 = absolute.
        const liqMode = window.AITuning ? AITuning.get('evaluator.liquidityPenaltyMode', 2) : 2;
        if (liqMode === 1 || (liqMode >= 2 && !state.players[otherId].isCPU)) {
            const shortNow = Math.max(0, floor - state.players[forPlayerId].cash);
            const added = Math.max(0, floor - cashAfter) - shortNow;
            if (added > 0) utility -= added * 1.2;
        } else if (cashAfter < floor) utility -= (floor - cashAfter) * 1.2;

        // Enemy fuel: cash handed to an opponent who has (or gains) a
        // buildable monopoly is ammunition they will spend on houses.
        const netCashOut = lose.cash - gain.cash;
        if (netCashOut > 0) {
            const otherCanBuild = Object.keys(GROUP_META).some(g => {
                if (g === 'railroad' || g === 'utility') return false;
                const ids = Rules.tilesInGroup(g);
                return ids.every(id => afterTiles[id] === otherId) &&
                    ids.some(id => Rules.houseCount(state, id) < 5) &&
                    // ...and the bank can still sell them the building. With
                    // stock exhausted, cash handed over is not house money.
                    this._canBankSupply(state, ids);
            });
            if (otherCanBuild) utility -= netCashOut * 0.5;
        }
        return utility;
    },

    /** How far ahead of the rest of the field a player is: 0 while anyone
     *  matches their net worth, ramping to 1 as their lead reaches 50%. */
    _leadFactor(state, playerId) {
        const mine = Rules.netWorth(state, playerId);
        let best = 0;
        GameState.activePlayers(state).forEach(p => {
            if (p.id === playerId) return;
            const nw = Rules.netWorth(state, p.id);
            if (nw > best) best = nw;
        });
        if (best <= 0) return 1;
        return Math.max(0, Math.min(1, (mine / best - 1) / 0.5));
    },

    _ownershipAfter(state, offer) {
        const after = {};
        for (let id = 0; id < 40; id++) after[id] = Rules.getOwner(state, id);
        offer.give.properties.forEach(id => { after[id] = offer.to; });
        offer.get.properties.forEach(id => { after[id] = offer.from; });
        return after;
    },

    /** Marginal rent gain per dollar for building one house on a tile. */
    buildROI(state, tileId) {
        const tile = BOARD[tileId];
        const houses = Rules.houseCount(state, tileId);
        if (houses >= 5) return 0;
        const rents = Rules.rentTable(state, tileId);
        const current = houses === 0 ? rents[0] * 2 : rents[houses];
        const next = rents[houses + 1];
        const freq = LANDING_FREQ[tileId] / 2.5;
        return ((next - current) * freq) / tile.houseCost;
    }
};

if (typeof window !== 'undefined') {
    window.Evaluator = Evaluator;
}
