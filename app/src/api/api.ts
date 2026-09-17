// The renderer-facing API facade. Method names and result shapes match
// what the renderer calls through the preload bridge; runs in-process in
// the Electron main process (no external API server).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { ibanValid } from "../domain/qrbill";
import { slugify, fold } from "../domain/textsim";
import type {
  BankAccountRow,
  Config,
  DocType,
  DocumentRow,
  EventRow,
  InvoiceRow,
  SenderRow,
} from "../domain/types";
import * as config from "../infra/config";
import { listLocalModels, modelBaseUrl } from "../services/metadata_model";
import * as db from "../infra/db";
import { renderQrPng } from "../infra/qrcodec";
import * as invoices from "../services/invoices";
import * as scanner from "../services/scanner";
import { ProcessingQueue } from "../services/processing_queue";
import * as workbench from "../services/pipeline";
import * as storage from "../infra/storage";
import { requestAbort, aborted, finishAbort, ExecutionScope, inScope } from "../infra/exec";
import type { ProcessingProgress } from "../domain/progress";
import { metadataAsOf, recordMetadata } from "../infra/metadata_history";
import { validDate } from "../domain/document_dates";
import { DOC_TYPES } from "../domain/types";
import { enrichStoredPdf } from "../infra/pdf_metadata";
import {
  exportPdf,
  defaultExportDirectory,
  type ExportTarget,
} from "../services/pdf_export";

interface TimelineEntry {
  date: string;
  label: string;
  kind: string;
  document_id: number | null;
}

type Params = Record<string, unknown>;

export class Api {
  cfg: Config;
  con: db.Db;

  constructor() {
    this.cfg = config.load();
    this.con = db.connect(config.dbPath(this.cfg));
    storage.init(this.con);
    this.queue = new ProcessingQueue(this.con, () => this.cfg, () => this.onStatus());
  }

  queue: ProcessingQueue;
  private activeScope: ExecutionScope | null = null;
  busy = false;
  label = "Ready";
  processing: ProcessingProgress | null = null;
  private active: Promise<unknown> | null = null;
  onStatus: () => void = () => {};

  async initialize(): Promise<void> {
    await storage.migrateFiles(this.con, this.cfg);
    this.cfg = {
      ...this.cfg,
      ...storage.setting<Config>(this.con, "config"),
      data_root: this.cfg.data_root,
    };
    this.queue.resume();
  }

  private async foreground<T>(
    label: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.busy)
      throw new Error("Wait for the current operation, or stop it first.");
    this.busy = true;
    const scope = new ExecutionScope();
    this.activeScope = scope;
    this.progress(label);
    const task = inScope(scope, action);
    this.active = task;
    try {
      return await task;
    } finally {
      await finishAbort(scope);
      this.busy = false;
      this.active = null;
      this.activeScope = null;
      this.progress("Ready");
    }
  }
  private progress = (label: string, processing?: ProcessingProgress): void => {
    this.label = label;
    this.processing = processing || null;
    this.onStatus();
  };
  async shutdown(): Promise<void> {
    if (this.activeScope) requestAbort(this.activeScope);
    const queueStopped = this.queue.stop();
    try {
      await this.active;
    } catch {
      /* durable work is preserved */
    }
    await queueStopped;
    this.con.close();
  }
  assertIdle(): void {
    if (this.busy)
      throw new Error("An operation is in progress. Please wait or stop it.");
  }

  // -- documents ---------------------------------------------------------
  search({ q = "", limit = 100 } = {} as Params) {
    return db.search(this.con, String(q), Number(limit));
  }

  list_documents(
    {
      doc_type = null,
      sender_id = null,
      year = null,
      inbox = false,
      limit = 200,
      offset = 0,
      sort = "document",
      q = "",
    } = {} as Params,
  ) {
    const where = ["d.status != 'trash'"];
    const args: unknown[] = [];
    if (q) {
      const matches = db.search(this.con, String(q), 10000) as {id:number}[];
      if (!matches.length) return [];
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
    if (inbox) where.push("d.reviewed = 0");
    return this.con
      .prepare(
        `SELECT d.id, d.created_at, d.scanned_at, d.scan_date_source, d.case_opened_date, d.doc_date, d.title, d.doc_type,
              d.sender_id, d.sender_name, d.language, d.summary,
              d.tags, d.pages, d.batch, d.reviewed, d.duplicate_of,
              d.dup_reason, d.amount, d.currency, d.due_date,
              d.invoice_ref, d.flags, d.thumb_path, d.pending
       FROM documents d WHERE ${where.join(" AND ")}
       ORDER BY ${sort === "scan" ? "COALESCE(d.scanned_at,d.created_at)" : "COALESCE(d.doc_date,d.scanned_at,d.created_at)"} DESC, d.id DESC
       LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
  }

  library_groups(params: Params = {}) {
    const docs = this.list_documents({ ...params, limit: 500 }) as {id:number;title:string}[];
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
    `).all() as {a:number;b:number;reason:string}[];
    const parent = new Map<number,number>();
    const root = (id:number):number => {
      if (!parent.has(id)) parent.set(id,id);
      let r=id;
      while (parent.get(r)!==r) r=parent.get(r)!;
      let n=id;
      while(parent.get(n)!==r) { const next=parent.get(n)!;parent.set(n,r);n=next; }
      return r;
    };
    for(const edge of edges) parent.set(root(edge.b),root(edge.a));
    const grouped = new Map<number, typeof docs>();
    for(const doc of docs) { const key=root(doc.id);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key)!.push(doc); }
    return [...grouped].map(([id, documents]) => ({ id, documents,
      relationships: edges.filter((e) => documents.some((d) => d.id===e.a || d.id===e.b)),
    }));
  }

  document_sources({ id }: { id: number }) {
    const doc = this.con
      .prepare("SELECT batch FROM documents WHERE id=?")
      .get(id) as { batch: string | null } | undefined;
    if (!doc) throw new Error("Document not found.");
    const legacy = doc.batch
      ? `legacy/originals/${doc.batch}/`
      : "no-legacy-source/";
    const sources = this.con
      .prepare(
        `SELECT DISTINCT a.key, length(b.data) AS bytes FROM assets a JOIN blobs b USING(sha)
      WHERE a.key IN (SELECT source_key FROM review_pages WHERE document_id=?)
      OR a.key IN (SELECT i.source_key FROM imports i JOIN review_groups g ON g.id=i.group_id WHERE g.target_id=?)
      OR substr(a.key,1,?)=? OR a.key LIKE ? ORDER BY a.key`,
      )
      .all(id, id, legacy.length, legacy, `revision/${id}/%`) as Array<{
      key: string;
      bytes: number;
    }>;
    return sources.filter(
      (source) =>
        source.key.startsWith("revision/") ||
        /\.(pdf|jpe?g|png|tiff?|pnm)$/i.test(source.key),
    );
  }
  recover_source({ id, key }: { id: number; key: string }) {
    if (!this.document_sources({ id }).some((s) => s.key === key))
      throw new Error("Source does not belong to this document.");
    return this.foreground("Preparing original source", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-recover-"));
      try {
        const file = path.join(
          dir,
          key.startsWith("revision/")
            ? "previous-version.pdf"
            : path.basename(key),
        );
        fs.writeFileSync(file, storage.get(this.con, key)!.data);
        const groupId = workbench.queueFiles(
          this.con,
          [file],
          `Source from document #${id}`,
        );
        await workbench.prepareGroup(this.con, groupId, this.progress);
        return groupId;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  get_document({ id }: { id: number }) {
    const doc = this.con
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(id) as DocumentRow | undefined;
    if (!doc) throw new Error(`no document ${id}`);
    const d: Record<string, unknown> = { ...doc };
    d.sources = this.document_sources({ id });
    d.pdf_abs = null;
    d.has_pdf = storage.has(this.con, storage.docKey(id));
    d.pages_detail = this.con
      .prepare(
        `SELECT page_no, scan_order, is_blank, marker,
              substr(text,1,400) AS text_head
       FROM pages WHERE document_id=? ORDER BY COALESCE(page_no, 999),
       scan_order`,
      )
      .all(id);
    const inv = this.con
      .prepare("SELECT * FROM invoices WHERE document_id=?")
      .get(id) as InvoiceRow | undefined;
    if (inv) {
      const invOut: Record<string, unknown> = { ...inv };
      if (inv.paid_account_id) {
        const acc = this.con
          .prepare("SELECT holder, bank FROM bank_accounts WHERE id=?")
          .get(inv.paid_account_id) as
          | Pick<BankAccountRow, "holder" | "bank">
          | undefined;
        if (acc)
          invOut.paid_account = [acc.holder, acc.bank]
            .filter(Boolean)
            .join(", ");
      }
      const ids = invoices.chainIds(this.con, inv.id);
      invOut.chain = this.con
        .prepare(
          `SELECT i.*, dd.title AS doc_title, dd.id AS doc_id
         FROM invoices i JOIN documents dd ON dd.id=i.document_id
         WHERE i.id IN (${ids.join(",")}) ORDER BY i.reminder_level`,
        )
        .all();
      d.invoice = invOut;
    } else {
      d.invoice = null;
    }
    d.duplicates = (
      this.con
        .prepare("SELECT id FROM documents WHERE duplicate_of=?")
        .all(id) as Array<{ id: number }>
    ).map((r) => r.id);
    d.refs = this.con
      .prepare(
        "SELECT kind, value, page, evidence FROM doc_refs WHERE document_id=?",
      )
      .all(id);
    d.related = [
      ...db.relatedDocuments(this.con, id),
      ...this.con
        .prepare(
          `SELECT d.id,d.title,d.doc_type,d.doc_date,d.created_at,'verified link' AS kind,'' AS value
       FROM document_links l JOIN documents d ON d.id=CASE WHEN l.a=? THEN l.b ELSE l.a END
       WHERE (l.a=? OR l.b=?) AND d.status!='trash'`,
        )
        .all(id, id, id),
    ];
    d.review_history = this.con
      .prepare(
        "SELECT at,note,checks FROM review_log WHERE document_id=? ORDER BY id DESC",
      )
      .all(id);
    d.timeline = this.timeline({ id });
    let extracted: Partial<import("../domain/types").Extraction> = {};
    try {
      extracted = JSON.parse(doc.ai_json || "{}");
    } catch {
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
  timeline({ id }: { id: number }): TimelineEntry[] {
    const doc = this.con
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(id) as DocumentRow | undefined;
    if (!doc) return [];
    const ev: TimelineEntry[] = [];
    const add = (
      date: string | null,
      label: string,
      kind: string,
      docId: number | null = null,
    ): void => {
      if (date)
        ev.push({
          date: String(date).slice(0, 10),
          label,
          kind,
          document_id: docId,
        });
    };
    add(doc.doc_date, doc.title || doc.doc_type || "", "self", id);
    add(
      doc.scanned_at || doc.created_at,
      doc.scan_date_source === "legacy_recorded_at"
        ? "Scan recorded (legacy timestamp)"
        : "Scanned / imported",
      "scan",
      id,
    );
    add(doc.case_opened_date, "Case initiated", "case_opened", id);
    try {
      const ai = JSON.parse(doc.ai_json || "{}") as {
        ref_dates?: Array<{ date: string; label?: string; kind?: string }>;
      };
      for (const rd of ai.ref_dates ?? [])
        add(rd.date, rd.label || "mentioned date", rd.kind || "mentioned", id);
    } catch {
      /* ai_json unreadable */
    }
    const inv = this.con
      .prepare("SELECT * FROM invoices WHERE document_id=?")
      .get(id) as InvoiceRow | undefined;
    if (inv) {
      for (const cid of invoices.chainIds(this.con, inv.id)) {
        const m = this.con
          .prepare(
            `SELECT i.*, dd.doc_date AS ddate, dd.title AS dtitle,
                  dd.id AS did FROM invoices i
           JOIN documents dd ON dd.id = i.document_id
           WHERE i.id=?`,
          )
          .get(cid) as InvoiceRow & {
          ddate: string | null;
          dtitle: string | null;
          did: number;
        };
        const label =
          m.reminder_level === 0 ? "invoice" : `reminder ${m.reminder_level}`;
        if (m.did !== id)
          add(m.ddate, `${label}: ${m.dtitle || ""}`.trim(), "chain", m.did);
        add(m.due_date, `due (${label})`, "due", m.did);
        if (m.paid_at)
          add(
            m.paid_at,
            m.status === "paid" ? "paid" : "do not pay",
            "paid",
            m.did,
          );
      }
    }
    for (const r of db.relatedDocuments(this.con, id))
      add(
        r.doc_date || r.created_at,
        `${r.doc_type}: ${r.title || ""} (${r.kind} ${r.value})`,
        "related",
        r.id,
      );
    // dedup identical entries, sort chronologically
    const seen = new Set<string>();
    const out: TimelineEntry[] = [];
    for (const e of ev.sort((a, b) => a.date.localeCompare(b.date))) {
      const key = `${e.date}\x00${e.label}\x00${e.document_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
    return out;
  }

  update_document({ id, ...fields }: { id: number } & Params) {
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
      const sets: string[] = [];
      const args: unknown[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (allowed.has(k)) {
          if (
            (k === "doc_date" || k === "case_opened_date") &&
            v !== null &&
            !validDate(v)
          )
            throw new Error("Use a valid calendar date.");
          if (k === "doc_type" && !DOC_TYPES.includes(v as DocType))
            throw new Error("Unknown document type.");
          sets.push(`${k}=?`);
          args.push(v);
        } else if (k === "tags") {
          const tags = ((v as unknown[]) || [])
            .map((t) => String(t).trim().toLowerCase())
            .filter(Boolean);
          sets.push("tags=?", "tags_text=?");
          args.push(JSON.stringify(tags), fold(tags.join(" ")));
        } else if (k === "sender_name") {
          const name = v as string | null;
          const sid = name
            ? db.upsertSender(this.con, slugify(name), name)
            : null;
          sets.push("sender_id=?", "sender_name=?");
          const canonical = sid
            ? (
                this.con
                  .prepare("SELECT name FROM senders WHERE id=?")
                  .get(sid) as { name: string }
              ).name
            : null;
          args.push(sid, canonical);
        }
      }
      if (sets.length)
        this.con.transaction(() => {
          recordMetadata(this.con, id, "Before manual correction");
          this.con
            .prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id=?`)
            .run(...args, id);
          recordMetadata(this.con, id, "Manual metadata correction");
        })();
      const review = this.con
        .prepare("SELECT id FROM review_groups WHERE target_id=?")
        .get(id) as { id: number } | undefined;
      if (review) {
        const values: Partial<workbench.DraftMetadata> = {};
        for (const key of [
          "title",
          "sender_name",
          "doc_type",
          "doc_date",
          "case_opened_date",
        ] as const)
          if (key in fields) (values as Params)[key] = fields[key];
        if (Object.keys(values).length)
          workbench.updateMetadata(this.con, review.id, values);
      }
      await enrichStoredPdf(this.con, id);
      return this.get_document({ id });
    });
  }

  async trash_document({ id }: { id: number }) {
    const review = this.con
      .prepare("SELECT id FROM review_groups WHERE target_id=?")
      .get(id) as { id: number } | undefined;
    if (review) {
      await this.queue.editPages(review.id);
      workbench.deleteReview(this.con, review.id);
    }
    this.con.prepare("UPDATE documents SET status='trash' WHERE id=?").run(id);
    return true;
  }

  // -- senders / invoices -------------------------------------------------
  list_senders(): SenderRow[] {
    return this.con
      .prepare(
        `SELECT s.*, COUNT(d.id) AS doc_count,
              MAX(COALESCE(d.doc_date, d.created_at)) AS last_doc
       FROM senders s LEFT JOIN documents d
            ON d.sender_id = s.id AND d.status != 'trash'
       GROUP BY s.id ORDER BY doc_count DESC`,
      )
      .all() as SenderRow[];
  }

  list_invoices({ status = null } = {} as { status?: string | null }) {
    return invoices.listInvoices(this.con, {
      status: status === "all" ? null : status,
    });
  }

  invoice_paid({
    id,
    note = null,
    account_id = null,
    paid_date = null,
  }: {
    id: number;
    note?: string | null;
    account_id?: number | null;
    paid_date?: string | null;
  }) {
    invoices.markPaid(this.con, id, {
      note,
      accountId: account_id,
      paidDate: paid_date,
    });
    return true;
  }

  invoice_do_not_pay({
    id,
    note = null,
  }: {
    id: number;
    note?: string | null;
  }) {
    invoices.markDoNotPay(this.con, id, note);
    return true;
  }

  invoice_reopen({ id }: { id: number }) {
    invoices.reopen(this.con, id);
    return true;
  }

  // -- bank accounts ------------------------------------------------------
  list_bank_accounts(): BankAccountRow[] {
    return this.con
      .prepare("SELECT * FROM bank_accounts ORDER BY id")
      .all() as BankAccountRow[];
  }

  save_bank_account({
    id = null,
    holder = null,
    bank = null,
    iban = null,
  }: {
    id?: number | null;
    holder?: string | null;
    bank?: string | null;
    iban?: string | null;
  } = {}) {
    holder = (holder || "").trim();
    bank = (bank || "").trim();
    iban = (iban || "").trim();
    if (!holder) throw new Error("account holder is required");
    if (iban) {
      // stored compact uppercase (like senders.iban); UI regroups by 4
      iban = iban.replace(/\s+/g, "").toUpperCase();
      if (!(iban.length >= 15 && iban.length <= 34 && ibanValid(iban)))
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

  delete_bank_account({ id }: { id: number }) {
    // past payments keep their row but drop the link (ON DELETE SET NULL)
    this.con.prepare("DELETE FROM bank_accounts WHERE id=?").run(id);
    return true;
  }

  /**
   * Swiss QR as data-URI PNG with the Swiss-cross overlay, for paying by
   * scanning the screen with a banking app.
   */
  async render_qr({ invoice_id }: { invoice_id: number }) {
    return this.foreground("Preparing payment QR", async () => {
      const row = this.con
        .prepare(
          "SELECT qr_payload, amount, amount_due FROM invoices WHERE id=?",
        )
        .get(invoice_id) as
        | Pick<InvoiceRow, "qr_payload" | "amount" | "amount_due">
        | undefined;
      if (!row?.qr_payload)
        throw new Error("no QR payload stored for this invoice");
      let payload = row.qr_payload;
      // after reminders the amount due includes fees -- update the SPC
      // amount line so the banking app prefills what is actually owed
      if (
        row.amount_due &&
        row.amount &&
        Math.abs(row.amount_due - row.amount) >= 0.01
      ) {
        const nl = payload.includes("\r\n") ? "\r\n" : "\n";
        const lines = payload.split(nl);
        if (lines.length > 19) {
          lines[18] = row.amount_due.toFixed(2);
          payload = lines.join(nl);
        }
      }
      const png = await renderQrPng(payload);
      return "data:image/png;base64," + png.toString("base64");
    });
  }

  // -- foreground capture and collation ----------------------------------
  get_workbench() {
    return workbench.workbench(this.con);
  }
  metadata_history({ id }: { id: number }) {
    return this.con
      .prepare(
        "SELECT id,valid_from,valid_to,recorded_from,recorded_to,source,snapshot FROM document_metadata_versions WHERE document_id=? ORDER BY recorded_from DESC",
      )
      .all(id);
  }
  metadata_as_of({
    id,
    known_at,
    effective_on,
  }: {
    id: number;
    known_at: string;
    effective_on?: string;
  }) {
    return metadataAsOf(this.con, id, known_at, effective_on);
  }
  refresh_document_metadata({ id }: { id: number }) {
    return this.foreground("Recognizing document details", async () => {
      this.progress("Matching references and interpreting document dates", {
        stage: "details",
      });
      await workbench.recognizeDocumentMetadata(this.cfg, this.con, id);
      await enrichStoredPdf(this.con, id);
      return this.get_document({ id });
    });
  }
  new_group({ title }: { title?: string } = {}) {
    return workbench.newGroup(this.con, title);
  }
  rename_group({ id, title }: { id: number; title: string }) {
    return this.update_group_metadata({ id, values: { title } });
  }
  update_group_metadata({
    id,
    values,
  }: {
    id: number;
    values: Partial<workbench.DraftMetadata>;
  }) {
    workbench.updateMetadata(this.con, id, values);
    return workbench.workbench(this.con).find((g) => g.id === id)!;
  }
  remove_empty_group({ id }: { id: number }) {
    workbench.removeEmptyGroup(this.con, id);
  }

  edit_page(p: { id: number; group_id: number; excluded?: boolean }) {
    return this.foreground("Saving page changes", async () => {
      const source = this.con
        .prepare("SELECT group_id FROM review_pages WHERE id=?")
        .get(p.id) as { group_id: number };
      for (const id of new Set([source.group_id, p.group_id])) await this.queue.editPages(id);
      workbench.editPage(this.con, p.id, p.group_id, p.excluded);

    });
  }
  reorder_pages(p: { id: number; pages: number[] }) {
    return this.foreground("Saving page order", async () => {
      await this.queue.editPages(p.id);
      workbench.reorder(this.con, p.id, p.pages);
      this.con.prepare("UPDATE review_groups SET manual_order=1 WHERE id=?").run(p.id);
    });
  }
  enqueue_group({ id }: { id: number }) {
    this.queue.enqueue(id);
    return id;
  }
  edit_group_pages({ id }: { id: number }) {
    return this.foreground("Opening page review", () => this.queue.editPages(id));
  }
  prepare_group({ id }: { id: number }) {
    return this.foreground("Preparing captured pages", async () => {
      await this.queue.editPages(id);
      await workbench.prepareGroup(this.con, id, this.progress);
    });
  }
  read_group({ id }: { id: number }) {
    return this.foreground("Queueing text recognition", async () => {
      await this.queue.editPages(id);
      this.con.prepare("UPDATE review_pages SET ocr_source=NULL WHERE group_id=? AND excluded=0").run(id);
      this.con.prepare("UPDATE review_groups SET split_done=0 WHERE id=?").run(id);
      this.queue.enqueue(id);
    });
  }
  recognize_group_details({ id }: { id: number }) {
    this.queue.enqueue(id);
  }
  file_group(input: workbench.FileReview) {
    if (workbench.group(this.con, input.id).phase !== "ready")
      throw new Error("Wait until this document is ready to review before saving it to Library.");
    return this.foreground("Saving document", () =>
      workbench.fileGroup(this.cfg, this.con, input, this.progress),
    );
  }
  reopen_document({ id }: { id: number }) {
    return this.foreground("Preparing document for review", async () => {
      const existing = this.con.prepare("SELECT id FROM review_groups WHERE target_id=?").get(id);
      const groupId = await workbench.reopenDocument(
        this.con,
        id,
        this.progress,
      );
      // Opening an existing active review must not steal it from the worker.
      if (!existing) this.con.prepare("UPDATE review_groups SET phase='ready' WHERE id=?").run(groupId);
      return groupId;
    });
  }
  delete_review({ id }: { id: number }) {
    return this.foreground("Removing scanned set", async () => {
      await this.queue.editPages(id);
      workbench.deleteReview(this.con, id);
      return true;
    });
  }
  backup_database(destination: string) {
    return this.foreground("Backing up database", () =>
      storage.backup(this.con, destination),
    );
  }

  private async captureFiles(files: string[], title: string, options: { group_id?: number; after_page_id?: number } = {}, issue: string | null = null, capturedAt?: string) {
    const { group_id, after_page_id } = options;
    const old = group_id ? this.con.prepare("SELECT id FROM review_pages WHERE group_id=? ORDER BY position,id").all(group_id) as {id:number}[] : [];
    if (group_id) await this.queue.editPages(group_id);
    if (after_page_id != null && after_page_id !== 0 && !old.some((p) => p.id === after_page_id))
      throw new Error("Choose an insertion point in this scanned set.");
    const id = workbench.queueFiles(this.con, files, title, issue, group_id, capturedAt);
    if (!aborted()) {
      await workbench.prepareGroup(this.con, id, this.progress);
      if (group_id && after_page_id != null) {
        const all = this.con.prepare("SELECT id FROM review_pages WHERE group_id=? ORDER BY position,id").all(id) as {id:number}[];
        const added = all.filter((p) => !old.some((o) => o.id === p.id));
        const at = after_page_id === 0 ? 0 : old.findIndex((p) => p.id === after_page_id) + 1;
        workbench.reorder(this.con, id, [...old.slice(0,at),...added,...old.slice(at)].map((p) => p.id));
        this.con.prepare("UPDATE review_groups SET manual_order=1 WHERE id=?").run(id);
      }
    }
    return id;
  }
  import_files(files: string[], options: { group_id?: number; after_page_id?: number } = {}) {
    return this.foreground("Importing pages", () => this.captureFiles(files,
      files.length === 1 ? path.basename(files[0]) : "Imported pages", options));
  }
  scan_now(options: { group_id?: number; after_page_id?: number } = {}) {
    return this.foreground("Looking for scanner", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-scan-"));
      const capturedAt = new Date().toISOString();
      try {
        if (options.group_id) workbench.group(this.con, options.group_id);
        if (options.after_page_id && !this.con.prepare("SELECT 1 FROM review_pages WHERE id=? AND group_id=?").get(options.after_page_id, options.group_id))
          throw new Error("Choose an insertion point in this scanned set.");
        const result = await scanner.scan(dir, this.cfg.scanner_device, (n) =>
          this.progress(`Scanning · ${n} captured pages`));
        return await this.captureFiles(result.files, `Scan ${new Date().toLocaleString()}`, options,
          aborted() ? "Scan interrupted by user. Verify completeness." : result.warning, capturedAt);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  discover_scanners() {
    return this.foreground("Looking for scanner", () => scanner.discover());
  }
  abort_scan() {
    if (this.activeScope) requestAbort(this.activeScope);
    this.progress("Stopping · captured source files are kept");
  }
  status() {
    return { busy: this.busy, label: this.label, processing: this.processing, background: this.queue.current, queue_version: this.queue.version };
  }

  list_events({ limit = 100 } = {} as Params): EventRow[] {
    return this.con
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as EventRow[];
  }

  stats() {
    const one = <T>(sql: string): T => this.con.prepare(sql).get() as T;
    const docs = one<{ c: number }>(
      "SELECT COUNT(*) c FROM documents WHERE status!='trash'",
    ).c;
    const inbox = one<{ c: number }>(
      "SELECT COUNT(*) c FROM documents WHERE status!='trash' AND reviewed=0",
    ).c;
    // one count per chain root (original invoice OR orphan reminder --
    // a reminder whose original was never scanned is still unpaid money)
    const unpaid = one<{ c: number; s: number }>(
      `SELECT COUNT(*) c, COALESCE(SUM(i.amount_due),0) s
       FROM invoices i JOIN documents d ON d.id = i.document_id
       WHERE i.status IN ('open','reminded')
         AND i.parent_invoice_id IS NULL
         AND i.is_notification=0 AND d.status != 'trash'`,
    );
    const overdue = one<{ c: number }>(
      `SELECT COUNT(*) c
       FROM invoices i JOIN documents d ON d.id = i.document_id
       WHERE i.status IN ('open','reminded')
         AND i.parent_invoice_id IS NULL
         AND i.is_notification=0 AND d.status != 'trash'
         AND i.due_date < date('now')`,
    ).c;
    const types = this.con
      .prepare(
        `SELECT doc_type, COUNT(*) n FROM documents WHERE status!='trash'
       GROUP BY doc_type ORDER BY n DESC`,
      )
      .all() as Array<{ doc_type: DocType | null; n: number }>;
    return {
      documents: docs,
      inbox,
      unpaid_count: unpaid.c,
      unpaid_total: unpaid.s,
      overdue,
      types,
    };
  }

  get_settings(): Config {
    return this.cfg;
  }
  export_pdf(target: ExportTarget, destination?: string) {
    return this.foreground("Exporting searchable PDF", () =>
      exportPdf(
        this.con,
        target,
        this.cfg.export_directory || defaultExportDirectory(),
        destination,
      ),
    );
  }
  list_metadata_models({ base_url }: { base_url: string }) {
    return this.foreground("Connecting to the local model server", () =>
      listLocalModels(base_url),
    );
  }

  set_settings(kv: Params = {}): Config {
    const next = { ...this.cfg };
    if (kv.ocr_engine !== undefined) {
      if (kv.ocr_engine !== "paddleocr-vl" && kv.ocr_engine !== "tesseract")
        throw new Error("Choose an OCR engine.");
      next.ocr_engine = kv.ocr_engine;
    }
    for (const key of ["ocr_python", "export_directory"] as const) {
      if (kv[key] === undefined) continue;
      if (typeof kv[key] !== "string" || !kv[key].trim())
        throw new Error("Use a valid file path.");
      const value = kv[key].trim().replace(/^~(?=\/|$)/, os.homedir());
      if (!path.isAbsolute(value) || value.includes("\0"))
        throw new Error("Use an absolute file path.");
      next[key] = value;
    }
    if (kv.ocr_device !== undefined) {
      if (
        typeof kv.ocr_device !== "string" ||
        !/^(cpu|gpu:[0-9]+)$/.test(kv.ocr_device)
      )
        throw new Error("Use cpu or gpu:0, gpu:1, etc.");
      next.ocr_device = kv.ocr_device;
    }
    if (kv.metadata_provider !== undefined) {
      if (
        kv.metadata_provider !== "claude-cli" &&
        kv.metadata_provider !== "local" &&
        kv.metadata_provider !== "local-server"
      )
        throw new Error("Unknown metadata provider.");
      next.metadata_provider = kv.metadata_provider;
    }
    if (kv.metadata_base_url !== undefined) {
      if (typeof kv.metadata_base_url !== "string")
        throw new Error("Use a model server address.");
      next.metadata_base_url = modelBaseUrl(kv.metadata_base_url);
    }
    if (typeof kv.metadata_model === "string")
      next.metadata_model = kv.metadata_model.trim().slice(0, 200);
    if (kv.ocr_languages !== undefined) {
      if (
        typeof kv.ocr_languages !== "string" ||
        !/^[a-z_]+(?:\+[a-z_]+)*$/.test(kv.ocr_languages)
      )
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
      sources: (
        this.con.prepare("SELECT COUNT(*) n FROM assets").get() as { n: number }
      ).n,
    };
  }

  years(): string[] {
    return (
      this.con
        .prepare(
          `SELECT DISTINCT substr(COALESCE(doc_date, created_at),1,4) y
       FROM documents WHERE status!='trash' ORDER BY 1 DESC`,
        )
        .all() as Array<{ y: string }>
    ).map((r) => r.y);
  }
}
