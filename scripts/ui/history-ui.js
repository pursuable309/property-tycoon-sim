/**
 * UI: History Tab
 *
 * Setup-screen tab over the game archive, for the player: filter pills
 * (All / Won / Lost / Unfinished), games grouped by day as compact cards
 * (tap one for the detail: standings, interactive net-worth chart, trades,
 * review findings, with Note and Delete in its footer).
 * The developer side (review queue, suggested tuning, AI Tuning) lives in
 * the Lab tab, which reuses _aggregatePanel / _recsBlock from here.
 *
 * Review-type actions are only offered on terminal records (finished or
 * abandoned) — an in-progress game re-pushes its buffer every turn and
 * would clobber anything written to its file.
 *
 * noteModal() (free-text note considered by the review-games skill, see
 * REVIEWS.md) is the one action not gated to terminal records — Settings
 * calls it directly for the live game.
 *
 * openModal() is a read-only browser of the same archive for use mid-game
 * (opened from Settings): viewing only, no review / delete / tuning.
 *
 * Dependencies: game-history, tuning, modals, notifications
 * Exports: window.HistoryUI
 */

const HistoryUI = {

    // Fallback palette when the board renderer's token colors are unavailable.
    SPARK_COLORS: ['#0072BB', '#ED1B24', '#1FB25A', '#F7941D', '#9C27B0', '#00838F', '#795548', '#607D8B'],

    /**
     * The color a player token actually wears on the board, so post-game
     * standings and the net-worth chart match what was just played. Uses the
     * live BoardRenderer palette (default or colorblind, whichever is active)
     * and falls back to SPARK_COLORS if the renderer isn't loaded.
     */
    _playerColor(id) {
        const pal = (typeof BoardRenderer !== 'undefined' && BoardRenderer.TOKEN_COLORS) || this.SPARK_COLORS;
        return pal[id % pal.length];
    },

    PAGE_SIZE: 20,    // cards rendered per infinite-scroll page

    _readOnly: false, // true while browsing from the in-game modal
    _observer: null,  // IntersectionObserver driving the current card list

    FILTERS: [['all', 'All'], ['won', 'Won'], ['lost', 'Lost'], ['live', 'Unfinished']],
    _filter: 'all',

    async render() {
        this._readOnly = false;
        const root = document.getElementById('history-root');
        if (!root) return;
        root.innerHTML = '<div class="history-empty">Loading…</div>';
        const summaries = (await GameHistory.list()).slice().reverse(); // newest first
        // The saved game in progress gets highlighted in the list (its card's border)
        const save = GameState.load();
        this._liveId = save && save.phase !== GamePhase.GAME_OVER ? save.gameId : null;
        root.innerHTML = '';

        if (!summaries.length) {
            root.appendChild(this._el('div', 'history-empty', 'No games recorded yet. Finish a game and it will appear here.'));
            return;
        }

        const bar = this._el('div', 'history-filters');
        bar.innerHTML = Segmented.html('history-filter', this.FILTERS, this._filter, 'Filter games', 'is-scroll');
        root.appendChild(bar);
        const list = this._el('div', 'history-list');
        root.appendChild(list);
        const paint = () => {
            list.textContent = '';
            const shown = summaries.filter(s => this._matches(s, this._filter));
            if (!shown.length) { list.appendChild(this._el('div', 'history-empty', 'No games match.')); return; }
            // Cards render a page at a time; the page (viewport) is the scroll root.
            this._renderCardList(list, shown, null);
        };
        bar.addEventListener('change', () => {
            this._filter = Segmented.value(bar, 'history-filter') || 'all';
            paint();
        });
        paint();
    },

    /** Summary player strings are "Name (human)" / "Name (CPU d3/trader)". */
    _parsePlayer(str) {
        const m = /^(.*) \((human|CPU)(?: d(\d))?[^)]*\)$/.exec(str || '');
        return m ? { name: m[1], human: m[2] === 'human', difficulty: m[3] ? Number(m[3]) : null }
            : { name: String(str || '?'), human: false, difficulty: null };
    },

    /** Won / Lost = a human seat won / a CPU won; Unfinished = in progress or abandoned. */
    _matches(s, filter) {
        if (filter === 'all') return true;
        const live = !s.finished;
        if (filter === 'live') return live;
        if (live || !s.winner) return false;
        const humanWon = (s.players || []).map(p => this._parsePlayer(p))
            .some(p => p.human && p.name === s.winner);
        return filter === 'won' ? humanWon : !humanWon;
    },

    /** "Today" / "Yesterday" / "Nov 5" (adds the year when not this year). */
    _dayLabel(startedAt) {
        const day = (startedAt || '').slice(0, 10);
        if (!day) return 'Undated';
        const d = new Date(day + 'T00:00:00');
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const diff = Math.round((today - d) / 86400000);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        const opts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
        return d.toLocaleDateString('en-US', opts);
    },

    /** Read-only archive browser for mid-game use (no review/delete/tuning). */
    async openModal() {
        this._readOnly = true;
        const summaries = (await GameHistory.list()).slice().reverse(); // newest first
        const body = this._el('div', 'history-modal-list');
        // Show first so #modal-body (the scroll container) exists as the
        // IntersectionObserver root for pagination.
        Modals.show({
            title: '📜 Game history',
            body,
            buttons: [{ label: 'Close', class: 'btn-secondary', onClick: () => AuctionUI.maybeReopen() }]
        });
        if (!summaries.length) {
            body.appendChild(this._el('div', 'history-empty', 'No games recorded yet. Finish a game and it will appear here.'));
            return;
        }
        this._renderCardList(body, summaries, document.getElementById('modal-body'));
    },

    /**
     * Render summary cards into `container` a page at a time, appending the
     * next page as a sentinel nears the scroll root. scrollRoot is the
     * scrollable ancestor to observe against: null (viewport) for the History
     * tab, #modal-body for the in-game modal. Any observer from a previous
     * render is torn down first, so repeated renders can't double-append.
     */
    _renderCardList(container, summaries, scrollRoot) {
        if (this._observer) { this._observer.disconnect(); this._observer = null; }

        const sentinel = this._el('div', 'history-sentinel');
        let cursor = 0;
        let lastDay = null;
        const renderPage = () => {
            const end = Math.min(cursor + this.PAGE_SIZE, summaries.length);
            for (; cursor < end; cursor++) {
                const day = this._dayLabel(summaries[cursor].startedAt);
                if (day !== lastDay) {
                    container.insertBefore(this._el('div', 'history-day', day), sentinel);
                    lastDay = day;
                }
                container.insertBefore(this._card(summaries[cursor]), sentinel);
            }
            if (cursor >= summaries.length) {
                if (this._observer) { this._observer.disconnect(); this._observer = null; }
                sentinel.remove();
            }
        };

        container.appendChild(sentinel);
        renderPage(); // first page

        if (cursor < summaries.length && typeof IntersectionObserver !== 'undefined') {
            this._observer = new IntersectionObserver(
                entries => { if (entries.some(e => e.isIntersecting)) renderPage(); },
                { root: scrollRoot || null, rootMargin: '400px' }); // prefetch before the bottom
            this._observer.observe(sentinel);
        } else {
            // No observer support: fall back to rendering everything at once.
            while (cursor < summaries.length) renderPage();
        }
    },

    _reviewable(summary) {
        return summary.finished || summary.abandoned;
    },

    /* ==================== LIST ==================== */

    /** Compact card: time · turns · result, player chips, status icons.
     *  The whole card opens the detail (Note / Delete live in its footer). */
    _card(s) {
        const card = this._el('button', 'history-card history-card-tap');
        card.type = 'button';

        const head = this._el('div', 'history-card-head');
        head.appendChild(this._el('span', 'history-date', (s.startedAt || '').slice(11, 16) || '?'));
        head.appendChild(this._el('span', 'history-turns', `${s.turns || 0} turns`));
        const players = (s.players || []).map(p => this._parsePlayer(p));
        if (s.winner) {
            const humanWon = players.some(p => p.human && p.name === s.winner);
            head.appendChild(this._el('span', `pt-chip ${humanWon ? 'chip-win' : 'chip-cpu-win'}`, `🏆 ${s.winner}`));
        } else if (s.abandoned) {
            head.appendChild(this._el('span', 'pt-chip', 'abandoned'));
        } else if (!s.finished) {
            const live = this._liveId && this._liveId === s.id;
            if (live) card.classList.add('is-live');
            head.appendChild(this._el('span', 'pt-chip chip-live', live ? '▶ in progress' : '▶ unfinished'));
        }
        card.appendChild(head);

        const chips = this._el('div', 'history-chips');
        players.forEach((p, i) => {
            const chip = this._el('span', 'pt-chip pt-chip-dot' + (p.human ? ' is-human' : ''));
            chip.style.setProperty('--c', this._playerColor(i));
            chip.appendChild(this._el('span', 'pt-chip-name', p.name));
            if (p.difficulty) chip.appendChild(this._el('span', 'pt-chip-sub', `d${p.difficulty}`));
            chips.appendChild(chip);
        });
        card.appendChild(chips);

        const icons = [];
        if (s.rules && s.rules.balancedRents) icons.push(['⚖', 'Balanced rents']);
        if (s.rules && s.rules.delayedBuy) icons.push(['🚦', 'Opening lap']);
        if (s.rules && s.rules.freeParking) icons.push(['🅿️', 'Free Parking jackpot']);
        if (s.review) icons.push(['✔', 'Claude reviewed']);
        if (s.reviewRequested) icons.push(['⏳', 'Queued for Claude review']);
        if (s.note) icons.push(['📝', 'Has a note']);
        if (icons.length) {
            const row = this._el('div', 'history-icons');
            icons.forEach(([icon, label]) => {
                const el = row.appendChild(this._el('span', '', icon));
                el.title = label;
                el.setAttribute('aria-label', label);
            });
            card.appendChild(row);
        }
        card.setAttribute('aria-label',
            `${s.startedAt || ''}, ${s.turns || 0} turns${s.winner ? `, won by ${s.winner}` : ''}. Open details`);
        card.addEventListener('click', () => this._openDetail(s.id));
        return card;
    },

    /**
     * Free-text note attached to a record, surfaced to Claude by the
     * review-games skill (REVIEWS.md) when the game is reviewed. Works on
     * any record, live or archived: the status bar's 📝 button opens it for
     * the in-progress game (gameId only, no summary available), the History
     * tab/detail view for archived ones.
     */
    async noteModal(gameId, opts) {
        opts = opts || {};
        const record = await GameHistory.get(gameId);
        if (!record) { showNotification('Could not load that game', 'error'); return; }

        const wrap = this._el('div', 'history-note-wrap');
        wrap.appendChild(this._el('div', 'history-note-hint',
            'Shown to Claude when this game is reviewed — add context, things to watch, or questions.'));
        const textarea = document.createElement('textarea');
        textarea.className = 'history-note-input';
        textarea.rows = 5;
        textarea.maxLength = 2000;
        textarea.value = record.note || '';
        wrap.appendChild(textarea);

        Modals.show({
            title: '📝 Game note',
            body: wrap,
            buttons: [
                {
                    label: '✅ Save', class: 'btn-primary', onClick: async () => {
                        const ok = await GameHistory.setNote(gameId, textarea.value.trim());
                        showNotification(ok ? 'Note saved' : 'Saved locally — will sync when reachable', ok ? 'success' : 'warning');
                        if (opts.onSaved) opts.onSaved();
                    }
                },
                { label: 'Cancel', class: 'btn-secondary', onClick: () => { if (opts.onCancel) opts.onCancel(); } }
            ]
        });
    },

    _confirmDelete(s) {
        const save = StorageManager.get(STORAGE_KEYS.SAVE, null);
        if ((save && save.gameId === s.id) || GameState.pausedGameIds().includes(s.id)) {
            showNotification('That game is in progress or paused — finish or discard it first', 'warning');
            return;
        }
        Modals.show({
            title: 'Delete game?',
            body: `<p>Delete the game from <strong>${this._esc(s.startedAt || '?')}</strong> from the archive?` +
                ' This cannot be undone.</p>',
            buttons: [
                {
                    label: '🗑 Delete', class: 'btn-primary', onClick: async () => {
                        const ok = await GameHistory.delete(s.id);
                        showNotification(ok ? 'Game deleted' : 'Delete failed (server unreachable?)', ok ? 'success' : 'error');
                        this.render();
                    }
                },
                { label: 'Cancel', class: 'btn-secondary', onClick: () => this._openDetail(s.id) }
            ]
        });
    },

    /* ==================== DETAIL ==================== */

    async _openDetail(gameId) {
        const record = await GameHistory.get(gameId);
        if (!record) { showNotification('Could not load that game', 'error'); return; }

        const body = this._el('div', 'history-detail');
        const section = (title) => {
            body.appendChild(this._el('div', 'history-section-title', title));
        };

        if (record.note) {
            section('Note');
            body.appendChild(this._el('div', 'history-note-display', record.note));
        }

        // Final standings from the last snapshot
        section('Standings');
        body.appendChild(this._standings(record));

        // Net worth over time
        if ((record.snapshots || []).length > 1) {
            section('Net worth over time');
            body.appendChild(this._netWorthChart(record));
        }

        // Rules & tuning in effect
        const ruleBits = [];
        if (record.rules && record.rules.balancedRents) ruleBits.push('balanced rents');
        if (record.rules && record.rules.delayedBuy) ruleBits.push('opening lap');
        if (record.rules && record.rules.freeParking) {
            ruleBits.push(`free parking (${record.rules.freeParkingScope === 'all' ? 'all payments' : 'penalties'})`);
        }
        const tuningKeys = Object.keys(record.tuning || {});
        const st = record.settings;
        section('Rules & tuning');
        const info = this._el('div', 'history-trades');
        info.appendChild(this._el('div', '', `House rules: ${ruleBits.length ? ruleBits.join(', ') : 'standard'}`));
        if (st) {
            const cap = v => v ? v[0].toUpperCase() + v.slice(1) : '?';
            info.appendChild(this._el('div', '',
                `CPU trade activity: ${cap(st.tradeActivity)} · deal flexibility: ${cap(st.tradeFlex)}` +
                ` · counter-offers: ${st.cpuCounters ? 'on' : 'off'}`));
            (record.settingsChanges || []).forEach(ch => info.appendChild(this._el('div', 'standing-sub',
                `↳ from turn ${ch.turn}: activity ${cap(ch.tradeActivity)}, flexibility ${cap(ch.tradeFlex)},` +
                ` counters ${ch.cpuCounters ? 'on' : 'off'}`)));
        }
        tuningKeys.forEach(k => info.appendChild(this._el('div', 'rec-knob', `${k} = ${record.tuning[k]}`)));
        body.appendChild(info);

        // Trades
        if ((record.trades || []).length) {
            section(`Trades (${record.trades.length})`);
            const list = this._el('div', 'history-trades');
            record.trades.forEach(tr => {
                const name = id => (record.players[id] || {}).name || `#${id}`;
                const bundle = b => [
                    b.cash ? `$${b.cash}` : '',
                    b.jailCards ? `${b.jailCards}× jail card` : '',
                    ...(b.properties || []).map(id => BOARD[id] ? BOARD[id].name : `tile ${id}`)
                ].filter(Boolean).join(', ') || 'nothing';
                list.appendChild(this._el('div', '',
                    `T${tr.turn}: ${name(tr.from)} → ${name(tr.to)}: gave ${bundle(tr.give)} for ${bundle(tr.get)}`));
            });
            body.appendChild(list);
        }

        // Review results
        if (record.review) {
            const r = record.review;
            section(`Review (${r.engine === 'claude' ? 'Claude' : `heuristic v${r.version}`}, ${r.reviewedAt})`);
            if (r.summary) body.appendChild(this._el('div', 'history-summary', r.summary));

            const findings = (r.findings || []);
            if (findings.length) {
                const list = this._el('div', 'history-findings');
                const sevRank = { major: 0, minor: 1, info: 2 };
                findings.slice().sort((a, b) => (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3))
                    .forEach(f => {
                        const row = this._el('div', 'history-finding');
                        row.appendChild(this._el('span', `finding-sev sev-${f.severity}`, f.severity));
                        row.appendChild(this._el('span', '', f.message + (f.turn ? ` (turn ${f.turn})` : '')));
                        list.appendChild(row);
                    });
                body.appendChild(list);
            } else {
                body.appendChild(this._el('div', 'history-trades', 'No issues found — clean game.'));
            }

            const recBlock = this._recsBlock('Tuning recommendations', r.recommendations || []);
            if (recBlock) body.appendChild(recBlock);
        }

        const buttons = [];
        // Full event log (read-only; works mid-game from the archive browser too)
        if ((record.log || []).length && typeof LogUI !== 'undefined') {
            buttons.push({
                label: '📜 Game log', class: 'btn-secondary',
                onClick: () => LogUI.showRecord(record, {
                    title: `📜 Game log — ${(record.startedAt || '?').slice(0, 16)}`,
                    onClose: () => this._openDetail(gameId)
                })
            });
        }
        if (!this._readOnly) {
            // Notes only make sense on terminal records (an in-progress game
            // re-pushes its record every turn and would overwrite the note).
            if (record.finished || record.abandoned) {
                buttons.push({
                    label: record.note ? '📝 Edit note' : '📝 Add note', class: 'btn-secondary',
                    onClick: () => this.noteModal(gameId, { onSaved: () => { this._dirty = true; this._openDetail(gameId); },
                                                            onCancel: () => this._openDetail(gameId) })
                });
            }
            // Delete works on any record, including orphaned in-progress ones
            buttons.push({ label: '🗑 Delete', class: 'btn-secondary', onClick: () => this._confirmDelete(record) });
        }
        // Close keeps the list (and its scroll) unless a note changed a card
        buttons.push({
            label: 'Close', class: 'btn-secondary',
            onClick: () => {
                if (this._readOnly) this.openModal();
                else if (this._dirty) { this._dirty = false; this.render(); }
            }
        });

        Modals.show({
            title: `Game — ${(record.startedAt || '?').slice(0, 16)}`,
            body: body,
            buttons: buttons
        });
    },

    /** Ranked standings from the last snapshot (shared by detail + stats). */
    _standings(record) {
        const last = (record.snapshots || [])[record.snapshots.length - 1];
        const standings = this._el('div', 'history-standings');
        const order = (record.players || []).map(p => ({
            p: p,
            snap: last ? last.players[p.id] : null
        })).sort((a, b) => ((b.snap && !b.snap.bankrupt ? b.snap.netWorth : -1)) -
                           ((a.snap && !a.snap.bankrupt ? a.snap.netWorth : -1)));
        order.forEach((row, i) => {
            const line = this._el('div', 'history-standing');
            const swatch = this._el('span');
            swatch.style.cssText = `width:10px;height:10px;border-radius:50%;display:inline-block;background:${this._playerColor(row.p.id)}`;
            line.appendChild(swatch);
            line.appendChild(this._el('span', 'standing-name',
                `${record.winner && record.winner.id === row.p.id ? '🏆 ' : `${i + 1}. `}${row.p.name}`));
            line.appendChild(this._el('span', 'standing-sub',
                row.p.cloneSeat ? SetupUI.cloneLabel(row.p)
                    : row.p.isCPU ? `CPU d${row.p.difficulty}/${row.p.personality || '?'}` : 'human'));
            line.appendChild(this._el('span', 'standing-worth',
                row.snap ? (row.snap.bankrupt ? 'bankrupt' : `$${row.snap.netWorth}`) : '—'));
            standings.appendChild(line);
        });
        return standings;
    },

    /**
     * Lean, mobile-friendly post-game recap: final standings, net-worth curve
     * and a handful of derived key events. Read-only; no review actions. Opened
     * from the Game Over modal.
     */
    async showStats(gameId, opts) {
        const record = await GameHistory.get(gameId);
        if (!record) { showNotification('Stats not available yet', 'warning'); return; }

        const body = this._el('div', 'history-detail');
        const section = t => body.appendChild(this._el('div', 'history-section-title', t));

        section('Final standings');
        body.appendChild(this._standings(record));

        if ((record.snapshots || []).length > 1) {
            section('Net worth over time');
            body.appendChild(this._netWorthChart(record));
        }

        const events = this._keyEvents(record);
        if (events.length) {
            section('Key events');
            const list = this._el('div', 'history-trades');
            events.forEach(e => {
                const row = this._el('div', 'history-finding');
                row.appendChild(this._el('span', 'history-turns', `T${e.turn}`));
                row.appendChild(this._el('span', '', e.text));
                list.appendChild(row);
            });
            body.appendChild(list);
        }

        Modals.show({
            title: '📊 Game stats',
            body,
            buttons: [{ label: 'Close', class: 'btn-secondary', onClick: opts && opts.onClose }]
        });
    },

    /**
     * Key moments: net-worth lead changes, bankruptcies, and the win (all
     * derived from per-turn snapshots), plus Free Parking pot collections
     * (read from the full log, the only place that windfall is recorded).
     * Trimmed to keep the recap short on a phone.
     */
    _keyEvents(record) {
        const snaps = record.snapshots || [];
        const name = id => ((record.players || [])[id] || {}).name || `#${id}`;
        const events = [];

        // Lead changes: leader by net worth among the still-solvent
        let prevLeader = null;
        snaps.forEach((s, i) => {
            let leader = null, best = -1;
            s.players.forEach((pp, id) => {
                if (!pp.bankrupt && (pp.netWorth || 0) > best) { best = pp.netWorth || 0; leader = id; }
            });
            if (leader !== null && leader !== prevLeader) {
                if (prevLeader !== null) events.push({ turn: s.turn, kind: 'lead', text: `${name(leader)} takes the lead` });
                prevLeader = leader;
            }
        });

        // Bankruptcies: first snapshot where each player shows bankrupt
        const seen = new Set();
        snaps.forEach(s => s.players.forEach((pp, id) => {
            if (pp.bankrupt && !seen.has(id)) { seen.add(id); events.push({ turn: s.turn, kind: 'bust', text: `${name(id)} goes bankrupt` }); }
        }));

        // Free Parking pot wins (only recorded in the log)
        (record.log || []).forEach(entry => {
            const m = /^(.+) collects \$(\d+) from Free Parking/.exec(entry.text || '');
            if (m) events.push({ turn: entry.turn, kind: 'parking', text: `${m[1]} lands on Free Parking (+$${m[2]})` });
        });

        if (record.winner) {
            const last = snaps[snaps.length - 1];
            events.push({ turn: last ? last.turn : record.turns, kind: 'win', text: `🏆 ${record.winner.name} wins` });
        }

        events.sort((a, b) => a.turn - b.turn || (a.kind === 'win' ? 1 : -1));

        // Keep it short: bankruptcies + win always, thin the minor events
        // (lead changes and Free Parking wins) evenly.
        if (events.length > 14) {
            const isMinor = e => e.kind === 'lead' || e.kind === 'parking';
            const keep = events.filter(e => !isMinor(e));
            const minor = events.filter(isMinor);
            const room = Math.max(0, 14 - keep.length);
            const stride = Math.ceil(minor.length / Math.max(1, room));
            const thinned = minor.filter((_, i) => i % stride === 0);
            return [...keep, ...thinned].sort((a, b) => a.turn - b.turn || (a.kind === 'win' ? 1 : -1));
        }
        return events;
    },

    /**
     * Interactive net-worth chart: one polyline per player over the per-turn
     * snapshots, a player legend, and vertical markers at a curated handful of
     * key moments (bankruptcies, the win, lead changes, property trades). Tap
     * or hover a marker to read the event. The SVG stretches to fill (0..100
     * space, non-scaling strokes) so the percentage-positioned marker overlay
     * always lines up with the curve.
     */
    _netWorthChart(record) {
        const snaps = record.snapshots || [];
        const container = this._el('div', 'nw-chart-container');
        if (snaps.length < 2) return container;

        const step = Math.max(1, Math.ceil(snaps.length / 120));
        const sampled = snaps.filter((_, i) => i % step === 0 || i === snaps.length - 1);
        const minTurn = sampled[0].turn;
        const maxTurn = sampled[sampled.length - 1].turn;
        const span = Math.max(1, maxTurn - minTurn);
        const xForTurn = t => ((Math.max(minTurn, Math.min(maxTurn, t)) - minTurn) / span) * 100;
        const maxWorth = Math.max(1, ...sampled.flatMap(s => s.players.map(p => p.netWorth || 0)));

        const plot = this._el('div', 'nw-plot');
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'nw-svg');
        record.players.forEach(p => {
            const pts = sampled.map(s => {
                const worth = s.players[p.id] ? (s.players[p.id].netWorth || 0) : 0;
                const y = 98 - (worth / maxWorth) * 96;
                return `${xForTurn(s.turn).toFixed(2)},${y.toFixed(2)}`;
            }).join(' ');
            const line = document.createElementNS(svgNS, 'polyline');
            line.setAttribute('points', pts);
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', this._playerColor(p.id));
            line.setAttribute('stroke-width', '1.5');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            svg.appendChild(line);
        });
        plot.appendChild(svg);

        const tip = this._el('div', 'nw-tip');
        tip.hidden = true;
        const events = this._chartEvents(record);
        events.forEach(ev => {
            const x = xForTurn(ev.turn);
            const marker = this._el('button', `nw-marker nw-marker-${ev.kind}`);
            marker.type = 'button';
            marker.style.left = `${x}%`;
            marker.setAttribute('aria-label', `Turn ${ev.turn}: ${ev.text}`);
            const show = () => {
                tip.hidden = false;
                tip.textContent = `T${ev.turn} · ${ev.text}`;
                tip.style.left = `${x}%`;
                tip.classList.toggle('nw-tip-right', x > 60);
                plot.querySelectorAll('.nw-marker.is-active').forEach(m => m.classList.remove('is-active'));
                marker.classList.add('is-active');
            };
            marker.addEventListener('click', e => { e.stopPropagation(); show(); });
            marker.addEventListener('mouseenter', show);
            plot.appendChild(marker);
        });
        plot.appendChild(tip);
        plot.addEventListener('mouseleave', () => {
            tip.hidden = true;
            plot.querySelectorAll('.nw-marker.is-active').forEach(m => m.classList.remove('is-active'));
        });

        // Event markers can crowd the curve when a lot happens — let them be
        // toggled off, remembered across games via the shared settings store.
        if (events.length) {
            const showEvents = SettingsUI.load().chartEvents !== false;
            plot.classList.toggle('nw-hide-events', !showEvents);
            const toggle = document.createElement('label');
            toggle.className = 'nw-events-toggle';
            toggle.innerHTML = '<span>Key event markers</span>';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'toggle';
            cb.checked = showEvents;
            cb.addEventListener('change', () => {
                plot.classList.toggle('nw-hide-events', !cb.checked);
                if (cb.checked) { tip.hidden = true; }
                const stored = SettingsUI.load();
                stored.chartEvents = cb.checked;
                StorageManager.set(STORAGE_KEYS.SETTINGS, stored);
            });
            toggle.appendChild(cb);
            container.appendChild(toggle);
        }
        container.appendChild(plot);

        const legend = this._el('div', 'nw-legend');
        record.players.forEach(p => {
            const item = this._el('span', 'nw-legend-item');
            const sw = this._el('span', 'nw-legend-swatch');
            sw.style.background = this._playerColor(p.id);
            item.appendChild(sw);
            item.appendChild(this._el('span', '', p.name));
            legend.appendChild(item);
        });
        container.appendChild(legend);
        return container;
    },

    /**
     * A curated set of chart markers (kept deliberately sparse). Bankruptcies
     * and the win always show; the remaining budget is filled from property
     * trades and lead changes, spread evenly across the game.
     */
    _chartEvents(record) {
        const name = id => ((record.players || [])[id] || {}).name || `#${id}`;
        const busts = [], wins = [], leads = [];
        this._keyEvents(record).forEach(e => {
            if (e.kind === 'bust') busts.push(e);
            else if (e.kind === 'win') wins.push(e);
            else leads.push(e);
        });
        const trades = (record.trades || [])
            .filter(t => (t.give.properties || []).length || (t.get.properties || []).length)
            .map(t => ({ turn: t.turn, kind: 'trade', text: `${name(t.from)} ⇄ ${name(t.to)}` }));

        const MAX = 10;
        const keep = [...busts, ...wins];
        const budget = Math.max(0, MAX - keep.length);
        let extras = [...trades, ...leads].sort((a, b) => a.turn - b.turn);
        if (extras.length > budget) {
            const stride = extras.length / budget;
            extras = Array.from({ length: budget }, (_, i) => extras[Math.floor(i * stride)]);
        }
        return [...keep, ...extras].sort((a, b) => a.turn - b.turn || (a.kind === 'win' ? 1 : -1));
    },

    /* ==================== RECOMMENDATIONS ==================== */

    /** Knobs the viewer has dismissed (localStorage, per-viewer, survives
     *  reload). Dismissing hides that knob's recommendations everywhere — the
     *  per-game cards and the cross-game aggregate — since a dismissal is a
     *  decision that the tuning DIRECTION is not worth pursuing. Reversible via
     *  the "Show N dismissed" toggle each recommendations block grows. */
    _dismissedRecs() {
        try {
            const arr = JSON.parse(localStorage.getItem('monopoly_dismissed_recs') || '[]');
            return new Set(Array.isArray(arr) ? arr : []);
        } catch (e) { return new Set(); }
    },

    _setRecDismissed(knob, on) {
        const set = this._dismissedRecs();
        if (on) set.add(knob); else set.delete(knob);
        try { localStorage.setItem('monopoly_dismissed_recs', JSON.stringify([...set])); } catch (e) { /* private mode */ }
    },

    /**
     * A self-contained recommendations block (title + cards) that re-renders
     * itself in place when a card is dismissed or restored, so the section
     * count and the "Show N dismissed" toggle stay in sync without reopening.
     * Returns null when there is nothing to show. Used by both the per-game
     * review and the cross-game aggregate.
     */
    _recsBlock(title, recs) {
        recs = recs || [];
        if (!recs.length) return null;
        const block = this._el('div', 'history-recs');
        const render = () => {
            block.textContent = '';
            const dset = this._dismissedRecs();
            const retired = r => (window.AITuning && AITuning.retiredRec) ? AITuning.retiredRec(r) : null;
            const active = recs.filter(r => !dset.has(r.knob) && !retired(r));
            const hidden = recs.filter(r => dset.has(r.knob) || retired(r));
            block.appendChild(this._el('div', 'history-section-title', title));
            active.forEach(rec => block.appendChild(this._recCard(rec, { onChange: render })));
            if (!active.length) block.appendChild(this._el('div', 'rec-reason', 'All recommendations dismissed.'));
            if (hidden.length) {
                block.appendChild(this._btn(
                    `${this._showDismissed ? 'Hide' : 'Show'} ${hidden.length} dismissed`,
                    'rec-dismissed-toggle',
                    () => { this._showDismissed = !this._showDismissed; render(); }));
                if (this._showDismissed) {
                    hidden.forEach(rec => block.appendChild(this._recCard(rec, { dismissed: true, retired: retired(rec), onChange: render })));
                }
            }
        };
        render();
        return block;
    },

    _recCard(rec, opts) {
        opts = opts || {};
        const card = this._el('div', 'rec-card' + (opts.dismissed ? ' rec-card-dismissed' : ''));
        const line = this._el('div', 'rec-line');
        line.appendChild(this._el('span', 'rec-knob', rec.knob));
        line.appendChild(this._el('span', '', `${rec.current} → ${rec.suggested}`));

        if (opts.retired) {
            line.appendChild(this._el('span', 'rec-retired', 'Retired'));
        } else if (opts.dismissed) {
            line.appendChild(this._btn('Restore', 'btn-secondary', () => {
                this._setRecDismissed(rec.knob, false);
                showNotification(`Restored ${rec.knob} recommendation`, 'info');
                if (opts.onChange) opts.onChange();
            }));
        } else {
            const live = window.AITuning ? AITuning.get(rec.knob) : null;
            const applied = live !== null && live === rec.suggested;
            const btn = this._btn(applied ? 'Applied' : 'Apply', 'btn-primary', () => {
                AITuning.set(rec.knob, rec.suggested);
                showNotification(`${rec.knob} → ${rec.suggested} (takes effect next game)`, 'success');
                btn.textContent = 'Applied';
                btn.disabled = true;
            });
            if (applied) btn.disabled = true;
            if (!this._readOnly) line.appendChild(btn); // no tuning changes mid-game
            const dismiss = this._btn('✕', 'btn-secondary rec-dismiss', () => {
                this._setRecDismissed(rec.knob, true);
                showNotification(`Dismissed ${rec.knob}`, 'info');
                if (opts.onChange) opts.onChange();
            });
            dismiss.title = 'Dismiss this recommendation';
            dismiss.setAttribute('aria-label', `Dismiss ${rec.knob} recommendation`);
            line.appendChild(dismiss);
        }

        card.appendChild(line);
        card.appendChild(this._el('div', 'rec-reason',
            `${rec.reason}${rec.confidence ? ` (confidence: ${rec.confidence})` : ''}`));
        if (rec._support) card.appendChild(this._el('div', 'rec-support', rec._support));
        if (opts.retired) card.appendChild(this._el('div', 'rec-support', `Retired in the repo: ${opts.retired.reason}`));
        return card;
    },

    /**
     * Cross-game panel built from list summaries only: recommendations
     * grouped by knob (median suggestion), shown when backed by >= 2 games
     * or a single high-confidence rec.
     */
    _aggregatePanel(summaries) {
        const byKnob = {};
        summaries.forEach(s => {
            if (!s.review || !s.review.recommendations) return;
            s.review.recommendations.forEach(rec => {
                (byKnob[rec.knob] = byKnob[rec.knob] || []).push(rec);
            });
        });
        const knobs = Object.keys(byKnob).filter(k =>
            byKnob[k].length >= 2 || byKnob[k].some(r => r.confidence === 'high'));
        if (!knobs.length) return null;

        const recs = [];
        knobs.forEach(knob => {
            const group = byKnob[knob];
            const sorted = group.map(r => r.suggested).sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const current = window.AITuning ? AITuning.get(knob) : group[0].current;
            if (median === current) return;
            recs.push({
                knob: knob, current: current, suggested: median, reason: group[0].reason, confidence: null,
                _support: `backed by ${group.length} game${group.length > 1 ? 's' : ''}`
            });
        });
        return this._recsBlock(
            `Suggested tuning (across ${summaries.filter(s => s.review).length} reviewed games)`, recs);
    },

    /* ==================== HELPERS ==================== */

    _el(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    },

    _btn(label, cls, onClick) {
        const b = this._el('button', `btn ${cls}`, label);
        b.addEventListener('click', onClick);
        return b;
    },

    _esc(text) {
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.HistoryUI = HistoryUI;
}
