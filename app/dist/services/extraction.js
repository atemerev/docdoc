"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalize = normalize;
exports.extractHeuristic = extractHeuristic;
// Local metadata suggestions. No network calls, model service, or page mutations.
const textsim_1 = require("../domain/textsim");
const types_1 = require("../domain/types");
const document_dates_1 = require("../domain/document_dates");
const pursuit_1 = require("../domain/pursuit");
const correspondence_1 = require("../domain/correspondence");
const senders_1 = require("../domain/senders");
const isoDate = (v) => {
    const s = String(v ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
        return null;
    const d = new Date(s + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
        ? s
        : null;
};
/** Normalize metadata suggestions and decoded QR fields. */
function normalize(d, qr = null) {
    const str = (v) => String(v ?? "").trim();
    const num = (v) => {
        const n = v != null ? parseFloat(String(v)) : NaN;
        return Number.isFinite(n) ? n : null;
    };
    const out = {
        doc_type: types_1.DOC_TYPES.includes(d.doc_type)
            ? d.doc_type
            : "other",
        sender_name: str(d.sender_name) || null,
        sender_key: (0, textsim_1.slugify)(str(d.sender_key) || str(d.sender_name)),
        recipient_name: str(d.recipient_name) || null,
        title: str(d.title) || null,
        language: str(d.language).slice(0, 2).toLowerCase() || null,
        summary_en: str(d.summary_en) || null,
        tags: (Array.isArray(d.tags) ? d.tags : [])
            .map((t) => String(t).toLowerCase().trim().slice(0, 32))
            .filter(Boolean)
            .slice(0, 8),
        doc_date: d.doc_date ? isoDate(d.doc_date) : null,
        case_opened_date: (0, document_dates_1.validDate)(d.case_opened_date),
        date_evidence: str(d.date_evidence) || null,
        pursuit: d.pursuit ? d.pursuit : null,
        case_handler: d.case_handler ? d.case_handler : null,
        due_date: d.due_date ? isoDate(d.due_date) : null,
        amount: num(d.amount),
        reminder_fee: num(d.reminder_fee),
        currency: str(d.currency).slice(0, 3).toUpperCase() || null,
        invoice_ref: str(d.invoice_ref) || null,
        reminder_level: (() => {
            const lvl = parseInt(String(d.reminder_level), 10);
            return Number.isFinite(lvl) ? Math.max(0, Math.min(9, lvl)) : 0;
        })(),
        refs: (Array.isArray(d.refs) ? d.refs : [])
            .filter((r) => !!r &&
            typeof r === "object" &&
            !!r.value)
            .map((r) => ({
            kind: types_1.REF_KINDS.includes(r.kind)
                ? r.kind
                : "other",
            value: String(r.value).trim().slice(0, 64),
            ...(Number.isInteger(r.page) ? { page: Number(r.page) } : {}),
            ...(r.evidence ? { evidence: String(r.evidence).slice(0, 240) } : {}),
        }))
            .slice(0, 200),
        ref_dates: (Array.isArray(d.ref_dates) ? d.ref_dates : [])
            .map((r) => {
            const rr = r;
            const date = rr ? isoDate(rr.date) : null;
            return date
                ? {
                    date,
                    label: String(rr.label ?? "").slice(0, 80),
                    kind: rr.kind,
                    page: Number(rr.page) || undefined,
                    evidence: String(rr.evidence || "").slice(0, 240),
                }
                : null;
        })
            .filter((x) => x !== null)
            .slice(0, 200),
    };
    // QR-bill data is authoritative where present
    if (qr) {
        if (qr.amount && !qr.is_notification && out.doc_type !== "pursuit") {
            out.amount = qr.amount;
            out.currency = qr.currency || out.currency;
        }
        if (qr.swico?.due_date)
            out.due_date = qr.swico.due_date;
        if (qr.swico?.invoice_no)
            out.invoice_ref = qr.swico.invoice_no;
        if (!["invoice", "reminder", "pursuit"].includes(out.doc_type) &&
            !qr.is_notification)
            out.doc_type = "invoice";
        if (qr.creditor && !out.sender_name) {
            out.sender_name = qr.creditor.name;
            out.sender_key = (0, textsim_1.slugify)(qr.creditor.name);
        }
    }
    return out;
}
const REMINDER_WORDS = /\b(zahlungserinnerung|mahnung|rappel|sollecito|payment reminder)\b/i;
const TYPE_WORDS = [
    ["pursuit", pursuit_1.PURSUIT_WORDS],
    ["invoice", /\b(rechnung|facture|fattura|invoice)\b/i],
    ["receipt", /\b(quittung|beleg|reçu|ricevuta|receipt)\b/i],
    [
        "contract",
        /\b(vertrag|contrat|contratto|contract|employment agreement)\b/i,
    ],
    [
        "statement",
        /\b(kontoauszug|auszug|relevé|estratto|statement|transaction overview|transactions overview)\b/i,
    ],
    ["policy", /\b(versicherungspolice|police d.assurance|insurance policy)\b/i],
    [
        "tax",
        /\b(steuererklärung|steuerveranlagung|tax assessment|tax return|déclaration fiscale|déclaration d.impôt)\b/i,
    ],
    [
        "medical",
        /\b(laborbericht|arztbericht|medical report|lab results|rapport médical)\b/i,
    ],
    ["return_slip", /\b(retourenschein|return slip|bon de retour)\b/i],
    ["letter", /\b(dear|sehr geehrte|madame|monsieur|cher|chère)\b/i],
];
const REF_PATTERNS = [
    [
        "invoice_no",
        /(?:Rechnungs?[-\s]?(?:Nr|Nummer)|Facture\s?(?:no|n°)|Fattura\s?n\.?|Invoice\s?(?:no|number|#))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i,
    ],
    [
        "customer_no",
        /(?:Kunden[-\s]?(?:Nr|Nummer)|Client\s?(?:no|n°)|Customer\s?(?:no|number)|Debitor[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i,
    ],
    [
        "policy_no",
        /(?:Policen?[-\s]?(?:Nr|Nummer)|Police\s?(?:no|n°)?|Policy\s?(?:no|number)|Versicherungs[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i,
    ],
    [
        "contract_no",
        /(?:Vertrags?[-\s]?(?:Nr|Nummer)|Contrat\s?(?:no|n°)|Contract\s?(?:no|number|nr))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i,
    ],
];
const AMOUNT_RE = /\b(?:CHF|Fr\.?|EUR|€)\s*([\d'’   ]*\d(?:[.,]\d{2}))/i;
function printedSiteName(text) {
    // Browser print headers contain a page title, site name and URL. Use the
    // matching site label instead of mistaking an OCR-damaged logo for a sender.
    for (const line of text
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, 3)) {
        const url = /https?:\/\/[^\s]+/.exec(line)?.[0];
        if (!url || !line.includes("|"))
            continue;
        try {
            const host = new URL(url).hostname
                .replace(/^www\./, "")
                .split(".")
                .slice(0, -1);
            const label = line
                .slice(0, line.indexOf(url))
                .split("|")
                .map((part) => part.trim())
                .find((part) => part.length >= 3 &&
                part.length <= 60 &&
                host.some((name) => (0, senders_1.senderName)(part).replace(/ /g, "") === (0, senders_1.senderName)(name)));
            if (label)
                return label;
        }
        catch {
            /* a damaged URL is not reliable sender evidence */
        }
    }
    return undefined;
}
/** Local suggestions from keywords and QR data. Verify them before filing. */
function extractHeuristic(ocrText, qr = null, senders = []) {
    const text = ocrText || "";
    const d = {};
    if (pursuit_1.PURSUIT_WORDS.test(text))
        d.doc_type = "pursuit";
    else if (REMINDER_WORDS.test(text)) {
        d.doc_type = "reminder";
        const lvl = /(\d)\s*\.?\s*(?:mahnung|rappel|sollecito)/i.exec(text);
        d.reminder_level = lvl ? parseInt(lvl[1], 10) : 1;
    }
    else {
        d.doc_type = TYPE_WORDS.find(([, rx]) => rx.test(text))?.[0] ?? "other";
    }
    Object.assign(d, (0, document_dates_1.documentDates)(text, d.doc_type === "pursuit"));
    if (d.doc_type !== "pursuit" && (0, document_dates_1.validDate)(qr?.swico?.invoice_date)) {
        d.doc_date = qr.swico.invoice_date;
        d.date_evidence = "Invoice date encoded in the Swiss QR-bill";
    }
    const am = AMOUNT_RE.exec(text);
    if (am) {
        d.amount = parseFloat(am[1].replace(/['’   ]/g, "").replace(",", "."));
        d.currency = /EUR|€/i.test(am[0]) ? "EUR" : "CHF";
    }
    if (qr?.creditor && d.doc_type !== "pursuit") {
        d.sender_name = qr.creditor.name;
    }
    else {
        const known = (0, senders_1.senderFromHeader)(senders, text);
        d.sender_name = printedSiteName(text) || known?.name;
        // Skip print headers, addresses, document headings and recipient labels.
        for (let line of text
            .split("\n")
            .filter((l) => l.trim())
            .slice(0, 8)) {
            if (d.sender_name)
                break;
            line = line
                .trim()
                .split(/\s{3,}/)[0]
                .replace(/^[^\p{L}\p{N}]+/u, "");
            if (line.length >= 3 &&
                line.length <= 80 &&
                !/^\d/.test(line) &&
                !/^(direct print|printed|print.out|page |seite |to:|from:|date:|an:|datum:|dear |sehr geehrte|madame|monsieur)/i.test(line) &&
                !TYPE_WORDS.some(([, rx]) => rx.test(line)) &&
                !REMINDER_WORDS.test(line) &&
                !/\b\d{4}\b|\b(?:strasse|straße|street|road|rue|avenue)\b/i.test(line)) {
                d.sender_name = line;
                break;
            }
        }
    }
    const knownSender = d.sender_name
        ? (0, senders_1.matchSender)(senders, String(d.sender_name), {
            uid: qr?.swico?.uid,
            iban: qr?.iban,
        })
        : undefined;
    if (knownSender)
        d.sender_name = knownSender.name;
    d.sender_key = (0, textsim_1.slugify)(String(d.sender_name ?? ""));
    // Normalize QR information before selecting the title (a QR invoice may have
    // no readable invoice heading).
    const dt = normalize(d, qr).doc_type;
    const headingPattern = dt === "reminder"
        ? REMINDER_WORDS
        : TYPE_WORDS.find(([type]) => type === dt)?.[1];
    const heading = text
        .split("\n")
        .map((line) => line.trim().split(/\s{3,}/)[0])
        .find((line) => line.length >= 4 &&
        line.length <= 100 &&
        !/https?:\/\/|\s\|\s/.test(line) &&
        (0, senders_1.senderName)(line) !== (0, senders_1.senderName)(String(d.sender_name || "")) &&
        headingPattern?.test(line) &&
        !/^(dear |sehr geehrte|madame|monsieur)/i.test(line));
    const label = {
        invoice: "Invoice",
        reminder: "Payment reminder",
        return_slip: "Return slip",
        other: "Document",
    }[dt] || dt[0].toUpperCase() + dt.slice(1);
    d.title =
        text.trim() || qr
            ? heading ||
                [d.sender_name, label, d.doc_date].filter(Boolean).join(" · ")
            : null;
    d.tags = dt !== "other" ? [dt] : [];
    const correspondence = (0, correspondence_1.correspondenceMetadata)(text, d.doc_type === "pursuit");
    d.case_handler = correspondence.case_handler;
    const refs = [...correspondence.refs];
    for (const [kind, rx] of REF_PATTERNS)
        for (const m of text.matchAll(new RegExp(rx.source, rx.flags + "g")))
            refs.push({ kind, value: m[1] });
    d.refs = refs;
    if (d.doc_type === "pursuit") {
        const pursuit = (0, pursuit_1.pursuitMetadata)(text);
        d.pursuit = pursuit.pursuit;
        d.refs = [...pursuit.refs, ...refs].filter((ref, i, all) => all.findIndex((other) => other.kind === ref.kind && other.value === ref.value) === i);
        const number = pursuit.refs.find((ref) => ref.kind === "pursuit_no")?.value;
        d.title = [pursuit.pursuit.subtype, number ? `Poursuite ${number}` : null]
            .filter(Boolean)
            .join(" · ");
        d.amount = pursuit.pursuit.outstanding_amount;
        d.currency = pursuit.pursuit.currency;
    }
    return normalize(d, qr);
}
