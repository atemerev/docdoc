"use strict";
// Synthetic scan batches: a Swiss insurance premium invoice with a
// QR-bill, and a matching 1. Mahnung. Used to exercise the invoice
// lifecycle, reminder linking, refs and dedup end to end.
Object.defineProperty(exports, "__esModule", { value: true });
exports.failures = exports.QRR = exports.IBAN = void 0;
exports.page = page;
exports.invoicePage = invoicePage;
exports.mahnungPage = mahnungPage;
exports.check = check;
exports.finish = finish;
const child_process_1 = require("child_process");
exports.IBAN = "CH4431999123000889012"; // valid QR-IBAN (IID 31999)
exports.QRR = "210000000003139471430009017"; // valid mod-10 check digit
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function spc(amount, message, swico) {
    return [
        "SPC", "0200", "1",
        exports.IBAN,
        "S", "Helvetia Versicherungen AG", "St. Alban-Anlage", "26",
        "4002", "Basel", "CH",
        "", "", "", "", "", "", "",
        amount.toFixed(2), "CHF",
        "S", "Aryeh Testperson", "Musterweg", "1", "8000", "Zürich", "CH",
        "QRR",
        exports.QRR,
        message, "EPD", swico,
    ].join("\r\n");
}
/**
 * Render an A4-ish 300dpi page image via rsvg-convert; y is the text top
 * edge. The QR is embedded as a data-URI <image> -- no raster
 * compositing needed.
 */
function page(lines, qrPayload = null) {
    const texts = lines.map(([x, y, size, bold, text]) => `<text x="${x}" y="${y + size}" font-family="DejaVu Sans"
       font-size="${size}" ${bold ? 'font-weight="bold"' : ""}
       fill="black">${esc(text)}</text>`).join("\n");
    let qrEl = "";
    if (qrPayload) {
        const qrPng = (0, child_process_1.execFileSync)("qrencode", ["-l", "M", "-s", "8", "-m", "4", "-t", "PNG", "-o", "-", qrPayload], { maxBuffer: 16 << 20 });
        qrEl = `<image x="180" y="2760" width="560" height="560"
              style="image-rendering:pixelated"
              href="data:image/png;base64,${qrPng.toString("base64")}"/>`;
    }
    const svg = Buffer.from(`<svg width="2480" height="3508" xmlns="http://www.w3.org/2000/svg"
          xmlns:xlink="http://www.w3.org/1999/xlink">
       <rect width="2480" height="3508" fill="white"/>${texts}${qrEl}</svg>`);
    return (0, child_process_1.execFileSync)("rsvg-convert", ["--format", "png"], { input: svg, maxBuffer: 64 << 20 });
}
function invoicePage() {
    const lines = [
        [180, 160, 64, true, "Helvetia Versicherungen AG"],
        [180, 250, 40, false, "St. Alban-Anlage 26, 4002 Basel"],
        [1700, 160, 40, false, "Basel, 15.06.2026"],
        [180, 480, 40, false, "Aryeh Testperson"],
        [180, 540, 40, false, "Musterweg 1"],
        [180, 600, 40, false, "8000 Zürich"],
        [180, 860, 56, true, "Rechnung Nr. RE-2026-0042"],
        [180, 970, 40, false, "Hausratversicherung — Prämie 2026/2027"],
        [180, 1030, 40, false, "Policen-Nr. P-778899"],
        [180, 1090, 40, false, "Kunden-Nr. K-556677"],
        [180, 1250, 40, false, "Versicherungsperiode: 01.07.2026 – 30.06.2027"],
        [180, 1400, 44, true, "Prämie total: CHF 249.60"],
        [180, 1520, 40, false, "Zahlbar bis 15.07.2026 (30 Tage netto)."],
        [180, 2650, 44, true, "Zahlteil / Section paiement"],
    ];
    const sw = "//S1/10/RE-2026-0042/11/260615/30/106017086/40/0:30";
    return page(lines, spc(249.60, "Praemie Hausrat P-778899", sw));
}
function mahnungPage() {
    const lines = [
        [180, 160, 64, true, "Helvetia Versicherungen AG"],
        [180, 250, 40, false, "St. Alban-Anlage 26, 4002 Basel"],
        [1700, 160, 40, false, "Basel, 05.08.2026"],
        [180, 480, 40, false, "Aryeh Testperson"],
        [180, 540, 40, false, "Musterweg 1"],
        [180, 600, 40, false, "8000 Zürich"],
        [180, 860, 56, true, "1. Mahnung"],
        [180, 970, 40, false,
            "Unsere Rechnung Nr. RE-2026-0042 vom 15.06.2026 ist trotz"],
        [180, 1030, 40, false, "Fälligkeit am 15.07.2026 noch unbeglichen."],
        [180, 1150, 40, false, "Policen-Nr. P-778899"],
        [180, 1300, 40, false, "Rechnungsbetrag:          CHF 249.60"],
        [180, 1360, 40, false, "Mahngebühr:               CHF  20.00"],
        [180, 1450, 44, true, "Total zahlbar:            CHF 269.60"],
        [180, 1570, 40, false,
            "Wir bitten um Zahlung bis 19.08.2026 mit dem ursprünglichen"],
        [180, 1630, 40, false, "Einzahlungsschein."],
    ];
    // deliberately no QR payment part: reminders often arrive as plain
    // letters, so linking must work via the extracted invoice number
    return page(lines);
}
// shared check-harness for the plain-node test suites
exports.failures = [];
function check(name, cond, detail = "") {
    console.log(`  [${cond ? "ok" : "FAIL"}] ${name} ${detail}`);
    if (!cond)
        exports.failures.push(name);
}
function finish() {
    console.log(`\n${exports.failures.length} failure(s)`);
    process.exit(exports.failures.length ? 1 : 0);
}
