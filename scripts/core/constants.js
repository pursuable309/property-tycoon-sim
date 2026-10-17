/**
 * Core: Constants
 *
 * Shared enums, storage keys, and a minimal event bus.
 *
 * Exports:
 *   - window.STORAGE_KEYS
 *   - window.GamePhase
 *   - window.GROUP_META
 *   - window.EventBus
 *   - window.GAME_CONST
 */

const STORAGE_KEYS = {
    SAVE: 'monopoly_save_v1',
    SETTINGS: 'monopoly_settings',
    STATS: 'monopoly_stats',
    HISTORY_INDEX: 'monopoly_history_v1',      // ids of records not yet flushed to the server
    HISTORY_GAME_PREFIX: 'monopoly_history_game_', // + gameId -> buffered record
    AI_TUNING: 'monopoly_ai_tuning'               // sparse AITuning overrides
};

const GamePhase = {
    AWAIT_PREROLL: 'AWAIT_PREROLL',       // current player may manage properties / trade / roll
    AWAIT_JAIL_CHOICE: 'AWAIT_JAIL_CHOICE',
    AWAIT_ROLL: 'AWAIT_ROLL',             // legacy alias of AWAIT_PREROLL roll step (kept for saves)
    AWAIT_DECISION: 'AWAIT_DECISION',     // pendingAction holds what is owed (e.g. buy-or-auction)
    AUCTION_IN_PROGRESS: 'AUCTION_IN_PROGRESS',
    TRADE_PENDING: 'TRADE_PENDING',
    DEBT_SETTLEMENT: 'DEBT_SETTLEMENT',
    AWAIT_ENDTURN: 'AWAIT_ENDTURN',
    GAME_OVER: 'GAME_OVER'
};

const GAME_CONST = {
    STARTING_CASH: 1500,
    GO_SALARY: 200,
    JAIL_FINE: 50,
    JAIL_TILE: 10,
    GO_TO_JAIL_TILE: 30,
    MAX_JAIL_TURNS: 3,
    BANK_HOUSES: 32,
    BANK_HOTELS: 12,
    MORTGAGE_INTEREST: 0.10,
    LOG_CAP: 200,
    MAX_PLAYERS: 8
};

const GROUP_META = {
    brown:     { color: '#8B4513', size: 2, label: 'Brown' },
    lightblue: { color: '#87CEEB', size: 3, label: 'Light Blue' },
    pink:      { color: '#D93A96', size: 3, label: 'Pink' },
    orange:    { color: '#F7941D', size: 3, label: 'Orange' },
    red:       { color: '#ED1B24', size: 3, label: 'Red' },
    yellow:    { color: '#FEF200', size: 3, label: 'Yellow' },
    green:     { color: '#1FB25A', size: 3, label: 'Green' },
    darkblue:  { color: '#0072BB', size: 2, label: 'Dark Blue' },
    railroad:  { color: '#444444', size: 4, label: 'Railroad' },
    utility:   { color: '#9E9E9E', size: 2, label: 'Utility' }
};

/* Minimal pub/sub used by the turn engine to notify UI renderers. */
const EventBus = {
    _handlers: {},
    // Muted during DEV.simulate: headless engines share this bus, and the
    // game-UI handlers assume window.engine points at the emitting game.
    muted: false,
    on(event, fn) {
        (this._handlers[event] = this._handlers[event] || []).push(fn);
    },
    off(event, fn) {
        this._handlers[event] = (this._handlers[event] || []).filter(h => h !== fn);
    },
    emit(event, payload) {
        if (this.muted) return;
        (this._handlers[event] || []).forEach(fn => {
            try { fn(payload); } catch (e) { console.error(`EventBus handler error for "${event}":`, e); }
        });
    }
};

if (typeof window !== 'undefined') {
    window.STORAGE_KEYS = STORAGE_KEYS;
    window.GamePhase = GamePhase;
    window.GAME_CONST = GAME_CONST;
    window.GROUP_META = GROUP_META;
    window.EventBus = EventBus;
}
