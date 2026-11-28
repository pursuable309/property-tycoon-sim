#!/usr/bin/env node
/**
 * ui-check (shared core): drive every screen, sheet and modal of a web app
 * through a declarative state catalog across the shared screen sizes,
 * screenshot each, run in-page layout checks, and write a timestamped run
 * directory with results.json and an HTML contact sheet.
 *
 * Canonical in .scripts/ui_check/; each app holds a byte-identical copy in
 * its ui-check folder's core/ (.shared/manifest.json) next to its adapter:
 *   <app ui dir>/config.json   url, repo, outRoot, matrix, content, seed, prune, diff
 *   <app ui dir>/adapter.js    axes, bases, sign-in / storage, waits, check selectors
 *   <app ui dir>/states.js     the state catalog
 * The app dir is --app DIR, else $UI_APP, else the folder holding core/.
 *
 *   node <app ui dir>/core/ui_check.js --states 'sheet-*' --sizes cover-cams,internal
 *   node <app ui dir>/core/ui_check.js --list
 *
 * Browser: the shared headless Chromium over CDP (connectOverCDP to
 * 127.0.0.1:9222, started with the in-proot start script; never launch()).
 * Each run uses its own browser context (own storage), one reused page, and
 * a fresh page load per case. See README.md.
 *
 * --ci (GitHub Actions only, via gh_ui.sh and ci/ui.yml): the one place that
 * calls chromium.launch(), on the disposable runner, with playwright-core from
 * core/ci/node_modules (npm ci of ci/package-lock.json). The root CLAUDE.md
 * rule "never chromium.launch()" is about the phone and still holds there:
 * without --ci nothing below changes. --shard i/n runs every n-th case;
 * --merge combines shard runs (or rebuilds one run's report, e.g. with a baseline).
 *
 * Usage: node ui_check.js [--app DIR] [filters] | --list | --plan | --merge DIRS | --prune (see --help)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE_DIR = __dirname;
// Phone paths (CDP start script, heartbeat, Mission Control header file) live
// in lib/phone.js, which the CI snapshot doesn't ship: loaded only off --ci.
let phone = null;
const PHONE = () => (phone = phone || require('./lib/phone'));
let CI = false;   // set from --ci in main()

const { CHECK_CFG, runChecks } = require('./lib/checks');
const report = require('./lib/report');
const png = require('./lib/png');
const KIT_CORE_SRC = fs.readFileSync(path.join(CORE_DIR, 'lib', 'kit-core.js'), 'utf8');
const SHARED_SIZES = JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'lib', 'sizes.json'), 'utf8')).sizes;

/** Screen type the shared device queries give a size (.shared/README.md "Screen Sizes"). */
const typeOf = s => (s.h < 500 ? 'cover' : s.w <= 480 ? 'internal' : 'full');

/* ==================== App (adapter) ==================== */

// Filled by loadApp(): { dir, cfg, adapter, states, repo, axes, seats }
let APP = null;

function loadApp(appArg, configArg) {
    const dir = path.resolve(appArg || process.env.UI_APP || path.dirname(CORE_DIR));
    const cfgPath = configArg ? path.resolve(configArg) : path.join(dir, 'config.json');
    if (!fs.existsSync(cfgPath)) throw usage(`no config.json in ${dir}: pass --app <the app's ui-check dir>`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const adapter = require(path.join(dir, 'adapter.js'));
    const { STATES } = require(path.join(dir, 'states.js'));
    const repo = path.resolve(dir, cfg.repo || '.');
    const sizes = Object.assign({}, SHARED_SIZES, cfg.sizes || {});
    cfg.sizes = sizes;
    const axes = adapter.axes || {};
    for (const [k, a] of Object.entries(axes)) {
        if (!/^[a-z][a-z0-9-]*$/.test(k) || ['states', 'groups', 'skip', 'sizes', 'seats', 'content'].includes(k)) throw new Error(`adapter axis "${k}": bad or reserved name`);
        if (a.default === undefined) throw new Error(`adapter axis "${k}" has no default`);
    }
    APP = { dir, cfg, adapter, states: STATES, repo, axes, seats: adapter.seats || null,
        kitSrc: adapter.kitFile ? fs.readFileSync(path.join(dir, adapter.kitFile), 'utf8') : (adapter.kitSrc || ''),
        options: adapter.options || {} };
    return APP;
}

/* ==================== CLI ==================== */

function help() {
    const ax = Object.entries((APP && APP.axes) || {}).map(([k, a]) =>
        `  --${k.padEnd(9)} V,...   ${a.help || ''} (default ${(APP.cfg.matrix || {})[k] || a.default})`).join('\n');
    const opts = Object.entries((APP && APP.options) || {}).map(([k, o]) => `  --${k.padEnd(18)} ${o.help || ''}`).join('\n');
    return `ui-check — screenshot + layout-check every UI state across screen sizes

Options (lists are comma-separated):
  --app DIR            the app's ui-check dir (default: the folder holding core/)
  --states  ID,...     state ids; * wildcards ('sheet-*'); default all
  --groups  G,...      state groups (see --list)
  --skip    ID,...     state ids to leave out (wildcards ok)
  --sizes   S,...      preset names (see --list) or WxH; default: the config matrix
${APP && APP.seats ? '  --seats   N,...      seat counts for states that take them\n' : ''}${ax ? ax + '\n' : ''}  --content P,...      content profiles (config.json "content"), e.g. normal,stress
  --baseline DIR|latest   compare with an earlier run, flag changed images
  --out DIR            run directory (default <outRoot>/<timestamp>)
  --config FILE        config JSON (default: config.json in the app dir)
  --no-embed           link the screenshots as sibling files instead of inlining
                       them (default: inlined, so report.html opens from a file
                       manager; --ci never inlines)
${opts ? opts + '\n' : ''}  --fail-exit          exit 1 if any check failed
  --restart-server     if the app's server is down, restart it via Mission Control
  --list               print states and size presets, then exit
  --plan               print the case count for these filters, then exit
  --shard I/N          run only every N-th case, starting at case I (1-based)
  --merge DIR,...      no browser: combine earlier runs (shards) into --out
                       (or rebuild one run's report in place), with --baseline
  --prune              no browser: delete old runs (config.json "prune")
  --dry-run            with --prune: list what would go, delete nothing
  --no-prune           skip the automatic prune at the end of a run
  --ci                 GitHub Actions runner only: launch Chromium itself
  -h, --help

Full sweeps run on GitHub Actions: bash <app ui dir>/gh_ui.sh submit [these filters]`;
}

// Every flag ui_check.js knows (plus the adapter's axes and options). An
// unknown flag or a value flag with no value is an error: silently ignoring
// `--size cover-cams` (typo) would run the whole matrix on the phone.
const BASE_BOOL = ['embed', 'no-embed', 'fail-exit', 'restart-server', 'list', 'plan', 'ci', 'prune', 'no-prune', 'dry-run', 'h', 'help'];
const BASE_VALUE = ['app', 'states', 'groups', 'skip', 'sizes', 'seats', 'content', 'baseline', 'out', 'config', 'shard', 'merge'];

/** A mistake in the command line or a state's definition: printed without a stack. */
const usage = msg => Object.assign(new Error(msg), { usage: true });

function parseArgs(argv, boolFlags, valueFlags) {
    const o = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--') && a !== '-h') { o._.push(a); continue; }
        const eq = a.indexOf('=');
        const k = (eq < 0 ? a : a.slice(0, eq)).replace(/^--?/, '');
        const inline = eq < 0 ? undefined : a.slice(eq + 1);
        if (boolFlags.includes(k)) { o[k] = true; continue; }
        if (!valueFlags.includes(k)) throw usage(`unknown option --${k} (see --help)`);
        const v = inline !== undefined ? inline : argv[++i];
        if (v === undefined || v === '' || (inline === undefined && /^--?[a-z]/.test(v))) throw usage(`--${k} needs a value`);
        o[k] = v;
    }
    if (o._.length) throw usage(`unexpected argument ${JSON.stringify(o._[0])} (options start with --)`);
    return o;
}
/** --app / --config first (they decide which axes and options exist). */
function preArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const m = /^--(app|config)(?:=(.*))?$/.exec(argv[i]);
        if (m) o[m[1]] = m[2] !== undefined ? m[2] : argv[i + 1];
    }
    return o;
}
const list = v => (v === undefined || v === true ? null : String(v).split(',').map(s => s.trim()).filter(Boolean));
const wild = pats => id => pats.some(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(id));

/* ==================== Matrix ==================== */

/** Allowed values of an axis (the adapter lists them; a function is called
 *  with { repo, cfg, dir }). A typo would otherwise write a setting the app
 *  ignores and screenshot the default under the wrong name. */
function axisValues(name) {
    const a = APP.axes[name];
    if (!a || !a.values) return null;
    return typeof a.values === 'function' ? a.values({ repo: APP.repo, cfg: APP.cfg, dir: APP.dir }) : a.values;
}
/** The key a state's `settings` pins an axis with (its setting name, else the axis name). */
const pinKey = name => APP.axes[name].setting || name;

function buildCases(cfg, args) {
    const STATES = APP.states;
    const statePats = list(args.states), groups = list(args.groups), skip = list(args.skip);
    let states = STATES.filter(s => (!statePats || wild(statePats)(s.id)) && (!groups || groups.includes(s.group)) && (!skip || !wild(skip)(s.id)));
    if (!states.length) throw usage('no state matches the filters (try --list)');
    const matrix = cfg.matrix || {};

    const sizes = (list(args.sizes) || matrix.sizes || Object.keys(cfg.sizes)).map(name => {
        const m = /^(\d+)x(\d+)$/.exec(name);
        if (m) return { name, w: +m[1], h: +m[2] };
        const p = cfg.sizes[name];
        if (!p) throw usage(`unknown size "${name}" (see --list)`);
        return { name, w: p.w, h: p.h };
    });
    const axisNames = Object.keys(APP.axes);
    const axisList = {};
    for (const k of axisNames) {
        const v = list(args[k]) || matrix[k] || [APP.axes[k].default];
        const ok = axisValues(k);
        const bad = ok && v.find(x => !ok.includes(x));
        if (bad !== undefined && bad !== null) throw usage(`--${k}: unknown value "${bad}" (one of: ${ok.join(', ')})`);
        axisList[k] = v;
    }
    const S = APP.seats;
    let seatsAxis = [null];
    if (S) {
        seatsAxis = (list(args.seats) || matrix.seats || S.default).map(Number);
        if (seatsAxis.some(n => !Number.isInteger(n) || n < S.min || n > S.max)) throw usage(`--seats: whole numbers ${S.min}-${S.max}`);
    } else if (args.seats) throw usage('--seats: this app has no seats');
    // Content profiles (names, numbers) are config data, not a setting
    const contentNames = Object.keys(cfg.content || {});
    const contentDefault = contentNames[0] || 'normal';
    const contents = list(args.content) || matrix.content || [contentDefault];
    const badContent = contents.find(x => !Object.hasOwn(cfg.content || { [contentDefault]: {} }, x));
    if (badContent) throw usage(`--content: unknown value "${badContent}" (one of: ${(contentNames.length ? contentNames : [contentDefault]).join(', ')})`);
    const groupsKnown = [...new Set(STATES.map(s => s.group))];
    if (groups) for (const g of groups) if (!groupsKnown.includes(g)) throw usage(`--groups: unknown group "${g}" (one of: ${groupsKnown.join(', ')})`);
    const bases = APP.adapter.bases || {};

    // Every combination of the axes, in declaration order
    const combos = axisNames.reduce((acc, k) => acc.flatMap(o => axisList[k].map(v => Object.assign({}, o, { [k]: v }))), [{}]);

    const cases = [], seen = new Set();
    for (const st of states) {
        const base = st.base || APP.adapter.defaultBase;
        if (base && !Object.hasOwn(bases, base)) throw usage(`${st.id}: unknown base "${base}" (one of: ${Object.keys(bases).join(', ')})`);
        // A state's own settings (st.settings) win over the matrix axes, so
        // its cases collapse to one per size for that axis (deduped below)
        const fixed = st.settings || {};
        for (const k of Object.keys(fixed)) {
            const ax = axisNames.find(a => pinKey(a) === k);
            const ok = ax && axisValues(ax);
            if (ok && !ok.includes(fixed[k])) throw usage(`${st.id}: settings.${k} "${fixed[k]}" is not one of ${ok.join(', ')}`);
        }
        const pinned = ax => pinKey(ax) in fixed;
        for (const size of sizes) {
            const type = typeOf(size);
            const seatList = S ? (S.forState ? S.forState(st, seatsAxis) : (st.seats ? [st.seats] : seatsAxis)) : [null];
            for (const seats0 of seatList) {
                const seats = S ? Math.max(seats0, st.minSeats || S.min) : null;
                for (const combo of combos) for (const content of contents) {
                    const ax = {};
                    for (const k of axisNames) {
                        const a = APP.axes[k];
                        const v = a.appliesTo && !a.appliesTo(type) ? a.default : combo[k];
                        ax[k] = pinned(k) ? fixed[pinKey(k)] : v;
                    }
                    // Variant name: the seat count, every `always` axis, then
                    // every other axis that isn't its default (and isn't pinned)
                    const variant = [S ? `${S.prefix || 's'}${seats}` : '',
                        ...axisNames.map(k => {
                            const a = APP.axes[k];
                            if (a.always) return ax[k];
                            return ax[k] !== a.default && !pinned(k) ? (a.prefix !== undefined ? a.prefix : k + '-') + ax[k] : '';
                        }),
                        content !== contentDefault ? content : ''].filter(Boolean).join('-') || 'default';
                    const file = `${st.id}__${size.name}__${variant}.png`;
                    if (seen.has(file)) continue;
                    seen.add(file);
                    cases.push({ idx: cases.length, st, base, size, type, seats, ax, content, variant, file });
                }
            }
        }
    }
    return { cases, sizes };
}

/** { <setting or axis name>: value } of a case, for results.json and adapter.prepare. */
const caseSettings = c => Object.fromEntries(Object.keys(APP.axes).map(k => [pinKey(k), c.ax[k]]));

/* ==================== Browser ==================== */

function touchHeartbeat() {
    if (CI) return;   // no idle watchdog on a runner
    const hb = PHONE().HEARTBEAT;
    try { const t = new Date(); fs.utimesSync(hb, t, t); } catch (e) { try { fs.writeFileSync(hb, ''); } catch (_) { /* no watchdog */ } }
}

function startChromium() {
    execFileSync('bash', [PHONE().START_SCRIPT], { stdio: 'ignore', timeout: 30000 });
}

/** playwright-core: the phone's global @playwright/cli copy, or on a CI
 *  runner the lockfile-pinned one in core/ci/node_modules. */
function playwright() {
    return require(CI ? path.join(CORE_DIR, 'ci', 'node_modules', 'playwright-core') : PHONE().PW_CORE);
}

async function serverUp(url) {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        return res.ok;
    } catch (e) { return false; }
}

/** The Mission Control project id the restart goes to (a registered app only). */
function projectId(cfg) {
    const id = cfg.projectId;
    if (!id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return null;
    return id;
}

function restartServer(cfg) {
    // The one allowed restart path: Mission Control, token sent from its header file
    const out = execFileSync('curl', ['-s', '-H', '@' + PHONE().MC_HEADER_FILE, '-X', 'POST',
        `http://localhost:8000/api/projects/${projectId(cfg)}/restart`], { encoding: 'utf8', timeout: 30000 });
    return out.slice(0, 300);
}

class Session {
    constructor(cfg) { this.cfg = cfg; this.consoleBucket = []; this.content = null; this.case = null; }

    async open() {
        const { chromium } = playwright();
        if (CI) {
            // GitHub Actions runner only (see the header comment): a throwaway
            // VM, so this run owns the browser. channel 'chromium' = the full
            // Chromium build in new headless mode, as the phone's start script runs it.
            this.browser = await chromium.launch({ channel: 'chromium', headless: true, timeout: 60000,
                args: ['--disable-dev-shm-usage', '--disable-gpu'] });
        } else {
            startChromium();
            this.browser = await chromium.connectOverCDP(this.cfg.cdp || 'http://127.0.0.1:9222', { timeout: 20000 });
        }
        // Own context: its storage is separate from any other tab's, and it
        // goes away with the run
        this.ctx = await this.browser.newContext({ viewport: { width: 400, height: 700 }, deviceScaleFactor: 1 });
        // The app's network routes and sign-in (PT: fixed history answers,
        // writes blocked; Spare Change: the test vault's session)
        if (APP.adapter.context) await APP.adapter.context(this.ctx, this.cfg, { ci: CI, repo: APP.repo, dir: APP.dir });
        this.page = await this.ctx.newPage();
        // Scrollbars take no width on the phone (Chrome's overlay ones) or
        // on Actions (headless hides them); the phone's CDP browser draws
        // classic 15px bars that would narrow every scrolling screen and
        // flag clipping the real device doesn't have. Hide them everywhere.
        try {
            const cdp = await this.ctx.newCDPSession(this.page);
            await cdp.send('Emulation.setScrollbarsHidden', { hidden: true });
        } catch (e) { console.warn(`ui-check: could not hide scrollbars (${e.message}); local widths may be ~15px short`); }
        this.page.on('console', msg => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            // The browser's own favicon probe (an app without /favicon.ico): not the page's doing
            if (/\/favicon\.ico$/.test((msg.location() || {}).url || '')) return;
            this.consoleBucket.push({ kind: /Failed to load resource|net::ERR_/.test(text) ? 'resource' : 'console', text: text.slice(0, 300), url: (msg.location() || {}).url || '' });
        });
        this.page.on('pageerror', err => this.consoleBucket.push({ kind: 'pageerror', text: String(err && err.message || err).slice(0, 300) }));
        this.page.on('requestfailed', req => {
            const f = req.failure();
            if (f && /ERR_ABORTED/.test(f.errorText)) return;   // navigations away
            this.consoleBucket.push({ kind: 'resource', text: `${req.method()} ${req.url()} failed: ${f ? f.errorText : '?'}` });
        });
        this.page.setDefaultTimeout(15000);
    }

    alive() { return this.browser && this.browser.isConnected(); }

    async close() {
        try {
            if (this.page && !this.page.isClosed()) {
                await this.page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* */ } }).catch(() => {});
            }
            if (this.ctx) await this.ctx.close().catch(() => {});
        } finally {
            if (this.browser) await this.browser.close().catch(() => {});   // CDP: disconnects, the shared browser keeps running; --ci: ends the launched one
        }
    }

    /** After every load: the app's wait, then the kits (core, then the app's), then its afterKit. */
    async ready() {
        if (APP.adapter.ready) await APP.adapter.ready(this.page, this.case);
        else await this.page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 15000 });
        const r = await this.page.evaluate(KIT_CORE_SRC);
        if (APP.kitSrc) await this.page.evaluate(APP.kitSrc);
        if (APP.adapter.afterKit) {
            await APP.adapter.afterKit(this.page, { content: this.content, profile: (this.cfg.content || {})[this.content] || {}, case: this.case, cfg: this.cfg });
        }
        return r;
    }
}

/* ==================== One case ==================== */

async function runCase(sess, c, cfg, runDir, opts) {
    const page = sess.page;
    const t0 = Date.now();
    sess.consoleBucket = [];
    sess.content = c.content;
    sess.case = c;
    const issues = [];
    let info = null, phase = 'load', extra = {};
    touchHeartbeat();
    try {
        await page.setViewportSize({ width: c.size.w, height: c.size.h });
        if (!page.url().startsWith(cfg.url)) await page.goto(cfg.url, { waitUntil: 'load' });
        // Storage for this case (settings from the axes, the app's own keys),
        // then a fresh load that reads it
        const settings = Object.assign({}, cfg.settings || {}, caseSettings(c), c.st.settings || {});
        if (APP.adapter.prepare) await APP.adapter.prepare(page, c, cfg, settings);
        else await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.reload({ waitUntil: 'load' });
        await sess.ready();

        phase = 'base';
        if (c.base && APP.adapter.bases[c.base]) await APP.adapter.bases[c.base](page, c, cfg);
        const stepArg = Object.assign({ seats: c.seats, type: c.type }, c.ax);
        if (c.seats === null) delete stepArg.seats;
        for (let i = 0; i < c.st.steps.length; i++) {
            const step = c.st.steps[i];
            phase = `step ${i + 1}`;
            if (step === 'reload') {
                await page.reload({ waitUntil: 'load' });
                await sess.ready();
                continue;
            }
            const ret = await page.evaluate(`(${step.toString()})(window.__uic, ${JSON.stringify(APP.adapter.stepArg ? APP.adapter.stepArg(c) : stepArg)})`);
            // A step that could not reach its state says so: kit.waitFor
            // resolves false, PT's kit.playUntil 'timeout'. The screenshot is
            // then of some other moment, so the case is flagged instead of passing.
            if (ret === false || ret === 'timeout') {
                issues.push({ sev: 'warn', check: 'state', msg: `step ${i + 1} did not reach its state (${ret === false ? 'waited in vain' : 'timed out'}): the screenshot may not show "${c.st.title}"` });
            }
            await page.evaluate(() => window.__uic.frames(1));
        }
        if (c.st.animAt !== undefined) {
            // Freeze every running animation at animAt ms into its own
            // timeline (delays count), so the frame is the same on every run
            phase = 'animAt';
            const n = await page.evaluate(ms => window.__uic.pauseAnimations(ms), c.st.animAt);
            if (!n) issues.push({ sev: 'warn', check: 'anim', msg: `animAt ${c.st.animAt}: no animation was running to freeze` });
        }
        phase = 'settle';
        await page.evaluate(ms => (window.__uic.freeze(), window.__uic.frames(2).then(() => window.__uic.wait(ms))), c.st.settle || 120);
        for (const [k, o] of Object.entries(APP.options)) if (opts[k] && o.afterSettle) await o.afterSettle(page, c);

        if (APP.adapter.caseExtra) extra = (await APP.adapter.caseExtra(page, c)) || {};
        phase = 'checks';
        // skipMoving: only a frozen mid-animation frame exempts its animating
        // tappables (an infinite pulse with animations on is still checked)
        const checkCfg = Object.assign({}, CHECK_CFG, APP.adapter.checkCfg || {}, c.st.checkCfg || {}, { skipMoving: c.st.animAt !== undefined });
        const res = await page.evaluate(`(${runChecks.toString()})(${JSON.stringify(checkCfg)})`);
        info = res.info;
        issues.push(...res.issues);
    } catch (e) {
        issues.push({ sev: 'error', check: 'harness', msg: `${phase}: ${String(e && e.message || e).split('\n')[0].slice(0, 300)}` });
    }
    try {
        // 'disabled' fast-forwards animations to their end; a frozen frame must stay put
        await page.screenshot({ path: path.join(runDir, c.file), animations: c.st.animAt !== undefined ? 'allow' : 'disabled', caret: 'hide', timeout: 15000 });
    } catch (e) {
        issues.push({ sev: 'error', check: 'harness', msg: `screenshot: ${String(e.message).split('\n')[0]}` });
    }
    for (const m of sess.consoleBucket) {
        issues.push({ sev: m.kind === 'resource' ? 'warn' : 'fail', check: m.kind === 'resource' ? 'resource' : 'console', msg: m.text });
    }
    return Object.assign({ idx: c.idx, state: c.st.id, title: c.st.title, group: c.st.group, size: c.size.name, variant: c.variant, seats: c.seats,
        settings: caseSettings(c), content: c.content, file: c.file, ms: Date.now() - t0, issues, info }, extra);
}

/* ==================== Baseline ==================== */

// GitHub Actions runs (gh_ui.sh fetch) land in <stamp>-gh/: their fonts and
// raster differ from the phone's, so `latest` only pairs runs of the same kind.
const isGhRun = d => /-gh$/.test(path.basename(d));

/** { label, dirs }: the run(s) to compare with, newest first. `latest` is
 *  every earlier run of the same kind, and each screenshot is compared with
 *  the newest one that has it: a targeted run (--states 'sheet-*') after a
 *  run of other states still finds the sheets in the run before that. */
function resolveBaseline(arg, outRoot, runDir) {
    if (!arg) return null;
    if (arg !== 'latest') {
        const p = path.resolve(arg);
        if (!fs.existsSync(path.join(p, 'results.json'))) throw new Error(`baseline ${p} has no results.json`);
        if (p === path.resolve(runDir)) throw new Error('baseline is the run itself');
        return { label: path.basename(p), dirs: [p] };
    }
    const gh = isGhRun(runDir), me = path.basename(runDir);
    // Only timestamped runs (<YYYYMMDD-HHMMSS>[-gh]): a named --out run
    // (scratch, an agent's) is not a baseline unless named outright, and
    // names would sort after every stamp. Earlier than this run if it has a stamp.
    const STAMP = /^\d{8}-\d{6}(-gh)?$/;
    const dirs = fs.existsSync(outRoot) ? fs.readdirSync(outRoot).filter(d => STAMP.test(d)).map(d => path.join(outRoot, d))
        .filter(d => d !== path.resolve(runDir) && fs.existsSync(path.join(d, 'results.json')) && isGhRun(d) === gh
            && (!STAMP.test(me) || path.basename(d) < me)).sort() : [];
    if (!dirs.length) throw Object.assign(new Error(`no earlier ${gh ? 'GitHub Actions (-gh) ' : ''}run to use as baseline`), { usage: true });
    dirs.reverse();
    return { label: `latest (${path.basename(dirs[0])} and earlier)`, dirs };
}

/* ==================== Results ==================== */

/** Baseline diff, totals, results.json and report.html for a finished (or
 *  merged) run. Returns the exit code. */
function finalize(out, meta, runDir, baseline, cfg, args) {
    if (baseline) {
        for (const r of out) {
            const b = path.join(runDir, r.file);
            if (!fs.existsSync(b)) continue;
            const from = baseline.dirs.find(d => fs.existsSync(path.join(d, r.file)));
            if (!from) { r.diff = { missing: true, changed: false, note: 'not in baseline' }; continue; }
            const d = png.compare(fs.readFileSync(path.join(from, r.file)), fs.readFileSync(b), cfg.diff || {});
            r.diff = { changed: d.changed, ratio: d.ratio, note: `${d.note} (vs ${path.basename(from)})`, against: path.basename(from) };
            if (d.diff) {
                fs.mkdirSync(path.join(runDir, 'diff'), { recursive: true });
                r.diff.diffFile = path.join('diff', r.file);
                fs.writeFileSync(path.join(runDir, r.diff.diffFile), d.diff);
            }
        }
    }

    const count = sev => out.reduce((n, r) => n + r.issues.filter(i => i.sev === sev).length, 0);
    const results = Object.assign({
        runId: path.basename(runDir), url: cfg.url, baseline: baseline ? baseline.label : null
    }, meta, {
        totals: { cases: out.length, fail: count('fail'), warn: count('warn'), info: count('info'), error: count('error'),
            changed: out.filter(r => r.diff && r.diff.changed).length,
            casesWithFail: out.filter(r => r.issues.some(i => i.sev === 'fail')).length },
        cases: out
    });
    fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 1));
    fs.writeFileSync(path.join(runDir, 'report.html'), report.build(results, runDir, { embed: !args['no-embed'] && !args.ci }));

    const t = results.totals;
    console.log(`\n${t.cases} cases in ${(results.durationMs / 1000).toFixed(0)} s: ${t.fail} fail, ${t.warn} warn${t.info ? `, ${t.info} info` : ''}, ${t.error} harness errors` +
        (baseline ? `, ${t.changed} changed vs ${results.baseline}` : '') + (results.interrupted ? ' (interrupted)' : ''));
    console.log(`results: ${path.join(runDir, 'results.json')}\nreport:  ${path.join(runDir, 'report.html')}`);
    if (t.error) return 3;
    return args['fail-exit'] && t.fail ? 1 : 0;
}

/* ==================== Merge ==================== */

// A screenshot name as buildCases makes it: one path segment, no traversal.
// Merge inputs can come from a downloaded GitHub artifact, so every name read
// from a results.json is checked before it becomes a path.
const CASE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.png$/;

/** Older runs (before the info severity) reported a tappable that only
 *  scrolls through the camera keep-out as a warn: read it as info now. */
function upgradeIssue(i) {
    if (i.sev === 'warn' && i.check === 'cams' && /scrolls through it/.test(String(i.msg))) return Object.assign({}, i, { sev: 'info' });
    return i;
}

/** Combine shard runs into runDir (copying their screenshots), or with one
 *  source and no --out, rebuild that run's report in place. No browser. */
function merge(args, cfg, outRoot) {
    const srcs = list(args.merge).map(d => path.resolve(d));
    const runDir = path.resolve(args.out || (srcs.length === 1 ? srcs[0] : ''));
    if (!args.out && srcs.length !== 1) throw new Error('--merge of several runs needs --out DIR');
    fs.mkdirSync(runDir, { recursive: true });
    const runs = srcs.map(d => {
        const f = path.join(d, 'results.json');
        if (!fs.existsSync(f)) throw new Error(`${d} has no results.json`);
        return { dir: d, res: JSON.parse(fs.readFileSync(f, 'utf8')) };
    });
    const out = [], sizes = [], seenSize = new Set(), seenFile = new Set();
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const arr = (v, what, dir) => { if (v === undefined) return []; if (!Array.isArray(v)) throw new Error(`${dir}: ${what} is not a list`); return v; };
    for (const { dir, res } of runs) {
        // Shapes and numbers are forced here, so report.js (which escapes every
        // string) never meets a non-number where it prints one raw.
        for (const s of arr(res.sizes, 'sizes', dir)) {
            const name = String(s && s.name);
            if (!seenSize.has(name)) { seenSize.add(name); sizes.push({ name, w: num(s.w), h: num(s.h) }); }
        }
        res.durationMs = num(res.durationMs);
        res.args = arr(res.args, 'args', dir).map(String);
        for (const c of arr(res.cases, 'cases', dir)) {
            if (!c || typeof c !== 'object') throw new Error(`${dir}: a case is not an object`);
            c.ms = num(c.ms); c.seats = num(c.seats);
            if (c.idx !== undefined) c.idx = num(c.idx);
            c.issues = arr(c.issues, 'issues', dir).filter(i => i && typeof i === 'object').map(upgradeIssue);
            if (!CASE_FILE_RE.test(String(c.file))) throw new Error(`${dir}: bad screenshot name ${JSON.stringify(String(c.file).slice(0, 80))}`);
            if (seenFile.has(c.file)) continue;   // the same case in two shards: keep the first
            seenFile.add(c.file);
            delete c.diff;                        // recomputed against this run's baseline
            const src = path.join(dir, c.file), dst = path.join(runDir, c.file);
            if (src !== dst && fs.existsSync(src)) fs.copyFileSync(src, dst);
            out.push(c);
        }
    }
    out.sort((a, b) => (a.idx ?? 1e9) - (b.idx ?? 1e9));
    fs.rmSync(path.join(runDir, 'diff'), { recursive: true, force: true });
    const baseline = resolveBaseline(args.baseline, outRoot, runDir);
    const first = runs[0].res;
    const starts = runs.map(r => Date.parse(r.res.startedAt)).filter(Number.isFinite);
    const meta = {
        startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : first.startedAt,
        // Wall time of the slowest shard (shards run side by side)
        durationMs: Math.max(0, ...runs.map(r => r.res.durationMs || 0)),
        interrupted: runs.some(r => r.res.interrupted),
        args: (first.args || []).filter((a, i, all) => !/^--(shard|out|ci)(=|$)/.test(a) && !/^--(shard|out)$/.test(all[i - 1] || '')),
        sizes,
        shards: runs.length > 1 ? runs.map(r => ({ run: r.res.runId, cases: (r.res.cases || []).length, durationMs: r.res.durationMs }))
            : first.shards || null,
        ci: first.ci || false
    };
    console.log(`ui-check merge: ${runs.length} run(s), ${out.length} cases -> ${runDir}`);
    return finalize(out, meta, runDir, baseline, cfg, args);
}

/* ==================== Prune ==================== */

const STAMP_RE = /^\d{8}-\d{6}(-gh)?$/;
const NAMED_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/**
 * Delete old run directories under outRoot (screenshots/ui-check/), which
 * otherwise grow by a few to 40 MB a run. Keeps:
 *   - the newest keepLocal timestamped local runs and keepGh -gh runs
 *     (the `--baseline latest` candidates);
 *   - any run a gh job not yet fetched names as its baseline, and `protect`
 *     (this run, its baseline dirs);
 *   - anything touched in the last minGuardMin minutes (a run in progress,
 *     maybe another session's).
 * Named runs (--out scratch, agents') go after scratchHours. A timestamped
 * dir with no results.json (a crashed run) goes after minGuardMin. A
 * gh-jobs/<id> dir goes once its job is fetched and its report is gone.
 * Only direct children of outRoot with a plain name are ever touched.
 */
function prune(outRoot, cfg, { protect = [], dryRun = false } = {}) {
    const pc = Object.assign({ keepLocal: 6, keepGh: 4, scratchHours: 24, minGuardMin: 30 }, cfg.prune || {});
    if (!fs.existsSync(outRoot)) return { removed: [], freed: 0 };
    const now = Date.now();
    const keep = new Set(protect.map(p => path.resolve(p)));
    const jobsDir = path.join(outRoot, 'gh-jobs');
    const jobs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter(j => /^\d{8}-\d{6}-ui-\d{1,5}c$/.test(j)) : [];
    const jobState = j => { try { return fs.readFileSync(path.join(jobsDir, j, 'state'), 'utf8').trim(); } catch (e) { return 'unknown'; } };
    for (const j of jobs) {
        if (/^(success|failure)$/.test(jobState(j))) continue;
        try {
            const b = JSON.parse(fs.readFileSync(path.join(jobsDir, j, 'meta.json'), 'utf8')).baseline;
            if (b && b !== 'latest') keep.add(path.resolve(APP.repo, b));
        } catch (e) { /* no meta */ }
    }
    const entries = fs.readdirSync(outRoot, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.isSymbolicLink() && e.name !== 'gh-jobs' && NAMED_RE.test(e.name))
        .map(e => {
            const dir = path.join(outRoot, e.name);
            return { name: e.name, dir, mtime: fs.statSync(dir).mtimeMs, done: fs.existsSync(path.join(dir, 'results.json')) };
        });
    const doomed = [];
    const fresh = e => now - e.mtime < pc.minGuardMin * 60000;
    for (const gh of [false, true]) {
        const runs = entries.filter(e => STAMP_RE.test(e.name) && e.done && /-gh$/.test(e.name) === gh)
            .sort((a, b) => (a.name < b.name ? 1 : -1));
        runs.slice(gh ? pc.keepGh : pc.keepLocal).forEach(e => doomed.push(e));
    }
    for (const e of entries) {
        if (STAMP_RE.test(e.name) && !e.done) doomed.push(e);                                  // crashed run
        else if (!STAMP_RE.test(e.name) && now - e.mtime > pc.scratchHours * 3600000) doomed.push(e);   // scratch
    }
    const removed = [];
    let freed = 0;
    const size = d => { let n = 0; for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name); n += f.isDirectory() ? size(p) : f.isFile() ? fs.statSync(p).size : 0; } return n; };
    for (const e of doomed) {
        if (keep.has(e.dir) || fresh(e) || removed.includes(e.name)) continue;
        if (path.dirname(e.dir) !== path.resolve(outRoot)) continue;
        freed += size(e.dir);
        if (!dryRun) fs.rmSync(e.dir, { recursive: true, force: true });
        removed.push(e.name);
    }
    // Job state of fetched jobs whose report is gone
    for (const j of jobs) {
        if (!/^(success|failure)$/.test(jobState(j))) continue;
        if (fs.existsSync(path.join(outRoot, j.replace(/-ui-.*$/, '') + '-gh'))) continue;
        if (!dryRun) fs.rmSync(path.join(jobsDir, j), { recursive: true, force: true });
        removed.push('gh-jobs/' + j);
    }
    return { removed, freed };
}

function printPrune(r, dryRun) {
    if (!r.removed.length) return;
    console.log(`prune: ${dryRun ? 'would remove' : 'removed'} ${r.removed.length} old run(s), ${(r.freed / 1048576).toFixed(1)} MB: ${r.removed.join(', ')}`);
}

/* ==================== Main ==================== */

function parseShard(v) {
    if (v === undefined) return null;
    const m = /^(\d{1,3})\/(\d{1,3})$/.exec(String(v));
    if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error('--shard must look like 2/8 (1 <= I <= N)');
    return { i: +m[1], n: +m[2] };
}

async function main() {
    const argv = process.argv.slice(2);
    const pre = preArgs(argv);
    loadApp(pre.app, pre.config);
    const optNames = Object.keys(APP.options);
    for (const k of optNames) if (!/^[a-z][a-z0-9-]*$/.test(k) || BASE_BOOL.includes(k) || BASE_VALUE.includes(k)) throw new Error(`adapter option "${k}": bad or reserved name`);
    const args = parseArgs(argv, [...BASE_BOOL, ...optNames], [...BASE_VALUE, ...Object.keys(APP.axes)]);
    if (args.h || args.help) { console.log(help()); return 0; }
    CI = !!args.ci;
    const cfg = APP.cfg;

    if (args.list) {
        console.log(`App: ${APP.adapter.name || path.basename(APP.repo)} (${APP.dir})\n\nStates:`);
        for (const s of APP.states) console.log(`  ${s.id.padEnd(24)} ${String(s.group).padEnd(8)} ${s.title}${s.seats ? ` [${s.seats} seats]` : ''}`);
        console.log('\nSize presets:');
        for (const [k, v] of Object.entries(cfg.sizes)) console.log(`  ${k.padEnd(13)} ${String(v.w + 'x' + v.h).padEnd(8)} ${typeOf(v).padEnd(9)}${v.note || ''}`);
        const axes = Object.keys(APP.axes);
        if (axes.length) {
            console.log('\nAxes:');
            for (const k of axes) console.log(`  --${k.padEnd(11)} ${(axisValues(k) || ['(any)']).join(', ')}  (default ${APP.axes[k].default})`);
        }
        if (Object.keys(cfg.content || {}).length) {
            console.log('\nContent profiles (--content):');
            for (const [k, v] of Object.entries(cfg.content)) console.log(`  ${k.padEnd(13)} ${v.note || (v.names || []).join(', ')}`);
        }
        console.log(`\nDefault matrix: ${JSON.stringify(cfg.matrix || {})}`);
        return 0;
    }

    const outRoot = path.resolve(APP.repo, cfg.outRoot || 'screenshots/ui-check');
    if (args.prune) {
        const r = prune(outRoot, cfg, { dryRun: !!args['dry-run'] });
        printPrune(r, !!args['dry-run']);
        if (!r.removed.length) console.log('prune: nothing to remove');
        return 0;
    }
    if (args.merge) return merge(args, cfg, outRoot);

    const shard = parseShard(args.shard);
    const all = buildCases(cfg, args);
    const sizes = all.sizes;
    const cases = shard ? all.cases.filter(c => c.idx % shard.n === shard.i - 1) : all.cases;
    if (args.plan) {
        console.log(`cases=${all.cases.length}` + (shard ? ` shard=${shard.i}/${shard.n} shardCases=${cases.length}` : ''));
        return 0;
    }
    // The app's own guard (Spare Change: only the test instance, never the real app)
    if (APP.adapter.checkUrl) APP.adapter.checkUrl(cfg.url, { ci: CI });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const runDir = path.resolve(args.out || path.join(outRoot, stamp));
    fs.mkdirSync(runDir, { recursive: true });
    const baseline = resolveBaseline(args.baseline, outRoot, runDir);

    if (!(await serverUp(cfg.url))) {
        if (CI) { console.error(`App ${cfg.url} is down (the workflow's start step runs first)`); return 2; }
        const pid = projectId(cfg);
        if (!pid) { console.error(`App ${cfg.url} is down. ${cfg.startHint || 'Start it first.'}`); return 2; }
        if (!args['restart-server']) {
            console.error(`App ${cfg.url} is down. Restart it through Mission Control (or pass --restart-server):\n` +
                `  curl -s -H "@${PHONE().MC_HEADER_FILE}" -X POST http://localhost:8000/api/projects/${pid}/restart`);
            return 2;
        }
        console.error('App down: restarting via Mission Control: ' + restartServer(cfg));
        await new Promise(r => setTimeout(r, 3000));
        if (!(await serverUp(cfg.url))) { console.error('still down'); return 2; }
    }

    console.log(`ui-check: ${cases.length} cases${shard ? ` (shard ${shard.i}/${shard.n} of ${all.cases.length})` : ''} -> ${runDir}`);
    const hyg = APP.adapter.beforeRun ? await APP.adapter.beforeRun({ repo: APP.repo, cfg, ci: CI }) : null;
    const sess = new Session(cfg);
    const t0 = Date.now();
    const out = [];
    let interrupted = false;
    const onSig = () => { interrupted = true; };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    const opts = Object.fromEntries(optNames.map(k => [k, !!args[k]]));
    try {
        await sess.open();
        for (let i = 0; i < cases.length && !interrupted; i++) {
            const c = cases[i];
            if (!sess.alive()) {   // the idle watchdog or a crash took the browser: start over
                await sess.close().catch(() => {});
                await sess.open();
            }
            let r = await runCase(sess, c, cfg, runDir, opts);
            if (r.issues.some(x => x.sev === 'error') && !sess.alive()) {
                await sess.close().catch(() => {});
                await sess.open();
                r = await runCase(sess, c, cfg, runDir, opts);
            }
            const f = r.issues.filter(x => x.sev === 'fail').length, w = r.issues.filter(x => x.sev === 'warn').length;
            const n = r.issues.filter(x => x.sev === 'info').length;
            const e = r.issues.filter(x => x.sev === 'error');
            console.log(`[${String(i + 1).padStart(3)}/${cases.length}] ${c.file.padEnd(62)} ${String(r.ms).padStart(5)}ms  F${f} W${w}${n ? ' i' + n : ''}${e.length ? '  ERROR ' + e[0].msg : ''}`);
            out.push(r);
        }
    } finally {
        await sess.close().catch(() => {});
        if (APP.adapter.afterRun) {
            try { await APP.adapter.afterRun(hyg, out, { repo: APP.repo, cfg, ci: CI }); }
            catch (e) { console.error('hygiene (afterRun) failed: ' + e.message); }
        }
        process.off('SIGINT', onSig);
        process.off('SIGTERM', onSig);
    }

    const code = finalize(out, {
        app: APP.adapter.name || null,
        startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, interrupted,
        args: process.argv.slice(2), sizes,
        shards: shard ? { i: shard.i, n: shard.n, of: all.cases.length } : null, ci: CI
    }, runDir, baseline, cfg, args);
    // Old runs go at the end of every local run (never on a runner)
    if (!CI && !args['no-prune']) {
        try { printPrune(prune(outRoot, cfg, { protect: [runDir, ...(baseline ? baseline.dirs : [])] })); }
        catch (e) { console.error('prune failed: ' + e.message); }
    }
    return code;
}

main().then(code => process.exit(code || 0), err => {
    if (err && err.usage) { console.error('ui-check: ' + err.message); process.exit(2); }
    console.error(err && err.stack || err); process.exit(4);
});
