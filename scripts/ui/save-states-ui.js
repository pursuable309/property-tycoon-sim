/**
 * UI: Save states and paused games
 *
 * A sheet listing the slots (GameState.saveSlot / switchToSlot): paused
 * games (set aside to play another, Resume) and save states (snapshots made
 * with Save now, Load). Loading never loses the game in progress: it is
 * paused first, except when the save is an earlier point of that same game
 * (a rewind, confirmed). Loading mid-game reloads the page with LOAD_KEY set
 * and boot (main.js) finishes it, so no timer of the running engine can
 * autosave over the loaded game. Player names are user text: textContent only.
 *
 * SaveStatesUI.open({ inGame, onClose })
 * SaveStatesUI.loadPending()        -> boot: finish a load asked for before a reload
 * SaveStatesUI.row(slot, opts)      -> one slot's row (also the home screen's paused list)
 *
 * Exports: window.SaveStatesUI
 */

const SaveStatesUI = {

    LOAD_KEY: 'pt_load_slot',

    open(opts) {
        opts = opts || {};
        const body = document.createElement('div');
        body.className = 'saves';
        const refill = () => this._fill(body, opts, refill);
        refill();

        const buttons = [{ label: 'Close', class: 'btn-secondary', onClick: () => { if (opts.onClose) opts.onClose(); } }];
        const state = opts.inGame && window.engine && engine.state;
        if (state && state.phase !== GamePhase.GAME_OVER) {
            buttons.push({ label: '💾 Save now', class: 'btn-primary', keepOpen: true, onClick: () => {
                const res = GameState.saveSlot(engine.state);
                if (res.ok) showNotification(`Saved turn ${res.slot.turn}`, 'success');
                else showNotification(res.reason, 'error');
                refill();
            } });
        }
        Modals.show({ title: 'Save states', body, buttons });
    },

    _fill(body, opts, refill) {
        body.textContent = '';
        const liveId = this._live(opts) ? this._live(opts).gameId : null;
        const paused = GameState.slotsOfKind('paused');
        const saves = GameState.slotsOfKind('save');
        const rowOpts = Object.assign({}, opts, { liveId, onDeleted: refill });
        if (paused.length) {
            body.appendChild(this._el('div', 'eyebrow saves-head', 'Paused games'));
            paused.forEach(slot => body.appendChild(this.row(slot, rowOpts)));
            body.appendChild(this._el('div', 'eyebrow saves-head', 'Save states'));
        }
        body.appendChild(this._el('p', 'saves-intro', saves.length
            ? `${saves.length} of ${GameState.MAX_SLOTS} used. A save plays on exactly as it was, dice included.`
            : (opts.inGame ? 'None yet. Save now keeps this exact position to come back to.'
                : 'None yet. Save from a game: Settings → Saves.')));
        saves.forEach(slot => body.appendChild(this.row(slot, rowOpts)));
    },

    _el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    },

    /** The game in progress: the running one in a game, else the autosave. */
    _live(opts) {
        const s = opts.inGame && window.engine ? engine.state : GameState.load();
        return s && s.phase !== GamePhase.GAME_OVER ? s : null;
    },

    /** One slot: title, when + who's left, tokens; delete (two taps) and
     *  Resume / Load. opts: inGame, liveId, onDeleted, onClose. */
    row(slot, opts) {
        const el = this._el.bind(this);
        const isPaused = slot.kind === 'paused';
        const row = el('div', 'save-row' + (isPaused ? ' is-paused' : ''));
        const info = row.appendChild(el('div', 'save-info'));
        info.appendChild(el('div', 'save-title', `Turn ${Number(slot.turn) || 0} · ${slot.mover || '?'}'s move`));
        const players = slot.players || [];
        const left = players.filter(p => !p.out).length;
        info.appendChild(el('div', 'save-sub',
            `${isPaused ? 'Paused' : 'Saved'} ${SetupUI._ago(slot.savedAt)} · ${left} of ${players.length} left` +
            (opts.liveId && slot.gameId === opts.liveId ? ' · this game' : '')));

        const tokens = row.appendChild(el('div', 'continue-tokens save-tokens'));
        const colors = BoardRenderer.TOKEN_COLORS || BoardRenderer.COLORS_DEFAULT;
        players.forEach(p => {
            const t = tokens.appendChild(el('span', 'continue-token' + (p.out ? ' is-out' : ''),
                BoardRenderer.TOKEN_ICONS[p.token] || '●'));
            t.style.setProperty('--c', colors[p.id % colors.length]);
            t.title = String(p.name || '');
        });

        const actions = row.appendChild(el('div', 'save-actions'));
        const del = actions.appendChild(el('button', 'btn btn-quiet btn-sm save-del'));
        del.type = 'button';
        del.innerHTML = Icons.svg('trash');    // static icon markup
        del.setAttribute('aria-label', isPaused ? 'Discard paused game' : 'Delete save');
        Modals.armConfirm(del, isPaused ? 'Discard?' : 'Delete?', () => {
            GameState.deleteSlot(slot.id);
            // A discarded paused game is over for good
            if (isPaused && slot.gameId && typeof GameHistory !== 'undefined') GameHistory.abandon(slot.gameId);
            if (opts.onDeleted) opts.onDeleted();
        });
        const load = actions.appendChild(el('button', 'btn btn-primary btn-sm'));
        load.type = 'button';
        Icons.label(load, isPaused ? '▶ Resume' : '▶ Load');
        load.addEventListener('click', () => this._confirmLoad(slot, opts));
        return row;
    },

    /** Only a rewind (an earlier save of the game in progress) asks first:
     *  anything else pauses the game in progress, so nothing is lost. */
    _confirmLoad(slot, opts) {
        const live = this._live(opts);
        const go = () => this._load(slot.id, opts);
        if (!live || slot.kind === 'paused' || live.gameId !== slot.gameId) { go(); return; }
        const body = document.createElement('div');
        body.appendChild(this._el('p', '',
            `Go back to turn ${Number(slot.turn) || 0} · ${slot.mover || '?'}'s move?`));
        body.appendChild(this._el('p', '',
            `This game's later play (now turn ${Number(live.turnNumber) || 0}) is dropped: ` +
            'it stays in History as abandoned, and the game goes on as a new record.'));
        Modals.show({
            title: 'Go back?',
            body,
            buttons: [
                { label: 'Cancel', class: 'btn-secondary', onClick: () => this.open(opts) },
                { label: '↩ Go back', class: 'btn-primary', onClick: go }
            ]
        });
    },

    _load(id, opts) {
        if (opts.inGame) {
            // Restart the page first: the running engine's timers could
            // otherwise autosave the old game over the loaded one.
            try {
                sessionStorage.setItem(this.LOAD_KEY, id);
            } catch (e) {
                showNotification('Could not load: browser storage is blocked', 'error');
                return;
            }
            location.reload();
            return;
        }
        this._restore(id);
    },

    /** Boot: finish a load asked for before the reload. */
    loadPending() {
        let id = null;
        try {
            id = sessionStorage.getItem(this.LOAD_KEY);
            if (id) sessionStorage.removeItem(this.LOAD_KEY);
        } catch (e) { return; }
        if (id) this._restore(id);
    },

    _restore(id) {
        const res = GameState.switchToSlot(id);
        if (!res.ok) {
            showNotification(res.reason, 'error');
            if (typeof SetupUI !== 'undefined') SetupUI._renderContinue();
            return;
        }
        if (resumeGame()) {
            showNotification(res.paused
                ? `Paused the turn ${res.paused.turn} game — resume it from the home screen`
                : `Loaded turn ${res.state.turnNumber}`, 'success');
        }
    }
};

if (typeof window !== 'undefined') {
    window.SaveStatesUI = SaveStatesUI;
}
