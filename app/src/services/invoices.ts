// Invoice lifecycle.
//
// Every invoice-ish document gets an invoices row. A reminder (Mahnung/
// rappel/sollecito) becomes its own row with reminder_level>0 AND is
// linked to the original open invoice (parent_invoice_id); the original
// moves to status 'reminded' and its amount_due/due_date follow the
// newest reminder. Statuses: open -> reminded -> paid | void. 'overdue'
// is computed from due_date at query time, never stored.

import { addDays } from "../domain/qrbill";
import { normRef } from "../domain/textsim";
import type { Config, DocumentRow, Extraction, InvoiceRow, QrBill }
  from "../domain/types";
import { nowIso, type Db } from "../infra/db";
import { matchReminder, type ReminderCandidate } from "./extraction";

const today = (): string => new Date().toISOString().slice(0, 10);

export interface RecordResult {
  invoiceId: number;
  notes: string[];
}

/** Create the invoices row for a document (invoice or reminder). */
export async function recordInvoice(
  con: Db, cfg: Config, documentId: number, senderId: number | null,
  ext: Extraction, qr: QrBill | null,
): Promise<RecordResult> {
  const notes: string[] = [];
  // idempotency: a crashed earlier run (or rowid reuse after a manual
  // delete) may have left an invoice for this document -- never crash on it
  const existing = con.prepare(
    "SELECT id FROM invoices WHERE document_id=?").get(documentId) as
    { id: number } | undefined;
  if (existing) {
    notes.push(`invoice #${existing.id} already exists for this document`);
    return { invoiceId: existing.id, notes };
  }
  const amount = ext.amount;
  let due = ext.due_date;
  if (!due && ext.doc_date && ext.doc_type === "invoice") {
    const term = Number(cfg.default_payment_term_days ?? 30);
    due = addDays(ext.doc_date, term);
    notes.push(`due date assumed: ${term}-day Swiss convention`);
  }

  const isNotification = qr?.is_notification ? 1 : 0;
  const level = ext.reminder_level ?? 0;

  const info = con.prepare(
    `INSERT INTO invoices(document_id, sender_id, status, amount, currency,
         amount_due, due_date, invoice_ref, qr_iban, qr_ref_type,
         qr_reference, qr_creditor, qr_payload, swico, is_notification,
         reminder_level, fees)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(documentId, senderId,
        isNotification ? "void" : "open",
        amount, ext.currency || qr?.currency || "CHF",
        amount, due, ext.invoice_ref,
        qr?.iban ?? null, qr?.ref_type ?? null, qr?.reference ?? null,
        qr?.creditor ? JSON.stringify(qr.creditor) : null,
        qr?.payload ?? null,
        qr?.swico ? JSON.stringify(qr.swico) : null,
        isNotification, level, ext.reminder_fee || 0);
  const invId = Number(info.lastInsertRowid);

  if (level > 0) {
    const parent = await findParent(con, cfg, senderId, ext, qr, invId, notes);
    if (parent) linkReminder(con, invId, parent, ext, due, notes);
    else notes.push("reminder: no matching open invoice found");
  }
  return { invoiceId: invId, notes };
}

// candidates are open chain roots whose document is not in the trash
const ROOT = `i.status IN ('open','reminded') AND i.parent_invoice_id IS NULL
              AND (SELECT status FROM documents WHERE id = i.document_id)
                  != 'trash'`;

/**
 * Chain root for a reminder: the original invoice or, when that was
 * never scanned, the earliest scanned reminder (so consecutive orphan
 * reminders collate into one chain). Deterministic identifiers first
 * (QR reference, invoice number, shared refs -- these are exact), then
 * AI adjudication over the open roots; bare sender/amount heuristics
 * only in no-AI degraded mode. Invoices of trashed documents never match.
 */
async function findParent(
  con: Db, cfg: Config, senderId: number | null, ext: Extraction,
  qr: QrBill | null, excludeId: number, notes: string[],
): Promise<InvoiceRow | null> {
  const q = (sql: string, args: unknown[]): InvoiceRow | undefined =>
    con.prepare(sql + " AND i.id != ? ORDER BY i.id DESC")
      .get(...args, excludeId) as InvoiceRow | undefined;

  if (qr?.reference) {
    const row = q(`SELECT i.* FROM invoices i WHERE i.qr_reference = ?
                   AND ${ROOT}`, [qr.reference]);
    if (row) return row;
  }
  if (ext.invoice_ref) {
    const row = q(`SELECT i.* FROM invoices i WHERE i.invoice_ref = ?
                   AND ${ROOT}`, [ext.invoice_ref]);
    if (row) return row;
  }
  // shared internal references (reminders cite the original invoice number)
  const norms = ext.refs
    .filter((r) => ["invoice_no", "order_no", "case_no", "other"].includes(r.kind))
    .map((r) => normRef(r.value))
    .filter((n) => n.length >= 4);
  if (norms.length) {
    const row = q(`SELECT i.* FROM invoices i
                   JOIN doc_refs r ON r.document_id = i.document_id
                   WHERE r.norm IN (${norms.map(() => "?").join(",")})
                   AND ${ROOT}`, norms);
    if (row) return row;
  }
  // no exact identifier matched -- let the model decide among open roots
  const candidates = con.prepare(
    `SELECT i.id, i.invoice_ref, i.amount, i.currency, i.due_date,
            d.sender_name, d.title, d.doc_date
     FROM invoices i JOIN documents d ON d.id = i.document_id
     WHERE ${ROOT} AND d.status != 'trash'
       AND i.id != ? ORDER BY i.id DESC LIMIT 25`
  ).all(excludeId) as ReminderCandidate[];
  const { invoiceId, reason } = await matchReminder(cfg, ext, candidates);
  if (invoiceId) {
    notes.push(`AI matched reminder to invoice #${invoiceId}: ${reason}`);
    return con.prepare("SELECT * FROM invoices WHERE id=?")
      .get(invoiceId) as InvoiceRow;
  }
  if (["claude-cli", "local-vllm"].includes(cfg.ai_provider))
    return null;          // the model looked and found no clear match
  // degraded mode without AI: sender+amount heuristics
  if (senderId && ext.amount != null) {
    const row = q(`SELECT i.* FROM invoices i WHERE i.sender_id = ?
                   AND ${ROOT} AND i.amount BETWEEN ? AND ?`,
                  [senderId, ext.amount - 60, ext.amount + 0.01]);
    if (row) return row;
  }
  if (senderId) {
    const row = q(`SELECT i.* FROM invoices i WHERE i.sender_id = ?
                   AND ${ROOT}`, [senderId]);
    if (row) return row;
  }
  return null;
}

function linkReminder(
  con: Db, invId: number, parent: InvoiceRow, ext: Extraction,
  due: string | null, notes: string[],
): void {
  let fee = ext.reminder_fee || 0;
  const newDue = ext.amount != null
    ? ext.amount
    : (parent.amount_due ?? parent.amount ?? 0) + fee;
  if (!fee && ext.amount != null && parent.amount != null) {
    const implied = Math.round((ext.amount - parent.amount) * 100) / 100;
    if (implied > 0 && implied <= 60) {
      fee = implied;
      notes.push(`reminder fee implied from amounts: ${fee.toFixed(2)}`);
    }
  }
  con.prepare("UPDATE invoices SET parent_invoice_id=? WHERE id=?")
    .run(parent.id, invId);
  con.prepare(
    `UPDATE invoices SET status='reminded', amount_due=?,
         due_date=COALESCE(?, due_date), fees=fees+? WHERE id=?`
  ).run(newDue, due, fee, parent.id);
  notes.push(`linked to invoice #${parent.id}`
             + (fee ? `, fee ${fee.toFixed(2)}` : ""));
}

/** The whole reminder chain (original + all its reminders). */
export function chainIds(con: Db, invoiceId: number): number[] {
  const row = con.prepare("SELECT * FROM invoices WHERE id=?")
    .get(invoiceId) as InvoiceRow | undefined;
  if (!row) return [];
  const root = row.parent_invoice_id ?? row.id;
  return (con.prepare(
    "SELECT id FROM invoices WHERE id=? OR parent_invoice_id=?"
  ).all(root, root) as Array<{ id: number }>).map((r) => r.id);
}

export interface MarkPaidOpts {
  note?: string | null;
  accountId?: number | null;
  paidDate?: string | null;
}

/**
 * Paying any member settles the whole chain. paidDate (ISO date) may lie
 * in the future -- the payment's value date, not the click time.
 */
export function markPaid(
  con: Db, invoiceId: number,
  { note = null, accountId = null, paidDate = null }: MarkPaidOpts = {},
): number[] {
  const at = paidDate || nowIso();
  const ids = chainIds(con, invoiceId);
  const upd = con.prepare(
    `UPDATE invoices SET status='paid', paid_at=?, paid_note=?,
         paid_account_id=? WHERE id=?`);
  for (const id of ids) upd.run(at, note, accountId, id);
  return ids;
}

/**
 * Settled elsewhere (employer paid, direct debit, disputed, ...): close
 * the whole chain as 'void' without recording a payment -- the note says
 * where it went. reopen() undoes this like a payment.
 */
export function markDoNotPay(
  con: Db, invoiceId: number, note: string | null = null,
): number[] {
  const ids = chainIds(con, invoiceId);
  const upd = con.prepare(
    `UPDATE invoices SET status='void', paid_at=?, paid_note=?,
         paid_account_id=NULL WHERE id=?`);
  for (const id of ids) upd.run(nowIso(), note, id);
  return ids;
}

export function reopen(con: Db, invoiceId: number): number[] {
  const ids = chainIds(con, invoiceId);
  const upd = con.prepare(
    `UPDATE invoices SET status='open', paid_at=NULL, paid_note=NULL,
         paid_account_id=NULL WHERE id=?`);
  for (const id of ids) upd.run(id);
  return ids;
}

export type InvoiceListRow = InvoiceRow & {
  title: string | null;
  sender_name: string | null;
  doc_date: string | null;
  pdf_path: string | null;
  thumb_path: string | null;
  reviewed: number;
  pending: DocumentRow["pending"];
  overdue: number;
  reminder_count: number;
  max_reminder_level: number;
};

/**
 * One row per invoice *chain*, joined with its document, overdue
 * computed. The representative row is the chain root: the original
 * invoice, or the first-scanned reminder when the original was never
 * scanned (an orphan reminder still is unpaid money -- it must show).
 * max_reminder_level covers the whole chain, including the root itself.
 */
export function listInvoices(
  con: Db, { status = null, limit = 500 }:
    { status?: string | null; limit?: number } = {},
): InvoiceListRow[] {
  let where = "1=1";
  let args: unknown[] = [];
  if (status === "overdue") {
    where = "i.status IN ('open','reminded') AND i.due_date < ?";
    args = [today()];
  } else if (status === "unpaid") {
    where = "i.status IN ('open','reminded')";
  } else if (status) {
    where = "i.status = ?";
    args = [status];
  }
  return con.prepare(
    `SELECT i.*, d.title, d.sender_name, d.doc_date, d.pdf_path, d.thumb_path,
            d.reviewed, d.pending,
            (i.status IN ('open','reminded') AND i.due_date < '${today()}')
                AS overdue,
            (SELECT COUNT(*) FROM invoices c WHERE c.parent_invoice_id = i.id)
                + (i.reminder_level > 0) AS reminder_count,
            (SELECT MAX(m.reminder_level) FROM invoices m
              WHERE m.id = i.id OR m.parent_invoice_id = i.id)
                AS max_reminder_level
     FROM invoices i JOIN documents d ON d.id = i.document_id
     WHERE ${where} AND d.status != 'trash' AND i.parent_invoice_id IS NULL
     ORDER BY CASE WHEN i.status IN ('open','reminded') THEN 0 ELSE 1 END,
              i.due_date IS NULL, i.due_date, i.id DESC
     LIMIT ?`
  ).all(...args, limit) as InvoiceListRow[];
}
