/**
 * Core: Turn Engine
 *
 * Phase state machine + single action dispatch point. Every mutation flows
 * through dispatch(): validate -> apply -> log -> autosave -> notify -> pump.
 * pump() drives CPU decisions (via window.CPUPlayer) with a thinking delay;
 * humans act through UI events that call dispatch().
 *
 * The engine is a class so the DEV harness can run throwaway simulations
 * (persist: false) without touching the real save.
 *
 * Dependencies: constants, rng, board-data, game-state, rules-engine,
 *               features/* (cards, property-actions, auction, bankruptcy, trading)
 * Exports: window.MonopolyEngine (class), window.engine (singleton, set by main.js)
 */

class MonopolyEngine {

    constructor(state, options = {}) {
        this.state = state;
        this.persist = options.persist !== false;
        this.cpuDelay = options.cpuDelay !== undefined ? options.cpuDelay : 700;
        this.tradeLimit = options.tradeLimit !== undefined ? options.tradeLimit : 2;
        // Expose the per-turn trade cap on the state so the CPU (which only ever
        // sees `state`, not the engine driving it) can budget its proposals
        // against the SAME limit the engine enforces — never emitting a proposal
        // that would be rejected, which stalls the turn (dispatch of a rejected
        // action doesn't re-pump). Kept in sync by settings.js on runtime change.
        state.tradeLimit = this.tradeLimit;
        this.autoPump = options.autoPump !== false;
        this._cpuTimer = null;
    }

    /* ==================== DISPATCH ==================== */

    dispatch(action) {
        const s = this.state;
        if (s.phase === GamePhase.GAME_OVER) return { ok: false, reason: 'Game is over' };

        const result = this._apply(s, action);
        if (!result.ok) {
            EventBus.emit('actionRejected', { action, result });
            return result;
        }

        this._checkWinner(s);
        if (this.persist) GameState.save(s);
        EventBus.emit('stateChanged', s);
        if (this.autoPump) this.pump();
        return result;
    }

    _apply(s, action) {
        const player = GameState.currentPlayer(s);

        switch (action.type) {

            /* ----- rolling & movement ----- */

            case 'ROLL_DICE': {
                if (s.phase !== GamePhase.AWAIT_PREROLL) return { ok: false, reason: 'Cannot roll now' };
                const dice = RNG.rollDice(s);
                s.lastDice = dice;
                const doubles = dice[0] === dice[1];
                GameState.addLog(s, `${player.name} rolls ${dice[0]} + ${dice[1]}.`);
                EventBus.emit('diceRolled', { player: player.id, dice });

                if (doubles) {
                    s.doublesCount += 1;
                    if (s.doublesCount >= 3) {
                        GameState.addLog(s, `${player.name} rolled doubles three times - go to Jail!`);
                        this._sendToJail(s, player);
                        s.phase = GamePhase.AWAIT_ENDTURN;
                        return { ok: true };
                    }
                }
                s.rollMeta = { doubles: doubles, fromJail: false };
                this._moveBy(s, player, dice[0] + dice[1]);
                this._land(s, player, dice[0] + dice[1], {});
                return { ok: true };
            }

            /* ----- jail ----- */

            case 'JAIL_PAY': {
                if (s.phase !== GamePhase.AWAIT_JAIL_CHOICE) return { ok: false, reason: 'Not in jail choice' };
                if (player.cash < GAME_CONST.JAIL_FINE) return { ok: false, reason: 'Not enough cash' };
                GameState.pay(s, player.id, null, GAME_CONST.JAIL_FINE, 'jail fine');
                this._releaseFromJail(s, player, `pays $${GAME_CONST.JAIL_FINE}`);
                s.phase = GamePhase.AWAIT_PREROLL;
                return { ok: true };
            }

            case 'JAIL_CARD': {
                if (s.phase !== GamePhase.AWAIT_JAIL_CHOICE) return { ok: false, reason: 'Not in jail choice' };
                if (player.getOutCards < 1) return { ok: false, reason: 'No jail card' };
                GameState.returnJailCard(s, player.id);
                this._releaseFromJail(s, player, 'uses a Get Out of Jail Free card');
                s.phase = GamePhase.AWAIT_PREROLL;
                return { ok: true };
            }

            case 'JAIL_ROLL': {
                if (s.phase !== GamePhase.AWAIT_JAIL_CHOICE) return { ok: false, reason: 'Not in jail choice' };
                const dice = RNG.rollDice(s);
                s.lastDice = dice;
                const total = dice[0] + dice[1];
                GameState.addLog(s, `${player.name} rolls ${dice[0]} + ${dice[1]} in Jail.`);
                EventBus.emit('diceRolled', { player: player.id, dice });

                if (dice[0] === dice[1]) {
                    this._releaseFromJail(s, player, 'rolls doubles');
                    s.rollMeta = { doubles: false, fromJail: true }; // no extra roll after jail doubles
                    this._moveBy(s, player, total);
                    this._land(s, player, total, {});
                    return { ok: true };
                }

                player.jailTurns += 1;
                if (player.jailTurns >= GAME_CONST.MAX_JAIL_TURNS) {
                    s.rollMeta = { doubles: false, fromJail: true };
                    if (player.getOutCards > 0) {
                        GameState.returnJailCard(s, player.id);
                        this._releaseFromJail(s, player, 'uses a Get Out of Jail Free card after three failed rolls');
                    } else {
                        GameState.addLog(s, `${player.name} must pay the $${GAME_CONST.JAIL_FINE} fine.`);
                        this._releaseFromJail(s, player, 'pays after three failed rolls');
                        const paid = this._charge(s, player.id, GAME_CONST.JAIL_FINE, null, { thenMove: total, reason: 'jail fine' });
                        if (!paid) return { ok: true };
                    }
                    this._moveBy(s, player, total);
                    this._land(s, player, total, {});
                    return { ok: true };
                }
                GameState.addLog(s, `${player.name} stays in Jail (turn ${player.jailTurns}).`);
                s.phase = GamePhase.AWAIT_ENDTURN;
                return { ok: true };
            }

            /* ----- buy or auction ----- */

            case 'BUY_PROPERTY': {
                if (s.phase !== GamePhase.AWAIT_DECISION || !s.pendingAction || s.pendingAction.type !== 'BUY_OR_AUCTION') {
                    return { ok: false, reason: 'No purchase pending' };
                }
                const tileId = s.pendingAction.tileId;
                const price = BOARD[tileId].price;
                if (player.cash < price) return { ok: false, reason: 'Not enough cash' };
                PropertyActions.buy(s, player.id, tileId, price);
                EventBus.emit('propertyPurchased', { playerId: player.id, tileId, price });
                s.pendingAction = null;
                this._afterLanding(s);
                return { ok: true };
            }

            case 'DECLINE_BUY': {
                if (s.phase !== GamePhase.AWAIT_DECISION || !s.pendingAction || s.pendingAction.type !== 'BUY_OR_AUCTION') {
                    return { ok: false, reason: 'No purchase pending' };
                }
                const auctTileId = s.pendingAction.tileId;
                Auction.start(s, auctTileId);
                EventBus.emit('auctionStarted', { tileId: auctTileId });
                s.pendingAction = null;
                s.phase = GamePhase.AUCTION_IN_PROGRESS;
                return { ok: true };
            }

            case 'AUCTION_BID': {
                if (s.phase !== GamePhase.AUCTION_IN_PROGRESS) return { ok: false, reason: 'No auction running' };
                const tileId = s.auction ? s.auction.tileId : null; // Auction.bid clears s.auction on finish
                const res = Auction.bid(s, action.playerId, action.amount);
                if (res.ok && res.done) {
                    this._afterLanding(s);
                    EventBus.emit('auctionEnded', { winnerId: res.winnerId, tileId, price: res.price });
                }
                return res;
            }

            case 'AUCTION_PASS': {
                if (s.phase !== GamePhase.AUCTION_IN_PROGRESS) return { ok: false, reason: 'No auction running' };
                const tileId = s.auction ? s.auction.tileId : null; // Auction.pass clears s.auction on finish
                const res = Auction.pass(s, action.playerId);
                if (res.ok && res.done) {
                    this._afterLanding(s);
                    EventBus.emit('auctionEnded', { winnerId: res.winnerId, tileId, price: res.price });
                }
                return res;
            }

            /* ----- property management ----- */

            case 'BUILD_HOUSE':
            case 'SELL_HOUSE':
            case 'MORTGAGE':
            case 'UNMORTGAGE': {
                if (!this._canManageNow(s, action)) return { ok: false, reason: 'Cannot manage properties now' };
                const fn = { BUILD_HOUSE: 'buildHouse', SELL_HOUSE: 'sellHouse', MORTGAGE: 'mortgage', UNMORTGAGE: 'unmortgage' }[action.type];
                const actorId = (action.playerId !== undefined) ? action.playerId : s.currentPlayer;
                const res = PropertyActions[fn](s, actorId, action.tileId);
                // A human raising cash by hand is auto-settled the instant the
                // debt is covered (no separate "Pay" click). A CPU instead lets
                // its own PAY_DEBT fire on the next pump: settling here would
                // append the "pays $X" line in this same dispatch, so the
                // mortgage/sale that finally covered the debt would be overwritten
                // in the board spotlight before it ever rendered (its own cpuDelay
                // frame is what makes the last liquidation visible).
                if (res.ok && s.phase === GamePhase.DEBT_SETTLEMENT && !s.players[actorId].isCPU) {
                    this._maybeAutoPayDebt(s);
                }
                return res;
            }

            /* ----- debt ----- */

            case 'PAY_DEBT': {
                if (s.phase !== GamePhase.DEBT_SETTLEMENT || !s.debt) return { ok: false, reason: 'No debt pending' };
                if (s.players[s.debt.debtorId].cash < s.debt.amount) return { ok: false, reason: 'Not enough cash yet' };
                this._settleDebt(s);
                return { ok: true };
            }

            case 'AUTO_RAISE_CASH': {
                if (s.phase !== GamePhase.DEBT_SETTLEMENT || !s.debt) return { ok: false, reason: 'No debt pending' };
                if (action.playerId !== undefined && action.playerId !== s.debt.debtorId) {
                    return { ok: false, reason: 'Not the player in debt' };
                }
                this._raiseCashToTarget(s, s.debt.debtorId, s.debt.amount);
                this._maybeAutoPayDebt(s);
                return { ok: true };
            }

            case 'DECLARE_BANKRUPTCY': {
                if (s.phase !== GamePhase.DEBT_SETTLEMENT || !s.debt) return { ok: false, reason: 'No debt pending' };
                if (Rules.liquidationValue(s, s.debt.debtorId) >= s.debt.amount) {
                    return { ok: false, reason: 'You can still raise the money' };
                }
                const creditor = (typeof s.debt.creditorId === 'number') ? s.debt.creditorId : null;
                const { interestDue } = Bankruptcy.declare(s, s.debt.debtorId, creditor);
                s.debt = null;
                if (creditor !== null &&
                    !this._chargeTransferInterest(s, creditor, interestDue, { thenEndTurn: true })) {
                    return { ok: true }; // creditor raises the interest first; turn ends on settle
                }
                this._endTurn(s);
                return { ok: true };
            }

            /* ----- trading ----- */

            case 'PROPOSE_TRADE': {
                const tradePhases = [GamePhase.AWAIT_PREROLL, GamePhase.AWAIT_ENDTURN,
                    GamePhase.AWAIT_JAIL_CHOICE, GamePhase.AWAIT_DECISION,
                    GamePhase.AUCTION_IN_PROGRESS, GamePhase.DEBT_SETTLEMENT];
                if (!tradePhases.includes(s.phase)) {
                    return { ok: false, reason: 'Cannot trade now' };
                }
                if (s.phase === GamePhase.AUCTION_IN_PROGRESS && action.offer.from !== Auction.currentBidder(s)) {
                    return { ok: false, reason: 'Only the current bidder can trade during an auction' };
                }
                // Only the player who owes money may trade their way out of a debt
                if (s.phase === GamePhase.DEBT_SETTLEMENT && (!s.debt || action.offer.from !== s.debt.debtorId)) {
                    return { ok: false, reason: 'Only the player in debt can trade now' };
                }
                const offer = action.offer;
                const used = (s.tradeAttempts && s.tradeAttempts[offer.from]) || 0;
                if (used >= this.tradeLimit) {
                    return { ok: false, reason: `Trade limit reached (${this.tradeLimit} per turn)` };
                }
                const check = Trading.validate(s, offer);
                if (!check.ok) return check;
                s.tradeAttempts = s.tradeAttempts || {};
                s.tradeAttempts[offer.from] = used + 1;
                s.trade = { ...offer, awaiting: offer.to, returnPhase: s.phase, counters: 0,
                    // What the proposer originally asked for, carried through
                    // counters so a rejected counter can still feed the ledger.
                    asked: { by: offer.from, of: offer.to, tiles: offer.get.properties.slice() } };
                s.phase = GamePhase.TRADE_PENDING;
                GameState.addLog(s, `${s.players[offer.from].name} proposes a trade to ${s.players[offer.to].name}.`);
                GameState.addLog(s, Trading.describeOffer(s, offer), { detail: true, cat: 'trade' });
                return { ok: true };
            }

            case 'ACCEPT_TRADE': {
                if (s.phase !== GamePhase.TRADE_PENDING || !s.trade) return { ok: false, reason: 'No trade pending' };
                if (action.playerId !== s.trade.awaiting) return { ok: false, reason: 'Not your trade to answer' };
                // The answerer receives one side; record which of its mortgaged
                // deeds they chose to lift immediately (vs. keep mortgaged).
                if (action.liftNow && action.liftNow.length) {
                    const recvSide = s.trade.awaiting === s.trade.to ? s.trade.give : s.trade.get;
                    recvSide.liftNow = action.liftNow.filter(id =>
                        recvSide.properties.includes(id) && s.tiles[String(id)] && s.tiles[String(id)].mortgaged);
                }
                const check = Trading.validate(s, s.trade);
                if (!check.ok) { // state changed since proposal
                    GameState.addLog(s, `Trade is no longer valid: ${check.reason}`);
                } else {
                    Trading.apply(s, s.trade);
                }
                s.phase = s.trade.returnPhase;
                s.trade = null;
                // A trade made to cover a debt may have raised enough to settle it
                if (s.phase === GamePhase.DEBT_SETTLEMENT) this._maybeAutoPayDebt(s);
                return { ok: true };
            }

            case 'REJECT_TRADE': {
                if (s.phase !== GamePhase.TRADE_PENDING || !s.trade) return { ok: false, reason: 'No trade pending' };
                if (action.playerId !== s.trade.awaiting) return { ok: false, reason: 'Not your trade to answer' };
                GameState.addLog(s, `${s.players[action.playerId].name} rejects the trade.`);
                EventBus.emit('tradeRejected', { by: action.playerId, offer: s.trade });
                // Refusal ledger: the proposer (s.trade.from) asked the answerer
                // (s.trade.to, the rejecter) for the tiles on its GET side and was
                // told no. Record it per (owner:tile) — shape-independent — so the
                // proposer's AI (CPUPlayer._refusedRecently) can stop re-asking
                // through rotated offer shapes instead of nagging the same holder
                // for the same tile all game. An accepted trade never reaches here,
                // and a counter routes through COUNTER_TRADE (engagement, not a no).
                const proposer = s.players[s.trade.from];
                if (proposer && s.trade.get && s.trade.get.properties) {
                    proposer.tradeRefusals = proposer.tradeRefusals || {};
                    for (const tid of s.trade.get.properties) {
                        const key = `${s.trade.to}:${tid}`;
                        const rec = proposer.tradeRefusals[key] || { count: 0, turn: 0 };
                        rec.count += 1;
                        rec.turn = s.turnNumber;
                        proposer.tradeRefusals[key] = rec;
                    }
                }
                // The other half: the owner COUNTERED my ask and I (the original
                // proposer) turned the counter down. That's a price standoff on
                // the tiles I asked for, as final as a flat no — without this, an
                // asker whose every offer draws a counter never fills its ledger
                // and re-asks the same tile all game (mv2jir3q: Lane asked Gray
                // for States six times, t117-t252). Knob evaluator.tradeNagFix.
                const asked = s.trade.asked;
                const nagFix = window.AITuning ? AITuning.get('evaluator.tradeNagFix', 1) : 1;
                if (nagFix > 0 && asked && s.trade.counters > 0 && action.playerId === asked.by) {
                    const asker = s.players[asked.by];
                    asker.tradeRefusals = asker.tradeRefusals || {};
                    for (const tid of asked.tiles) {
                        if (Rules.getOwner(s, tid) !== asked.of) continue;
                        const key = `${asked.of}:${tid}`;
                        const rec = asker.tradeRefusals[key] || { count: 0, turn: 0 };
                        rec.count += 1;
                        rec.turn = s.turnNumber;
                        asker.tradeRefusals[key] = rec;
                    }
                }
                s.phase = s.trade.returnPhase;
                s.trade = null;
                return { ok: true };
            }

            case 'COUNTER_TRADE': {
                if (s.phase !== GamePhase.TRADE_PENDING || !s.trade) return { ok: false, reason: 'No trade pending' };
                if (action.playerId !== s.trade.awaiting) return { ok: false, reason: 'Not your trade to answer' };
                if (s.trade.counters >= 3) return { ok: false, reason: 'Too many counter-offers' };
                // A counter must stay between the same two players — the answerer
                // sends it back to the other trader, never to a third player.
                const parties = new Set([s.trade.from, s.trade.to]);
                if (action.offer.from !== action.playerId ||
                    action.offer.to === action.offer.from ||
                    !parties.has(action.offer.to)) {
                    return { ok: false, reason: 'Counter must go back to the other trader' };
                }
                const check = Trading.validate(s, action.offer);
                if (!check.ok) return check;
                s.trade = {
                    ...action.offer,
                    awaiting: action.offer.to,
                    returnPhase: s.trade.returnPhase,
                    counters: s.trade.counters + 1,
                    asked: s.trade.asked
                };
                GameState.addLog(s, `${s.players[action.offer.from].name} makes a counter-offer.`);
                GameState.addLog(s, Trading.describeOffer(s, action.offer), { detail: true, cat: 'trade' });
                return { ok: true };
            }

            /* ----- turn end ----- */

            case 'END_TURN': {
                if (s.phase !== GamePhase.AWAIT_ENDTURN) return { ok: false, reason: 'Cannot end turn now' };
                if (s.rollMeta && s.rollMeta.doubles && !GameState.currentPlayer(s).inJail && !GameState.currentPlayer(s).bankrupt) {
                    // Doubles grant another roll for the same player
                    s.rollMeta = null;
                    s.phase = GamePhase.AWAIT_PREROLL;
                    GameState.addLog(s, `${player.name} rolled doubles and goes again.`);
                    return { ok: true };
                }
                this._endTurn(s);
                return { ok: true };
            }

            default:
                return { ok: false, reason: `Unknown action: ${action.type}` };
        }
    }

    /* ==================== INTERNALS ==================== */

    _canManageNow(s, action) {
        // AWAIT_DECISION included so a landing player can mortgage/sell to
        // afford the purchase before choosing buy vs auction
        const manageable = [GamePhase.AWAIT_PREROLL, GamePhase.AWAIT_ENDTURN,
            GamePhase.AWAIT_JAIL_CHOICE, GamePhase.AWAIT_DECISION];
        if (manageable.includes(s.phase)) return true;
        // During debt settlement only cash-raising actions are allowed
        if (s.phase === GamePhase.DEBT_SETTLEMENT && (action.type === 'SELL_HOUSE' || action.type === 'MORTGAGE')) return true;
        // During an auction the current bidder may raise cash
        if (s.phase === GamePhase.AUCTION_IN_PROGRESS &&
            (action.type === 'SELL_HOUSE' || action.type === 'MORTGAGE') &&
            action.playerId === Auction.currentBidder(s)) return true;
        return false;
    }

    _moveBy(s, player, steps) {
        const target = (player.position + steps) % 40;
        if (target < player.position) {
            GameState.pay(s, null, player.id, GAME_CONST.GO_SALARY, 'salary');
            GameState.addLog(s, `${player.name} passes GO and collects $${GAME_CONST.GO_SALARY}.`);
            GameState.unlockBuying(s);
        }
        player.position = target;
        GameState.addLog(s, `${player.name} lands on ${BOARD[target].name}.`);
    }

    /** Resolve the current tile. May chain via cards. */
    _land(s, player, diceTotal, opts) {
        if (opts.tenTimesDice) {
            const ts = s.tiles[String(player.position)];
            const owedRent = ts && ts.owner !== null && ts.owner !== player.id && !ts.mortgaged;
            if (owedRent) {
                const bonus = RNG.rollDice(s);
                diceTotal = bonus[0] + bonus[1];
                GameState.addLog(s, `${player.name} rolls ${bonus[0]} + ${bonus[1]} for the utility fee.`);
            }
        }
        const outcome = Rules.resolveLanding(s, player.id, player.position, diceTotal, opts);

        switch (outcome.kind) {
            case 'buyOrAuction':
                s.pendingAction = { type: 'BUY_OR_AUCTION', tileId: outcome.tileId };
                s.phase = GamePhase.AWAIT_DECISION;
                return;

            case 'buyLocked':
                GameState.addLog(s, `${BOARD[outcome.tileId].name} cannot be bought yet — no one has completed a lap.`);
                this._afterLanding(s);
                return;

            case 'rent': {
                GameState.addLog(s, `${player.name} owes $${outcome.amount} rent to ${s.players[outcome.ownerId].name}.`);
                const paid = this._charge(s, player.id, outcome.amount, outcome.ownerId, { reason: 'rent' });
                if (paid) this._afterLanding(s);
                return;
            }

            case 'tax': {
                GameState.addLog(s, `${player.name} owes $${outcome.amount} in tax.`);
                const paid = this._charge(s, player.id, outcome.amount, null, { reason: 'tax' });
                if (paid) this._afterLanding(s);
                return;
            }

            case 'drawCard': {
                const card = GameState.drawCard(s, outcome.deck);
                GameState.addLog(s, `${player.name} draws: "${card.text}"`);
                EventBus.emit('cardDrawn', { player: player.id, deck: outcome.deck, card });
                this._applyCard(s, player, card);
                return;
            }

            case 'goToJail':
                this._sendToJail(s, player);
                s.phase = GamePhase.AWAIT_ENDTURN;
                return;

            default:
                this._collectFreeParking(s, player);
                this._afterLanding(s);
        }
    }

    /** Free Parking house rule: landing here wins the accumulated pot. */
    _collectFreeParking(s, player) {
        if (BOARD[player.position].type !== 'parking') return;
        if (!s.rules.freeParking || (s.freeParkingPot || 0) <= 0) return;
        const pot = s.freeParkingPot;
        s.freeParkingPot = 0;
        GameState.pay(s, null, player.id, pot, 'free parking');
        GameState.addLog(s, `${player.name} collects $${pot} from Free Parking!`);
        EventBus.emit('freeParkingCollected', { playerId: player.id, amount: pot });
    }

    _applyCard(s, player, card) {
        const outcome = Cards.apply(s, player.id, card);

        if (outcome.moved) {
            this._land(s, player, s.lastDice ? s.lastDice[0] + s.lastDice[1] : 7, outcome.landingOpts);
            return;
        }
        if (outcome.jailed) {
            this._sendToJail(s, player);
            s.phase = GamePhase.AWAIT_ENDTURN;
            return;
        }
        if (outcome.charge) {
            const paid = this._charge(s, player.id, outcome.charge.amount, outcome.charge.creditorId, { reason: 'card' });
            if (paid) this._afterLanding(s);
            return;
        }
        if (outcome.collectEach) {
            const others = GameState.activePlayers(s).filter(p => p.id !== player.id);
            others.forEach(other => {
                const amount = outcome.collectEach.amount;
                if (other.cash < amount) this._autoRaiseCash(s, other.id, amount);
                if (other.cash >= amount) {
                    GameState.pay(s, other.id, player.id, amount, 'card');
                    GameState.addLog(s, `${other.name} pays ${player.name} $${amount}.`);
                } else {
                    GameState.pay(s, other.id, player.id, Math.max(0, other.cash), 'card');
                    const { interestDue } = Bankruptcy.declare(s, other.id, player.id);
                    this._chargeTransferInterest(s, player.id, interestDue, {});
                }
            });
            this._afterLanding(s);
            return;
        }
        this._afterLanding(s);
    }

    /**
     * Charge a player. Returns true if paid in full now; false if the game
     * entered DEBT_SETTLEMENT (or the player was auto-bankrupted).
     * creditorId: player id, null (bank), or 'each' (split between others).
     */
    _charge(s, debtorId, amount, creditorId, extra = {}) {
        const debtor = s.players[debtorId];
        if (debtor.cash >= amount) {
            this._distribute(s, debtorId, amount, creditorId, extra.reason);
            return true;
        }
        s.debt = { debtorId, creditorId, amount, ...extra };
        s.phase = GamePhase.DEBT_SETTLEMENT;
        GameState.addLog(s, `${debtor.name} cannot pay $${amount} and must raise cash or go bankrupt.`);
        return false;
    }

    _distribute(s, debtorId, amount, creditorId, reason) {
        if (creditorId === 'each') {
            const others = GameState.activePlayers(s).filter(p => p.id !== debtorId);
            const per = amount / others.length;
            others.forEach(o => GameState.pay(s, debtorId, o.id, per, reason));
            GameState.addLog(s, `${s.players[debtorId].name} pays $${per} to each player.`);
        } else {
            GameState.pay(s, debtorId, creditorId, amount, reason);
            const to = creditorId === null ? 'the bank' : s.players[creditorId].name;
            GameState.addLog(s, `${s.players[debtorId].name} pays $${amount} to ${to}.`);
        }
    }

    _settleDebt(s) {
        const debt = s.debt;
        this._distribute(s, debt.debtorId, debt.amount, debt.creditorId, debt.reason);
        s.debt = null;
        if (debt.thenEndTurn) {
            this._endTurn(s); // debt was owed by a bankruptcy's creditor, not the turn player
            return;
        }
        if (debt.thenMove) {
            const player = s.players[debt.debtorId];
            this._moveBy(s, player, debt.thenMove);
            this._land(s, player, debt.thenMove, {});
            return;
        }
        this._afterLanding(s);
    }

    _maybeAutoPayDebt(s) {
        if (s.debt && s.players[s.debt.debtorId].cash >= s.debt.amount) {
            this._settleDebt(s);
        }
    }

    /**
     * Charge a bankruptcy creditor the 10% interest on mortgaged deeds they
     * received, via the normal debt-settlement flow so they can raise cash
     * instead of going negative. Returns true when nothing is left to settle
     * (paid in full, or the bankruptcy just ended the game — the fee is moot).
     * A card can bankrupt several opponents into the same creditor; fees
     * accumulate onto the already-pending debt in that case.
     */
    _chargeTransferInterest(s, creditorId, amount, extra) {
        if (!amount || this._checkWinner(s)) return true;
        if (s.debt && s.debt.debtorId === creditorId) {
            s.debt.amount += amount;
            return false;
        }
        return this._charge(s, creditorId, amount, null, { reason: 'mortgage interest', ...extra });
    }

    /**
     * Smart liquidation used by the human "Auto Sell/Mortgage" button — mirrors
     * the CPU's debt strategy (CPUPlayer._raiseCash): mortgage spare singles
     * first (cheapest by value), then break down houses lowest-ROI first, until
     * the target is reached or nothing more can be raised.
     */
    _raiseCashToTarget(s, playerId, target) {
        const player = s.players[playerId];
        let guard = 200;
        while (player.cash < target && guard-- > 0) {
            const props = GameState.propertiesOf(s, playerId);

            const mortgageable = props.filter(id => Rules.canMortgage(s, playerId, id).ok);
            if (mortgageable.length > 0) {
                const singles = mortgageable.filter(id => {
                    const g = BOARD[id].group;
                    return !g || !Rules.ownsFullGroup(s, playerId, g);
                });
                const pick = (singles.length > 0 ? singles : mortgageable)
                    .sort((a, b) => Evaluator.propertyValue(s, a, playerId) - Evaluator.propertyValue(s, b, playerId))[0];
                PropertyActions.mortgage(s, playerId, pick);
                continue;
            }

            const sellable = props.filter(id => Rules.canSellHouse(s, playerId, id).ok);
            if (sellable.length > 0) {
                const pick = sellable.sort((a, b) => Evaluator.buildROI(s, a) - Evaluator.buildROI(s, b))[0];
                PropertyActions.sellHouse(s, playerId, pick);
                continue;
            }
            break;
        }
    }

    /** Naive automatic liquidation (used for opponents owing birthday money). */
    _autoRaiseCash(s, playerId, target) {
        const props = () => GameState.propertiesOf(s, playerId);
        // Sell houses cheapest-group first
        let guard = 100;
        while (s.players[playerId].cash < target && guard-- > 0) {
            const withHouses = props().filter(id => Rules.houseCount(s, id) > 0)
                .sort((a, b) => BOARD[a].houseCost - BOARD[b].houseCost);
            const sellable = withHouses.find(id => Rules.canSellHouse(s, playerId, id).ok);
            if (sellable === undefined) break;
            PropertyActions.sellHouse(s, playerId, sellable);
        }
        guard = 100;
        while (s.players[playerId].cash < target && guard-- > 0) {
            const mortgageable = props().filter(id => Rules.canMortgage(s, playerId, id).ok)
                .sort((a, b) => BOARD[a].price - BOARD[b].price);
            if (mortgageable.length === 0) break;
            PropertyActions.mortgage(s, playerId, mortgageable[0]);
        }
    }

    _sendToJail(s, player) {
        player.position = GAME_CONST.JAIL_TILE;
        player.inJail = true;
        player.jailTurns = 0;
        s.rollMeta = null; // no extra roll
        GameState.addLog(s, `${player.name} goes to Jail.`);
        EventBus.emit('sentToJail', { player: player.id });
    }

    _releaseFromJail(s, player, how) {
        player.inJail = false;
        player.jailTurns = 0;
        GameState.addLog(s, `${player.name} ${how} and leaves Jail.`);
    }

    /** After landing fully resolves: doubles roll again, otherwise end-turn. */
    _afterLanding(s) {
        if (s.phase === GamePhase.GAME_OVER) return;
        if (s.debt) return; // unsettled debt (e.g. transfer interest) keeps DEBT_SETTLEMENT
        s.phase = GamePhase.AWAIT_ENDTURN;
    }

    _endTurn(s) {
        if (this._checkWinner(s)) return;
        const n = s.players.length;
        let next = s.currentPlayer;
        for (let i = 1; i <= n; i++) {
            const candidate = (s.currentPlayer + i) % n;
            if (!s.players[candidate].bankrupt) { next = candidate; break; }
        }
        s.currentPlayer = next;
        s.turnNumber += 1;
        s.doublesCount = 0;
        s.rollMeta = null;
        s.pendingAction = null;
        s.tradeAttempts = {};
        const player = s.players[next];
        s.phase = player.inJail ? GamePhase.AWAIT_JAIL_CHOICE : GamePhase.AWAIT_PREROLL;
        GameState.addLog(s, `${player.name}'s turn`);
    }

    _checkWinner(s) {
        if (s.phase === GamePhase.GAME_OVER) return true;
        const active = GameState.activePlayers(s);
        if (active.length === 1 && s.players.length > 1) {
            s.winner = active[0].id;
            s.phase = GamePhase.GAME_OVER;
            GameState.addLog(s, `${active[0].name} wins the game!`);
            EventBus.emit('gameOver', { winnerId: active[0].id });
            return true;
        }
        return false;
    }

    /* ==================== CPU PUMP ==================== */

    /** Who owes the next decision, or null if a human/no one does. */
    pendingCPU() {
        const s = this.state;
        if (typeof CPUPlayer === 'undefined') return null;
        let playerId = null;
        switch (s.phase) {
            case GamePhase.AWAIT_PREROLL:
            case GamePhase.AWAIT_JAIL_CHOICE:
            case GamePhase.AWAIT_DECISION:
            case GamePhase.AWAIT_ENDTURN:
            case GamePhase.DEBT_SETTLEMENT:
                playerId = (s.phase === GamePhase.DEBT_SETTLEMENT) ? s.debt.debtorId : s.currentPlayer;
                break;
            case GamePhase.AUCTION_IN_PROGRESS:
                playerId = Auction.currentBidder(s);
                break;
            case GamePhase.TRADE_PENDING:
                playerId = s.trade.awaiting;
                break;
            default:
                return null;
        }
        const player = s.players[playerId];
        return (player && player.isCPU && !player.bankrupt) ? playerId : null;
    }

    /** Schedule (or run) the next CPU decision. */
    pump() {
        const playerId = this.pendingCPU();
        if (playerId === null) return;
        if (this._cpuTimer) return; // one pending decision at a time

        const run = () => {
            this._cpuTimer = null;
            const currentId = this.pendingCPU();
            if (currentId === null) return;
            const action = CPUPlayer.nextAction(this.state, currentId);
            if (action) this.dispatch(action);
        };

        if (this.cpuDelay === 0) {
            run();
        } else {
            this._cpuTimer = setTimeout(run, this.cpuDelay);
        }
    }

    /**
     * Resolve the current CPU-only auction immediately (UI "Skip" button):
     * run every remaining CPU bid synchronously, then resume normal play.
     * Stops early if a human bidder owes the next decision.
     */
    fastForwardAuction() {
        const s = this.state;
        if (s.phase !== GamePhase.AUCTION_IN_PROGRESS) return;
        if (this._cpuTimer) { clearTimeout(this._cpuTimer); this._cpuTimer = null; }
        let guard = 0;
        while (s.phase === GamePhase.AUCTION_IN_PROGRESS && guard++ < 1000) {
            if (this.pendingCPU() === null) break; // a human bidder still owes a decision
            if (!this.step()) break;               // no CPU action available
        }
        if (this.autoPump) this.pump();
    }

    /**
     * Play the rest of a CPU-only game out at full speed (UI "Skip to end",
     * offered once every human is bankrupt). Runs in ~40ms time slices so the
     * page stays responsive, with UI events muted inside each slice (no
     * per-step render, toast or sound). The history record still gets every
     * log entry and one snapshot per turn: the save + history sync runs on
     * each turn change, and before the capped state.log could drop entries
     * it hasn't seen. Resolves when the game ends, stalls, or shouldStop().
     */
    async fastForwardToEnd(opts = {}) {
        const s = this.state;
        if (this.fastForwarding || s.phase === GamePhase.GAME_OVER) return;
        if (this._cpuTimer) { clearTimeout(this._cpuTimer); this._cpuTimer = null; }
        this.fastForwarding = true;
        const persist = this.persist;
        this.persist = false;
        const logCount = () => s.logCount || s.log.length;
        let savedTurn = s.turnNumber;
        let savedLog = logCount();
        let stalled = false;
        try {
            while (s.phase !== GamePhase.GAME_OVER && !stalled && !(opts.shouldStop && opts.shouldStop())) {
                const sliceEnd = Date.now() + 40;
                EventBus.muted = true;
                try {
                    while (Date.now() < sliceEnd && s.phase !== GamePhase.GAME_OVER) {
                        if (!this.step()) { stalled = true; break; }
                        if (persist && (s.turnNumber !== savedTurn ||
                                logCount() - savedLog >= GAME_CONST.LOG_CAP / 2)) {
                            GameState.save(s);
                            savedTurn = s.turnNumber;
                            savedLog = logCount();
                        }
                    }
                } finally {
                    EventBus.muted = false;
                }
                if (opts.onProgress) opts.onProgress(s);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        } finally {
            this.persist = persist;
            this.fastForwarding = false;
        }
        if (persist) GameState.save(s);
        EventBus.emit('stateChanged', s);
        // _checkWinner's gameOver fired while muted
        if (s.phase === GamePhase.GAME_OVER) EventBus.emit('gameOver', { winnerId: s.winner });
        if (this.autoPump) this.pump();
    }

    /** One synchronous CPU step for headless simulation. Returns true if acted. */
    step() {
        const playerId = this.pendingCPU();
        if (playerId === null) return false;
        const action = CPUPlayer.nextAction(this.state, playerId);
        if (!action) return false;
        const prevAutoPump = this.autoPump;
        this.autoPump = false;
        this.dispatch(action);
        this.autoPump = prevAutoPump;
        return true;
    }
}

if (typeof window !== 'undefined') {
    window.MonopolyEngine = MonopolyEngine;
}
