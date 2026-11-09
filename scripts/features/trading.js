/**
 * Feature: Trading
 *
 * Trade offer model, validation, and application. Offers can include
 * properties (no buildings anywhere in their color group), cash, and
 * Get Out of Jail Free cards. When you receive a mortgaged property the
 * official rules let you choose, then and there, either to lift the mortgage
 * at once (pay principal + 10%, ~the normal unmortgage cost) or to keep it
 * mortgaged and pay only the 10% transfer interest now (a further 10% is owed
 * whenever you later unmortgage). A side's `liftNow` lists the mortgaged
 * deeds on that side whose receiver elected to lift on receipt.
 *
 * Offer shape (stored in state.trade while pending):
 *   { from, to, give: { cash, properties: [], jailCards, liftNow: [] }, get: { ... } }
 * "give"/"get" are from the proposer's perspective; each side's `liftNow` is a
 * subset of that side's mortgaged `properties`, chosen by whoever receives them.
 *
 * Dependencies: game-state.js, rules-engine.js
 * Exports: window.Trading
 */

const Trading = {

    emptySide() {
        return { cash: 0, properties: [], jailCards: 0 };
    },

    /** "Boardwalk, $200, 1 Get Out of Jail Free card" — '' when the side is empty. */
    sideText(side) {
        const parts = side.properties.map(id => BOARD[id].name);
        if (side.cash > 0) parts.push(`$${side.cash}`);
        if (side.jailCards > 0) {
            parts.push(`${side.jailCards} Get Out of Jail Free card${side.jailCards > 1 ? 's' : ''}`);
        }
        return parts.join(', ');
    },

    /** Log detail line spelling out an offer from the proposer's perspective. */
    describeOffer(state, offer) {
        const gives = this.sideText(offer.give) || 'nothing';
        const wants = this.sideText(offer.get) || 'nothing';
        return `${state.players[offer.from].name} offers ${gives} for ${wants}.`;
    },

    /** Returns { ok, reason } */
    validate(state, offer) {
        const from = state.players[offer.from];
        const to = state.players[offer.to];
        if (!from || !to || from.bankrupt || to.bankrupt) return { ok: false, reason: 'Invalid players' };
        if (offer.from === offer.to) return { ok: false, reason: 'Cannot trade with yourself' };

        const empty = (s) => s.cash === 0 && s.properties.length === 0 && s.jailCards === 0;
        if (empty(offer.give) && empty(offer.get)) return { ok: false, reason: 'Empty trade' };

        const sides = [
            { side: offer.give, owner: from },
            { side: offer.get, owner: to }
        ];
        for (const { side, owner } of sides) {
            if (side.cash < 0) return { ok: false, reason: 'Invalid cash amount' };
            if (side.cash > owner.cash) return { ok: false, reason: `${owner.name} does not have that much cash` };
            if (side.jailCards > owner.getOutCards) return { ok: false, reason: `${owner.name} does not have that many jail cards` };
            for (const tileId of side.properties) {
                const ts = state.tiles[String(tileId)];
                if (!ts || ts.owner !== owner.id) return { ok: false, reason: `${owner.name} does not own ${BOARD[tileId].name}` };
                const tile = BOARD[tileId];
                if (tile.type === 'property') {
                    const groupHasHouses = Rules.tilesInGroup(tile.group).some(id => Rules.houseCount(state, id) > 0);
                    if (groupHasHouses) return { ok: false, reason: `Sell buildings in the ${GROUP_META[tile.group].label} group before trading` };
                }
            }
        }

        // Receivers must afford, per mortgaged deed they get, either the full
        // unmortgage cost (if lifting on receipt) or the 10% transfer fee. Under
        // the simplified house rule there is no cost at transfer time.
        const simple = state.rules && state.rules.simpleMortgageTransfer;
        const receiptCost = (side) => {
            if (simple) return 0;
            const lift = new Set(side.liftNow || []);
            return side.properties.reduce((sum, id) => {
                if (!state.tiles[String(id)].mortgaged) return sum;
                return sum + (lift.has(id) ? Rules.unmortgageCost(id) : Rules.mortgageTransferFee(id));
            }, 0);
        };
        const toNet = offer.give.cash - offer.get.cash - receiptCost(offer.give);
        const fromNet = offer.get.cash - offer.give.cash - receiptCost(offer.get);
        if (to.cash + toNet < 0) return { ok: false, reason: `${to.name} cannot afford the mortgage costs` };
        if (from.cash + fromNet < 0) return { ok: false, reason: `${from.name} cannot afford the mortgage costs` };

        return { ok: true };
    },

    /** Apply an accepted trade. Assumes validate() passed. */
    apply(state, offer) {
        const from = state.players[offer.from];
        const to = state.players[offer.to];

        this._transferSide(state, offer.give, offer.from, offer.to);
        this._transferSide(state, offer.get, offer.to, offer.from);

        GameState.addLog(state, `Trade completed between ${from.name} and ${to.name}.`);
        state.trades = state.trades || [];
        state.trades.push({
            turn: state.turnNumber,
            from: offer.from,
            to: offer.to,
            counters: offer.counters || 0,
            give: { cash: offer.give.cash, jailCards: offer.give.jailCards, properties: offer.give.properties.slice(), liftNow: (offer.give.liftNow || []).slice() },
            get: { cash: offer.get.cash, jailCards: offer.get.jailCards, properties: offer.get.properties.slice(), liftNow: (offer.get.liftNow || []).slice() }
        });
        EventBus.emit('tradeCompleted', { offer: offer });
    },

    _transferSide(state, side, giverId, receiverId) {
        if (side.cash > 0) {
            GameState.pay(state, giverId, receiverId, side.cash);
            GameState.addLog(state, `${state.players[giverId].name} pays $${side.cash}.`);
        }
        // Simplified house rule: mortgaged deeds transfer with no fee and stay
        // mortgaged; the new owner pays 10% only if/when they later unmortgage.
        const simple = state.rules && state.rules.simpleMortgageTransfer;
        const lift = new Set(side.liftNow || []);
        side.properties.forEach(tileId => {
            const ts = GameState.tileState(state, tileId);
            ts.owner = receiverId;
            GameState.addLog(state, `${BOARD[tileId].name} goes to ${state.players[receiverId].name}.`);
            if (ts.mortgaged && !simple) {
                if (lift.has(tileId)) {
                    // Lift on receipt: pay principal + 10% (the standard unmortgage
                    // cost) and take the deed unmortgaged — no separate transfer fee.
                    const cost = Rules.unmortgageCost(tileId);
                    ts.mortgaged = false;
                    GameState.pay(state, receiverId, null, cost);
                    GameState.addLog(state, `${state.players[receiverId].name} lifts the mortgage on ${BOARD[tileId].name} for $${cost}.`);
                } else {
                    // Kept mortgaged: pay only the 10% transfer interest now.
                    const fee = Rules.mortgageTransferFee(tileId);
                    GameState.pay(state, receiverId, null, fee);
                    GameState.addLog(state, `${state.players[receiverId].name} pays $${fee} mortgage interest.`);
                }
            }
        });
        for (let i = 0; i < side.jailCards; i++) {
            state.players[giverId].getOutCards -= 1;
            state.players[receiverId].getOutCards += 1;
            if (state.decks.chanceJailCardHeldBy === giverId) state.decks.chanceJailCardHeldBy = receiverId;
            else if (state.decks.communityJailCardHeldBy === giverId) state.decks.communityJailCardHeldBy = receiverId;
        }
    }
};

if (typeof window !== 'undefined') {
    window.Trading = Trading;
}
