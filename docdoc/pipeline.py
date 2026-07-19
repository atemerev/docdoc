"""Two-stage processing pipeline: a directory of scanned page images
becomes a filed, searchable, understood document.

Stage 1, ingest (fast, seconds): images -> raw PDF, filed under a
provisional archive name with a thumbnail and a document row marked
pending='queued' -- the PDF is visible in the app immediately after the
scan.

Stage 2, understand (slow, background queue in watchd): QR decode ->
OCR (searchable PDF/A + per-page text) -> blank-page drop -> AI
understanding -> page-order check -> dedup -> sender upsert -> metadata
update + final archive filename -> invoice lifecycle. pending flips to
NULL (done) or 'error'.

One batch directory == one document (separator-page splitting is on the
roadmap). Ingest failures move the batch to <data_root>/failed/ with an
event; understand failures keep the document with its raw PDF and set
pending='error'.
"""

import datetime
import glob
import json
import os
import shutil
import subprocess
import threading

from . import ai, db, dedup, invoices, ocr, pageorder, qrbill


class BatchAborted(Exception):
    """User hit Abort: raised between stages once the abort flag is set
    (long-running children are killed by request_abort, making the
    current stage return early)."""


_ABORT = threading.Event()


def request_abort():
    """Abort everything in flight. Sets the flag consulted between
    stages and kills this process's children (ocrmypdf, claude, ...) so
    the running stage ends promptly. Safe to call from a signal handler;
    watchd's worker turns the flag into BatchAborted and deletes the
    in-flight documents."""
    _ABORT.set()
    subprocess.run(["pkill", "-TERM", "-P", str(os.getpid())],
                   capture_output=True)


def aborted():
    return _ABORT.is_set()


def clear_abort():
    _ABORT.clear()


def check_abort():
    if _ABORT.is_set():
        raise BatchAborted()


def log(msg):
    print(msg, flush=True)


def _progress_path(cfg, batch):
    return os.path.join(cfg["data_root"], "tmp", f"{batch}.progress.json")


def progress(cfg, batch, stage, label, pct, ceil):
    """Best-effort stage marker for the app's progress bar: pct is where
    this stage starts, ceil where it ends (the UI creeps in between).
    Doubles as the between-stages abort checkpoint."""
    check_abort()
    path = _progress_path(cfg, batch)
    try:
        with open(path + ".tmp", "w") as f:
            json.dump({"stage": stage, "label": label, "pct": pct,
                       "ceil": ceil,
                       "at": datetime.datetime.now().isoformat(timespec="seconds")},
                      f)
        os.replace(path + ".tmp", path)
    except OSError:
        pass


def clear_progress(cfg, batch):
    try:
        os.unlink(_progress_path(cfg, batch))
    except OSError:
        pass


def batch_images(batch_dir):
    imgs = []
    for pat in ("*.jpg", "*.jpeg", "*.png", "*.tif", "*.tiff", "*.pnm"):
        imgs.extend(glob.glob(os.path.join(batch_dir, pat)))
    return sorted(imgs)


def archive_name(ext, doc_id, title):
    date = ext.get("doc_date") or datetime.date.today().isoformat()
    year = date[:4]
    title_slug = ai.slugify(title or ext.get("doc_type") or "document")[:48]
    fname = f"{date}_{ext.get('sender_key') or 'unknown'}_{title_slug}_{doc_id:05d}.pdf"
    return os.path.join(year, fname)


# ------------------------------------------------------------- stage 1
def ingest_batch(cfg, con, batch_dir):
    """Fast foreground stage: the scanned pages become a filed, viewable
    document within seconds. Returns the document id (pending='queued',
    to be picked up by the background queue) or None (empty batch)."""
    batch = os.path.basename(batch_dir.rstrip("/"))
    images = batch_images(batch_dir)
    if not images:
        log(f"pipeline: {batch}: no images, skipping")
        return None
    log(f"pipeline: {batch}: ingesting {len(images)} page image(s)")
    db.event(con, "batch-start", f"ingesting {len(images)} page(s)", batch=batch)

    workdir = os.path.join(cfg["data_root"], "tmp", batch)
    os.makedirs(workdir, exist_ok=True)
    dest = None
    try:
        raw_pdf = os.path.join(workdir, "raw.pdf")
        ocr.images_to_pdf(images, raw_pdf)
        now = datetime.datetime.now().isoformat(timespec="seconds")
        cur = con.execute(
            """INSERT INTO documents(created_at, pages, batch, status, pending)
               VALUES (?,?,?,'inbox','queued')""",
            (now, len(images), batch))
        doc_id = cur.lastrowid
        rel = archive_name({}, doc_id, batch.replace("_", "-"))
        dest = os.path.join(cfg["data_root"], "archive", rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(raw_pdf, dest)
        thumb_rel = f"{doc_id:05d}.jpg"
        try:
            ocr.thumbnail(dest, os.path.join(cfg["data_root"], "thumbs", thumb_rel))
        except ocr.OcrError:
            thumb_rel = None
        con.execute("UPDATE documents SET pdf_path=?, thumb_path=? WHERE id=?",
                    (rel, thumb_rel, doc_id))
        con.commit()
        log(f"pipeline: {batch}: visible as document #{doc_id} (archive/{rel})")
        return doc_id
    except Exception:
        con.rollback()
        if dest:
            try:
                os.unlink(dest)
            except OSError:
                pass
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ------------------------------------------------------------- stage 2
def process_document(cfg, con, doc_id, images_dir=None):
    """Slow background stage: OCR, AI understanding, page order, dedup,
    invoice lifecycle. The document already exists with its raw PDF;
    this fills in text + metadata and finalizes the archive filename.
    Page images come from originals/<batch> unless images_dir overrides;
    a missing directory degrades gracefully (no blank-page detection,
    text-only AI)."""
    doc = con.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not doc:
        raise ValueError(f"no document {doc_id}")
    batch = doc["batch"] or f"doc-{doc_id}"
    if images_dir is None:
        images_dir = os.path.join(cfg["data_root"], "originals", doc["batch"] or "")
    images = batch_images(images_dir) if os.path.isdir(images_dir) else []
    raw_pdf = os.path.join(cfg["data_root"], "archive", doc["pdf_path"])
    workdir = os.path.join(cfg["data_root"], "tmp", batch)
    os.makedirs(workdir, exist_ok=True)
    try:
        return _understand(cfg, con, doc, images, raw_pdf, workdir)
    except BatchAborted:
        raise
    except Exception:
        if aborted():           # stage child was killed by an abort
            raise BatchAborted(batch)
        raise
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        clear_progress(cfg, batch)


def _understand(cfg, con, doc, images, raw_pdf, workdir):
    doc_id, batch = doc["id"], doc["batch"]
    n = doc["pages"] or len(images)

    # 1. Swiss QR-bill (from original images -- best resolution)
    progress(cfg, batch, "qr", "reading QR code", 2, 10)
    qr = qrbill.find_qrbill(images) if images else None
    if qr:
        log(f"pipeline: {batch}: QR-bill found "
            f"({qr.get('creditor', {}).get('name')}, "
            f"{qr.get('amount')} {qr.get('currency')})")

    # 2. OCR the already-filed raw PDF
    ocr_pdf_path = os.path.join(workdir, "ocr.pdf")
    progress(cfg, batch, "ocr", f"OCR, {n} page(s)", 12, 55)
    _, page_texts = ocr.ocr_pdf(raw_pdf, ocr_pdf_path,
                                languages=cfg["ocr_languages"])
    check_abort()
    # ocrmypdf sidecar pages should match input pages; be defensive
    while len(page_texts) < n:
        page_texts.append("")
    # originals gone (crash recovery + keep_originals=False): text-only mode
    imgs = images if len(images) == n else [None] * n

    # 3. blank pages
    blanks = set()
    if cfg.get("blank_page_drop", True) and n > 1:
        for i, (text, img) in enumerate(zip(page_texts, imgs)):
            if ocr.is_blank(text, img, min_chars=int(cfg["min_chars_nonblank"])):
                blanks.add(i)
        if len(blanks) == n:
            blanks = set()          # never drop everything
    flags = []
    kept = [i for i in range(n) if i not in blanks]
    if blanks:
        flags.append(f"blank-dropped:{len(blanks)}")

    # 4. AI understanding -- the model *reads* the page images (in scan
    # order) and reports metadata, internal references AND the correct
    # reading order. Regex heuristics only run in no-AI degraded mode.
    known = [r["key"] for r in con.execute("SELECT key FROM senders")]
    scan_content = "\n\f\n".join(page_texts[i] for i in kept)
    progress(cfg, batch, "ai", "AI reading the document", 58, 90)
    ext, provider = ai.extract(cfg, [imgs[i] for i in kept if imgs[i]],
                               scan_content, qr=qr, known_senders=known)
    check_abort()   # a killed claude falls back to heuristics -- don't file that
    log(f"pipeline: {batch}: [{provider}] {ext['doc_type']} from "
        f"{ext.get('sender_name')}: {ext.get('title')!r}")

    # 5. page order: AI judgement, page-number markers as cross-check
    marker_order, oflags = pageorder.check_order(
        [page_texts[i] for i in kept])
    ai_order = ext.get("page_order")
    if ai_order and len(ai_order) == len(kept):
        if marker_order and marker_order != ai_order:
            flags.append("order-conflict-markers-vs-ai")
        kept = [kept[p - 1] for p in ai_order]
        flags.append("page-order-fixed:ai")
        log(f"pipeline: {batch}: AI corrected page order -> "
            f"{[i + 1 for i in kept]}")
    elif provider != "heuristic" and marker_order:
        # AI saw the pages and found the order fine; markers disagree
        flags.append("order-uncertain:markers-disagree-with-ai")
    elif provider == "heuristic":
        flags += oflags
        if marker_order:
            kept = [kept[p - 1] for p in marker_order]
            log(f"pipeline: {batch}: page order corrected by markers -> "
                f"{[i + 1 for i in kept]}")

    final_pdf = os.path.join(workdir, "final.pdf")
    if kept != list(range(n)):
        ocr.rebuild_pdf(ocr_pdf_path, final_pdf, [i + 1 for i in kept])
    else:
        final_pdf = ocr_pdf_path

    kept_texts = [page_texts[i] for i in kept]
    content = "\n\f\n".join(kept_texts)

    # 6. dedup (on the final ordered content)
    progress(cfg, batch, "file", "checking duplicates + filing", 92, 100)
    sha = dedup.file_sha256(final_pdf)
    thash = dedup.text_hash(content)
    dup_of, dup_reason = dedup.find_duplicates(con, sha, thash, content)
    if dup_reason and dup_reason.startswith("similar:"):
        flags.append(f"possible-duplicate:{dup_reason.split(':')[1]}")
        dup_reason_col = "similar"
    else:
        dup_reason_col = dup_reason

    # reference-based duplicate: same doc type + same extracted internal
    # reference + broadly similar text = same paper, rescanned or copied
    if not dup_of:
        rid, rreason = dedup.ref_duplicate(con, ext, content)
        if rid:
            dup_of, dup_reason_col = rid, rreason

    # 7. sender
    sender_id = None
    if ext.get("sender_key") and ext["sender_key"] != "unknown":
        sender_id = db.upsert_sender(
            con, ext["sender_key"], ext.get("sender_name") or ext["sender_key"],
            uid=(qr or {}).get("swico", {}).get("uid") if qr and qr.get("swico") else None,
            iban=(qr or {}).get("iban"),
            address=(qr or {}).get("creditor"))

    # 8. replace the provisional archive file with the final OCR'd PDF
    # under its real name (file first, then commit the paths -- a crash
    # in between leaves both files, never a dangling pdf_path)
    old_rel = doc["pdf_path"]
    rel = archive_name(ext, doc_id, ext.get("title"))
    dest = os.path.join(cfg["data_root"], "archive", rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(final_pdf, dest)
    thumb_rel = f"{doc_id:05d}.jpg"
    try:
        ocr.thumbnail(dest, os.path.join(cfg["data_root"], "thumbs", thumb_rel))
    except ocr.OcrError:
        thumb_rel = doc["thumb_path"]

    # 9. document metadata (row was inserted at ingest)
    tags_text = " ".join(ext["tags"])
    con.execute(
        """UPDATE documents SET doc_date=?, title=?, doc_type=?, sender_id=?,
               sender_name=?, recipient=?, language=?, summary=?, tags=?,
               tags_text=?, pdf_path=?, thumb_path=?, pages=?, content=?,
               file_sha256=?, text_hash=?, duplicate_of=?, dup_reason=?,
               amount=?, currency=?, due_date=?, invoice_ref=?, ai_json=?,
               flags=?, pending=NULL
           WHERE id=?""",
        (ext.get("doc_date"), ext.get("title"), ext["doc_type"], sender_id,
         db.fold(ext.get("sender_name") or ""), ext.get("recipient_name"),
         ext.get("language"), ext.get("summary_en"), json.dumps(ext["tags"]),
         db.fold(tags_text), rel, thumb_rel, len(kept), db.fold(content),
         sha, thash, dup_of, dup_reason_col, ext.get("amount"),
         ext.get("currency"), ext.get("due_date"), ext.get("invoice_ref"),
         json.dumps(ext), json.dumps(flags), doc_id))

    # 9b. internal references -- the glue that links related documents
    refs = [(r["kind"], r["value"]) for r in ext.get("refs", [])]
    if ext.get("invoice_ref"):
        refs.append(("invoice_no", ext["invoice_ref"]))
    if qr and qr.get("reference"):
        refs.append(("qr_reference", qr["reference"]))
    if qr and qr.get("swico") and qr["swico"].get("customer_ref"):
        refs.append(("customer_no", qr["swico"]["customer_ref"]))
    con.execute("DELETE FROM doc_refs WHERE document_id=?", (doc_id,))
    db.add_refs(con, doc_id, refs)

    # 10. pages
    con.execute("DELETE FROM pages WHERE document_id=?", (doc_id,))
    for final_pos, scan_idx in enumerate(kept, start=1):
        con.execute(
            """INSERT INTO pages(document_id, page_no, scan_order, text,
                   is_blank, marker) VALUES (?,?,?,?,0,?)""",
            (doc_id, final_pos, scan_idx + 1, kept_texts[final_pos - 1],
             str(pageorder.page_marker(kept_texts[final_pos - 1]) or "")))
    for scan_idx in sorted(blanks):
        con.execute(
            """INSERT INTO pages(document_id, page_no, scan_order, text,
                   is_blank, marker) VALUES (?,NULL,?,?,1,'')""",
            (doc_id, scan_idx + 1, page_texts[scan_idx]))
    con.commit()
    if old_rel and old_rel != rel:
        try:
            os.unlink(os.path.join(cfg["data_root"], "archive", old_rel))
        except OSError:
            pass

    # 11. invoice lifecycle (not for hard duplicates -- no double counting)
    if (ext["doc_type"] in ("invoice", "reminder") or qr) and not dup_of:
        inv_id, notes = invoices.record_invoice(con, cfg, doc_id, sender_id,
                                                ext, qr)
        for n_ in notes:
            db.event(con, "invoice", n_, batch=batch, document_id=doc_id)

    msg = (f"{ext['doc_type']} '{ext.get('title')}' from "
           f"{ext.get('sender_name') or '?'} ({len(kept)} page(s))")
    if dup_of:
        msg += f" -- DUPLICATE of #{dup_of} ({dup_reason_col})"
    db.event(con, "document", msg, batch=batch, document_id=doc_id)
    log(f"pipeline: {batch}: filed as archive/{rel}"
        + (f" (duplicate of #{dup_of})" if dup_of else ""))
    return doc_id


def process_batch(cfg, con, batch_dir):
    """Synchronous convenience for the CLI and tests: ingest + understand
    in one call, reading images from the batch directory itself."""
    doc_id = ingest_batch(cfg, con, batch_dir)
    if doc_id is None:
        return None
    return process_document(cfg, con, doc_id, images_dir=batch_dir)


def finish_batch(cfg, batch_dir, success, keep=None):
    """Move originals to originals/ (or failed/), per config. keep=True
    forces keeping (watchd ingest: the background stage still needs the
    page images; keep_originals is applied after understanding)."""
    batch = os.path.basename(batch_dir.rstrip("/"))
    if not os.path.isdir(batch_dir):    # deleted by an abort mid-batch
        return None
    if not success:
        dest = os.path.join(cfg["data_root"], "failed", batch)
        shutil.move(batch_dir, dest)
        return dest
    if keep is None:
        keep = cfg.get("keep_originals", True)
    if keep:
        dest = os.path.join(cfg["data_root"], "originals", batch)
        shutil.move(batch_dir, dest)
        return dest
    shutil.rmtree(batch_dir)
    return None
