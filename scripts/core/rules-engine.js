/**
 * Core: Rules Engine
 *
 * Pure functions implementing official Monopoly rules: rent, building
 * legality (even-building, bank scarcity), mortgages, jail, net worth,
 * and landing resolution. No DOM, no persistence, no sequencing.
 *
 * Dependencies: constants.js, board-data.js
 * Exports: window.Rules
 */

const Rules = {

    getTile(tileId) {
        return BOARD[tileId];
    },

    isOwnable(tileId) {
        const t = BOARD[tileId];
        return t.type === 'property' || t.type === 'railroad' || t.type === 'utility';
    },

    getOwner(state, tileId) {
        const ts = state.tiles[String(tileId)];
        return ts ? ts.owner : null;
    },

    tilesInGroup(group) {
        return BOARD.filter(t => t.group === group).map(t => t.id);
    },

    countOwnedInGroup(state, playerId, group) {
        return this.tilesInGroup(group).filter(id => this.getOwner(state, id) === playerId).length;
    },

    ownsFullGroup(state, playerId, group) {
        return this.countOwnedInGroup(state, playerId, group) === GROUP_META[group].size;
    },

    /* ==================== RENT ==================== */

    /* Independent house rules (ludible.nl "How I Fixed Monopoly"). The legacy
       rules.balanced flag (older saves) enabled both at once. */

    /** House rule: rebalanced rent tables (equal ROI per property). */
    balancedRents(state) {
        return !!(state.rules && (state.rules.balancedRents || state.rules.balanced));
    },

    /** House rule: no buying until any player has passed or landed on GO. */
    delayedBuy(state) {
        return !!(state.rules && (state.rules.delayedBuy || state.rules.balanced));
    },

    /** Active rent array for a property tile: [base, 1..4 houses, hotel]. */
    rentTable(state, tileId) {
        return this.balancedRents(state) ? BALANCED_RENTS[tileId] : BOARD[tileId].rent;
    },

    /**
     * Rent owed for landing on tileId with diceTotal.
     * opts.doubleRent  - Chance "nearest railroad" card
     * opts.tenTimesDice - Chance "nearest utility" card
     * Returns 0 if unowned, mortgaged, or owned by the lander.
     */
    calcRent(state, tileId, landerId, diceTotal, opts = {}) {
        const tile = BOARD[tileId];
        const ts = state.tiles[String(tileId)];
        if (!ts || ts.owner === null || ts.owner === landerId || ts.mortgaged) return 0;
        const owner = ts.owner;

        if (tile.type === 'property') {
            const rents = this.rentTable(state, tileId);
            if (ts.houses > 0) return rents[ts.houses];
            const monopoly = this.ownsFullGroup(state, owner, tile.group);
            return monopoly ? rents[0] * 2 : rents[0];
        }

        if (tile.type === 'railroad') {
            const owned = this.countOwnedInGroup(state, owner, 'railroad');
            const base = this.balancedRents(state)
                ? BALANCED_RENTS[tileId][owned - 1]
                : 25 * Math.pow(2, owned - 1);
            return opts.doubleRent ? base * 2 : base;
        }

        if (tile.type === 'utility') {
            if (opts.tenTimesDice) return diceTotal * 10;
            const owned = this.countOwnedInGroup(state, owner, 'utility');
            if (this.balancedRents(state)) return diceTotal * BALANCED_RENTS[tileId][owned - 1];
            return diceTotal * (owned === 2 ? 10 : 4);
        }

        return 0;
    },

    /* ==================== BUILDING ==================== */

    /** Houses on a tile; 5 means hotel. */
    houseCount(state, tileId) {
        const ts = state.tiles[String(tileId)];
        return ts ? ts.houses : 0;
    },

    groupHouseCounts(state, group) {
        return this.tilesInGroup(group).map(id => this.houseCount(state, id));
    },

    /** { ok, reason } - even-building, monopoly, mortgage, and bank-stock checks. */
    canBuildHouse(state, playerId, tileId) {
        const tile = BOARD[tileId];
        if (!tile || tile.type !== 'property') return { ok: false, reason: 'Not a buildable property' };
        const ts = state.tiles[String(tileId)];
        if (!ts || ts.owner !== playerId) return { ok: false, reason: 'Not owned by player' };
        if (!this.ownsFullGroup(state, playerId, tile.group)) return { ok: false, reason: 'Need the full color group' };
        if (this.tilesInGroup(tile.group).some(id => state.tiles[String(id)] && state.tiles[String(id)].mortgaged)) {
            return { ok: false, reason: 'A property in the group is mortgaged' };
        }
        if (ts.houses >= 5) return { ok: false, reason: 'Already has a hotel' };
        // Even building: cannot exceed the minimum in the group
        const min = Math.min(...this.groupHouseCounts(state, tile.group));
        if (ts.houses > min) return { ok: false, reason: 'Must build evenly across the group' };
        // Bank stock
        if (ts.houses === 4) {
            if (state.bank.hotels < 1) return { ok: false, reason: 'No hotels left in the bank' };
        } else if (state.bank.houses < 1) {
            return { ok: false, reason: 'No houses left in the bank' };
        }
        if (state.players[playerId].cash < tile.houseCost) return { ok: false, reason: 'Not enough cash' };
        return { ok: true };
    },

    /** { ok, reason } - even selling: cannot drop below the group max - handled via max check. */
    canSellHouse(state, playerId, tileId) {
        const tile = BOARD[tileId];
        if (!tile || tile.type !== 'property') return { ok: false, reason: 'Not a property' };
        const ts = state.tiles[String(tileId)];
        if (!ts || ts.owner !== playerId) return { ok: false, reason: 'Not owned by player' };
        if (ts.houses === 0) return { ok: false, reason: 'No houses to sell' };
        const max = Math.max(...this.groupHouseCounts(state, tile.group));
        if (ts.houses < max) return { ok: false, reason: 'Must sell evenly across the group' };
        // Breaking a hotel back to 4 houses requires houses in the bank
        if (ts.houses === 5 && state.bank.houses < 4) {
            return { ok: false, reason: 'Not enough houses in the bank to break the hotel' };
        }
        return { ok: true };
    },

    houseSellValue(tileId) {
        return BOARD[tileId].houseCost / 2;
    },

    /* ==================== MORTGAGE ==================== */

    mortgageValue(tileId) {
        return BOARD[tileId].price / 2;
    },

    unmortgageCost(tileId) {
        return Math.ceil(this.mortgageValue(tileId) * (1 + GAME_CONST.MORTGAGE_INTEREST));
    },

    /** Fee when receiving a mortgaged property (trade/bankruptcy) without unmortgaging. */
    mortgageTransferFee(tileId) {
        return Math.ceil(this.mortgageValue(tileId) * GAME_CONST.MORTGAGE_INTEREST);
    },

    canMortgage(state, playerId, tileId) {
        const ts = state.tiles[String(tileId)];
        if (!ts || ts.owner !== playerId) return { ok: false, reason: 'Not owned by player' };
        if (ts.mortgaged) return { ok: false, reason: 'Already mortgaged' };
        const tile = BOARD[tileId];
        if (tile.type === 'property') {
            const anyHouses = this.tilesInGroup(tile.group).some(id => this.houseCount(state, id) > 0);
            if (anyHouses) return { ok: false, reason: 'Sell all houses in the group first' };
        }
        return { ok: true };
    },

    canUnmortgage(state, playerId, tileId) {
        const ts = state.tiles[String(tileId)];
        if (!ts || ts.owner !== playerId) return { ok: false, reason: 'Not owned by player' };
        if (!ts.mortgaged) return { ok: false, reason: 'Not mortgaged' };
        if (state.players[playerId].cash < this.unmortgageCost(tileId)) return { ok: false, reason: 'Not enough cash' };
        return { ok: true };
    },

    /* ==================== VALUATION ==================== */

    /** Total wealth: cash + full property prices + building costs. */
    netWorth(state, playerId) {
        const player = state.players[playerId];
        let worth = player.cash;
        GameState.propertiesOf(state, playerId).forEach(tileId => {
            const tile = BOARD[tileId];
            const ts = state.tiles[String(tileId)];
            worth += ts.mortgaged ? this.mortgageValue(tileId) : tile.price;
            if (ts.houses > 0) worth += ts.houses * tile.houseCost;
        });
        return worth;
    },

    /**
     * Max cash raisable right now: cash + house sales + mortgaging everything.
     * Hotels need 4 bank houses to break; when the bank is short even after
     * selling every loose house we own, hotel groups are frozen solid (their
     * houses cannot be sold, so nothing in the group can be mortgaged either)
     * and their equity must not be counted as raisable.
     */
    liquidationValue(state, playerId) {
        const player = state.players[playerId];
        const props = GameState.propertiesOf(state, playerId);

        const hotelGroups = {};
        props.forEach(tileId => {
            if (this.houseCount(state, tileId) === 5) hotelGroups[BOARD[tileId].group] = true;
        });
        let looseHouses = 0; // sellable now; selling them restocks the bank
        props.forEach(tileId => {
            const h = this.houseCount(state, tileId);
            if (h > 0 && h < 5 && !hotelGroups[BOARD[tileId].group]) looseHouses += h;
        });
        const hotelsStuck = state.bank.houses + looseHouses < 4;

        let total = player.cash;
        props.forEach(tileId => {
            const ts = state.tiles[String(tileId)];
            if (hotelsStuck && hotelGroups[BOARD[tileId].group]) return;
            if (ts.houses > 0) total += ts.houses * this.houseSellValue(tileId);
            if (!ts.mortgaged) total += this.mortgageValue(tileId);
        });
        return total;
    },

    /* ==================== LANDING ==================== */

    nearestTileOfType(fromTileId, tileType) {
        for (let step = 1; step <= 40; step++) {
            const id = (fromTileId + step) % 40;
            if (BOARD[id].type === tileType) return id;
        }
        return null;
    },

    /**
     * What landing on a tile requires. Pure - the turn engine applies it.
     * Returns { kind, ... }:
     *   none | buyOrAuction | buyLocked | rent | tax | drawCard | goToJail
     */
    resolveLanding(state, playerId, tileId, diceTotal, opts = {}) {
        const tile = BOARD[tileId];

        if (this.isOwnable(tileId)) {
            const owner = this.getOwner(state, tileId);
            if (owner === null) {
                // Delayed-buy rule: nothing may be bought (or auctioned) until
                // any one player has passed or landed on GO
                if (this.delayedBuy(state) && state.buyingUnlocked === false) {
                    return { kind: 'buyLocked', tileId: tileId };
                }
                return { kind: 'buyOrAuction', tileId: tileId };
            }
            if (owner === playerId) return { kind: 'none' };
            const rent = this.calcRent(state, tileId, playerId, diceTotal, opts);
            if (rent === 0) return { kind: 'none' }; // mortgaged
            return { kind: 'rent', tileId: tileId, ownerId: owner, amount: rent };
        }

        switch (tile.type) {
            case 'tax': return { kind: 'tax', amount: tile.amount };
            case 'chance': return { kind: 'drawCard', deck: 'chance' };
            case 'chest': return { kind: 'drawCard', deck: 'community' };
            case 'gotojail': return { kind: 'goToJail' };
            default: return { kind: 'none' }; // go, jail (visiting), free parking
        }
    },

    /** Repairs cost for a card effect. */
    repairsCost(state, playerId, perHouse, perHotel) {
        let houses = 0, hotels = 0;
        GameState.propertiesOf(state, playerId).forEach(tileId => {
            const n = this.houseCount(state, tileId);
            if (n === 5) hotels += 1;
            else houses += n;
        });
        return houses * perHouse + hotels * perHotel;
    }
};

if (typeof window !== 'undefined') {
    window.Rules = Rules;
}
