"use strict";
// The document pipeline.
//
// Stage 1 ingest: scanned pages become a filed, viewable document within
// seconds (raw PDF + thumbnail under a provisional name). Stage 2
// understanding: OCR, AI, page order, dedup, invoice lifecycle fill in
// text + metadata and finalize the archive filename. A stack that the AI
// recognizes as several documents is split, each part re-extracted (with
// its own QR-bill) and filed separately.
//
// Abort: infra/exec's registry kills stage children; the watcher turns
// BatchAborted into deletion of all in-flight documents.
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
exports.log = exports.BatchAborted = void 0;
exports.progress = progress;
exports.clearProgress = clearProgress;
exports.batchImages = batchImages;
exports.archiveName = archiveName;
exports.ingestBatch = ingestBatch;
exports.processDocument = processDocument;
exports.processBatch = processBatch;
exports.finishBatch = finishBatch;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const pageorder_1 = require("../domain/pageorder");
const textsim_1 = require("../domain/textsim");
const db = __importStar(require("../infra/db"));
const exec_1 = require("../infra/exec");
Object.defineProperty(exports, "BatchAborted", { enumerable: true, get: function () { return exec_1.BatchAborted; } });
const imaging_1 = require("../infra/imaging");
const ocr = __importStar(require("../infra/ocr"));
const qrcodec_1 = require("../infra/qrcodec");
const dedup_1 = require("./dedup");
const textsim_2 = require("../domain/textsim");
const extraction_1 = require("./extraction");
const invoices_1 = require("./invoices");
const log = (msg) => console.log(msg);
exports.log = log;
const progressPath = (cfg, batch) => path.join(cfg.data_root, "tmp", `${batch}.progress.json`);
/**
 * Best-effort stage marker for the app's progress bar: pct is where this
 * stage starts, ceil where it ends (the UI creeps in between). Doubles
 * as the between-stages abort checkpoint.
 */
function progress(cfg, batch, stage, label, pct, ceil) {
    (0, exec_1.checkAbort)();
    const p = progressPath(cfg, batch);
    try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p + ".tmp", JSON.stringify({ stage, label, pct, ceil, at: db.nowIso() }));
        fs.renameSync(p + ".tmp", p);
    }
    catch { /* progress is cosmetic */ }
}
function clearProgress(cfg, batch) {
    try {
        fs.unlinkSync(progressPath(cfg, batch));
    }
    catch { /* absent */ }
}
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".pnm"]);
function batchImages(batchDir) {
    let entries;
    try {
        entries = fs.readdirSync(batchDir);
    }
    catch {
        return [];
    }
    return entries
        .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
        .sort()
        .map((f) => path.join(batchDir, f));
}
/**
 * A batch pushed by the scanner itself (SFTP/FTP/SMB button scan) is a
 * single multipage PDF instead of page images.
 */
function batchPdf(batchDir) {
    let entries;
    try {
        entries = fs.readdirSync(batchDir);
    }
    catch {
        return null;
    }
    const pdfs = entries.filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
    return pdfs.length ? path.join(batchDir, pdfs[0]) : null;
}
function archiveName(ext, docId, title) {
    const date = ext.doc_date || new Date().toISOString().slice(0, 10);
    const year = date.slice(0, 4);
    const titleSlug = (0, textsim_1.slugify)(title || ext.doc_type || "document").slice(0, 48);
    const fname = `${date}_${ext.sender_key || "unknown"}_${titleSlug}_`
        + `${String(docId).padStart(5, "0")}.pdf`;
    return path.join(year, fname);
}
/**
 * rename(2) fails with EXDEV across filesystems (scans_dir lives on
 * /home, data_root on /pool) -- fall back to copy+delete.
 */
function moveSync(src, dest) {
    try {
        fs.renameSync(src, dest);
    }
    catch (e) {
        if (e.code !== "EXDEV")
            throw e;
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
}
// ------------------------------------------------------------- stage 1
/**
 * Fast foreground stage: the scanned pages become a filed, viewable
 * document within seconds. Returns the document id (pending='queued',
 * to be picked up by the background queue) or null (empty batch).
 */
async function ingestBatch(cfg, con, batchDir) {
    const batch = path.basename(batchDir.replace(/\/+$/, ""));
    let images = batchImages(batchDir);
    const srcPdf = images.length ? null : batchPdf(batchDir);
    if (!images.length && srcPdf) {
        // render page images so QR decode, vision AI and blank detection see
        // the same inputs a scanimage batch provides
        await ocr.pdfToImages(srcPdf, batchDir);
        images = batchImages(batchDir);
    }
    if (!images.length) {
        (0, exports.log)(`pipeline: ${batch}: no images, skipping`);
        return null;
    }
    (0, exports.log)(`pipeline: ${batch}: ingesting ${images.length} page image(s)`
        + (srcPdf ? " (from pushed PDF)" : ""));
    db.event(con, "batch-start", `ingesting ${images.length} page(s)`, { batch });
    const workdir = path.join(cfg.data_root, "tmp", batch);
    fs.mkdirSync(workdir, { recursive: true });
    let dest = null;
    try {
        const rawPdf = path.join(workdir, "raw.pdf");
        if (srcPdf)
            fs.copyFileSync(srcPdf, rawPdf);
        else
            await ocr.imagesToPdf(images, rawPdf);
        const info = con.prepare(`INSERT INTO documents(created_at, pages, batch, status, pending)
       VALUES (?,?,?,'inbox','queued')`).run(db.nowIso(), images.length, batch);
        const docId = Number(info.lastInsertRowid);
        const rel = archiveName({}, docId, batch.replace(/_/g, "-"));
        dest = path.join(cfg.data_root, "archive", rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(rawPdf, dest);
        let thumbRel = `${String(docId).padStart(5, "0")}.jpg`;
        try {
            await ocr.thumbnail(dest, path.join(cfg.data_root, "thumbs", thumbRel));
        }
        catch (e) {
            if (!(e instanceof ocr.OcrError))
                throw e;
            thumbRel = null;
        }
        con.prepare("UPDATE documents SET pdf_path=?, thumb_path=? WHERE id=?")
            .run(rel, thumbRel, docId);
        (0, exports.log)(`pipeline: ${batch}: visible as document #${docId} (archive/${rel})`);
        return docId;
    }
    catch (e) {
        if (dest) {
            try {
                fs.unlinkSync(dest);
            }
            catch { /* not created */ }
        }
        throw e;
    }
    finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
}
// ------------------------------------------------------------- stage 2
/**
 * Slow background stage: OCR, AI understanding, page order, dedup,
 * invoice lifecycle. The document already exists with its raw PDF; this
 * fills in text + metadata and finalizes the archive filename. Page
 * images come from originals/<batch> unless imagesDir overrides; a
 * missing directory degrades gracefully (no blank-page detection,
 * text-only AI).
 */
async function processDocument(cfg, con, docId, imagesDir = null) {
    const doc = con.prepare("SELECT * FROM documents WHERE id=?")
        .get(docId);
    if (!doc)
        throw new Error(`no document ${docId}`);
    const batch = doc.batch || `doc-${docId}`;
    if (imagesDir === null)
        imagesDir = path.join(cfg.data_root, "originals", doc.batch || "");
    const images = fs.existsSync(imagesDir) ? batchImages(imagesDir) : [];
    const rawPdf = path.join(cfg.data_root, "archive", doc.pdf_path);
    const workdir = path.join(cfg.data_root, "tmp", batch);
    fs.mkdirSync(workdir, { recursive: true });
    try {
        return await understand(cfg, con, doc, images, rawPdf, workdir);
    }
    catch (e) {
        if (e instanceof exec_1.BatchAborted)
            throw e;
        if ((0, exec_1.aborted)())
            throw new exec_1.BatchAborted(batch); // stage child killed by abort
        throw e;
    }
    finally {
        fs.rmSync(workdir, { recursive: true, force: true });
        clearProgress(cfg, batch);
    }
}
async function understand(cfg, con, doc, images, rawPdf, workdir) {
    const docId = doc.id, batch = doc.batch;
    const n = doc.pages || images.length;
    // 1. Swiss QR-bill (from original images -- best resolution)
    progress(cfg, batch, "qr", "reading QR code", 2, 10);
    const qr = images.length ? await (0, qrcodec_1.findQrbill)(images) : null;
    if (qr)
        (0, exports.log)(`pipeline: ${batch}: QR-bill found (${qr.creditor?.name}, `
            + `${qr.amount} ${qr.currency})`);
    // 2. OCR the already-filed raw PDF
    const ocrPdfPath = path.join(workdir, "ocr.pdf");
    progress(cfg, batch, "ocr", `OCR, ${n} page(s)`, 12, 55);
    const { pageTexts } = await ocr.ocrPdf(rawPdf, ocrPdfPath, { languages: cfg.ocr_languages });
    (0, exec_1.checkAbort)();
    // ocrmypdf sidecar pages should match input pages; be defensive
    while (pageTexts.length < n)
        pageTexts.push("");
    // originals gone (crash recovery + keep_originals=false): text-only mode
    const imgs = images.length === n ? images : new Array(n).fill(null);
    // 3. blank pages
    const blanks = new Set();
    if ((cfg.blank_page_drop ?? true) && n > 1) {
        for (let i = 0; i < n; i++)
            if ((0, imaging_1.isBlank)(pageTexts[i], imgs[i], { minChars: Number(cfg.min_chars_nonblank) || 12 }))
                blanks.add(i);
        if (blanks.size === n)
            blanks.clear(); // never drop everything
    }
    const flags = [];
    let kept = [...Array(n).keys()].filter((i) => !blanks.has(i));
    if (blanks.size)
        flags.push(`blank-dropped:${blanks.size}`);
    // 4. AI understanding -- the model *reads* the page images (in scan
    // order) and reports metadata, internal references, the correct
    // reading order AND whether the stack is really several documents.
    // Regex heuristics only run in no-AI degraded mode.
    const known = con.prepare("SELECT key FROM senders").all().map((r) => r.key);
    const scanContent = kept.map((i) => pageTexts[i]).join("\n\f\n");
    progress(cfg, batch, "ai", "AI reading the document", 58, 90);
    const { ext, provider } = await (0, extraction_1.runExtraction)(cfg, kept.map((i) => imgs[i]).filter((p) => p !== null), scanContent, { qr, knownSenders: known });
    (0, exec_1.checkAbort)(); // a killed AI falls back to heuristics -- don't file that
    (0, exports.log)(`pipeline: ${batch}: [${provider}] ${ext.doc_type} from `
        + `${ext.sender_name}: '${ext.title}'`);
    // 4b. several documents fed as one stack? validate the grouping: the
    // groups must exactly partition the kept pages, else file as one and
    // leave a flag for the review queue
    let groups = null;
    if (ext.page_groups && ext.page_groups.length > 1) {
        const flat = ext.page_groups.flat().sort((a, b) => a - b);
        const identity1 = Array.from({ length: kept.length }, (_, i) => i + 1);
        if (JSON.stringify(flat) === JSON.stringify(identity1))
            groups = ext.page_groups;
        else
            flags.push("multi-doc-uncertain:bad-groups");
    }
    if (groups) {
        (0, exports.log)(`pipeline: ${batch}: stack contains ${groups.length} documents `
            + JSON.stringify(groups));
        db.event(con, "info", `stack split into ${groups.length} documents`, { batch, documentId: docId });
        for (let gi = 0; gi < groups.length; gi++) {
            (0, exec_1.checkAbort)();
            // groups reference positions among the pages the model saw (kept),
            // each group already in reading order
            const scanIdxs = groups[gi].map((p) => kept[p - 1]);
            const subTexts = scanIdxs.map((i) => pageTexts[i]);
            const subImages = scanIdxs.map((i) => imgs[i])
                .filter((p) => p !== null);
            // each part gets its own QR detection (two invoices = possibly two
            // QR-bills) and its own extraction over only its pages -- the
            // stack-level call above only established the grouping
            const subQr = subImages.length ? await (0, qrcodec_1.findQrbill)(subImages) : null;
            progress(cfg, batch, "ai", `AI reading document ${gi + 1}/${groups.length}`, 58 + Math.round((gi / groups.length) * 32), 90);
            const sub = await (0, extraction_1.runExtraction)(cfg, subImages, subTexts.join("\n\f\n"), { qr: subQr, knownSenders: known });
            (0, exec_1.checkAbort)();
            let rowDoc = doc;
            if (gi > 0) {
                const info = con.prepare(`INSERT INTO documents(created_at, pages, batch, status, pending)
           VALUES (?,?,?,'inbox','queued')`).run(db.nowIso(), scanIdxs.length, batch);
                rowDoc = con.prepare("SELECT * FROM documents WHERE id=?")
                    .get(Number(info.lastInsertRowid));
            }
            const partPdf = path.join(workdir, `part-${gi}.pdf`);
            await ocr.rebuildPdf(ocrPdfPath, partPdf, scanIdxs.map((i) => i + 1));
            await fileDocument(cfg, con, rowDoc, sub.ext, subQr, partPdf, scanIdxs, subTexts, gi === 0 ? blanks : new Set(), [...flags, `multi-doc:${gi + 1}/${groups.length}`], pageTexts);
        }
        return docId;
    }
    // 5. page order: AI judgement, page-number markers as cross-check
    const { order: markerOrder, flags: oflags } = (0, pageorder_1.checkOrder)(kept.map((i) => pageTexts[i]));
    const aiOrder = ext.page_order;
    if (aiOrder && aiOrder.length === kept.length) {
        if (markerOrder && JSON.stringify(markerOrder) !== JSON.stringify(aiOrder))
            flags.push("order-conflict-markers-vs-ai");
        kept = aiOrder.map((p) => kept[p - 1]);
        flags.push("page-order-fixed:ai");
        (0, exports.log)(`pipeline: ${batch}: AI corrected page order -> `
            + `${kept.map((i) => i + 1)}`);
    }
    else if (provider !== "heuristic" && markerOrder) {
        // AI saw the pages and found the order fine; markers disagree
        flags.push("order-uncertain:markers-disagree-with-ai");
    }
    else if (provider === "heuristic") {
        flags.push(...oflags);
        if (markerOrder) {
            kept = markerOrder.map((p) => kept[p - 1]);
            (0, exports.log)(`pipeline: ${batch}: page order corrected by markers -> `
                + `${kept.map((i) => i + 1)}`);
        }
    }
    let finalPdf = path.join(workdir, "final.pdf");
    const identity = [...Array(n).keys()];
    if (JSON.stringify(kept) !== JSON.stringify(identity))
        await ocr.rebuildPdf(ocrPdfPath, finalPdf, kept.map((i) => i + 1));
    else
        finalPdf = ocrPdfPath;
    await fileDocument(cfg, con, doc, ext, qr, finalPdf, kept, kept.map((i) => pageTexts[i]), blanks, flags, pageTexts);
    return docId;
}
/**
 * File one logical document: dedup, sender, archive move, metadata,
 * refs, pages, invoice lifecycle, event. `kept` holds 0-based scan
 * indices in final reading order; `doc` is the (possibly freshly
 * inserted) documents row to fill in.
 */
async function fileDocument(cfg, con, doc, ext, qr, finalPdf, kept, keptTexts, blanks, flags, pageTexts) {
    const docId = doc.id, batch = doc.batch;
    const content = keptTexts.join("\n\f\n");
    // 6. dedup (on the final ordered content)
    progress(cfg, batch, "file", "checking duplicates + filing", 92, 100);
    const sha = (0, dedup_1.fileSha256)(finalPdf);
    const thash = (0, textsim_2.textHash)(content);
    let { id: dupOf, reason: dupReason } = (0, dedup_1.findDuplicates)(con, sha, thash, content);
    let dupReasonCol = dupReason;
    if (dupReason && dupReason.startsWith("similar:")) {
        flags.push(`possible-duplicate:${dupReason.split(":")[1]}`);
        dupReasonCol = "similar";
    }
    // reference-based duplicate: same doc type + same extracted internal
    // reference + broadly similar text = same paper, rescanned or copied
    if (!dupOf) {
        const { id: rid, reason: rreason } = (0, dedup_1.refDuplicate)(con, ext, content);
        if (rid) {
            dupOf = rid;
            dupReasonCol = rreason;
        }
    }
    // 7. sender
    let senderId = null;
    if (ext.sender_key && ext.sender_key !== "unknown")
        senderId = db.upsertSender(con, ext.sender_key, ext.sender_name || ext.sender_key, { uid: qr?.swico?.uid ?? null, iban: qr?.iban ?? null,
            address: qr?.creditor ?? null });
    // 8. replace the provisional archive file with the final OCR'd PDF
    // under its real name (file first, then commit the paths -- a crash
    // in between leaves both files, never a dangling pdf_path)
    const oldRel = doc.pdf_path;
    const rel = archiveName(ext, docId, ext.title);
    const dest = path.join(cfg.data_root, "archive", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(finalPdf, dest);
    let thumbRel = `${String(docId).padStart(5, "0")}.jpg`;
    try {
        await ocr.thumbnail(dest, path.join(cfg.data_root, "thumbs", thumbRel));
    }
    catch (e) {
        if (!(e instanceof ocr.OcrError))
            throw e;
        thumbRel = doc.thumb_path;
    }
    // 9. document metadata (row was inserted at ingest / split)
    const tagsText = ext.tags.join(" ");
    con.prepare(`UPDATE documents SET doc_date=?, title=?, doc_type=?, sender_id=?,
         sender_name=?, recipient=?, language=?, summary=?, tags=?,
         tags_text=?, pdf_path=?, thumb_path=?, pages=?, content=?,
         file_sha256=?, text_hash=?, duplicate_of=?, dup_reason=?,
         amount=?, currency=?, due_date=?, invoice_ref=?, ai_json=?,
         flags=?, pending=NULL
     WHERE id=?`).run(ext.doc_date, ext.title, ext.doc_type, senderId, (0, textsim_1.fold)(ext.sender_name || ""), ext.recipient_name, ext.language, ext.summary_en, JSON.stringify(ext.tags), (0, textsim_1.fold)(tagsText), rel, thumbRel, kept.length, (0, textsim_1.fold)(content), sha, thash, dupOf, dupReasonCol, ext.amount, ext.currency, ext.due_date, ext.invoice_ref, JSON.stringify(ext), JSON.stringify(flags), docId);
    // 9b. internal references -- the glue that links related documents
    const refs = ext.refs.map((r) => [r.kind, r.value]);
    if (ext.invoice_ref)
        refs.push(["invoice_no", ext.invoice_ref]);
    if (qr?.reference)
        refs.push(["qr_reference", qr.reference]);
    if (qr?.swico?.customer_ref)
        refs.push(["customer_no", qr.swico.customer_ref]);
    con.prepare("DELETE FROM doc_refs WHERE document_id=?").run(docId);
    db.addRefs(con, docId, refs);
    // 10. pages
    con.prepare("DELETE FROM pages WHERE document_id=?").run(docId);
    const insPage = con.prepare(`INSERT INTO pages(document_id, page_no, scan_order, text, is_blank, marker)
     VALUES (?,?,?,?,?,?)`);
    kept.forEach((scanIdx, i) => {
        const marker = (0, pageorder_1.pageMarker)(keptTexts[i]);
        insPage.run(docId, i + 1, scanIdx + 1, keptTexts[i], 0, marker ? `${marker[0]},${marker[1]}` : "");
    });
    for (const scanIdx of [...blanks].sort((a, b) => a - b))
        insPage.run(docId, null, scanIdx + 1, pageTexts[scanIdx], 1, "");
    if (oldRel && oldRel !== rel) {
        try {
            fs.unlinkSync(path.join(cfg.data_root, "archive", oldRel));
        }
        catch { /* already replaced */ }
    }
    // 11. invoice lifecycle (not for hard duplicates -- no double counting)
    if ((["invoice", "reminder"].includes(ext.doc_type) || qr) && !dupOf) {
        const { notes } = await (0, invoices_1.recordInvoice)(con, cfg, docId, senderId, ext, qr);
        for (const note of notes)
            db.event(con, "invoice", note, { batch, documentId: docId });
    }
    let msg = `${ext.doc_type} '${ext.title}' from `
        + `${ext.sender_name || "?"} (${kept.length} page(s))`;
    if (dupOf)
        msg += ` -- DUPLICATE of #${dupOf} (${dupReasonCol})`;
    db.event(con, "document", msg, { batch, documentId: docId });
    (0, exports.log)(`pipeline: ${batch}: filed as archive/${rel}`
        + (dupOf ? ` (duplicate of #${dupOf})` : ""));
}
/** Ingest + understand in one call, reading images from the batch dir. */
async function processBatch(cfg, con, batchDir) {
    const docId = await ingestBatch(cfg, con, batchDir);
    if (docId === null)
        return null;
    return processDocument(cfg, con, docId, batchDir);
}
/**
 * Move originals to originals/ (or failed/), per config. keep=true
 * forces keeping (watcher ingest: the background stage still needs the
 * page images; keep_originals is applied after understanding).
 */
function finishBatch(cfg, batchDir, success, keep = null) {
    const batch = path.basename(batchDir.replace(/\/+$/, ""));
    if (!fs.existsSync(batchDir))
        return null; // deleted by an abort mid-batch
    if (!success) {
        const dest = path.join(cfg.data_root, "failed", batch);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        moveSync(batchDir, dest);
        return dest;
    }
    if (keep === null)
        keep = cfg.keep_originals ?? true;
    if (keep) {
        const dest = path.join(cfg.data_root, "originals", batch);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        moveSync(batchDir, dest);
        return dest;
    }
    fs.rmSync(batchDir, { recursive: true, force: true });
    return null;
}
