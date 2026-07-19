// The document pipeline (JS port of docdoc/pipeline.py).
//
// Stage 1 ingest: scanned pages become a filed, viewable document within
// seconds (raw PDF + thumbnail under a provisional name). Stage 2
// understanding: OCR, AI, page order, dedup, invoice lifecycle fill in
// text + metadata and finalize the archive filename.
//
// Abort: requestAbort() sets the flag consulted between stages and kills
// every tracked child process (ocrmypdf, claude, ...) so the running
// stage ends promptly; the watcher turns BatchAborted into deletion of
// all in-flight documents.

const fs = require("fs");
const path = require("path");

const ai = require("./ai");
const db = require("./db");
const dedup = require("./dedup");
const invoices = require("./invoices");
const ocr = require("./ocr");
const pageorder = require("./pageorder");
const qrbill = require("./qrbill");

class BatchAborted extends Error {}

let ABORT = false;
const children = new Set();

function requestAbort() {
  ABORT = true;
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
}

const aborted = () => ABORT;
const clearAbort = () => { ABORT = false; };
function checkAbort() {
  if (ABORT) throw new BatchAborted();
}
const trackChild = (c) => children.add(c);
const untrackChild = (c) => children.delete(c);

const log = (msg) => console.log(msg);

const progressPath = (cfg, batch) =>
  path.join(cfg.data_root, "tmp", `${batch}.progress.json`);

function progress(cfg, batch, stage, label, pct, ceil) {
  // Best-effort stage marker for the app's progress bar: pct is where
  // this stage starts, ceil where it ends (the UI creeps in between).
  // Doubles as the between-stages abort checkpoint.
  checkAbort();
  const p = progressPath(cfg, batch);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + ".tmp", JSON.stringify(
      { stage, label, pct, ceil, at: db.nowIso() }));
    fs.renameSync(p + ".tmp", p);
  } catch {}
}

function clearProgress(cfg, batch) {
  try { fs.unlinkSync(progressPath(cfg, batch)); } catch {}
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".pnm"]);

function batchImages(batchDir) {
  let entries;
  try { entries = fs.readdirSync(batchDir); } catch { return []; }
  return entries
    .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(batchDir, f));
}

function archiveName(ext, docId, title) {
  const date = ext.doc_date || new Date().toISOString().slice(0, 10);
  const year = date.slice(0, 4);
  const titleSlug = ai.slugify(title || ext.doc_type || "document").slice(0, 48);
  const fname = `${date}_${ext.sender_key || "unknown"}_${titleSlug}_`
    + `${String(docId).padStart(5, "0")}.pdf`;
  return path.join(year, fname);
}

function batchPdf(batchDir) {
  // A batch pushed by the scanner itself (SFTP/FTP/SMB button scan) is a
  // single multipage PDF instead of page images.
  let entries;
  try { entries = fs.readdirSync(batchDir); } catch { return null; }
  const pdfs = entries.filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  return pdfs.length ? path.join(batchDir, pdfs[0]) : null;
}

// ------------------------------------------------------------- stage 1
async function ingestBatch(cfg, con, batchDir) {
  // Fast foreground stage: the scanned pages become a filed, viewable
  // document within seconds. Returns the document id (pending='queued',
  // to be picked up by the background queue) or null (empty batch).
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
    log(`pipeline: ${batch}: no images, skipping`);
    return null;
  }
  log(`pipeline: ${batch}: ingesting ${images.length} page image(s)`
      + (srcPdf ? " (from pushed PDF)" : ""));
  db.event(con, "batch-start", `ingesting ${images.length} page(s)`, { batch });

  const workdir = path.join(cfg.data_root, "tmp", batch);
  fs.mkdirSync(workdir, { recursive: true });
  let dest = null;
  try {
    const rawPdf = path.join(workdir, "raw.pdf");
    if (srcPdf) fs.copyFileSync(srcPdf, rawPdf);
    else await ocr.imagesToPdf(images, rawPdf);
    const info = con.prepare(
      `INSERT INTO documents(created_at, pages, batch, status, pending)
       VALUES (?,?,?,'inbox','queued')`
    ).run(db.nowIso(), images.length, batch);
    const docId = Number(info.lastInsertRowid);
    const rel = archiveName({}, docId, batch.replace(/_/g, "-"));
    dest = path.join(cfg.data_root, "archive", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(rawPdf, dest);
    let thumbRel = `${String(docId).padStart(5, "0")}.jpg`;
    try {
      await ocr.thumbnail(dest, path.join(cfg.data_root, "thumbs", thumbRel));
    } catch (e) {
      if (!(e instanceof ocr.OcrError)) throw e;
      thumbRel = null;
    }
    con.prepare("UPDATE documents SET pdf_path=?, thumb_path=? WHERE id=?")
      .run(rel, thumbRel, docId);
    log(`pipeline: ${batch}: visible as document #${docId} (archive/${rel})`);
    return docId;
  } catch (e) {
    if (dest) { try { fs.unlinkSync(dest); } catch {} }
    throw e;
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- stage 2
async function processDocument(cfg, con, docId, imagesDir = null) {
  // Slow background stage: OCR, AI understanding, page order, dedup,
  // invoice lifecycle. The document already exists with its raw PDF;
  // this fills in text + metadata and finalizes the archive filename.
  // Page images come from originals/<batch> unless imagesDir overrides;
  // a missing directory degrades gracefully (no blank-page detection,
  // text-only AI).
  const doc = con.prepare("SELECT * FROM documents WHERE id=?").get(docId);
  if (!doc) throw new Error(`no document ${docId}`);
  const batch = doc.batch || `doc-${docId}`;
  if (imagesDir === null)
    imagesDir = path.join(cfg.data_root, "originals", doc.batch || "");
  const images = fs.existsSync(imagesDir) ? batchImages(imagesDir) : [];
  const rawPdf = path.join(cfg.data_root, "archive", doc.pdf_path);
  const workdir = path.join(cfg.data_root, "tmp", batch);
  fs.mkdirSync(workdir, { recursive: true });
  try {
    return await understand(cfg, con, doc, images, rawPdf, workdir);
  } catch (e) {
    if (e instanceof BatchAborted) throw e;
    if (aborted()) throw new BatchAborted(batch);  // stage child killed by abort
    throw e;
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    clearProgress(cfg, batch);
  }
}

async function understand(cfg, con, doc, images, rawPdf, workdir) {
  const docId = doc.id, batch = doc.batch;
  const n = doc.pages || images.length;

  // 1. Swiss QR-bill (from original images -- best resolution)
  progress(cfg, batch, "qr", "reading QR code", 2, 10);
  const qr = images.length ? await qrbill.findQrbill(images) : null;
  if (qr)
    log(`pipeline: ${batch}: QR-bill found (${qr.creditor?.name}, `
        + `${qr.amount} ${qr.currency})`);

  // 2. OCR the already-filed raw PDF
  const ocrPdfPath = path.join(workdir, "ocr.pdf");
  progress(cfg, batch, "ocr", `OCR, ${n} page(s)`, 12, 55);
  const { pageTexts } = await ocr.ocrPdf(rawPdf, ocrPdfPath,
    { languages: cfg.ocr_languages });
  checkAbort();
  // ocrmypdf sidecar pages should match input pages; be defensive
  while (pageTexts.length < n) pageTexts.push("");
  // originals gone (crash recovery + keep_originals=false): text-only mode
  const imgs = images.length === n ? images : new Array(n).fill(null);

  // 3. blank pages
  const blanks = new Set();
  if ((cfg.blank_page_drop ?? true) && n > 1) {
    for (let i = 0; i < n; i++)
      if (await ocr.isBlank(pageTexts[i], imgs[i],
          { minChars: parseInt(cfg.min_chars_nonblank, 10) || 12 }))
        blanks.add(i);
    if (blanks.size === n) blanks.clear();   // never drop everything
  }
  const flags = [];
  let kept = [...Array(n).keys()].filter((i) => !blanks.has(i));
  if (blanks.size) flags.push(`blank-dropped:${blanks.size}`);

  // 4. AI understanding -- the model *reads* the page images (in scan
  // order) and reports metadata, internal references, the correct
  // reading order AND whether the stack is really several documents.
  // Regex heuristics only run in no-AI degraded mode.
  const known = con.prepare("SELECT key FROM senders").all().map((r) => r.key);
  const scanContent = kept.map((i) => pageTexts[i]).join("\n\f\n");
  progress(cfg, batch, "ai", "AI reading the document", 58, 90);
  const { ext, provider } = await ai.extract(cfg,
    kept.map((i) => imgs[i]).filter(Boolean), scanContent,
    { qr, knownSenders: known });
  checkAbort();  // a killed AI falls back to heuristics -- don't file that
  log(`pipeline: ${batch}: [${provider}] ${ext.doc_type} from `
      + `${ext.sender_name}: '${ext.title}'`);

  // 4b. several documents fed as one stack? validate the grouping: the
  // groups must exactly partition the kept pages, else file as one and
  // leave a flag for the review queue
  let groups = null;
  if (Array.isArray(ext.page_groups) && ext.page_groups.length > 1) {
    const flat = ext.page_groups.flat().sort((a, b) => a - b);
    const identity1 = Array.from({ length: kept.length }, (_, i) => i + 1);
    if (JSON.stringify(flat) === JSON.stringify(identity1))
      groups = ext.page_groups;
    else flags.push("multi-doc-uncertain:bad-groups");
  }

  if (groups) {
    log(`pipeline: ${batch}: stack contains ${groups.length} documents `
        + JSON.stringify(groups));
    db.event(con, "info",
             `stack split into ${groups.length} documents`,
             { batch, documentId: docId });
    for (let gi = 0; gi < groups.length; gi++) {
      checkAbort();
      // groups reference positions among the pages the model saw (kept),
      // each group already in reading order
      const scanIdxs = groups[gi].map((p) => kept[p - 1]);
      const subTexts = scanIdxs.map((i) => pageTexts[i]);
      const subImages = scanIdxs.map((i) => imgs[i]).filter(Boolean);
      // each part gets its own QR detection (two invoices = possibly two
      // QR-bills) and its own extraction over only its pages -- the
      // stack-level call above only established the grouping
      const subQr = subImages.length ? await qrbill.findQrbill(subImages) : null;
      progress(cfg, batch, "ai",
               `AI reading document ${gi + 1}/${groups.length}`,
               58 + Math.round((gi / groups.length) * 32), 90);
      const sub = await ai.extract(cfg, subImages, subTexts.join("\n\f\n"),
                                   { qr: subQr, knownSenders: known });
      checkAbort();
      let rowDoc = doc;
      if (gi > 0) {
        const info = con.prepare(
          `INSERT INTO documents(created_at, pages, batch, status, pending)
           VALUES (?,?,?,'inbox','queued')`
        ).run(db.nowIso(), scanIdxs.length, batch);
        rowDoc = con.prepare("SELECT * FROM documents WHERE id=?")
          .get(Number(info.lastInsertRowid));
      }
      const partPdf = path.join(workdir, `part-${gi}.pdf`);
      await ocr.rebuildPdf(ocrPdfPath, partPdf, scanIdxs.map((i) => i + 1));
      await fileDocument(cfg, con, rowDoc, sub.ext, subQr, partPdf,
        scanIdxs, subTexts, gi === 0 ? blanks : new Set(),
        [...flags, `multi-doc:${gi + 1}/${groups.length}`], pageTexts);
    }
    return docId;
  }

  // 5. page order: AI judgement, page-number markers as cross-check
  const { order: markerOrder, flags: oflags } =
    pageorder.checkOrder(kept.map((i) => pageTexts[i]));
  const aiOrder = ext.page_order;
  if (aiOrder && aiOrder.length === kept.length) {
    if (markerOrder && JSON.stringify(markerOrder) !== JSON.stringify(aiOrder))
      flags.push("order-conflict-markers-vs-ai");
    kept = aiOrder.map((p) => kept[p - 1]);
    flags.push("page-order-fixed:ai");
    log(`pipeline: ${batch}: AI corrected page order -> `
        + `${kept.map((i) => i + 1)}`);
  } else if (provider !== "heuristic" && markerOrder) {
    // AI saw the pages and found the order fine; markers disagree
    flags.push("order-uncertain:markers-disagree-with-ai");
  } else if (provider === "heuristic") {
    flags.push(...oflags);
    if (markerOrder) {
      kept = markerOrder.map((p) => kept[p - 1]);
      log(`pipeline: ${batch}: page order corrected by markers -> `
          + `${kept.map((i) => i + 1)}`);
    }
  }

  let finalPdf = path.join(workdir, "final.pdf");
  const identity = [...Array(n).keys()];
  if (JSON.stringify(kept) !== JSON.stringify(identity))
    await ocr.rebuildPdf(ocrPdfPath, finalPdf, kept.map((i) => i + 1));
  else finalPdf = ocrPdfPath;

  await fileDocument(cfg, con, doc, ext, qr, finalPdf, kept,
    kept.map((i) => pageTexts[i]), blanks, flags, pageTexts);
  return docId;
}

async function fileDocument(cfg, con, doc, ext, qr, finalPdf, kept,
                            keptTexts, blanks, flags, pageTexts) {
  // File one logical document: dedup, sender, archive move, metadata,
  // refs, pages, invoice lifecycle, event. `kept` holds 0-based scan
  // indices in final reading order; `doc` is the (possibly freshly
  // inserted) documents row to fill in.
  const docId = doc.id, batch = doc.batch;
  const content = keptTexts.join("\n\f\n");

  // 6. dedup (on the final ordered content)
  progress(cfg, batch, "file", "checking duplicates + filing", 92, 100);
  const sha = dedup.fileSha256(finalPdf);
  const thash = dedup.textHash(content);
  let { id: dupOf, reason: dupReason } =
    dedup.findDuplicates(con, sha, thash, content);
  let dupReasonCol = dupReason;
  if (dupReason && dupReason.startsWith("similar:")) {
    flags.push(`possible-duplicate:${dupReason.split(":")[1]}`);
    dupReasonCol = "similar";
  }
  // reference-based duplicate: same doc type + same extracted internal
  // reference + broadly similar text = same paper, rescanned or copied
  if (!dupOf) {
    const { id: rid, reason: rreason } = dedup.refDuplicate(con, ext, content);
    if (rid) { dupOf = rid; dupReasonCol = rreason; }
  }

  // 7. sender
  let senderId = null;
  if (ext.sender_key && ext.sender_key !== "unknown")
    senderId = db.upsertSender(con, ext.sender_key,
      ext.sender_name || ext.sender_key,
      { uid: qr?.swico?.uid ?? null, iban: qr?.iban ?? null,
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
  } catch (e) {
    if (!(e instanceof ocr.OcrError)) throw e;
    thumbRel = doc.thumb_path;
  }

  // 9. document metadata (row was inserted at ingest)
  const tagsText = ext.tags.join(" ");
  con.prepare(
    `UPDATE documents SET doc_date=?, title=?, doc_type=?, sender_id=?,
         sender_name=?, recipient=?, language=?, summary=?, tags=?,
         tags_text=?, pdf_path=?, thumb_path=?, pages=?, content=?,
         file_sha256=?, text_hash=?, duplicate_of=?, dup_reason=?,
         amount=?, currency=?, due_date=?, invoice_ref=?, ai_json=?,
         flags=?, pending=NULL
     WHERE id=?`
  ).run(ext.doc_date, ext.title, ext.doc_type, senderId,
        db.fold(ext.sender_name || ""), ext.recipient_name,
        ext.language, ext.summary_en, JSON.stringify(ext.tags),
        db.fold(tagsText), rel, thumbRel, kept.length, db.fold(content),
        sha, thash, dupOf, dupReasonCol, ext.amount,
        ext.currency, ext.due_date, ext.invoice_ref,
        JSON.stringify(ext), JSON.stringify(flags), docId);

  // 9b. internal references -- the glue that links related documents
  const refs = ext.refs.map((r) => [r.kind, r.value]);
  if (ext.invoice_ref) refs.push(["invoice_no", ext.invoice_ref]);
  if (qr?.reference) refs.push(["qr_reference", qr.reference]);
  if (qr?.swico?.customer_ref) refs.push(["customer_no", qr.swico.customer_ref]);
  con.prepare("DELETE FROM doc_refs WHERE document_id=?").run(docId);
  db.addRefs(con, docId, refs);

  // 10. pages
  con.prepare("DELETE FROM pages WHERE document_id=?").run(docId);
  const insPage = con.prepare(
    `INSERT INTO pages(document_id, page_no, scan_order, text, is_blank, marker)
     VALUES (?,?,?,?,?,?)`);
  kept.forEach((scanIdx, i) => {
    const marker = pageorder.pageMarker(keptTexts[i]);
    insPage.run(docId, i + 1, scanIdx + 1, keptTexts[i], 0,
                marker ? `${marker[0]},${marker[1]}` : "");
  });
  for (const scanIdx of [...blanks].sort((a, b) => a - b))
    insPage.run(docId, null, scanIdx + 1, pageTexts[scanIdx], 1, "");
  if (oldRel && oldRel !== rel) {
    try { fs.unlinkSync(path.join(cfg.data_root, "archive", oldRel)); }
    catch {}
  }

  // 11. invoice lifecycle (not for hard duplicates -- no double counting)
  if ((["invoice", "reminder"].includes(ext.doc_type) || qr) && !dupOf) {
    const { notes } = await invoices.recordInvoice(
      con, cfg, docId, senderId, ext, qr);
    for (const note of notes)
      db.event(con, "invoice", note, { batch, documentId: docId });
  }

  let msg = `${ext.doc_type} '${ext.title}' from `
    + `${ext.sender_name || "?"} (${kept.length} page(s))`;
  if (dupOf) msg += ` -- DUPLICATE of #${dupOf} (${dupReasonCol})`;
  db.event(con, "document", msg, { batch, documentId: docId });
  log(`pipeline: ${batch}: filed as archive/${rel}`
      + (dupOf ? ` (duplicate of #${dupOf})` : ""));
  return docId;
}

async function processBatch(cfg, con, batchDir) {
  // Synchronous convenience for tests: ingest + understand in one call,
  // reading images from the batch directory itself.
  const docId = await ingestBatch(cfg, con, batchDir);
  if (docId === null) return null;
  return processDocument(cfg, con, docId, batchDir);
}

function moveSync(src, dest) {
  // rename(2) fails with EXDEV across filesystems (scans_dir lives on
  // /home, data_root on /pool) -- fall back to copy+delete like
  // Python's shutil.move did
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(src, dest, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function finishBatch(cfg, batchDir, success, keep = null) {
  // Move originals to originals/ (or failed/), per config. keep=true
  // forces keeping (watcher ingest: the background stage still needs the
  // page images; keep_originals is applied after understanding).
  const batch = path.basename(batchDir.replace(/\/+$/, ""));
  if (!fs.existsSync(batchDir)) return null;   // deleted by an abort mid-batch
  if (!success) {
    const dest = path.join(cfg.data_root, "failed", batch);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    moveSync(batchDir, dest);
    return dest;
  }
  if (keep === null) keep = cfg.keep_originals ?? true;
  if (keep) {
    const dest = path.join(cfg.data_root, "originals", batch);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    moveSync(batchDir, dest);
    return dest;
  }
  fs.rmSync(batchDir, { recursive: true, force: true });
  return null;
}

module.exports = { BatchAborted, requestAbort, aborted, clearAbort, checkAbort,
                   trackChild, untrackChild, log, progress, clearProgress,
                   batchImages, archiveName, ingestBatch, processDocument,
                   processBatch, finishBatch };
