/**
 * Feature: Auction
 *
 * Round-robin auction started when a player declines to buy (official rules).
 * All solvent players, including the decliner, may bid. State lives in
 * state.auction so auctions survive save/reload.
 *
 * Dependencies: game-state.js, rules-engine.js
 * Exports: window.Auction
 */

const Auction = {

    start(state, tileId) {
        const bidders = GameState.activePlayers(state).map(p => p.id);
        state.auction = {
            tileId: tileId,
            declinedBy: state.currentPlayer, // the player whose decline opened this auction
            currentBid: 0,
            currentWinner: null,
            activeBidders: bidders,
            allBidders: bidders.slice(), // for UI: everyone, incl. later passers
            bids: {},                    // playerId -> their highest bid so far
            turnIdx: (bidders.indexOf(state.currentPlayer) + 1) % bidders.length  // bidding starts left of the decliner
        };
        GameState.addLog(state, `Auction started for ${BOARD[tileId].name}.`);
    },

    currentBidder(state) {
        const a = state.auction;
        return a.activeBidders[a.turnIdx % a.activeBidders.length];
    },

    /** Returns { ok, reason } or { ok, done, winnerId, price } when the bid ends the auction. */
    bid(state, playerId, amount) {
        const a = state.auction;
        if (playerId !== this.currentBidder(state)) return { ok: false, reason: 'Not your turn to bid' };
        if (amount <= a.currentBid) return { ok: false, reason: 'Bid must exceed current bid' };
        if (amount > state.players[playerId].cash) return { ok: false, reason: 'Cannot bid more than your cash' };
        a.currentBid = amount;
        a.currentWinner = playerId;
        if (a.bids) a.bids[playerId] = amount;
        a.turnIdx = (a.turnIdx + 1) % a.activeBidders.length;
        GameState.addLog(state, `${state.players[playerId].name} bids $${amount}.`);
        // Sole remaining bidder (everyone else passed before any bid stood):
        // nobody is left to outbid them, so the bid wins outright
        if (a.activeBidders.length === 1) return this._finish(state);
        return { ok: true };
    },

    /** Returns { ok, done, winnerId, price } - done when the auction ends. */
    pass(state, playerId) {
        const a = state.auction;
        if (playerId !== this.currentBidder(state)) return { ok: false, reason: 'Not your turn to bid' };
        if (playerId === a.currentWinner) return this._finish(state); // standing high bid wins

        const idx = a.activeBidders.indexOf(playerId);
        a.activeBidders.splice(idx, 1);
        if (idx < a.turnIdx) a.turnIdx -= 1;
        if (a.turnIdx >= a.activeBidders.length) a.turnIdx = 0;
        GameState.addLog(state, `${state.players[playerId].name} passes.`);

        if (a.activeBidders.length === 0) {
            GameState.addLog(state, `No bids. ${BOARD[a.tileId].name} remains unsold.`);
            state.auction = null;
            return { ok: true, done: true, winnerId: null };
        }
        if (a.activeBidders.length === 1 && a.activeBidders[0] === a.currentWinner) {
            return this._finish(state);
        }
        return { ok: true, done: false };
    },

    _finish(state) {
        const a = state.auction;
        const winnerId = a.currentWinner;
        const price = a.currentBid;
        PropertyActions.buy(state, winnerId, a.tileId, price);
        state.auction = null;
        return { ok: true, done: true, winnerId: winnerId, price: price };
    }
};

if (typeof window !== 'undefined') {
    window.Auction = Auction;
}
