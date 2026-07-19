"""docdocd -- watches the scans directory and processes completed batches.

A batch is ready when it contains a `.batch-done` marker (written by
scan_buttond after a scan finishes) or, as a fallback for batches from
other sources, when the newest file is older than SETTLE_SECONDS.

Two-stage flow: the main loop ingests ready batches immediately (raw
PDF filed and visible in the app within seconds) and enqueues them for
a background worker thread that runs OCR + AI one document at a time.
The queue is persistent -- documents.pending='queued' is re-enqueued on
restart. Ingested originals are moved to originals/ (kept until the
background stage ran, then keep_originals applies); ingest failures
move the batch to failed/.

SIGUSR1 (the app's Abort button) aborts everything in flight: the
worker's current stage is interrupted (children killed) and every
document still pending is deleted -- row, archive PDF, thumbnail and
originals. Completed documents are never touched.
"""

import os
import queue
import shutil
import signal
import subprocess
import threading
import time

from . import config, db, pipeline

MARKER = ".batch-done"
SETTLE_SECONDS = 90
POLL_SECONDS = 2

_queue = queue.Queue()


def notify(summary, body=""):
    if shutil.which("notify-send"):
        subprocess.run(["notify-send", "-a", "docdoc", summary, body],
                       check=False)


def batch_ready(path):
    if os.path.exists(os.path.join(path, MARKER)):
        return True
    try:
        newest = max(os.path.getmtime(os.path.join(path, f))
                     for f in os.listdir(path))
    except ValueError:
        # empty dir (aborted scan): judge by the dir itself so it gets
        # cleaned up instead of sitting in "waiting" forever
        newest = os.path.getmtime(path)
    except OSError:
        return False                    # dir vanished (abort sweep)
    return time.time() - newest > SETTLE_SECONDS


def run_once(cfg, con):
    scans = cfg["scans_dir"]
    if not os.path.isdir(scans):
        return 0
    handled = 0
    for name in sorted(os.listdir(scans)):
        batch_dir = os.path.join(scans, name)
        if not os.path.isdir(batch_dir) or name.startswith("."):
            continue
        if pipeline.aborted():
            break                       # abort sweep in flight; the server
                                        # deletes the pending batch dirs
        if not batch_ready(batch_dir):
            continue
        try:
            os.unlink(os.path.join(batch_dir, MARKER))
        except OSError:
            pass
        if not pipeline.batch_images(batch_dir):
            pipeline.log(f"watchd: {name}: empty batch, removing")
            shutil.rmtree(batch_dir, ignore_errors=True)
            continue
        try:
            doc_id = pipeline.ingest_batch(cfg, con, batch_dir)
        except Exception as e:
            if pipeline.aborted():      # ingest child killed by an abort
                shutil.rmtree(batch_dir, ignore_errors=True)
                continue
            pipeline.log(f"watchd: {name}: ingest FAILED: {e!r}")
            db.event(con, "error", f"batch failed: {e}", batch=name)
            pipeline.finish_batch(cfg, batch_dir, success=False)
            notify("Document processing failed",
                   f"Batch {name} moved to failed/ — see the app's Activity tab.")
            continue
        if doc_id is None:
            shutil.rmtree(batch_dir, ignore_errors=True)
            continue
        # keep the page images until OCR/AI ran (the AI reads them);
        # the worker applies keep_originals afterwards
        pipeline.finish_batch(cfg, batch_dir, success=True, keep=True)
        _queue.put(doc_id)
        handled += 1
    return handled


def _delete_inflight(cfg, con):
    """Abort: delete every document still awaiting understanding -- row,
    archive PDF, thumbnail and original images. Filed (fully processed)
    documents are untouched."""
    con.rollback()                      # drop anything half-written
    while True:
        try:
            _queue.get_nowait()
        except queue.Empty:
            break
    rows = con.execute(
        """SELECT id, batch, pdf_path, thumb_path FROM documents
           WHERE pending='queued'""").fetchall()
    for r in rows:
        for rel, sub in ((r["pdf_path"], "archive"), (r["thumb_path"], "thumbs")):
            if rel:
                try:
                    os.unlink(os.path.join(cfg["data_root"], sub, rel))
                except OSError:
                    pass
        if r["batch"]:
            shutil.rmtree(os.path.join(cfg["data_root"], "originals", r["batch"]),
                          ignore_errors=True)
            pipeline.clear_progress(cfg, r["batch"])
        con.execute("DELETE FROM documents WHERE id=?", (r["id"],))
    con.commit()
    if rows:
        names = ", ".join(r["batch"] or f"#{r['id']}" for r in rows)
        pipeline.log(f"watchd: abort deleted {len(rows)} in-flight "
                     f"document(s): {names}")
        db.event(con, "abort",
                 f"aborted -- deleted {len(rows)} in-flight document(s)")
        notify("Processing aborted",
               f"{len(rows)} unprocessed document(s) deleted.")
    pipeline.clear_abort()


def worker():
    """Serial background queue: one document at a time through OCR + AI."""
    con = db.connect()
    while True:
        if pipeline.aborted():
            _delete_inflight(config.load(), con)
        try:
            doc_id = _queue.get(timeout=1)
        except queue.Empty:
            continue
        cfg = config.load()
        doc = con.execute(
            "SELECT id, batch FROM documents WHERE id=? AND pending='queued'",
            (doc_id,)).fetchone()
        if not doc:
            continue                    # deleted by an abort, or already done
        try:
            pipeline.process_document(cfg, con, doc_id)
            row = con.execute(
                "SELECT title, sender_name, doc_type, duplicate_of "
                "FROM documents WHERE id=?", (doc_id,)).fetchone()
            if row:
                body = (f"{row['sender_name'] or '?'} — "
                        f"{row['title'] or row['doc_type']}")
                if row["duplicate_of"]:
                    body += f" (duplicate of #{row['duplicate_of']})"
                notify("Document filed", body)
            if not cfg.get("keep_originals", True) and doc["batch"]:
                shutil.rmtree(
                    os.path.join(cfg["data_root"], "originals", doc["batch"]),
                    ignore_errors=True)
        except pipeline.BatchAborted:
            _delete_inflight(cfg, con)
        except Exception as e:
            con.rollback()
            pipeline.log(f"watchd: {doc['batch']}: understanding FAILED: {e!r}")
            db.event(con, "error", f"processing failed: {e}",
                     batch=doc["batch"], document_id=doc_id)
            con.execute("UPDATE documents SET pending='error' WHERE id=?",
                        (doc_id,))
            con.commit()
            notify("Document processing failed",
                   "The document is filed with its raw scan — "
                   "see the app's Activity tab.")


def main():
    cfg = config.load()
    con = db.connect()
    signal.signal(signal.SIGUSR1, lambda *a: pipeline.request_abort())
    # recover the queue: ingested before a restart, not yet understood
    pending = [r["id"] for r in con.execute(
        "SELECT id FROM documents WHERE pending='queued' ORDER BY id")]
    for doc_id in pending:
        _queue.put(doc_id)
    if pending:
        pipeline.log(f"docdocd: re-queued {len(pending)} pending document(s)")
    threading.Thread(target=worker, daemon=True).start()
    pipeline.log(f"docdocd: watching {cfg['scans_dir']} "
                 f"(archive: {cfg['data_root']})")
    while True:
        try:
            run_once(cfg, con)
        except Exception as e:
            pipeline.log(f"docdocd: error: {e!r}")
        time.sleep(POLL_SECONDS)
        cfg = config.load()      # pick up settings changes


if __name__ == "__main__":
    main()
