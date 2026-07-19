// Duplicate detection, layered (research: paperless-ngx practice + better):
//
// 1. exact file bytes (sha256)          -> hard duplicate
// 2. exact normalized OCR text (sha256) -> hard duplicate
// 3. invoice fields (sender+ref+amount)  -> handled in invoices.js
// 4. text trigram Jaccard similarity     -> soft 'possible duplicate' flag
//
// Never silently rejects: pipeline links duplicates to the original and
// keeps them reviewable.

const crypto = require("crypto");
const fs = require("fs");
const db = require("./db");

function fileSha256(path) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(path));
  return h.digest("hex");
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/ß/g, "ss")
    .replace(/[^a-z0-9äöüéèàâçêîôû]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

const textHash = (text) =>
  crypto.createHash("sha256").update(normalizeText(text)).digest("hex");

function trigrams(text) {
  const t = normalizeText(text);
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function refDuplicate(con, ext, content, minSimilarity = 0.5) {
  // Duplicate via understanding: two documents of the same type carrying
  // the same unique internal reference (invoice/order/case number extracted
  // by the AI) and broadly similar text are scans of the same paper --
  // robust against OCR variance that defeats pure text similarity.
  const values = (ext.refs || []).map((r) => r.value);
  if (ext.invoice_ref) values.push(ext.invoice_ref);
  const norms = [...new Set(values.map(db.normRef).filter((n) => n.length >= 4))];
  if (!norms.length) return { id: null, reason: null };
  const tg = trigrams(content);
  const rows = con.prepare(
    `SELECT DISTINCT d.id, d.content, d.doc_type FROM documents d
     JOIN doc_refs r ON r.document_id = d.id
     WHERE r.norm IN (${norms.map(() => "?").join(",")})
       AND d.status != 'trash'`).all(...norms);
  for (const row of rows)
    if (row.doc_type === ext.doc_type
        && jaccard(tg, trigrams(row.content)) >= minSimilarity)
      return { id: row.id, reason: "same-refs" };
  return { id: null, reason: null };
}

function findDuplicates(con, sha, thash, content, similarThreshold = 0.75) {
  // -> { id, reason } hard match, or { id: null, reason: 'similar:<id>' }
  // soft match, or { id: null, reason: null }.
  let row = con.prepare(
    "SELECT id FROM documents WHERE file_sha256=? AND status!='trash'").get(sha);
  if (row) return { id: row.id, reason: "exact-file" };
  row = con.prepare(
    "SELECT id FROM documents WHERE text_hash=? AND status!='trash'").get(thash);
  if (row) return { id: row.id, reason: "exact-text" };
  const tg = trigrams(content);
  if (!tg.size) return { id: null, reason: null };
  const n = normalizeText(content).length;
  // candidates: comparable text length only (cheap pre-filter at
  // personal-archive scale)
  for (const r of con.prepare(
      `SELECT id, content FROM documents
       WHERE status != 'trash' AND content IS NOT NULL
         AND length(content) BETWEEN ? AND ?
       ORDER BY id DESC LIMIT 500`)
      .iterate(Math.floor(n * 0.6), Math.floor(n * 1.6) + 64)) {
    if (jaccard(tg, trigrams(r.content)) >= similarThreshold)
      return { id: null, reason: `similar:${r.id}` };
  }
  return { id: null, reason: null };
}

module.exports = { fileSha256, normalizeText, textHash, trigrams, jaccard,
                   refDuplicate, findDuplicates };
