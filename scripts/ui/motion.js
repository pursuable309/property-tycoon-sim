/**
 * UI: Motion (event-driven board animations)
 *
 * Cosmetic only: listens to engine events and decorates the DOM the renderers
 * already built; never touches game state or the game RNG. Everything here
 * runs only when Anim.on('effects') (Animations = Full, or Custom with Board
 * effects on); Reduced / Off, the OS
 * "reduce motion" setting, a hidden tab and Skip-to-end fast-forwarding all
 * switch it off. (DEV.simulate mutes the EventBus, so it never gets here.)
 *
 *   propertyPurchased / auctionEnded  the tile flips with a glow in the buyer's colour
 *   moneyMoved (player -> player)     coins travel from the payer's card to the payee's,
 *                                     1-6 of them by the amount (coinCount)
 *   tradeCompleted                    each side's deeds (in their tile colours) and coins cross
 *                                     between the two players' cards; as each deed lands, its
 *                                     tile pulses in the new owner's colour and its ownership
 *                                     mark turns over from the old owner's to the new one's
 *                                     (dot / emoji / tint; also for a bankrupt estate)
 *   a colour set completed            its bands shimmer
 *   houses / a hotel built or sold    the new pips drop onto the tile with a bounce; sold
 *                                     ones lift off and fade; one shimmer sweeps the band
 *                                     (backwards on a sale; tiles staggered)
 *   a property (un)mortgaged          the tile flips edge-on and lands showing its new face
 *   playerBankrupt                    that player's card drains to grey; with a player as
 *                                     creditor, the estate's deeds and coins fly to their card
 *   gameOver                          confetti when a human wins (or in a CPU-only game);
 *                                     when a CPU beats a human, the screen shakes under a
 *                                     red vignette instead (defeat)
 *
 * The dice tumble and the cash count-up live with their owners (dice.css,
 * panels.js); the keyframes are in styles/features/motion.css.
 *
 * Exports: window.Motion
 */

const Motion = {

    MAX_FLYING: 32,     // coins + deeds in the air at once (a whole estate is up to 28 deeds)
    // Timings at the Normal flight speed (0.75 s a flight); Anim flyMs
    // (Settings → Animations → Custom → Flight speed) scales all three
    FLY_MS: 750,
    STAGGER_MS: 140,
    ESTATE_MS: 1500,    // a bankrupt estate's deeds all set off within this
    COIN_GAP_MS: 90,    // between the coins of one payment

    // Coins per payment: 1 + the number of these an amount is above. Picked
    // from 129 recorded games (11,120 player-to-player payments): <= $25 is
    // ~45% of rents (bare lots, low railroads), <= $75 doubled set rents and
    // 2-railroad hits (~23%), <= $200 one or two houses (~15%), <= $500 three
    // houses / median trade cash, <= $1000 hotels (~8%), above that only the
    // big hotels (<2%). Coins from 4 up are drawn a little bigger (motion.css).
    COIN_TIERS: [25, 75, 200, 500, 1000],

    _ms(base) {
        const fly = (window.Anim && Anim.get('flyMs')) || this.FLY_MS;
        return Math.round(base * fly / this.FLY_MS);
    },
    CONFETTI: 54,

    _flying: 0,
    _sets: null,        // { gameId, owners: { group: playerId } }
    _bankruptNow: [],
    _holdings: null,    // { gameId, owners: { tileId: playerId }, worth: { playerId: $ } } at the last render
    _confettiFor: null,
    _tiles: null,       // { gameId, t: { tileId: { owner, houses, mortgaged } } } at the last render
    TILE_STAGGER_MS: 120,   // between tiles changed by one action (Build evenly, a mortgage spree)
    SWAP_MS: 900,       // a tile's change of owner (motion.css .tile-owner-swap)
    _landAt: {},        // tileId -> ms after the event when its flying deed lands (deed())

    enabled() {
        if (!Anim.on('effects')) return false;
        if (document.hidden) return false;
        if (window.engine && window.engine.fastForwarding) return false;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        const game = document.getElementById('screen-game');
        return !!game && !game.hidden;
    },

    init() {
        EventBus.on('propertyPurchased', ({ playerId, tileId }) => this.flashTile(tileId, playerId));
        EventBus.on('auctionEnded', ({ winnerId, tileId }) => {
            if (winnerId !== null && winnerId !== undefined) this.flashTile(tileId, winnerId);
        });
        EventBus.on('moneyMoved', ({ from, to, amount }) => {
            if (from && to) this.coins(this._idByName(from.name), this._idByName(to.name), amount);
        });
        EventBus.on('tradeCompleted', ({ offer }) => this.trade(offer));
        EventBus.on('playerBankrupt', ({ playerId, creditorId }) => {
            this._bankruptNow.push(playerId);
            this.estate(playerId, creditorId);
        });
        EventBus.on('gameOver', ({ winnerId }) => this.gameOver(winnerId));
        // Registered after the renderers (main.js boot), so the DOM is current
        EventBus.on('stateChanged', state => this._afterRender(state));
    },

    _idByName(name) {
        const state = window.engine && window.engine.state;
        const p = state && state.players.find(x => x.name === name);
        return p ? p.id : null;
    },

    _color(playerId) {
        return (BoardRenderer.TOKEN_COLORS && BoardRenderer.TOKEN_COLORS[playerId]) || 'currentColor';
    },

    /** Restart a one-shot CSS animation class on an element. */
    _pulse(el, cls, ms) {
        el.classList.remove(cls);
        void el.offsetWidth; // reflow so the animation restarts
        el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), ms);
    },

    flashTile(tileId, playerId) {
        if (!this.enabled()) return;
        const el = document.querySelector(`.tile[data-tile-id="${Number(tileId)}"]`);
        if (!el) return;
        el.style.setProperty('--flash', this._color(playerId));
        this._pulse(el, 'tile-bought', 750);
    },

    /** How many coins an amount is drawn as (0 for nothing; 1-6). */
    coinCount(amount) {
        const n = Number(amount);
        if (!(n > 0)) return 0;
        return 1 + this.COIN_TIERS.filter(edge => n > edge).length;
    },

    /** A coin from the payer's player card to the payee's (size: 1-6, see coinCount). */
    coin(fromId, toId, opts, size) {
        const coin = document.createElement('div');
        coin.className = 'motion-coin';
        if (size >= 6) coin.classList.add('motion-coin-xl');
        else if (size >= 4) coin.classList.add('motion-coin-lg');
        coin.textContent = '$';
        this._fly(coin, fromId, toId, opts);
    },

    /**
     * A payment as a short trail of coins, as many as coinCount(amount),
     * COIN_GAP_MS apart (scaled with the flight speed) and fanned a few px
     * around opts.lift so the trail reads as several coins. Returns how long
     * the trail takes to set off, so callers can queue what comes after.
     */
    coins(fromId, toId, amount, opts) {
        opts = opts || {};
        const count = this.coinCount(amount);
        const gap = this._ms(this.COIN_GAP_MS);
        const lift = opts.lift === undefined ? -18 : opts.lift;
        const FAN = [0, 6, -6, 12, -12, 0];
        for (let i = 0; i < count; i++) {
            this.coin(fromId, toId, { delay: (opts.delay || 0) + i * gap, lift: lift + FAN[i % FAN.length] }, count);
        }
        return count * gap;
    },

    /** A small deed (white card, the tile's colour band) between two player cards. */
    deed(tileId, fromId, toId, opts) {
        const tile = BOARD[tileId];
        if (!tile) return;
        const deed = document.createElement('div');
        deed.className = 'motion-deed';
        const band = document.createElement('i');
        const meta = tile.group && GROUP_META[tile.group];
        if (meta) band.style.background = meta.color; // fixed palette (constants.js)
        deed.appendChild(band);
        // The tile's owner swap (_ownerSwap) waits for this deed to land
        this._landAt[tileId] = ((opts && opts.delay) || 0) + this._ms(this.FLY_MS);
        this._fly(deed, fromId, toId, opts);
    },

    /**
     * A completed trade: each side's deeds, then its cash, cross between the
     * two player cards, one after another. The proposer's side arcs over the
     * top and the other side underneath, so the two streams stay apart.
     */
    trade(offer) {
        if (!offer || !this.enabled()) return;
        const side = (part, fromId, toId, lift) => {
            let n = 0;
            ((part && part.properties) || []).forEach(tileId => {
                this.deed(tileId, fromId, toId, { delay: n * this._ms(this.STAGGER_MS), lift });
                n += 1;
            });
            if (part && part.cash > 0) this.coins(fromId, toId, part.cash, { delay: n * this._ms(this.STAGGER_MS), lift });
        };
        side(offer.give, offer.from, offer.to, -22);
        side(offer.get, offer.to, offer.from, 22);
    },

    /**
     * A bankruptcy to another player: everything the debtor held at the last
     * render (the event fires after the engine has already moved it) flies to
     * the creditor's card, deeds first and the cash last. Nothing is shown
     * when the estate goes to the bank.
     */
    estate(debtorId, creditorId) {
        const state = window.engine && window.engine.state;
        const held = this._holdings;
        if (creditorId === null || creditorId === undefined || !this.enabled()) return;
        if (!state || !held || held.gameId !== state.gameId) return;
        const tiles = Object.keys(held.owners).filter(id => held.owners[id] === debtorId).map(Number);
        const gap = tiles.length ? Math.min(this._ms(this.STAGGER_MS), this._ms(this.ESTATE_MS) / tiles.length) : 0;
        tiles.forEach((tileId, n) => this.deed(tileId, debtorId, creditorId, { delay: n * gap }));
        if (held.worth[debtorId] > 0) this.coins(debtorId, creditorId, held.worth[debtorId], { delay: tiles.length * gap });
    },

    /**
     * What each player holds, kept from render to render for estate(): deeds,
     * and the cash an estate would hand over (cash plus buildings sold back at
     * half price, as bankruptcy.js does), which sets its coin count.
     */
    _snapshot(state) {
        const owners = {}, worth = {};
        state.players.forEach(p => { worth[p.id] = Math.max(0, p.cash || 0); });
        Object.keys(state.tiles).forEach(id => {
            const ts = state.tiles[id];
            if (!ts || ts.owner === null || ts.owner === undefined) return;
            owners[id] = ts.owner;
            const tile = BOARD[Number(id)];
            if (ts.houses > 0 && tile && tile.houseCost) worth[ts.owner] += ts.houses * tile.houseCost / 2;
        });
        this._holdings = { gameId: state.gameId, owners, worth };
    },

    /**
     * Fly an element from one player card's centre to another's.
     * opts.delay: ms before it sets off; opts.lift: px the arc's midpoint is
     * raised (negative) or lowered.
     */
    _fly(el, fromId, toId, opts) {
        opts = opts || {};
        if (fromId === null || toId === null || fromId === undefined || toId === undefined || fromId === toId) return;
        if (!this.enabled() || this._flying >= this.MAX_FLYING || !document.body.animate) return;
        this._flying += 1;
        // Next frame: the cards have been re-rendered for the new state
        requestAnimationFrame(() => {
            const cards = document.querySelectorAll('#player-panels .player-panel');
            const a = cards[fromId], b = cards[toId];
            if (!a || !b) { this._flying -= 1; return; }
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            el.classList.add('motion-fly');
            document.body.appendChild(el);
            const w = el.offsetWidth, h = el.offsetHeight;
            el.style.left = `${ra.left + ra.width / 2 - w / 2}px`;
            el.style.top = `${ra.top + ra.height / 2 - h / 2}px`;
            const dx = rb.left + rb.width / 2 - (ra.left + ra.width / 2);
            const dy = rb.top + rb.height / 2 - (ra.top + ra.height / 2);
            const lift = opts.lift === undefined ? -18 : opts.lift;
            const done = () => { el.remove(); this._flying -= 1; };
            const anim = el.animate([
                { transform: 'translate(0, 0) scale(0.6)', opacity: 0 },
                { transform: `translate(${dx * 0.08}px, ${dy * 0.08}px) scale(0.9)`, opacity: 1, offset: 0.12 },
                { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + lift}px) scale(1.25)`, opacity: 1, offset: 0.5 },
                { transform: `translate(${dx}px, ${dy}px) scale(0.7)`, opacity: 0.2 }
            ], { duration: this._ms(this.FLY_MS), delay: opts.delay || 0, easing: 'ease-in-out', fill: 'backwards' });
            anim.onfinish = done;
            anim.oncancel = done;
        });
    },

    /** Confetti for a human winner (or a CPU-only game), defeat when a CPU beats a human. */
    gameOver(winnerId) {
        const state = window.engine && window.engine.state;
        if (!state || this._confettiFor === state.gameId) return; // once per game
        this._confettiFor = state.gameId;
        if (!this.enabled()) return;
        const winner = state.players[winnerId !== undefined ? winnerId : state.winner];
        const anyHuman = state.players.some(p => !p.isCPU);
        if (winner && winner.isCPU && anyHuman) this.defeat();
        else this.confetti();
    },

    /** A human lost to a CPU: the whole screen shakes under a red vignette. */
    defeat() {
        const veil = document.createElement('div');
        veil.className = 'motion-defeat';
        document.body.appendChild(veil);
        this._pulse(document.body, 'motion-shake', 700);
        setTimeout(() => veil.remove(), 1800);
    },

    confetti() {
        const layer = document.createElement('div');
        layer.className = 'motion-confetti';
        const colors = BoardRenderer.TOKEN_COLORS || BoardRenderer.COLORS_DEFAULT;
        const rnd = (min, max) => min + Math.random() * (max - min); // cosmetic, not the game RNG
        for (let i = 0; i < this.CONFETTI; i++) {
            const piece = document.createElement('i');
            piece.className = 'confetti-piece';
            piece.style.left = `${rnd(0, 100).toFixed(1)}%`;
            piece.style.background = colors[i % colors.length];
            piece.style.setProperty('--drift', `${rnd(-60, 60).toFixed(0)}px`);
            piece.style.setProperty('--spin', `${rnd(360, 1080).toFixed(0)}deg`);
            piece.style.setProperty('--dur', `${rnd(1.8, 3).toFixed(2)}s`);
            piece.style.setProperty('--delay', `${rnd(0, 0.7).toFixed(2)}s`);
            layer.appendChild(piece);
        }
        document.body.appendChild(layer);
        setTimeout(() => layer.remove(), 4000);
    },

    _afterRender(state) {
        this._setShimmer(state);
        this._tileChanges(state);
        this._snapshot(state);
        const gone = this._bankruptNow;
        this._bankruptNow = [];
        if (!gone.length || !this.enabled()) return;
        const cards = document.querySelectorAll('#player-panels .player-panel');
        gone.forEach(id => { if (cards[id]) this._pulse(cards[id], 'panel-bankrupt-now', 1100); });
    },

    /**
     * Buildings and mortgages, found by diffing each tile against the last
     * render. Only a tile that kept its owner counts, so trades, bankrupt
     * estates and a new / loaded game never animate here.
     */
    _tileChanges(state) {
        const t = {};
        Object.keys(state.tiles).forEach(id => {
            const ts = state.tiles[id];
            if (!ts || ts.owner === null || ts.owner === undefined) return;
            t[id] = { owner: ts.owner, houses: ts.houses || 0, mortgaged: !!ts.mortgaged };
        });
        const prev = this._tiles && this._tiles.gameId === state.gameId ? this._tiles.t : null;
        this._tiles = { gameId: state.gameId, t };
        const landAt = this._landAt;
        this._landAt = {};
        if (!prev || !this.enabled()) return;
        let n = 0, swaps = 0;
        Object.keys(t).forEach(id => {
            const now = t[id], was = prev[id];
            if (!was) return;
            const el = document.querySelector(`.tile[data-tile-id="${Number(id)}"]`);
            if (!el) return;
            if (was.owner !== now.owner) {
                // Traded, or part of an estate: one player to another
                const delay = landAt[id] !== undefined ? landAt[id] : swaps * this.TILE_STAGGER_MS;
                this._ownerSwap(el, was.owner, now.owner, delay, state);
                swaps += 1;
                return;
            }
            let changed = false;
            if (now.houses !== was.houses) {
                const delay = n * this.TILE_STAGGER_MS;
                this._pips(el, was.houses, now.houses, delay);
                // One sweep of the set shimmer across the band: forwards on a build, back on a sale
                const cls = now.houses > was.houses ? 'tile-band-built' : 'tile-band-sold';
                if (delay) setTimeout(() => this._pulse(el, cls, 900), delay);
                else this._pulse(el, cls, 900);
                changed = true;
            }
            if (now.mortgaged !== was.mortgaged) {
                const cls = now.mortgaged ? 'tile-mortgage-flip' : 'tile-unmortgage-flip';
                const delay = n * this.TILE_STAGGER_MS;
                if (delay) setTimeout(() => this._pulse(el, cls, 700), delay);
                else this._pulse(el, cls, 700);
                changed = true;
            }
            if (changed) n += 1;
        });
    },

    /**
     * A tile that changed hands: after `delay` ms (until then it still shows
     * the old owner: the animations fill backwards) it pulses in the new
     * owner's colour while its mark turns over. The dot and the tint fade
     * from the old colour (--old-owner); the emoji mark flips edge-on, a ghost
     * of the old owner's emoji turning away as the new one turns in.
     */
    _ownerSwap(el, oldId, newId, delay, state) {
        const cls = 'tile-owner-swap';
        if (el._swapTimer) clearTimeout(el._swapTimer);
        el.querySelectorAll('.owner-emoji-old').forEach(g => g.remove());
        el.classList.remove(cls);
        void el.offsetWidth; // reflow so the animation restarts
        el.style.setProperty('--old-owner', this._color(oldId));
        el.style.setProperty('--flash', this._color(newId));
        el.style.setProperty('--swap-delay', `${Math.max(0, Math.round(delay))}ms`);
        const mark = el.querySelector('.owner-emoji');
        if (mark) {
            const ghost = BoardRenderer.ownerEmoji(state.players[oldId], oldId);
            ghost.classList.add('owner-emoji-old');
            ghost.setAttribute('aria-hidden', 'true');
            mark.after(ghost);
            // Laid over the new mark (.tile-marks is its offset parent)
            ghost.style.left = `${mark.offsetLeft}px`;
            ghost.style.top = `${mark.offsetTop}px`;
        }
        el.classList.add(cls);
        el._swapTimer = setTimeout(() => {
            el.classList.remove(cls);
            el.querySelectorAll('.owner-emoji-old').forEach(g => g.remove());
            el._swapTimer = null;
        }, delay + this.SWAP_MS + 50);
    },

    /** Animate a tile's building pips from `was` to `now` houses (5 = hotel). */
    _pips(el, was, now, delay) {
        const marks = el.querySelector('.tile-marks');
        if (!marks) return;
        if (now > was) {
            // Built: the renderer has drawn the new pips; drop in the added ones
            const added = now === 5
                ? Array.from(marks.querySelectorAll('.hotel-pip'))
                : Array.from(marks.querySelectorAll('.house-pip')).slice(was);
            added.forEach((pip, i) => {
                pip.style.setProperty('--pip-delay', `${delay + i * 90}ms`);
                pip.classList.add('pip-drop');
                // The renderer now keeps unchanged pips, so clear the class or
                // the drop would replay whenever the board is shown again
                pip.addEventListener('animationend', () => pip.classList.remove('pip-drop'), { once: true });
            });
            return;
        }
        // Sold: the pips are already gone, so lift ghosts of them off the tile
        const ghosts = was === 5 ? ['hotel-pip'] : Array(was - now).fill('house-pip');
        ghosts.forEach((cls, i) => {
            const ghost = document.createElement('span');
            ghost.className = `${cls} pip-lift`;
            ghost.setAttribute('aria-hidden', 'true');
            ghost.style.setProperty('--pip-delay', `${delay + i * 90}ms`);
            marks.appendChild(ghost);
            setTimeout(() => ghost.remove(), delay + i * 90 + 600);
        });
    },

    /** Shimmer a colour group's bands the moment one player completes it. */
    _setShimmer(state) {
        const owners = {};
        BOARD.forEach(tile => {
            if (tile.type !== 'property' || owners[tile.group] !== undefined) return;
            const ts = state.tiles[String(tile.id)];
            const owner = ts && ts.owner !== null && ts.owner !== undefined ? ts.owner : null;
            owners[tile.group] = owner !== null && Rules.ownsFullGroup(state, owner, tile.group) ? owner : null;
        });
        const prev = this._sets && this._sets.gameId === state.gameId ? this._sets.owners : null;
        this._sets = { gameId: state.gameId, owners };
        if (!prev || !this.enabled()) return; // first look at this game: nothing is "new"
        Object.keys(owners).forEach(group => {
            if (owners[group] === null || owners[group] === prev[group]) return;
            BOARD.forEach(tile => {
                if (tile.type !== 'property' || tile.group !== group) return;
                const el = document.querySelector(`.tile[data-tile-id="${tile.id}"]`);
                if (el) this._pulse(el, 'tile-set-new', 1700);
            });
        });
    }
};

if (typeof window !== 'undefined') {
    window.Motion = Motion;
}
