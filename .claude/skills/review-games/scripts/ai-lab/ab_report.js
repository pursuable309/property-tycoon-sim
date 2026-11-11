#!/usr/bin/env node
'use strict';
const path = require('path');
// Output/scratch dir: $AI_LAB_OUT, else ./runs next to this script.
const OUT = process.env.AI_LAB_OUT || path.join(__dirname, 'runs');
require('fs').mkdirSync(OUT, { recursive: true });

// Merge + report the overnight cells. Per arm and shape: mean deltas vs the
// reference arm on win% / capWin% / dev% / mono-per-survivor / avgSteps, the
// d5-d4 and d4-d3 ladder margins with per-cell win counts, trade economics,
// and the lever's firing counts (a wash with zero firings is a no-op, not a
// verdict).
//
// Env:
//   AB_ARMS   arms to report (default: every arm found in the cells dir)
//   AB_BASE   reference arm the deltas are taken against (default `base`).
//             E.g. AB_BASE=oldboth reads a default-on fix's effect with the
//             natural sign (fix minus old code).
//   AB_SEEDS / AB_RULES  restrict to these (default: whatever cells exist, so
//             a submit with custom seeds/rulesets is never silently dropped)
const fs = require('fs');

const CELLS = process.env.AI_LAB_CELLS || path.join(OUT, 'cells');
const REF = process.env.AB_BASE || 'base';
const list = v => v.split(/[\s,]+/).filter(Boolean);
// Cell files are `${seed}_${rules}_${arm}_${shape}.json`; discover the grid.
const found = { seeds: new Set(), rules: new Set(), arms: new Set() };
if (fs.existsSync(CELLS)) fs.readdirSync(CELLS).forEach(f => {
    const m = /^(-?\d+)_([^_]+)_(.+)_([^_]+)\.json$/.exec(f);
    if (m) { found.seeds.add(+m[1]); found.rules.add(m[2]); found.arms.add(m[3]); }
});
const SEEDS = process.env.AB_SEEDS ? list(process.env.AB_SEEDS).map(Number) : [...found.seeds].sort((a, b) => a - b);
const RULE_ORDER = ['standard', 'delayed', 'bd'];
const RULES = process.env.AB_RULES ? list(process.env.AB_RULES)
    : [...found.rules].sort((a, b) => (RULE_ORDER.indexOf(a) + 99 * (RULE_ORDER.indexOf(a) < 0)) - (RULE_ORDER.indexOf(b) + 99 * (RULE_ORDER.indexOf(b) < 0)));
const ARMS = process.env.AB_ARMS ? list(process.env.AB_ARMS) : [...found.arms].sort();

const win = a => (a && a.games) ? 100 * a.wins / a.games : null;
const cap = a => (a && a.games) ? 100 * a.capWins / a.games : null;
const dev = a => (a && a.games) ? 100 * a.developed / a.games : null;
const mps = a => (a && a.survived) ? a.monopolies / a.survived : null;
const scg = a => (a && a.games) ? a.setCompleting / a.games : null;   // set-completing trades/game (fluidity)
const sgn = x => (x >= 0 ? '+' : '') + x.toFixed(1);
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
// Mean with a ±2 standard-error band across cells, and how many cells went
// each way — the instrument's noise floor is ~±1.5-2pp of win at 4-5p.
const band = xs => {
    if (!xs.length) return '—';
    const m = mean(xs);
    const se = xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) / xs.length) : 0;
    const up = xs.filter(x => x > 0).length, dn = xs.filter(x => x < 0).length;
    return `${sgn(m)} ±${(2 * se).toFixed(1)} (${up}↑/${dn}↓ of ${xs.length})`;
};

function load(seed, rules, arm, shape) {
    const f = `${CELLS}/${seed}_${rules}_${arm}_${shape}.json`;
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

// Per-game trade rates from a cell's ladder totals (cells from before
// 2026-09-30 have no L.trades and are skipped for these lines).
const tradeRates = L => {
    const t = L.trades, g = L.totalGames;
    if (!t || !g) return null;
    return {
        trades: t.total / g, cashPerTrade: t.total ? t.cashMoved / t.total : 0,
        swaps: t.swaps / g, cashBuys: t.cashBuys / g, reversals: t.reversals / g,
        pingpong: 100 * t.pingpongGames / g, pairHand: 100 * t.pairAdvanceHandovers / g,
        entries: 100 * t.shutoutEntries / g,
        entrantDev: t.shutoutEntries ? 100 * t.entrantDeveloped / t.shutoutEntries : null,
        entrantWin: t.shutoutEntries ? 100 * t.entrantWins / t.shutoutEntries : null,
    };
};
// Pool the trade-flow instrument (per responder difficulty) across cells.
const poolFlow = cells => {
    const out = {};
    cells.forEach(c => Object.entries(c.flow || {}).forEach(([d, f]) => {
        const o = out[d] = out[d] || {};
        Object.entries(f).forEach(([k, v]) => { o[k] = (o[k] || 0) + v; });
    }));
    return out;
};
const flowLine = f => {
    const resp = (f.acc || 0) + (f.ctr || 0) + (f.rej || 0);
    const acc = resp ? `${(100 * (f.acc || 0) / resp).toFixed(0)}%` : '—';
    const pc = f.prop ? `$${((f.propCash || 0) / f.prop).toFixed(0)}` : '—';
    const ac = f.acc ? `$${((f.accCash || 0) / f.acc).toFixed(0)}` : '—';
    return `acc ${acc} cash/prop ${pc} cash/acc ${ac} (n=${f.prop || 0})`;
};
// Counter rounds (cells from 2026-09-30 E45 on; older cells lack the fields):
// answers to OPENING offers vs to COUNTER-offers, deals per opening (as opened
// / after counters), and set-handover veto fires.
const pctOf = (n, d) => d ? `${(100 * n / d).toFixed(0)}%` : '—';
const roundLine = f => {
    const n0 = (f.acc0 || 0) + (f.ctr0 || 0) + (f.rej0 || 0);
    if (!n0) return null;
    const nC = (f.accC || 0) + (f.ctrC || 0) + (f.rejC || 0);
    return `open acc/ctr/rej ${pctOf(f.acc0 || 0, n0)}/${pctOf(f.ctr0 || 0, n0)}/${pctOf(f.rej0 || 0, n0)} (n=${n0})` +
        `  on-counter ${pctOf(f.accC || 0, nC)}/${pctOf(f.ctrC || 0, nC)}/${pctOf(f.rejC || 0, nC)} (n=${nC})` +
        `  deals/opening ${pctOf((f.deal0 || 0) + (f.dealC || 0), n0)} (via ctr ${pctOf(f.dealC || 0, n0)})` +
        (f.veto ? `  veto ${f.veto}` : '');
};

function report(shape, top) {
    const cells = [];
    SEEDS.forEach(s => RULES.forEach(r => {
        const b = load(s, r, REF, shape); if (!b) return;
        cells.push({ seed: s, rules: r, base: b });
    }));
    if (!cells.length) { console.log(`\n${shape}: no ${REF} cells yet`); return; }
    console.log(`\n${'='.repeat(78)}\n ${shape.toUpperCase()}  (${cells.length}/${SEEDS.length * RULES.length} ${REF} cells)\n${'='.repeat(78)}`);
    ARMS.filter(a => a !== REF).forEach(arm => {
        const rows = cells.map(c => ({ c, a: load(c.seed, c.rules, arm, shape) })).filter(x => x.a);
        if (!rows.length) return;
        const acc = { win: [], cap: [], dev: [], mps: [], steps: [], scg: [], gap: [], gapB: [], mid: [], midB: [] };
        const fires = {}, brokerFires = {}, entryFires = {}, cedeFires = {};
        const e51Fires = {};
        rows.forEach(({ c, a }) => {
            const B = c.base.L.agg, A = a.L.agg;
            acc.win.push(win(A[top]) - win(B[top]));
            acc.cap.push(cap(A[top]) - cap(B[top]));
            acc.dev.push(dev(A[top]) - dev(B[top]));
            if (mps(A[top]) !== null && mps(B[top]) !== null) acc.mps.push(mps(A[top]) - mps(B[top]));
            acc.steps.push(100 * (a.L.avgSteps - c.base.L.avgSteps) / c.base.L.avgSteps);
            // trade fluidity: set-completing trades/game summed across the ladder (all difficulties)
            const scAll = g => Object.keys(g).reduce((s, d) => s + (scg(g[d]) || 0), 0);
            acc.scg.push(scAll(A) - scAll(B));
            if (A[4] && B[4]) { acc.gap.push(win(A[5]) - win(A[4])); acc.gapB.push(win(B[5]) - win(B[4])); }
            if (A[3] && B[3]) { acc.mid.push(win(A[4]) - win(A[3])); acc.midB.push(win(B[4]) - win(B[3])); }
            Object.entries(a.fires || {}).forEach(([d, n]) => { fires[d] = (fires[d] || 0) + n; });
            Object.entries(a.brokerFires || {}).forEach(([d, n]) => { brokerFires[d] = (brokerFires[d] || 0) + n; });
            Object.entries(a.entryFires || {}).forEach(([d, n]) => { entryFires[d] = (entryFires[d] || 0) + n; });
            Object.entries(a.cedeFires || {}).forEach(([d, m]) => { const t = cedeFires[d] = cedeFires[d] || {}; Object.entries(m).forEach(([f, n]) => { t[f] = (t[f] || 0) + n; }); });
            Object.entries(a.e51Fires || {}).forEach(([k, m]) => Object.entries(m).forEach(([d, n]) => {
                const t = e51Fires[k] = e51Fires[k] || {}; t[d] = (t[d] || 0) + n; }));
        });
        // broker involvement vs. win, summed across cells (arm and its baseline)
        const bk = { games: 0, winsAny: 0, winsActor: 0, winsRecipient: 0, winsSeller: 0 };
        const bkB = { games: 0, winsAny: 0, winsActor: 0, winsRecipient: 0, winsSeller: 0 };
        rows.forEach(({ c, a }) => {
            const x = a.L.broker, y = c.base.L.broker;
            if (x) Object.keys(bk).forEach(k => bk[k] += x[k] || 0);
            if (y) Object.keys(bkB).forEach(k => bkB[k] += y[k] || 0);
        });
        const pct = (w, g) => g ? (100 * w / g).toFixed(0) + '%' : '—';
        const viol = rows.reduce((s, { a }) => s + a.L.violations, 0);
        const gapUp = acc.gap.filter((g, i) => g > acc.gapB[i]).length;
        console.log(`\n  arm ${arm} vs ${REF}  (${rows.length} cells, ${viol} violations)   latent detections ${JSON.stringify(fires)}   broker fires ${JSON.stringify(brokerFires)}   entry fires ${JSON.stringify(entryFires)}${Object.keys(e51Fires).length ? `   E51 fires ${JSON.stringify(e51Fires)}` : ''}${Object.keys(cedeFires).length ? `   cede ${JSON.stringify(cedeFires)}` : ''}`);
        console.log(`    d${top} win ${band(acc.win)}   capWin ${band(acc.cap)}`);
        console.log(`    d${top}: win ${sgn(mean(acc.win))}  capWin ${sgn(mean(acc.cap))}  ` +
            `dev% ${sgn(mean(acc.dev))}  mono/srv ${sgn(mean(acc.mps))}  setComplete/game ${sgn(mean(acc.scg))}  avgSteps ${sgn(mean(acc.steps))}%`);
        if (acc.gap.length) {
            console.log(`    d5-d4 gap ${sgn(mean(acc.gapB))} -> ${sgn(mean(acc.gap))}   ` +
                `(gap wider in ${gapUp}/${acc.gap.length} cells)`);
        }
        if (acc.mid.length) console.log(`    d4-d3 margin ${sgn(mean(acc.midB))} -> ${sgn(mean(acc.mid))}`);
        // Every seat's win delta (ladder keys, pooled over cells): for gates by min difficulty
        const seatKeys = [...new Set(rows.flatMap(({ c, a }) => Object.keys(a.L.agg).filter(k => c.base.L.agg[k])))];
        console.log(`    win delta by seat: ` + seatKeys.map(k => `${/^\d+$/.test(k) ? 'd' + k : k} ${sgn(mean(rows.filter(({ c, a }) => a.L.agg[k] && c.base.L.agg[k]).map(({ c, a }) => win(a.L.agg[k]) - win(c.base.L.agg[k]))))}`).join('  '));
        console.log(`    broker-involved win%: ${REF} ${bkB.games}g any ${pct(bkB.winsAny, bkB.games)} ` +
            `(A ${pct(bkB.winsActor, bkB.games)} / B ${pct(bkB.winsRecipient, bkB.games)} / C ${pct(bkB.winsSeller, bkB.games)})` +
            `  ->  arm ${bk.games}g any ${pct(bk.winsAny, bk.games)} ` +
            `(A ${pct(bk.winsActor, bk.games)} / B ${pct(bk.winsRecipient, bk.games)} / C ${pct(bk.winsSeller, bk.games)})`);
        // Trade economics (ref -> arm, pooled means across cells). Watch
        // reversals/ping-pong whenever a change makes deals cheaper (E07).
        const tr = rows.map(({ c, a }) => ({ b: tradeRates(c.base.L), a: tradeRates(a.L) })).filter(x => x.a && x.b);
        if (tr.length) {
            const f = (k, d = 2) => {
                const bs = tr.map(x => x.b[k]).filter(v => v !== null), as = tr.map(x => x.a[k]).filter(v => v !== null);
                return bs.length && as.length ? `${mean(bs).toFixed(d)} -> ${mean(as).toFixed(d)}` : '—';
            };
            console.log(`    trades/game ${f('trades')}  cash/trade $${f('cashPerTrade', 0)}  swaps/game ${f('swaps')}  cashBuys/game ${f('cashBuys')}`);
            console.log(`    reversals/game ${f('reversals')}  ping-pong games ${f('pingpong', 1)}%  pair-advance handovers/100g ${f('pairHand', 1)}`);
            console.log(`    shut-out entries/100g ${f('entries', 1)}  entrant developed ${f('entrantDev', 0)}%  entrant won ${f('entrantWin', 0)}%`);
        }
        // Trade flow by RESPONDER difficulty (CPU proposals received).
        const fB = poolFlow(rows.map(x => x.c.base)), fA = poolFlow(rows.map(x => x.a));
        const ds = [...new Set([...Object.keys(fB), ...Object.keys(fA)])].sort();
        ds.forEach(d => {
            console.log(`    flow to ${d}: ${REF} ${flowLine(fB[d] || {})}  ->  arm ${flowLine(fA[d] || {})}`);
            const rB = roundLine(fB[d] || {}), rA = roundLine(fA[d] || {});
            if (rB || rA) console.log(`      rounds ${d}: ${REF} ${rB || '—'}\n                  arm  ${rA || '—'}`);
        });
        // Per archetype (all difficulties pooled): win% delta vs ref, where both
        // cells carry aggArch (cells from before 2026-09-30 don't).
        const ARCH = ['builder', 'cautious', 'trader', 'aggressive', 'hoarder'];
        const archLine = ARCH.map(k => {
            const dsA = rows.filter(({ c, a }) => a.L.aggArch && c.base.L.aggArch && a.L.aggArch[k] && c.base.L.aggArch[k])
                .map(({ c, a }) => win(a.L.aggArch[k]) - win(c.base.L.aggArch[k]));
            return dsA.length ? `${k} ${sgn(mean(dsA))}` : null;
        }).filter(Boolean);
        if (archLine.length) console.log(`    archetype win delta: ${archLine.join('  ')}`);
        const per = acc.win.map((w, i) => `${rows[i].c.seed}/${rows[i].c.rules} ${sgn(w)}`).join('  ');
        console.log(`    per-cell d${top} win delta: ${per}`);
    });
}

// E54: the T-clone seat's absolute levels per arm (pooled over cells), next to
// the human's real rates from fit_human.js. Validation, not a delta.
function cloneReport(shape) {
    const per = {};
    SEEDS.forEach(sd => RULES.forEach(r => ARMS.forEach(arm => {
        const c = load(sd, r, arm, shape); if (!c || !c.L.agg.T) return;
        const t = per[arm] = per[arm] || { games: 0, wins: 0, capWins: 0, developed: 0, cells: 0, k: {} };
        ['games', 'wins', 'capWins', 'developed'].forEach(k => { t[k] += c.L.agg.T[k]; });
        t.cells++;
        Object.entries(c.clone || {}).forEach(([k, v]) => { t.k[k] = (t.k[k] || 0) + v; });
    })));
    if (!Object.keys(per).length) return;
    const pc = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
    console.log(`\n  T-clone seat (${shape}; human T, E54 — buys 85% of affordable landings, contests 76% of auctions it can afford, builds on 19% of build-possible turns,` +
        ` 4.7 proposals per 100 turns; accepts 17% / counters 21% of offers to it; CPUs accept 13% / counter 15% of its openings)`);
    Object.entries(per).forEach(([arm, t]) => {
        const k = t.k;
        console.log(`    ${arm.padEnd(8)} ${t.cells} cells  win ${pc(t.wins, t.games)}  capWin ${pc(t.capWins, t.games)}  dev ${pc(t.developed, t.games)}` +
            `  | buys ${pc(k.bought, k.buyAfford)}  contests ${pc(k.engaged, k.auctions)}  builds ${pc(k.builtTurns, k.buildable)}  proposes ${pc(k.proposals, k.turns)}` +
            (k.offersIn != null ? `  | offers in ${k.offersIn}: acc ${pc(k.acceptedIn, k.offersIn)} ctr ${pc(k.counteredIn, k.offersIn)}` +
                `  out ${k.offersOut}: acc ${pc(k.acceptedOut, k.offersOut)} ctr ${pc(k.counteredOut, k.offersOut)}` : ''));
        const shp = ['swap', 'multi', 'buyComplete', 'buy', 'tradeComplete', 'trade', 'sell'];
        const nShp = shp.reduce((s, x) => s + (k['shp_' + x] || 0), 0);
        if (nShp) console.log(`             openings (${nShp}): ${shp.map(x => `${x} ${pc(k['shp_' + x] || 0, nShp)}`).join('  ')}` +
            (k.shp_ask ? `  | zone-less asks ${pc(k.shp_ask, nShp)}` : ''));
        if (k.opp_none != null || k.opp_multiAvail != null) console.log(`             opportunity: ` + ['multiAvail', 'swapOnly', 'none'].map(c =>
            `${c} ${k['opp_' + c] || 0} turns -> mutual ${pc(k[`opp_${c}_mutual`] || 0, k['opp_' + c])} multi ${pc(k[`opp_${c}_multi`] || 0, k['opp_' + c])}`).join('  |  '));
    });
    console.log('    T recorded openings (fit_human 2026-10-19, n 166): swap 9.8%  multi 16.8%  buyComplete 4.2%  buy 5.4%  tradeComplete 32.5%  trade 17.4%  sell 13.9%');
    // Clone win vs base on the same cells: the human-rule gate (lower = the CPUs beat the
    // human-like seat more). SE is the binomial SE of the pooled difference.
    ARMS.filter(a => a !== REF).forEach(arm => {
        let up = 0, down = 0, n = 0, wa = 0, ga = 0, wb = 0, gb = 0;
        const vers = new Set();
        SEEDS.forEach(sd => RULES.forEach(r => {
            const a = load(sd, r, arm, shape), b = load(sd, r, REF, shape);
            if (!a || !b || !a.L.agg.T || !b.L.agg.T) return;
            const A = a.L.agg.T, B = b.L.agg.T;
            const d = A.wins / A.games - B.wins / B.games;
            n++; if (d > 0) up++; else if (d < 0) down++;
            wa += A.wins; ga += A.games; wb += B.wins; gb += B.games;
            if (a.cloneVersion) vers.add(a.cloneVersion);
        }));
        if (!n) return;
        const pa = wa / ga, pb = wb / gb, se = Math.sqrt(pa * (1 - pa) / ga + pb * (1 - pb) / gb);
        console.log(`    clone win ${arm} vs ${REF}: ${(100 * (pa - pb)) >= 0 ? '+' : ''}${(100 * (pa - pb)).toFixed(1)} ±${(100 * se).toFixed(1)} SE` +
            `  (${up}↑/${down}↓ of ${n} cells)${vers.size ? '  clone ' + [...vers].join(',') : ''}`);
    });
}

console.log(`A/B report  —  arms: ${ARMS.join(', ')}  (deltas vs ${REF})  seeds: ${SEEDS.join(' ')}  rulesets: ${RULES.join(' ')}`);
report('5p', 5);
report('4p', 5);
report('h2h', 5);
report('6p', 5);
report('8p', 5);
report('t4p', 5);
cloneReport('t4p');
const done = fs.existsSync(CELLS) ? fs.readdirSync(CELLS).filter(f => f.endsWith('.json')).length : 0;
console.log(`\ncells complete: ${done}\n`);
