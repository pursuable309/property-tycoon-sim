/**
 * UI: Play section (the home screen)
 *
 * - Continue card: a saved game in progress (turn, whose move, when saved)
 *   with Continue / Discard. Starting a new game over it asks first.
 * - Seats: up to 8 rows; only filled seats show. Each is Human / CPU with a
 *   name, a token (tap for the swatch grid; picking a taken token swaps it),
 *   and for CPUs a 1-5 difficulty pill row and a personality. ✕ removes a
 *   seat (2 minimum), "+ Add player" brings back the next free one as a CPU.
 * - The lineup and house rules are remembered (STORAGE_KEYS.SETUP) and
 *   restored on the next visit; with nothing saved: seat 1 human with the
 *   top hat, seats 2-4 CPUs at difficulty 3 / 4 / 5.
 * - Settings (⚙) and Start Game sit in a bar pinned to the bottom.
 *
 * Exports: window.SetupUI
 */

const SetupUI = {

    PERSONALITIES: {
        random:     '🎲 Random',
        aggressive: 'Aggressive',
        hoarder:    'Hoarder',
        builder:    'Builder',
        trader:     'Trader',
        cautious:   'Cautious'
    },

    // Per-seat only (not in the bulk picker): the playable clones of T (E64), kept apart from the sims'
    // pinned benchmark. "Clone of T" plays like T (Personalities.CLONE_SEAT at d4); "strong" plays like T
    // in the games T wins (CLONE_SEAT_STRONG at d5: builds more readily, lookahead on). Both record
    // cloneSeat, so reviews, fits and the Stats clone filter treat them alike. The option reads
    // "T (strong)" so it fits the narrowest personality picker (internal 5-8 seats, ~89px).
    CLONE_OPTIONS: [['clone', '🧬 Clone of T'], ['clone-strong', '🧬 T (strong)']],
    _cloneSeat(key) {
        if (key === 'clone') return { version: Personalities.CLONE_SEAT || Personalities.CLONE_BENCHMARK, difficulty: Personalities.CLONE_SEAT_DIFFICULTY || 4 };
        if (key === 'clone-strong' && Personalities.CLONE_SEAT_STRONG) return { version: Personalities.CLONE_SEAT_STRONG, difficulty: Personalities.CLONE_SEAT_STRONG_DIFFICULTY || 5 };
        return null;
    },

    /** Badge text for a cloneSeat player (live state: personality {archetype}; history record: a string). */
    cloneLabel(p) {
        const v = p.personality && typeof p.personality === 'object' ? p.personality.archetype : p.personality;
        return v && v === Personalities.CLONE_SEAT_STRONG ? '🧬 Clone of T (strong)' : '🧬 Clone of T';
    },

    // House-rule toggles: [element id, saved key, title, hint]
    RULES: [
        ['setup-balanced-rents', 'balancedRents', 'Balanced rents', 'Every property earns the same return on its price'],
        ['setup-delayed-buy', 'delayedBuy', 'Opening lap', 'No buying until someone passes or lands on GO'],
        ['setup-free-parking', 'freeParking', 'Free Parking jackpot', 'Bank payments pile up; landing on Free Parking wins the pot'],
        ['setup-advanced-mortgage', 'advancedMortgage', 'Advanced mortgage transfers', 'Official rule: 10% fee when you receive a mortgaged deed, then 10% again to unmortgage']
    ],

    // sessionStorage flag set by Game Over → Rematch (read in main.js boot)
    REMATCH_KEY: 'pt_rematch',

    // Longest player name: 10 keeps a name whole in the seat cards, player
    // cards, feed and toasts on the smallest displays (was 14)
    NAME_MAX: 9,

    NAMES: [
        'Alex', 'Bailey', 'Casey', 'Dana', 'Ellis', 'Frankie', 'Gray', 'Harper',
        'Indie', 'Jules', 'Kit', 'Lane', 'Morgan', 'Noel', 'Oakley', 'Parker',
        'Quinn', 'Reese', 'Sage', 'Tate', 'Uma', 'Vic', 'Wren', 'Xen',
        'Yuri', 'Zane', 'Ash', 'Blair', 'Cameron', 'Devon', 'Emery', 'Finley',
        'Gale', 'Hollis', 'Ira', 'Jamie', 'Kai', 'Lennon', 'Marley', 'Nico'
    ],

    render() {
        this._renderContinue();

        const box = document.getElementById('setup-seats');
        box.innerHTML = '';
        const seats = this._initialSeats();

        // Players heading: count + one-tap randomize, then "apply to every CPU"
        const controls = document.createElement('div');
        controls.className = 'seat-controls';
        controls.innerHTML = `
            <div class="seat-controls-head">
                <h2 class="setup-h2">Players <span class="setup-count" id="setup-count"></span></h2>
                <button type="button" id="btn-randomize-seats" class="btn btn-quiet btn-sm">${Icons.svg('dice')} Randomize</button>
            </div>
            <div class="seat-bulk">
                <span class="seat-bulk-label">All CPUs</span>
                <select id="bulk-difficulty" aria-label="Set every CPU's difficulty">
                    <option value="">Difficulty</option>
                    ${[1, 2, 3, 4, 5].map(n => `<option value="${n}">Difficulty ${n}</option>`).join('')}
                </select>
                <select id="bulk-personality" aria-label="Set every CPU's personality">
                    <option value="">Personality</option>
                    ${Object.entries(this.PERSONALITIES).map(([v, label]) =>
                        `<option value="${v}">${label}</option>`).join('')}
                </select>
            </div>`;
        controls.querySelector('#bulk-difficulty').addEventListener('change', e => {
            if (!e.target.value) return;
            this._rows().forEach(row => {
                if (this._seatType(row) === 'cpu' && !this._isClone(row)) this._setDifficulty(row, e.target.value);
            });
            e.target.value = ''; // acts as a command, not a state
        });
        controls.querySelector('#bulk-personality').addEventListener('change', e => {
            if (!e.target.value) return;
            this._rows().forEach(row => {
                if (this._seatType(row) !== 'cpu') return;
                row.querySelector('.seat-personality').value = e.target.value;
                this._syncClone(row);
            });
            e.target.value = '';
        });
        controls.querySelector('#btn-randomize-seats').addEventListener('click', () => this._randomize());
        box.appendChild(controls);

        const list = document.createElement('div');
        list.className = 'seat-list';
        box.appendChild(list);
        seats.forEach((seat, i) => list.appendChild(this._seatRow(seat, i)));

        const add = document.createElement('button');
        add.type = 'button';
        add.id = 'btn-add-seat';
        add.className = 'seat-add';
        Icons.label(add, '＋ Add player');
        add.addEventListener('click', () => this._addSeat());
        list.appendChild(add);

        // House rules ride in the pinned bottom bar, above Settings + Start Game
        const actions = document.querySelector('#tab-setup .setup-actions');
        actions.querySelector('.setup-rules')?.remove();
        actions.prepend(this._rulesBlock());
        this._syncCount();

        const startBtn = document.getElementById('btn-start-game');
        if (!startBtn.querySelector('.icon')) startBtn.insertAdjacentHTML('afterbegin', Icons.svg('play') + ' ');
        startBtn.onclick = () => this._confirmStart();
        const settingsBtn = document.getElementById('btn-setup-settings');
        if (settingsBtn) {
            settingsBtn.innerHTML = Icons.svg('settings');
            settingsBtn.onclick = () => SettingsUI.open();
        }

        this._initTabs();
        if (window.LabUI) LabUI.startBadge();   // levers waiting / in the pipeline + games queued for review
    },

    /* ==================== Continue card ==================== */

    /** The saved game in progress, or null (none, or it already ended). */
    _savedGame() {
        const save = GameState.load();
        return save && save.phase !== GamePhase.GAME_OVER ? save : null;
    },

    _renderContinue() {
        const host = document.getElementById('setup-continue');
        if (!host) return;
        host.textContent = '';
        const save = this._savedGame();
        if (!save) { this._renderSlots(host); return; }

        const card = document.createElement('section');
        card.className = 'continue-card';
        card.setAttribute('aria-label', 'Game in progress');
        const top = card.appendChild(this._el('div', 'continue-top'));
        const info = top.appendChild(this._el('div', 'continue-info'));
        info.appendChild(this._el('div', 'eyebrow', 'Game in progress'));
        const mover = (save.players[save.currentPlayer] || {}).name || '?';
        info.appendChild(this._el('div', 'continue-title', `Turn ${save.turnNumber} · ${mover}'s move`));
        const alive = save.players.filter(p => !p.bankrupt).length;
        info.appendChild(this._el('div', 'continue-sub',
            `Saved ${this._ago(save.updatedAt)} · ${alive} of ${save.players.length} players left`));

        const tokens = top.appendChild(this._el('div', 'continue-tokens'));
        const colors = BoardRenderer.TOKEN_COLORS || BoardRenderer.COLORS_DEFAULT;
        save.players.forEach(p => {
            const t = tokens.appendChild(this._el('span', 'continue-token' + (p.bankrupt ? ' is-out' : ''),
                BoardRenderer.TOKEN_ICONS[p.token] || '●'));
            t.style.setProperty('--c', colors[p.id % colors.length]);
            t.title = p.name;
        });

        const actions = card.appendChild(this._el('div', 'continue-actions'));
        const discard = actions.appendChild(this._el('button', 'btn btn-quiet'));
        Icons.label(discard, '🗑 Discard');
        discard.type = 'button';
        discard.addEventListener('click', () => this._confirmDiscard(save, () => this._renderContinue()));
        const cont = actions.appendChild(this._el('button', 'btn btn-primary'));
        Icons.label(cont, '▶ Continue');
        cont.type = 'button';
        cont.addEventListener('click', () => resumeGame());
        host.appendChild(card);
        this._renderSlots(host);
    },

    /** Under the Continue card: the paused games (Resume pauses the game in
     *  progress in turn), then "Save states (N)" when there are any. */
    _renderSlots(host) {
        const rerender = () => this._renderContinue();
        const paused = GameState.slotsOfKind('paused');
        if (paused.length) {
            const box = host.appendChild(this._el('section', 'paused-games'));
            box.setAttribute('aria-label', 'Paused games');
            box.appendChild(this._el('div', 'eyebrow saves-head', `Paused games (${paused.length})`));
            paused.forEach(slot => box.appendChild(SaveStatesUI.row(slot, { onDeleted: rerender })));
        }
        const n = GameState.slotsOfKind('save').length;
        if (!n) return;
        const btn = host.appendChild(this._el('button', 'btn btn-quiet btn-sm saves-link'));
        btn.type = 'button';
        Icons.label(btn, `💾 Save states (${n})`);
        btn.addEventListener('click', () => SaveStatesUI.open({ onClose: rerender }));
    },

    /** "Discard saved game?" — the Continue card's Discard. */
    _confirmDiscard(save, then, startLabel) {
        Modals.show({
            title: 'Discard saved game?',
            body: `<p>Your game in progress (turn ${Number(save.turnNumber) || 0}) will be lost.</p>`,
            buttons: [
                { label: 'Cancel', class: 'btn-secondary' },
                { label: '🗑 ' + (startLabel || 'Discard'), class: 'btn-danger', onClick: () => {
                    GameState.clearSave();
                    then();
                } }
            ]
        });
    },

    /** "5 min ago" / "3 h ago" / a date, from an ISO string or epoch ms. */
    _ago(when) {
        const ms = typeof when === 'number' ? when : Date.parse(when);
        if (!ms) return 'earlier';
        const min = Math.round((Date.now() - ms) / 60000);
        if (min < 1) return 'just now';
        if (min < 60) return `${min} min ago`;
        if (min < 60 * 36) return `${Math.round(min / 60)} h ago`;
        const d = new Date(ms), p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },

    /* ==================== Seats ==================== */

    /** Eight seat specs: the remembered lineup if valid, else the defaults. */
    _initialSeats() {
        const tokens = Object.keys(BoardRenderer.TOKEN_ICONS);
        const saved = this._loadSetup();
        if (saved) return saved.seats;

        const names = this._shuffled(this.NAMES);
        const shuffledTokens = this._shuffled(tokens);
        // The default human seat always starts with the top hat
        const hatIdx = shuffledTokens.indexOf('hat');
        [shuffledTokens[0], shuffledTokens[hatIdx]] = [shuffledTokens[hatIdx], shuffledTokens[0]];
        return Array.from({ length: GAME_CONST.MAX_PLAYERS }, (_, i) => ({
            type: i === 0 ? 'human' : (i <= 3 ? 'cpu' : 'none'),
            name: i === 0 ? 'T' : names[i],
            token: shuffledTokens[i],
            difficulty: [3, 3, 4, 5][i] || 3,
            personality: 'random'
        }));
    },

    _seatRow(seat, i) {
        const row = document.createElement('div');
        row.className = 'seat-row';
        row.dataset.seat = i;
        const seatColors = BoardRenderer.TOKEN_COLORS || BoardRenderer.COLORS_DEFAULT;
        row.style.setProperty('--seat-accent', seatColors[i % seatColors.length]);
        const personalities = [...Object.entries(this.PERSONALITIES), ...this.CLONE_OPTIONS];

        row.innerHTML = `
            <div class="seat-head">
                <button type="button" class="seat-token-btn" aria-label="Seat ${i + 1} token"></button>
                <input class="seat-name" type="text" maxlength="${this.NAME_MAX}" placeholder="Name" aria-label="Seat ${i + 1} name">
                ${Segmented.html('seat-type-' + i,
                    [['human', '👤'], ['cpu', '🤖']], seat.type === 'cpu' ? 'cpu' : 'human',
                    `Seat ${i + 1}: human or CPU`, 'seat-type')}
                <button type="button" class="seat-remove" aria-label="Remove seat ${i + 1}" title="Remove">${Icons.svg('close')}</button>
            </div>
            <div class="seat-difficulty">
                ${Segmented.html('seat-diff-' + i, [1, 2, 3, 4, 5].map(n => [n, String(n)]), seat.difficulty,
                    `Seat ${i + 1} CPU difficulty`, 'seat-diff')}
                <select class="seat-personality" aria-label="Seat ${i + 1} CPU personality">
                    ${personalities.map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}
                </select>
            </div>`;
        row.querySelector('.seat-type .segmented-opt:first-child').title = 'Human';
        row.querySelector('.seat-type .segmented-opt:last-child').title = 'CPU';

        // User-controlled values go in through properties, never the template
        const tokenBtn = row.querySelector('.seat-token-btn');
        tokenBtn.dataset.token = seat.token;
        tokenBtn.textContent = BoardRenderer.TOKEN_ICONS[seat.token];
        row.querySelector('.seat-name').value = seat.name;
        row.querySelector('.seat-personality').value = seat.personality;
        row.dataset.empty = seat.type === 'none' ? '1' : '';

        row.querySelector('.seat-type').addEventListener('change', () => this._syncSeatState(row));
        row.querySelector('.seat-personality').addEventListener('change', () => this._syncClone(row));
        row.querySelector('.seat-remove').addEventListener('click', () => this._setSeatType(row, 'none'));
        tokenBtn.addEventListener('click', e => { e.stopPropagation(); this._openTokenGrid(tokenBtn); });

        this._syncSeatState(row);
        this._syncClone(row);
        return row;
    },

    _rows() { return [...document.querySelectorAll('#setup-seats .seat-row')]; },

    /** A seat row's type: 'none' (removed) | 'human' | 'cpu'. */
    _seatType(row) {
        if (row.dataset.empty) return 'none';
        return Segmented.value(row, 'seat-type-' + row.dataset.seat) || 'human';
    },

    _setSeatType(row, val) {
        if (val === 'none') {
            if (this._filled().length <= 2) return;   // the 2-seat minimum
            row.dataset.empty = '1';
            this._syncSeatState(row);
            return;
        }
        row.dataset.empty = '';
        Segmented.set(row, 'seat-type-' + row.dataset.seat, val); // fires change -> sync
        this._syncSeatState(row);
    },

    _filled() { return this._rows().filter(r => this._seatType(r) !== 'none'); },

    /** Reflect a seat's type in its classes and which fields show. */
    _syncSeatState(row) {
        const type = this._seatType(row);
        row.hidden = type === 'none';
        row.classList.toggle('is-cpu', type === 'cpu');
        row.classList.toggle('is-human', type === 'human');
        row.querySelector('.seat-difficulty').hidden = type !== 'cpu';
        this._syncCount();
    },

    /** Players count, start-bar label, ✕ / Add availability. */
    _syncCount() {
        const rows = this._rows();
        if (!rows.length) return;
        const n = this._filled().length;
        const count = document.getElementById('setup-count');
        if (count) count.textContent = String(n);
        const sub = document.querySelector('.btn-start-sub');
        if (sub) sub.textContent = `· ${n} players`;
        rows.forEach(r => { r.querySelector('.seat-remove').disabled = n <= 2; });
        const add = document.getElementById('btn-add-seat');
        if (add) add.hidden = n >= rows.length;
    },

    /** Bring back the first free seat as a CPU (difficulty 3, random personality). */
    _addSeat() {
        const row = this._rows().find(r => this._seatType(r) === 'none');
        if (!row) return;
        const taken = new Set(this._filled().map(r => r.querySelector('.seat-name').value.trim()));
        const name = this._shuffled(this.NAMES).find(n => !taken.has(n)) || '';
        row.querySelector('.seat-name').value = name;
        row.querySelector('.seat-personality').value = 'random';
        this._setDifficulty(row, 3);
        this._setSeatType(row, 'cpu');
        this._syncClone(row);
    },

    _isClone(row) { return !!this._cloneSeat(row.querySelector('.seat-personality').value); },

    _difficulty(row) { return Number(Segmented.value(row, 'seat-diff-' + row.dataset.seat)) || 3; },

    _setDifficulty(row, d) {
        const input = row.querySelector(`input[name="seat-diff-${row.dataset.seat}"][value="${Number(d)}"]`);
        if (input) input.checked = true;
    },

    /** A Clone of T seat plays at its calibrated difficulty: pin the pills
     *  there while it's picked, and free them when another is picked. */
    _syncClone(row) {
        const clone = this._cloneSeat(row.querySelector('.seat-personality').value), isClone = !!clone;
        if (isClone) this._setDifficulty(row, clone.difficulty);
        row.querySelectorAll('.seat-diff input').forEach(inp => { inp.disabled = isClone; });
        row.querySelector('.seat-diff').classList.toggle('is-locked', isClone);
    },

    /** Swatch-grid popover for picking a seat's token. Tokens stay unique:
     *  picking one held by another seat swaps the two seats' tokens. */
    _openTokenGrid(tokenBtn) {
        const reopening = this._tokenGridOwner === tokenBtn;
        this._closeTokenGrid();
        if (reopening) return; // a second tap on the same token just closes it

        const tokens = Object.keys(BoardRenderer.TOKEN_ICONS);
        const taken = {};
        this._filled().forEach(r => { taken[r.querySelector('.seat-token-btn').dataset.token] = true; });
        const current = tokenBtn.dataset.token;

        const grid = document.createElement('div');
        grid.className = 'token-grid';
        tokens.forEach(t => {
            const inUse = taken[t] && t !== current;
            const cell = document.createElement('button');
            cell.type = 'button';
            cell.className = 'token-cell' + (t === current ? ' is-current' : '') + (inUse ? ' is-taken' : '');
            cell.textContent = BoardRenderer.TOKEN_ICONS[t];
            cell.setAttribute('aria-label', t + (inUse ? ' (in use — will swap)' : ''));
            cell.addEventListener('click', () => { this._pickToken(tokenBtn, t); this._closeTokenGrid(); });
            grid.appendChild(cell);
        });
        tokenBtn.parentElement.appendChild(grid); // .seat-head is position:relative
        this._tokenGridOwner = tokenBtn;

        const onDoc = ev => {
            if (ev.type === 'keydown') { if (ev.key === 'Escape') this._closeTokenGrid(); return; }
            if (grid.contains(ev.target) || tokenBtn.contains(ev.target)) return;
            this._closeTokenGrid();
        };
        this._tokenGridCleanup = () => {
            grid.remove();
            document.removeEventListener('click', onDoc, true);
            document.removeEventListener('keydown', onDoc, true);
            this._tokenGridOwner = null;
            this._tokenGridCleanup = null;
        };
        // Registered next tick so the opening click doesn't immediately close it
        setTimeout(() => {
            document.addEventListener('click', onDoc, true);
            document.addEventListener('keydown', onDoc, true);
        }, 0);
    },

    _closeTokenGrid() { if (this._tokenGridCleanup) this._tokenGridCleanup(); },

    /** Give tokenBtn `picked`; any seat (shown or removed) holding it gets ours. */
    _pickToken(tokenBtn, picked) {
        const prev = tokenBtn.dataset.token;
        if (picked === prev) return;
        document.querySelectorAll('#setup-seats .seat-token-btn').forEach(other => {
            if (other !== tokenBtn && other.dataset.token === picked) {
                other.dataset.token = prev;
                other.textContent = BoardRenderer.TOKEN_ICONS[prev];
            }
        });
        tokenBtn.dataset.token = picked;
        tokenBtn.textContent = BoardRenderer.TOKEN_ICONS[picked];
    },

    /** Randomize the opponents: seat 1 human, seats 2..N CPUs (N random) at
     *  random difficulty, personality left on Random for the AI to assign. */
    _randomize() {
        const rows = this._rows();
        const total = 2 + Math.floor(Math.random() * (rows.length - 1)); // 2..MAX_PLAYERS seats
        const names = this._shuffled(this.NAMES);
        rows.forEach((row, i) => {
            const type = i === 0 ? 'human' : (i < total ? 'cpu' : 'none');
            row.dataset.empty = '';
            if (type === 'cpu') {
                row.querySelector('.seat-name').value = names[i];
                row.querySelector('.seat-personality').value = 'random';
                this._setDifficulty(row, 1 + Math.floor(Math.random() * 5));
                this._syncClone(row);
            }
            if (type === 'none') row.dataset.empty = '1';
            else Segmented.set(row, 'seat-type-' + row.dataset.seat, type);
            this._syncSeatState(row);
        });
        showNotification(`Randomized: ${total - 1} CPU opponent${total - 1 === 1 ? '' : 's'}`, 'info');
    },

    /* ==================== House rules ==================== */

    _rulesBlock() {
        const saved = (this._loadSetup() || {}).rules || {};
        const block = document.createElement('details');
        block.className = 'setup-rules';
        block.innerHTML = `
            <summary class="setup-rules-summary">
                <span class="setup-h2">House rules</span>
                <span class="setup-rules-state" id="setup-rules-state"></span>
            </summary>
            <div class="setup-rules-list">
                ${this.RULES.map(([id, , title, hint]) => `
                    <label class="settings-row setup-rule">
                        <span class="setup-rule-text"><strong>${title}</strong><small>${hint}</small></span>
                        <input type="checkbox" class="toggle" id="${id}">
                    </label>`).join('')}
                <label class="settings-row setup-subrule" id="setup-free-parking-scope-row" hidden>
                    <span>Pot collects</span>
                    <select id="setup-free-parking-scope">
                        <option value="classic">Fines &amp; taxes</option>
                        <option value="all">All bank payments</option>
                    </select>
                </label>
            </div>`;
        this.RULES.forEach(([id, key]) => { block.querySelector('#' + id).checked = !!saved[key]; });
        block.querySelector('#setup-free-parking-scope').value = saved.freeParkingScope === 'all' ? 'all' : 'classic';

        const fpToggle = block.querySelector('#setup-free-parking');
        const fpScopeRow = block.querySelector('#setup-free-parking-scope-row');
        const sync = () => {
            fpScopeRow.hidden = !fpToggle.checked;
            const on = this.RULES.filter(([id]) => block.querySelector('#' + id).checked).length;
            block.querySelector('#setup-rules-state').textContent = on ? `${on} on` : 'Standard';
        };
        block.addEventListener('change', sync);
        sync();
        return block;
    },

    /* ==================== Remembered setup ==================== */

    /** The saved lineup, validated field by field (it's localStorage: treat it
     *  as untrusted). Null if missing or unusable. */
    _loadSetup() {
        const raw = StorageManager.get(STORAGE_KEYS.SETUP, null);
        if (!raw || !Array.isArray(raw.seats) || raw.seats.length !== GAME_CONST.MAX_PLAYERS) return null;
        const tokens = Object.keys(BoardRenderer.TOKEN_ICONS);
        const personalities = [...Object.keys(this.PERSONALITIES), ...this.CLONE_OPTIONS.map(o => o[0])];
        const used = new Set();
        const seats = raw.seats.map(s => {
            s = s || {};
            const token = tokens.includes(s.token) && !used.has(s.token) ? s.token : null;
            if (token) used.add(token);
            return {
                type: ['none', 'human', 'cpu'].includes(s.type) ? s.type : 'none',
                name: typeof s.name === 'string' ? s.name.slice(0, this.NAME_MAX) : '',
                token,
                difficulty: [1, 2, 3, 4, 5].includes(Number(s.difficulty)) ? Number(s.difficulty) : 3,
                personality: personalities.includes(s.personality) ? s.personality : 'random'
            };
        });
        // Fill any missing / duplicate token with an unused one
        const free = tokens.filter(t => !used.has(t));
        seats.forEach(s => { if (!s.token) s.token = free.shift(); });
        if (seats.filter(s => s.type !== 'none').length < 2) return null;
        const r = raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
        const rules = {};
        this.RULES.forEach(([, key]) => { rules[key] = r[key] === true; });
        rules.freeParkingScope = r.freeParkingScope === 'all' ? 'all' : 'classic';
        return { seats, rules };
    },

    _saveSetup() {
        const seats = this._rows().map(row => ({
            type: this._seatType(row),
            name: row.querySelector('.seat-name').value.trim().slice(0, this.NAME_MAX),
            token: row.querySelector('.seat-token-btn').dataset.token,
            difficulty: this._difficulty(row),
            personality: row.querySelector('.seat-personality').value
        }));
        const rules = {};
        this.RULES.forEach(([id, key]) => { rules[key] = this._checked(id); });
        const scope = document.getElementById('setup-free-parking-scope');
        rules.freeParkingScope = scope ? scope.value : 'classic';
        StorageManager.set(STORAGE_KEYS.SETUP, { seats, rules });
    },

    /* ==================== Tabs ==================== */

    /** The home sections (Play / History / Stats / Lab) on the shared subtabs. Home
     *  always opens on Play, where the Continue card is (a ?tab=home&view= link
     *  still picks one); render() runs again on every return home and keeps the
     *  section shown. */
    _initTabs() {
        if (this._tabsReady || typeof Subtabs === 'undefined') return;
        const bar = document.querySelector('.home-subtabs');
        if (!bar) return;
        bar.querySelectorAll('button[data-icon]').forEach(b => {
            b.insertAdjacentHTML('afterbegin', Icons.svg(b.dataset.icon));
            b.removeAttribute('data-icon');
        });
        try { localStorage.removeItem('pt-home-view'); } catch (e) { /* private mode */ }
        this._tabsReady = true;
        Subtabs.init('home', { root: '#screen-setup', storageKey: 'pt-home-view', onShow: v => this._onTab(v) });
    },

    _showTab(tab) {
        if (typeof Subtabs !== 'undefined') Subtabs.show('home', tab);
    },

    /** History/Stats/Lab re-render on every activation so they stay fresh;
     *  Lab polls only while shown. */
    _onTab(tab) {
        if (tab === 'setup') this._renderContinue();
        if (tab === 'history' && window.HistoryUI) HistoryUI.render();
        if (tab === 'stats' && window.StatsUI) StatsUI.render();
        if (window.LabUI) { if (tab === 'lab') LabUI.render(); else LabUI.stop(); }
    },

    /* ==================== Start ==================== */

    /** Start Game: ask first if it would discard a game in progress. */
    _confirmStart() {
        const save = this._savedGame();
        if (save) this._confirmStartOver(save);
        else this.startFromForm();
    },

    /** Start Game with a game in progress: pause it (resume it later from
     *  the home screen) or discard it. */
    _confirmStartOver(save) {
        const body = document.createElement('div');
        body.appendChild(this._el('p', '', `You have a game in progress (turn ${Number(save.turnNumber) || 0}).`));
        body.appendChild(this._el('p', '', 'Pause it to resume later from the home screen, or discard it.'));
        Modals.show({
            title: 'Game in progress',
            body,
            buttons: [
                { label: 'Cancel', class: 'btn-secondary' },
                { label: '🗑 Discard & start', class: 'btn-danger', onClick: () => {
                    GameState.clearSave();
                    this.startFromForm();
                } },
                { label: '⏸ Pause & start', class: 'btn-primary', onClick: () => {
                    const res = GameState.pauseLive();
                    if (!res.ok) { showNotification(res.reason, 'error'); return; }
                    this.startFromForm();
                } }
            ]
        });
    },

    /** Start a game from the form as it stands (also Game Over → Rematch). */
    startFromForm() {
        const seats = [];
        this._rows().forEach(row => {
            const type = this._seatType(row);
            if (type === 'none') return;
            const name = row.querySelector('.seat-name').value.trim();
            const personality = row.querySelector('.seat-personality').value;
            const clone = type === 'cpu' ? this._cloneSeat(personality) : null;
            const seat = {
                name: name || (type === 'cpu' ? `CPU ${seats.length + 1}` : `Player ${seats.length + 1}`),
                isCPU: type === 'cpu',
                difficulty: clone ? clone.difficulty : this._difficulty(row),
                personality: personality === 'random' ? null : personality,
                token: row.querySelector('.seat-token-btn').dataset.token
            };
            // The game records the clone version as the seat's archetype (game-history players[].personality)
            if (clone) Object.assign(seat, { personality: clone.version, cloneSeat: true });
            seats.push(seat);
        });

        if (seats.length < 2) {
            showNotification('Add at least 2 players', 'warning');
            return;
        }
        this._saveSetup();
        const scopeEl = document.getElementById('setup-free-parking-scope');
        const config = {
            seats,
            balancedRents: this._checked('setup-balanced-rents'),
            delayedBuy: this._checked('setup-delayed-buy'),
            freeParking: this._checked('setup-free-parking'),
            freeParkingScope: scopeEl ? scopeEl.value : 'classic',
            // Simplified transfers are the default; the toggle opts into the official fee
            simpleMortgageTransfer: !this._checked('setup-advanced-mortgage')
        };
        this._confirmExpress(() => startNewGame(config));
    },

    /** Express left on from a previous game: offer to turn it off before
     *  the new one starts. Either answer starts the game. */
    _confirmExpress(then) {
        if (!window.SettingsUI || !SettingsUI.isExpress(SettingsUI.load())) { then(); return; }
        Modals.show({
            title: 'Express is on',
            body: '<p>CPU speed is Fast and your turns roll and end on their own '
                + '(Turn flow → Express). Turn Express off for this game?</p>',
            buttons: [
                { label: '⏩ Keep Express', class: 'btn-secondary', onClick: then },
                { label: '⏹ Turn off', class: 'btn-primary', onClick: () => {
                    SettingsUI.setExpress(false);
                    then();
                } }
            ]
        });
    },

    /* ==================== Helpers ==================== */

    _checked(id) { const el = document.getElementById(id); return !!(el && el.checked); },

    _shuffled(arr) {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    },

    _el(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    }
};

if (typeof window !== 'undefined') {
    window.SetupUI = SetupUI;
}
