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
                if (seat.humanProxy) player.humanProxy = true; // E54 clone standing in for a human
                if (seat.cloneSeat) player.cloneSeat = true;   // "Clone of T" seat in a real game (a CPU to the others)
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

    /* ==================== SAVE STATES ==================== */

    // Slots beside the autosave, each a full copy of a state (so it replays
    // exactly: same RNG position). Two kinds:
    //   'save'   a snapshot (Save now); loading it starts a copy of the game
    //   'paused' a whole game set aside to start or resume another; loading
    //            it moves the game back to the live slot, same gameId, and
    //            its history record stays open (GameHistory never abandons it)
    // The index holds metadata only (cheap to list); each state has its own key.
    MAX_SLOTS: 10,   // snapshots; pausing a game is never refused for room

    listSlots() {
        const list = StorageManager.get(STORAGE_KEYS.SLOTS, []);
        return Array.isArray(list) ? list.filter(m => m && typeof m.id === 'string') : [];
    },

    /** Snapshots (kind 'save') or paused games (kind 'paused'). */
    slotsOfKind(kind) {
        return this.listSlots().filter(m => (m.kind || 'save') === kind);
    },

    /** Copy a live game into a new slot. opts.kind 'paused' sets the game
     *  aside (no cap). -> { ok, slot } or { ok: false, reason } */
    saveSlot(state, opts) {
        const kind = opts && opts.kind === 'paused' ? 'paused' : 'save';
        if (!state || state.version !== 1 || state.phase === GamePhase.GAME_OVER) {
            return { ok: false, reason: 'No game in progress to save' };
        }
        const slots = this.listSlots();
        if (kind === 'save' && this.slotsOfKind('save').length >= this.MAX_SLOTS) {
            return { ok: false, reason: `All ${this.MAX_SLOTS} slots are full — delete one first` };
        }
        let id = Date.now().toString(36);
        while (slots.some(m => m.id === id)) id += 'x';
        const mover = state.players[state.currentPlayer] || {};
        const slot = {
            id,
            kind,
            savedAt: new Date().toISOString(),
            gameId: state.gameId || null,
            turn: state.turnNumber,
            mover: mover.name || '?',
            players: state.players.map(p => ({ id: p.id, name: p.name, token: p.token, out: !!p.bankrupt }))
        };
        if (!StorageManager.set(STORAGE_KEYS.SLOT_PREFIX + id, state)) {
            return { ok: false, reason: 'Not enough storage for another save' };
        }
        slots.unshift(slot);
        if (!StorageManager.set(STORAGE_KEYS.SLOTS, slots)) {
            StorageManager.remove(STORAGE_KEYS.SLOT_PREFIX + id);
            return { ok: false, reason: 'Not enough storage for another save' };
        }
        return { ok: true, slot };
    },

    /**
     * A slot's state, ready to become the live game, or null. A paused game
     * comes back as it was. A snapshot gets a new gameId so its history is a
     * record of its own (marked restoredFrom): continuing under the old id
     * would splice two timelines into one record, or rebuild an
     * already-archived finished game from scratch.
     */
    restoreSlot(id) {
        const slot = this.listSlots().find(m => m.id === id);
        const state = slot ? StorageManager.get(STORAGE_KEYS.SLOT_PREFIX + id, null) : null;
        if (!state || state.version !== 1 || !Array.isArray(state.players)) return null;
        if (slot.kind === 'paused') return state;
        state.restoredFrom = { gameId: state.gameId || null, turn: state.turnNumber, savedAt: slot.savedAt };
        state.gameId = `${Date.now().toString(36)}-${(state.seed >>> 0).toString(36)}`;
        state.createdAt = new Date().toISOString();
        return state;
    },

    /** gameIds of the paused games (their history records stay open). */
    pausedGameIds() {
        return this.slotsOfKind('paused').map(m => m.gameId).filter(Boolean);
    },

    /**
     * Make a slot the live game. The game in progress, if any, is paused
     * first, unless the slot is a snapshot of that same game (a rewind: the
     * later position is dropped and stays in History as abandoned).
     * -> { ok, state, paused (slot or null) } or { ok: false, reason }
     */
    switchToSlot(id) {
        const slot = this.listSlots().find(m => m.id === id);
        const target = slot && this.restoreSlot(id);
        if (!target) return { ok: false, reason: 'That save could not be read' };
        const live = this.load();
        let paused = null;
        if (live && live.phase !== GamePhase.GAME_OVER && !(slot.kind === 'save' && live.gameId === slot.gameId)) {
            const res = this.saveSlot(live, { kind: 'paused' });
            if (!res.ok) return res;
            paused = res.slot;
        }
        if (!this.save(target)) {
            if (paused) this.deleteSlot(paused.id);
            return { ok: false, reason: 'Not enough storage to load that game' };
        }
        if (slot.kind === 'paused') this.deleteSlot(id);
        return { ok: true, state: target, paused };
    },

    /** Set the game in progress aside (Start Game → Pause & start). */
    pauseLive() {
        const live = this.load();
        if (!live || live.phase === GamePhase.GAME_OVER) return { ok: true, slot: null };
        const res = this.saveSlot(live, { kind: 'paused' });
        if (res.ok) this.clearSave();
        return res;
    },

    deleteSlot(id) {
        StorageManager.remove(STORAGE_KEYS.SLOT_PREFIX + id);
        return StorageManager.set(STORAGE_KEYS.SLOTS, this.listSlots().filter(m => m.id !== id));
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
        // a plain scan in id order (same list as filtering and sorting the keys): this
        // runs millions of times inside a d5 lookahead decision
        const owned = [];
        for (let id = 0; id < BOARD.length; id++) {
            const ts = state.tiles[id];
            if (ts && ts.owner === playerId) owned.push(id);
        }
        return owned;
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
        // CPU reasoning lines: the catalogued efforts (docs/ai/) that changed the decision (CPUPlayer._fire)
        if (opts && opts.levers && opts.levers.length) entry.levers = opts.levers;
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
