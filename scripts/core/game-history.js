/**
 * Core: Game History
 *
 * Records every persisted game for post-game analysis of CPU decision making
 * (property purchases, cash management, trading). Unlike the in-game log
 * (capped at LOG_CAP entries), history keeps the FULL log, plus per-turn
 * financial snapshots and structured trade records.
 *
 * Storage: all-time archive lives on disk as history/<gameId>.json, written
 * via POST /api/history (server.py). localStorage is only a write buffer for
 * games not yet flushed to the server (offline play, server hiccups):
 *   - STORAGE_KEYS.HISTORY_INDEX: ids of buffered records
 *   - STORAGE_KEYS.HISTORY_GAME_PREFIX + gameId: buffered record
 * Once a finished/abandoned record reaches the server, its buffer is deleted.
 *
 * Hooked in from GameState.save(), so only persisted games are recorded
 * (DEV.simulate uses persist:false and never touches history).
 *
 * Analysis (console): await GameHistory.list() / .get(id) / .exportAll()
 *
 * Dependencies: constants.js, storage.js, rules-engine.js (netWorth)
 * Exports: window.GameHistory
 */

const GameHistory = {

    _lastPushedTurn: {},   // gameId -> turn number of the last server push
    _commit: null,         // git HEAD of the served code, fetched on page load

    /** Ask the server which git commit is being served, for record stamping. */
    fetchCommit() {
        if (typeof fetch === 'undefined') return Promise.resolve(null);
        return fetch('/api/version')
            .then(res => res.ok ? res.json() : null)
            .then(v => (this._commit = (v && v.commit) || null))
            .catch(() => null); // offline - records go out without a commit
    },

    /** 'YYYY-MM-DD hh:mm:ss' in local time. */
    timestamp(date) {
        const d = date || new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },

    _gameKey(id) {
        return STORAGE_KEYS.HISTORY_GAME_PREFIX + id;
    },

    /**
     * Bring the history record for this state up to date. Called after every
     * committed action (from GameState.save), so it must stay cheap: appends
     * new log entries, snapshots once per turn, and finalizes on game over.
     */
    sync(state) {
        if (!state.gameId) {
            // Save predates history tracking - adopt it mid-game
            state.gameId = `${Date.now().toString(36)}-${(state.seed >>> 0).toString(36)}`;
            state.logCount = state.log.length;
        }

        let record = StorageManager.get(this._gameKey(state.gameId), null);
        if (!record) {
            // A finished game with no buffer was already archived - never
            // rebuild a fresh (truncated) record over it
            if (state.phase === GamePhase.GAME_OVER) return;
            record = this._begin(state);
        }
        if (record.finished) return; // GAME_OVER already recorded

        // Backfill the code version if _begin ran before /api/version answered
        if (!record.commit && this._commit) record.commit = this._commit;

        // Player info can change after creation (personalities assigned by AI)
        record.players = state.players.map(p => ({
            id: p.id,
            name: p.name,
            token: p.token,
            isCPU: p.isCPU,
            difficulty: p.isCPU ? p.difficulty : undefined,
            personality: (p.isCPU && p.personality) ? p.personality.archetype : undefined,
            // The rest of the personality (per-colour valuation bias and the
            // seed that drew it) so decision replays can rebuild the exact CPU
            // instead of assuming neutral colour bias.
            groupBias: (p.isCPU && p.personality && p.personality.groupBias) ? p.personality.groupBias : undefined,
            noiseSeed: (p.isCPU && p.personality) ? p.personality.noiseSeed : undefined
        }));

        // Append log entries added since the last sync. state.log is capped,
        // so entries older than LOG_CAP only survive here.
        const logCount = state.logCount || state.log.length;
        const newEntries = logCount - (record.logCount || 0);
        if (newEntries > 0) {
            record.log.push(...state.log.slice(-Math.min(newEntries, state.log.length)));
            record.logCount = logCount;
        }

        // One financial snapshot per turn (taken at the first action of it)
        if (record.lastSnapTurn !== state.turnNumber) {
            record.lastSnapTurn = state.turnNumber;
            record.snapshots.push({
                turn: state.turnNumber,
                players: state.players.map(p => ({
                    cash: p.cash,
                    netWorth: p.bankrupt ? 0 : Rules.netWorth(state, p.id),
                    properties: GameState.propertiesOf(state, p.id).length,
                    bankrupt: p.bankrupt || undefined
                }))
            });
        }

        // Structured trades accumulated in state by Trading.apply
        if (state.trades && state.trades.length > (record.trades || []).length) {
            record.trades = state.trades.slice();
        }

        // Trade settings live outside state (Settings modal -> DEV.*) and can
        // change mid-game; keep the latest plus a change trail for reviews
        const settings = this._tradeSettings();
        if (!record.settings) {
            record.settings = settings;
        } else if (settings.tradeActivity !== record.settings.tradeActivity ||
                   settings.tradeFlex !== record.settings.tradeFlex ||
                   settings.cpuCounters !== record.settings.cpuCounters) {
            (record.settingsChanges = record.settingsChanges || [])
                .push({ turn: state.turnNumber, ...settings });
            record.settings = settings;
        }

        record.turns = state.turnNumber;
        if (state.phase === GamePhase.GAME_OVER) {
            record.finished = true;
            record.endedAt = this.timestamp();
            record.winner = state.winner !== null ? {
                id: state.winner,
                name: state.players[state.winner].name
            } : null;
            // Auto-queue the finished game for Claude review (the review-games
            // skill finds the queue via `grep -l reviewRequested history/*.json`).
            // Idempotent: don't re-queue an already-queued or Claude-reviewed game.
            if (!record.reviewRequested && !(record.review && record.review.engine === 'claude')) {
                record.reviewRequested = this.timestamp();
            }
        }

        StorageManager.set(this._gameKey(state.gameId), record);
        this._trackBuffered(record.id);

        // Push to the server at most once per turn, plus the final state
        if (record.finished || this._lastPushedTurn[record.id] !== record.turns) {
            this._lastPushedTurn[record.id] = record.turns;
            this._push(record);
        }
    },

    /** Bot trade settings in effect (Settings modal -> DEV.*), with the same
     *  fallbacks CPUPlayer._tradeConfig uses for headless runs. */
    _tradeSettings() {
        const dev = (typeof window !== 'undefined' && window.DEV) || {};
        return {
            tradeActivity: dev.tradeActivity || 'normal',
            tradeFlex: dev.tradeFlex || 'fair',
            cpuCounters: dev.cpuCounters !== undefined ? !!dev.cpuCounters : true
        };
    },

    /** Create a fresh record and retire stale unfinished ones. */
    _begin(state) {
        // A single save slot means any older unfinished game can never resume
        const ids = StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, []);
        ids.forEach(id => {
            if (id === state.gameId) return;
            const rec = StorageManager.get(this._gameKey(id), null);
            if (rec && !rec.finished && !rec.abandoned) {
                rec.abandoned = true;
                rec.endedAt = this.timestamp();
                StorageManager.set(this._gameKey(id), rec);
            }
        });
        this.flush();

        return {
            id: state.gameId,
            startedAt: this.timestamp(state.createdAt ? new Date(state.createdAt) : undefined),
            endedAt: null,
            finished: false,
            abandoned: false,
            seed: state.seed,
            commit: this._commit,
            rules: { ...state.rules },
            tuning: { ...(state.tuning || {}) },
            settings: this._tradeSettings(),
            players: [],
            winner: null,
            turns: state.turnNumber,
            lastSnapTurn: null,
            logCount: 0,
            log: [],
            snapshots: [],
            trades: []
        };
    },

    _trackBuffered(id) {
        const ids = StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, []);
        if (!ids.includes(id)) {
            ids.push(id);
            StorageManager.set(STORAGE_KEYS.HISTORY_INDEX, ids);
        }
    },

    _dropBuffered(id) {
        StorageManager.remove(this._gameKey(id));
        const ids = StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, [])
            .filter(x => x !== id);
        StorageManager.set(STORAGE_KEYS.HISTORY_INDEX, ids);
    },

    /**
     * Send a record to the server archive (fire-and-forget). Terminal records
     * (finished/abandoned) release their localStorage buffer on success; the
     * in-progress game keeps its buffer so resume-after-reload still appends.
     */
    _push(record) {
        if (typeof fetch === 'undefined') return Promise.resolve(false);
        return fetch('/api/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        }).then(res => {
            if (res.ok && (record.finished || record.abandoned)) {
                this._dropBuffered(record.id);
            }
            return res.ok;
        }).catch(() => false); // offline - buffer stays, retried by flush()
    },

    /** Retry pushing every buffered record (called on boot and new game). */
    flush() {
        const ids = StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, []);
        ids.forEach(id => {
            const rec = StorageManager.get(this._gameKey(id), null);
            if (rec) this._push(rec); else this._dropBuffered(id);
        });
    },

    /* ==================== ANALYSIS API (console) ==================== */

    /** Summaries of all archived games plus unflushed buffered ones. */
    async list() {
        let server = [];
        try {
            const res = await fetch('/api/history');
            if (res.ok) server = await res.json();
        } catch (e) { /* offline */ }
        const seen = new Set(server.map(s => s.id));
        StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, []).forEach(id => {
            if (seen.has(id)) return;
            const rec = StorageManager.get(this._gameKey(id), null);
            if (rec) server.push(this.summarize(rec));
        });
        return server.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    },

    /**
     * Persist a modified record (review results, review requests). Also
     * refreshes any localStorage buffer for it so a later flush() cannot
     * resurrect a copy without the changes. Only call on terminal records
     * (finished/abandoned) - an in-progress game re-pushes its own buffer
     * every turn and would overwrite this.
     */
    async saveRecord(record) {
        if (StorageManager.get(this._gameKey(record.id), null)) {
            StorageManager.set(this._gameKey(record.id), record);
        }
        return await this._push(record);
    },

    /**
     * Attach/update the free-text note on a record (status bar 📝 button for
     * the live game, History tab for archived ones). Considered by the
     * review-games skill per REVIEWS.md. Works on in-progress records too -
     * unlike review results, a note isn't gated to finished/abandoned games.
     */
    async setNote(gameId, note) {
        const record = await this.get(gameId);
        if (!record) return false;
        record.note = note;
        return await this.saveRecord(record);
    },

    /** Delete a game from the archive (server file + any local buffer). */
    async delete(gameId) {
        let ok = false;
        try {
            const res = await fetch(`/api/history/${encodeURIComponent(gameId)}`, { method: 'DELETE' });
            ok = res.ok;
        } catch (e) { /* offline - still drop the buffer */ }
        this._dropBuffered(gameId);
        return ok;
    },

    /** Full record (log, snapshots, trades) for one game. */
    async get(gameId) {
        const local = StorageManager.get(this._gameKey(gameId), null);
        if (local) return await this._rehydrateLog(local);
        try {
            const res = await fetch(`/history/${gameId}.json`);
            return res.ok ? await this._rehydrateLog(await res.json()) : null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Claude-reviewed records store their uncapped log gzip+base64-compressed in
     * `logGz` instead of `log` (see server.py pack_log_record / REVIEWS.md).
     * Decode it back to a plain `record.log` so every reader (_keyEvents etc.)
     * is oblivious to the compression. No-op when the log is already plain,
     * absent, or DecompressionStream is unavailable — the log only feeds
     * cosmetic extras (Free Parking chart markers), so failing soft is fine.
     */
    async _rehydrateLog(record) {
        if (!record || Array.isArray(record.log) || !record.logGz) return record;
        if (typeof DecompressionStream === 'undefined') return record;
        try {
            const bytes = Uint8Array.from(atob(record.logGz), c => c.charCodeAt(0));
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            record.log = JSON.parse(await new Response(stream).text());
            delete record.logGz;
        } catch (e) { /* leave logGz as-is; log-derived extras just won't show */ }
        return record;
    },

    /** Every full record - feed this to analysis tooling. */
    async exportAll() {
        const entries = await this.list();
        const records = await Promise.all(entries.map(e => this.get(e.id)));
        return records.filter(r => r !== null);
    },

    /** Download the entire history as one JSON file. */
    async download() {
        const blob = new Blob([JSON.stringify(await this.exportAll(), null, 2)],
            { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `monopoly-history-${this.timestamp().replace(/[: ]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    },

    summarize(record) {
        return {
            id: record.id,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
            finished: record.finished,
            abandoned: record.abandoned,
            numPlayers: record.players.length,
            players: record.players.map(p =>
                p.isCPU ? `${p.name} (CPU d${p.difficulty}${p.personality ? '/' + p.personality : ''})`
                        : `${p.name} (human)`),
            winner: record.winner ? record.winner.name : null,
            turns: record.turns,
            rules: record.rules || null,
            commit: record.commit || null,
            note: record.note || null,
            reviewRequested: record.reviewRequested || null,
            // Same projection server.py uses for its listing
            review: record.review ? {
                engine: record.review.engine,
                version: record.review.version,
                reviewedAt: record.review.reviewedAt,
                recommendations: record.review.recommendations || []
            } : null
        };
    }
};

if (typeof window !== 'undefined') {
    window.GameHistory = GameHistory;
    // Retry any records left unflushed by an offline session
    window.addEventListener('load', () => {
        GameHistory.fetchCommit();
        GameHistory.flush();
    });
}
