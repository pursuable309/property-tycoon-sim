/**
 * UI: Sound effects
 *
 * Plays short vendored WAV cues (assets/audio/) for tactile game moments,
 * driven entirely by EventBus so it stays silent during DEV.simulate
 * (EventBus.muted). Scope is set in Settings:
 *   'off'   - no sound
 *   'human' - only events a human player is involved in
 *   'all'   - every event, including CPU-vs-CPU
 *
 * Browsers gate audio until a user gesture, so the first pointer/key press
 * primes the clips; after that programmatic plays (CPU turns) are allowed.
 *
 * Exports: window.Sound
 */

const Sound = {

    BASE: 'assets/audio/',
    POOL_SIZE: 3,           // round-robin copies per cue, for overlap
    THROTTLE_MS: 60,        // ignore the same cue fired again within this window
    VOLUME: 0.7,

    FILES: {
        dice:          'dice-roll.wav',
        cash:          'cash.wav',       // money arriving to a player
        cashOut:       'cash-out.wav',   // money leaving a player (reversed)
        card:          'card-draw.wav',
        tradeComplete: 'trade-complete.wav',
        tradeReject:   'trade-reject.wav',
        auctionStart:  'auction-start.wav',
        auction:       'auction-complete.wav',
        jail:          'jail.wav',
        property:      'property-buy.wav',
        bankruptcy:    'bankruptcy.wav',
        victory:       'victory.wav'
    },

    _mode: 'off',
    _inited: false,
    _unlocked: false,
    _pools: {},             // cue -> [HTMLAudioElement]
    _idx: {},               // cue -> next pool index
    _lastAt: {},            // cue -> timestamp of last play

    /** Preload pools, arm the unlock gesture, and wire event cues. Idempotent. */
    init() {
        if (this._inited || typeof document === 'undefined') return;
        this._inited = true;

        Object.entries(this.FILES).forEach(([cue, file]) => {
            this._pools[cue] = Array.from({ length: this.POOL_SIZE }, () => {
                const el = new Audio(this.BASE + file);
                el.preload = 'auto';
                el.volume = this.VOLUME;
                return el;
            });
            this._idx[cue] = 0;
        });

        const unlock = () => this._unlock();
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });

        this._subscribe();
    },

    setMode(mode) {
        this._mode = ['off', 'human', 'all'].includes(mode) ? mode : 'off';
    },

    /** Play a cue. `human` = a human player is involved in the triggering event. */
    play(cue, human) {
        if (this._mode === 'off') return;
        if (this._mode === 'human' && !human) return;
        const pool = this._pools[cue];
        if (!pool) return;

        const now = Date.now();
        if (now - (this._lastAt[cue] || 0) < this.THROTTLE_MS) return;
        this._lastAt[cue] = now;

        const el = pool[this._idx[cue]];
        this._idx[cue] = (this._idx[cue] + 1) % pool.length;
        try {
            el.currentTime = 0;
            const p = el.play();
            if (p && p.catch) p.catch(() => {}); // autoplay rejection: ignore
        } catch (e) { /* element busy / not ready */ }
    },

    /** Prime playback on the first user gesture so later CPU plays are allowed. */
    _unlock() {
        if (this._unlocked) return;
        this._unlocked = true;
        Object.values(this._pools).forEach(pool => {
            const el = pool[0];
            el.muted = true;
            const p = el.play();
            if (p && p.then) {
                p.then(() => { el.pause(); el.currentTime = 0; el.muted = false; })
                 .catch(() => { el.muted = false; });
            } else {
                el.pause(); el.currentTime = 0; el.muted = false;
            }
        });
    },

    _isHuman(id) {
        return !!(window.engine && engine.state.players[id] && !engine.state.players[id].isCPU);
    },

    // Table-wide events (auction start) concern every potential bidder, so a
    // human is "involved" whenever any human is still in the game.
    _anyHuman() {
        return !!(window.engine && engine.state.players.some(p => !p.isCPU && !p.bankrupt));
    },

    _subscribe() {
        EventBus.on('diceRolled', ({ player }) => this.play('dice', this._isHuman(player)));
        // Direction is from the human's wallet: a human paying gets the reversed
        // "debit" cue; money arriving to a human (or CPU-only in 'all' mode) gets
        // the normal coin cue.
        EventBus.on('moneyMoved', ({ from, to, reason }) => {
            if (reason === 'mortgage interest') return; // keep the bankruptcy cue audible
            const humanFrom = !!(from && !from.isCPU);
            const humanTo = !!(to && !to.isCPU);
            this.play(humanFrom ? 'cashOut' : 'cash', humanFrom || humanTo);
        });
        EventBus.on('cardDrawn', ({ player }) => this.play('card', this._isHuman(player)));
        EventBus.on('tradeCompleted', ({ offer }) =>
            this.play('tradeComplete', this._isHuman(offer.from) || this._isHuman(offer.to)));
        EventBus.on('tradeRejected', ({ offer }) =>
            this.play('tradeReject', this._isHuman(offer.from) || this._isHuman(offer.to)));
        EventBus.on('auctionStarted', () => this.play('auctionStart', this._anyHuman()));
        EventBus.on('auctionEnded', ({ winnerId }) =>
            this.play('auction', winnerId !== null && winnerId !== undefined && this._isHuman(winnerId)));
        EventBus.on('sentToJail', ({ player }) => this.play('jail', this._isHuman(player)));
        EventBus.on('propertyPurchased', ({ playerId }) => this.play('property', this._isHuman(playerId)));
        EventBus.on('playerBankrupt', ({ playerId }) => this.play('bankruptcy', this._isHuman(playerId)));
        EventBus.on('gameOver', ({ winnerId }) => this.play('victory', this._isHuman(winnerId)));
    }
};

if (typeof window !== 'undefined') {
    window.Sound = Sound;
}
