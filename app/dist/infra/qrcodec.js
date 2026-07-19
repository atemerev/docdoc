"use strict";
// QR code I/O: decode QR payloads from page images (zbarimg) and render
// a Swiss QR PNG with the centered 7/46 Swiss cross (qrencode + pngjs).
// SPC *parsing* is pure domain logic in domain/qrbill.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeQrCodes = decodeQrCodes;
exports.findQrbill = findQrbill;
exports.renderQrPng = renderQrPng;
const qrbill_1 = require("../domain/qrbill");
const exec_1 = require("./exec");
/** All QR payloads in an image via zbarimg. */
async function decodeQrCodes(imagePath) {
    let stdout;
    try {
        stdout = await (0, exec_1.runBinary)("zbarimg", ["--raw", "-q", "-Sdisable", "-Sqrcode.enable", "-Sbinary", imagePath], { okCodes: [4] }); // 4 = no symbols found
    }
    catch {
        return [];
    }
    // -Sbinary stops zbar from charset-guessing (it mangles UTF-8 umlauts
    // otherwise); we decode UTF-8 ourselves. SPC payloads embed newlines,
    // so symbols are split on the 'SPC' header anchor, not on lines.
    const out = stdout.toString("utf-8");
    if (!out.trim())
        return [];
    const idxs = [];
    for (const m of out.matchAll(/^SPC\r?$/gm))
        idxs.push(m.index);
    if (idxs.length) {
        idxs.push(out.length);
        const chunks = [];
        for (let i = 0; i < idxs.length - 1; i++)
            chunks.push(out.slice(idxs[i], idxs[i + 1]).replace(/^\n+|\n+$/g, ""));
        return chunks;
    }
    return out.replace(/^\n+|\n+$/g, "").split("\n").filter(Boolean);
}
/** Scan page images for a Swiss QR-bill; first valid SPC wins. */
async function findQrbill(imagePaths) {
    for (const p of imagePaths) {
        for (const payload of await decodeQrCodes(p)) {
            const parsed = (0, qrbill_1.parseSpc)(payload);
            if (parsed)
                return parsed;
        }
    }
    return null;
}
/**
 * Swiss QR PNG with the centered 7/46 Swiss cross per the IG (ECC level
 * M absorbs it) -- qrencode CLI, cross drawn pixel-wise with pngjs.
 */
async function renderQrPng(payload) {
    const { PNG } = require("pngjs");
    const stdout = await (0, exec_1.runBinary)("qrencode", ["-t", "PNG", "-l", "M", "-s", "10", "-m", "4", "-o", "-"], { input: payload });
    const img = PNG.sync.read(stdout);
    const w = img.width;
    const s = Math.round(w * 7 / 46);
    const border = Math.max(1, Math.round(s / 24));
    const arm = Math.round(s * 0.58), thick = Math.round(s * 0.18);
    const cx = Math.floor(w / 2), cy = Math.floor(img.height / 2);
    const put = (x, y, v) => {
        const i = (y * w + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
    };
    const x0 = cx - Math.floor(s / 2), y0 = cy - Math.floor(s / 2);
    for (let y = y0; y < y0 + s; y++)
        for (let x = x0; x < x0 + s; x++) {
            const edge = x - x0 < border || x0 + s - 1 - x < border
                || y - y0 < border || y0 + s - 1 - y < border;
            put(x, y, edge ? 255 : 0); // white outline, black box
        }
    for (let y = cy - Math.floor(arm / 2); y < cy + Math.ceil(arm / 2); y++)
        for (let x = cx - Math.floor(thick / 2); x < cx + Math.ceil(thick / 2); x++)
            put(x, y, 255); // vertical arm
    for (let y = cy - Math.floor(thick / 2); y < cy + Math.ceil(thick / 2); y++)
        for (let x = cx - Math.floor(arm / 2); x < cx + Math.ceil(arm / 2); x++)
            put(x, y, 255); // horizontal arm
    return PNG.sync.write(img);
}
