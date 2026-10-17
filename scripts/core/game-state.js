/**
 * Core: Game State
 *
 * Creates, persists, and mutates the single serializable game-state object.
 * Higher-level rule decisions live in rules-engine.js; sequencing lives in
 * turn-engine.js. Money movement goes through GameState.pay() so the ledger
 * stays consistent (bank == null).
 *
 * Dependencies: constants.js, rng.js, board-data.js, storage.js
 * Exports: window.GameState
 */

const GameState = {

    /**
     * @param {Object} config
     * @param {Array}  config.seats - [{ name, isCPU, difficulty, token }]
     * @param {number} [config.seed]
     */
    createGame(config) {
        const seed = (config.seed !== undefined) ? (config.seed | 0) : ((Date.now() ^ (Math.random() * 0xFFFFFFFF)) | 0);
        const state = {
            version: 1,
            seed: seed,
            gameId: `${Date.now().toString(36)}-${(seed >>> 0).toString(36)}`,
            rngState: seed,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            phase: GamePhase.AWAIT_PREROLL,
            pendingAction: null,
            currentPlayer: 0,
            doublesCount: 0,
            turnNumber: 1,
            lastDice: null,
            players: [],
            tiles: {},
            bank: { houses: GAME_CONST.BANK_HOUSES, hotels: GAME_CONST.BANK_HOTELS },
            decks: {
                chance: CHANCE_CARDS.map(c => c.id),
                community: COMMUNITY_CARDS.map(c => c.id),
                chanceJailCardHeldBy: null,
                communityJailCardHeldBy: null
            },
            rules: {
                balancedRents: !!config.balancedRents,   // ludible.nl rebalanced rent tables
                delayedBuy: !!config.delayedBuy,         // no buying until anyone reaches GO
                freeParking: !!config.freeParking,       // house-rule jackpot on Free Parking
                // 'classic' = taxes/fines/card penalties only; 'all' = every payment to the bank
                freeParkingScope: config.freeParking ? (config.freeParkingScope === 'all' ? 'all' : 'classic') : undefined,
                // default true: no 10% transfer fee on traded mortgaged deeds; the new owner
                // pays 10% only at unmortgage. Opt into the official fee via "Advanced" in setup.
                simpleMortgageTransfer: config.simpleMortgageTransfer === undefined ? true : !!config.simpleMortgageTransfer
            },
            // delayedBuy: buying locked until any player passes/lands on GO
            buyingUnlocked: !config.delayedBuy,
            // Free Parking jackpot: cash paid to the bank piles here until collected
            freeParkingPot: 0,
            auction: null,
            trade: null,
            debt: null,          // { debtorId, creditorId|null, amount }
            winner: null,
            log: [],
            logCount: 0,     // total entries ever logged (log itself is capped)
            trades: [],      // structured completed-trade records for history
            // AI tuning overrides active at game start (so reviews know
            // what the CPUs were playing with)
            tuning: (typeof window !== 'undefined' && window.AITuning) ? AITuning.overrides() : {}
        };

        config.seats.forEach((seat, i) => {
            const player = {
                id: i,
                name: seat.name || (seat.isCPU ? `CPU ${i + 1}` : `Player ${i + 1}`),
                token: seat.token || ['hat', 'car', 'dog', 'ship', 'boot', 'cat', 'moneybag', 'horse'][i],
                isCPU: !!seat.isCPU,
                cash: GAME_CONST.STARTING_CASH,
                position: 0,
                inJail: false,
                jailTurns: 0,
                getOutCards: 0,
                bankrupt: false
            };
            if (player.isCPU) {
                player.difficulty = seat.difficulty || 3;
                player.personality = null; // assigned by ai/personalities.js when AI loads
                player.personalityPick = seat.personality || null; // null = random archetype
            }
            state.players.push(player);
        });

        RNG.shuffle(state, state.decks.chance);
        RNG.shuffle(state, state.decks.community);
        this.addLog(state, 'New game started.');
        if (state.rules.balancedRents) this.addLog(state, 'House rule: rebalanced rents (equal ROI per property).');
        if (state.rules.delayedBuy) this.addLog(state, 'House rule: no buying until any player reaches GO.');
        if (state.rules.freeParking) this.addLog(state, `House rule: Free Parking jackpot (${state.rules.freeParkingScope === 'all' ? 'all bank payments' : 'penalties & taxes'}).`);
        if (!state.rules.simpleMortgageTransfer) this.addLog(state, 'House rule: advanced mortgage transfers (10% fee when receiving a mortgaged deed).');
        this._rollOff(state);
        return state;
    },

    /** Official start: every player rolls, highest goes first; ties re-roll.
     *  Rounds are kept in state.rollOff so the UI can present them. */
    _rollOff(state) {
        if (state.players.length < 2) return;
        let contenders = state.players.map(p => p.id);
        state.rollOff = [];
        while (contenders.length > 1) {
            const round = contenders.map(id => {
                const d = RNG.rollDice(state);
                this.addLog(state, `${state.players[id].name} rolls ${d[0]} + ${d[1]} for first move.`);
                return { id, dice: d, total: d[0] + d[1] };
            });
            state.rollOff.push(round);
            const max = Math.max(...round.map(r => r.total));
            const tied = round.filter(r => r.total === max).map(r => r.id);
            if (tied.length > 1) this.addLog(state, 'Tie — tied players roll again.');
            contenders = tied;
        }
        state.currentPlayer = contenders[0];
        this.addLog(state, `${state.players[contenders[0]].name} goes first.`);
    },

    /* ==================== PERSISTENCE ==================== */

    save(state) {
        state.updatedAt = new Date().toISOString();
        const ok = StorageManager.set(STORAGE_KEYS.SAVE, state);
        if (typeof GameHistory !== 'undefined') GameHistory.sync(state);
        return ok;
    },

    load() {
        const state = StorageManager.get(STORAGE_KEYS.SAVE, null);
        if (!state || state.version !== 1) return null;
        return state;
    },

    hasSave() {
        return this.load() !== null;
    },

    clearSave() {
        return StorageManager.remove(STORAGE_KEYS.SAVE);
    },

    /* ==================== ACCESSORS ==================== */

    getPlayer(state, id) {
        return state.players[id];
    },

    currentPlayer(state) {
        return state.players[state.currentPlayer];
    },

    activePlayers(state) {
        return state.players.filter(p => !p.bankrupt);
    },

    /** Ownership record for a tile (creates on demand for ownable tiles). */
    tileState(state, tileId) {
        const key = String(tileId);
        if (!state.tiles[key]) {
            state.tiles[key] = { owner: null, houses: 0, mortgaged: false };
        }
        return state.tiles[key];
    },

    /** Tile ids owned by a player. */
    propertiesOf(state, playerId) {
        return Object.keys(state.tiles)
            .filter(k => state.tiles[k].owner === playerId)
            .map(Number)
            .sort((a, b) => a - b);
    },

    /* ==================== MUTATORS ==================== */

    /**
     * Move money. fromId/toId of null means the bank.
     * Does NOT check solvency - the turn engine handles debt.
     * When a reason is given ('rent', 'tax', 'card', 'salary', 'jail fine'),
     * a moneyMoved event is emitted for UI notifications.
     */
    pay(state, fromId, toId, amount, reason) {
        if (fromId !== null) state.players[fromId].cash -= amount;
        if (toId !== null) state.players[toId].cash += amount;
        // Free Parking jackpot: money paid TO the bank (toId === null) collects
        // in the pot. 'classic' scope takes only penalties (tax, jail fine, card
        // payments — all of which pass a reason); 'all' takes every bank payment
        // (property purchases, building, unmortgaging — which pass no reason).
        else if (amount > 0 && state.rules && state.rules.freeParking) {
            const CLASSIC_REASONS = { tax: 1, 'jail fine': 1, card: 1 };
            if (state.rules.freeParkingScope === 'all' || (reason && CLASSIC_REASONS[reason])) {
                state.freeParkingPot = (state.freeParkingPot || 0) + amount;
            }
        }
        if (reason && typeof EventBus !== 'undefined') {
            const info = id => id === null ? null :
                { name: state.players[id].name, isCPU: state.players[id].isCPU };
            EventBus.emit('moneyMoved', { from: info(fromId), to: info(toId), amount, reason });
        }
    },

    /**
     * opts.detail marks a supporting line: never announced, shown quietly.
     * opts.cat pins the log-filter category (e.g. 'ai' for CPU reasoning
     * traces) instead of letting the UI infer it from the text; it is kept in
     * the persisted history record too, so game-review tooling can select it.
     */
    addLog(state, text, opts) {
        const entry = { turn: state.turnNumber, text: text };
        if (opts && opts.detail) entry.detail = true;
        if (opts && opts.cat) entry.cat = opts.cat;
        state.log.push(entry);
        state.logCount = (state.logCount || 0) + 1;
        if (state.log.length > GAME_CONST.LOG_CAP) {
            state.log.splice(0, state.log.length - GAME_CONST.LOG_CAP);
        }
    },

    /** Draw the top card id, recycling it to the bottom (jail cards handled by caller). */
    drawCard(state, deckName) {
        const deck = state.decks[deckName];
        const cardId = deck.shift();
        const all = deckName === 'chance' ? CHANCE_CARDS : COMMUNITY_CARDS;
        const card = all.find(c => c.id === cardId);
        if (card.effect.type !== 'getOutOfJail') {
            deck.push(cardId); // jail cards leave the deck while held
        }
        return card;
    },

    /** Delayed-buy house rule: first pass/landing on GO by anyone opens the market. */
    unlockBuying(state) {
        if (state.buyingUnlocked !== false) return;
        state.buyingUnlocked = true;
        this.addLog(state, 'A lap is complete — properties may now be bought.');
    },

    /** Return a held Get Out of Jail Free card to the bottom of its deck. */
    returnJailCard(state, playerId) {
        const player = state.players[playerId];
        player.getOutCards -= 1;
        if (state.decks.chanceJailCardHeldBy === playerId) {
            state.decks.chanceJailCardHeldBy = null;
            state.decks.chance.push('ch8');
        } else if (state.decks.communityJailCardHeldBy === playerId) {
            state.decks.communityJailCardHeldBy = null;
            state.decks.community.push('cc5');
        }
    }
};

if (typeof window !== 'undefined') {
    window.GameState = GameState;
}
