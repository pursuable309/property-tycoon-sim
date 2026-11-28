/**
 * UI: Board Renderer
 *
 * Renders the 40 tiles once, then updates ownership / buildings / tokens on
 * every stateChanged. Ring layout: 11x11 CSS grid on all displays.
 *
 * Exports: window.BoardRenderer
 */

const BoardRenderer = {

    COLORS_DEFAULT: ['#E53935', '#1E88E5', '#43A047', '#FDD835', '#8E24AA', '#FB8C00', '#00ACC1', '#6D4C41'],
    // Okabe-Ito palette: distinguishable under the common color-vision deficiencies
    COLORS_COLORBLIND: ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#999999'],
    TOKEN_COLORS: null, // one of the two above; switched by SettingsUI.apply()
    TOKEN_ICONS: {
        hat: '🎩', car: '🚗', dog: '🐕', ship: '🚢', boot: '👢',
        cat: '🐈', moneybag: '💰', horse: '🐎', thimble: '🧵', train: '🚂'
    },

    _built: false,

    build() {
        const board = document.getElementById('board');
        BOARD.forEach(tile => {
            const el = document.createElement('div');
            el.className = `tile tile-${tile.type}`;
            el.dataset.tileId = tile.id;
            const pos = tileGridPos(tile.id);
            el.style.gridRow = pos.row;
            el.style.gridColumn = pos.col;

            // Only colour-group streets carry a band; railroads, utilities,
            // taxes and the card tiles show a line glyph instead
            if (tile.type === 'property') {
                const band = document.createElement('div');
                band.className = 'tile-band';
                band.style.background = GROUP_META[tile.group].color;
                el.appendChild(band);
            }
            const glyph = this._glyph(tile);
            if (glyph) {
                el.classList.add('tile-has-glyph');
                const g = document.createElement('div');
                g.className = 'tile-glyph';
                g.innerHTML = Icons.svg(glyph); // static markup from icons.js
                el.appendChild(g);
            }
            const name = document.createElement('div');
            name.className = 'tile-name';
            name.textContent = this._shortName(tile);
            el.appendChild(name);

            const marks = document.createElement('div');
            marks.className = 'tile-marks';
            el.appendChild(marks);

            const tokens = document.createElement('div');
            tokens.className = 'tile-tokens';
            el.appendChild(tokens);

            el.addEventListener('click', () => {
                if (typeof PropertyUI === 'undefined' || !window.engine || !engine.state) return;
                // Deeds for ownable squares; what the square does for the rest
                if (Rules.isOwnable(tile.id)) PropertyUI.showTile(tile.id);
                else PropertyUI.showSpace(tile.id);
            });
            board.appendChild(el);
        });
        this._built = true;
    },

    /** Line glyph (icons.js name) for a tile with no colour band. */
    _glyph(tile) {
        switch (tile.type) {
            case 'railroad': return 'train';
            case 'utility': return /water/i.test(tile.name) ? 'drop' : 'bolt';
            case 'tax': return /luxury/i.test(tile.name) ? 'gem' : 'percent';
            case 'chance': return 'question';
            case 'chest': return 'chest';
            default: return null;
        }
    },

    /**
     * A seat's colour for TEXT: the token colour, darkened (light theme) or
     * lightened (dark theme) until it reads against every surface it sits on
     * (cards, sheet rows, the board centre: WCAG 4.5:1; 7:1 in the High
     * Contrast style). The raw yellow on white was close to invisible, and
     * a white-only target left 3.5:1 on the green board centre. Dots,
     * borders and tints keep TOKEN_COLORS.
     */
    inkColor(id) {
        const base = this.TOKEN_COLORS[id];
        if (!base) return 'inherit';
        const dark = !!(window.Theme && Theme.resolved() === 'dark');
        // High Contrast asks for more (AAA) on its pure black / white cards
        const strict = !!(window.Style && Style.current() === 'contrast');
        const surfaces = this._surfaces();
        const key = base + (dark ? ':d' : ':l') + (strict ? ':hc' : '') + ':' + surfaces.join(',');
        if (!this._inkCache[key]) this._inkCache[key] = this._readable(base, dark, strict ? 7 : 4.5, surfaces);
        return this._inkCache[key];
    },

    _inkCache: {},

    /** The current theme's surface colours (hex tokens) seat names sit on. */
    _surfaces() {
        const cs = getComputedStyle(document.documentElement);
        return ['--surface', '--surface-alt', '--board-bg']
            .map(v => cs.getPropertyValue(v).trim().toLowerCase())
            .filter(v => /^#[0-9a-f]{6}$/.test(v));
    },

    _readable(hex, dark, target, surfaces) {
        const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        const lum = c => {
            const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        // Surfaces the names sit on: white / near-black cards, plus the
        // theme's own light (or dark) surfaces; a surface on the other side
        // (Felt's dark baize in the light theme) can't be met by darkening
        const bgs = [dark ? lum([27, 25, 21]) : 1].concat((surfaces || [])
            .map(h => lum([1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))))
            .filter(l => dark ? l < 0.1 : l > 0.4));
        const ratio = c => { const l = lum(c); return Math.min(...bgs.map(bg => (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05))); };
        const toward = dark ? 255 : 0;
        let c = rgb.slice();
        for (let i = 0; i < 60 && ratio(c) < target; i++) c = c.map(v => Math.round(v + (toward - v) * 0.05));
        return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
    },

    _shortName(tile) {
        const abbr = {
            go: 'GO', jail: 'JAIL', parking: 'FREE', gotojail: 'GO TO JAIL',
            chance: '?', chest: 'CC', tax: tile.name
        };
        if (abbr[tile.type] !== undefined && tile.type !== 'tax') return abbr[tile.type];
        return tile.name;
    },

    render(state) {
        if (!this._built) this.build();

        const move = this._detectMove(state);
        this._cancelMoveAnim();

        const current = state.players[state.currentPlayer];
        BOARD.forEach(tile => {
            const el = document.querySelector(`.tile[data-tile-id="${tile.id}"]`);
            const ts = state.tiles[String(tile.id)];
            const marks = el.querySelector('.tile-marks');
            el.classList.toggle('mortgaged', !!(ts && ts.mortgaged));

            const isActive = !current.bankrupt && current.position === tile.id &&
                state.phase !== GamePhase.GAME_OVER;
            el.classList.toggle('tile-active', isActive);
            if (isActive) el.style.setProperty('--active-color', this.TOKEN_COLORS[current.id]);
            else el.style.removeProperty('--active-color');

            const owned = !!(ts && ts.owner !== null && ts.owner !== undefined);
            el.classList.toggle('tile-owned', owned);
            if (owned) el.style.setProperty('--owner', this.TOKEN_COLORS[ts.owner]);
            else el.style.removeProperty('--owner');

            // Marks are rebuilt only when what they show changes, so an
            // animation on them (motion.js: pips, an owner swap) isn't cut
            // short by the next render
            const ownerP = owned ? state.players[ts.owner] : null;
            const sig = owned ? `${ts.owner}|${ownerP && ownerP.token}|${this.TOKEN_COLORS[ts.owner]}|${ts.houses}` : '';
            if (marks.dataset.sig === sig) {
                // unchanged
            } else if (!owned) {
                marks.dataset.sig = sig;
                marks.innerHTML = '';
            } else {
                marks.dataset.sig = sig;
                marks.innerHTML = '';
                const dot = document.createElement('span');
                dot.className = 'owner-dot';
                dot.style.background = this.TOKEN_COLORS[ts.owner];
                marks.appendChild(dot);
                // Ownership display "Tokens": the owner's token emoji in a thin
                // seat-colour ring; tile.css shows it or the dot by the setting
                marks.appendChild(this.ownerEmoji(ownerP, ts.owner));
                if (ts.houses === 5) {
                    const hotel = document.createElement('span');
                    hotel.className = 'hotel-pip';
                    marks.appendChild(hotel);
                } else {
                    for (let i = 0; i < (ts ? ts.houses : 0); i++) {
                        const pip = document.createElement('span');
                        pip.className = 'house-pip';
                        marks.appendChild(pip);
                    }
                }
            }

            if (tile.type === 'parking') this._renderPot(el, state);

            const tokens = el.querySelector('.tile-tokens');
            tokens.innerHTML = '';
            // Tokens stack in an overlapping grid from the tile's bottom-right
            // corner (1 / 2x2 / 3x3; sizes in tile.css follow the tile), the
            // current player first so its larger disc grows into the tile.
            const here = state.players.filter(p => !p.bankrupt && p.position === tile.id);
            here.sort((a, b) => (b.id === state.currentPlayer) - (a.id === state.currentPlayer));
            const cols = here.length <= 1 ? 1 : here.length <= 4 ? 2 : 3;
            tokens.style.setProperty('--tok-cols', cols);
            here.forEach((p, i) => {
                const tok = document.createElement('span');
                tok.className = 'token';
                tok.title = p.name;
                tok.textContent = this.TOKEN_ICONS[p.token] || '●';
                tok.style.setProperty('--seat', this.TOKEN_COLORS[p.id]);
                tok.style.setProperty('--col', i % cols);
                tok.style.setProperty('--row', Math.floor(i / cols));
                if (p.id === state.currentPlayer) tok.classList.add('token-current');
                tokens.appendChild(tok);
            });
        });

        if (move) this._animateMove(move);

        this._prevPositions = {};
        state.players.forEach(p => { this._prevPositions[p.id] = p.position; });

    },

    /**
     * Free Parking pot: shown whenever the house rule is active (even at $0, so
     * players can see the rule is on and watch it grow).
     */
    _renderPot(el, state) {
        let pot = el.querySelector('.parking-pot');
        if (!(state.rules && state.rules.freeParking)) { if (pot) pot.remove(); return; }
        const amount = state.freeParkingPot || 0;
        if (!pot) {
            pot = document.createElement('div');
            pot.className = 'parking-pot';
            el.appendChild(pot);
        }
        pot.innerHTML = `<div class="parking-amount">$${amount}</div>`;
    },

    /* ==================== TOKEN MOVEMENT ANIMATION ==================== */

    _prevPositions: null,
    _moveTimer: null,

    /** A single player walked forward 2-12 tiles since the last render. */
    _detectMove(state) {
        if (!Anim.on('walk')) return null;
        if (!this._prevPositions) return null;
        const moved = state.players.filter(p => !p.bankrupt &&
            this._prevPositions[p.id] !== undefined && this._prevPositions[p.id] !== p.position);
        if (moved.length !== 1) return null;
        const p = moved[0];
        if (p.inJail) return null; // sent directly to jail, no walking
        const steps = (p.position - this._prevPositions[p.id] + 40) % 40;
        if (steps < 2 || steps > 12) return null;
        return { player: p, from: this._prevPositions[p.id], steps };
    },

    /** Hop a temp token tile-by-tile, then reveal the real one with a pop. */
    _animateMove(move) {
        const finalTile = document.querySelector(`.tile[data-tile-id="${move.player.position}"] .tile-tokens`);
        const realTok = finalTile &&
            Array.from(finalTile.querySelectorAll('.token')).find(t => t.title === move.player.name);
        if (!realTok) return;
        realTok.classList.add('token-hidden');

        let i = 0;
        // Anim stepMs 0 = auto: ~0.9 s for the whole move
        const stepMs = Anim.get('stepMs') || Math.max(80, Math.min(130, Math.floor(900 / move.steps)));
        this._moveTimer = setInterval(() => {
            i += 1;
            document.querySelectorAll('.token-temp').forEach(el => el.remove());
            if (i >= move.steps) {
                this._cancelMoveAnim();
                realTok.classList.add('token-land');
                return;
            }
            const tokens = document.querySelector(`.tile[data-tile-id="${(move.from + i) % 40}"] .tile-tokens`);
            if (!tokens) { this._cancelMoveAnim(); return; }
            const tmp = document.createElement('span');
            tmp.className = 'token token-temp';
            tmp.textContent = this.TOKEN_ICONS[move.player.token] || '●';
            tmp.style.setProperty('--seat', this.TOKEN_COLORS[move.player.id]);
            tokens.appendChild(tmp);
        }, stepMs);
    },

    _cancelMoveAnim() {
        if (this._moveTimer) { clearInterval(this._moveTimer); this._moveTimer = null; }
        document.querySelectorAll('.token-temp').forEach(el => el.remove());
        document.querySelectorAll('.token-hidden').forEach(el => el.classList.remove('token-hidden'));
    },

    /* ==================== TILE FLASH CUES ==================== */

    /** The "Tokens" ownership mark: an owner's token emoji (tile.css .owner-emoji). */
    ownerEmoji(player, ownerId) {
        const em = document.createElement('span');
        em.className = 'owner-emoji';
        em.textContent = (player && this.TOKEN_ICONS[player.token]) || '●';
        em.style.setProperty('--seat', this.TOKEN_COLORS[ownerId]);
        return em;
    },

    /** Pulse a tile so board events stay visible even when the token teleports. */
    flashTile(tileId, kind) {
        if (!Anim.on('highlights')) return;
        const el = document.querySelector(`.tile[data-tile-id="${tileId}"]`);
        if (!el) return;
        const cls = `tile-flash-${kind}`;
        el.classList.remove(cls);
        void el.offsetWidth; // restart the animation when flashes repeat quickly
        el.classList.add(cls);
        el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
    }
};

BoardRenderer.TOKEN_COLORS = BoardRenderer.COLORS_DEFAULT;

// Seat text colours depend on the resolved theme: repaint when it flips
// (system light/dark change, or the Theme setting)
if (typeof document !== 'undefined') {
    document.addEventListener('themechange', () => {
        if (window.engine && typeof EventBus !== 'undefined') EventBus.emit('stateChanged', window.engine.state);
    });
}

if (typeof window !== 'undefined') {
    window.BoardRenderer = BoardRenderer;
}
