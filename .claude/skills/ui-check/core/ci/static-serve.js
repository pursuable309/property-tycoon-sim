#!/usr/bin/env node
/**
 * GitHub Actions stand-in server for a static web app while ui-check sweeps run on a runner
 * (gh_ui.sh / ci/ui.yml, ci.json "start": {"static": {...}}). Never used on the phone: there
 * the app's real server runs under Mission Control.
 *
 * Why not the app's server: it may pull in token files, logging and private modules that
 * don't belong on a mirror. The page only needs, from job.json "start.static":
 *   - the same static allow-list as the app's server: `dirs` (path prefixes) and `fileRe`
 *     (single files), no dot paths, no non-normalized paths, the same response headers, with
 *     the CSP taken from the app's server at submit time (job.json "csp", ci.json "cspFrom"),
 *     so a CSP violation shows up as a console error exactly as it would locally;
 *   - fixed answers for the read APIs the page calls (`api`: { "/api/x": <json> }); job.json
 *     "head" answers /api/version. Every other /api call is 404 and nothing is ever written.
 *
 * Usage: node ci/static-serve.js <repo-root> [job.json]     # listens on 127.0.0.1:<port>
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');
let job = {};
try { job = JSON.parse(fs.readFileSync(process.argv[3] || path.join(ROOT, 'job.json'), 'utf8')); } catch (e) { /* defaults */ }
const S = (job.start && job.start.static) || {};
const PORT = Number(process.env.UI_SERVE_PORT) || (Number.isInteger(S.port) && S.port > 1023 && S.port < 65536 ? S.port : 8005);

const CSP = typeof job.csp === 'string' && /^[\x20-\x7e]{1,2000}$/.test(job.csp) ? job.csp
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
      "frame-ancestors 'none'; form-action 'self'";
const HEAD = typeof job.head === 'string' && /^[0-9a-f]{4,40}$/.test(job.head) ? job.head : null;

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const STATIC_DIRS = (Array.isArray(S.dirs) ? S.dirs : []).filter(d => typeof d === 'string' && /^\/[A-Za-z0-9_-]+\/$/.test(d));
const STATIC_FILE_RE = new RegExp(typeof S.fileRe === 'string' ? S.fileRe : '^/(index\\.html)?$');
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm', '.m4a': 'audio/mp4'
};
const API = Object.assign({ '/api/version': { commit: HEAD } },
    S.api && typeof S.api === 'object' ? Object.fromEntries(Object.entries(S.api).filter(([k]) => /^\/api\/[A-Za-z0-9/_-]+$/.test(k))) : {});

function headers(extra) {
    return Object.assign({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Security-Policy': CSP,
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
    }, extra);
}

function send(res, status, body, type) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, headers({ 'Content-Type': type, 'Content-Length': buf.length }));
    res.end(res.req.method === 'HEAD' ? undefined : buf);
}

/** The file a static path maps to, or null (same rules as server.py _static_allowed). */
function staticFile(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch (e) { return null; }
    const norm = path.posix.normalize(p);
    if (norm !== p || p.includes('/.') || p.includes('\0')) return null;
    if (!(STATIC_FILE_RE.test(p) || STATIC_DIRS.some(d => p.startsWith(d)))) return null;
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT + path.sep)) return null;
    return file;
}

const server = http.createServer((req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, '{"ok":false,"error":"forbidden"}', 'application/json');
    const urlPath = (req.url || '/').split('?', 1)[0];
    if (urlPath.startsWith('/api/')) {
        const key = urlPath.replace(/\/+$/, '');
        if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(API, key)) {
            return send(res, 200, JSON.stringify(API[key]), 'application/json');
        }
        return send(res, 404, '{"ok":false,"error":"not found"}', 'application/json');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
    const file = staticFile(urlPath);
    let st = null;
    try { st = file && fs.lstatSync(file); } catch (e) { st = null; }
    if (!st || !st.isFile()) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
});
server.listen(PORT, '127.0.0.1', () => console.log(`static-serve.js: ${ROOT} on http://127.0.0.1:${PORT}`));
