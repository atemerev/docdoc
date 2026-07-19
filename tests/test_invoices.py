#!/usr/bin/python3
"""Invoice chain collation test: one row per chain in list_invoices, orphan
reminders (original invoice never scanned) visible and chaining together,
paying any member settles the whole chain.
Run: /usr/bin/python3 tests/test_invoices.py
"""

import datetime
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from docdoc import db, invoices  # noqa: E402

CFG = {"ai_provider": "none", "default_payment_term_days": 30}


def add_doc(con, title, doc_type):
    cur = con.execute(
        "INSERT INTO documents(created_at, title, doc_type, status, reviewed)"
        " VALUES (?,?,?,'inbox',1)",
        (datetime.datetime.now().isoformat(), title, doc_type))
    con.commit()
    return cur.lastrowid


def main():
    failures = []

    def check(name, cond, detail=""):
        status = "ok" if cond else "FAIL"
        print(f"  [{status}] {name} {detail}")
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory() as td:
        con = db.connect(os.path.join(td, "test.db"))

        # chain A: original invoice + linked reminder
        d1 = add_doc(con, "Rechnung A", "invoice")
        inv_a, _ = invoices.record_invoice(
            con, CFG, d1, None,
            {"doc_type": "invoice", "amount": 100.0, "invoice_ref": "A-1",
             "doc_date": "2026-07-01"}, None)
        d2 = add_doc(con, "Mahnung A", "reminder")
        rem_a, notes = invoices.record_invoice(
            con, CFG, d2, None,
            {"doc_type": "reminder", "reminder_level": 1, "amount": 120.0,
             "invoice_ref": "A-1", "reminder_fee": 20.0}, None)
        check("reminder linked to its invoice",
              any("linked to invoice" in n for n in notes), notes)

        # chain B: orphan reminder (original never scanned), then a second
        # reminder that must chain onto the first orphan
        d3 = add_doc(con, "Sommation B (1st scanned)", "reminder")
        rem_b1, notes = invoices.record_invoice(
            con, CFG, d3, None,
            {"doc_type": "reminder", "reminder_level": 1, "amount": 200.0,
             "invoice_ref": "B-7"}, None)
        check("orphan reminder recorded without parent",
              any("no matching open invoice" in n for n in notes), notes)
        d4 = add_doc(con, "Sommation B (2nd scanned)", "reminder")
        rem_b2, notes = invoices.record_invoice(
            con, CFG, d4, None,
            {"doc_type": "reminder", "reminder_level": 2, "amount": 220.0,
             "invoice_ref": "B-7", "reminder_fee": 20.0}, None)
        check("second orphan reminder chains onto the first",
              any("linked to invoice" in n for n in notes), notes)

        rows = invoices.list_invoices(con)
        check("one row per chain", len(rows) == 2,
              f"(got {len(rows)}: {[r['id'] for r in rows]})")
        by_ref = {r["invoice_ref"]: r for r in rows}
        check("chain A root is the original invoice",
              by_ref.get("A-1") and by_ref["A-1"]["id"] == inv_a)
        check("chain A collates its reminder",
              by_ref.get("A-1") and by_ref["A-1"]["max_reminder_level"] == 1
              and by_ref["A-1"]["reminder_count"] == 1)
        check("chain A amount_due follows the reminder",
              by_ref.get("A-1") and by_ref["A-1"]["amount_due"] == 120.0)
        b = by_ref.get("B-7")
        check("orphan chain visible, rooted at first scanned reminder",
              b is not None and b["id"] == rem_b1)
        check("orphan chain collates to max level 2",
              b is not None and b["max_reminder_level"] == 2
              and b["reminder_count"] == 2)
        check("orphan chain amount_due follows newest reminder",
              b is not None and b["amount_due"] == 220.0)

        # paying any chain member settles the chain, list shows it paid
        invoices.mark_paid(con, rem_b2)
        rows = invoices.list_invoices(con, status="paid")
        check("paying a member settles the whole orphan chain",
              len(rows) == 1 and rows[0]["id"] == rem_b1
              and rows[0]["status"] == "paid")
        rows = invoices.list_invoices(con, status="unpaid")
        check("unpaid list keeps the other chain only",
              len(rows) == 1 and rows[0]["id"] == inv_a)

        # bank accounts: presets seeded once, first is the default
        accts = con.execute("SELECT * FROM bank_accounts ORDER BY id").fetchall()
        check("preset bank accounts seeded", len(accts) == 4,
              f"(got {len(accts)})")
        check("first preset is Temerev/Postfinance",
              accts and accts[0]["holder"] == "Alexander Temerev"
              and accts[0]["bank"] == "Postfinance")
        con2 = db.connect(os.path.join(td, "test.db"))
        n = con2.execute("SELECT COUNT(*) c FROM bank_accounts").fetchone()["c"]
        con2.close()
        check("reconnect does not reseed accounts", n == 4, f"(got {n})")

        # IBAN integrity on save (server API against this temp db)
        from docdoc import config as _config, server as _server
        _config.db_path = lambda: os.path.join(td, "test.db")
        api = _server.Api()
        api.save_bank_account(id=1, holder="Alexander Temerev",
                              bank="Postfinance",
                              iban="ch93 0076 2011 6238 5295 7")
        saved = api.list_bank_accounts()[0]["iban"]
        check("valid IBAN normalized to compact uppercase",
              saved == "CH9300762011623852957", f"(got {saved!r})")
        try:
            api.save_bank_account(id=1, holder="X",
                                  iban="CH94 0076 2011 6238 5295 7")
            check("bad-checksum IBAN rejected", False)
        except ValueError:
            check("bad-checksum IBAN rejected", True)
        try:
            api.save_bank_account(id=1, holder="X", iban="CH93")
            check("too-short IBAN rejected", False)
        except ValueError:
            check("too-short IBAN rejected", True)
        api.save_bank_account(id=1, holder="Alexander Temerev",
                              bank="Postfinance", iban="")
        check("empty IBAN allowed (stored NULL)",
              api.list_bank_accounts()[0]["iban"] is None)

        # status() events fallback: an abort event (logged with batch=NULL)
        # must terminate every in-flight batch, else the aborted batch
        # ghosts as "processing" and the app sticks at "Aborting…"
        db.event(api.con, "batch-start", "ingesting 3 page(s)",
                 batch="testbatch-abort")
        st = api.status()
        check("batch-start shows in processing fallback",
              any(p["batch"] == "testbatch-abort" for p in st["processing"]))
        db.event(api.con, "abort", "scan aborted from the app")
        st = api.status()
        check("abort event clears the in-flight batch",
              not any(p["batch"] == "testbatch-abort"
                      for p in st["processing"]))
        db.event(api.con, "batch-start", "ingesting 2 page(s)",
                 batch="testbatch-after")
        st = api.status()
        check("batch started after an abort still shows",
              any(p["batch"] == "testbatch-after" for p in st["processing"]))
        db.event(api.con, "document", "filed", batch="testbatch-after")
        api.con.close()

        # paying with an account and a value date records both, chain-wide;
        # reopen clears them
        invoices.mark_paid(con, rem_a, account_id=accts[0]["id"],
                           paid_date="2026-07-20")
        paid = con.execute(
            "SELECT * FROM invoices WHERE id IN (?,?)", (inv_a, rem_a)).fetchall()
        check("payment date and account stored on the whole chain",
              all(r["status"] == "paid" and r["paid_at"] == "2026-07-20"
                  and r["paid_account_id"] == accts[0]["id"] for r in paid))
        invoices.reopen(con, inv_a)
        row = con.execute("SELECT * FROM invoices WHERE id=?", (inv_a,)).fetchone()
        check("reopen clears payment date and account",
              row["status"] == "open" and row["paid_at"] is None
              and row["paid_account_id"] is None)

        # do-not-pay (settled elsewhere): voids the whole chain with the
        # comment, drops out of unpaid money, reopen restores
        invoices.mark_do_not_pay(con, rem_a, note="paid by employer")
        row = con.execute("SELECT * FROM invoices WHERE id=?", (inv_a,)).fetchone()
        check("do-not-pay voids the whole chain with the comment",
              row["status"] == "void" and row["paid_note"] == "paid by employer"
              and row["paid_at"] is not None and row["paid_account_id"] is None)
        check("do-not-pay chain leaves the unpaid list",
              all(r["id"] != inv_a
                  for r in invoices.list_invoices(con, status="unpaid")))
        invoices.reopen(con, rem_a)
        row = con.execute("SELECT * FROM invoices WHERE id=?", (inv_a,)).fetchone()
        check("reopen restores a do-not-pay chain",
              row["status"] == "open" and row["paid_note"] is None)

        con.close()

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
