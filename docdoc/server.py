"""JSON-lines stdio API server -- the Electron app spawns this process.

Request:  {"id": 1, "method": "search", "params": {"q": "migros"}}
Response: {"id": 1, "result": ...} | {"id": 1, "error": "..."}
Push:     {"event": "changed"}   (another process committed to the DB)

One writer connection on the main thread; a poller thread watches
PRAGMA data_version (changes when a different connection commits, i.e.
when docdocd files a new document) and pushes change events.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading

from . import config, db, invoices, qrbill

_write_lock = threading.Lock()


def send(obj):
    with _write_lock:
        sys.stdout.write(json.dumps(obj, default=str) + "\n")
        sys.stdout.flush()


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


class Api:
    def __init__(self):
        self.cfg = config.load()
        self.con = db.connect()

    # -- documents ---------------------------------------------------------
    def search(self, q="", limit=100):
        return rows_to_dicts(db.search(self.con, q, limit=limit))

    def list_documents(self, doc_type=None, sender_id=None, year=None,
                       inbox=False, limit=200, offset=0):
        where, args = ["d.status != 'trash'"], []
        if doc_type:
            where.append("d.doc_type = ?"); args.append(doc_type)
        if sender_id:
            where.append("d.sender_id = ?"); args.append(sender_id)
        if year:
            where.append("substr(COALESCE(d.doc_date, d.created_at),1,4) = ?")
            args.append(str(year))
        if inbox:
            where.append("d.reviewed = 0")
        rows = self.con.execute(
            f"""SELECT d.id, d.created_at, d.doc_date, d.title, d.doc_type,
                       d.sender_id, d.sender_name, d.language, d.summary,
                       d.tags, d.pages, d.batch, d.reviewed, d.duplicate_of,
                       d.dup_reason, d.amount, d.currency, d.due_date,
                       d.invoice_ref, d.flags, d.thumb_path, d.pending
                FROM documents d WHERE {' AND '.join(where)}
                ORDER BY COALESCE(d.doc_date, d.created_at) DESC, d.id DESC
                LIMIT ? OFFSET ?""", args + [limit, offset]).fetchall()
        return rows_to_dicts(rows)

    def get_document(self, id):
        doc = self.con.execute("SELECT * FROM documents WHERE id=?",
                               (id,)).fetchone()
        if not doc:
            raise ValueError(f"no document {id}")
        d = dict(doc)
        d["pdf_abs"] = os.path.join(self.cfg["data_root"], "archive",
                                    d["pdf_path"]) if d["pdf_path"] else None
        d["pages_detail"] = rows_to_dicts(self.con.execute(
            """SELECT page_no, scan_order, is_blank, marker,
                      substr(text,1,400) AS text_head
               FROM pages WHERE document_id=? ORDER BY COALESCE(page_no, 999),
               scan_order""", (id,)))
        inv = self.con.execute("SELECT * FROM invoices WHERE document_id=?",
                               (id,)).fetchone()
        d["invoice"] = dict(inv) if inv else None
        if inv:
            if inv["paid_account_id"]:
                acc = self.con.execute(
                    "SELECT holder, bank FROM bank_accounts WHERE id=?",
                    (inv["paid_account_id"],)).fetchone()
                if acc:
                    d["invoice"]["paid_account"] = ", ".join(
                        v for v in (acc["holder"], acc["bank"]) if v)
            d["invoice"]["chain"] = rows_to_dicts(self.con.execute(
                """SELECT i.*, dd.title AS doc_title, dd.id AS doc_id
                   FROM invoices i JOIN documents dd ON dd.id=i.document_id
                   WHERE i.id IN (%s) ORDER BY i.reminder_level"""
                % ",".join(map(str, invoices.chain_ids(self.con, inv["id"])))))
        dup_ids = [r["id"] for r in self.con.execute(
            "SELECT id FROM documents WHERE duplicate_of=?", (id,))]
        d["duplicates"] = dup_ids
        d["refs"] = rows_to_dicts(self.con.execute(
            "SELECT kind, value FROM doc_refs WHERE document_id=?", (id,)))
        d["related"] = rows_to_dicts(db.related_documents(self.con, id))
        d["timeline"] = self.timeline(id)
        return d

    def timeline(self, id):
        """All dated happenings around a document: its own dates, dates of
        other documents it mentions, its invoice chain, related documents."""
        doc = self.con.execute("SELECT * FROM documents WHERE id=?",
                               (id,)).fetchone()
        if not doc:
            return []
        ev = []

        def add(date, label, kind, doc_id=None):
            if date:
                ev.append({"date": str(date)[:10], "label": label,
                           "kind": kind, "document_id": doc_id})

        add(doc["doc_date"], doc["title"] or doc["doc_type"], "self", id)
        add(doc["created_at"], "scanned", "scan", id)
        try:
            for rd in json.loads(doc["ai_json"] or "{}").get("ref_dates", []):
                add(rd.get("date"), rd.get("label") or "mentioned date",
                    "mentioned", id)
        except json.JSONDecodeError:
            pass
        inv = self.con.execute("SELECT * FROM invoices WHERE document_id=?",
                               (id,)).fetchone()
        if inv:
            for cid in invoices.chain_ids(self.con, inv["id"]):
                m = self.con.execute(
                    """SELECT i.*, dd.doc_date AS ddate, dd.title AS dtitle,
                              dd.id AS did FROM invoices i
                       JOIN documents dd ON dd.id = i.document_id
                       WHERE i.id=?""", (cid,)).fetchone()
                label = ("invoice" if m["reminder_level"] == 0
                         else f"reminder {m['reminder_level']}")
                if m["did"] != id:
                    add(m["ddate"], f"{label}: {m['dtitle'] or ''}".strip(),
                        "chain", m["did"])
                add(m["due_date"], f"due ({label})", "due", m["did"])
                if m["paid_at"]:
                    add(m["paid_at"],
                        "paid" if m["status"] == "paid" else "do not pay",
                        "paid", m["did"])
        for r in db.related_documents(self.con, id):
            add(r["doc_date"] or r["created_at"],
                f"{r['doc_type']}: {r['title'] or ''} ({r['kind']} {r['value']})",
                "related", r["id"])
        # dedup identical entries, sort chronologically
        seen, out = set(), []
        for e in sorted(ev, key=lambda e: e["date"]):
            key = (e["date"], e["label"], e["document_id"])
            if key not in seen:
                seen.add(key)
                out.append(e)
        return out

    def update_document(self, id, **fields):
        allowed = {"title", "doc_type", "doc_date", "recipient", "summary",
                   "reviewed", "amount", "currency", "due_date", "invoice_ref"}
        sets, args = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k}=?"); args.append(v)
            elif k == "tags":
                tags = [str(t).strip().lower() for t in v if str(t).strip()]
                sets += ["tags=?", "tags_text=?"]
                args += [json.dumps(tags), db.fold(" ".join(tags))]
            elif k == "sender_name":
                from .ai import slugify
                sid = db.upsert_sender(self.con, slugify(v), v) if v else None
                sets += ["sender_id=?", "sender_name=?"]
                args += [sid, db.fold(v or "")]
        if sets:
            self.con.execute(f"UPDATE documents SET {', '.join(sets)} WHERE id=?",
                             args + [id])
            self.con.commit()
        return self.get_document(id)

    def trash_document(self, id):
        self.con.execute("UPDATE documents SET status='trash' WHERE id=?", (id,))
        self.con.commit()
        return True

    # -- senders / invoices -------------------------------------------------
    def list_senders(self):
        return rows_to_dicts(self.con.execute(
            """SELECT s.*, COUNT(d.id) AS doc_count,
                      MAX(COALESCE(d.doc_date, d.created_at)) AS last_doc
               FROM senders s LEFT JOIN documents d
                    ON d.sender_id = s.id AND d.status != 'trash'
               GROUP BY s.id ORDER BY doc_count DESC"""))

    def list_invoices(self, status=None):
        # reminder_count / max_reminder_level come precomputed per chain
        return rows_to_dicts(invoices.list_invoices(self.con, status=status))

    def invoice_paid(self, id, note=None, account_id=None, paid_date=None):
        invoices.mark_paid(self.con, id, note,
                           account_id=account_id, paid_date=paid_date)
        return True

    def invoice_do_not_pay(self, id, note=None):
        invoices.mark_do_not_pay(self.con, id, note)
        return True

    def invoice_reopen(self, id):
        invoices.reopen(self.con, id)
        return True

    # -- bank accounts ------------------------------------------------------
    def list_bank_accounts(self):
        return rows_to_dicts(self.con.execute(
            "SELECT * FROM bank_accounts ORDER BY id"))

    def save_bank_account(self, id=None, holder=None, bank=None, iban=None):
        holder, bank, iban = ((v or "").strip() for v in (holder, bank, iban))
        if not holder:
            raise ValueError("account holder is required")
        if iban:
            # stored compact uppercase (like senders.iban); UI regroups by 4
            iban = re.sub(r"\s+", "", iban).upper()
            if not (15 <= len(iban) <= 34 and qrbill.iban_valid(iban)):
                raise ValueError(f"not a valid IBAN: {iban}")
        if id:
            self.con.execute(
                "UPDATE bank_accounts SET holder=?, bank=?, iban=? WHERE id=?",
                (holder, bank or None, iban or None, id))
        else:
            self.con.execute(
                "INSERT INTO bank_accounts(holder, bank, iban) VALUES (?,?,?)",
                (holder, bank or None, iban or None))
        self.con.commit()
        return self.list_bank_accounts()

    def delete_bank_account(self, id):
        # past payments keep their row but drop the link (ON DELETE SET NULL)
        self.con.execute("DELETE FROM bank_accounts WHERE id=?", (id,))
        self.con.commit()
        return True

    def render_qr(self, invoice_id):
        """Swiss QR as data-URI PNG with the Swiss-cross overlay, for paying
        by scanning the screen with a banking app."""
        row = self.con.execute(
            "SELECT qr_payload, amount, amount_due FROM invoices WHERE id=?",
            (invoice_id,)).fetchone()
        if not row or not row["qr_payload"]:
            raise ValueError("no QR payload stored for this invoice")
        payload = row["qr_payload"]
        # after reminders the amount due includes fees -- update the SPC
        # amount line so the banking app prefills what is actually owed
        if row["amount_due"] and row["amount"] and \
                abs(row["amount_due"] - row["amount"]) >= 0.01:
            nl = "\r\n" if "\r\n" in payload else "\n"
            lines = payload.split(nl)
            if len(lines) > 19:
                lines[18] = f"{row['amount_due']:.2f}"
                payload = nl.join(lines)
        png = subprocess.run(
            ["qrencode", "-t", "PNG", "-l", "M", "-s", "10", "-m", "4", "-o", "-"],
            input=payload.encode(), capture_output=True, check=True).stdout
        png = self._swiss_cross(png)
        return "data:image/png;base64," + base64.b64encode(png).decode()

    @staticmethod
    def _swiss_cross(png_bytes):
        """Center the 7/46 Swiss cross per the IG (ECC level M absorbs it)."""
        import io
        from PIL import Image, ImageDraw
        im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        w = im.size[0]
        s = int(w * 7 / 46)
        cx = cy = w // 2
        d = ImageDraw.Draw(im)
        d.rectangle([cx - s // 2, cy - s // 2, cx + s // 2, cy + s // 2],
                    fill="black", outline="white", width=max(1, s // 24))
        arm, thick = int(s * 0.58), int(s * 0.18)
        d.rectangle([cx - thick // 2, cy - arm // 2,
                     cx + thick // 2, cy + arm // 2], fill="white")
        d.rectangle([cx - arm // 2, cy - thick // 2,
                     cx + arm // 2, cy + thick // 2], fill="white")
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue()

    # -- misc ---------------------------------------------------------------
    @staticmethod
    def _pgrep(pattern):
        r = subprocess.run(["pgrep", "-f", pattern],
                           capture_output=True, text=True)
        return [int(p) for p in r.stdout.split()]

    def scan_now(self):
        """Start a scan of whatever is in the feeder -- SIGUSR1 is
        scan_buttond's documented scan-request signal."""
        import signal
        pids = self._pgrep(r"python.*scan[-_]buttond")
        if not pids:
            raise RuntimeError("scanner daemon (scan-buttond) is not running")
        for pid in pids:
            os.kill(pid, signal.SIGUSR1)
        return True

    def abort_scan(self):
        """The app's Abort button: stop everything in flight and delete
        all temp scans. Covers every stage -- the scan in progress
        (buttond kills scanimage and deletes its partial batch, SIGUSR2),
        the background understanding queue (watchd kills the OCR/AI
        child and deletes every document still pending='queued' -- row,
        PDF, thumbnail, originals; SIGUSR1), and whatever is
        waiting/queued on disk. Fully processed documents are
        untouched."""
        import glob
        import signal
        import time
        sd = self.cfg["scans_dir"]
        tmpdir = os.path.join(self.cfg["data_root"], "tmp")

        def kill(pids, sig):
            for pid in pids:
                try:
                    os.kill(pid, sig)
                except ProcessLookupError:
                    pass

        kill(self._pgrep(r"python.*scan[-_]buttond"), signal.SIGUSR2)
        watchd_pids = self._pgrep(r"python.*docdoc\.watchd")
        kill(watchd_pids, signal.SIGUSR1)
        time.sleep(1.5)     # let the daemons kill children, release dirs

        removed = []
        if os.path.isdir(sd):
            for name in sorted(os.listdir(sd)):
                p = os.path.join(sd, name)
                if os.path.isdir(p) and not name.startswith("."):
                    shutil.rmtree(p, ignore_errors=True)
                    removed.append(name)
            try:
                os.unlink(os.path.join(sd, ".scanning"))
            except OSError:
                pass
        if os.path.isdir(tmpdir):
            for p in glob.glob(os.path.join(tmpdir, "*.progress.json")):
                try:
                    os.unlink(p)
                except OSError:
                    pass
            for p in glob.glob(os.path.join(tmpdir, "*")):
                if os.path.isdir(p):
                    shutil.rmtree(p, ignore_errors=True)
        # watchd may have picked up a batch during the sleep, after the
        # first signal -- abort again now that the batch dirs are gone
        kill(watchd_pids, signal.SIGUSR1)

        db.event(self.con, "abort",
                 "scan aborted from the app"
                 + (f" -- deleted {len(removed)} batch(es): "
                    + ", ".join(removed) if removed else ""))
        return {"removed_batches": removed}

    def status(self):
        """In-flight scanner/pipeline activity for the UI progress strip.
        scanning: EXPLICIT signal only -- scan_buttond maintains a
        <scans_dir>/.scanning flag for the duration of a scan (a stale flag
        from a crashed daemon is ignored after 15 min);
        waiting: unmarked batch dir the watcher will pick up on settle;
        queued: .batch-done written but not ingested yet, plus documents
        sitting in the background understanding queue (pending='queued');
        processing: per-stage progress file written by the pipeline, with a
        batch-start-event fallback for runs that write none;
        watcher_alive/scanner_alive: daemon health for the status bar;
        scanner_online: buttond's .scanner-online flag -- the device is
        actually attached (only meaningful while scanner_alive)."""
        import datetime
        import glob
        import time
        sd = self.cfg["scans_dir"]
        tmpdir = os.path.join(self.cfg["data_root"], "tmp")
        now = time.time()

        scanning = []
        flag = os.path.join(sd, ".scanning")
        try:
            if now - os.path.getmtime(flag) < 900:
                with open(flag) as f:
                    name = f.read().strip() or "scan"
                try:
                    pages = len([x for x in os.listdir(os.path.join(sd, name))
                                 if not x.startswith(".")])
                except OSError:
                    pages = 0
                scanning.append({"batch": name, "pages": pages})
        except OSError:
            pass
        scanning_names = {s["batch"] for s in scanning}

        processing = []
        for p in glob.glob(os.path.join(tmpdir, "*.progress.json")):
            if now - os.path.getmtime(p) > 900:
                continue
            try:
                with open(p) as f:
                    prog = json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
            processing.append(
                {"batch": os.path.basename(p)[:-len(".progress.json")],
                 "label": prog.get("label"), "pct": prog.get("pct"),
                 "ceil": prog.get("ceil")})
        prog_names = {p["batch"] for p in processing}
        # the background understanding queue: ingested documents whose
        # OCR/AI has not run yet (the active one has a progress file)
        pending = [r["batch"] or f"#{r['id']}" for r in self.con.execute(
            "SELECT id, batch FROM documents WHERE pending='queued' ORDER BY id")]
        pending_queued = [b for b in pending if b not in prog_names]

        # fallback: batch-start event without a terminal event (CLI runs,
        # older pipeline) -- no percentage available
        cutoff = (datetime.datetime.now()
                  - datetime.timedelta(minutes=30)).isoformat(timespec="seconds")
        state = {}
        for r in self.con.execute(
                """SELECT batch, kind FROM events
                   WHERE (batch IS NOT NULL OR kind='abort') AND at > ?
                   ORDER BY id""", (cutoff,)):
            if r["kind"] == "abort":
                # an abort kills everything in flight and is logged with
                # batch=NULL -- it must terminate every started batch, or
                # the aborted batch ghosts as "processing" for 30 min and
                # the app's Abort button sticks at "Aborting…"
                for b in state:
                    state[b] = False
            elif r["kind"] == "batch-start":
                state[r["batch"]] = True
            elif r["kind"] in ("document", "error"):
                state[r["batch"]] = False
        processing += [{"batch": b, "label": None, "pct": None, "ceil": None}
                       for b, v in state.items()
                       if v and b not in prog_names and b not in pending_queued]
        prog_names = {p["batch"] for p in processing}

        waiting, queued = [], []
        if os.path.isdir(sd):
            for name in sorted(os.listdir(sd)):
                p = os.path.join(sd, name)
                if not os.path.isdir(p) or name.startswith(".") \
                        or name in scanning_names or name in prog_names:
                    continue
                if os.path.exists(os.path.join(p, ".batch-done")):
                    queued.append(name)
                else:
                    waiting.append(name)
        queued += pending_queued

        return {"scanning": scanning, "waiting": waiting, "queued": queued,
                "processing": processing,
                "watcher_alive": bool(self._pgrep(r"python.*docdoc\.watchd")),
                "scanner_alive": bool(self._pgrep(r"python.*scan[-_]buttond")),
                "scanner_online": os.path.exists(
                    os.path.join(sd, ".scanner-online")),
                "busy": bool(scanning or waiting or queued or processing)}

    def list_events(self, limit=100):
        return rows_to_dicts(self.con.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)))

    def stats(self):
        docs = self.con.execute(
            "SELECT COUNT(*) c FROM documents WHERE status!='trash'").fetchone()["c"]
        inbox = self.con.execute(
            "SELECT COUNT(*) c FROM documents WHERE status!='trash' AND reviewed=0"
        ).fetchone()["c"]
        # one count per chain root (original invoice OR orphan reminder --
        # a reminder whose original was never scanned is still unpaid money)
        unpaid = self.con.execute(
            """SELECT COUNT(*) c, COALESCE(SUM(i.amount_due),0) s
               FROM invoices i JOIN documents d ON d.id = i.document_id
               WHERE i.status IN ('open','reminded')
                 AND i.parent_invoice_id IS NULL
                 AND i.is_notification=0 AND d.status != 'trash'""").fetchone()
        overdue = self.con.execute(
            """SELECT COUNT(*) c
               FROM invoices i JOIN documents d ON d.id = i.document_id
               WHERE i.status IN ('open','reminded')
                 AND i.parent_invoice_id IS NULL
                 AND i.is_notification=0 AND d.status != 'trash'
                 AND i.due_date < date('now')""").fetchone()["c"]
        types = rows_to_dicts(self.con.execute(
            """SELECT doc_type, COUNT(*) n FROM documents WHERE status!='trash'
               GROUP BY doc_type ORDER BY n DESC"""))
        return {"documents": docs, "inbox": inbox, "unpaid_count": unpaid["c"],
                "unpaid_total": unpaid["s"], "overdue": overdue, "types": types}

    def get_settings(self):
        return self.cfg

    def set_settings(self, **kv):
        cfg = config.load()
        cfg.update({k: v for k, v in kv.items() if k in config.DEFAULTS})
        config.save(cfg)
        self.cfg = config.load()
        return self.cfg

    def years(self):
        return [r[0] for r in self.con.execute(
            """SELECT DISTINCT substr(COALESCE(doc_date, created_at),1,4)
               FROM documents WHERE status!='trash' ORDER BY 1 DESC""")]


def poller():
    """Push {'event':'changed'} when another process commits."""
    import time
    con = db.connect()
    last = None
    while True:
        try:
            v = con.execute("PRAGMA data_version").fetchone()[0]
            if last is not None and v != last:
                send({"event": "changed"})
            last = v
        except Exception:
            pass
        time.sleep(1)


def main():
    api = Api()
    threading.Thread(target=poller, daemon=True).start()
    send({"event": "ready", "version": 1})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = getattr(api, req["method"], None)
            if method is None or req["method"].startswith("_"):
                raise ValueError(f"unknown method {req['method']!r}")
            result = method(**(req.get("params") or {}))
            send({"id": req_id, "result": result})
        except Exception as e:
            send({"id": req_id, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
