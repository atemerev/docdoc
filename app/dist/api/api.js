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
const os = __importStar(require("os"));
const qrbill_1 = require("../domain/qrbill");
const textsim_1 = require("../domain/textsim");
const config = __importStar(require("../infra/config"));
const metadata_model_1 = require("../services/metadata_model");
const db = __importStar(require("../infra/db"));
const qrcodec_1 = require("../infra/qrcodec");
const invoices = __importStar(require("../services/invoices"));
const scanner = __importStar(require("../services/scanner"));
const processing_queue_1 = require("../services/processing_queue");
const workbench = __importStar(require("../services/pipeline"));
const storage = __importStar(require("../infra/storage"));
const exec_1 = require("../infra/exec");
const metadata_history_1 = require("../infra/metadata_history");
const document_dates_1 = require("../domain/document_dates");
const types_1 = require("../domain/types");
const pdf_metadata_1 = require("../infra/pdf_metadata");
const pdf_export_1 = require("../services/pdf_export");
class Api {
    cfg;
    con;
    constructor() {
        this.cfg = config.load();
        this.con = db.connect(config.dbPath(this.cfg));
        storage.init(this.con);
        this.queue = new processing_queue_1.ProcessingQueue(this.con, () => this.cfg, () => this.onStatus());
    }
    queue;
    activeScope = null;
    busy = false;
    label = "Ready";
    processing = null;
    active = null;
    onStatus = () => { };
    async initialize() {
        await storage.migrateFiles(this.con, this.cfg);
        this.cfg = {
            ...this.cfg,
            ...storage.setting(this.con, "config"),
            data_root: this.cfg.data_root,
        };
        this.queue.resume();
    }
    async foreground(label, action) {
        if (this.busy)
            throw new Error("Wait for the current operation, or stop it first.");
        this.busy = true;
        const scope = new exec_1.ExecutionScope();
        this.activeScope = scope;
        this.progress(label);
        const task = (0, exec_1.inScope)(scope, action);
        this.active = task;
        try {
            return await task;
        }
        finally {
            await (0, exec_1.finishAbort)(scope);
            this.busy = false;
            this.active = null;
            this.activeScope = null;
            this.progress("Ready");
        }
    }
    progress = (label, processing) => {
        this.label = label;
        this.processing = processing || null;
        this.onStatus();
    };
    async shutdown() {
        if (this.activeScope)
            (0, exec_1.requestAbort)(this.activeScope);
        const queueStopped = this.queue.stop();
        try {
            await this.active;
        }
        catch {
            /* durable work is preserved */
        }
        await queueStopped;
        this.con.close();
    }
    assertIdle() {
        if (this.busy)
            throw new Error("An operation is in progress. Please wait or stop it.");
    }
    // -- documents ---------------------------------------------------------
    search({ q = "", limit = 100 } = {}) {
        return db.search(this.con, String(q), Number(limit));
    }
    list_documents({ doc_type = null, sender_id = null, year = null, inbox = false, limit = 200, offset = 0, sort = "document", q = "", } = {}) {
        const where = ["d.status != 'trash'"];
        const args = [];
        if (q) {
            const matches = db.search(this.con, String(q), 10000);
            if (!matches.length)
                return [];
            where.push(`d.id IN (${matches.map(() => "?").join(",")})`);
            args.push(...matches.map((d) => d.id));
        }
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
        return this.con
            .prepare(`SELECT d.id, d.created_at, d.scanned_at, d.scan_date_source, d.case_opened_date, d.doc_date, d.title, d.doc_type,
              d.sender_id, d.sender_name, d.language, d.summary,
              d.tags, d.pages, d.batch, d.reviewed, d.duplicate_of,
              d.dup_reason, d.amount, d.currency, d.due_date,
              d.invoice_ref, d.flags, d.thumb_path, d.pending
       FROM documents d WHERE ${where.join(" AND ")}
       ORDER BY ${sort === "scan" ? "COALESCE(d.scanned_at,d.created_at)" : "COALESCE(d.doc_date,d.scanned_at,d.created_at)"} DESC, d.id DESC
       LIMIT ? OFFSET ?`)
            .all(...args, limit, offset);
    }
    library_groups(params = {}) {
        const docs = this.list_documents({ ...params, limit: 500 });
        const edges = this.con.prepare(`
      SELECT DISTINCT r.document_id a,s.document_id b,r.kind || ': ' || r.value reason
      FROM doc_refs r JOIN doc_refs s ON s.kind=r.kind AND s.norm=r.norm AND s.document_id>r.document_id
      JOIN documents a ON a.id=r.document_id JOIN documents b ON b.id=s.document_id
      WHERE a.status!='trash' AND b.status!='trash'
      UNION SELECT l.a,l.b,'Linked documents' FROM document_links l
      JOIN documents a ON a.id=l.a JOIN documents b ON b.id=l.b WHERE a.status!='trash' AND b.status!='trash'
      UNION SELECT i.document_id,p.document_id,'Invoice and reminder' FROM invoices i
      JOIN invoices p ON p.id=i.parent_invoice_id
      JOIN documents a ON a.id=i.document_id JOIN documents b ON b.id=p.document_id
      WHERE a.status!='trash' AND b.status!='trash'
    `).all();
        const parent = new Map();
        const root = (id) => {
            if (!parent.has(id))
                parent.set(id, id);
            let r = id;
            while (parent.get(r) !== r)
                r = parent.get(r);
            let n = id;
            while (parent.get(n) !== r) {
                const next = parent.get(n);
                parent.set(n, r);
                n = next;
            }
            return r;
        };
        for (const edge of edges)
            parent.set(root(edge.b), root(edge.a));
        const grouped = new Map();
        for (const doc of docs) {
            const key = root(doc.id);
            if (!grouped.has(key))
                grouped.set(key, []);
            grouped.get(key).push(doc);
        }
        return [...grouped].map(([id, documents]) => ({ id, documents,
            relationships: edges.filter((e) => documents.some((d) => d.id === e.a || d.id === e.b)),
        }));
    }
    document_sources({ id }) {
        const doc = this.con
            .prepare("SELECT batch FROM documents WHERE id=?")
            .get(id);
        if (!doc)
            throw new Error("Document not found.");
        const legacy = doc.batch
            ? `legacy/originals/${doc.batch}/`
            : "no-legacy-source/";
        const sources = this.con
            .prepare(`SELECT DISTINCT a.key, length(b.data) AS bytes FROM assets a JOIN blobs b USING(sha)
      WHERE a.key IN (SELECT source_key FROM review_pages WHERE document_id=?)
      OR a.key IN (SELECT i.source_key FROM imports i JOIN review_groups g ON g.id=i.group_id WHERE g.target_id=?)
      OR substr(a.key,1,?)=? OR a.key LIKE ? ORDER BY a.key`)
            .all(id, id, legacy.length, legacy, `revision/${id}/%`);
        return sources.filter((source) => source.key.startsWith("revision/") ||
            /\.(pdf|jpe?g|png|tiff?|pnm)$/i.test(source.key));
    }
    recover_source({ id, key }) {
        if (!this.document_sources({ id }).some((s) => s.key === key))
            throw new Error("Source does not belong to this document.");
        return this.foreground("Preparing original source", async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-recover-"));
            try {
                const file = path.join(dir, key.startsWith("revision/")
                    ? "previous-version.pdf"
                    : path.basename(key));
                fs.writeFileSync(file, storage.get(this.con, key).data);
                const groupId = workbench.queueFiles(this.con, [file], `Source from document #${id}`);
                await workbench.prepareGroup(this.con, groupId, this.progress);
                return groupId;
            }
            finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
    get_document({ id }) {
        const doc = this.con
            .prepare("SELECT * FROM documents WHERE id=?")
            .get(id);
        if (!doc)
            throw new Error(`no document ${id}`);
        const d = { ...doc };
        d.sources = this.document_sources({ id });
        d.pdf_abs = null;
        d.has_pdf = storage.has(this.con, storage.docKey(id));
        d.pages_detail = this.con
            .prepare(`SELECT page_no, scan_order, is_blank, marker,
              substr(text,1,400) AS text_head
       FROM pages WHERE document_id=? ORDER BY COALESCE(page_no, 999),
       scan_order`)
            .all(id);
        const inv = this.con
            .prepare("SELECT * FROM invoices WHERE document_id=?")
            .get(id);
        if (inv) {
            const invOut = { ...inv };
            if (inv.paid_account_id) {
                const acc = this.con
                    .prepare("SELECT holder, bank FROM bank_accounts WHERE id=?")
                    .get(inv.paid_account_id);
                if (acc)
                    invOut.paid_account = [acc.holder, acc.bank]
                        .filter(Boolean)
                        .join(", ");
            }
            const ids = invoices.chainIds(this.con, inv.id);
            invOut.chain = this.con
                .prepare(`SELECT i.*, dd.title AS doc_title, dd.id AS doc_id
         FROM invoices i JOIN documents dd ON dd.id=i.document_id
         WHERE i.id IN (${ids.join(",")}) ORDER BY i.reminder_level`)
                .all();
            d.invoice = invOut;
        }
        else {
            d.invoice = null;
        }
        d.duplicates = this.con
            .prepare("SELECT id FROM documents WHERE duplicate_of=?")
            .all(id).map((r) => r.id);
        d.refs = this.con
            .prepare("SELECT kind, value, page, evidence FROM doc_refs WHERE document_id=?")
            .all(id);
        d.related = [
            ...db.relatedDocuments(this.con, id),
            ...this.con
                .prepare(`SELECT d.id,d.title,d.doc_type,d.doc_date,d.created_at,'verified link' AS kind,'' AS value
       FROM document_links l JOIN documents d ON d.id=CASE WHEN l.a=? THEN l.b ELSE l.a END
       WHERE (l.a=? OR l.b=?) AND d.status!='trash'`)
                .all(id, id, id),
        ];
        d.review_history = this.con
            .prepare("SELECT at,note,checks FROM review_log WHERE document_id=? ORDER BY id DESC")
            .all(id);
        d.timeline = this.timeline({ id });
        let extracted = {};
        try {
            extracted = JSON.parse(doc.ai_json || "{}");
        }
        catch {
            /* legacy extraction may be incomplete */
        }
        d.recognition = {
            dates: extracted.ref_dates || [],
            date_evidence: extracted.date_evidence || null,
            pursuit: extracted.pursuit || null,
            case_handler: extracted.case_handler || null,
            source: extracted.metadata_source || "Local OCR",
            warning: extracted.metadata_warning || null,
        };
        d.metadata_history = this.metadata_history({ id });
        return d;
    }
    /**
     * All dated happenings around a document: its own dates, dates of
     * other documents it mentions, its invoice chain, related documents.
     */
    timeline({ id }) {
        const doc = this.con
            .prepare("SELECT * FROM documents WHERE id=?")
            .get(id);
        if (!doc)
            return [];
        const ev = [];
        const add = (date, label, kind, docId = null) => {
            if (date)
                ev.push({
                    date: String(date).slice(0, 10),
                    label,
                    kind,
                    document_id: docId,
                });
        };
        add(doc.doc_date, doc.title || doc.doc_type || "", "self", id);
        add(doc.scanned_at || doc.created_at, doc.scan_date_source === "legacy_recorded_at"
            ? "Scan recorded (legacy timestamp)"
            : "Scanned / imported", "scan", id);
        add(doc.case_opened_date, "Case initiated", "case_opened", id);
        try {
            const ai = JSON.parse(doc.ai_json || "{}");
            for (const rd of ai.ref_dates ?? [])
                add(rd.date, rd.label || "mentioned date", rd.kind || "mentioned", id);
        }
        catch {
            /* ai_json unreadable */
        }
        const inv = this.con
            .prepare("SELECT * FROM invoices WHERE document_id=?")
            .get(id);
        if (inv) {
            for (const cid of invoices.chainIds(this.con, inv.id)) {
                const m = this.con
                    .prepare(`SELECT i.*, dd.doc_date AS ddate, dd.title AS dtitle,
                  dd.id AS did FROM invoices i
           JOIN documents dd ON dd.id = i.document_id
           WHERE i.id=?`)
                    .get(cid);
                const label = m.reminder_level === 0 ? "invoice" : `reminder ${m.reminder_level}`;
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
        return this.foreground("Saving document changes", async () => {
            const allowed = new Set([
                "title",
                "doc_type",
                "doc_date",
                "case_opened_date",
                "recipient",
                "summary",
                "amount",
                "currency",
                "due_date",
                "invoice_ref",
            ]);
            const sets = [];
            const args = [];
            for (const [k, v] of Object.entries(fields)) {
                if (allowed.has(k)) {
                    if ((k === "doc_date" || k === "case_opened_date") &&
                        v !== null &&
                        !(0, document_dates_1.validDate)(v))
                        throw new Error("Use a valid calendar date.");
                    if (k === "doc_type" && !types_1.DOC_TYPES.includes(v))
                        throw new Error("Unknown document type.");
                    sets.push(`${k}=?`);
                    args.push(v);
                }
                else if (k === "tags") {
                    const tags = (v || [])
                        .map((t) => String(t).trim().toLowerCase())
                        .filter(Boolean);
                    sets.push("tags=?", "tags_text=?");
                    args.push(JSON.stringify(tags), (0, textsim_1.fold)(tags.join(" ")));
                }
                else if (k === "sender_name") {
                    const name = v;
                    const sid = name
                        ? db.upsertSender(this.con, (0, textsim_1.slugify)(name), name)
                        : null;
                    sets.push("sender_id=?", "sender_name=?");
                    const canonical = sid
                        ? this.con
                            .prepare("SELECT name FROM senders WHERE id=?")
                            .get(sid).name
                        : null;
                    args.push(sid, canonical);
                }
            }
            if (sets.length)
                this.con.transaction(() => {
                    (0, metadata_history_1.recordMetadata)(this.con, id, "Before manual correction");
                    this.con
                        .prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id=?`)
                        .run(...args, id);
                    (0, metadata_history_1.recordMetadata)(this.con, id, "Manual metadata correction");
                })();
            const review = this.con
                .prepare("SELECT id FROM review_groups WHERE target_id=?")
                .get(id);
            if (review) {
                const values = {};
                for (const key of [
                    "title",
                    "sender_name",
                    "doc_type",
                    "doc_date",
                    "case_opened_date",
                ])
                    if (key in fields)
                        values[key] = fields[key];
                if (Object.keys(values).length)
                    workbench.updateMetadata(this.con, review.id, values);
            }
            await (0, pdf_metadata_1.enrichStoredPdf)(this.con, id);
            return this.get_document({ id });
        });
    }
    async trash_document({ id }) {
        const review = this.con
            .prepare("SELECT id FROM review_groups WHERE target_id=?")
            .get(id);
        if (review) {
            await this.queue.editPages(review.id);
            workbench.deleteReview(this.con, review.id);
        }
        this.con.prepare("UPDATE documents SET status='trash' WHERE id=?").run(id);
        return true;
    }
    // -- senders / invoices -------------------------------------------------
    list_senders() {
        return this.con
            .prepare(`SELECT s.*, COUNT(d.id) AS doc_count,
              MAX(COALESCE(d.doc_date, d.created_at)) AS last_doc
       FROM senders s LEFT JOIN documents d
            ON d.sender_id = s.id AND d.status != 'trash'
       GROUP BY s.id ORDER BY doc_count DESC`)
            .all();
    }
    list_invoices({ status = null } = {}) {
        return invoices.listInvoices(this.con, {
            status: status === "all" ? null : status,
        });
    }
    invoice_paid({ id, note = null, account_id = null, paid_date = null, }) {
        invoices.markPaid(this.con, id, {
            note,
            accountId: account_id,
            paidDate: paid_date,
        });
        return true;
    }
    invoice_do_not_pay({ id, note = null, }) {
        invoices.markDoNotPay(this.con, id, note);
        return true;
    }
    invoice_reopen({ id }) {
        invoices.reopen(this.con, id);
        return true;
    }
    // -- bank accounts ------------------------------------------------------
    list_bank_accounts() {
        return this.con
            .prepare("SELECT * FROM bank_accounts ORDER BY id")
            .all();
    }
    save_bank_account({ id = null, holder = null, bank = null, iban = null, } = {}) {
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
            this.con
                .prepare("UPDATE bank_accounts SET holder=?, bank=?, iban=? WHERE id=?")
                .run(holder, bank || null, iban || null, id);
        else
            this.con
                .prepare("INSERT INTO bank_accounts(holder, bank, iban) VALUES (?,?,?)")
                .run(holder, bank || null, iban || null);
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
        return this.foreground("Preparing payment QR", async () => {
            const row = this.con
                .prepare("SELECT qr_payload, amount, amount_due FROM invoices WHERE id=?")
                .get(invoice_id);
            if (!row?.qr_payload)
                throw new Error("no QR payload stored for this invoice");
            let payload = row.qr_payload;
            // after reminders the amount due includes fees -- update the SPC
            // amount line so the banking app prefills what is actually owed
            if (row.amount_due &&
                row.amount &&
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
        });
    }
    // -- foreground capture and collation ----------------------------------
    get_workbench() {
        return workbench.workbench(this.con);
    }
    metadata_history({ id }) {
        return this.con
            .prepare("SELECT id,valid_from,valid_to,recorded_from,recorded_to,source,snapshot FROM document_metadata_versions WHERE document_id=? ORDER BY recorded_from DESC")
            .all(id);
    }
    metadata_as_of({ id, known_at, effective_on, }) {
        return (0, metadata_history_1.metadataAsOf)(this.con, id, known_at, effective_on);
    }
    refresh_document_metadata({ id }) {
        return this.foreground("Recognizing document details", async () => {
            this.progress("Matching references and interpreting document dates", {
                stage: "details",
            });
            await workbench.recognizeDocumentMetadata(this.cfg, this.con, id);
            await (0, pdf_metadata_1.enrichStoredPdf)(this.con, id);
            return this.get_document({ id });
        });
    }
    new_group({ title } = {}) {
        return workbench.newGroup(this.con, title);
    }
    rename_group({ id, title }) {
        return this.update_group_metadata({ id, values: { title } });
    }
    update_group_metadata({ id, values, }) {
        workbench.updateMetadata(this.con, id, values);
        return workbench.workbench(this.con).find((g) => g.id === id);
    }
    remove_empty_group({ id }) {
        workbench.removeEmptyGroup(this.con, id);
    }
    edit_page(p) {
        return this.foreground("Saving page changes", async () => {
            const source = this.con
                .prepare("SELECT group_id FROM review_pages WHERE id=?")
                .get(p.id);
            for (const id of new Set([source.group_id, p.group_id]))
                await this.queue.editPages(id);
            workbench.editPage(this.con, p.id, p.group_id, p.excluded);
        });
    }
    reorder_pages(p) {
        return this.foreground("Saving page order", async () => {
            await this.queue.editPages(p.id);
            workbench.reorder(this.con, p.id, p.pages);
            this.con.prepare("UPDATE review_groups SET manual_order=1 WHERE id=?").run(p.id);
        });
    }
    enqueue_group({ id }) {
        this.queue.enqueue(id);
        return id;
    }
    edit_group_pages({ id }) {
        return this.foreground("Opening page review", () => this.queue.editPages(id));
    }
    prepare_group({ id }) {
        return this.foreground("Preparing captured pages", async () => {
            await this.queue.editPages(id);
            await workbench.prepareGroup(this.con, id, this.progress);
        });
    }
    read_group({ id }) {
        return this.foreground("Queueing text recognition", async () => {
            await this.queue.editPages(id);
            this.con.prepare("UPDATE review_pages SET ocr_source=NULL WHERE group_id=? AND excluded=0").run(id);
            this.con.prepare("UPDATE review_groups SET split_done=0 WHERE id=?").run(id);
            this.queue.enqueue(id);
        });
    }
    recognize_group_details({ id }) {
        this.queue.enqueue(id);
    }
    file_group(input) {
        if (workbench.group(this.con, input.id).phase !== "ready")
            throw new Error("Wait until this document is ready to review before saving it to Library.");
        return this.foreground("Saving document", () => workbench.fileGroup(this.cfg, this.con, input, this.progress));
    }
    reopen_document({ id }) {
        return this.foreground("Preparing document for review", async () => {
            const existing = this.con.prepare("SELECT id FROM review_groups WHERE target_id=?").get(id);
            const groupId = await workbench.reopenDocument(this.con, id, this.progress);
            // Opening an existing active review must not steal it from the worker.
            if (!existing)
                this.con.prepare("UPDATE review_groups SET phase='ready' WHERE id=?").run(groupId);
            return groupId;
        });
    }
    delete_review({ id }) {
        return this.foreground("Removing scanned set", async () => {
            await this.queue.editPages(id);
            workbench.deleteReview(this.con, id);
            return true;
        });
    }
    backup_database(destination) {
        return this.foreground("Backing up database", () => storage.backup(this.con, destination));
    }
    async captureFiles(files, title, options = {}, issue = null, capturedAt) {
        const { group_id, after_page_id } = options;
        const old = group_id ? this.con.prepare("SELECT id FROM review_pages WHERE group_id=? ORDER BY position,id").all(group_id) : [];
        if (group_id)
            await this.queue.editPages(group_id);
        if (after_page_id != null && after_page_id !== 0 && !old.some((p) => p.id === after_page_id))
            throw new Error("Choose an insertion point in this scanned set.");
        const id = workbench.queueFiles(this.con, files, title, issue, group_id, capturedAt);
        if (!(0, exec_1.aborted)()) {
            await workbench.prepareGroup(this.con, id, this.progress);
            if (group_id && after_page_id != null) {
                const all = this.con.prepare("SELECT id FROM review_pages WHERE group_id=? ORDER BY position,id").all(id);
                const added = all.filter((p) => !old.some((o) => o.id === p.id));
                const at = after_page_id === 0 ? 0 : old.findIndex((p) => p.id === after_page_id) + 1;
                workbench.reorder(this.con, id, [...old.slice(0, at), ...added, ...old.slice(at)].map((p) => p.id));
                this.con.prepare("UPDATE review_groups SET manual_order=1 WHERE id=?").run(id);
            }
        }
        return id;
    }
    import_files(files, options = {}) {
        return this.foreground("Importing pages", () => this.captureFiles(files, files.length === 1 ? path.basename(files[0]) : "Imported pages", options));
    }
    scan_now(options = {}) {
        return this.foreground("Looking for scanner", async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-scan-"));
            const capturedAt = new Date().toISOString();
            try {
                if (options.group_id)
                    workbench.group(this.con, options.group_id);
                if (options.after_page_id && !this.con.prepare("SELECT 1 FROM review_pages WHERE id=? AND group_id=?").get(options.after_page_id, options.group_id))
                    throw new Error("Choose an insertion point in this scanned set.");
                const result = await scanner.scan(dir, this.cfg.scanner_device, (n) => this.progress(`Scanning · ${n} captured pages`));
                return await this.captureFiles(result.files, `Scan ${new Date().toLocaleString()}`, options, (0, exec_1.aborted)() ? "Scan interrupted by user. Verify completeness." : result.warning, capturedAt);
            }
            finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    }
    discover_scanners() {
        return this.foreground("Looking for scanner", () => scanner.discover());
    }
    abort_scan() {
        if (this.activeScope)
            (0, exec_1.requestAbort)(this.activeScope);
        this.progress("Stopping · captured source files are kept");
    }
    status() {
        return { busy: this.busy, label: this.label, processing: this.processing, background: this.queue.current, queue_version: this.queue.version };
    }
    list_events({ limit = 100 } = {}) {
        return this.con
            .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
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
        const types = this.con
            .prepare(`SELECT doc_type, COUNT(*) n FROM documents WHERE status!='trash'
       GROUP BY doc_type ORDER BY n DESC`)
            .all();
        return {
            documents: docs,
            inbox,
            unpaid_count: unpaid.c,
            unpaid_total: unpaid.s,
            overdue,
            types,
        };
    }
    get_settings() {
        return this.cfg;
    }
    export_pdf(target, destination) {
        return this.foreground("Exporting searchable PDF", () => (0, pdf_export_1.exportPdf)(this.con, target, this.cfg.export_directory || (0, pdf_export_1.defaultExportDirectory)(), destination));
    }
    list_metadata_models({ base_url }) {
        return this.foreground("Connecting to the local model server", () => (0, metadata_model_1.listLocalModels)(base_url));
    }
    set_settings(kv = {}) {
        const next = { ...this.cfg };
        if (kv.ocr_engine !== undefined) {
            if (kv.ocr_engine !== "paddleocr-vl" && kv.ocr_engine !== "tesseract")
                throw new Error("Choose an OCR engine.");
            next.ocr_engine = kv.ocr_engine;
        }
        for (const key of ["ocr_python", "export_directory"]) {
            if (kv[key] === undefined)
                continue;
            if (typeof kv[key] !== "string" || !kv[key].trim())
                throw new Error("Use a valid file path.");
            const value = kv[key].trim().replace(/^~(?=\/|$)/, os.homedir());
            if (!path.isAbsolute(value) || value.includes("\0"))
                throw new Error("Use an absolute file path.");
            next[key] = value;
        }
        if (kv.ocr_device !== undefined) {
            if (typeof kv.ocr_device !== "string" ||
                !/^(cpu|gpu:[0-9]+)$/.test(kv.ocr_device))
                throw new Error("Use cpu or gpu:0, gpu:1, etc.");
            next.ocr_device = kv.ocr_device;
        }
        if (kv.metadata_provider !== undefined) {
            if (kv.metadata_provider !== "claude-cli" &&
                kv.metadata_provider !== "local" &&
                kv.metadata_provider !== "local-server")
                throw new Error("Unknown metadata provider.");
            next.metadata_provider = kv.metadata_provider;
        }
        if (kv.metadata_base_url !== undefined) {
            if (typeof kv.metadata_base_url !== "string")
                throw new Error("Use a model server address.");
            next.metadata_base_url = (0, metadata_model_1.modelBaseUrl)(kv.metadata_base_url);
        }
        if (typeof kv.metadata_model === "string")
            next.metadata_model = kv.metadata_model.trim().slice(0, 200);
        if (kv.ocr_languages !== undefined) {
            if (typeof kv.ocr_languages !== "string" ||
                !/^[a-z_]+(?:\+[a-z_]+)*$/.test(kv.ocr_languages))
                throw new Error("Use Tesseract language codes, e.g. deu+fra+ita+eng.");
            next.ocr_languages = kv.ocr_languages;
        }
        if (typeof kv.scanner_device === "string")
            next.scanner_device = kv.scanner_device;
        storage.setSetting(this.con, "config", next);
        this.cfg = next;
        return this.cfg;
    }
    storage_info() {
        return {
            path: this.con.name,
            size: fs.statSync(this.con.name).size,
            sources: this.con.prepare("SELECT COUNT(*) n FROM assets").get().n,
        };
    }
    years() {
        return this.con
            .prepare(`SELECT DISTINCT substr(COALESCE(doc_date, created_at),1,4) y
       FROM documents WHERE status!='trash' ORDER BY 1 DESC`)
            .all().map((r) => r.y);
    }
}
exports.Api = Api;
