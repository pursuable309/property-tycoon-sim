/**
 * Property Tycoon helpers for ui-check, evaluated in the game page after every
 * load, after the shared core/lib/kit-core.js: added onto window.__uic
 * (replacing the core freeze() and pauseAnimations()).
 *
 * Everything here drives the game through its public globals (startNewGame,
 * engine.dispatch, EventBus, the UI modules) or a click. It never edits the
 * game's files; it only stubs history writes (hygiene) and freezes the CPUs.
 */
(() => {
    if (!window.__uic || window.__uic.startGame) return 'already';

    const NAMES = ['Alexandra', 'Bo', 'Chen', 'Dmitri', 'Esperanza', 'Fu', 'Gil', 'Hal'];
    const TOKENS = ['hat', 'car', 'dog', 'ship', 'boot', 'cat', 'moneybag', 'horse'];
    const FROZEN = 1e9;   // engine.cpuDelay that never fires (setTimeout max is ~2.1e9)

    const kit = {
        /** Content profile (config.json "content", --content): seat names and,
         *  for 'stress', 5-digit cash and the bigger numbers states ask for
         *  with kit.n(). ui_check.js sets it after every load. */
        content: { name: 'normal', names: NAMES, cash: null, stress: false },
        useContent(name, p = {}) {
            this.content = { name, names: (p.names || NAMES).slice(0, 8), cash: p.cash || null, stress: name === 'stress' };
            return this.content.name;
        },
        /** A state's number: the ordinary one, or the worst-case one under --content stress. */
        n(normal, stress) { return this.content.stress ? stress : normal; },

        /** History hygiene: no record ever leaves the page (also blocked by a
         *  network route in the runner). Run before any game starts. */
        stubHistory() {
            if (!window.GameHistory) return false;
            if (!this._realSync) this._realSync = GameHistory.sync;
            GameHistory.sync = () => {};
            GameHistory._push = () => Promise.resolve(true);
            GameHistory.flush = () => {};
            GameHistory.setNote = () => Promise.resolve(true);
            GameHistory.delete = () => Promise.resolve(true);
            return true;
        },

        /** Answer the Lab's reads (/api/lab/*) from the fixture the adapter put in
         *  this.labData (lab-fixture.json), in the page, so the Lab tab shows a running
         *  job, a finished one with its report, an effort and proposals (the network
         *  route answers them empty). Writes and /api/lab/auth fail as signed out.
         *  Call before opening the Lab tab. */
        labFixture() {
            const data = this.labData;
            if (!data || this._labFetch) return !!data;
            const real = window.fetch.bind(window);
            const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body),
                { status, headers: { 'Content-Type': 'application/json' } }));
            this._labFetch = true;
            try { sessionStorage.removeItem('pt_lab_jobs'); } catch (e) { /* blocked */ }
            window.fetch = (input, init) => {
                const url = new URL(typeof input === 'string' ? input : input.url, location.href);
                const p = url.pathname.replace(/\/+$/, '');
                if (!p.startsWith('/api/lab')) return real(input, init);
                if (init && init.method && init.method !== 'GET') return reply(401, { error: 'sign in first' });
                if (p === '/api/lab/jobs') return reply(200, data.jobs);
                if (p === '/api/lab/proposals') return reply(200, data.proposals);
                if (p === '/api/lab/auth') return reply(401, { error: 'bad token' });
                let m = /^\/api\/lab\/jobs\/([^/]+)\/eta$/.exec(p);
                if (m) return reply(200, {});
                m = /^\/api\/lab\/jobs\/([^/]+)$/.exec(p);
                if (m) { const j = data.job[decodeURIComponent(m[1])]; return j ? reply(200, j) : reply(404, { error: 'not found' }); }
                m = /^\/api\/lab\/efforts\/([^/]+)$/.exec(p);
                if (m) { const e = data.efforts[decodeURIComponent(m[1])]; return e ? reply(200, e) : reply(404, { error: 'not found' }); }
                return reply(404, { error: 'not found' });
            };
            return true;
        },

        /** Record this page's game into the localStorage history buffer
         *  (GameHistory.sync back on; _push / flush stay stubbed, so nothing
         *  reaches the server). The History tab, game detail and Game stats
         *  read the buffer, so they show it without a server record. */
        recordHistory() {
            this.stubHistory();
            GameHistory.sync = this._realSync;
            if (window.engine && engine.state) GameHistory.sync(engine.state);
        },

        /** Fixed dates on every buffered record, so screenshots of the
         *  History tab and game detail don't change from run to run. */
        pinHistoryTimes(start = '2026-01-15 19:30:00', end = '2026-01-15 20:05:00') {
            StorageManager.get(STORAGE_KEYS.HISTORY_INDEX, []).forEach(id => {
                const key = GameHistory._gameKey(id);
                const rec = StorageManager.get(key, null);
                if (!rec) return;
                rec.startedAt = start;
                if (rec.endedAt) rec.endedAt = end;
                StorageManager.set(key, rec);
            });
        },

        /** Save states of the game in progress (one per entry of turns,
         *  each stamped with that turn number), newest first like the app. */
        saveSlots(turns = [4, 9]) {
            const s = engine.state, keep = s.turnNumber;
            const out = turns.map(t => {
                s.turnNumber = t;
                const r = GameState.saveSlot(s);
                if (!r.ok) throw new Error('save refused: ' + r.reason);
                return r.slot;
            });
            s.turnNumber = keep;
            return out;
        },

        wait(ms) { return new Promise(r => setTimeout(r, ms)); },
        frames(n = 2) {
            return new Promise(r => {
                const step = k => (k <= 0 ? r() : requestAnimationFrame(() => step(k - 1)));
                step(n);
            });
        },

        /** Deterministic seat list: seat 0 human, the rest CPUs (difficulty 3). */
        seats(n, humans = 1) {
            return Array.from({ length: n }, (_, i) => ({
                type: i < humans ? 'human' : 'cpu',
                name: this.content.names[i] || NAMES[i], token: TOKENS[i], difficulty: 3, personality: 'random'
            }));
        },

        /** The remembered New Game lineup (monopoly_setup_v1), so the home
         *  screen renders exactly n seats. Takes effect on the next render. */
        setupLineup(n, rules = {}) {
            const seats = this.seats(8).map((s, i) => Object.assign(s, { type: i < n ? s.type : 'none' }));
            localStorage.setItem(STORAGE_KEYS.SETUP, JSON.stringify({ seats, rules }));
        },

        /** Start a seeded game, CPUs frozen. opts.rolloff keeps the roll-off
         *  modal open; otherwise it is dismissed with its Start button and
         *  seat 0 (the human) is put on a pre-roll turn. */
        startGame(opts = {}) {
            this.stubHistory();
            const n = opts.seats || 4;
            const seats = this.seats(n, opts.humans || 1).map(s => ({
                name: s.name, isCPU: s.type === 'cpu', difficulty: s.difficulty, token: s.token
            }));
            startNewGame(Object.assign({ seats, seed: opts.seed || 7 }, opts.rules || {}));
            this.freeze();
            if (this.content.cash) {
                engine.state.players.forEach((p, i) => { p.cash = this.content.cash[i]; });
                this.refresh();
            }
            if (opts.rolloff) return engine.state;
            const start = document.querySelector('#modal-buttons button');
            if (start && Modals.isOpen()) start.click();   // public path: dismiss the roll-off
            this.freeze();
            const s = engine.state;
            s.currentPlayer = opts.current || 0;
            s.phase = GamePhase.AWAIT_PREROLL;
            s.pendingAction = null;
            this.refresh();
            return s;
        },

        /** Stop every pending and future CPU decision. */
        freeze() {
            if (!window.engine) return;
            clearTimeout(engine._cpuTimer);
            engine._cpuTimer = null;
            engine.cpuDelay = FROZEN;
        },

        /** Repaint from the current state (what the engine does after an action). */
        refresh() {
            GameState.save(engine.state);
            EventBus.emit('stateChanged', engine.state);
        },

        act(type, extra) { return engine.dispatch(Object.assign({ type }, extra || {})); },

        /** Queue scripted dice for the next rolls (then the seeded stream). */
        dice(...pairs) {
            if (!this._realRoll) {
                this._realRoll = RNG.rollDice;
                this._diceQueue = [];
                RNG.rollDice = s => (this._diceQueue.length ? this._diceQueue.shift() : this._realRoll(s));
            }
            this._diceQueue.push(...pairs);
        },

        /** Put a card on top of its deck ('chance' | 'community'). */
        topCard(deck, id) {
            const d = engine.state.decks;
            d[deck] = [id, ...d[deck].filter(c => c !== id)];
        },

        /** Give tiles to a player. opts: { houses, mortgaged } for each. */
        give(pid, tiles, opts = {}) {
            const s = engine.state;
            tiles.forEach(id => {
                const t = GameState.tileState(s, id);
                // Buildings already there go back to the bank first
                if (t.houses === 5) s.bank.hotels += 1;
                else s.bank.houses += t.houses || 0;
                t.owner = pid;
                t.houses = opts.houses || 0;
                t.mortgaged = !!opts.mortgaged;
                if (t.houses === 5) s.bank.hotels -= 1;
                else s.bank.houses -= t.houses;
            });
        },

        /** A mid-game spread of holdings, sized to the seat count. */
        holdings() {
            const s = engine.state;
            const n = s.players.length;
            this.give(0, [16, 18, 19], { houses: 2 });      // orange set, 2 houses each
            this.give(0, [5, 25]);                         // two railroads
            this.give(0, [1], { mortgaged: true });
            this.give(1, [37, 39]);                        // dark blue set
            this.give(1, [12]);
            if (n > 2) this.give(2, [21, 23, 6]);
            if (n > 3) this.give(3, [8, 9, 28]);
            for (let p = 4; p < n; p++) this.give(p, [[11], [13], [26], [31]][p - 4]);
            const cash = this.content.cash || [1240, 860, 430, 1015, 77, 1500, 615, 990];
            s.players.forEach((p, i) => { p.cash = cash[i]; });
            return s;
        },

        /** Headlines in the current turn (the board centre feed's lines). */
        headlines() {
            const s = engine.state;
            let n = 0;
            for (let i = s.log.length - 1; i >= 0; i--) {
                const e = s.log[i];
                if (e.turn !== s.turnNumber || /'s turn$/.test(e.text)) break;
                if (!e.detail) n += 1;
            }
            return n;
        },

        /** Run the CPUs (and a simple autopilot for the human seats) until
         *  pred(state) holds after an action, or maxMs passes; then freeze.
         *  Bounded to a few seconds: this is for reaching a state, not a sim. */
        playUntil(pred, maxMs = 5000, cpuMs = 15) {
            const s = engine.state;
            return new Promise(resolve => {
                let done = false;
                const finish = why => {
                    if (done) return;
                    done = true;
                    EventBus.off('stateChanged', on);
                    this.freeze();
                    resolve(why);
                };
                const pilot = () => {
                    if (done) return;
                    const st = engine.state;
                    const human = id => !st.players[id].isCPU;
                    if (st.phase === GamePhase.AUCTION_IN_PROGRESS) {
                        const b = Auction.currentBidder(st);
                        if (human(b)) this.act('AUCTION_PASS', { playerId: b });
                        return;
                    }
                    if (st.phase === GamePhase.TRADE_PENDING) {
                        if (human(st.trade.awaiting)) this.act('REJECT_TRADE', { playerId: st.trade.awaiting });
                        return;
                    }
                    if (st.phase === GamePhase.DEBT_SETTLEMENT && st.debt && human(st.debt.debtorId)) {
                        const r = this.act('AUTO_RAISE_CASH', { playerId: st.debt.debtorId });
                        if (st.phase === GamePhase.DEBT_SETTLEMENT) this.act('DECLARE_BANKRUPTCY');
                        return r;
                    }
                    if (!human(st.currentPlayer)) return;
                    const me = st.players[st.currentPlayer];
                    if (st.phase === GamePhase.AWAIT_PREROLL || st.phase === GamePhase.AWAIT_ROLL) this.act('ROLL_DICE');
                    else if (st.phase === GamePhase.AWAIT_JAIL_CHOICE) this.act(me.cash >= 50 ? 'JAIL_PAY' : 'JAIL_ROLL');
                    else if (st.phase === GamePhase.AWAIT_DECISION) {
                        const tile = BOARD[st.pendingAction.tileId];
                        this.act(me.cash >= tile.price + 200 ? 'BUY_PROPERTY' : 'DECLINE_BUY');
                    } else if (st.phase === GamePhase.AWAIT_ENDTURN) this.act('END_TURN');
                };
                const on = () => {
                    if (done || on.dead) return;
                    let hit = false;
                    try { hit = pred(engine.state); } catch (e) { hit = false; }
                    if (hit) { finish('reached'); return; }
                    if (Modals.isOpen() && document.querySelector('#modal-title')?.textContent.match(/Chance|Community Chest/)) {
                        setTimeout(() => { if (!done) Modals.close(); }, 0);
                    }
                    setTimeout(pilot, 0);
                };
                EventBus.on('stateChanged', on);
                setTimeout(() => finish('timeout'), maxMs);
                engine.cpuDelay = cpuMs;
                if (pred(s)) { finish('reached'); return; }
                engine.pump();
                setTimeout(pilot, 0);
            });
        },

        /** CPUs bid $10 steps until the human (seat 0) is the bidder (under
         *  --content stress the first bid jumps to 5 digits). */
        bidsUntilHuman(maxBids = 12) {
            for (let i = 0; i < maxBids; i++) {
                const s = engine.state;
                if (s.phase !== GamePhase.AUCTION_IN_PROGRESS) return false;
                const b = Auction.currentBidder(s);
                if (!s.players[b].isCPU) return true;
                const step = i === 0 ? this.n(10, 10020) : 10;
                this.act('AUCTION_BID', { playerId: b, amount: s.auction.currentBid + step });
                this.freeze();
            }
            return false;
        },

        /** Open a status-bar button by its class (.btn-log, .btn-owners, .btn-note). */
        clickStatus(cls) {
            const b = document.querySelector(`#status-bar ${cls}`);
            if (!b) throw new Error(`no status button ${cls}`);
            b.click();
        },

        /** Click a turn control by its accessible label (Roll, Properties, ...). */
        clickControl(label) {
            const b = [...document.querySelectorAll('#controls button')]
                .find(el => (el.getAttribute('aria-label') || el.textContent).trim().startsWith(label));
            if (!b) throw new Error(`no control "${label}"`);
            b.click();
        },

        /** Freeze every running animation (CSS and Web Animations: tile
         *  effects, flying deeds and coins) at ms into its own timeline, and
         *  stop motion.js's clean-up timers so nothing is taken down while
         *  the screenshot is taken. Returns how many were frozen. */
        pauseAnimations(ms) {
            document.querySelectorAll('.tile').forEach(t => {
                if (t._swapTimer) { clearTimeout(t._swapTimer); t._swapTimer = null; }
            });
            const anims = document.getAnimations();
            anims.forEach(a => { a.pause(); a.currentTime = ms; });
            return anims.length;
        },

        /** A CPU (seat 1) offers the human a trade and the human accepts it
         *  through the offer's Accept button. Leaves the trade's events
         *  (flying deeds, owner swaps) running. */
        acceptTradeFromCpu(give, get) {
            // Earlier effects (holdings() completing a set: its shimmer) end
            // first, so only the trade's own animations are left running
            document.getAnimations().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } });
            const s = engine.state;
            s.currentPlayer = 1;
            this.refresh();
            const r = this.act('PROPOSE_TRADE', { offer: { from: 1, to: 0,
                give: { properties: give, cash: 0, jailCards: 0 },
                get: { properties: get, cash: 0, jailCards: 0 } } });
            this.freeze();
            if (!r.ok) throw new Error('trade refused: ' + r.reason);
            this.clickModal('Accept');
            this.freeze();
        },

        /** Click a modal footer button whose text starts with label. */
        clickModal(label) {
            const b = [...document.querySelectorAll('#modal-buttons button')]
                .find(el => el.textContent.trim().replace(/^\W+/, '').startsWith(label));
            if (!b) throw new Error(`no modal button "${label}"`);
            b.click();
        }
    };

    Object.assign(window.__uic, kit);
    return 'ok';
})();
