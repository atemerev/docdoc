"use strict";
// Text normalization and similarity primitives for dedup. Pure.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fold = exports.normRef = exports.textHash = void 0;
exports.normalizeText = normalizeText;
exports.trigrams = trigrams;
exports.jaccard = jaccard;
exports.slugify = slugify;
const crypto_1 = require("crypto");
function normalizeText(text) {
    return String(text ?? "").toLowerCase().replace(/ß/g, "ss")
        .replace(/[^a-z0-9äöüéèàâçêîôû]+/g, " ")
        .replace(/\s+/g, " ").trim();
}
const textHash = (text) => (0, crypto_1.createHash)("sha256").update(normalizeText(text)).digest("hex");
exports.textHash = textHash;
function trigrams(text) {
    const t = normalizeText(text);
    const out = new Set();
    for (let i = 0; i + 3 <= t.length; i++)
        out.add(t.slice(i, i + 3));
    return out;
}
function jaccard(a, b) {
    if (!a.size || !b.size)
        return 0.0;
    let inter = 0;
    for (const x of a)
        if (b.has(x))
            inter++;
    return inter / (a.size + b.size - inter);
}
/** Normalize an internal reference for matching: uppercase alnum only. */
const normRef = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
exports.normRef = normRef;
/** Normalize text for indexing/search: ss for ß (unicode61 doesn't fold it). */
const fold = (text) => (text ?? "").replace(/ß/g, "ss");
exports.fold = fold;
function slugify(name) {
    const s = String(name ?? "")
        .normalize("NFKD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s.slice(0, 40) || "unknown";
}
