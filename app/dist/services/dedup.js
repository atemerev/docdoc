"use strict";
// Duplicate detection, layered (research: paperless-ngx practice + better):
//
// 1. exact file bytes (sha256)          -> hard duplicate
// 2. exact normalized OCR text (sha256) -> hard duplicate
// 3. invoice fields (sender+ref+amount)  -> handled in invoices.ts
// 4. text trigram Jaccard similarity     -> soft 'possible duplicate' flag
//
// Never silently rejects: pipeline links duplicates to the original and
// keeps them reviewable.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileSha256 = fileSha256;
exports.refDuplicate = refDuplicate;
exports.findDuplicates = findDuplicates;
const crypto_1 = require("crypto");
const fs = __importStar(require("fs"));
const textsim_1 = require("../domain/textsim");
function fileSha256(path) {
    return (0, crypto_1.createHash)("sha256").update(fs.readFileSync(path)).digest("hex");
}
/**
 * Duplicate via understanding: two documents of the same type carrying
 * the same unique internal reference (invoice/order/case number extracted
 * by the AI) and broadly similar text are scans of the same paper --
 * robust against OCR variance that defeats pure text similarity.
 */
function refDuplicate(con, ext, content, minSimilarity = 0.5) {
    const values = ext.refs.map((r) => r.value);
    if (ext.invoice_ref)
        values.push(ext.invoice_ref);
    const norms = [...new Set(values.map(textsim_1.normRef).filter((n) => n.length >= 4))];
    if (!norms.length)
        return { id: null, reason: null };
    const tg = (0, textsim_1.trigrams)(content);
    const rows = con.prepare(`SELECT DISTINCT d.id, d.content, d.doc_type FROM documents d
     JOIN doc_refs r ON r.document_id = d.id
     WHERE r.norm IN (${norms.map(() => "?").join(",")})
       AND d.status != 'trash'`).all(...norms);
    for (const row of rows)
        if (row.doc_type === ext.doc_type
            && (0, textsim_1.jaccard)(tg, (0, textsim_1.trigrams)(row.content)) >= minSimilarity)
            return { id: row.id, reason: "same-refs" };
    return { id: null, reason: null };
}
/**
 * Hard match -> { id, reason }; soft match -> { id: null, reason:
 * 'similar:<id>' }; nothing -> { id: null, reason: null }.
 */
function findDuplicates(con, sha, thash, content, similarThreshold = 0.75) {
    let row = con.prepare("SELECT id FROM documents WHERE file_sha256=? AND status!='trash'").get(sha);
    if (row)
        return { id: row.id, reason: "exact-file" };
    row = con.prepare("SELECT id FROM documents WHERE text_hash=? AND status!='trash'").get(thash);
    if (row)
        return { id: row.id, reason: "exact-text" };
    const tg = (0, textsim_1.trigrams)(content);
    if (!tg.size)
        return { id: null, reason: null };
    const n = (0, textsim_1.normalizeText)(content).length;
    // candidates: comparable text length only (cheap pre-filter at
    // personal-archive scale)
    for (const r of con.prepare(`SELECT id, content FROM documents
       WHERE status != 'trash' AND content IS NOT NULL
         AND length(content) BETWEEN ? AND ?
       ORDER BY id DESC LIMIT 500`)
        .iterate(Math.floor(n * 0.6), Math.floor(n * 1.6) + 64)) {
        const row2 = r;
        if ((0, textsim_1.jaccard)(tg, (0, textsim_1.trigrams)(row2.content)) >= similarThreshold)
            return { id: null, reason: `similar:${row2.id}` };
    }
    return { id: null, reason: null };
}
