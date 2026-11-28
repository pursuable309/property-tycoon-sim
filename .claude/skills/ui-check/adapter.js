/**
 * ui-check adapter for Property Tycoon: what the shared core (core/ui_check.js)
 * needs to know about this game. The core is a copy of .scripts/ui_check/
 * (never edit core/); everything game-specific lives here, in states.js and kit.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// localStorage keys the game reads at boot
const LINEUP_KEY = 'monopoly_setup_v1', SETTINGS_KEY = 'monopoly_settings';
const NAMES = ['Alexandra', 'Bo', 'Chen', 'Dmitri', 'Esperanza', 'Fu', 'Gil', 'Hal'];
const TOKENS = ['hat', 'car', 'dog', 'ship', 'boot', 'cat', 'moneybag', 'horse'];

// Read APIs answered by the harness (the same answers ci/static-serve.js gives
// on Actions, from ci.json "start.api"), so the home tabs look the same
// locally and on a runner, and a game played meanwhile doesn't show up as a
// baseline change. States that need games record their own in the page (kit.recordHistory).
const FIXED_API = {
    '/api/history': [],
    '/api/lab/jobs': [],
    '/api/lab/proposals': { waiting: [], running: [], declined: [] }
};

// Lab states (kit.labFixture): a finished job with its report and effort (E40, trimmed from a
// real run), a running job and three proposals. Handed to the page in afterKit; nothing reads
// the server's lab data.
const LAB_FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'lab-fixture.json'), 'utf8'));

function historyFiles(repo) {
    const dir = path.join(repo, 'history');
    try { return new Set(fs.readdirSync(dir).filter(f => f.endsWith('.json'))); } catch (e) { return new Set(); }
}

module.exports = {
    name: 'property-tycoon',

    // Matrix axis -> monopoly_settings key (a state's `settings` pins it).
    // always: in every variant name; else prefix+value when not the default.
    axes: {
        theme: { setting: 'theme', default: 'light', always: true, values: ['light', 'dark'], help: 'light,dark' },
        // Styles are the default (banker) plus styles/themes/style-<id>.css
        style: { setting: 'style', default: 'banker', always: true, help: 'banker,classic,felt,newsprint,contrast',
            values: ({ repo }) => ['banker', ...fs.readdirSync(path.join(repo, 'styles', 'themes'))
                .map(f => (/^style-([a-z0-9-]+)\.css$/.exec(f) || [])[1]).filter(Boolean)] },
        buttons: { setting: 'buttonsPos', default: 'centre', prefix: 'btn-', values: ['centre', 'bottom'],
            appliesTo: type => type === 'internal', help: 'centre,bottom (internal sizes only)' },
        cams: { setting: 'coverCams', default: 'auto', prefix: 'cams-', values: ['auto', 'on', 'off'],
            appliesTo: type => type === 'cover', help: 'auto,on,off (cover sizes only)' },
        anim: { setting: 'animations', default: 'off', prefix: 'anim-', values: ['off', 'reduced', 'full'], help: 'off,reduced,full' },
        ownership: { setting: 'ownership', default: 'dots', prefix: 'own-', values: ['dots', 'tokens', 'tint'], help: 'board ownership marks' }
    },

    // Seat counts: game states take the matrix's --seats, home states 4
    seats: { default: [4], min: 2, max: 8, prefix: 's',
        forState: (st, vals) => (st.seats ? [st.seats] : st.base === 'home' ? [4] : vals) },

    defaultBase: 'home',
    bases: {
        home: async () => {},
        game: (page, c, cfg) => page.evaluate(a => window.__uic.startGame(a), { seats: c.seats, seed: cfg.seed, rolloff: false }),
        rolloff: (page, c, cfg) => page.evaluate(a => window.__uic.startGame(a), { seats: c.seats, seed: cfg.seed, rolloff: true })
    },

    // In-page selectors for the layout checks (core/lib/checks.js)
    checkCfg: {
        cards: '#player-panels > *',                  // player cards (toasts must not cover them)
        ignore: '#dev-cams',                          // harness overlays
        // (.announce-prev: the centre feed fades older lines by age, LogUI._announce)
        muted: ':disabled, [aria-disabled="true"], .panel-bankrupt, .bidder-passed, .is-taken, .is-out, .rec-card-dismissed, .announce-prev',
        // tap-size: board tiles are inherently small on the covers (40 on a 270px
        // board); the deed is also reachable from the player card / portfolio
        tile: '.tile',
        tileNote: 'inherently small on this board size (the ring must fit 40 tiles); a deed is also reachable from its owner\'s card',
        // the clamped centre-feed line opens on a tap ("More"): a note, not a warning
        ellipsisOk: '.lever-clamp'
    },

    kitFile: 'kit.js',

    options: {
        'show-cams': { help: 'draw DEV.showCams() keep-out overlay on cam layouts', ci: true,
            afterSettle: page => page.evaluate(() => { if (document.documentElement.classList.contains('cover-cams') && window.DEV) DEV.showCams(); }) }
    },

    /** History hygiene, network side: no history write ever reaches the server. */
    async context(ctx) {
        const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        await ctx.route(u => /^\/(api\/(history|lab)(\/|$)|history\/)/.test(u.pathname), route => {
            const req = route.request(), m = req.method();
            const p = new URL(req.url()).pathname.replace(/\/+$/, '');
            if (m !== 'GET' && m !== 'HEAD') return json(route, 200, { ok: true, uiCheck: 'blocked' });
            if (Object.prototype.hasOwnProperty.call(FIXED_API, p)) return json(route, 200, FIXED_API[p]);
            return json(route, 404, { ok: false, error: 'not found' });
        });
    },

    /** Settings and the remembered lineup, before the case's fresh load. */
    async prepare(page, c, cfg, settings) {
        const names = ((cfg.content || {})[c.content] || {}).names || [];
        const lineup = {
            seats: Array.from({ length: 8 }, (_, i) => ({
                type: i === 0 ? 'human' : i < 4 ? 'cpu' : 'none',
                name: names[i] || NAMES[i], token: TOKENS[i], difficulty: 3, personality: 'random'
            })),
            rules: {}
        };
        await page.evaluate(([sk, s, lk, l]) => {
            localStorage.clear();
            sessionStorage.clear();
            localStorage.setItem(sk, JSON.stringify(s));
            localStorage.setItem(lk, JSON.stringify(l));
        }, [SETTINGS_KEY, settings, LINEUP_KEY, lineup]);
    },

    ready: page => page.waitForFunction(() => window.SetupUI && window.ScreenManager && document.readyState === 'complete'
        && document.querySelector('#setup-seats .seat-row'), null, { timeout: 15000 }),

    afterKit: (page, { content, profile }) => page.evaluate(([name, p, lab]) => {
        window.__uic.stubHistory(); window.__uic.useContent(name, p); window.__uic.labData = lab;
    }, [content, profile, LAB_FIXTURE]),

    stepArg: c => ({ seats: c.seats }),

    caseExtra: async page => ({ gameId: await page.evaluate(() => (window.engine && engine.state && engine.state.gameId) || null) }),

    beforeRun: ({ repo }) => historyFiles(repo),

    /** Delete only records this run created: new since the run started AND
     *  named after a game the harness started (its gameIds are collected per
     *  case). A new record from anything else (the user playing a real game
     *  meanwhile) is left alone and reported. */
    afterRun(before, out, { repo }) {
        if (!before) return;
        const ownIds = new Set(out.map(r => r.gameId).filter(Boolean));
        const removed = [], foreign = [];
        for (const f of historyFiles(repo)) {
            if (before.has(f)) continue;
            if (ownIds.has(f.replace(/\.json$/, ''))) {
                fs.unlinkSync(path.join(repo, 'history', f));
                removed.push(f);
            } else foreign.push(f);
        }
        if (removed.length) console.log(`hygiene: removed ${removed.length} history record(s) this run created: ${removed.join(', ')}`);
        if (foreign.length) console.log(`hygiene: left alone ${foreign.length} new record(s) not from ui-check (a real game?): ${foreign.join(', ')}`);
    }
};
