/**
 * UI: Statistics tab (all-time archive analytics)
 *
 * The Stats setup-screen tab. Aggregates the entire game-history archive
 * into a dashboard, organised into three sub-views via a segmented control:
 *   - Overview : headline KPIs, games over time, lengths, house rules
 *   - CPUs     : win rates by difficulty & personality, survival, trading
 *   - Board    : most-landed tiles, dice, trade market & economy
 * The Claude review analysis (word cloud, findings leaderboard) is drawn by
 * renderClaudeInto() for the Lab tab's Reviews view.
 *
 * Data flow: GameHistory.list() gives cheap summaries for an instant Overview
 * paint; the deeper charts need full records (snapshots/trades/log), fetched
 * through a throttled pool and cached (keyed by an archive signature) in the
 * otherwise-unused STORAGE_KEYS.STATS so revisits are instant. All charts are
 * inline HTML/SVG (no libraries) and styled with theme tokens, so dark mode is
 * free. Colours: difficulty is a sequential accent ramp; personality archetypes
 * use a CVD-validated categorical palette (see styles/features/stats.css).
 *
 * Exports: window.StatsUI
 */
const StatsUI = {

    ARCH_ORDER: ['aggressive', 'hoarder', 'builder', 'trader', 'cautious'],
    HOUSE_RULES: [
        ['balancedRents', 'Rebalanced rents'],
        ['delayedBuy', 'No buying until GO'],
        ['freeParking', 'Free Parking jackpot']
    ],

    _view: 'overview',   // persisted across re-renders
    _agg: null,          // full aggregates (null until records loaded)
    _sig: null,          // signature the current _agg was computed for
    _soloOnly: false,    // drop games with a second human (persisted in the STATS cache)
    _noClones: false,    // drop games with a Clone of T seat (persisted in the STATS cache)

    /* ==================== Entry point ==================== */

    async render() {
        const root = document.getElementById('stats-root');
        if (!root || typeof GameHistory === 'undefined') return;
        root.innerHTML = '';
        this._content = null;
        root.appendChild(this._switcher());
        const cache = StorageManager.get(STORAGE_KEYS.STATS, null) || {};
        this._soloOnly = !!cache.soloOnly;
        this._noClones = !!cache.noClones;

        let list = [];
        try { list = await GameHistory.list(); } catch (e) { /* offline */ }
        const others = this._otherHumans(list);
        if (others.length) root.appendChild(this._filterToggle('soloOnly', 'Solo games only', `(exclude ${others.join(', ')})`));
        if (list.some(s => this._hasClone(s))) root.appendChild(this._filterToggle('noClones', 'No Clone of T games', '(exclude 🧬 seats)'));
        this._content = root.appendChild(this._el('div', 'stats-content'));
        if (this._soloOnly) list = list.filter(s => !this._humansOf(s).some(n => others.includes(n)));
        if (this._noClones) list = list.filter(s => !this._hasClone(s));
        if (!list.length) { this._content.appendChild(this._empty()); return; }

        this._sumAgg = this._aggregateSummaries(list);
        const key = this._cacheKey();
        const sig = `${key}|${this._signature(list)}`;
        this._wantSig = sig;

        // Cache hit: everything is precomputed, paint instantly. One entry per
        // toggle state, so flipping it back and forth stays instant. `agg.reviews`
        // gates out pre-Claude-tab caches so they re-aggregate instead of showing
        // an empty Claude view.
        const cached = cache[key];
        if (cached && cached.sig === sig && cached.agg && cached.agg.reviews) {
            this._agg = cached.agg; this._sig = sig;
            this._renderView();
            return;
        }

        // Cold: paint what summaries allow now, load full records in the
        // background, then cache + repaint.
        this._agg = (this._sig === sig) ? this._agg : null;
        this._renderView();
        if (this._sig !== sig) this._loadFull(list, sig);
    },

    async _loadFull(list, sig) {
        this._loading = true;
        this._updateProgress(0, list.length);
        const records = await this._pool(list.map(s => s.id), 6,
            id => GameHistory.get(id).catch(() => null),
            done => this._updateProgress(done, list.length));
        this._loading = false;

        const agg = this._aggregate(records.filter(r => r));
        const cache = StorageManager.get(STORAGE_KEYS.STATS, null) || {};
        cache[sig.split('|')[0]] = { sig, agg };
        StorageManager.set(STORAGE_KEYS.STATS, cache);
        if (sig !== this._wantSig) return;   // the toggle flipped mid-load: cache it, don't paint it
        this._agg = agg; this._sig = sig;
        this._renderView();
    },

    /** Bounded-concurrency map — avoids firing 60 fetches at once. */
    async _pool(items, concurrency, worker, onProgress) {
        const out = []; let i = 0, done = 0;
        const run = async () => {
            while (i < items.length) {
                const idx = i++;
                out[idx] = await worker(items[idx]);
                if (onProgress) onProgress(++done, items.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
        return out;
    },

    _signature(list) {
        const ended = list.map(s => s.endedAt || '').filter(Boolean).sort();
        return `${list.length}:${ended[ended.length - 1] || 'none'}`;
    },

    /** Human seat names in a list() summary ("Name (human)"). */
    _humansOf(s) {
        return (s.players || []).filter(p => /\(human\)$/.test(p)).map(p => p.replace(/ \(human\)$/, ''));
    },

    /** Every human except the most frequent one (the archive's owner), e.g. ['E']. */
    _otherHumans(list) {
        const n = {};
        list.forEach(s => this._humansOf(s).forEach(h => { n[h] = (n[h] || 0) + 1; }));
        const names = Object.keys(n).sort((x, y) => n[y] - n[x]);
        return names.slice(1);
    },

    /** A Clone of T seat (either version) in a list() summary: its CPU entry
     *  carries the clone version as the archetype, "Name (CPU d4/T@2026-10-19s)". */
    _hasClone(s) {
        return (s.players || []).some(p => /\(CPU d\d\/T@[^)]*\)$/.test(p));
    },

    /** STATS cache entry for the current filters ('all' = unfiltered, which the
     *  Lab's Reviews view also reads). */
    _cacheKey() {
        const k = [this._soloOnly && 'solo', this._noClones && 'noclone'].filter(Boolean).join('-');
        return k || 'all';
    },

    /** A whole-game filter toggle. "Solo games only" drops games where a second human
     *  sat in (shared-cash co-op, they skew human win rates and CPU-vs-human stats);
     *  "No Clone of T games" drops games with a 🧬 seat, a CPU playing a fitted copy
     *  of the human (it sits in the CPU charts at its fixed difficulty). */
    _filterToggle(prop, label, sub) {
        const field = '_' + prop;
        const row = this._el('label', 'settings-row stats-solo');
        row.append(label + ' ');
        row.appendChild(this._el('span', 'stats-solo-sub', sub));
        const box = document.createElement('input');
        box.type = 'checkbox'; box.className = 'toggle'; box.checked = this[field];
        box.addEventListener('change', () => {
            this[field] = box.checked;
            const cache = StorageManager.get(STORAGE_KEYS.STATS, null) || {};
            cache[prop] = this[field];
            StorageManager.set(STORAGE_KEYS.STATS, cache);
            this._sig = null; this._agg = null;
            this.render();
        });
        row.appendChild(box);
        return row;
    },

    /* ==================== View chrome ==================== */

    _switcher() {
        const wrap = this._el('div', 'stats-switcher');
        wrap.innerHTML = Icons.subtabs('Statistics sections', [
            ['overview', 'Overview', 'grid'], ['cpu', 'CPUs', 'cpu'], ['board', 'Board', 'map']
        ]);
        // Shared subtabs (remembers the last view); the first onShow comes before
        // render() has its content box, so _renderView skips it
        Subtabs.init('stats', { root: wrap, storageKey: 'pt-stats-view', onShow: v => {
            this._view = v;
            this._renderView();
        } });
        return wrap;
    },

    _renderView() {
        if (!this._content) return;
        this._hideTip();
        this._content.innerHTML = '';
        const needsRecords = this._view !== 'overview';
        if (needsRecords && !this._agg) {
            this._content.appendChild(this._progress());
            return;
        }
        if (this._view === 'cpu') this._renderCpu();
        else if (this._view === 'board') this._renderBoard();
        else this._renderOverview();
    },

    /* ==================== Overview ==================== */

    _renderOverview() {
        const a = this._agg || this._sumAgg;
        const c = this._content;

        c.appendChild(this._kpiGrid([
            ['Games', a.total, `${a.finished} finished`],
            ['Playtime', this._fmtDur(a.playtimeSec), 'total, real time'],
            ['Avg length', a.avgTurns ? `${a.avgTurns} turns` : '—', a.medTurns ? `median ${a.medTurns}` : ''],
            ['Human win rate', a.humanGames ? this._pct(a.humanWins / a.humanGames) : '—', `${a.humanWins}/${a.humanGames} games`],
            ['Longest game', a.maxTurns ? `${a.maxTurns} turns` : '—', ''],
            ['Avg players', a.avgPlayers ? a.avgPlayers.toFixed(1) : '—', `${a.abandoned} abandoned`]
        ]));

        if (a.overTime && a.overTime.length > 1) {
            const { card, body } = this._card('Games over time');
            body.appendChild(this._areaChart(a.overTime.map(d => d.count),
                a.overTime.map(d => d.date), 'games'));
            c.appendChild(card);
        }

        if (a.lengthBins && a.lengthBins.length) {
            const { card, body } = this._card('Game length distribution');
            body.appendChild(this._histogram(a.lengthBins.map(b => b.count),
                a.lengthBins.map(b => b.label), 'games', 'turns'));
            c.appendChild(card);
        }

        if (a.playerCounts && a.playerCounts.some(v => v)) {
            const { card, body } = this._card('Players per game');
            const rows = a.playerCounts.map((n, i) => n ? { label: `${i}p`, value: n } : null).filter(Boolean);
            body.appendChild(this._bars(rows, { max: Math.max(...rows.map(r => r.value)), fmt: v => v }));
            c.appendChild(card);
        }

        if (a.houseRules) {
            const { card, body } = this._card('House rule usage');
            const rows = this.HOUSE_RULES.map(([k, label]) => ({
                label, value: a.houseRules[k] || 0, valueText: `${a.houseRules[k] || 0} · ${this._pct((a.houseRules[k] || 0) / a.total)}`
            }));
            body.appendChild(this._bars(rows, { max: a.total, fmt: v => v }));
            c.appendChild(card);
        }

        if (!this._agg) c.appendChild(this._progress('Loading full records for deeper charts…'));
    },

    /* ==================== CPU / AI ==================== */

    _renderCpu() {
        const a = this._agg, c = this._content;

        // Win rate by difficulty (sequential accent ramp; ordinal, direct-labelled)
        {
            const { card, body } = this._card('Win rate by difficulty');
            const rows = [1, 2, 3, 4, 5].map(d => {
                const seats = a.diffSeats[d] || 0, wins = a.diffWins[d] || 0;
                return { label: `d${d}`, value: seats ? wins / seats : 0, color: this._diffColor(d),
                    valueText: seats ? `${this._pct(wins / seats)}` : 'n/a', sublabel: `${wins}/${seats}` };
            });
            body.appendChild(this._bars(rows, { max: this._niceRateMax(rows), fmt: this._pct, pctScale: true }));
            body.appendChild(this._note('Per-seat: games won ÷ seats of that difficulty (finished games).'));
            c.appendChild(card);
        }

        // Win rate by personality archetype (categorical, validated palette)
        {
            const { card, body } = this._card('Win rate by personality');
            const rows = this.ARCH_ORDER.map(k => {
                const seats = a.archSeats[k] || 0, wins = a.archWins[k] || 0;
                return { label: this._cap(k), value: seats ? wins / seats : 0, color: this._archColor(k),
                    valueText: seats ? this._pct(wins / seats) : 'n/a', sublabel: `${wins}/${seats}` };
            });
            body.appendChild(this._bars(rows, { max: this._niceRateMax(rows), fmt: this._pct, pctScale: true }));
            c.appendChild(card);
        }

        // Difficulty × personality win-rate heatmap
        {
            const { card, body } = this._card('Difficulty × personality win rate');
            body.appendChild(this._heatmap(
                [1, 2, 3, 4, 5].map(d => `d${d}`),
                this.ARCH_ORDER.map(k => this._cap(k).slice(0, 4)),
                [1, 2, 3, 4, 5].map(d => this.ARCH_ORDER.map(k => {
                    const seats = (a.matrixSeats[d] || {})[k] || 0;
                    const wins = (a.matrixWins[d] || {})[k] || 0;
                    return { rate: seats ? wins / seats : null, seats, wins };
                }))));
            c.appendChild(card);
        }

        // Bankruptcy survival by difficulty
        {
            const { card, body } = this._card('Survival rate by difficulty');
            const rows = [1, 2, 3, 4, 5].map(d => {
                const seats = a.survTotal[d] || 0, surv = a.survLived[d] || 0;
                return { label: `d${d}`, value: seats ? surv / seats : 0, color: this._diffColor(d),
                    valueText: seats ? this._pct(surv / seats) : 'n/a', sublabel: `${surv}/${seats}` };
            });
            body.appendChild(this._bars(rows, { max: 1, fmt: this._pct, pctScale: true }));
            body.appendChild(this._note('Share of seats still solvent at game end.'));
            c.appendChild(card);
        }

        // Trades initiated per seat, by archetype
        {
            const { card, body } = this._card('Trades initiated per seat');
            const rows = this.ARCH_ORDER.map(k => {
                const seats = a.archSeats[k] || 0, init = a.tradeInit[k] || 0;
                const per = seats ? init / seats : 0;
                return { label: this._cap(k), value: per, color: this._archColor(k),
                    valueText: seats ? per.toFixed(1) : 'n/a',
                    sublabel: init ? `${this._pct((a.tradeCounters[k] || 0) / init)} countered` : '' };
            });
            body.appendChild(this._bars(rows, { max: Math.max(0.1, ...rows.map(r => r.value)), fmt: v => v.toFixed(1) }));
            c.appendChild(card);
        }

        // Average final net worth by difficulty
        {
            const { card, body } = this._card('Average final net worth by difficulty');
            const rows = [1, 2, 3, 4, 5].map(d => {
                const n = a.finalNwCount[d] || 0, sum = a.finalNwSum[d] || 0;
                const avg = n ? sum / n : 0;
                return { label: `d${d}`, value: avg, color: this._diffColor(d),
                    valueText: n ? this._fmtMoney(Math.round(avg)) : 'n/a' };
            });
            body.appendChild(this._bars(rows, { max: Math.max(1, ...rows.map(r => r.value)), fmt: v => this._fmtMoney(Math.round(v)) }));
            c.appendChild(card);
        }
    },

    /* ==================== Board & Trades ==================== */

    _renderBoard() {
        const a = this._agg, c = this._content;

        // Economy headline (compact values; exact figures via tap tooltip)
        {
            const { card, body } = this._card('Economy');
            const peakAvg = a.peakCount ? Math.round(a.peakSum / a.peakCount) : 0;
            body.appendChild(this._kpiGrid([
                ['Rent paid', a.hasLogs ? this._fmtMoneyShort(a.totalRent) : '—', 'all games', a.hasLogs ? `${this._fmtMoney(a.totalRent)} rent paid across all games` : null],
                ['Avg peak worth', a.peakCount ? this._fmtMoneyShort(peakAvg) : '—', 'per finished game', a.peakCount ? `${this._fmtMoney(peakAvg)} average peak net worth` : null],
                ['Free Parking', a.hasLogs ? this._fmtMoneyShort(a.parkingTotal) : '—', `${a.parkingHits} hits`, a.hasLogs ? `${this._fmtMoney(a.parkingTotal)} over ${a.parkingHits} Free Parking hits` : null]
            ], 'stats-kpi-grid-sm'));
            c.appendChild(card);
        }

        if (!a.hasLogs) {
            c.appendChild(this._note('Board & dice metrics need per-move game logs, which none of the archived games carry yet.'));
        } else {
            // Most-landed tiles (log-derived), coloured by property group
            {
                const { card, body } = this._card('Most-landed tiles');
                const top = a.landings.slice(0, 12);
                const rows = top.map(t => ({ label: t.name, value: t.count, color: t.color, valueText: t.count }));
                body.appendChild(this._bars(rows, { max: top.length ? top[0].count : 1, fmt: v => v }));
                c.appendChild(card);
            }

            // Dice-sum distribution + doubles rate
            {
                const { card, body } = this._card('Dice rolls');
                body.appendChild(this._histogram(
                    a.diceSums.slice(2), Array.from({ length: 11 }, (_, i) => `${i + 2}`), 'rolls'));
                body.appendChild(this._note(`${this._fmtInt(a.diceTotal)} rolls · doubles ${a.diceTotal ? this._pct(a.diceDoubles / a.diceTotal) : '—'} (fair: 17%)`));
                c.appendChild(card);
            }
        }

        // Trade market (structured) — most-traded properties
        if (a.tradedProps && a.tradedProps.length) {
            const { card, body } = this._card('Most-traded properties');
            const top = a.tradedProps.slice(0, 10);
            const rows = top.map(t => ({ label: t.name, value: t.count, color: t.color, valueText: t.count }));
            body.appendChild(this._bars(rows, { max: top[0].count, fmt: v => v }));
            c.appendChild(card);
        }

        // Trade composition + volume
        {
            const { card, body } = this._card('Trade activity');
            body.appendChild(this._kpiGrid([
                ['Total trades', a.tradeTotal, a.finished ? `${(a.tradeTotal / Math.max(1, a.finished)).toFixed(1)}/game` : ''],
                ['Countered', a.tradeTotal ? this._pct(a.tradeCountered / a.tradeTotal) : '—', `${a.tradeCountered} offers`]
            ], 'stats-kpi-grid-sm'));
            if (a.tradeTotal) {
                body.appendChild(this._stack([
                    { label: 'Property-only', value: a.tradeComp.prop, color: 'var(--arch-builder)' },
                    { label: 'Mixed', value: a.tradeComp.mixed, color: 'var(--arch-aggressive)' },
                    { label: 'Cash-only', value: a.tradeComp.cash, color: 'var(--arch-trader)' }
                ]));
            }
            c.appendChild(card);
        }
    },

    /* ==================== Claude review analysis ====================
       Aggregates the per-game `review` objects Claude writes back (REVIEWS.md):
       a date-filtered word cloud of the prose summaries, a findings leaderboard,
       and review-coverage KPIs. All
       state below persists across re-renders so the slider/toggle feel live. */

    _clMode: 'bi',      // 'bi' bigrams (default) | 'uni' unigrams
    _clLo: null,        // date-range lo/hi as epoch-day numbers
    _clHi: null,
    _clSig: null,       // review-set signature; a change resets the range
    _clWord: null,      // clicked cloud term → drills into matching summaries
    _clBodyWrap: null,  // the recomputed region (below the coverage KPIs + slider)

    // Filler words stripped before counting. Domain terms (cash, trade, mortgage,
    // monopoly, railroad, auction, bankrupt, liquidity, property names…) are kept
    // on purpose — they are the point of the cloud.
    _STOP: new Set(('the a an and or but of to in on at by for with from into as is are was ' +
        'were be been being it its this that these those he she they them his her their who whom ' +
        'which what when where why how not no yes do does did done has have had will would can ' +
        'could should may might must then than so too very just more most much many few some any ' +
        'all both each every other another same own out up down off over under again further once ' +
        'here there i you we me my your our us if while because although though after before ' +
        'game games turn turns player players playing played win wins won winner winning lost lose ' +
        'loss cpu bot difficulty seat seats round rounds got get gets end ends ended still never ' +
        'only also two three four five one').split(/\s+/)),

    /**
     * Claude review analysis into `container` (Lab → Reviews): coverage KPIs,
     * a date-range slider, the summary word cloud and the findings
     * leaderboard. Uses the cached full aggregate over ALL games (the Stats
     * tab's solo filter doesn't apply), loading the records if needed.
     */
    async renderClaudeInto(container) {
        container.textContent = '';
        const prog = container.appendChild(this._el('div', 'stats-progress'));
        const text = prog.appendChild(this._el('div', 'stats-progress-text', 'Analyzing reviews…'));
        const fill = prog.appendChild(this._el('div', 'stats-progress-track')).appendChild(this._el('div', 'stats-progress-fill'));
        let agg;
        try {
            agg = await this._allAggregate((done, total) => {
                fill.style.width = `${total ? (done / total) * 100 : 0}%`;
                text.textContent = `Analyzing ${done} of ${total} games…`;
            });
        } catch (e) { agg = null; }
        if (!container.isConnected) return;
        container.textContent = '';
        if (!agg) { container.appendChild(this._note('Could not load the game archive.')); return; }
        this._clAgg = agg;
        this._renderClaude(container);
    },

    /** Full aggregate over every game, from the STATS cache when the archive
     *  hasn't changed (same entry the Stats tab writes when not filtered). */
    async _allAggregate(onProgress) {
        const list = await GameHistory.list();
        const sig = `all|${this._signature(list)}`;
        const cache = StorageManager.get(STORAGE_KEYS.STATS, null) || {};
        if (cache.all && cache.all.sig === sig && cache.all.agg && cache.all.agg.reviews) return cache.all.agg;
        const records = await this._pool(list.map(s => s.id), 6,
            id => GameHistory.get(id).catch(() => null), onProgress);
        const agg = this._aggregate(records.filter(r => r));
        const fresh = StorageManager.get(STORAGE_KEYS.STATS, null) || {};
        fresh.all = { sig, agg };
        StorageManager.set(STORAGE_KEYS.STATS, fresh);
        return agg;
    },

    _renderClaude(c) {
        const a = this._clAgg;
        const reviews = a.reviews || [];
        if (!reviews.length) {
            c.appendChild(this._note('No games have a Claude review yet. Finished games auto-queue for ' +
                'review — run the review-games skill, then reopen this tab.'));
            return;
        }

        // Coverage KPIs (always full corpus, not date-filtered).
        {
            const { card, body } = this._card('Review coverage');
            const versions = reviews.map(r => r.version).filter(Boolean).sort();
            const dates = reviews.map(r => r.date).filter(Boolean).sort();
            body.appendChild(this._kpiGrid([
                ['Reviewed', a.reviewedCount, `of ${a.total} · ${this._pct(a.reviewedCount / Math.max(1, a.total))}`],
                ['In queue', a.queuedCount, a.queuedCount ? 'awaiting review' : 'all caught up'],
                ['Latest reviewer', versions.length ? versions[versions.length - 1].replace(/^claude-/, '') : '—', `${new Set(versions).size} versions`],
                ['Span', dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—', `${new Set(dates).size} review days`]
            ], 'stats-kpi-grid-sm'));
            c.appendChild(card);
        }

        // Reset the range whenever the review set changes (new reviews arrived).
        const days = reviews.map(r => this._dayNum(r.date)).filter(n => n != null);
        const minDay = Math.min(...days), maxDay = Math.max(...days);
        const sig = `${reviews.length}:${minDay}:${maxDay}`;
        if (this._clSig !== sig) { this._clSig = sig; this._clLo = minDay; this._clHi = maxDay; this._clWord = null; }

        const bodyWrap = this._el('div', 'cl-body');
        c.appendChild(this._clRange(minDay, maxDay, bodyWrap));
        c.appendChild(bodyWrap);
        this._renderClaudeBody(bodyWrap);
    },

    /** Dual-thumb date range. Two stacked range inputs (transparent tracks, only
        the thumbs catch pointer events) clamped so lo ≤ hi. */
    _clRange(minDay, maxDay, bodyWrap) {
        const { card, body } = this._card('Date range');
        if (minDay === maxDay) {
            body.appendChild(this._note(`All ${(this._clAgg.reviews || []).length} reviews are from ${this._dayStr(minDay)}.`));
            return card;
        }
        const wrap = this._el('div', 'cl-range');
        const track = this._el('div', 'cl-range-track');
        const fill = this._el('div', 'cl-range-fill');
        const lo = document.createElement('input'), hi = document.createElement('input');
        [lo, hi].forEach(inp => {
            inp.type = 'range'; inp.min = String(minDay); inp.max = String(maxDay); inp.step = '1';
            inp.className = 'cl-range-input';
        });
        lo.classList.add('cl-range-lo'); hi.classList.add('cl-range-hi');
        lo.value = String(this._clLo); hi.value = String(this._clHi);
        lo.setAttribute('aria-label', 'Range start date'); hi.setAttribute('aria-label', 'Range end date');

        const labels = this._el('div', 'cl-range-labels');
        const loLab = this._el('span'), hiLab = this._el('span');
        labels.append(loLab, hiLab);

        const paint = () => {
            const span = (maxDay - minDay) || 1;
            fill.style.left = `${((this._clLo - minDay) / span) * 100}%`;
            fill.style.right = `${(1 - (this._clHi - minDay) / span) * 100}%`;
            loLab.textContent = this._dayStr(this._clLo);
            hiLab.textContent = this._dayStr(this._clHi);
        };
        lo.addEventListener('input', () => {
            this._clLo = Math.min(+lo.value, this._clHi); lo.value = String(this._clLo);
            paint(); this._renderClaudeBody(bodyWrap);
        });
        hi.addEventListener('input', () => {
            this._clHi = Math.max(+hi.value, this._clLo); hi.value = String(this._clHi);
            paint(); this._renderClaudeBody(bodyWrap);
        });
        wrap.append(track, fill, lo, hi);
        body.append(wrap, labels);
        paint();
        return card;
    },

    /** Recompute the cloud / findings for the current date window. */
    _renderClaudeBody(wrap) {
        this._clBodyWrap = wrap;
        wrap.innerHTML = '';
        const inRange = (this._clAgg.reviews || []).filter(r => {
            const d = this._dayNum(r.date);
            return d == null || (d >= this._clLo && d <= this._clHi);
        });
        if (!inRange.length) { wrap.appendChild(this._note('No reviews in this date range.')); return; }
        wrap.appendChild(this._clCloud(inRange));
        wrap.appendChild(this._clFindings(inRange));
    },

    _clCloud(reviews) {
        const { card, body } = this._card('Summary word cloud');

        const toolbar = this._el('div', 'cl-cloud-toolbar');
        toolbar.innerHTML = Segmented.html('cl-mode', [['bi', '2-word'], ['uni', '1-word']], this._clMode, 'Cloud granularity');
        toolbar.addEventListener('change', () => {
            this._clMode = Segmented.value(toolbar, 'cl-mode') || 'bi';
            this._clWord = null;
            this._renderClaudeBody(this._clBodyWrap);
        });
        body.appendChild(toolbar);

        const terms = this._cloudTerms(reviews, this._clMode);
        if (!terms.length) { body.appendChild(this._note('Not enough recurring words in this range yet.')); return card; }

        const cloud = this._el('div', 'cl-cloud');
        const maxF = terms[0].n, minF = terms[terms.length - 1].n;
        terms.forEach(t => {
            const scale = maxF === minF ? 1 : (t.n - minF) / (maxF - minF);
            const w = this._el('button', 'cl-word' + (this._clWord === t.term ? ' is-sel' : ''), t.term);
            w.type = 'button';
            w.style.fontSize = `${(0.72 + scale * 1.18).toFixed(2)}rem`;
            if (this._clWord !== t.term) w.style.opacity = (0.5 + scale * 0.5).toFixed(2);
            w.setAttribute('aria-label', `${t.term}: ${t.n} mentions — show summaries`);
            w.addEventListener('click', () => {
                this._clWord = (this._clWord === t.term) ? null : t.term;
                this._renderClaudeBody(this._clBodyWrap);
            });
            cloud.appendChild(w);
        });
        body.appendChild(cloud);
        body.appendChild(this._note(`${terms.length} terms · ${this._clMode === 'bi' ? '2-word phrases' : 'single words'} across ${reviews.length} reviewed games · tap a word to read its games.`));

        // Drill-down: summaries containing the selected term, highlighted.
        if (this._clWord) {
            const re = this._termRegex(this._clWord);
            const matches = reviews.filter(r => re.test(r.summary));
            const list = this._el('div', 'cl-summaries');
            const head = this._el('div', 'cl-summaries-head');
            head.append(`“${this._clWord}” — ${matches.length} game${matches.length === 1 ? '' : 's'}`);
            const clear = this._el('button', 'cl-summaries-clear', '✕ clear'); clear.type = 'button';
            clear.addEventListener('click', () => { this._clWord = null; this._renderClaudeBody(this._clBodyWrap); });
            head.appendChild(clear);
            list.appendChild(head);
            matches.slice(0, 25).forEach(r => {
                const item = this._el('div', 'cl-summary');
                item.appendChild(this._el('div', 'cl-summary-date', r.date));
                item.appendChild(this._highlightSummary(r.summary, this._clWord));
                list.appendChild(item);
            });
            body.appendChild(list);
        }
        return card;
    },

    _clFindings(reviews) {
        const { card, body } = this._card('Findings leaderboard');
        const RANK = { major: 3, minor: 2, info: 1 };
        const COLOR = { major: 'var(--danger)', minor: 'var(--warning)', info: 'var(--success)' };
        const codes = {}, sevTotals = { major: 0, minor: 0, info: 0 };
        let total = 0;
        reviews.forEach(r => (r.findings || []).forEach(f => {
            if (!f.code) return;
            total++;
            if (f.severity in sevTotals) sevTotals[f.severity]++;
            const e = codes[f.code] = codes[f.code] || { count: 0, sev: 'info' };
            e.count++;
            if ((RANK[f.severity] || 0) > (RANK[e.sev] || 0)) e.sev = f.severity;
        }));
        if (!total) { body.appendChild(this._note('No findings recorded in this range.')); return card; }

        const rows = Object.keys(codes).map(code => ({
            label: code, value: codes[code].count, color: COLOR[codes[code].sev] || 'var(--accent)',
            valueText: codes[code].count, sublabel: codes[code].sev
        })).sort((x, y) => y.value - x.value).slice(0, 12);
        body.appendChild(this._bars(rows, { max: rows[0].value, fmt: v => v }));
        body.appendChild(this._stack([
            { label: 'Major', value: sevTotals.major, color: 'var(--danger)' },
            { label: 'Minor', value: sevTotals.minor, color: 'var(--warning)' },
            { label: 'Info', value: sevTotals.info, color: 'var(--success)' }
        ]));
        body.appendChild(this._note(`${total} findings across ${reviews.length} games · bar colour = highest severity seen for that code.`));
        return card;
    },

    /* ---- cloud tokenisation ---- */

    /** Top recurring terms. Bigrams break across stopword/name gaps so only real
        adjacent phrases ("cash starved") survive; unigrams are single words. */
    _cloudTerms(reviews, mode) {
        const names = new Set(this._clAgg.reviewNames || []);
        const counts = {};
        reviews.forEach(r => {
            const toks = this._tokens(r.summary, names);
            if (mode === 'uni') {
                toks.forEach(w => { if (w) counts[w] = (counts[w] || 0) + 1; });
            } else {
                for (let i = 0; i < toks.length - 1; i++) {
                    if (!toks[i] || !toks[i + 1]) continue;
                    const bg = `${toks[i]} ${toks[i + 1]}`;
                    counts[bg] = (counts[bg] || 0) + 1;
                }
            }
        });
        const min = mode === 'bi' ? 2 : 3;   // require recurrence to earn a slot
        return Object.keys(counts).map(term => ({ term, n: counts[term] }))
            .filter(t => t.n >= min).sort((x, y) => y.n - x.n).slice(0, 45);
    },

    /** Lowercased token stream; stopwords, player names, numbers and turn refs
        become null so bigram adjacency breaks across them. */
    _tokens(text, names) {
        return String(text || '').toLowerCase()
            .replace(/['’]s\b/g, '')            // possessive → base ("wren's" → "wren")
            .replace(/[^a-z0-9\s-]/g, ' ')      // punctuation → space (keep hyphens)
            .split(/\s+/)
            .map(w => w.replace(/^-+|-+$/g, ''))
            .map(w => {
                if (w.length < 3) return null;
                if (/^\d+$/.test(w) || /^d[1-5]$/.test(w) || /^t\d+$/.test(w)) return null;
                if (this._STOP.has(w) || names.has(w)) return null;
                return w;
            });
    },

    _termRegex(term) {
        const parts = term.split(' ').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        return new RegExp(`\\b${parts.join('\\W+')}\\b`, 'i');
    },

    /** Summary text with every occurrence of `term` wrapped in <mark> (text nodes
        only — the summary is treated as untrusted text). */
    _highlightSummary(text, term) {
        const el = this._el('div', 'cl-summary-text');
        const parts = term.split(' ').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp(`(\\b${parts.join('\\W+')}\\b)`, 'ig');
        let last = 0, m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
            el.appendChild(this._el('mark', 'cl-mark', m[0]));
            last = m.index + m[0].length;
            if (re.lastIndex === m.index) re.lastIndex++;   // guard against zero-width
        }
        if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
        return el;
    },

    _dayNum(dateStr) {
        if (!dateStr) return null;
        const t = Date.parse(`${dateStr}T00:00:00Z`);
        return isNaN(t) ? null : Math.floor(t / 86400000);
    },
    _dayStr(day) { return new Date(day * 86400000).toISOString().slice(0, 10); },

    /* ==================== Aggregation ==================== */

    /** Cheap Overview-only aggregate from list() summaries (instant paint). */
    _aggregateSummaries(list) {
        const a = { total: list.length, finished: 0, abandoned: 0, playtimeSec: 0,
            humanGames: 0, humanWins: 0, playerCounts: [], turnsList: [], dateCount: {} };
        list.forEach(s => {
            if (s.finished) a.finished++;
            if (s.abandoned) a.abandoned++;
            a.playtimeSec += this._duration(s.startedAt, s.endedAt);
            a.playerCounts[s.numPlayers] = (a.playerCounts[s.numPlayers] || 0) + 1;
            if (s.startedAt) { const d = s.startedAt.slice(0, 10); a.dateCount[d] = (a.dateCount[d] || 0) + 1; }
            if (s.finished && typeof s.turns === 'number') a.turnsList.push(s.turns);
            const hasHuman = (s.players || []).some(p => /\(human\)/.test(p));
            if (s.finished && hasHuman) {
                a.humanGames++;
                // winner is a bare name; it's a human win unless it matches a "(CPU …)" player
                const wp = (s.players || []).find(p => p.startsWith(`${s.winner} (`));
                if (s.winner && wp && /\(human\)/.test(wp)) a.humanWins++;
            }
        });
        return this._finishOverview(a, list.map(s => s.numPlayers));
    },

    _finishOverview(a, numPlayersList) {
        const t = a.turnsList.slice().sort((x, y) => x - y);
        a.avgTurns = t.length ? Math.round(t.reduce((s, v) => s + v, 0) / t.length) : 0;
        a.medTurns = t.length ? t[Math.floor(t.length / 2)] : 0;
        a.maxTurns = t.length ? t[t.length - 1] : 0;
        a.avgPlayers = numPlayersList.length ? numPlayersList.reduce((s, v) => s + v, 0) / numPlayersList.length : 0;
        a.overTime = Object.keys(a.dateCount).sort().map(d => ({ date: d.slice(5), count: a.dateCount[d] }));
        a.lengthBins = this._binTurns(a.turnsList);
        return a;
    },

    /** Full aggregate over complete records (all charts). Serialisable. */
    _aggregate(records) {
        const a = this._aggregateSummaries(records.map(r => ({
            finished: r.finished, abandoned: r.abandoned, startedAt: r.startedAt, endedAt: r.endedAt,
            numPlayers: (r.players || []).length, turns: r.turns,
            players: (r.players || []).map(p => p.isCPU ? `${p.name} (CPU)` : `${p.name} (human)`),
            winner: r.winner ? r.winner.name : null
        })));
        // Recompute human win-rate cleanly from ids (summary path is name-matched).
        a.humanGames = 0; a.humanWins = 0;
        a.houseRules = {}; a.diffSeats = {}; a.diffWins = {}; a.archSeats = {}; a.archWins = {};
        a.matrixSeats = {}; a.matrixWins = {}; a.survTotal = {}; a.survLived = {};
        a.tradeInit = {}; a.tradeCounters = {}; a.finalNwSum = {}; a.finalNwCount = {};
        a.tradeTotal = 0; a.tradeCountered = 0; a.tradeComp = { cash: 0, prop: 0, mixed: 0 };
        a.diceSums = new Array(13).fill(0); a.diceDoubles = 0; a.diceTotal = 0;
        a.totalRent = 0; a.parkingTotal = 0; a.parkingHits = 0; a.peakSum = 0; a.peakCount = 0; a.hasLogs = false;
        a.reviews = []; a.reviewedCount = 0; a.queuedCount = 0; a.reviewNames = {};
        const landings = {}, tradedProps = {};

        records.forEach(r => {
            const players = r.players || [];
            const finished = r.finished;
            const winner = r.winner;
            const humanSeat = players.some(p => !p.isCPU);

            (this.HOUSE_RULES).forEach(([k]) => { if (r.rules && r.rules[k]) a.houseRules[k] = (a.houseRules[k] || 0) + 1; });

            if (finished) {
                if (humanSeat) { a.humanGames++; if (winner && !players[winner.id].isCPU) a.humanWins++; }
                players.forEach(p => {
                    if (!p.isCPU) return;
                    const d = p.difficulty, k = p.personality;
                    a.diffSeats[d] = (a.diffSeats[d] || 0) + 1;
                    if (winner && winner.id === p.id) a.diffWins[d] = (a.diffWins[d] || 0) + 1;
                    if (k) {
                        a.archSeats[k] = (a.archSeats[k] || 0) + 1;
                        if (winner && winner.id === p.id) a.archWins[k] = (a.archWins[k] || 0) + 1;
                        (a.matrixSeats[d] = a.matrixSeats[d] || {})[k] = ((a.matrixSeats[d] || {})[k] || 0) + 1;
                        if (winner && winner.id === p.id) (a.matrixWins[d] = a.matrixWins[d] || {})[k] = ((a.matrixWins[d] || {})[k] || 0) + 1;
                    }
                });

                // End-state metrics from the last snapshot
                const last = (r.snapshots || [])[(r.snapshots || []).length - 1];
                if (last) {
                    let peak = 0;
                    (r.snapshots || []).forEach(s => s.players.forEach(pp => { if ((pp.netWorth || 0) > peak) peak = pp.netWorth || 0; }));
                    if (peak) { a.peakSum += peak; a.peakCount++; }
                    players.forEach(p => {
                        if (!p.isCPU) return;
                        const d = p.difficulty;
                        const solvent = last.players[p.id] && !last.players[p.id].bankrupt;
                        a.survTotal[d] = (a.survTotal[d] || 0) + 1;
                        if (solvent) a.survLived[d] = (a.survLived[d] || 0) + 1;
                        const nw = last.players[p.id] ? (last.players[p.id].netWorth || 0) : 0;
                        a.finalNwSum[d] = (a.finalNwSum[d] || 0) + nw;
                        a.finalNwCount[d] = (a.finalNwCount[d] || 0) + 1;
                    });
                }
            }

            // Trades (structured) — all games
            (r.trades || []).forEach(tr => {
                a.tradeTotal++;
                if (tr.counters) a.tradeCountered++;
                const fromArch = players[tr.from] && players[tr.from].isCPU ? players[tr.from].personality : null;
                if (fromArch) { a.tradeInit[fromArch] = (a.tradeInit[fromArch] || 0) + 1; a.tradeCounters[fromArch] = (a.tradeCounters[fromArch] || 0) + (tr.counters || 0); }
                const props = ((tr.give && tr.give.properties) || []).concat((tr.get && tr.get.properties) || []);
                const cash = ((tr.give && tr.give.cash) || 0) + ((tr.get && tr.get.cash) || 0);
                if (props.length && cash) a.tradeComp.mixed++;
                else if (props.length) a.tradeComp.prop++;
                else a.tradeComp.cash++;
                props.forEach(id => { tradedProps[id] = (tradedProps[id] || 0) + 1; });
            });

            // Log-derived — board landings, dice, rent, Free Parking
            if (Array.isArray(r.log) && r.log.length) {
                a.hasLogs = true;
                r.log.forEach(e => {
                    const txt = e.text || '';
                    let m;
                    if ((m = /(?: lands on | advances to | moves back to )(.+)\.$/.exec(txt))) landings[m[1]] = (landings[m[1]] || 0) + 1;
                    if ((m = / rolls (\d+) \+ (\d+)/.exec(txt))) {
                        const d1 = +m[1], d2 = +m[2];
                        a.diceSums[d1 + d2]++; a.diceTotal++; if (d1 === d2) a.diceDoubles++;
                    }
                    if ((m = / (?:owes|pays) \$(\d+) rent /.exec(txt))) a.totalRent += +m[1];   // "pays" since the merged line
                    if ((m = / collects \$(\d+) from Free Parking/.exec(txt))) { a.parkingTotal += +m[1]; a.parkingHits++; }
                });
            }

            // Claude review — compact per-game record for the date-filtered Claude tab.
            const reviewed = r.review && r.review.engine === 'claude';
            if (r.reviewRequested && !reviewed) a.queuedCount++;
            if (reviewed) {
                const rv = r.review;
                a.reviewedCount++;
                (rv.perPlayer || []).forEach(p => {
                    if (p.name) a.reviewNames[p.name.toLowerCase()] = 1;
                });
                a.reviews.push({
                    date: (rv.reviewedAt || r.endedAt || r.startedAt || '').slice(0, 10),
                    version: rv.version || '',
                    summary: rv.summary || '',
                    findings: (rv.findings || []).map(f => ({ code: f.code, severity: f.severity }))
                });
            }
        });

        a.landings = Object.keys(landings).map(name => ({ name, count: landings[name], color: this._tileColor(name) }))
            .sort((x, y) => y.count - x.count);
        a.tradedProps = Object.keys(tradedProps).map(id => ({
            name: (BOARD[+id] || {}).name || `#${id}`, count: tradedProps[id], color: this._tileColor((BOARD[+id] || {}).name)
        })).sort((x, y) => y.count - x.count);
        a.reviews.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
        a.reviewNames = Object.keys(a.reviewNames);
        return a;
    },

    _binTurns(list) {
        if (!list.length) return [];
        const max = Math.max(...list), size = max <= 60 ? 15 : max <= 150 ? 30 : 50;
        const bins = [];
        for (let lo = 0; lo < max + 1; lo += size) bins.push({ label: `${lo}-${lo + size}`, count: 0 });
        list.forEach(t => { bins[Math.min(bins.length - 1, Math.floor(t / size))].count++; });
        return bins;
    },

    /* ==================== Chart builders (inline HTML/SVG) ==================== */

    _kpiGrid(items, cls) {
        const grid = this._el('div', `stats-kpi-grid ${cls || ''}`);
        items.forEach(([label, value, sub, tip]) => {
            const tile = this._el('div', 'stats-kpi');
            tile.appendChild(this._el('div', 'stats-kpi-val', String(value)));
            tile.appendChild(this._el('div', 'stats-kpi-label', label));
            if (sub) tile.appendChild(this._el('div', 'stats-kpi-sub', sub));
            if (tip) this._bindTip(tile, tip);
            grid.appendChild(tile);
        });
        return grid;
    },

    /** Horizontal bars. rows: {label, value, color?, valueText?, sublabel?}. */
    _bars(rows, opts) {
        opts = opts || {};
        const max = opts.max || Math.max(1, ...rows.map(r => r.value));
        const wrap = this._el('div', 'stats-bars');
        rows.forEach(r => {
            const row = this._el('div', 'stats-bar-row');
            const lab = this._el('span', 'stats-bar-label', r.label);
            const track = this._el('div', 'stats-bar-track');
            const fill = this._el('div', 'stats-bar-fill');
            fill.style.width = `${Math.max(0, Math.min(100, (r.value / max) * 100))}%`;
            if (r.color) fill.style.background = r.color;
            track.appendChild(fill);
            const shown = r.valueText != null ? String(r.valueText) : (opts.fmt ? String(opts.fmt(r.value)) : String(r.value));
            row.append(lab, track, this._el('span', 'stats-bar-val', shown));
            this._bindTip(row, `${r.label}: ${shown}${r.sublabel ? ' (' + r.sublabel + ')' : ''}`);
            wrap.appendChild(row);
        });
        return wrap;
    },

    /** Vertical column histogram. values + xLabels aligned. `unit` names the bar
        value (what's counted); `xunit` names the axis label (the bucket). */
    _histogram(values, labels, unit, xunit) {
        const max = Math.max(1, ...values);
        const wrap = this._el('div', 'stats-hist');
        const cols = this._el('div', 'stats-hist-cols');
        values.forEach((v, i) => {
            const col = this._el('div', 'stats-hist-col');
            const bar = this._el('div', 'stats-hist-bar');
            bar.style.height = `${(v / max) * 100}%`;
            col.appendChild(bar);
            this._bindTip(col, `${labels[i]}${xunit ? ' ' + xunit : ''}: ${unit ? this._plural(v, unit) : v}`);
            cols.appendChild(col);
        });
        const axis = this._el('div', 'stats-hist-axis');
        labels.forEach(l => axis.appendChild(this._el('span', '', l)));
        wrap.append(cols, axis);
        return wrap;
    },

    /** Matrix heatmap. cells[r][c] = {rate|null, seats, wins}. */
    _heatmap(rowLabels, colLabels, cells) {
        const wrap = this._el('div', 'stats-heat');
        wrap.style.gridTemplateColumns = `auto repeat(${colLabels.length}, 1fr)`;
        wrap.appendChild(this._el('div', 'stats-heat-corner', ''));
        colLabels.forEach(c => wrap.appendChild(this._el('div', 'stats-heat-colh', c)));
        rowLabels.forEach((rl, ri) => {
            wrap.appendChild(this._el('div', 'stats-heat-rowh', rl));
            cells[ri].forEach((cell, ci) => {
                const el = this._el('div', 'stats-heat-cell', cell.rate == null ? '·' : this._pct(cell.rate));
                if (cell.rate != null) {
                    el.style.background = `color-mix(in srgb, var(--accent) ${Math.round(18 + cell.rate * 82)}%, var(--surface-alt))`;
                    if (cell.rate > 0.55) el.classList.add('is-hot');
                    this._bindTip(el, `${rl} · ${colLabels[ci] || ''}: ${this._pct(cell.rate)} (${cell.wins}/${cell.seats})`);
                } else { el.classList.add('is-empty'); }
                wrap.appendChild(el);
            });
        });
        return wrap;
    },

    /** Single stacked part-to-whole bar + legend. segments: {label,value,color}. */
    _stack(segments) {
        const total = segments.reduce((s, x) => s + x.value, 0) || 1;
        const wrap = this._el('div', 'stats-stack-wrap');
        const bar = this._el('div', 'stats-stack');
        segments.forEach(s => {
            if (!s.value) return;
            const seg = this._el('div', 'stats-stack-seg');
            seg.style.width = `${(s.value / total) * 100}%`;
            seg.style.background = s.color;
            this._bindTip(seg, `${s.label}: ${s.value} (${this._pct(s.value / total)})`);
            bar.appendChild(seg);
        });
        const legend = this._el('div', 'stats-legend');
        segments.forEach(s => {
            const item = this._el('span', 'stats-legend-item');
            const sw = this._el('span', 'stats-legend-swatch'); sw.style.background = s.color;
            item.append(sw, this._el('span', '', `${s.label} ${this._pct(s.value / total)}`));
            legend.appendChild(item);
        });
        wrap.append(bar, legend);
        return wrap;
    },

    /** SVG area+line time series. Stretch-to-fill, non-scaling stroke. */
    _areaChart(values, labels, unit) {
        const wrap = this._el('div', 'stats-area');
        const plot = this._el('div', 'stats-area-plot');
        const max = Math.max(1, ...values), n = values.length;
        const x = i => n === 1 ? 50 : (i / (n - 1)) * 100;
        const y = v => 98 - (v / max) * 94;
        const pts = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('class', 'stats-area-svg');
        const area = document.createElementNS(svgNS, 'polygon');
        area.setAttribute('points', `0,100 ${pts} 100,100`);
        area.setAttribute('class', 'stats-area-fill');
        const line = document.createElementNS(svgNS, 'polyline');
        line.setAttribute('points', pts);
        line.setAttribute('class', 'stats-area-line');
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(area, line);
        plot.appendChild(svg);

        // Per-point interaction: a moving dot + a full-plot hit layer. Tap (or
        // drag to scrub) reads the nearest day; hover previews on desktop.
        const dot = this._el('div', 'stats-area-dot');
        dot.hidden = true;
        plot.appendChild(dot);
        const hit = this._el('div', 'stats-area-hit stats-tappable');
        hit.setAttribute('role', 'button');
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('aria-label', `Games over time — tap a day (${values.reduce((s, v) => s + v, 0)} ${unit || ''} across ${n} days)`);
        plot.appendChild(hit);

        let scrubbing = false, idx = 0;
        const showIdx = (i) => {
            idx = Math.max(0, Math.min(n - 1, i));
            dot.style.left = `${x(idx)}%`;
            dot.style.top = `${y(values[idx])}%`;
            dot.hidden = false;
            this._areaDot = dot;
            this._showTip(dot, `${labels[idx]}: ${unit ? this._plural(values[idx], unit) : values[idx]}`);
        };
        const idxFromEvent = (e) => {
            const r = hit.getBoundingClientRect();
            const cx = (e.clientX != null ? e.clientX : 0) - r.left;
            return Math.round((r.width ? cx / r.width : 0) * (n - 1));
        };
        hit.addEventListener('pointerdown', e => { e.stopPropagation(); scrubbing = true; this._pinned = true; showIdx(idxFromEvent(e)); });
        hit.addEventListener('pointermove', e => { if (scrubbing || !this._pinned) showIdx(idxFromEvent(e)); });
        hit.addEventListener('pointerup', () => { scrubbing = false; });
        hit.addEventListener('pointercancel', () => { scrubbing = false; });
        hit.addEventListener('mouseleave', () => { if (!this._pinned) this._hideTip(); });
        hit.addEventListener('keydown', e => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); this._pinned = true; showIdx(idx + (e.key === 'ArrowRight' ? 1 : -1)); }
        });

        const axis = this._el('div', 'stats-area-axis');
        axis.append(this._el('span', '', labels[0] || ''), this._el('span', '', labels[labels.length - 1] || ''));
        wrap.append(plot, axis);
        return wrap;
    },

    /* ==================== Small pieces ==================== */

    _card(title) {
        const card = this._el('div', 'stats-card history-card');
        card.appendChild(this._el('div', 'history-section-title', title));
        const body = this._el('div', 'stats-card-body');
        card.appendChild(body);
        return { card, body };
    },

    _empty() {
        const e = this._el('div', 'history-empty');
        e.appendChild(this._el('div', 'stats-empty-emoji', '📊'));
        e.appendChild(this._el('p', '', 'No games recorded yet. Play a game and its stats will appear here.'));
        return e;
    },

    _progress(text) {
        const wrap = this._el('div', 'stats-progress');
        wrap.appendChild(this._el('div', 'stats-progress-text', text || 'Analyzing games…'));
        const bar = this._el('div', 'stats-progress-track');
        this._progressFill = this._el('div', 'stats-progress-fill');
        bar.appendChild(this._progressFill);
        wrap.appendChild(bar);
        return wrap;
    },

    _updateProgress(done, total) {
        if (this._progressFill) this._progressFill.style.width = `${total ? (done / total) * 100 : 0}%`;
        const t = this._content && this._content.querySelector('.stats-progress-text');
        if (t) t.textContent = `Analyzing ${done} of ${total} games…`;
    },

    _note(text) { return this._el('div', 'stats-note', text); },

    /* ==================== Tap/hover tooltip ====================
       Touch-friendly: tap a mark to reveal its exact count/value (native title
       tooltips never fire on touch). Hover shows it transiently on desktop; a
       tap pins it until you tap elsewhere, scroll, or press Escape. */

    _tip() {
        if (!this._tipEl) {
            this._tipEl = this._el('div', 'stats-tip');
            this._tipEl.hidden = true;
            document.body.appendChild(this._tipEl);
            document.addEventListener('click', e => {
                if (this._tipEl.hidden) return;
                if (e.target && e.target.closest && e.target.closest('.stats-tappable')) return;
                this._hideTip();
            });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') this._hideTip(); });
            window.addEventListener('scroll', () => this._hideTip(), true);
        }
        return this._tipEl;
    },

    _showTip(target, text) {
        const tip = this._tip();
        tip.textContent = text;
        tip.hidden = false;
        const r = target.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
        let top = r.top - th - 8;
        if (top < 6) top = r.bottom + 8;   // flip below when there's no room above
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        if (this._tipTarget && this._tipTarget !== target) this._tipTarget.classList.remove('is-active');
        this._tipTarget = target;
        target.classList.add('is-active');
    },

    _hideTip() {
        this._pinned = false;
        if (this._tipEl) this._tipEl.hidden = true;
        if (this._tipTarget) { this._tipTarget.classList.remove('is-active'); this._tipTarget = null; }
        if (this._areaDot) { this._areaDot.hidden = true; this._areaDot = null; }
    },

    /** Make `el` reveal `text` on tap (pins) and on hover (transient). */
    _bindTip(el, text) {
        el.classList.add('stats-tappable');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', text);
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (this._pinned && this._tipTarget === el) this._hideTip();
            else { this._showTip(el, text); this._pinned = true; }
        });
        el.addEventListener('mouseenter', () => { if (!this._pinned) this._showTip(el, text); });
        el.addEventListener('mouseleave', () => { if (!this._pinned) this._hideTip(); });
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._showTip(el, text); this._pinned = true; }
        });
        return el;
    },

    /* ==================== Colours & formatting ==================== */

    _diffColor(d) { return `color-mix(in srgb, var(--accent) ${[0, 42, 56, 70, 85, 100][d]}%, var(--surface-alt))`; },
    _archColor(k) { return `var(--arch-${k})`; },
    _tileColor(name) {
        const tile = (BOARD || []).find(t => t.name === name);
        return tile && tile.group && GROUP_META[tile.group] ? GROUP_META[tile.group].color : 'var(--accent)';
    },

    _niceRateMax(rows) { const m = Math.max(0.0001, ...rows.map(r => r.value)); return Math.min(1, Math.ceil(m * 10) / 10); },

    _pct: (x) => `${Math.round(x * 100)}%`,
    _plural: (n, w) => `${n} ${n === 1 ? w.replace(/s$/, '') : w}`,
    _cap: (s) => s.charAt(0).toUpperCase() + s.slice(1),
    _fmtInt: (n) => (n || 0).toLocaleString('en-US'),
    _fmtMoney(n) { return `$${(n || 0).toLocaleString('en-US')}`; },
    /** Compact money for KPI tiles so long figures don't overflow ($787K, $1.2M);
        the exact value is offered via the tile's tap tooltip. */
    _fmtMoneyShort(n) {
        n = n || 0; const abs = Math.abs(n);
        if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
        if (abs >= 1e4) return `$${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
        return this._fmtMoney(n);
    },
    _fmtDur(sec) {
        if (!sec) return '0m';
        const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
        return h ? `${h}h ${m}m` : `${m}m`;
    },

    _duration(start, end) {
        if (!start || !end) return 0;
        const a = Date.parse(start.replace(' ', 'T')), b = Date.parse(end.replace(' ', 'T'));
        return (isNaN(a) || isNaN(b) || b < a) ? 0 : Math.round((b - a) / 1000);
    },

    /* ==================== DOM helpers (mirror HistoryUI) ==================== */

    _el(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    }
};

if (typeof window !== 'undefined') window.StatsUI = StatsUI;
