/**
 * Minimal PNG decode / encode for the baseline diff (no dependencies: zlib
 * only). Handles what Chromium screenshots are: 8-bit RGB or RGBA,
 * non-interlaced. Anything else throws, and the runner falls back to a
 * byte comparison.
 */
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decode(buf) {
    if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
    let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            depth = data[8]; ctype = data[9]; interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${ctype})`);
    const bpp = ctype === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
            let v = line[x];
            if (f === 1) v += a;
            else if (f === 2) v += b;
            else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
            }
            line[x] = v & 255;
        }
        for (let x = 0; x < width; x++) {
            out[(y * width + x) * 4] = line[x * bpp];
            out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
            out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
            out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
        }
        prev = line;
    }
    return { width, height, data: out };
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
}

function encode({ width, height, data }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Compare two PNG files' bytes. Returns { same, changed, ratio, note, diff }
 * where diff is a PNG buffer (changed pixels red over a faded copy of the
 * new image) when the images differ.
 */
function compare(aBuf, bBuf, { threshold = 0.001, channelTol = 16 } = {}) {
    if (aBuf.equals(bBuf)) return { same: true, changed: false, ratio: 0, note: 'identical' };
    let a, b;
    try { a = decode(aBuf); b = decode(bBuf); } catch (e) {
        return { same: false, changed: true, ratio: 1, note: `bytes differ (${e.message})` };
    }
    if (a.width !== b.width || a.height !== b.height) {
        return { same: false, changed: true, ratio: 1, note: `size ${a.width}x${a.height} -> ${b.width}x${b.height}` };
    }
    const n = a.width * a.height;
    const out = Buffer.alloc(n * 4);
    let diff = 0;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
        if (d > channelTol) {
            diff += 1;
            out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 255;
        } else {
            out[o] = 255 - ((255 - b.data[o]) >> 2); out[o + 1] = 255 - ((255 - b.data[o + 1]) >> 2);
            out[o + 2] = 255 - ((255 - b.data[o + 2]) >> 2); out[o + 3] = 255;
        }
    }
    const ratio = diff / n;
    const changed = ratio > threshold;
    return { same: false, changed, ratio, note: `${(ratio * 100).toFixed(2)}% of pixels differ`,
        diff: changed ? encode({ width: a.width, height: a.height, data: out }) : null };
}

module.exports = { decode, encode, compare };
