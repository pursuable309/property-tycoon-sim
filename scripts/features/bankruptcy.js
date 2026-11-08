/**
 * Feature: Bankruptcy
 *
 * Asset transfer when a player cannot cover a debt (official rules):
 *  - Buildings are sold to the bank for half price (cash joins the estate).
 *  - To a creditor player: remaining cash, all deeds (mortgaged deeds incur
 *    the 10% transfer fee, owed by the creditor), and jail cards transfer.
 *    The fee is NOT paid here — it is returned as interestDue so the turn
 *    engine can charge it through debt settlement (the creditor may need to
 *    raise cash; paying directly could push them negative).
 *  - To the bank: deeds are unmortgaged and returned unowned; jail cards
 *    return to their decks.
 *
 * Dependencies: game-state.js, rules-engine.js
 * Exports: window.Bankruptcy
 */

const Bankruptcy = {

    /** creditorId of null means the bank.
     *  Returns { properties, interestDue }: the transferred tileIds and the
     *  total 10% mortgage-transfer interest the creditor still owes the bank. */
    declare(state, debtorId, creditorId) {
        const debtor = state.players[debtorId];
        const properties = GameState.propertiesOf(state, debtorId);

        // Sell all buildings to the bank for half price
        properties.forEach(tileId => {
            const ts = GameState.tileState(state, tileId);
            if (ts.houses === 5) {
                state.bank.hotels += 1;
                GameState.pay(state, null, debtorId, BOARD[tileId].houseCost * 5 / 2);
            } else if (ts.houses > 0) {
                state.bank.houses += ts.houses;
                GameState.pay(state, null, debtorId, ts.houses * BOARD[tileId].houseCost / 2);
            }
            ts.houses = 0;
        });

        // Hand over cash
        if (debtor.cash > 0 && creditorId !== null) {
            GameState.pay(state, debtorId, creditorId, debtor.cash);
        }
        debtor.cash = 0;

        // Transfer deeds
        let interestDue = 0;
        properties.forEach(tileId => {
            const ts = GameState.tileState(state, tileId);
            if (creditorId === null) {
                ts.owner = null;
                ts.mortgaged = false;
            } else {
                ts.owner = creditorId;
                if (ts.mortgaged) {
                    const fee = Rules.mortgageTransferFee(tileId);
                    interestDue += fee;
                    GameState.addLog(state, `${state.players[creditorId].name} owes $${fee} interest on mortgaged ${BOARD[tileId].name}.`);
                }
            }
        });

        // Jail cards
        while (debtor.getOutCards > 0) {
            if (creditorId === null) {
                GameState.returnJailCard(state, debtorId);
            } else {
                debtor.getOutCards -= 1;
                state.players[creditorId].getOutCards += 1;
                if (state.decks.chanceJailCardHeldBy === debtorId) state.decks.chanceJailCardHeldBy = creditorId;
                else if (state.decks.communityJailCardHeldBy === debtorId) state.decks.communityJailCardHeldBy = creditorId;
            }
        }

        debtor.bankrupt = true;
        debtor.inJail = false;
        const to = creditorId === null ? 'the bank' : state.players[creditorId].name;
        GameState.addLog(state, `${debtor.name} is bankrupt. Assets go to ${to}.`);
        EventBus.emit('playerBankrupt', { playerId: debtorId, creditorId });
        return { properties, interestDue };
    }
};

if (typeof window !== 'undefined') {
    window.Bankruptcy = Bankruptcy;
}
