/**
 * UI: Screen Manager
 *
 * Switches between the setup (home) and game screens and detects which display
 * profile is active (external = short, internal tall/narrow, standard).
 * Moves the turn buttons into the board center on every layout except a
 * wide cover's column and the internal display's Buttons > Bottom setting
 * (controlsInCentre).
 *
 * Exports: window.ScreenManager
 */

const ScreenManager = {

    /** 'external' | 'internal' | 'standard'
     *  Both Razr displays are narrow, so height is the discriminator:
     *  <500 = cover. As Chrome apps the internal reads 307x699 and the
     *  cover 361x308 or, when the page reaches the bottom edge, 361x407
     *  (see coverCams).
     *  Any other short screen (e.g. a landscape 805x361) gets the cover
     *  layout too: board at full height on the left, player column right.
     *  Keep in sync with the @media in responsive/motorola-external.css
     *  and responsive/other-devices.css (standard = >480 wide, >=500 tall). */
    getScreenType() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (h < 500) return 'external';
        if (w <= 480 && h >= 500) return 'internal';
        return 'standard';
    },

    /** Wide cover (a short landscape screen at least 2:1, e.g. 805x361):
     *  the column beside the full-height board is wide enough to hold the
     *  action buttons, so they stay under the player cards instead of
     *  moving into the board centre. Keep in sync with the same query in
     *  responsive/motorola-external.css. */
    COVER_WIDE_MQ: '(min-width: 481px) and (max-height: 499px) and (min-aspect-ratio: 2/1)',

    isCoverWide() {
        return this.getScreenType() === 'external' && !!window.matchMedia
            && window.matchMedia(this.COVER_WIDE_MQ).matches;
    },

    /** Camera keep-out on the cover (Razr Ultra 2025: Chrome reports the
     *  cover at 361x407 when the page runs down to the bottom edge, where
     *  the cameras cover the bottom-right corner, from about 47% across and
     *  75% down). Shares of the viewport, a little inside the measured
     *  edges; written to :root as --cam-top / --cam-left (px) so the CSS
     *  never repeats the numbers. */
    CAM_TOP_SHARE: 0.74,
    CAM_LEFT_SHARE: 0.46,

    /** True when the cover layout should keep clear of the cameras:
     *  Settings > Cover cameras On, or Auto (default) and the cover
     *  viewport is taller than it is wide (the only shape that reaches the
     *  cameras; the 361x266 / 361x308 readings stop above them). */
    coverCams() {
        if (this.getScreenType() !== 'external') return false;
        const mode = typeof SettingsUI !== 'undefined' ? SettingsUI.load().coverCams : undefined;
        if (mode === 'on') return true;
        if (mode === 'off') return false;
        return window.innerHeight > window.innerWidth;
    },

    /** Set html.cover-cams and the keep-out vars, then re-fit what depends
     *  on them. Runs on every resize, so switching between the cover's
     *  sizes (toolbar shown / hidden, full screen) re-lays out the game
     *  mid-turn, modals included, with no reload. */
    applyCoverCams() {
        const root = document.documentElement;
        const on = this.coverCams();
        const was = root.classList.contains('cover-cams');
        if (on) {
            root.style.setProperty('--cam-top', `${Math.round(window.innerHeight * this.CAM_TOP_SHARE)}px`);
            root.style.setProperty('--cam-left', `${Math.round(window.innerWidth * this.CAM_LEFT_SHARE)}px`);
        } else {
            root.style.removeProperty('--cam-top');
            root.style.removeProperty('--cam-left');
        }
        root.classList.toggle('cover-cams', on);
        if (on !== was) {
            if (typeof CoverSplit !== 'undefined') CoverSplit.apply();
            // The held auction sheet height was measured for the old shape
            if (typeof AuctionUI !== 'undefined') { AuctionUI._sheetHeight = null; AuctionUI._bodyPx = null; }
        }
        if (typeof ToastOffset !== 'undefined' && document.querySelector('body > .notification')) ToastOffset.layout();
    },

    _show(id) {
        document.querySelectorAll('.screen').forEach(el => { el.hidden = true; });
        document.getElementById(id).hidden = false;
    },

    showSetup() {
        this._show('screen-setup');
        this.applyCoverCams();
        if (typeof SetupUI !== 'undefined') SetupUI.render();
    },

    showGame() {
        this._show('screen-game');
        document.body.dataset.screenType = this.getScreenType();
        this.applyCoverCams();
        this._layoutControls();
        if (typeof CoverSplit !== 'undefined') CoverSplit.init();
    },

    _controlsInBoard: false,

    /** The turn buttons' place: the board centre (under the latest event)
     *  on every layout, except the wide cover's column and, on the internal
     *  display, Settings > Buttons > Bottom. html.ctl-centre / html.ctl-bottom
     *  tell the CSS which. */
    controlsInCentre() {
        const type = this.getScreenType();
        if (type === 'external') return !this.isCoverWide();
        if (type === 'internal') {
            const pos = typeof SettingsUI !== 'undefined' ? SettingsUI.load().buttonsPos : undefined;
            return pos !== 'bottom';
        }
        return true;
    },

    _layoutControls() {
        const inCentre = this.controlsInCentre();
        const root = document.documentElement;
        root.classList.toggle('ctl-centre', inCentre);
        root.classList.toggle('ctl-bottom', !inCentre);
        const controls = document.getElementById('controls');
        if (!controls) return;
        if (inCentre && !this._controlsInBoard) {
            const center = document.getElementById('board-center');
            if (center) {
                center.appendChild(controls);
                this._controlsInBoard = true;
            }
        } else if (!inCentre && this._controlsInBoard) {
            const layout = document.querySelector('.game-layout');
            const panels = document.getElementById('player-panels');
            if (layout) {
                layout.insertBefore(controls, panels ? panels.nextSibling : null);
                this._controlsInBoard = false;
            }
        }
    }
};

// One frame per burst of resizes (a toolbar sliding in fires many), so the
// layout flips once. visualViewport too: Chrome's toolbar show / hide on
// the cover doesn't always fire a window resize.
let _screenFrame = 0;
function _onScreenResize() {
    if (_screenFrame) return;
    _screenFrame = requestAnimationFrame(() => {
        _screenFrame = 0;
        document.body.dataset.screenType = ScreenManager.getScreenType();
        ScreenManager.applyCoverCams();
        ScreenManager._layoutControls();
    });
}
window.addEventListener('resize', _onScreenResize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', _onScreenResize);

if (typeof window !== 'undefined') {
    window.ScreenManager = ScreenManager;
}
