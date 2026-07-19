"""Invoice lifecycle.

Every invoice-ish document gets an invoices row. A reminder (Mahnung/rappel/
sollecito) becomes its own row with reminder_level>0 AND is linked to the
original open invoice (parent_invoice_id); the original moves to status
'reminded' and its amount_due/due_date follow the newest reminder.
Statuses: open -> reminded -> paid | void. 'overdue' is computed from
due_date at query time, never stored.
"""

import datetime
import json


def _today():
    return datetime.date.today().isoformat()


def record_invoice(con, cfg, document_id, sender_id, ext, qr):
    """Create the invoices row for a document (invoice or reminder).
    Returns (invoice_id, notes:list[str])."""
    notes = []
    # idempotency: a crashed earlier run (or rowid reuse after a manual
    # delete) may have left an invoice for this document -- never crash on it
    row = con.execute("SELECT id FROM invoices WHERE document_id=?",
                      (document_id,)).fetchone()
    if row:
        notes.append(f"invoice #{row['id']} already exists for this document")
        return row["id"], notes
    amount = ext.get("amount")
    due = ext.get("due_date")
    if not due and ext.get("doc_date") and ext["doc_type"] == "invoice":
        term = int(cfg.get("default_payment_term_days", 30))
        due = (datetime.date.fromisoformat(ext["doc_date"])
               + datetime.timedelta(days=term)).isoformat()
        notes.append(f"due date assumed: {term}-day Swiss convention")

    qr = qr or {}
    is_notification = 1 if qr.get("is_notification") else 0
    level = ext.get("reminder_level", 0)

    cur = con.execute(
        """INSERT INTO invoices(document_id, sender_id, status, amount, currency,
               amount_due, due_date, invoice_ref, qr_iban, qr_ref_type,
               qr_reference, qr_creditor, qr_payload, swico, is_notification,
               reminder_level, fees)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (document_id, sender_id,
         "void" if is_notification else "open",
         amount, ext.get("currency") or qr.get("currency") or "CHF",
         amount, due, ext.get("invoice_ref"),
         qr.get("iban"), qr.get("ref_type"), qr.get("reference"),
         json.dumps(qr.get("creditor")) if qr.get("creditor") else None,
         qr.get("payload"),
         json.dumps(qr.get("swico")) if qr.get("swico") else None,
         is_notification, level, ext.get("reminder_fee") or 0))
    inv_id = cur.lastrowid

    if level > 0:
        parent = _find_parent(con, cfg, sender_id, ext, qr, inv_id, notes)
        if parent:
            _link_reminder(con, inv_id, parent, ext, due, notes)
        else:
            notes.append("reminder: no matching open invoice found")
    con.commit()
    return inv_id, notes


def _find_parent(con, cfg, sender_id, ext, qr, exclude_id, notes):
    """Chain root for a reminder: the original invoice or, when that was
    never scanned, the earliest scanned reminder (so consecutive orphan
    reminders collate into one chain). Deterministic identifiers first
    (QR reference, invoice number, shared refs -- these are exact), then AI
    adjudication over the open roots; bare sender/amount heuristics only
    in no-AI degraded mode. Invoices of trashed documents never match."""
    # candidates are open chain roots whose document is not in the trash
    ROOT = """i.status IN ('open','reminded') AND i.parent_invoice_id IS NULL
              AND (SELECT status FROM documents WHERE id = i.document_id)
                  != 'trash'"""

    def q(sql, args):
        # every query aliases invoices as i (JOINs make bare 'id' ambiguous)
        return con.execute(sql + " AND i.id != ? ORDER BY i.id DESC",
                           args + [exclude_id]).fetchone()
    if qr and qr.get("reference"):
        row = q(f"""SELECT i.* FROM invoices i WHERE i.qr_reference = ?
                    AND {ROOT}""", [qr["reference"]])
        if row:
            return row
    if ext.get("invoice_ref"):
        row = q(f"""SELECT i.* FROM invoices i WHERE i.invoice_ref = ?
                    AND {ROOT}""", [ext["invoice_ref"]])
        if row:
            return row
    # shared internal references (reminders cite the original invoice number)
    from . import db as _db
    norms = [_db.norm_ref(r["value"]) for r in ext.get("refs", [])
             if r.get("kind") in ("invoice_no", "order_no", "case_no", "other")]
    norms = [n for n in norms if len(n) >= 4]
    if norms:
        row = q(f"""SELECT i.* FROM invoices i
                    JOIN doc_refs r ON r.document_id = i.document_id
                    WHERE r.norm IN ({','.join('?' * len(norms))})
                    AND {ROOT}""",
                norms)
        if row:
            return row
    # no exact identifier matched -- let the model decide among open roots
    from . import ai
    candidates = [dict(r) for r in con.execute(
        f"""SELECT i.id, i.invoice_ref, i.amount, i.currency, i.due_date,
                  d.sender_name, d.title, d.doc_date
           FROM invoices i JOIN documents d ON d.id = i.document_id
           WHERE {ROOT} AND d.status != 'trash'
             AND i.id != ? ORDER BY i.id DESC LIMIT 25""", (exclude_id,))]
    inv_id, reason = ai.match_reminder(cfg, ext, candidates)
    if inv_id:
        notes.append(f"AI matched reminder to invoice #{inv_id}: {reason}")
        return con.execute("SELECT * FROM invoices WHERE id=?",
                           (inv_id,)).fetchone()
    if cfg.get("ai_provider") == "claude-cli":
        return None          # the model looked and found no clear match
    # degraded mode without AI: sender+amount heuristics
    if sender_id and ext.get("amount"):
        row = q(f"""SELECT i.* FROM invoices i WHERE i.sender_id = ?
                    AND {ROOT} AND i.amount BETWEEN ? AND ?""",
                [sender_id, ext["amount"] - 60, ext["amount"] + 0.01])
        if row:
            return row
    if sender_id:
        row = q(f"""SELECT i.* FROM invoices i WHERE i.sender_id = ?
                    AND {ROOT}""", [sender_id])
        if row:
            return row
    return None


def _link_reminder(con, inv_id, parent, ext, due, notes):
    fee = ext.get("reminder_fee") or 0
    new_due = (ext.get("amount") if ext.get("amount") is not None
               else (parent["amount_due"] or parent["amount"] or 0) + fee)
    if not fee and ext.get("amount") and parent["amount"]:
        implied = round(ext["amount"] - parent["amount"], 2)
        if 0 < implied <= 60:
            fee = implied
            notes.append(f"reminder fee implied from amounts: {fee:.2f}")
    con.execute("UPDATE invoices SET parent_invoice_id=? WHERE id=?",
                (parent["id"], inv_id))
    con.execute(
        """UPDATE invoices SET status='reminded', amount_due=?,
               due_date=COALESCE(?, due_date), fees=fees+? WHERE id=?""",
        (new_due, due, fee, parent["id"]))
    notes.append(f"linked to invoice #{parent['id']}"
                 + (f", fee {fee:.2f}" if fee else ""))


def chain_ids(con, invoice_id):
    """The whole reminder chain (original + all its reminders)."""
    row = con.execute("SELECT * FROM invoices WHERE id=?", (invoice_id,)).fetchone()
    if not row:
        return []
    root = row["parent_invoice_id"] or row["id"]
    ids = [r["id"] for r in con.execute(
        "SELECT id FROM invoices WHERE id=? OR parent_invoice_id=?", (root, root))]
    return ids


def mark_paid(con, invoice_id, note=None, account_id=None, paid_date=None):
    """Paying any member settles the whole chain. paid_date (ISO date) may
    lie in the future -- the payment's value date, not the click time."""
    at = paid_date or datetime.datetime.now().isoformat(timespec="seconds")
    ids = chain_ids(con, invoice_id)
    con.executemany(
        """UPDATE invoices SET status='paid', paid_at=?, paid_note=?,
               paid_account_id=? WHERE id=?""",
        [(at, note, account_id, i) for i in ids])
    con.commit()
    return ids


def mark_do_not_pay(con, invoice_id, note=None):
    """Settled elsewhere (employer paid, direct debit, disputed, ...):
    close the whole chain as 'void' without recording a payment -- the
    note says where it went. reopen() undoes this like a payment."""
    now = datetime.datetime.now().isoformat(timespec="seconds")
    ids = chain_ids(con, invoice_id)
    con.executemany(
        """UPDATE invoices SET status='void', paid_at=?, paid_note=?,
               paid_account_id=NULL WHERE id=?""",
        [(now, note, i) for i in ids])
    con.commit()
    return ids


def reopen(con, invoice_id):
    ids = chain_ids(con, invoice_id)
    con.executemany(
        """UPDATE invoices SET status='open', paid_at=NULL, paid_note=NULL,
               paid_account_id=NULL WHERE id=?""",
        [(i,) for i in ids])
    con.commit()
    return ids


def list_invoices(con, status=None, limit=500):
    """One row per invoice *chain*, joined with its document, overdue
    computed. The representative row is the chain root: the original
    invoice, or the first-scanned reminder when the original was never
    scanned (an orphan reminder still is unpaid money -- it must show).
    max_reminder_level covers the whole chain, including the root itself."""
    where, args = "1=1", []
    if status == "overdue":
        where = "i.status IN ('open','reminded') AND i.due_date < ?"
        args = [_today()]
    elif status == "unpaid":
        where = "i.status IN ('open','reminded')"
    elif status:
        where = "i.status = ?"
        args = [status]
    rows = con.execute(f"""
        SELECT i.*, d.title, d.sender_name, d.doc_date, d.pdf_path, d.thumb_path,
               d.reviewed, d.pending,
               (i.status IN ('open','reminded') AND i.due_date < '{_today()}')
                   AS overdue,
               (SELECT COUNT(*) FROM invoices c WHERE c.parent_invoice_id = i.id)
                   + (i.reminder_level > 0) AS reminder_count,
               (SELECT MAX(m.reminder_level) FROM invoices m
                 WHERE m.id = i.id OR m.parent_invoice_id = i.id)
                   AS max_reminder_level
        FROM invoices i JOIN documents d ON d.id = i.document_id
        WHERE {where} AND d.status != 'trash' AND i.parent_invoice_id IS NULL
        ORDER BY CASE WHEN i.status IN ('open','reminded') THEN 0 ELSE 1 END,
                 i.due_date IS NULL, i.due_date, i.id DESC
        LIMIT ?""", args + [limit]).fetchall()
    return rows
