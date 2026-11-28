/**
 * Feature: Card Effects
 *
 * Executes Chance / Community Chest card effects. Movement effects are
 * delegated back to the TurnEngine so landing resolution (rent, buy, etc.)
 * chains correctly.
 *
 * Dependencies: constants.js, board-data.js, game-state.js, rules-engine.js
 * Exports: window.Cards
 */

const Cards = {

    /**
     * Apply a drawn card for a player. Returns an outcome descriptor:
     *   { moved: bool, landingOpts: {...} } - engine re-resolves landing if moved
     *   { jailed: true }
     *   { charge: { amount, creditorId } } - engine routes through debt handling
     *   { done: true }
     */
    apply(state, playerId, card) {
        const player = state.players[playerId];
        const eff = card.effect;

        switch (eff.type) {
            case 'moveTo': {
                this._moveTo(state, player, eff.tile);
                return { moved: true, landingOpts: {} };
            }

            case 'moveBy': {
                let target = (player.position + eff.amount + 40) % 40;
                // Moving backwards never passes GO
                if (eff.amount > 0) {
                    this._moveTo(state, player, target);
                } else {
                    player.position = target;
                    GameState.addLog(state, `${player.name} moves back to ${BOARD[target].name}.`);
                }
                return { moved: true, landingOpts: {} };
            }

            case 'moveToNearest': {
                const target = Rules.nearestTileOfType(player.position, eff.tileType);
                this._moveTo(state, player, target);
                const opts = {};
                if (eff.special === 'doubleRent') opts.doubleRent = true;
                if (eff.special === 'tenTimesDice') opts.tenTimesDice = true;
                return { moved: true, landingOpts: opts };
            }

            case 'collect':
                GameState.pay(state, null, playerId, eff.amount, 'card');
                GameState.addLog(state, `${player.name} collects $${eff.amount}.`);
                return { done: true };

            case 'pay':
                return { charge: { amount: eff.amount, creditorId: null } };

            case 'payEach': {
                const others = GameState.activePlayers(state).filter(p => p.id !== playerId);
                return { charge: { amount: eff.amount * others.length, creditorId: 'each' } };
            }

            case 'collectEach':
                // Opponents pay the player; the engine auto-liquidates short opponents
                return { collectEach: { amount: eff.amount } };

            case 'repairs': {
                const cost = Rules.repairsCost(state, playerId, eff.perHouse, eff.perHotel);
                if (cost === 0) {
                    GameState.addLog(state, `${player.name} owes nothing for repairs.`);
                    return { done: true };
                }
                return { charge: { amount: cost, creditorId: null } };
            }

            case 'goToJail':
                return { jailed: true };

            case 'getOutOfJail': {
                player.getOutCards += 1;
                if (card.id === 'ch8') state.decks.chanceJailCardHeldBy = playerId;
                else state.decks.communityJailCardHeldBy = playerId;
                GameState.addLog(state, `${player.name} keeps a Get Out of Jail Free card.`);
                return { done: true };
            }

            default:
                console.error('Unknown card effect:', eff);
                return { done: true };
        }
    },

    /** Forward movement to an absolute tile, collecting GO salary when passing. */
    _moveTo(state, player, target) {
        if (target <= player.position && target !== player.position) {
            GameState.pay(state, null, player.id, GAME_CONST.GO_SALARY, 'salary');
            GameState.addLog(state, `${player.name} passes GO and collects $${GAME_CONST.GO_SALARY}.`);
            GameState.unlockBuying(state);
        }
        player.position = target;
        GameState.addLog(state, `${player.name} advances to ${BOARD[target].name}.`);
    }
};

if (typeof window !== 'undefined') {
    window.Cards = Cards;
}
