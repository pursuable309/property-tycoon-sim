/**
 * Feature: Property Actions
 *
 * Appliers for build / sell / mortgage / unmortgage. Validation comes from
 * Rules.can* - these apply the mutation and log. Called by the TurnEngine.
 *
 * Dependencies: game-state.js, rules-engine.js
 * Exports: window.PropertyActions
 */

const PropertyActions = {

    buy(state, playerId, tileId, price) {
        const player = state.players[playerId];
        const tile = BOARD[tileId];
        GameState.pay(state, playerId, null, price);
        GameState.tileState(state, tileId).owner = playerId;
        GameState.addLog(state, `${player.name} buys ${tile.name} for $${price}.`);
    },

    buildHouse(state, playerId, tileId) {
        const check = Rules.canBuildHouse(state, playerId, tileId);
        if (!check.ok) return check;
        const tile = BOARD[tileId];
        const ts = GameState.tileState(state, tileId);
        GameState.pay(state, playerId, null, tile.houseCost);
        if (ts.houses === 4) {
            ts.houses = 5;
            state.bank.houses += 4;   // four houses return to the bank
            state.bank.hotels -= 1;
            GameState.addLog(state, `${state.players[playerId].name} builds a hotel on ${tile.name}.`);
        } else {
            ts.houses += 1;
            state.bank.houses -= 1;
            GameState.addLog(state, `${state.players[playerId].name} builds a house on ${tile.name} (${ts.houses}).`);
        }
        return { ok: true };
    },

    sellHouse(state, playerId, tileId) {
        const check = Rules.canSellHouse(state, playerId, tileId);
        if (!check.ok) return check;
        const tile = BOARD[tileId];
        const ts = GameState.tileState(state, tileId);
        if (ts.houses === 5) {
            ts.houses = 4;
            state.bank.hotels += 1;
            state.bank.houses -= 4;
            GameState.pay(state, null, playerId, tile.houseCost / 2);
            GameState.addLog(state, `${state.players[playerId].name} sells the hotel on ${tile.name}.`);
        } else {
            ts.houses -= 1;
            state.bank.houses += 1;
            GameState.pay(state, null, playerId, tile.houseCost / 2);
            GameState.addLog(state, `${state.players[playerId].name} sells a house on ${tile.name} (${ts.houses}).`);
        }
        return { ok: true };
    },

    mortgage(state, playerId, tileId) {
        const check = Rules.canMortgage(state, playerId, tileId);
        if (!check.ok) return check;
        GameState.tileState(state, tileId).mortgaged = true;
        GameState.pay(state, null, playerId, Rules.mortgageValue(tileId));
        GameState.addLog(state, `${state.players[playerId].name} mortgages ${BOARD[tileId].name} for $${Rules.mortgageValue(tileId)}.`);
        return { ok: true };
    },

    unmortgage(state, playerId, tileId) {
        const check = Rules.canUnmortgage(state, playerId, tileId);
        if (!check.ok) return check;
        GameState.tileState(state, tileId).mortgaged = false;
        GameState.pay(state, playerId, null, Rules.unmortgageCost(tileId));
        GameState.addLog(state, `${state.players[playerId].name} unmortgages ${BOARD[tileId].name} for $${Rules.unmortgageCost(tileId)}.`);
        return { ok: true };
    }
};

if (typeof window !== 'undefined') {
    window.PropertyActions = PropertyActions;
}
