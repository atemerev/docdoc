"use strict";
// The renderer-facing API facade. Method names and result shapes match
// what the renderer calls through the preload bridge; runs in-process in
// the Electron main process (no external API server).
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
exports.Api = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const qrbill_1 = require("../domain/qrbill");
const textsim_1 = require("../domain/textsim");
const config = __importStar(require("../infra/config"));
const db = __importStar(require("../infra/db"));
const qrcodec_1 = require("../infra/qrcodec");
const invoices = __importStar(require("../services/invoices"));
const scanner = __importStar(require("../services/scanner"));
const watcher = __importStar(require("../services/watcher"));
const execFileP = (0, util_1.promisify)(child_process_1.execFile);
class Api {
    cfg;
    con;
    constructor() {
        this.cfg = config.load();
        this.con = db.connect();
    }
    // -- documents ---------------------------------------------------------
    search({ q = "", limit = 100 } = {}) {
        return db.search(this.con, String(q), Number(limit));
    }
    list_documents({ doc_type = null, sender_id = null, year = null, inbox = false, limit = 200, offset = 0 } = {}) {
        const where = ["d.status != 'trash'"];
        const args = [];
        if (doc_type) {
            where.push("d.doc_type = ?");
            args.push(doc_type);
        }
        if (sender_id) {
            where.push("d.sender_id = ?");
            args.push(sender_id);
        }
        if (year) {
            where.push("substr(COALESCE(d.doc_date, d.created_at),1,4) = ?");
            args.push(String(year));
        }
        if (inbox)
            where.push("d.reviewed = 0");
        return this.con.prepare(`SELECT d.id, d.created_at, d.doc_date, d.title, d.doc_type,
              d.sender_id, d.sender_name, d.language, d.summary,
              d.tags, d.pages, d.batch, d.reviewed, d.duplicate_of,
              d.dup_reason, d.amount, d.currency, d.due_date,
              d.invoice_ref, d.flags, d.thumb_path, d.pending
       FROM documents d WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(d.doc_date, d.created_at) DESC, d.id DESC
       LIMIT ? OFFSET ?`).all(...args, limit, offset);
    }
    get_document({ id }) {
        const doc = this.con.prepare("SELECT * FROM documents WHERE id=?")
            .get(id);
        if (!doc)
            throw new Error(`no document ${id}`);
        const d = { ...doc };
        d.pdf_abs = doc.pdf_path
            ? path.join(this.cfg.data_root, "archive", doc.pdf_path) : null;
        d.pages_detail = this.con.prepare(`SELECT page_no, scan_order, is_blank, marker,
              substr(text,1,400) AS text_head
       FROM pages WHERE document_id=? ORDER BY COALESCE(page_no, 999),
       scan_order`).all(id);
        const inv = this.con.prepare("SELECT * FROM invoices WHERE document_id=?").get(id);
        if (inv) {
            const invOut = { ...inv };
            if (inv.paid_account_id) {
                const acc = this.con.prepare("SELECT holder, bank FROM bank_accounts WHERE id=?").get(inv.paid_account_id);
                if (acc)
                    invOut.paid_account =
                        [acc.holder, acc.bank].filter(Boolean).join(", ");
            }
            const ids = invoices.chainIds(this.con, inv.id);
            invOut.chain = this.con.prepare(`SELECT i.*, dd.title AS doc_title, dd.id AS doc_id
         FROM invoices i JOIN documents dd ON dd.id=i.document_id
         WHERE i.id IN (${ids.join(",")}) ORDER BY i.reminder_level`).all();
            d.invoice = invOut;
        }
        else {
            d.invoice = null;
        }
        d.duplicates = this.con.prepare("SELECT id FROM documents WHERE duplicate_of=?").all(id).map((r) => r.id);
        d.refs = this.con.prepare("SELECT kind, value FROM doc_refs WHERE document_id=?").all(id);
        d.related = db.relatedDocuments(this.con, id);
        d.timeline = this.timeline({ id });
        return d;
    }
    /**
     * All dated happenings around a document: its own dates, dates of
     * other documents it mentions, its invoice chain, related documents.
     */
    timeline({ id }) {
        const doc = this.con.prepare("SELECT * FROM documents WHERE id=?")
            .get(id);
        if (!doc)
            return [];
        const ev = [];
        const add = (date, label, kind, docId = null) => {
            if (date)
                ev.push({ date: String(date).slice(0, 10), label, kind,
                    document_id: docId });
        };
        add(doc.doc_date, doc.title || doc.doc_type || "", "self", id);
        add(doc.created_at, "scanned", "scan", id);
        try {
            const ai = JSON.parse(doc.ai_json || "{}");
            for (const rd of ai.ref_dates ?? [])
                add(rd.date, rd.label || "mentioned date", "mentioned", id);
        }
        catch { /* ai_json unreadable */ }
        const inv = this.con.prepare("SELECT * FROM invoices WHERE document_id=?").get(id);
        if (inv) {
            for (const cid of invoices.chainIds(this.con, inv.id)) {
                const m = this.con.prepare(`SELECT i.*, dd.doc_date AS ddate, dd.title AS dtitle,
                  dd.id AS did FROM invoices i
           JOIN documents dd ON dd.id = i.document_id
           WHERE i.id=?`).get(cid);
                const label = m.reminder_level === 0
                    ? "invoice" : `reminder ${m.reminder_level}`;
                if (m.did !== id)
                    add(m.ddate, `${label}: ${m.dtitle || ""}`.trim(), "chain", m.did);
                add(m.due_date, `due (${label})`, "due", m.did);
                if (m.paid_at)
                    add(m.paid_at, m.status === "paid" ? "paid" : "do not pay", "paid", m.did);
            }
        }
        for (const r of db.relatedDocuments(this.con, id))
            add(r.doc_date || r.created_at, `${r.doc_type}: ${r.title || ""} (${r.kind} ${r.value})`, "related", r.id);
        // dedup identical entries, sort chronologically
        const seen = new Set();
        const out = [];
        for (const e of ev.sort((a, b) => a.date.localeCompare(b.date))) {
            const key = `${e.date}\x00${e.label}\x00${e.document_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                out.push(e);
            }
        }
        return out;
    }
    update_document({ id, ...fields }) {
        const allowed = new Set(["title", "doc_type", "doc_date", "recipient",
            "summary", "reviewed", "amount", "currency",
            "due_date", "invoice_ref"]);
        const sets = [];
        const args = [];
        for (const [k, v] of Object.entries(fields)) {
            if (allowed.has(k)) {
                sets.push(`${k}=?`);
                args.push(v);
            }
            else if (k === "tags") {
                const tags = (v || [])
                    .map((t) => String(t).trim().toLowerCase()).filter(Boolean);
                sets.push("tags=?", "tags_text=?");
                args.push(JSON.stringify(tags), (0, textsim_1.fold)(tags.join(" ")));
            }
            else if (k === "sender_name") {
                const name = v;
                const sid = name
                    ? db.upsertSender(this.con, (0, textsim_1.slugify)(name), name) : null;
                sets.push("sender_id=?", "sender_name=?");
                args.push(sid, (0, textsim_1.fold)(name || ""));
            }
        }
        if (sets.length)
            this.con.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id=?`).run(...args, id);
        return this.get_document({ id });
    }
    trash_document({ id }) {
        this.con.prepare("UPDATE documents SET status='trash' WHERE id=?").run(id);
        return true;
    }
    // -- senders / invoices -------------------------------------------------
    list_senders() {
        return this.con.prepare(`SELECT s.*, COUNT(d.id) AS doc_count,
              MAX(COALESCE(d.doc_date, d.created_at)) AS last_doc
       FROM senders s LEFT JOIN documents d
            ON d.sender_id = s.id AND d.status != 'trash'
       GROUP BY s.id ORDER BY doc_count DESC`).all();
    }
    list_invoices({ status = null } = {}) {
        return invoices.listInvoices(this.con, { status: status === "all" ? null : status });
    }
    invoice_paid({ id, note = null, account_id = null, paid_date = null }) {
        invoices.markPaid(this.con, id, { note, accountId: account_id, paidDate: paid_date });
        return true;
    }
    invoice_do_not_pay({ id, note = null }) {
        invoices.markDoNotPay(this.con, id, note);
        return true;
    }
    invoice_reopen({ id }) {
        invoices.reopen(this.con, id);
        return true;
    }
    // -- bank accounts ------------------------------------------------------
    list_bank_accounts() {
        return this.con.prepare("SELECT * FROM bank_accounts ORDER BY id")
            .all();
    }
    save_bank_account({ id = null, holder = null, bank = null, iban = null } = {}) {
        holder = (holder || "").trim();
        bank = (bank || "").trim();
        iban = (iban || "").trim();
        if (!holder)
            throw new Error("account holder is required");
        if (iban) {
            // stored compact uppercase (like senders.iban); UI regroups by 4
            iban = iban.replace(/\s+/g, "").toUpperCase();
            if (!(iban.length >= 15 && iban.length <= 34 && (0, qrbill_1.ibanValid)(iban)))
                throw new Error(`not a valid IBAN: ${iban}`);
        }
        if (id)
            this.con.prepare("UPDATE bank_accounts SET holder=?, bank=?, iban=? WHERE id=?").run(holder, bank || null, iban || null, id);
        else
            this.con.prepare("INSERT INTO bank_accounts(holder, bank, iban) VALUES (?,?,?)").run(holder, bank || null, iban || null);
        return this.list_bank_accounts();
    }
    delete_bank_account({ id }) {
        // past payments keep their row but drop the link (ON DELETE SET NULL)
        this.con.prepare("DELETE FROM bank_accounts WHERE id=?").run(id);
        return true;
    }
    /**
     * Swiss QR as data-URI PNG with the Swiss-cross overlay, for paying by
     * scanning the screen with a banking app.
     */
    async render_qr({ invoice_id }) {
        const row = this.con.prepare("SELECT qr_payload, amount, amount_due FROM invoices WHERE id=?").get(invoice_id);
        if (!row?.qr_payload)
            throw new Error("no QR payload stored for this invoice");
        let payload = row.qr_payload;
        // after reminders the amount due includes fees -- update the SPC
        // amount line so the banking app prefills what is actually owed
        if (row.amount_due && row.amount &&
            Math.abs(row.amount_due - row.amount) >= 0.01) {
            const nl = payload.includes("\r\n") ? "\r\n" : "\n";
            const lines = payload.split(nl);
            if (lines.length > 19) {
                lines[18] = row.amount_due.toFixed(2);
                payload = lines.join(nl);
            }
        }
        const png = await (0, qrcodec_1.renderQrPng)(payload);
        return "data:image/png;base64," + png.toString("base64");
    }
    // -- misc ---------------------------------------------------------------
    async _pgrep(pattern) {
        try {
            const { stdout } = await execFileP("pgrep", ["-f", pattern]);
            return stdout.split(/\s+/).filter(Boolean).map(Number);
        }
        catch {
            return [];
        }
    }
    async scan_now() {
        return scanner.scanNow();
    }
    /**
     * The app's Abort button: stop everything in flight and delete all
     * temp scans. Covers the scan in progress, the background
     * understanding queue, and whatever is waiting/queued on disk. Fully
     * processed documents are untouched.
     */
    async abort_scan() {
        const sd = this.cfg.scans_dir;
        const tmpdir = path.join(this.cfg.data_root, "tmp");
        scanner.abort();
        watcher.abort();
        await new Promise((r) => setTimeout(r, 1500));
        const removed = [];
        if (fs.existsSync(sd)) {
            for (const name of fs.readdirSync(sd).sort()) {
                const p = path.join(sd, name);
                if (fs.statSync(p).isDirectory() && !name.startsWith(".")) {
                    fs.rmSync(p, { recursive: true, force: true });
                    removed.push(name);
                }
            }
            try {
                fs.unlinkSync(path.join(sd, ".scanning"));
            }
            catch { /* absent */ }
        }
        if (fs.existsSync(tmpdir)) {
            for (const name of fs.readdirSync(tmpdir)) {
                const p = path.join(tmpdir, name);
                if (name.endsWith(".progress.json")) {
                    try {
                        fs.unlinkSync(p);
                    }
                    catch { /* raced */ }
                }
                else if (fs.statSync(p).isDirectory()) {
                    fs.rmSync(p, { recursive: true, force: true });
                }
            }
        }
        // a batch may have been picked up during the sleep -- abort again
        // now that the batch dirs are gone
        watcher.abort();
        db.event(this.con, "abort", "scan aborted from the app"
            + (removed.length
                ? ` -- deleted ${removed.length} batch(es): ${removed.join(", ")}`
                : ""));
        return { removed_batches: removed };
    }
    /** In-flight scanner/pipeline activity for the UI progress strip. */
    async status() {
        const sd = this.cfg.scans_dir;
        const tmpdir = path.join(this.cfg.data_root, "tmp");
        const now = Date.now();
        const scanning = [];
        const flag = path.join(sd, ".scanning");
        try {
            const st = fs.statSync(flag);
            if (now - st.mtimeMs < 900000) {
                const name = fs.readFileSync(flag, "utf-8").trim() || "scan";
                let pages = 0;
                try {
                    pages = fs.readdirSync(path.join(sd, name))
                        .filter((x) => !x.startsWith(".")).length;
                }
                catch { /* dir not there yet */ }
                scanning.push({ batch: name, pages });
            }
        }
        catch { /* no scan in progress */ }
        const scanningNames = new Set(scanning.map((s) => s.batch));
        const processing = [];
        if (fs.existsSync(tmpdir)) {
            for (const f of fs.readdirSync(tmpdir)) {
                if (!f.endsWith(".progress.json"))
                    continue;
                const p = path.join(tmpdir, f);
                try {
                    if (now - fs.statSync(p).mtimeMs > 900000)
                        continue;
                    const prog = JSON.parse(fs.readFileSync(p, "utf-8"));
                    processing.push({ batch: f.slice(0, -".progress.json".length),
                        label: prog.label ?? null, pct: prog.pct ?? null,
                        ceil: prog.ceil ?? null });
                }
                catch { /* torn write */ }
            }
        }
        let progNames = new Set(processing.map((p) => p.batch));
        // the background understanding queue: ingested documents whose
        // OCR/AI has not run yet (the active one has a progress file)
        const pending = this.con.prepare("SELECT id, batch FROM documents WHERE pending='queued' ORDER BY id").all()
            .map((r) => r.batch || `#${r.id}`);
        const pendingQueued = pending.filter((b) => !progNames.has(b));
        // fallback: batch-start event without a terminal event -- an abort
        // (logged with batch=NULL) terminates every started batch
        const cutoff = new Date(now - 30 * 60000).toISOString().slice(0, 19);
        const state = new Map();
        for (const r of this.con.prepare(`SELECT batch, kind FROM events
         WHERE (batch IS NOT NULL OR kind='abort') AND at > ?
         ORDER BY id`).all(cutoff)) {
            if (r.kind === "abort")
                for (const b of state.keys())
                    state.set(b, false);
            else if (r.kind === "batch-start")
                state.set(r.batch, true);
            else if (["document", "error"].includes(r.kind))
                state.set(r.batch, false);
        }
        for (const [b, v] of state)
            if (v && !progNames.has(b) && !pendingQueued.includes(b))
                processing.push({ batch: b, label: null, pct: null, ceil: null });
        progNames = new Set(processing.map((p) => p.batch));
        const waiting = [], queued = [];
        if (fs.existsSync(sd)) {
            for (const name of fs.readdirSync(sd).sort()) {
                const p = path.join(sd, name);
                let isDir = false;
                try {
                    isDir = fs.statSync(p).isDirectory();
                }
                catch { /* raced */ }
                if (!isDir || name.startsWith(".")
                    || scanningNames.has(name) || progNames.has(name))
                    continue;
                if (fs.existsSync(path.join(p, ".batch-done")))
                    queued.push(name);
                else
                    waiting.push(name);
            }
        }
        queued.push(...pendingQueued);
        return {
            scanning, waiting, queued, processing,
            watcher_alive: watcher.alive(),
            scanner_alive: scanner.available(),
            scanner_online: await scanner.online(),
            busy: Boolean(scanning.length || waiting.length || queued.length
                || processing.length),
        };
    }
    list_events({ limit = 100 } = {}) {
        return this.con.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
            .all(limit);
    }
    stats() {
        const one = (sql) => this.con.prepare(sql).get();
        const docs = one("SELECT COUNT(*) c FROM documents WHERE status!='trash'").c;
        const inbox = one("SELECT COUNT(*) c FROM documents WHERE status!='trash' AND reviewed=0").c;
        // one count per chain root (original invoice OR orphan reminder --
        // a reminder whose original was never scanned is still unpaid money)
        const unpaid = one(`SELECT COUNT(*) c, COALESCE(SUM(i.amount_due),0) s
       FROM invoices i JOIN documents d ON d.id = i.document_id
       WHERE i.status IN ('open','reminded')
         AND i.parent_invoice_id IS NULL
         AND i.is_notification=0 AND d.status != 'trash'`);
        const overdue = one(`SELECT COUNT(*) c
       FROM invoices i JOIN documents d ON d.id = i.document_id
       WHERE i.status IN ('open','reminded')
         AND i.parent_invoice_id IS NULL
         AND i.is_notification=0 AND d.status != 'trash'
         AND i.due_date < date('now')`).c;
        const types = this.con.prepare(`SELECT doc_type, COUNT(*) n FROM documents WHERE status!='trash'
       GROUP BY doc_type ORDER BY n DESC`).all();
        return { documents: docs, inbox, unpaid_count: unpaid.c,
            unpaid_total: unpaid.s, overdue, types };
    }
    get_settings() {
        return this.cfg;
    }
    set_settings(kv = {}) {
        const cfg = config.load();
        for (const [k, v] of Object.entries(kv))
            if (k in config.DEFAULTS)
                cfg[k] = v;
        config.save(cfg);
        this.cfg = config.load();
        return this.cfg;
    }
    years() {
        return this.con.prepare(`SELECT DISTINCT substr(COALESCE(doc_date, created_at),1,4) y
       FROM documents WHERE status!='trash' ORDER BY 1 DESC`).all().map((r) => r.y);
    }
}
exports.Api = Api;
