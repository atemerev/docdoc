// Duplicate detection, layered (research: paperless-ngx practice + better):
//
// 1. exact file bytes (sha256)          -> hard duplicate
// 2. exact normalized OCR text (sha256) -> hard duplicate
// 3. invoice fields (sender+ref+amount)  -> handled in invoices.ts
// 4. text trigram Jaccard similarity     -> soft 'possible duplicate' flag
//
// Never silently rejects: pipeline links duplicates to the original and
// keeps them reviewable.

import { createHash } from "crypto";
import * as fs from "fs";
import { jaccard, normRef, normalizeText, trigrams } from "../domain/textsim";
import type { Extraction } from "../domain/types";
import type { Db } from "../infra/db";

export function fileSha256(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

export interface DupResult {
  id: number | null;
  reason: string | null;
}

/**
 * Duplicate via understanding: two documents of the same type carrying
 * the same unique internal reference (invoice/order/case number extracted
 * by the AI) and broadly similar text are scans of the same paper --
 * robust against OCR variance that defeats pure text similarity.
 */
export function refDuplicate(
  con: Db, ext: Extraction, content: string, minSimilarity = 0.5,
): DupResult {
  const values = ext.refs.map((r) => r.value);
  if (ext.invoice_ref) values.push(ext.invoice_ref);
  const norms = [...new Set(values.map(normRef).filter((n) => n.length >= 4))];
  if (!norms.length) return { id: null, reason: null };
  const tg = trigrams(content);
  const rows = con.prepare(
    `SELECT DISTINCT d.id, d.content, d.doc_type FROM documents d
     JOIN doc_refs r ON r.document_id = d.id
     WHERE r.norm IN (${norms.map(() => "?").join(",")})
       AND d.status != 'trash'`
  ).all(...norms) as Array<{ id: number; content: string | null;
                             doc_type: string | null }>;
  for (const row of rows)
    if (row.doc_type === ext.doc_type
        && jaccard(tg, trigrams(row.content)) >= minSimilarity)
      return { id: row.id, reason: "same-refs" };
  return { id: null, reason: null };
}

/**
 * Hard match -> { id, reason }; soft match -> { id: null, reason:
 * 'similar:<id>' }; nothing -> { id: null, reason: null }.
 */
export function findDuplicates(
  con: Db, sha: string, thash: string, content: string,
  similarThreshold = 0.75,
): DupResult {
  let row = con.prepare(
    "SELECT id FROM documents WHERE file_sha256=? AND status!='trash'"
  ).get(sha) as { id: number } | undefined;
  if (row) return { id: row.id, reason: "exact-file" };
  row = con.prepare(
    "SELECT id FROM documents WHERE text_hash=? AND status!='trash'"
  ).get(thash) as { id: number } | undefined;
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
    const row2 = r as { id: number; content: string };
    if (jaccard(tg, trigrams(row2.content)) >= similarThreshold)
      return { id: null, reason: `similar:${row2.id}` };
  }
  return { id: null, reason: null };
}
