"""Duplicate detection, layered (research: paperless-ngx practice + better):

1. exact file bytes (sha256)          -> hard duplicate
2. exact normalized OCR text (sha256) -> hard duplicate (same paper, re-scan
                                         with identical OCR result is rare
                                         but free to check)
3. invoice fields (sender+ref+amount)  -> handled in invoices.py
4. text trigram Jaccard similarity     -> soft 'possible duplicate' flag

Never silently rejects: pipeline links duplicates to the original and
keeps them reviewable.
"""

import hashlib
import re


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_text(text):
    t = (text or "").lower().replace("ß", "ss")
    t = re.sub(r"[^a-z0-9äöüéèàâçêîôû]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def text_hash(text):
    return hashlib.sha256(normalize_text(text).encode()).hexdigest()


def trigrams(text):
    t = normalize_text(text)
    return {t[i:i + 3] for i in range(len(t) - 2)} if len(t) >= 3 else set()


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def ref_duplicate(con, ext, content, min_similarity=0.5):
    """Duplicate via understanding: two documents of the same type carrying
    the same unique internal reference (invoice/order/case number extracted
    by the AI) and broadly similar text are scans of the same paper --
    robust against OCR variance that defeats pure text similarity."""
    from .db import norm_ref
    values = [r["value"] for r in ext.get("refs", [])]
    if ext.get("invoice_ref"):
        values.append(ext["invoice_ref"])
    norms = list({n for n in (norm_ref(v) for v in values) if len(n) >= 4})
    if not norms:
        return None, None
    tg = trigrams(content)
    rows = con.execute(
        f"""SELECT DISTINCT d.id, d.content, d.doc_type FROM documents d
            JOIN doc_refs r ON r.document_id = d.id
            WHERE r.norm IN ({','.join('?' * len(norms))})
              AND d.status != 'trash'""", norms).fetchall()
    for row in rows:
        if row["doc_type"] == ext.get("doc_type") and \
                jaccard(tg, trigrams(row["content"])) >= min_similarity:
            return row["id"], "same-refs"
    return None, None


def find_duplicates(con, sha, thash, content, similar_threshold=0.75):
    """-> (duplicate_of_id, reason) hard match, or (None, 'similar:<id>')
    soft match, or (None, None)."""
    row = con.execute(
        "SELECT id FROM documents WHERE file_sha256=? AND status!='trash'",
        (sha,)).fetchone()
    if row:
        return row["id"], "exact-file"
    row = con.execute(
        "SELECT id FROM documents WHERE text_hash=? AND status!='trash'",
        (thash,)).fetchone()
    if row:
        return row["id"], "exact-text"
    tg = trigrams(content)
    if not tg:
        return None, None
    n = len(normalize_text(content))
    # candidates: comparable text length only (cheap pre-filter at
    # personal-archive scale; avoids O(n) full-text comparisons growing ugly)
    for row in con.execute(
            """SELECT id, content FROM documents
               WHERE status != 'trash' AND content IS NOT NULL
                 AND length(content) BETWEEN ? AND ?
               ORDER BY id DESC LIMIT 500""",
            (int(n * 0.6), int(n * 1.6) + 64)):
        if jaccard(tg, trigrams(row["content"])) >= similar_threshold:
            return None, f"similar:{row['id']}"
    return None, None
