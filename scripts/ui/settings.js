/**
 * UI: Settings
 *
 * Display, turn-flow and trading preferences, persisted in localStorage
 * under monopoly_settings and applied at boot and the moment a field
 * changes (no Save step; Done closes the sheet). Organised into three tabs
 * (Display / Turn flow / Trading); small option sets render as segmented
 * pill rows, booleans as the shared toggle switch, timings as number fields
 * in seconds (stored in ms). A ? beside a label opens what the option
 * actually does (preset timings included). Animations and CPU speed have a
 * Custom choice that reveals their own values; Turn flow's Express switch
 * sets CPU speed Fast + every human auto option in one go.
 *
 * Exports: window.SettingsUI
 */

const SettingsUI = {

    SPEEDS: { fast: 150, normal: 700, slow: 1400 },

    // Number fields in ms: [min, max]. A live CPU pause of 0 would run CPU
    // turns synchronously and freeze the page, hence the 50 ms floor.
    LIMITS: { cpuDelayMs: [50, 5000], autoDelay: [0, 5000] },

    // The settings Express turns on; it's "on" exactly while all four match
    EXPRESS: { cpuSpeed: 'fast', autoRoll: true, autoRollJail: true, autoEndTurn: true },

    // What each option means (the ? beside its label). Plain text.
    HELP: {
        ownership: 'How the board marks who owns a property. Dots: a small dot in the owner\'s colour. '
            + 'Tokens: the owner\'s token emoji in a ring of their colour (the small cover screen shows dots instead). '
            + 'Tinted tiles: the whole tile is washed in the owner\'s colour.',
        animations: 'Full: dice tumble for 0.7 s, tokens walk tile by tile (about 0.9 s a move), '
            + 'board effects (purchase flip, coins between players, trade and bankruptcy flights, '
            + 'set shimmer, a traded property pulsing as its mark turns to the new owner\'s, houses dropping in or lifting off with a shimmer, the mortgage flip, confetti), tile flashes, the latest-event pop and cash count-up. '
            + 'Reduced: dice shake for 0.25 s, tokens jump, tile flashes and the cash flash only. '
            + 'Off: everything instant. Custom: set each one below. '
            + 'Your system\'s "reduce motion" setting also turns board effects off.',
        animDice: 'Tumble: the dice spin and show random faces. Shake: a short wobble. None: the result shows at once.',
        animStep: 'Time per tile while a token walks. 0 = automatic: about 0.9 s for the whole move (0.08–0.13 s a tile).',
        animFly: 'How long a coin or deed takes to fly from one player\'s card to another (payments, trades, bankruptcy): '
            + 'Fast 0.4 s · Normal 0.75 s · Slow 1.2 s. In a trade or an estate the items set off one after another, '
            + 'spaced in proportion (0.14 s apart at Normal; a whole estate within 1.5 s). Custom: your own, 0.2–3 s.',
        animHighlights: 'Tile flashes on rent, cards and tax, the latest-event pop, and the green / red flash with a +$ / −$ chip on a player\'s cash.',
        cpuSpeed: 'The pause before each CPU action (roll, buy, bid, build, trade, end turn): '
            + 'Fast 0.15 s · Normal 0.7 s · Slow 1.4 s. The same pause spaces out back-to-back toasts '
            + '(at least 0.4 s apart). Custom: your own, 0.05–5 s.',
        express: 'One switch for a quick game: CPU speed Fast, plus Auto-roll dice, Auto-roll in jail and '
            + 'Auto-end turn. Turning it off puts back what you had before. Changing any of those four turns Express off.',
        autoRoll: 'Rolls for you at the start of your turn, after the auto-action pause. It waits while a sheet (card, trade, deed) is open.',
        autoRollJail: 'With Auto-roll on: in jail it rolls for doubles instead of waiting for you to use a card or pay the fine.',
        autoEndTurn: 'Ends your turn after the auto-action pause once your move is done (after doubles it rolls again instead), '
            + 'and closes notices such as drawn cards after twice the CPU pause (at least 1.4 s).',
        coverCams: 'Cover display only. Auto: when the page reaches the bottom edge (taller than wide), '
            + 'the board fills the top and the player cards, status icons and sheet buttons move to the '
            + 'bottom-left, clear of the cameras. On / Off: always / never.',
        buttonsPos: 'Internal display only. Centre: the turn buttons sit in the board centre under the latest '
            + 'event, as on the cover. Bottom: below the player cards, at the screen\'s bottom edge.',
        toastPos: 'Cover and internal displays. Centre: notices show in the board centre under the dice, over the '
            + 'feed\'s older lines. Bottom: at the screen\'s bottom edge (above the buttons there). Over an open sheet '
            + 'they always sit just above its buttons.',
        autoDelay: 'How long Auto-roll and Auto-end turn wait before acting. Default 1 s; 0–5 s.'
    },

    // Remembered so reopening returns to the tab last viewed this session
    _activeTab: 'display',

    load() {
        return StorageManager.get(STORAGE_KEYS.SETTINGS,
            { theme: 'auto', style: 'banker', ownership: 'dots', cpuSpeed: 'normal', animations: 'full', tradeLimit: 2, autoRoll: false, autoRollJail: true, autoEndTurn: false,
              colorblind: false, hideCpuDifficulty: false, tradeActivity: 'normal', tradeFlex: 'fair', cpuCounters: true, tradeValueHint: true, autoRejectCpuTrades: false, chartEvents: true, sound: 'off' });
    },

    /** A ms value from settings, clamped to its LIMITS (bad → fallback). */
    _ms(key, value, fallback) {
        const n = Math.round(Number(value));
        if (value === undefined || value === null || !Number.isFinite(n)) return fallback;
        const [lo, hi] = this.LIMITS[key];
        return Math.min(hi, Math.max(lo, n));
    },

    /** Pause before each CPU action, in ms (preset or Custom). */
    cpuDelay(settings) {
        if (settings.cpuSpeed === 'custom') return this._ms('cpuDelayMs', settings.cpuDelayMs, this.SPEEDS.normal);
        return this.SPEEDS[settings.cpuSpeed] || this.SPEEDS.normal;
    },

    isExpress(settings) {
        return Object.keys(this.EXPRESS).every(k => this._val(settings, k) === this.EXPRESS[k]);
    },

    apply(settings) {
        // theme.js / style.js (loaded in <head>) read the saved settings;
        // Style.apply() refreshes the theme too
        if (window.Style) Style.apply(settings.style);
        else if (window.Theme) Theme.refresh();
        Anim.set(settings.animations || 'full', settings.animCustom);
        // Board ownership marks: owner dots, the whole tile tinted, or the
        // owner's token emoji (tile.css; the cover screen shows dots for it)
        document.documentElement.dataset.ownership =
            ['tint', 'tokens'].includes(settings.ownership) ? settings.ownership : 'dots';
        // Colourblind-friendly colours: tinted tiles keep their owner dot (tile.css)
        document.documentElement.toggleAttribute('data-colorblind', !!settings.colorblind);
        const delay = this.cpuDelay(settings);
        DEV.cpuDelay = delay;
        DEV.autoDelay = this._ms('autoDelay', settings.autoDelay, 1000);
        DEV.tradeLimit = Number(settings.tradeLimit) || 2;
        DEV.autoRoll = !!settings.autoRoll;
        DEV.autoRollJail = settings.autoRollJail !== undefined ? !!settings.autoRollJail : true;
        DEV.autoEndTurn = !!settings.autoEndTurn;
        DEV.tradeActivity = settings.tradeActivity || 'normal';
        DEV.tradeFlex = settings.tradeFlex || 'fair';
        DEV.cpuCounters = settings.cpuCounters !== undefined ? !!settings.cpuCounters : true;
        DEV.tradeValueHint = settings.tradeValueHint !== undefined ? !!settings.tradeValueHint : true;
        DEV.autoRejectCpuTrades = !!settings.autoRejectCpuTrades;
        DEV.hideCpuDifficulty = !!settings.hideCpuDifficulty;
        if (window.Sound) Sound.setMode(settings.sound || 'off');
        if (typeof ScreenManager !== 'undefined') { ScreenManager.applyCoverCams(); ScreenManager._layoutControls(); }
        if (typeof ToastOffset !== 'undefined' && document.querySelector('body > .notification')) ToastOffset.layout();
        if (typeof BoardRenderer !== 'undefined') {
            BoardRenderer.TOKEN_COLORS = settings.colorblind
                ? BoardRenderer.COLORS_COLORBLIND : BoardRenderer.COLORS_DEFAULT;
        }
        if (window.engine) {
            window.engine.cpuDelay = delay;
            window.engine.tradeLimit = DEV.tradeLimit;
            window.engine.state.tradeLimit = DEV.tradeLimit; // CPU reads its proposal budget from state
            EventBus.emit('stateChanged', window.engine.state); // repaint player colors
        }
    },

    // A segmented pill row: options is [value, label] pairs. The label sits on
    // its own line so the pills get the full row width (fits the 270px screen).
    segRow(label, name, options, current, cls, help) {
        return `
            <div class="settings-row stacked">
                <span class="settings-label">${label}${this._helpBtn(help)}</span>
                ${Segmented.html(name, options, current, label, cls)}
            </div>${this._helpText(help)}`;
    },

    toggleRow(label, id, checked, help) {
        return `
            <label class="settings-row"><span class="settings-label">${label}${this._helpBtn(help)}</span>
                <input type="checkbox" class="toggle" id="${id}" ${checked ? 'checked' : ''}>
            </label>${this._helpText(help)}`;
    },

    /** A timing in seconds (stored as ms). ms is always a clamped number. */
    secRow(label, id, ms, [lo, hi], step, help) {
        const sec = n => String(Math.round(n) / 1000);
        return `
            <label class="settings-row"><span class="settings-label">${label}${this._helpBtn(help)}</span>
                <span class="settings-num">
                    <input type="number" class="settings-num-input" id="${id}" inputmode="decimal"
                           min="${sec(lo)}" max="${sec(hi)}" step="${step}" value="${sec(ms)}">
                    <span class="settings-num-unit">s</span>
                </span>
            </label>${this._helpText(help)}`;
    },

    // ? button beside a label; its text (HELP[key]) sits hidden under the row
    _helpBtn(key) {
        if (!key) return '';
        return ` <button type="button" class="settings-help-btn" data-help="${key}" aria-expanded="false"
                    aria-controls="help-${key}" aria-label="What does this do?">${Icons.svg('question')}</button>`;
    },

    _helpText(key) {
        if (!key) return '';
        const p = document.createElement('p');
        p.textContent = this.HELP[key];   // plain text, escaped
        return `<p class="settings-help" id="help-${key}" hidden>${p.innerHTML}</p>`;
    },

    /** A block shown only while the segmented field `name` equals `value`. */
    subBlock(name, value, current, rows) {
        return `<div class="settings-sub" data-when="${name}=${value}"${String(current) === value ? '' : ' hidden'}>${rows.join('')}</div>`;
    },

    /** Live viewport readout ("external · 378×273 @3x · app"): the numbers
     *  the responsive ladder keys on, so layout work can be checked on the
     *  real device (Motorola cover vs internal, browser tab vs installed app). */
    screenInfo() {
        const dpr = Math.round(window.devicePixelRatio * 100) / 100;
        const standalone = window.matchMedia('(display-mode: standalone)').matches ||
            window.matchMedia('(display-mode: fullscreen)').matches;
        const cams = document.documentElement.classList.contains('cover-cams') ? ' · cams' : '';
        return `${ScreenManager.getScreenType()} · ${window.innerWidth}×${window.innerHeight} @${dpr}x · ${standalone ? 'app' : 'browser'}${cams}`;
    },

    // Fullscreen is a live browser state, not a saved setting: the browser
    // only enters it from a user gesture, so it can't be restored on reload.
    fullscreenSupported() {
        const el = document.documentElement;
        return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled)
            && !!(el.requestFullscreen || el.webkitRequestFullscreen);
    },

    isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    },

    setFullscreen(on) {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        const p = on ? req.call(el, { navigationUI: 'hide' }) : exit.call(document);
        return Promise.resolve(p);
    },

    panel(name, active, rows) {
        // Inactive panels stay in layout (invisible + inert) so the sheet keeps
        // the tallest panel's height; see .settings-panels in setup.css
        return `<div class="settings-panel${active ? '' : ' is-inactive'}" data-panel="${name}"${active ? '' : ' inert aria-hidden="true"'}>${rows.join('')}</div>`;
    },

    /**
     * Every form field: [settings key, element id/name, kind, read default,
     * [min, max] ms for 'sec']. kind 'seg' = Segmented pills (name),
     * 'toggle' = .toggle checkbox (id), 'num' = Segmented whose value is
     * stored as a number, 'sec' = number input in seconds stored as ms.
     * A dotted key ('animCustom.walk') lives in a nested object. One table
     * drives rendering defaults, refilling the form and the instant save.
     */
    FIELDS: [
        ['theme', 'setting-theme', 'seg', 'auto'],
        ['style', 'setting-style', 'seg', 'banker'],
        ['ownership', 'setting-ownership', 'seg', 'dots'],
        ['animations', 'setting-anim', 'seg', 'full'],
        ['animCustom.dice', 'setting-anim-dice', 'seg', 'tumble'],
        ['animCustom.diceMs', 'setting-anim-dice-ms', 'sec', 700, Anim.LIMITS.diceMs],
        ['animCustom.walk', 'setting-anim-walk', 'toggle', true],
        ['animCustom.stepMs', 'setting-anim-step-ms', 'sec', 0, Anim.LIMITS.stepMs],
        ['animCustom.effects', 'setting-anim-effects', 'toggle', true],
        ['animCustom.fly', 'setting-anim-fly', 'seg', 'normal'],
        ['animCustom.flyMs', 'setting-anim-fly-ms', 'sec', 750, Anim.LIMITS.flyMs],
        ['animCustom.highlights', 'setting-anim-highlights', 'toggle', true],
        ['animCustom.countUp', 'setting-anim-countup', 'toggle', true],
        ['sound', 'setting-sound', 'seg', 'off'],
        ['coverCams', 'setting-cover-cams', 'seg', 'auto'],
        ['buttonsPos', 'setting-buttons-pos', 'seg', 'centre'],
        ['toastPos', 'setting-toast-pos', 'seg', 'centre'],
        ['colorblind', 'setting-colorblind', 'toggle', false],
        ['hideCpuDifficulty', 'setting-hide-cpu-diff', 'toggle', false],
        ['cpuSpeed', 'setting-speed', 'seg', 'normal'],
        ['cpuDelayMs', 'setting-cpu-ms', 'sec', 700, [50, 5000]],
        ['autoDelay', 'setting-auto-ms', 'sec', 1000, [0, 5000]],
        ['autoRoll', 'setting-autoroll', 'toggle', false],
        ['autoRollJail', 'setting-autoroll-jail', 'toggle', true],
        ['autoEndTurn', 'setting-autoend', 'toggle', false],
        ['tradeActivity', 'setting-trade-activity', 'seg', 'normal'],
        ['tradeFlex', 'setting-trade-flex', 'seg', 'fair'],
        ['tradeLimit', 'setting-trades', 'num', 2],
        ['cpuCounters', 'setting-cpu-counters', 'toggle', true],
        ['autoRejectCpuTrades', 'setting-auto-reject-trades', 'toggle', false],
        ['tradeValueHint', 'setting-trade-value-hint', 'toggle', true]
    ],

    /** Current value of a field, with its default when unset. */
    _val(settings, key) {
        const f = this.FIELDS.find(x => x[0] === key);
        const [head, sub] = key.split('.');
        const v = sub ? (settings[head] && typeof settings[head] === 'object' ? settings[head][sub] : undefined) : settings[key];
        if (v === undefined || v === null) return f[3];
        if (f[2] === 'sec') {   // a number field: always a clamped number
            const n = Math.round(Number(v));
            return Number.isFinite(n) ? Math.min(f[4][1], Math.max(f[4][0], n)) : f[3];
        }
        return v;
    },

    /** Copy of settings with key (dotted = nested) set to value. */
    _with(settings, key, value) {
        const [head, sub] = key.split('.');
        if (!sub) return { ...settings, [key]: value };
        const nested = settings[head] && typeof settings[head] === 'object' ? settings[head] : {};
        return { ...settings, [head]: { ...nested, [sub]: value } };
    },

    _save(updated) {
        StorageManager.set(STORAGE_KEYS.SETTINGS, updated);
        this.apply(updated);
    },

    /** Set every form field (and Express / the Custom blocks) from settings,
     *  without firing change events. */
    _fill(body, settings) {
        this.FIELDS.forEach(([key, id, kind]) => {
            const value = this._val(settings, key);
            if (kind === 'toggle') {
                const el = body.querySelector('#' + id);
                if (el) el.checked = !!value;
            } else if (kind === 'sec') {
                const el = body.querySelector('#' + id);
                if (el) el.value = String(value / 1000);
            } else {
                const el = body.querySelector(`input[name="${id}"][value="${CSS.escape(String(value))}"]`);
                if (el) el.checked = true;
            }
        });
        const express = body.querySelector('#setting-express');
        if (express) express.checked = this.isExpress(settings);
        // Auto-roll in jail only applies with Auto-roll on
        const jail = body.querySelector('#setting-autoroll-jail');
        if (jail) jail.disabled = !this._val(settings, 'autoRoll');
        body.querySelectorAll('.settings-sub[data-when]').forEach(el => {
            const [name, value] = el.dataset.when.split('=');
            el.hidden = Segmented.value(body, name) !== value;
        });
    },

    /** Read one field from the form and save it on its own. Re-loads first,
     *  so keys written elsewhere (cover-split's coverColumn, the chart's
     *  chartEvents) are never overwritten with a stale copy. */
    _saveField(body, field) {
        const [key, id, kind, , limits] = field;
        let value;
        if (kind === 'toggle') value = body.querySelector('#' + id).checked;
        else if (kind === 'sec') {
            const sec = parseFloat(body.querySelector('#' + id).value);
            value = Number.isFinite(sec)
                ? Math.min(limits[1], Math.max(limits[0], Math.round(sec * 1000)))
                : this._val(this.load(), key);   // empty / junk: keep the old value
        } else value = Segmented.value(body, id);
        if (kind === 'num') value = Number(value);
        if (value === null || value === undefined) return;
        const before = this.load();
        let updated = this._with(before, key, value);
        // First switch to Custom: start from the values just in use
        if (key === 'animations' && value === 'custom' && !before.animCustom) {
            const prev = Anim.resolve(before.animations || 'full');
            updated.animCustom = { dice: prev.dice, diceMs: prev.diceMs || 700, walk: prev.walk,
                stepMs: prev.stepMs, effects: prev.effects, fly: prev.fly, flyMs: prev.flyMs, highlights: prev.highlights, countUp: prev.countUp };
        }
        if (key === 'cpuSpeed' && value === 'custom' && before.cpuDelayMs === undefined) {
            updated.cpuDelayMs = this.cpuDelay(before);
        }
        // Leaving Express by hand drops what it would have restored
        if (key in this.EXPRESS && !this.isExpress(updated)) delete updated.expressRestore;
        this._save(updated);
        this._fill(body, updated);   // normalised numbers, Custom blocks, Express
    },

    /** Express switch in the sheet: set it, then refresh the form. */
    _setExpress(body, on) {
        this._fill(body, this.setExpress(on));
    },

    /** Express on: remember the four settings, then set them; off: put them
     *  back. Saves and applies; returns the new settings. Also used by the
     *  new-game prompt (SetupUI) to turn Express off. */
    setExpress(on) {
        const before = this.load();
        let updated = { ...before };
        if (on) {
            if (!this.isExpress(before)) {
                updated.expressRestore = {};
                Object.keys(this.EXPRESS).forEach(k => { updated.expressRestore[k] = this._val(before, k); });
            }
            Object.assign(updated, this.EXPRESS);
        } else {
            const back = before.expressRestore && typeof before.expressRestore === 'object' ? before.expressRestore : {};
            Object.keys(this.EXPRESS).forEach(k => {
                const f = this.FIELDS.find(x => x[0] === k);
                const v = back[k];
                updated[k] = typeof v === typeof f[3] ? v : f[3];
            });
            // Restoring something that is itself Express: fall back to the defaults
            if (this.isExpress(updated)) {
                Object.keys(this.EXPRESS).forEach(k => { updated[k] = this.FIELDS.find(x => x[0] === k)[3]; });
            }
            delete updated.expressRestore;
        }
        this._save(updated);
        return updated;
    },

    /**
     * Settings sheet. Every change saves and applies at once (theme previews
     * live); Done closes it. opts.inGame adds the 📜 History browser, which
     * only makes sense mid-game (the setup screen has the History tab), and
     * 💾 Saves (save states: save now / load / delete).
     */
    open(opts) {
        opts = opts || {};
        const settings = this.load();
        const v = key => this._val(settings, key);
        const cap = s => s[0].toUpperCase() + s.slice(1);
        const opts3 = vals => vals.map(x => [x, cap(x)]);

        // The shared subtab bar ([view, one-word label, icon]); the switching stays
        // here, since every panel stays mounted so the sheet keeps one height
        const tabs = [
            ['display', 'Display', 'eye'],
            ['flow', 'Turns', 'repeat'],
            ['trading', 'Trading', 'trade']
        ];
        if (!tabs.some(([id]) => id === this._activeTab)) this._activeTab = 'display';

        const body = document.createElement('div');
        body.className = 'settings-body';
        body.innerHTML = `
            ${Icons.subtabs('Settings sections', tabs, 'settings-tabs')}
            <div class="settings-panels">
            ${this.panel('display', this._activeTab === 'display', [
                this.fullscreenSupported() ? this.toggleRow('Full screen', 'setting-fullscreen', this.isFullscreen()) : '',
                this.segRow('Theme', 'setting-theme', [['auto', 'System'], ['light', 'Light'], ['dark', 'Dark']], v('theme')),
                this.segRow('Style', 'setting-style', Object.keys(Style.STYLES).map(id => [id, Style.STYLES[id].label]), v('style'), 'is-styles'),
                this.segRow('Sound effects', 'setting-sound',
                    [['off', 'Off'], ['human', 'Human'], ['all', 'All']], v('sound')),
                ScreenManager.getScreenType() === 'external'
                    ? this.segRow('Cover cameras', 'setting-cover-cams', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], v('coverCams'), '', 'coverCams') : '',
                ScreenManager.getScreenType() === 'internal'
                    ? this.segRow('Buttons', 'setting-buttons-pos', [['centre', 'Centre'], ['bottom', 'Bottom']], v('buttonsPos'), '', 'buttonsPos') : '',
                ScreenManager.getScreenType() !== 'full'
                    ? this.segRow('Notices', 'setting-toast-pos', [['centre', 'Centre'], ['bottom', 'Bottom']], v('toastPos'), '', 'toastPos') : '',
                this.segRow('Property ownership', 'setting-ownership', [['dots', 'Dots'], ['tokens', 'Tokens'], ['tint', 'Tinted tiles']], v('ownership'), '', 'ownership'),
                this.segRow('Animations', 'setting-anim', opts3(['full', 'reduced', 'off', 'custom']), v('animations'), '', 'animations'),
                this.subBlock('setting-anim', 'custom', v('animations'), [
                    this.segRow('Dice roll', 'setting-anim-dice',
                        [['tumble', 'Tumble'], ['shake', 'Shake'], ['off', 'None']], v('animCustom.dice'), '', 'animDice'),
                    this.secRow('Dice roll time', 'setting-anim-dice-ms', v('animCustom.diceMs'), Anim.LIMITS.diceMs, 0.05),
                    this.toggleRow('Tokens walk tile by tile', 'setting-anim-walk', v('animCustom.walk')),
                    this.secRow('Token step time', 'setting-anim-step-ms', v('animCustom.stepMs'), Anim.LIMITS.stepMs, 0.01, 'animStep'),
                    this.toggleRow('Board effects (flips, coins, flying deeds, buildings, confetti)', 'setting-anim-effects', v('animCustom.effects')),
                    this.segRow('Flight speed (cash and deeds)', 'setting-anim-fly',
                        [['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow'], ['custom', 'Custom']], v('animCustom.fly'), '', 'animFly'),
                    this.subBlock('setting-anim-fly', 'custom', v('animCustom.fly'), [
                        this.secRow('Flight time', 'setting-anim-fly-ms', v('animCustom.flyMs'), Anim.LIMITS.flyMs, 0.05)
                    ]),
                    this.toggleRow('Highlights (tile flashes, cash flash)', 'setting-anim-highlights', v('animCustom.highlights'), 'animHighlights'),
                    this.toggleRow('Cash count-up', 'setting-anim-countup', v('animCustom.countUp'))
                ]),
                this.toggleRow('Colorblind-friendly player colors', 'setting-colorblind', v('colorblind')),
                this.toggleRow('Hide CPU difficulty in player cards', 'setting-hide-cpu-diff', v('hideCpuDifficulty')),
                `<div class="settings-diag" id="setting-screen-info" title="Screen type · viewport · display mode"></div>`
            ])}
            ${this.panel('flow', this._activeTab === 'flow', [
                this.toggleRow('Express', 'setting-express', this.isExpress(settings), 'express'),
                this.segRow('CPU speed', 'setting-speed', opts3(['fast', 'normal', 'slow', 'custom']), v('cpuSpeed'), '', 'cpuSpeed'),
                this.subBlock('setting-speed', 'custom', v('cpuSpeed'), [
                    this.secRow('CPU pause per action', 'setting-cpu-ms', v('cpuDelayMs'), this.LIMITS.cpuDelayMs, 0.05)
                ]),
                this.toggleRow('Auto-roll dice (humans)', 'setting-autoroll', v('autoRoll'), 'autoRoll'),
                this.toggleRow('Auto-roll for doubles in jail', 'setting-autoroll-jail', v('autoRollJail') !== false, 'autoRollJail'),
                this.toggleRow('Auto-end turn (humans)', 'setting-autoend', v('autoEndTurn'), 'autoEndTurn'),
                this.secRow('Auto-action pause', 'setting-auto-ms', v('autoDelay'), this.LIMITS.autoDelay, 0.1, 'autoDelay')
            ])}
            ${this.panel('trading', this._activeTab === 'trading', [
                this.segRow('CPU trade activity', 'setting-trade-activity',
                    opts3(['off', 'rare', 'normal', 'eager']), v('tradeActivity')),
                this.segRow('CPU deal flexibility', 'setting-trade-flex',
                    opts3(['strict', 'fair', 'generous']), v('tradeFlex')),
                this.segRow('Trades per turn', 'setting-trades',
                    [1, 2, 3, 5].map(n => [n, String(n)]), Number(v('tradeLimit')) || 2),
                this.toggleRow('CPU counter-offers', 'setting-cpu-counters', v('cpuCounters') !== false),
                this.toggleRow('Auto-reject incoming CPU trades', 'setting-auto-reject-trades', v('autoRejectCpuTrades')),
                this.toggleRow('Show trade value estimate', 'setting-trade-value-hint', v('tradeValueHint') !== false)
            ])}
            </div>`;

        // Tab switching keeps every panel mounted (the sheet keeps one height)
        const tabBtns = body.querySelectorAll('.settings-tabs > button[data-view]');
        const paintTabs = () => tabBtns.forEach(b => {
            const on = b.dataset.view === this._activeTab;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        paintTabs();
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this._activeTab = btn.dataset.view;
                paintTabs();
                body.querySelectorAll('.settings-panel').forEach(p => {
                    const off = p.dataset.panel !== this._activeTab;
                    p.classList.toggle('is-inactive', off);
                    p.inert = off;
                    if (off) p.setAttribute('aria-hidden', 'true'); else p.removeAttribute('aria-hidden');
                });
                // Panels share the tallest one's height: start a shorter tab at
                // its top, not in the blank below it
                const scroller = body.closest('#modal-body');
                if (scroller) scroller.scrollTop = 0;
            });
        });

        // Instant apply: each field saves itself the moment it changes
        // (a number field on commit: Enter, blur or the spinner)
        this.FIELDS.forEach(field => {
            const [, id, kind] = field;
            const el = kind === 'toggle' || kind === 'sec' ? body.querySelector('#' + id)
                : body.querySelector(`input[name="${id}"]`)?.closest('.segmented');
            if (el) el.addEventListener('change', () => this._saveField(body, field));
        });
        const express = body.querySelector('#setting-express');
        if (express) express.addEventListener('change', () => this._setExpress(body, express.checked));
        this._fill(body, settings);

        // ? buttons: show / hide the option's explanation (inside a <label>,
        // so stop the tap from also flipping its toggle)
        body.querySelectorAll('.settings-help-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const text = body.querySelector('#help-' + btn.dataset.help);
                if (!text) return;
                text.hidden = !text.hidden;
                btn.setAttribute('aria-expanded', String(!text.hidden));
            });
        });

        // Screen readout (diagnostics) follows fold/unfold and full-screen changes live
        const screenEl = body.querySelector('#setting-screen-info');
        const syncScreen = () => {
            if (!screenEl.isConnected && screenEl.dataset.shown) {   // sheet closed
                window.removeEventListener('resize', syncScreen);
                return;
            }
            screenEl.textContent = this.screenInfo();
            screenEl.dataset.shown = '1';
        };
        syncScreen();
        window.addEventListener('resize', syncScreen);

        // Full screen is a live browser state, applied from the tap's gesture
        const fsToggle = body.querySelector('#setting-fullscreen');
        if (fsToggle) {
            const sync = () => {
                if (!fsToggle.isConnected) {   // sheet closed: drop the listeners
                    document.removeEventListener('fullscreenchange', sync);
                    document.removeEventListener('webkitfullscreenchange', sync);
                    return;
                }
                fsToggle.checked = this.isFullscreen();
            };
            fsToggle.addEventListener('change', () => {
                this.setFullscreen(fsToggle.checked).catch(() => {
                    showNotification('Full screen not available', 'warning');
                }).finally(sync);
            });
            // Track exits via the back gesture / Esc while the sheet is open
            document.addEventListener('fullscreenchange', sync);
            document.addEventListener('webkitfullscreenchange', sync);
        }

        const buttons = [];
        if (opts.inGame) {
            buttons.push({ label: '📜 History', class: 'btn-secondary', info: true, onClick: () => HistoryUI.openModal() });
            buttons.push({ label: '💾 Saves', class: 'btn-secondary', onClick: () => SaveStatesUI.open({ inGame: true }) });
        }
        buttons.push({ label: 'Done', class: 'btn-primary', onClick: () => { if (opts.onClose) opts.onClose(); } });

        Modals.show({ title: 'Settings', body, buttons });
    }
};

if (typeof window !== 'undefined') {
    window.SettingsUI = SettingsUI;
}
