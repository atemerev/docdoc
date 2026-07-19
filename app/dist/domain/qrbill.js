"use strict";
// Swiss QR-bill: parsing and validation of the Swiss Payments Code.
// Pure domain logic -- decoding QR codes from images lives in
// infra/qrcodec.ts.
//
// Implements SIX Implementation Guidelines v2.3 (accepting v2.2 'K'
// combined addresses too -- pre-Nov-2025 paper is everywhere) and Swico
// S1 billing information. Payload Version is '0200' for all of v2.0-2.4,
// so spec version cannot be detected from the payload.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFICATION_TEXTS = exports.MOD10_TABLE = exports.QR_IID_MAX = exports.QR_IID_MIN = void 0;
exports.ibanValid = ibanValid;
exports.isQrIban = isQrIban;
exports.qrrValid = qrrValid;
exports.scorValid = scorValid;
exports.addDays = addDays;
exports.parseSwico = parseSwico;
exports.parseSpc = parseSpc;
exports.QR_IID_MIN = 30000;
exports.QR_IID_MAX = 31999;
exports.MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
exports.NOTIFICATION_TEXTS = [
    "NICHT ZUR ZAHLUNG VERWENDEN",
    "NE PAS UTILISER POUR LE PAIEMENT",
    "NON UTILIZZARE PER IL PAGAMENTO",
    "DO NOT USE FOR PAYMENT",
];
/** big-int mod 97 over a digit string (IBAN/SCOR check) */
function mod97(digits) {
    let rem = 0;
    for (const ch of digits)
        rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
    return rem;
}
const alnumDigits = (s) => [...s].map((c) => parseInt(c, 36).toString()).join("");
function ibanValid(iban) {
    const s = String(iban ?? "").replace(/\s/g, "").toUpperCase();
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(s))
        return false;
    return mod97(alnumDigits(s.slice(4) + s.slice(0, 4))) === 1;
}
function isQrIban(iban) {
    const s = String(iban ?? "").replace(/\s/g, "");
    if (s.length < 9)
        return false;
    const iid = parseInt(s.slice(4, 9), 10);
    return Number.isInteger(iid) && iid >= exports.QR_IID_MIN && iid <= exports.QR_IID_MAX;
}
/** QR reference: 27 digits, mod-10 recursive check digit, not all zeros. */
function qrrValid(ref) {
    const s = ref ?? "";
    if (!/^\d{27}$/.test(s) || /^0+$/.test(s))
        return false;
    let carry = 0;
    for (const d of s.slice(0, 26))
        carry = exports.MOD10_TABLE[(carry + (d.charCodeAt(0) - 48)) % 10];
    return (10 - carry) % 10 === parseInt(s[26], 10);
}
/** ISO 11649 creditor reference: RF + 2 check digits + <=21 alnum. */
function scorValid(ref) {
    const s = String(ref ?? "").toUpperCase();
    if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(s))
        return false;
    return mod97(alnumDigits(s.slice(4) + s.slice(0, 4))) === 1;
}
/** Split on '/' honoring \/ and \\ escapes. */
function swicoSplit(s) {
    const parts = [];
    let cur = "", i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === "\\" && i + 1 < s.length && "/\\".includes(s[i + 1])) {
            cur += s[i + 1];
            i += 2;
        }
        else if (c === "/") {
            parts.push(cur);
            cur = "";
            i += 1;
        }
        else {
            cur += c;
            i += 1;
        }
    }
    parts.push(cur);
    return parts;
}
function yymmdd(s) {
    const m = /^(\d{2})(\d{2})(\d{2})/.exec(s);
    if (!m)
        return null;
    const year = 2000 + parseInt(m[1], 10);
    const mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
    const d = new Date(Date.UTC(year, mo - 1, dd));
    if (d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== dd)
        return null;
    return d.toISOString().slice(0, 10);
}
function addDays(iso, days) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
/**
 * Parse Swico S1 billing information ('//S1/10/.../40/2:10;0:30').
 * Returns tags plus derived invoice_no, invoice_date, customer_ref, uid,
 * due_date (from /11/ + the 0%-entry of /40/) and discounts.
 */
function parseSwico(strd) {
    if (!strd || !strd.startsWith("//"))
        return null;
    const scheme = strd.slice(2, 4);
    if (scheme !== "S1")
        return { scheme, raw: strd };
    const parts = swicoSplit(strd.slice(4));
    // parts[0] is '' (leading /), then alternating tag, value
    const tags = {};
    for (let i = 1; i < parts.length; i += 2)
        if (parts[i])
            tags[parts[i]] = parts[i + 1] ?? "";
    const out = { scheme: "S1", tags, raw: strd };
    out.invoice_no = tags["10"] ?? null;
    out.invoice_date = "11" in tags ? yymmdd(tags["11"]) : null;
    out.customer_ref = tags["20"] ?? null;
    out.uid = tags["30"] ?? null;
    if ("40" in tags) {
        const discounts = [];
        for (const cond of tags["40"].split(";")) {
            const m = /^([\d.]+):(\d+)$/.exec(cond.trim());
            if (m)
                discounts.push([parseFloat(m[1]), parseInt(m[2], 10)]);
        }
        out.discounts = discounts;
        const net = discounts.find(([pct]) => pct === 0)?.[1];
        if (net !== undefined && out.invoice_date)
            out.due_date = addDays(out.invoice_date, net);
    }
    return out;
}
/** 7 payload lines -> address (S structured or K combined). */
function address(lines) {
    const [adrtp, name, l1, l2, pcode, town, country] = [...lines, "", "", "", "", "", "", ""].slice(0, 7);
    if (!name)
        return null;
    const a = { name, country: country || null, type: adrtp || null };
    if (adrtp === "K") {
        a.line1 = l1 || null;
        a.line2 = l2 || null;
    }
    else {
        a.street = l1 || null;
        a.building = l2 || null;
        a.postal_code = pcode || null;
        a.town = town || null;
    }
    return a;
}
/**
 * Parse a Swiss Payments Code payload. Returns null if not SPC.
 * Tolerant reader: validation problems are recorded in .problems instead
 * of rejecting (scanned archives contain old and slightly broken bills).
 */
function parseSpc(payload) {
    if (!payload)
        return null;
    const lines = payload.replace(/\r\n/g, "\n").split("\n");
    if (lines.length < 31 || lines[0].trim() !== "SPC")
        return null;
    const L = lines.map((ln) => ln.trim());
    while (L.length < 34)
        L.push("");
    const problems = [];
    if (L[1] !== "0200")
        problems.push(`unexpected version '${L[1]}'`);
    if (L[2] !== "1")
        problems.push(`unexpected coding '${L[2]}'`);
    const iban = L[3].replace(/\s/g, "").toUpperCase();
    if (!ibanValid(iban))
        problems.push(`IBAN check failed: ${iban}`);
    if (!["CH", "LI"].includes(iban.slice(0, 2)))
        problems.push(`IBAN not CH/LI: ${iban.slice(0, 2)}`);
    const creditor = address(L.slice(4, 11));
    const debtor = address(L.slice(20, 27));
    let amount = null;
    if (L[18]) {
        amount = parseFloat(L[18]);
        if (!Number.isFinite(amount)) {
            problems.push(`bad amount '${L[18]}'`);
            amount = null;
        }
    }
    const currency = L[19];
    if (!["CHF", "EUR"].includes(currency))
        problems.push(`bad currency '${currency}'`);
    const refType = L[27], reference = L[28].replace(/\s/g, "");
    if (refType === "QRR") {
        if (!qrrValid(reference))
            problems.push(`QRR reference invalid: ${reference}`);
        if (!isQrIban(iban))
            problems.push("QRR used with non-QR-IBAN");
    }
    else if (refType === "SCOR") {
        if (!scorValid(reference))
            problems.push(`SCOR reference invalid: ${reference}`);
        if (isQrIban(iban))
            problems.push("SCOR used with QR-IBAN");
    }
    else if (refType === "NON") {
        if (reference)
            problems.push("reference present with type NON");
    }
    else {
        problems.push(`unknown reference type '${refType}'`);
    }
    const message = L[29];
    if (L[30] !== "EPD")
        problems.push(`missing EPD trailer (got '${L[30]}')`);
    const swico = L[31] ? parseSwico(L[31]) : null;
    const alt = L.slice(32, 34).filter(Boolean);
    const isNotification = amount === 0.0 ||
        exports.NOTIFICATION_TEXTS.some((t) => (message || "").toUpperCase().includes(t));
    return {
        iban,
        is_qr_iban: isQrIban(iban),
        creditor,
        debtor,
        amount,
        currency,
        ref_type: refType,
        reference: reference || null,
        message: message || null,
        swico,
        alt_procedures: alt,
        is_notification: isNotification,
        problems,
        payload,
    };
}
