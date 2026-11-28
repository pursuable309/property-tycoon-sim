/**
 * UI: Cover Split
 *
 * Drag handle between the board and the player column on the Motorola cover
 * display. Dragging sets the column width (--ext-col on #screen-game); the
 * board takes whatever the column leaves, up to the full height, and the
 * player cards compact themselves to fit (container queries in
 * motorola-external.css). Double-tap resets. The width is saved in
 * monopoly_settings.coverColumn as a fraction of the viewport width, so it
 * survives a zoom change (Firefox flips 1.4x on fold/unfold).
 *
 * Exports: window.CoverSplit
 */

const CoverSplit = {

    MIN_COL: 40,        // px: token + cash cards
    MAX_SHARE: 0.55,    // of the viewport width
    HANDLE: 10,         // px: .cover-split width (keep in sync with the CSS)
    PAD: 8,             // px: screen padding + grid gaps around the board
    STEP: 8,            // px per arrow-key press

    _bound: false,

    init() {
        const handle = document.getElementById('cover-split');
        if (!handle || this._bound) { this.apply(); return; }
        this._bound = true;

        let dragging = false;
        let lastTap = 0;
        handle.addEventListener('pointerdown', e => {
            dragging = true;
            handle.setPointerCapture(e.pointerId);
            handle.classList.add('is-dragging');
            e.preventDefault();
        });
        handle.addEventListener('pointermove', e => {
            if (!dragging) return;
            this._set(window.innerWidth - e.clientX - this.HANDLE / 2 - this.PAD / 2);
        });
        const end = e => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('is-dragging');
            if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
            // Double-tap (two releases close together) resets to the default
            const now = Date.now();
            if (now - lastTap < 350) { this.reset(); lastTap = 0; return; }
            lastTap = now;
            this._save();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        handle.addEventListener('keydown', e => {
            const dir = { ArrowLeft: 1, ArrowRight: -1 }[e.key];
            if (!dir) return;
            e.preventDefault();
            this._set(this._current() + dir * this.STEP);
            this._save();
        });
        window.addEventListener('resize', () => this.apply());
        this.apply();
    },

    /** Narrowest useful column: below this the board would already be at
     *  full height, so a narrower column would only add empty space. */
    _minCol() {
        const boardMax = window.innerHeight - this.PAD;
        return Math.max(this.MIN_COL, window.innerWidth - boardMax - this.HANDLE - this.PAD);
    },

    _clamp(px) {
        const max = Math.round(window.innerWidth * this.MAX_SHARE);
        return Math.round(Math.min(max, Math.max(this._minCol(), px)));
    },

    _current() {
        const panels = document.getElementById('player-panels');
        return panels ? panels.getBoundingClientRect().width : this.MIN_COL;
    },

    _set(px) {
        const screen = document.getElementById('screen-game');
        if (screen) screen.style.setProperty('--ext-col', `${this._clamp(px)}px`);
    },

    _save() {
        const s = SettingsUI.load();
        s.coverColumn = Math.round(this._current() / window.innerWidth * 1000) / 1000;
        StorageManager.set(STORAGE_KEYS.SETTINGS, s);
    },

    /** Restore the saved width (as a share of the current viewport). */
    apply() {
        const share = Number(SettingsUI.load().coverColumn);
        if (share > 0) this._set(share * window.innerWidth);
    },

    reset() {
        const screen = document.getElementById('screen-game');
        if (screen) screen.style.removeProperty('--ext-col');
        const s = SettingsUI.load();
        delete s.coverColumn;
        StorageManager.set(STORAGE_KEYS.SETTINGS, s);
    }
};

if (typeof window !== 'undefined') {
    window.CoverSplit = CoverSplit;
}
