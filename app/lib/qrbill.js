// Swiss QR-bill: decode QR codes from page images (zbarimg) and parse the
// Swiss Payments Code payload.
//
// Implements SIX Implementation Guidelines v2.3 (accepting v2.2 'K' combined
// addresses too -- pre-Nov-2025 paper is everywhere) and Swico S1 billing
// information. Payload Version is '0200' for all of v2.0-2.4, so spec version
// cannot be detected from the payload.

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const QR_IID_MIN = 30000, QR_IID_MAX = 31999;
const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

const NOTIFICATION_TEXTS = [
  "NICHT ZUR ZAHLUNG VERWENDEN",
  "NE PAS UTILISER POUR LE PAIEMENT",
  "NON UTILIZZARE PER IL PAGAMENTO",
  "DO NOT USE FOR PAYMENT",
];

// big-int mod 97 over a digit string (IBAN/SCOR check)
function mod97(digits) {
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem;
}

const alnumDigits = (s) =>
  [...s].map((c) => parseInt(c, 36).toString()).join("");

function ibanValid(iban) {
  const s = String(iban || "").replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(s)) return false;
  return mod97(alnumDigits(s.slice(4) + s.slice(0, 4))) === 1;
}

function isQrIban(iban) {
  const s = String(iban || "").replace(/\s/g, "");
  if (s.length < 9) return false;
  const iid = parseInt(s.slice(4, 9), 10);
  return Number.isInteger(iid) && iid >= QR_IID_MIN && iid <= QR_IID_MAX;
}

function qrrValid(ref) {
  // QR reference: 27 digits, mod-10 recursive check digit, not all zeros.
  if (!/^\d{27}$/.test(ref || "") || /^0+$/.test(ref)) return false;
  let carry = 0;
  for (const d of ref.slice(0, 26))
    carry = MOD10_TABLE[(carry + (d.charCodeAt(0) - 48)) % 10];
  return (10 - carry) % 10 === parseInt(ref[26], 10);
}

function scorValid(ref) {
  // ISO 11649 creditor reference: RF + 2 check digits + <=21 alnum.
  const s = String(ref || "").toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(s)) return false;
  return mod97(alnumDigits(s.slice(4) + s.slice(0, 4))) === 1;
}

function swicoSplit(s) {
  // Split on '/' honoring \/ and \\ escapes.
  const parts = [];
  let cur = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && "/\\".includes(s[i + 1])) {
      cur += s[i + 1]; i += 2;
    } else if (c === "/") {
      parts.push(cur); cur = ""; i += 1;
    } else {
      cur += c; i += 1;
    }
  }
  parts.push(cur);
  return parts;
}

function yymmdd(s) {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(s || "");
  if (!m) return null;
  const [, yy, mo, dd] = m;
  const year = 2000 + parseInt(yy, 10);
  const d = new Date(Date.UTC(year, parseInt(mo, 10) - 1, parseInt(dd, 10)));
  if (d.getUTCMonth() + 1 !== parseInt(mo, 10) || d.getUTCDate() !== parseInt(dd, 10))
    return null;
  return d.toISOString().slice(0, 10);
}

const addDays = (iso, days) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function parseSwico(strd) {
  // Parse Swico S1 billing information ('//S1/10/.../40/2:10;0:30').
  // Returns dict with raw tags plus derived: invoice_no, invoice_date,
  // customer_ref, uid, due_date (from /11/ + the 0%-entry of /40/),
  // discounts [[pct, days], ...].
  if (!strd || !strd.startsWith("//")) return null;
  const scheme = strd.slice(2, 4);
  if (scheme !== "S1") return { scheme, raw: strd };
  const parts = swicoSplit(strd.slice(4));
  // parts[0] is '' (leading /), then alternating tag, value
  const tags = {};
  for (let i = 1; i < parts.length; i += 2)
    if (parts[i]) tags[parts[i]] = parts[i + 1] ?? "";
  const out = { scheme: "S1", tags, raw: strd };
  out.invoice_no = tags["10"] ?? null;
  out.invoice_date = "11" in tags ? yymmdd(tags["11"]) : null;
  out.customer_ref = tags["20"] ?? null;
  out.uid = tags["30"] ?? null;
  if ("40" in tags) {
    const discounts = [];
    for (const cond of tags["40"].split(";")) {
      const m = /^([\d.]+):(\d+)$/.exec(cond.trim());
      if (m) discounts.push([parseFloat(m[1]), parseInt(m[2], 10)]);
    }
    out.discounts = discounts;
    const net = discounts.find(([pct]) => pct === 0)?.[1];
    if (net !== undefined && out.invoice_date)
      out.due_date = addDays(out.invoice_date, net);
  }
  return out;
}

function address(lines) {
  // 7 payload lines -> address dict (S structured or K combined).
  const [adrtp, name, l1, l2, pcode, town, country] =
    [...lines, "", "", "", "", "", "", ""].slice(0, 7);
  if (!name) return null;
  const a = { name, country: country || null, type: adrtp || null };
  if (adrtp === "K") {
    a.line1 = l1 || null; a.line2 = l2 || null;
  } else {
    a.street = l1 || null; a.building = l2 || null;
    a.postal_code = pcode || null; a.town = town || null;
  }
  return a;
}

function parseSpc(payload) {
  // Parse a Swiss Payments Code payload. Returns dict or null if not SPC.
  // Tolerant reader: validation problems recorded in .problems instead of
  // rejecting (scanned archives contain old and slightly broken bills).
  if (!payload) return null;
  const lines = payload.replace(/\r\n/g, "\n").split("\n");
  if (lines.length < 31 || lines[0].trim() !== "SPC") return null;
  const L = lines.map((ln) => ln.trim());
  while (L.length < 34) L.push("");
  const problems = [];
  if (L[1] !== "0200") problems.push(`unexpected version '${L[1]}'`);
  if (L[2] !== "1") problems.push(`unexpected coding '${L[2]}'`);

  const iban = L[3].replace(/\s/g, "").toUpperCase();
  if (!ibanValid(iban)) problems.push(`IBAN check failed: ${iban}`);
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
    if (!qrrValid(reference)) problems.push(`QRR reference invalid: ${reference}`);
    if (!isQrIban(iban)) problems.push("QRR used with non-QR-IBAN");
  } else if (refType === "SCOR") {
    if (!scorValid(reference)) problems.push(`SCOR reference invalid: ${reference}`);
    if (isQrIban(iban)) problems.push("SCOR used with QR-IBAN");
  } else if (refType === "NON") {
    if (reference) problems.push("reference present with type NON");
  } else {
    problems.push(`unknown reference type '${refType}'`);
  }

  const message = L[29];
  if (L[30] !== "EPD") problems.push(`missing EPD trailer (got '${L[30]}')`);
  const swico = L[31] ? parseSwico(L[31]) : null;
  const alt = L.slice(32, 34).filter(Boolean);

  const isNotification = amount === 0.0 ||
    NOTIFICATION_TEXTS.some((t) => (message || "").toUpperCase().includes(t));

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

async function decodeQrCodes(imagePath) {
  // All QR payloads in an image via zbarimg. Returns list of strings.
  let stdout;
  try {
    ({ stdout } = await execFileP(
      "zbarimg",
      ["--raw", "-q", "-Sdisable", "-Sqrcode.enable", "-Sbinary", imagePath],
      { encoding: "buffer", maxBuffer: 16 << 20 }));
  } catch (e) {
    if (e.code === 4 && e.stdout) stdout = e.stdout;   // 4 = no symbols found
    else return [];
  }
  // -Sbinary stops zbar from charset-guessing (it mangles UTF-8 umlauts
  // otherwise); we decode UTF-8 ourselves. SPC payloads embed newlines,
  // so symbols are split on the 'SPC' header anchor, not on lines.
  const out = stdout.toString("utf-8");
  if (!out.trim()) return [];
  const idxs = [];
  for (const m of out.matchAll(/^SPC\r?$/gm)) idxs.push(m.index);
  if (idxs.length) {
    idxs.push(out.length);
    const chunks = [];
    for (let i = 0; i < idxs.length - 1; i++)
      chunks.push(out.slice(idxs[i], idxs[i + 1]).replace(/^\n+|\n+$/g, ""));
    return chunks;
  }
  return out.replace(/^\n+|\n+$/g, "").split("\n").filter(Boolean);
}

async function findQrbill(imagePaths) {
  // Scan page images for a Swiss QR-bill; first valid SPC wins.
  for (const p of imagePaths) {
    for (const payload of await decodeQrCodes(p)) {
      const parsed = parseSpc(payload);
      if (parsed) return parsed;
    }
  }
  return null;
}

async function renderQrPng(payload) {
  // Swiss QR PNG with the 7/46 Swiss-cross overlay per the IG (ECC level M
  // absorbs it) -- qrencode CLI + sharp SVG composite.
  const sharp = require("sharp");
  const { stdout } = await execFileP(
    "qrencode", ["-t", "PNG", "-l", "M", "-s", "10", "-m", "4", "-o", "-"],
    { encoding: "buffer", input: payload, maxBuffer: 16 << 20 });
  const img = sharp(stdout);
  const { width } = await img.metadata();
  const s = Math.round(width * 7 / 46);
  const stroke = Math.max(1, Math.round(s / 24));
  const arm = Math.round(s * 0.58), thick = Math.round(s * 0.18);
  const c = s / 2;
  const cross = Buffer.from(
    `<svg width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg">
       <rect x="0" y="0" width="${s}" height="${s}" fill="black"
             stroke="white" stroke-width="${stroke}"/>
       <rect x="${c - thick / 2}" y="${c - arm / 2}" width="${thick}" height="${arm}" fill="white"/>
       <rect x="${c - arm / 2}" y="${c - thick / 2}" width="${arm}" height="${thick}" fill="white"/>
     </svg>`);
  return img.composite([{ input: cross, gravity: "centre" }]).png().toBuffer();
}

const buildSpc = (qr) => qr.payload ?? null;

module.exports = { QR_IID_MIN, QR_IID_MAX, MOD10_TABLE, NOTIFICATION_TEXTS,
                   ibanValid, isQrIban, qrrValid, scorValid,
                   parseSwico, parseSpc, decodeQrCodes, findQrbill,
                   renderQrPng, buildSpc };
