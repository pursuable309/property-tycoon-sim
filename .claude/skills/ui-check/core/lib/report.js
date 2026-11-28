/**
 * Self-contained HTML contact sheet: rows = state (+ variant), columns =
 * sizes, each cell a screenshot with its check badges. Inline CSS/JS only;
 * images are sibling files (relative src) or, with embed, data URIs.
 */
const fs = require('fs');
const path = require('path');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function build(results, runDir, { embed = false } = {}) {
    const sizes = results.sizes;   // [{ name, w, h }]
    const rows = new Map();        // key state|variant -> { state, variant, title, group, cells: {size: case} }
    for (const c of results.cases) {
        const key = `${c.state}|${c.variant}`;
        if (!rows.has(key)) rows.set(key, { state: c.state, variant: c.variant, title: c.title, group: c.group, cells: {} });
        rows.get(key).cells[c.size] = c;
    }
    const img = file => {
        if (!file) return '';
        if (!embed) return esc(file);
        const p = path.join(runDir, file);
        return fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : '';
    };
    const t = results.totals;
    const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    const summary = (k, n) => [k || !n ? plural(k, 'issue') : '', n ? plural(n, 'note') : ''].filter(Boolean).join(', ');
    const cell = c => {
        if (!c) return '<td class="empty"></td>';
        const f = c.issues.filter(i => i.sev === 'fail').length;
        const w = c.issues.filter(i => i.sev === 'warn').length;
        const e = c.issues.filter(i => i.sev === 'error').length;
        const n = c.issues.filter(i => i.sev === 'info').length;   // notes: not issues
        const badges = [
            e ? `<span class="b err" title="harness error">ERR ${e}</span>` : '',
            f ? `<span class="b fail">F ${f}</span>` : '',
            w ? `<span class="b warn">W ${w}</span>` : '',
            !e && !f && !w ? '<span class="b ok">ok</span>' : '',
            n ? `<span class="b info" title="notes, not issues">i ${n}</span>` : '',
            c.diff && c.diff.changed ? `<span class="b chg" title="${esc(c.diff.note)}">Δ ${esc((c.diff.ratio * 100).toFixed(1))}%</span>` : '',
            c.diff && c.diff.missing ? '<span class="b chg">new</span>' : ''
        ].join('');
        const list = c.issues.map(i => `<li class="${i.sev}"><b>${esc(i.check)}</b> ${esc(i.msg)}${i.el ? ` <code>${esc(i.el)}</code>` : ''}</li>`).join('');
        // The diff opens in the lightbox like a screenshot: with inlined
        // images its href would be a data: URL, which browsers won't open in a tab
        const diffLink = c.diff && c.diff.diffFile
            ? ` · <a href="${embed ? '#' : esc(c.diff.diffFile)}" class="zoom" data-src="${img(c.diff.diffFile)}">diff</a>` : '';
        return `<td class="${e ? 'has-err' : f ? 'has-fail' : w ? 'has-warn' : 'clean'}${c.diff && c.diff.changed ? ' changed' : ''}">
            <a href="${embed ? '#' : esc(c.file)}" class="zoom"><img loading="lazy" src="${img(c.file)}" alt="${esc(c.file)}"></a>
            <div class="badges">${badges}<span class="ms">${c.ms}ms</span></div>
            ${list || diffLink ? `<details><summary>${summary(c.issues.length - n, n)}</summary><ul>${list}</ul>${diffLink}</details>` : ''}
        </td>`;
    };
    const body = [...rows.values()].map(r => `
        <tr data-group="${esc(r.group)}">
            <th class="rowh"><div class="sid">${esc(r.state)}</div><div class="stitle">${esc(r.title)}</div><div class="var">${esc(r.variant)}</div></th>
            ${sizes.map(s => cell(r.cells[s.name])).join('')}
        </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ui-check ${esc(results.runId)}</title>
<style>
:root { color-scheme: light dark; --fail: #c62828; --warn: #b26a00; --ok: #2e7d32; --chg: #6a1b9a; --info: #1565c0; --line: #8884; }
body { font: 13px/1.4 system-ui, sans-serif; margin: 0; }
header { padding: 10px 14px; position: sticky; top: 0; background: Canvas; border-bottom: 1px solid var(--line); z-index: 2; }
h1 { font-size: 16px; margin: 0 0 4px; }
.sum span { margin-right: 12px; }
.filters label { margin-right: 10px; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--line); vertical-align: top; padding: 4px; }
thead th { position: sticky; top: 78px; background: Canvas; z-index: 1; font-weight: 600; }
.rowh { text-align: left; min-width: 150px; max-width: 180px; position: sticky; left: 0; background: Canvas; }
.sid { font-family: ui-monospace, monospace; font-weight: 600; }
.stitle, .var { color: GrayText; font-size: 12px; }
td img { display: block; max-width: 220px; max-height: 260px; border: 1px solid var(--line); }
td.has-fail img { outline: 2px solid var(--fail); } td.has-err img { outline: 2px dashed var(--fail); }
td.changed img { box-shadow: 0 0 0 4px var(--chg); }
.badges { margin-top: 3px; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.b { font-size: 11px; font-weight: 700; padding: 0 5px; border-radius: 8px; color: #fff; }
.b.fail, .b.err { background: var(--fail); } .b.warn { background: var(--warn); } .b.ok { background: var(--ok); } .b.chg { background: var(--chg); } .b.info { background: var(--info); }
.ms { color: GrayText; font-size: 11px; margin-left: auto; }
details { max-width: 220px; font-size: 11px; } ul { padding-left: 14px; margin: 4px 0; }
li.fail b, li.error b { color: var(--fail); } li.warn b { color: var(--warn); } li.info b { color: var(--info); }
code { font-size: 10px; word-break: break-all; }
body.only-issues tr:not(:has(td.has-fail, td.has-warn, td.has-err, td.changed)) { display: none; }
#lightbox { position: fixed; inset: 0; z-index: 9; background: #000c; overflow: auto; display: flex; padding: 12px; }
#lightbox[hidden] { display: none; }
#lightbox img { margin: auto; max-width: none; }
</style></head><body>
<header>
  <h1>ui-check · ${esc(results.runId)}</h1>
  <div class="sum"><span>${t.cases} cases</span><span style="color:var(--fail)">${t.fail} fail</span><span style="color:var(--warn)">${t.warn} warn</span>${t.info ? `<span style="color:var(--info)">${t.info} info</span>` : ''}<span>${t.error} harness errors</span>${results.baseline ? `<span style="color:var(--chg)">${t.changed} changed vs ${esc(results.baseline)}</span>` : ''}<span>${(results.durationMs / 1000).toFixed(0)} s</span></div>
  <div class="filters"><label><input type="checkbox" id="only"> only rows with issues / changes</label>
  ${[...new Set([...rows.values()].map(r => r.group))].map(g => `<label><input type="checkbox" class="grp" value="${esc(g)}" checked> ${esc(g)}</label>`).join('')}</div>
</header>
<table><thead><tr><th class="rowh">state / variant</th>${sizes.map(s => `<th>${esc(s.name)}<br><small>${s.w}x${s.h}</small></th>`).join('')}</tr></thead>
<tbody>${body}</tbody></table>
<div id="lightbox" hidden><img alt=""></div>
<script>
// Full size in an overlay (inlined images can't open as data: URLs in a tab)
const box = document.getElementById('lightbox');
document.addEventListener('click', e => {
  const a = e.target.closest('a.zoom');
  if (a) { e.preventDefault(); box.firstElementChild.src = a.dataset.src || a.querySelector('img').src; box.hidden = false; return; }
  if (e.target.closest('#lightbox')) box.hidden = true;
});
document.getElementById('only').onchange = e => document.body.classList.toggle('only-issues', e.target.checked);
document.querySelectorAll('.grp').forEach(cb => cb.onchange = () => {
  const on = new Set([...document.querySelectorAll('.grp:checked')].map(x => x.value));
  document.querySelectorAll('tbody tr').forEach(tr => { tr.hidden = !on.has(tr.dataset.group); });
});
</script>
</body></html>`;
}

module.exports = { build };
