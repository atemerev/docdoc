"use strict";
// Invoice chain collation test: one row per chain in listInvoices,
// orphan reminders visible and chaining together, paying any member
// settles the whole chain, bank accounts + IBAN integrity, do-not-pay,
// status abort fallback.
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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const configMod = __importStar(require("../infra/config"));
const db = __importStar(require("../infra/db"));
const invoices = __importStar(require("../services/invoices"));
const fixtures_1 = require("./fixtures");
const CFG = { ai_provider: "none", default_payment_term_days: 30 };
function addDoc(con, title, docType) {
    return Number(con.prepare(`INSERT INTO documents(created_at, title, doc_type, status, reviewed)
     VALUES (?,?,?,'inbox',1)`).run(db.nowIso(), title, docType).lastInsertRowid);
}
async function main() {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "invtest-"));
    const dbfile = path.join(td, "test.db");
    const con = db.connect(dbfile);
    // chain A: original invoice + linked reminder
    const d1 = addDoc(con, "Rechnung A", "invoice");
    const { invoiceId: invA } = await invoices.recordInvoice(con, CFG, d1, null, { doc_type: "invoice", amount: 100.0, invoice_ref: "A-1",
        doc_date: "2026-07-01", refs: [], tags: [], ref_dates: [],
        reminder_level: 0 }, null);
    const d2 = addDoc(con, "Mahnung A", "reminder");
    const ra = await invoices.recordInvoice(con, CFG, d2, null, { doc_type: "reminder", reminder_level: 1, amount: 120.0,
        invoice_ref: "A-1", reminder_fee: 20.0, refs: [], tags: [],
        ref_dates: [] }, null);
    (0, fixtures_1.check)("reminder linked to its invoice", ra.notes.some((n) => n.includes("linked to invoice")), ra.notes.join("; "));
    // chain B: orphan reminder (original never scanned), then a second
    // reminder that must chain onto the first orphan
    const d3 = addDoc(con, "Sommation B (1st scanned)", "reminder");
    const rb1 = await invoices.recordInvoice(con, CFG, d3, null, { doc_type: "reminder", reminder_level: 1, amount: 200.0,
        invoice_ref: "B-7", refs: [], tags: [], ref_dates: [] }, null);
    (0, fixtures_1.check)("orphan reminder recorded without parent", rb1.notes.some((n) => n.includes("no matching open invoice")), rb1.notes.join("; "));
    const d4 = addDoc(con, "Sommation B (2nd scanned)", "reminder");
    const rb2 = await invoices.recordInvoice(con, CFG, d4, null, { doc_type: "reminder", reminder_level: 2, amount: 220.0,
        invoice_ref: "B-7", reminder_fee: 20.0, refs: [], tags: [],
        ref_dates: [] }, null);
    (0, fixtures_1.check)("second orphan reminder chains onto the first", rb2.notes.some((n) => n.includes("linked to invoice")), rb2.notes.join("; "));
    let rows = invoices.listInvoices(con);
    (0, fixtures_1.check)("one row per chain", rows.length === 2, `(got ${rows.length}: ${rows.map((r) => r.id).join(",")})`);
    const byRef = Object.fromEntries(rows.map((r) => [r.invoice_ref, r]));
    (0, fixtures_1.check)("chain A root is the original invoice", byRef["A-1"]?.id === invA);
    (0, fixtures_1.check)("chain A collates its reminder", byRef["A-1"]?.max_reminder_level === 1
        && byRef["A-1"]?.reminder_count === 1);
    (0, fixtures_1.check)("chain A amount_due follows the reminder", byRef["A-1"]?.amount_due === 120.0);
    const b = byRef["B-7"];
    (0, fixtures_1.check)("orphan chain visible, rooted at first scanned reminder", b?.id === rb1.invoiceId);
    (0, fixtures_1.check)("orphan chain collates to max level 2", b?.max_reminder_level === 2 && b?.reminder_count === 2);
    (0, fixtures_1.check)("orphan chain amount_due follows newest reminder", b?.amount_due === 220.0);
    // paying any chain member settles the chain, list shows it paid
    invoices.markPaid(con, rb2.invoiceId);
    rows = invoices.listInvoices(con, { status: "paid" });
    (0, fixtures_1.check)("paying a member settles the whole orphan chain", rows.length === 1 && rows[0].id === rb1.invoiceId
        && rows[0].status === "paid");
    rows = invoices.listInvoices(con, { status: "unpaid" });
    (0, fixtures_1.check)("unpaid list keeps the other chain only", rows.length === 1 && rows[0].id === invA);
    // bank accounts: presets seeded once, first is the default
    const accts = con.prepare("SELECT * FROM bank_accounts ORDER BY id")
        .all();
    (0, fixtures_1.check)("preset bank accounts seeded", accts.length === 4, `(got ${accts.length})`);
    (0, fixtures_1.check)("first preset is Temerev/Postfinance", accts[0]?.holder === "Alexander Temerev"
        && accts[0]?.bank === "Postfinance");
    const con2 = db.connect(dbfile);
    const n = con2.prepare("SELECT COUNT(*) c FROM bank_accounts").get().c;
    con2.close();
    (0, fixtures_1.check)("reconnect does not reseed accounts", n === 4, `(got ${n})`);
    // IBAN integrity on save (Api against this temp db)
    configMod.dbPath = () => dbfile;
    const { Api } = await import("../api/api.js");
    const api = new Api();
    api.save_bank_account({ id: 1, holder: "Alexander Temerev",
        bank: "Postfinance",
        iban: "ch93 0076 2011 6238 5295 7" });
    const saved = api.list_bank_accounts()[0].iban;
    (0, fixtures_1.check)("valid IBAN normalized to compact uppercase", saved === "CH9300762011623852957", `(got ${saved})`);
    let threw = false;
    try {
        api.save_bank_account({ id: 1, holder: "X",
            iban: "CH94 0076 2011 6238 5295 7" });
    }
    catch {
        threw = true;
    }
    (0, fixtures_1.check)("bad-checksum IBAN rejected", threw);
    threw = false;
    try {
        api.save_bank_account({ id: 1, holder: "X", iban: "CH93" });
    }
    catch {
        threw = true;
    }
    (0, fixtures_1.check)("too-short IBAN rejected", threw);
    api.save_bank_account({ id: 1, holder: "Alexander Temerev",
        bank: "Postfinance", iban: "" });
    (0, fixtures_1.check)("empty IBAN allowed (stored NULL)", api.list_bank_accounts()[0].iban === null);
    // status() events fallback: an abort event (logged with batch=NULL)
    // must terminate every in-flight batch, else the aborted batch ghosts
    // as "processing" and the app sticks at "Aborting…"
    db.event(api.con, "batch-start", "ingesting 3 page(s)", { batch: "testbatch-abort" });
    let st = await api.status();
    (0, fixtures_1.check)("batch-start shows in processing fallback", st.processing.some((p) => p.batch === "testbatch-abort"));
    db.event(api.con, "abort", "scan aborted from the app");
    st = await api.status();
    (0, fixtures_1.check)("abort event clears the in-flight batch", !st.processing.some((p) => p.batch === "testbatch-abort"));
    db.event(api.con, "batch-start", "ingesting 2 page(s)", { batch: "testbatch-after" });
    st = await api.status();
    (0, fixtures_1.check)("batch started after an abort still shows", st.processing.some((p) => p.batch === "testbatch-after"));
    db.event(api.con, "document", "filed", { batch: "testbatch-after" });
    api.con.close();
    // paying with an account and a value date records both, chain-wide;
    // reopen clears them
    const remA = con.prepare("SELECT id FROM invoices WHERE document_id=?").get(d2).id;
    invoices.markPaid(con, remA, { accountId: accts[0].id,
        paidDate: "2026-07-20" });
    const paid = con.prepare("SELECT * FROM invoices WHERE id IN (?,?)").all(invA, remA);
    (0, fixtures_1.check)("payment date and account stored on the whole chain", paid.every((r) => r.status === "paid" && r.paid_at === "2026-07-20"
        && r.paid_account_id === accts[0].id));
    invoices.reopen(con, invA);
    let row = con.prepare("SELECT * FROM invoices WHERE id=?")
        .get(invA);
    (0, fixtures_1.check)("reopen clears payment date and account", row.status === "open" && row.paid_at === null
        && row.paid_account_id === null);
    // do-not-pay (settled elsewhere): voids the whole chain with the
    // comment, drops out of unpaid money, reopen restores
    invoices.markDoNotPay(con, remA, "paid by employer");
    row = con.prepare("SELECT * FROM invoices WHERE id=?").get(invA);
    (0, fixtures_1.check)("do-not-pay voids the whole chain with the comment", row.status === "void" && row.paid_note === "paid by employer"
        && row.paid_at !== null && row.paid_account_id === null);
    (0, fixtures_1.check)("do-not-pay chain leaves the unpaid list", invoices.listInvoices(con, { status: "unpaid" })
        .every((r) => r.id !== invA));
    invoices.reopen(con, remA);
    row = con.prepare("SELECT * FROM invoices WHERE id=?").get(invA);
    (0, fixtures_1.check)("reopen restores a do-not-pay chain", row.status === "open" && row.paid_note === null);
    con.close();
    fs.rmSync(td, { recursive: true, force: true });
    (0, fixtures_1.finish)();
}
void main().catch((e) => { console.error(e); process.exit(1); });
