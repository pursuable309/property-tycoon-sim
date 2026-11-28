/**
 * UI: Dice display with a roll animation set by the animations setting
 * (Anim: dice = tumble (faces cycle) | shake | off, for Anim diceMs). Faces are drawn: a 3x3 grid of pips, the ones a face uses
 * shown by CSS from data-face (dice.css). A live roll tints the pips with
 * the roller's seat colour.
 *
 * Exports: window.DiceUI
 */

const DiceUI = {

    PIPS: '<i class="pip"></i>'.repeat(9),

    /** Draw face n (1-6) on a die element. */
    _face(el, n) {
        if (!el.firstElementChild) el.innerHTML = this.PIPS; // replaces the "?" placeholder
        el.dataset.face = String(n);
    },

    _timer: null,
    _spin: null,

    show(dice) {
        const d1 = document.getElementById('die-1');
        const d2 = document.getElementById('die-2');
        if (!d1) return;
        this._cancel(d1, d2);
        this._tint(d1.parentElement);

        const mode = Anim.get('dice');
        if (mode === 'off') {
            this._face(d1, dice[0]);
            this._face(d2, dice[1]);
            return;
        }

        d1.classList.add('rolling');
        d2.classList.add('rolling');
        if (mode === 'tumble') {
            this._spin = setInterval(() => {
                // Cosmetic only (never the game RNG)
                this._face(d1, 1 + Math.floor(Math.random() * 6));
                this._face(d2, 1 + Math.floor(Math.random() * 6));
            }, 80);
        }

        this._timer = setTimeout(() => {
            this._cancel(d1, d2);
            this._face(d1, dice[0]);
            this._face(d2, dice[1]);
            d1.classList.add('die-land');
            d2.classList.add('die-land');
            setTimeout(() => {
                d1.classList.remove('die-land');
                d2.classList.remove('die-land');
            }, 300);
        }, Anim.get('diceMs'));
    },

    _cancel(d1, d2) {
        if (this._spin) { clearInterval(this._spin); this._spin = null; }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        d1.classList.remove('rolling');
        d2.classList.remove('rolling');
    },

    render(state) {
        if (!state.lastDice) return;
        const d1 = document.getElementById('die-1');
        const d2 = document.getElementById('die-2');
        if (!d1 || d1.classList.contains('rolling')) return;
        this._face(d1, state.lastDice[0]);
        this._face(d2, state.lastDice[1]);
    },

    /** Pips take the roller's seat colour (text-safe variant) for this roll. */
    _tint(area) {
        const state = window.engine && window.engine.state;
        if (!area || !state || typeof BoardRenderer === 'undefined') return;
        area.style.setProperty('--pip', BoardRenderer.inkColor(state.currentPlayer));
    }
};

if (typeof window !== 'undefined') {
    window.DiceUI = DiceUI;
    EventBus.on('diceRolled', ({ dice }) => DiceUI.show(dice));
}
