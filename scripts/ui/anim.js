/**
 * UI: Anim (resolved animation preferences)
 *
 * Settings → Display → Animations picks a preset (Full / Reduced / Off) or
 * Custom, which sets each effect on its own. SettingsUI.apply() resolves the
 * choice into Anim.current; the animating modules ask Anim.on(key) /
 * Anim.get(key) instead of reading html[data-anim] themselves. CSS keys on
 * html[data-anim] (full | reduced | off | custom; "off" drops transitions)
 * and html[data-anim-dice] (tumble | shake | off).
 *
 * Keys: dice ('tumble' | 'shake' | 'off'), diceMs (roll time), walk (token
 * hops tile by tile), stepMs (per tile; 0 = auto, ~0.9 s a move), effects
 * (Motion: purchase flip, coins, trade / estate flights, set shimmer,
 * confetti), flyMs (one coin / deed flight between player cards; set by
 * fly = fast | normal | slow | custom), highlights (tile flashes, latest-event pop, cash flash + delta
 * chip), countUp (cash figures count to the new amount).
 *
 * Exports: window.Anim
 */

const Anim = {

    PRESETS: {
        full:    { dice: 'tumble', diceMs: 700, walk: true,  stepMs: 0, effects: true,  fly: 'normal', flyMs: 750, highlights: true,  countUp: true },
        reduced: { dice: 'shake',  diceMs: 250, walk: false, stepMs: 0, effects: false, fly: 'normal', flyMs: 750, highlights: true,  countUp: false },
        off:     { dice: 'off',    diceMs: 0,   walk: false, stepMs: 0, effects: false, fly: 'normal', flyMs: 750, highlights: false, countUp: false }
    },

    // Flight of a coin / deed between player cards, per speed
    FLY_SPEEDS: { fast: 400, normal: 750, slow: 1200 },

    // Custom number fields: [min, max] in ms
    LIMITS: { diceMs: [100, 3000], stepMs: [0, 600], flyMs: [200, 3000] },

    level: 'full',
    current: null,

    /** Clamp a custom ms value into its range (bad input → fallback). */
    clampMs(key, value, fallback) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return fallback;
        const [lo, hi] = this.LIMITS[key];
        return Math.min(hi, Math.max(lo, n));
    },

    /** Preset or Custom (custom values over the Full preset) → flat prefs. */
    resolve(level, custom) {
        if (level !== 'custom') return { ...(this.PRESETS[level] || this.PRESETS.full) };
        const base = this.PRESETS.full;
        const c = custom && typeof custom === 'object' ? custom : {};
        const bool = (k) => (typeof c[k] === 'boolean' ? c[k] : base[k]);
        const fly = ['fast', 'normal', 'slow', 'custom'].includes(c.fly) ? c.fly : base.fly;
        return {
            dice: ['tumble', 'shake', 'off'].includes(c.dice) ? c.dice : base.dice,
            diceMs: this.clampMs('diceMs', c.diceMs ?? base.diceMs, base.diceMs),
            walk: bool('walk'),
            stepMs: this.clampMs('stepMs', c.stepMs ?? base.stepMs, base.stepMs),
            effects: bool('effects'),
            fly,
            flyMs: fly === 'custom' ? this.clampMs('flyMs', c.flyMs ?? base.flyMs, base.flyMs) : this.FLY_SPEEDS[fly],
            highlights: bool('highlights'),
            countUp: bool('countUp')
        };
    },

    set(level, custom) {
        this.level = ['full', 'reduced', 'off', 'custom'].includes(level) ? level : 'full';
        this.current = this.resolve(this.level, custom);
        const root = document.documentElement;
        root.dataset.anim = this.level;
        root.dataset.animDice = this.current.dice;
    },

    /** Is an effect on? (dice: any roll animation at all) */
    on(key) {
        if (!this.current) this.set('full');
        const v = this.current[key];
        return key === 'dice' ? v !== 'off' : !!v;
    },

    get(key) {
        if (!this.current) this.set('full');
        return this.current[key];
    }
};

if (typeof window !== 'undefined') {
    window.Anim = Anim;
}
