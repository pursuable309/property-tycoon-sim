/**
 * UI: Game Log
 *
 * Two surfaces onto the same event stream (state.log):
 *   - the board-center feed (#announce): this turn's headline events, the
 *     latest in full, the earlier ones muted above it (.announce-prev).
 *     Swipe down on it (or wheel) to page back through earlier headlines,
 *     up to come back; it returns to live after FEED_IDLE_MS untouched.
 *   - the full Game Log modal (📜 button): a LIVE, auto-scrolling feed that
 *     appends events as they occur and can be filtered by event type.
 *
 * Player names in entries are colored with their token color.
 *
 * Exports: window.LogUI
 */

const LogUI = {

    /**
     * Event categories, in chip/legend order. Each has a matcher against the
     * log text (first hit wins); entries carrying an explicit `entry.cat`
     * (e.g. AI-reasoning detail lines) bypass the matchers. Anything unmatched
     * falls into 'other'.
     */
    CATEGORIES: [
        { key: 'buy',      label: 'Buys',       icon: '💰', cls: 'log-hl-buy',      re: / buys .* for \$/ },
        { key: 'rent',     label: 'Rent',       icon: '💸', cls: 'log-hl-rent',     re: / rent / },
        { key: 'trade',    label: 'Trades',     icon: '🤝', cls: 'log-hl-trade',    re: /^Trade completed|proposes a trade|makes a counter-offer|rejects the trade/ },
        { key: 'build',    label: 'Building',   icon: '🏗', cls: 'log-hl-build',    re: / (builds|sells) (a|the) (house|hotel)/ },
        { key: 'mortgage', label: 'Mortgage',   icon: '🏦', cls: 'log-hl-mortgage', re: / (un)?mortgages / },
        { key: 'card',     label: 'Cards',      icon: '🃏', cls: 'log-hl-card',     re: / draws: "/ },
        { key: 'ai',       label: 'AI reasoning', icon: '🤖', cls: 'log-hl-ai',     re: null },
        { key: 'bankrupt', label: 'Bankruptcy', icon: '💀', cls: 'log-hl-bankrupt', re: / is bankrupt\./ },
        { key: 'other',    label: 'Other',      icon: '📋', cls: null,              re: null }
    ],

    /** Short wording for the board-centre feed where a line doesn't fit its
     *  box (cover centres are 2-4 lines of ~16-25 characters): the same
     *  event, fewer words, so it shows whole instead of clamped. The full
     *  wording stays in the log. [pattern on the log text, replacement]. */
    FEED_SHORT: [
        [/^(.+)'s turn$/, '▶ $1'],
        [/^(.+) cannot pay \$(\d+) and must raise cash or go bankrupt\.$/, "$1 can't pay $$$2"],
        [/^Trade completed between (.+) and (.+)\.$/, '🤝 $1 ⇄ $2'],
        [/^(.+) proposes a trade to (.+)\.$/, '$1 offers $2 a trade'],
        [/^(.+) makes a counter-offer\.$/, '$1 counters'],
        [/^(.+) rejects the trade\.$/, '$1 says no'],
        [/^Trade is no longer valid: .*$/, 'Trade no longer valid'],
        [/^(.+) rolled doubles three times - go to Jail!$/, '$1: 3 doubles, Jail'],
        [/^(.+) rolls (\d) \+ (\d) in Jail\.$/, '$1 rolls $2+$3 (Jail)'],
        [/^(.+) rolls (\d) \+ (\d) for the utility fee\.$/, '$1 rolls $2+$3 (fee)'],
        [/^(.+) rolls (\d) \+ (\d)( for first move)?\.$/, '$1 rolls $2+$3'],
        [/^(.+) rolled doubles and goes again\.$/, '$1 goes again'],
        [/^(.+) must pay the \$(\d+) fine\.$/, '$1 pays $$$2 fine'],
        [/^(.+) stays in Jail \(turn \d\)\.$/, '$1 stays in Jail'],
        [/^(.+) passes GO and collects \$(\d+)\.$/, '$1 +$$$2 (GO)'],
        [/^(.+) (?:lands on|advances to) (.+)\.$/, '$1 → $2'],
        [/^(.+) moves back to (.+)\.$/, '$1 back to $2'],
        [/^(.+) cannot be bought yet — no one has completed a lap\.$/, '$1: not for sale yet'],
        [/^A lap is complete — properties may now be bought\.$/, 'Lap done: buying opens'],
        [/^(.+) (pays|owes) \$(\d+) rent to (.+)\.$/, '$1 $2 $4 $$$3'],
        [/^(.+) (pays|owes) \$(\d+) in tax\.$/, '$1 $2 $$$3 tax'],
        [/^(.+) draws: "(.+)"$/, '$1: $2'],
        [/^(.+) collects \$(\d+) from Free Parking!$/, '$1 +$$$2 (Parking)'],
        [/^(.+) pays \$(\d+) to each player\.$/, '$1 pays all $$$2'],
        [/^(.+) pays \$(\d+) to (.+)\.$/, '$1 pays $3 $$$2'],
        [/^(.+) pays \$(\d+) and leaves Jail\.$/, '$1 out of Jail ($$$2)'],
        [/^(.+) pays after three failed rolls and leaves Jail\.$/, '$1 pays out of Jail'],
        [/^(.+) rolls doubles and leaves Jail\.$/, '$1: doubles, out of Jail'],
        [/^(.+) owes nothing for repairs\.$/, '$1: no repairs'],
        [/^(.+) goes to (.+)\.$/, '$1 → $2'],
        [/^(.+) keeps a Get Out of Jail Free card\.$/, '$1 keeps a Jail card'],
        [/^(.+) buys (.+) for \$(\d+)\.$/, '$1 buys $2'],
        [/^(.+) builds a house on (.+) \((\d)\)\.$/, '$1 builds $2 ($3)'],
        [/^(.+) builds a hotel on (.+)\.$/, '$1: hotel on $2'],
        [/^(.+) sells a house on (.+) \((\d)\)\.$/, '$1 sells $2 ($3)'],
        [/^(.+) sells the hotel on (.+)\.$/, '$1 sells $2 hotel'],
        [/^(.+) mortgages (.+) for \$(\d+)\.$/, '$1 mortgages $2'],
        [/^(.+) unmortgages (.+) for \$(\d+)\.$/, '$1 unmortgages $2'],
        [/^(.+) lifts the mortgage on (.+) for \$(\d+)\.$/, '$1 unmortgages $2'],
        [/^(.+) owes \$(\d+) interest on mortgaged (.+)\.$/, '$1 owes $$$2 interest'],
        [/^(.+) is bankrupt\. Assets go to (.+)\.$/, '$1 bankrupt → $2'],
        [/^Auction started for (.+)\.$/, 'Auction: $1'],
        [/^No bids\. (.+) remains unsold\.$/, '$1 unsold'],
        [/^(.+) wins the game!$/, '$1 wins!']
    ],

    /** The feed's short wording for a log line, or null when it has none. */
    shortText(text) {
        for (const [re, to] of this.FEED_SHORT) {
            if (re.test(text)) {
                const short = text.replace(re, to);
                return short.length < text.length ? short : null;
            }
        }
        return null;
    },

    FEED_MAX: 12,           // most headlines rendered in the feed (CSS clips the oldest to fit)
    FEED_FADE_STEP: 0.16,   // each older line this much more transparent...
    FEED_FADE_MIN: 0.22,    // ...down to this
    FEED_MIN_PX: 13,        // internal: smallest type a too-long latest line shrinks to
    TINT_MS: 700,           // the newest line's brief tint (no movement, no fade)
    _lastAnnounced: null,
    _announcedAt: 0,
    _feedHtml: '',          // the feed's last full render (re-fitted on resize)
    _feedAnchor: null,      // browsing: state.log index of the bottom line shown; null = live
    _feedIdle: null,        // timer that returns a browsed feed to live
    _feedLast: null,        // { state, colors } of the last render, for browsing
    FEED_IDLE_MS: 10000,
    FEED_STEP_PX: 26,       // drag distance per headline
    _feedObserver: null,
    _activeFilters: null,   // Set<categoryKey>; null until first use = all on
    _live: null,            // { gen, list, state, colors } while the modal is open
    _archivedLog: null,     // { gameId, log } pulled from the server archive for
                            // a finished game whose localStorage buffer was dropped
    _archivedPending: null, // gameId of an in-flight archive fetch (dedupe)
    _leverOpen: new Map(),  // "<entry index>|<Exx>" -> expanded? for the open lever panels

    render(state) {
        const colors = {};
        state.players.forEach(p => { colors[p.name] = BoardRenderer.inkColor(p.id); });
        this._announce(state, colors);
        this._refreshLive();   // keep the open modal current as events land
    },

    /** The board centre's feed, read like a chat that only ever moves up a
     *  line at a time: the previous turn's headlines, faded, above a thin
     *  divider, then this turn's, the latest in full at the bottom (detail
     *  lines and the "X's turn" line left out; the turn banner says whose
     *  turn it is). The card keeps its size; lines that don't fit leave at
     *  the top, whole (_fitFeed). A new line never moves or fades: it only
     *  gets a brief tint, kept across re-renders by a negative animation
     *  delay. */
    _announce(state, colors) {
        const el = document.getElementById('announce');
        if (!el || state.log.length === 0) return;
        this._feedLast = { state, colors };
        this._bindFeedSwipe(el);
        if (this._feedAnchor !== null) {
            if (this._feedAnchor >= state.log.length) this._feedAnchor = null;   // a new game
            else return this._announceBack(el, state, colors);
        }
        el.classList.remove('announce-browsing');
        // "X's turn" opens each turn's lines, so a turn starts with it in
        // the big latest-line type
        const isHeadline = e => !e.detail;
        // Walk back through this turn, then the one before it
        const cur = [], prevTurn = [];
        let turn = state.turnNumber, list = cur;
        for (let i = state.log.length - 1; i >= 0 && cur.length + prevTurn.length < this.FEED_MAX; i--) {
            const e = state.log[i];
            if (e.turn !== turn) {
                if (list === prevTurn) break;
                turn = e.turn; list = prevTurn;
            }
            if (isHeadline(e)) list.unshift(e);
            if (/ goes first\.$/.test(e.text)) break;   // nothing before the first turn
        }
        if (!cur.length && !prevTurn.length) { el.innerHTML = ''; return; }
        const latest = cur.length ? cur[cur.length - 1] : null;
        const key = latest ? `${latest.turn}:${cur.length}:${latest.text}` : `none:${state.turnNumber}`;
        const now = Date.now();
        if (key !== this._lastAnnounced) {
            this._lastAnnounced = key;
            this._announcedAt = latest ? now : 0;
        }
        const age = now - this._announcedAt;
        const tint = !!latest && Anim.on('highlights') && age < this.TINT_MS;
        // Oldest first: the previous turn, a divider, then this turn (the
        // internal display's card has a fixed height, leaving the room
        // above it for toasts; _fitFeed keeps what fits)
        let items = prevTurn.map(e => ({ e, old: true }));
        if (prevTurn.length && cur.length) items.push({ hr: true });
        items = items.concat(cur.map(e => ({ e })));
        // Each line fades the older it is (opacity steps from the latest)
        const n = items.length;
        const fade = k => k === 0 ? 1 : Math.max(this.FEED_FADE_MIN, 0.82 - (k - 1) * this.FEED_FADE_STEP);
        const html = items.map((it, idx) => {
            const k = n - 1 - idx;
            const op = `opacity:${fade(k).toFixed(2)}`;
            if (it.hr) return `<hr class="announce-turn" aria-hidden="true" style="${op}">`;
            const main = latest && it.e === latest;
            const cls = main ? 'announce-main' : `announce-prev${it.old ? ' announce-old' : ''}`;
            // A shorter wording rides along for lines that don't fit (_fitFeed)
            const short = this.shortText(it.e.text);
            const alt = short ? ` data-short="${this._esc(this._colorize(short, colors)).replace(/"/g, '&quot;')}"` : '';
            return `<span class="${cls}" style="${op}"${alt}>${this._colorize(it.e.text, colors)}</span>`;
        }).join('');
        el.innerHTML = html;
        if (tint) {
            el.lastElementChild.classList.add('announce-new');
            el.lastElementChild.style.animationDelay = `-${age}ms`;
        }
        this._feedHtml = html;   // without the tint, for re-fits
        this._fitFeed(el);
        if (!this._feedObserver && typeof ResizeObserver !== 'undefined') {
            // The centre changes size with the layout (resize, cover cameras,
            // the Buttons setting): lay the same lines out again to fit
            let w = 0, h = 0;
            this._feedObserver = new ResizeObserver(() => {
                if (el.clientWidth === w && el.clientHeight === h) return;
                w = el.clientWidth; h = el.clientHeight;
                if (!this._feedHtml) return;
                el.innerHTML = this._feedHtml;
                this._fitFeed(el);
            });
            this._feedObserver.observe(el.parentElement || el);
        }
    },

    /** Browsing: the headlines up to state.log[_feedAnchor], oldest first, with
     *  a divider where the turn changes; the bottom one in the big type.
     *  New events don't move it (the anchor is a log index). */
    _announceBack(el, state, colors) {
        const items = [];
        let turn = null;
        for (let i = this._feedAnchor; i >= 0 && items.length < this.FEED_MAX * 2; i--) {
            const e = state.log[i];
            if (e.detail) continue;
            if (turn !== null && e.turn !== turn) items.unshift({ hr: true });
            turn = e.turn;
            items.unshift({ e });
        }
        const last = items.length - 1;
        el.innerHTML = items.map((it, idx) => {
            if (it.hr) return '<hr class="announce-turn" aria-hidden="true">';
            const cls = idx === last ? 'announce-main' : 'announce-prev';
            const short = this.shortText(it.e.text);
            const alt = short ? ` data-short="${this._esc(this._colorize(short, colors)).replace(/"/g, '&quot;')}"` : '';
            return `<span class="${cls}"${alt}>${this._colorize(it.e.text, colors)}</span>`;
        }).join('');
        el.classList.add('announce-browsing');
        this._feedHtml = el.innerHTML;
        this._fitFeed(el);
    },

    /** Headline log indices (what the feed shows), oldest first. */
    _headlines(state) {
        const out = [];
        state.log.forEach((e, i) => { if (!e.detail) out.push(i); });
        return out;
    },

    /** Move the browse anchor by `steps` headlines: + = older, - = newer;
     *  past the newest it goes live again. */
    _feedStep(steps) {
        const last = this._feedLast;
        if (!last || !steps) return;
        const heads = this._headlines(last.state);
        if (!heads.length) return;
        let pos = this._feedAnchor === null ? heads.length - 1 : heads.indexOf(this._feedAnchor);
        if (pos < 0) pos = heads.length - 1;
        pos = Math.max(0, pos - steps);
        this._feedAnchor = pos >= heads.length - 1 ? null : heads[pos];
        clearTimeout(this._feedIdle);
        if (this._feedAnchor !== null) {
            this._feedIdle = setTimeout(() => { this._feedAnchor = null; this._replay(); }, this.FEED_IDLE_MS);
        }
        this._replay();
    },

    _replay() {
        const last = this._feedLast;
        if (last) this._announce(last.state, last.colors);
    },

    /** Swipe (pointer drag) and wheel on the feed: down = earlier lines. */
    _bindFeedSwipe(el) {
        if (el.dataset.swipeBound) return;
        el.dataset.swipeBound = '1';
        let startY = null, moved = 0;
        el.addEventListener('pointerdown', e => {
            startY = e.clientY; moved = 0;
            if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* gone */ } }
        });
        el.addEventListener('pointermove', e => {
            if (startY === null) return;
            const steps = Math.trunc((e.clientY - startY) / this.FEED_STEP_PX) - moved;
            if (steps) { moved += steps; this._feedStep(steps); }
        });
        const end = () => { startY = null; };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
        el.addEventListener('wheel', e => {
            e.preventDefault();
            this._feedStep(e.deltaY < 0 ? 1 : -1);   // wheel up = earlier, like a chat
        }, { passive: false });
    },

    /** Drop the oldest earlier lines, whole, until the feed fits its card:
     *  a line is never shown cut through, and the latest always shows from
     *  its start (alone, it may be clamped at the bottom by the CSS). */
    _fitFeed(el) {
        // Bottom-anchored (flex-end): what doesn't fit spills out of the
        // top, which scrollHeight doesn't count, so compare edges
        const spills = () => {
            const first = el.firstElementChild;
            if (!first) return false;
            const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
            return first.getBoundingClientRect().top < el.getBoundingClientRect().top + pad - 1;
        };
        // Off the internal display (whose latest line grows instead), a
        // line cut by its clamp takes its short wording first
        if (typeof ScreenManager === 'undefined' || ScreenManager.getScreenType() !== 'internal') {
            for (const line of el.children) {
                if (line.dataset.short && line.scrollHeight > line.clientHeight + 1) {
                    line.innerHTML = line.dataset.short;
                    delete line.dataset.short;
                }
            }
            // Still cut (the smallest centre has one line): the latest line
            // drops its leading name when the turn line above already shows
            // it ("Can't pay $1400", "→ St. Charles Place")
            const main = el.querySelector('.announce-main');
            const name = main && main.firstElementChild;
            const banner = document.getElementById('turn-banner');
            if (main && main.scrollHeight > main.clientHeight + 1 && name && name.classList.contains('log-name') &&
                !name.previousSibling && banner && banner.textContent.includes(name.textContent)) {
                name.remove();
                const rest = main.firstChild;
                if (rest && rest.nodeType === 3) {
                    const t = rest.textContent.replace(/^[\s:]+/, '');
                    rest.textContent = t.charAt(0).toUpperCase() + t.slice(1);
                }
            }
        }
        // Oldest first; a divider left at the top goes with them
        while (el.firstElementChild && el.firstElementChild !== el.lastElementChild && spills()) {
            el.firstElementChild.remove();
            if (el.firstElementChild && el.firstElementChild.tagName === 'HR') el.firstElementChild.remove();
        }
        // Alone and still too tall: internal shows it whole (no …), in
        // smaller type down to FEED_MIN_PX, then by growing the card (toasts
        // then go over its top); elsewhere (short wording already in, FitText
        // shrinks it next) clamp it to the whole lines that fit rather than
        // cut a line (Chrome ends a clamp in "…": ui-check warns on it)
        const last = el.lastElementChild;
        el.style.minHeight = '';
        if (last && typeof ScreenManager !== 'undefined' && ScreenManager.getScreenType() === 'internal') {
            const pad = parseFloat(getComputedStyle(el).paddingTop) + parseFloat(getComputedStyle(el).paddingBottom);
            let px = parseFloat(getComputedStyle(last).fontSize);
            while (last.scrollHeight > last.clientHeight + 1 && px > this.FEED_MIN_PX) {
                px -= 1;
                last.style.fontSize = `${px}px`;
            }
            if (last.scrollHeight > last.clientHeight + 1) el.style.minHeight = `${Math.ceil(last.scrollHeight + pad)}px`;
            return;
        }
        if (last && last.scrollHeight > last.clientHeight + 1) {
            const lh = parseFloat(getComputedStyle(last).lineHeight) || 18;
            last.style.webkitLineClamp = String(Math.max(1, Math.floor((last.clientHeight + 1) / lh)));
        }
    },

    _filters() {
        if (!this._activeFilters) {
            this._activeFilters = new Set(this.CATEGORIES.map(c => c.key));
        }
        return this._activeFilters;
    },

    /** Live full game log in a modal: auto-scrolls as events occur, filterable.
     *  opts (archive view, see showRecord): { title, onClose, archived } —
     *  archived skips live updates, the archive fetch and the cap note. */
    showFull(state, opts) {
        opts = opts || {};
        const colors = {};
        state.players.forEach(p => { colors[p.name] = BoardRenderer.inkColor(p.id); });
        const active = this._filters();

        const body = document.createElement('div');
        body.className = 'log-modal';
        body.innerHTML = `
            <div class="log-toolbar">
                <button type="button" class="log-filter-toggle" aria-expanded="false">
                    <span class="log-icon">🔎</span><span>Filter</span>
                </button>
                <span class="log-filter-summary"></span>
            </div>
            <div class="log-filter-chips" hidden>
                <div class="log-chip-quick">
                    <button type="button" class="log-chip-all" data-all="1">All</button>
                    <button type="button" class="log-chip-all" data-all="0">None</button>
                </div>
                ${this.CATEGORIES.map(c => `
                    <button type="button" class="log-chip ${c.cls || ''}" data-key="${c.key}"
                            aria-pressed="${active.has(c.key)}">
                        <span class="log-icon">${c.icon}</span>${c.label}
                    </button>`).join('')}
            </div>
            <div class="log-full-list" tabindex="0"></div>`;

        const list = body.querySelector('.log-full-list');
        const chips = body.querySelector('.log-filter-chips');
        const summary = body.querySelector('.log-filter-summary');

        // Lever tags on CPU reasoning lines: a chip opens the effort's panel, "More" expands it
        this._leverOpen = new Map();
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('.lever-chip, .lever-more');
            if (!btn || !list.contains(btn)) return;
            const key = btn.dataset.key;
            if (btn.classList.contains('lever-chip')) {
                if (this._leverOpen.has(key)) this._leverOpen.delete(key); else this._leverOpen.set(key, false);
            } else {
                this._leverOpen.set(key, !this._leverOpen.get(key));
            }
            const top = list.scrollTop;
            list.innerHTML = this._buildList(state, colors);
            list.scrollTop = top;
        });

        const renderList = (stick) => {
            list.innerHTML = this._buildList(state, colors);
            if (stick !== false) list.scrollTop = list.scrollHeight;
            const total = this.CATEGORIES.length;
            summary.textContent = active.size >= total
                ? 'All events'
                : `${active.size} of ${total} types`;
        };
        const syncChips = () => {
            chips.querySelectorAll('.log-chip').forEach(chip => {
                chip.setAttribute('aria-pressed', active.has(chip.dataset.key));
            });
        };

        body.querySelector('.log-filter-toggle').addEventListener('click', (e) => {
            const btn = e.currentTarget;
            const open = chips.hidden;
            chips.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
        });
        chips.addEventListener('click', (e) => {
            const chip = e.target.closest('.log-chip');
            if (chip) {
                const key = chip.dataset.key;
                if (active.has(key)) active.delete(key); else active.add(key);
                syncChips();
                renderList();
                return;
            }
            const all = e.target.closest('.log-chip-all');
            if (all) {
                active.clear();
                if (all.dataset.all === '1') this.CATEGORIES.forEach(c => active.add(c.key));
                syncChips();
                renderList();
            }
        });

        Modals.show({
            title: opts.title || '📜 Game Log',
            body: body,
            buttons: [{ label: 'Close', class: 'btn-secondary', onClick: opts.onClose }]
        });
        renderList();
        if (opts.archived) { this._live = null; return; }
        // Register for live updates (see _refreshLive, driven by render()).
        this._live = { gen: Modals._generation, list, state, colors, summary,
                       lastLen: this._fullLog(state).length };
        // A finished game has no buffer; pull its full log from the archive
        // and repaint once it arrives so filters cover the whole game.
        this._ensureFullLog(state, () => {
            if (this._live && Modals._generation === this._live.gen) {
                renderList();
                this._live.lastLen = this._fullLog(state).length;
            }
        });
    },

    /** Read-only log of an archived game record (History tab detail). The
     *  record's log is the complete, uncapped event stream. */
    showRecord(record, opts) {
        const players = (Array.isArray(record.players) ? record.players : [])
            .map((p, i) => ({ id: Number.isInteger(p && p.id) ? p.id : i, name: String((p && p.name) || '') }));
        const log = (Array.isArray(record.log) ? record.log : [])
            .filter(e => e && typeof e === 'object')
            .map(e => Object.assign({}, e, { text: String(e.text == null ? '' : e.text) }));
        const state = { players, log, gameId: null, archived: true };
        this.showFull(state, Object.assign({ archived: true }, opts));
    },

    /** Rebuild the open modal's list in place as new events arrive, keeping the
     *  user pinned to the newest event only if they were already at the bottom. */
    _refreshLive() {
        if (!this._live) return;
        if (!Modals.isOpen() || Modals._generation !== this._live.gen) {
            this._live = null;
            return;
        }
        const { list, state, colors, summary } = this._live;
        const source = this._fullLog(state);
        if (source.length === this._live.lastLen) return; // no new events to fold in
        this._live.lastLen = source.length;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
        list.innerHTML = this._buildList(state, colors);
        if (atBottom) list.scrollTop = list.scrollHeight;
        const total = this.CATEGORIES.length;
        summary.textContent = this._filters().size >= total
            ? 'All events' : `${this._filters().size} of ${total} types`;
    },

    /**
     * The complete event log for display. state.log is capped at LOG_CAP to
     * keep the autosave small, but the game-history buffer keeps every entry;
     * pull from there when available so the modal shows the whole game, not
     * just the tail. A finished game releases its buffer on game-over, so also
     * accept a full log fetched from the server archive by _ensureFullLog.
     * Falls back to the capped log for games with no record at all (headless
     * DEV.simulate, offline finished-game review) or before the first sync.
     */
    _fullLog(state) {
        if (state.gameId && typeof StorageManager !== 'undefined' && typeof STORAGE_KEYS !== 'undefined') {
            const rec = StorageManager.get(STORAGE_KEYS.HISTORY_GAME_PREFIX + state.gameId, null);
            if (rec && Array.isArray(rec.log) && rec.log.length >= state.log.length) {
                return rec.log;
            }
        }
        if (this._archivedLog && this._archivedLog.gameId === state.gameId &&
            this._archivedLog.log.length >= state.log.length) {
            return this._archivedLog.log;
        }
        return state.log;
    },

    /**
     * When the in-memory log is capped and no buffer holds the full history
     * (a finished game released its buffer on game-over), pull the complete
     * log from the server archive once and repaint via cb. Best-effort: an
     * offline or missing record just keeps the capped view and its note.
     */
    _ensureFullLog(state, cb) {
        if (this._fullLog(state) !== state.log) return;        // full log already on hand
        if ((state.logCount || 0) <= state.log.length) return; // nothing was trimmed away
        if (!state.gameId || typeof GameHistory === 'undefined') return;
        if (this._archivedPending === state.gameId) return;    // fetch already in flight
        this._archivedPending = state.gameId;
        GameHistory.get(state.gameId).then(rec => {
            this._archivedPending = null;
            if (rec && Array.isArray(rec.log) && rec.log.length > state.log.length) {
                this._archivedLog = { gameId: state.gameId, log: rec.log };
                cb();
            }
        }).catch(() => { this._archivedPending = null; });
    },

    _buildList(state, colors) {
        const active = this._filters();
        const entries = this._fullLog(state);
        let html = '';
        // Only warn about truncation when the full history is genuinely
        // unreachable (no buffered record) and the in-memory log is at its cap.
        if (!state.archived && entries === state.log && state.log.length >= GAME_CONST.LOG_CAP) {
            html += `<div class="log-cap-note">Showing the last ${GAME_CONST.LOG_CAP} events.</div>`;
        }
        let lastTurn = null, shown = 0;
        for (let idx = 0; idx < entries.length; idx++) {
            const entry = entries[idx];
            const cat = this._category(entry);
            if (!active.has(cat.key)) continue;
            if (entry.turn !== lastTurn) {
                lastTurn = entry.turn;
                // Escaped: archived entries come back from the server unvalidated
                html += `<div class="log-turn-divider">Turn ${this._esc(String(entry.turn))}</div>`;
            }
            const icon = cat.icon ? `<span class="log-icon">${cat.icon}</span>` : '';
            const cls = (cat.cls ? ' ' + cat.cls : '') + (entry.detail ? ' log-detail' : '');
            const levers = this._leverTags(entry.levers);
            html += `<div class="log-entry log-full-entry${cls}">${icon}${this._colorize(entry.text, colors)}` +
                `${this._leverChips(levers, idx)}</div>${this._leverPanels(levers, idx)}`;
            shown++;
        }
        if (!shown) html += '<div class="log-cap-note">No matching events.</div>';
        return html;
    },

    /* ---------- Lever tags (CPU reasoning lines, 2026-11-12 on) ----------
     * entry.levers lists the catalogued efforts that changed a CPU decision
     * ("E63 human handover 0.2 on a mutual completion"; CPUPlayer._fire). Each
     * shows as a chip; its panel reads window.EffortNotes (generated from
     * docs/ai/efforts by effort_notes.py): title, status, headline, and on
     * "More" the worked example, knobs and decision date. Archived entries come
     * back from the server unvalidated, so everything is coerced and escaped. */

    /** [{eff, note}] from entry.levers, one per effort (notes merged). */
    _leverTags(levers) {
        if (!Array.isArray(levers)) return [];
        const out = [];
        for (const raw of levers) {
            const m = /^(E\d{1,3})\b\s*(.*)$/.exec(String(raw));
            if (!m) continue;
            const have = out.find(t => t.eff === m[1]);
            if (have) { if (m[2] && !have.note.includes(m[2])) have.note += (have.note ? '; ' : '') + m[2]; }
            else out.push({ eff: m[1], note: m[2] || '' });
        }
        return out;
    },

    _leverChips(tags, idx) {
        if (!tags.length) return '';
        const info = typeof Icons !== 'undefined' ? Icons.svg('info') : '';
        return '<span class="lever-chips">' + tags.map(t => {
            const key = `${idx}|${t.eff}`, open = this._leverOpen.has(key);
            return `<button type="button" class="lever-chip" data-key="${key}" aria-expanded="${open}" ` +
                `title="${this._esc(t.note || t.eff)}">${t.eff}${info}</button>`;
        }).join('') + '</span>';
    },

    _leverPanels(tags, idx) {
        const notes = (typeof window !== 'undefined' && window.EffortNotes) || {};
        let html = '';
        for (const t of tags) {
            const key = `${idx}|${t.eff}`;
            if (!this._leverOpen.has(key)) continue;
            const n = Object.prototype.hasOwnProperty.call(notes, t.eff) ? notes[t.eff] : null;
            const exp = !!this._leverOpen.get(key);
            const st = n ? String(n.status || '') : '';
            html += `<div class="lever-panel">` +
                `<div class="lever-head"><span class="lever-id">${t.eff}</span>` +
                (st ? `<span class="lever-status lever-st-${st.toLowerCase().replace(/[^a-z]/g, '')}">${this._esc(st)}</span>` : '') +
                (n ? `<span class="lever-title">${this._esc(n.title || '')}</span>` : '') + `</div>` +
                (t.note ? `<div class="lever-note">This decision: ${this._esc(t.note)}</div>` : '') +
                (n ? `<div class="lever-headline${exp ? '' : ' lever-clamp'}">${this._esc(n.headline || '')}</div>`
                   : `<div class="lever-headline">${t.eff} is not in this build's catalogue.</div>`);
            if (n && exp) {
                if (n.example) html += `<div class="lever-detail">${this._esc(n.example)}</div>`;
                const facts = [];
                if (Array.isArray(n.knobs) && n.knobs.length) facts.push(`Knobs: ${n.knobs.map(k => this._esc(k)).join(', ')}`);
                if (n.decided) facts.push(`Decided ${this._esc(n.decided)}`);
                facts.push(`Catalogue: docs/ai/efforts/${t.eff}-…`);
                html += `<div class="lever-facts">${facts.join(' · ')}</div>`;
            }
            if (n) html += `<button type="button" class="lever-more" data-key="${key}">${exp ? 'Less' : 'More'}</button>`;
            html += `</div>`;
        }
        return html;
    },

    /** Category for a log entry (explicit entry.cat wins, else match text). */
    _category(entry) {
        if (entry.cat) {
            const c = this.CATEGORIES.find(x => x.key === entry.cat);
            if (c) return c;
        }
        // Detail lines with no explicit category are supporting text ('other').
        if (!entry.detail) {
            for (const c of this.CATEGORIES) {
                if (c.re && c.re.test(entry.text)) return c;
            }
        }
        return this.CATEGORIES[this.CATEGORIES.length - 1]; // 'other'
    },

    _colorize(text, colors) {
        const esc = this._esc(text);
        for (const name of Object.keys(colors)) {
            const escName = this._esc(name);
            const idx = esc.startsWith(escName) ? 0 : (esc.startsWith('--- ' + escName) ? 4 : -1);
            if (idx >= 0) {
                return esc.slice(0, idx) +
                    `<span class="log-name" style="color:${colors[name]}">${escName}</span>` +
                    esc.slice(idx + escName.length);
            }
        }
        return esc;
    },

    _esc(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
};

if (typeof window !== 'undefined') {
    window.LogUI = LogUI;
}
