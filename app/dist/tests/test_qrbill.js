"use strict";
// Round-trip test for the Swiss QR-bill parser: synthesize an SPC
// payload, render it as a QR image (qrencode), decode it back (zbarimg),
// parse, verify. Run: npm test (or the compiled file directly under
// ELECTRON_RUN_AS_NODE).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const qrbill_1 = require("../domain/qrbill");
const qrcodec_1 = require("../infra/qrcodec");
const fixtures_1 = require("./fixtures");
function makeQrr(base26) {
    let carry = 0;
    for (const d of base26)
        carry = qrbill_1.MOD10_TABLE[(carry + Number(d)) % 10];
    return base26 + String((10 - carry) % 10);
}
async function main() {
    console.log("== validation primitives ==");
    (0, fixtures_1.check)("IBAN valid", (0, qrbill_1.ibanValid)("CH4431999123000889012"));
    (0, fixtures_1.check)("IBAN invalid detected", !(0, qrbill_1.ibanValid)("CH4431999123000889013"));
    (0, fixtures_1.check)("QR-IBAN detected", (0, qrbill_1.isQrIban)("CH4431999123000889012"));
    (0, fixtures_1.check)("normal IBAN not QR", !(0, qrbill_1.isQrIban)("CH9300762011623852957"));
    // worked example from the SIX IG: 26-digit ref -> check digit 7
    const ig = makeQrr("21000000000313947143000901");
    (0, fixtures_1.check)("QRR IG example check digit", ig.endsWith("7"), ig);
    (0, fixtures_1.check)("QRR valid", (0, qrbill_1.qrrValid)(ig));
    (0, fixtures_1.check)("QRR bad check digit", !(0, qrbill_1.qrrValid)(ig.slice(0, -1) + "5"));
    (0, fixtures_1.check)("SCOR valid", (0, qrbill_1.scorValid)("RF18539007547034"));
    (0, fixtures_1.check)("SCOR invalid", !(0, qrbill_1.scorValid)("RF19539007547034"));
    console.log("== swico ==");
    const s = (0, qrbill_1.parseSwico)("//S1/10/10201409/11/190512/20/1400.000-53/30/106017086/32/7.7/40/2:10;0:30");
    (0, fixtures_1.check)("swico invoice_no", s.invoice_no === "10201409");
    (0, fixtures_1.check)("swico invoice_date", s.invoice_date === "2019-05-12");
    (0, fixtures_1.check)("swico uid", s.uid === "106017086");
    (0, fixtures_1.check)("swico due date (invoice+30d)", s.due_date === "2019-06-11", String(s.due_date));
    (0, fixtures_1.check)("swico discounts", JSON.stringify(s.discounts) === JSON.stringify([[2.0, 10], [0.0, 30]]));
    const escd = (0, qrbill_1.parseSwico)("//S1/10/X.66711\\/8824/11/200712");
    (0, fixtures_1.check)("swico escaped slash", escd.invoice_no === "X.66711/8824", String(escd.invoice_no));
    console.log("== SPC round trip through a real QR image ==");
    const qrr = makeQrr("21000000000313947143000901");
    const payload = [
        "SPC", "0200", "1",
        "CH4431999123000889012",
        "S", "Max Muster & Söhne", "Musterstrasse", "123", "8000", "Seldwyla", "CH",
        "", "", "", "", "", "", "",
        "1949.75", "CHF",
        "S", "Simon Muster", "Musterstrasse", "1", "8000", "Seldwyla", "CH",
        "QRR", qrr,
        "Auftrag vom 15.06.2026",
        "EPD",
        "//S1/10/10201409/11/260615/30/106017086/40/0:30",
    ].join("\r\n");
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "qrtest-"));
    let found = null;
    try {
        const png = path.join(td, "qr.png");
        (0, child_process_1.execFileSync)("qrencode", ["-l", "M", "-s", "6", "-m", "4", "-o", png, payload]);
        found = await (0, qrcodec_1.findQrbill)([png]);
    }
    finally {
        fs.rmSync(td, { recursive: true, force: true });
    }
    (0, fixtures_1.check)("QR decoded & parsed", found !== null);
    if (found) {
        (0, fixtures_1.check)("iban", found.iban === "CH4431999123000889012");
        (0, fixtures_1.check)("is QR-IBAN", found.is_qr_iban);
        (0, fixtures_1.check)("creditor name", found.creditor?.name === "Max Muster & Söhne", JSON.stringify(found.creditor));
        (0, fixtures_1.check)("amount", found.amount === 1949.75);
        (0, fixtures_1.check)("currency", found.currency === "CHF");
        (0, fixtures_1.check)("ref", found.reference === qrr);
        (0, fixtures_1.check)("debtor", found.debtor?.name === "Simon Muster");
        (0, fixtures_1.check)("swico due date", found.swico?.due_date === "2026-07-15", String(found.swico?.due_date));
        (0, fixtures_1.check)("no problems", found.problems.length === 0, JSON.stringify(found.problems));
        (0, fixtures_1.check)("not a notification", !found.is_notification);
    }
    console.log("== K-address (v2.2 legacy) and notification bills ==");
    const legacy = payload.replace("S\r\nMax Muster & Söhne\r\nMusterstrasse\r\n123\r\n8000\r\nSeldwyla\r\nCH", "K\r\nMax Muster & Söhne\r\nMusterstrasse 123\r\n8000 Seldwyla\r\n\r\n\r\nCH");
    const k = (0, qrbill_1.parseSpc)(legacy);
    (0, fixtures_1.check)("K address parsed", k?.creditor?.line2 === "8000 Seldwyla", JSON.stringify(k?.creditor));
    const notif = (0, qrbill_1.parseSpc)(payload.replace("1949.75", "0.00"));
    (0, fixtures_1.check)("0.00 = notification", notif.is_notification);
    console.log("== QR render with Swiss cross ==");
    const rendered = await (0, qrcodec_1.renderQrPng)(payload);
    (0, fixtures_1.check)("renders a PNG", rendered.length > 1000 &&
        rendered.subarray(1, 4).toString() === "PNG");
    (0, fixtures_1.finish)();
}
void main().catch((e) => { console.error(e); process.exit(1); });
