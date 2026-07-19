#!/usr/bin/env node
// End-to-end pipeline test: synthetic invoice (with QR-bill) + Mahnung
// run through the full JS pipeline -- img2pdf/ocrmypdf OCR, QR decode,
// extraction (heuristics, no AI dependency), reminder linking via shared
// refs, dedup on rescan. Fully isolated temp data_root; touches nothing
// real. Run: node tests/test_pipeline.js   (takes ~1 min: 3× OCR)

const fs = require("fs");
const os = require("os");
const path = require("path");

const LIB = path.join(__dirname, "..", "app", "lib");
const db = require(path.join(LIB, "db.js"));
const pipeline = require(path.join(LIB, "pipeline.js"));
const fixtures = require(path.join(__dirname, "make_fixtures.js"));

const failures = [];
function check(name, cond, detail = "") {
  console.log(`  [${cond ? "ok" : "FAIL"}] ${name} ${detail}`);
  if (!cond) failures.push(name);
}

async function main() {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "pipetest-"));
  const cfg = {
    data_root: td,
    scans_dir: path.join(td, "scans"),
    keep_originals: true,
    ocr_languages: "deu+fra+ita+eng",
    ai_provider: "none",
    ai_send_images: true,
    ai_max_pages: 4,
    default_payment_term_days: 30,
    blank_page_drop: true,
    min_chars_nonblank: 12,
  };
  const con = db.connect(path.join(td, "docdoc.db"));

  try {
    // fixtures
    const invDir = path.join(td, "in", "fixture-invoice");
    const mahDir = path.join(td, "in", "fixture-mahnung");
    fs.mkdirSync(invDir, { recursive: true });
    fs.mkdirSync(mahDir, { recursive: true });
    fs.writeFileSync(path.join(invDir, "page-001.png"),
                     await fixtures.invoicePage());
    fs.writeFileSync(path.join(mahDir, "page-001.png"),
                     await fixtures.mahnungPage());
    // rescan copy for the dedup check (same paper, separate batch)
    const dupDir = path.join(td, "in", "fixture-invoice-rescan");
    fs.mkdirSync(dupDir, { recursive: true });
    fs.copyFileSync(path.join(invDir, "page-001.png"),
                    path.join(dupDir, "page-001.png"));

    console.log("== invoice batch (QR-bill) ==");
    const docInv = await pipeline.processBatch(cfg, con, invDir);
    const dInv = con.prepare("SELECT * FROM documents WHERE id=?").get(docInv);
    check("document filed (pending cleared)", dInv.pending === null);
    check("classified as invoice", dInv.doc_type === "invoice", dInv.doc_type);
    check("OCR text captured",
          (dInv.content || "").includes("Hausratversicherung"),
          `(len ${String(dInv.content || "").length})`);
    check("archive PDF exists",
          fs.existsSync(path.join(td, "archive", dInv.pdf_path)), dInv.pdf_path);
    check("thumbnail exists",
          fs.existsSync(path.join(td, "thumbs", dInv.thumb_path)));
    const inv = con.prepare(
      "SELECT * FROM invoices WHERE document_id=?").get(docInv);
    check("invoice row with QR reference",
          inv && inv.qr_reference === fixtures.QRR, inv?.qr_reference);
    check("QR amount authoritative", inv && inv.amount === 249.60,
          String(inv?.amount));
    check("due date from Swico /40/ net term",
          inv && inv.due_date === "2026-07-15", inv?.due_date);
    check("sender from QR creditor",
          (dInv.sender_name || "").includes("Helvetia"), dInv.sender_name);
    const refs = con.prepare(
      "SELECT norm FROM doc_refs WHERE document_id=?").all(docInv)
      .map((r) => r.norm);
    check("invoice number extracted as ref",
          refs.includes("RE20260042"), refs.join(","));
    check("policy number extracted as ref",
          refs.includes("P778899"), refs.join(","));

    console.log("== Mahnung batch (no QR; links via refs) ==");
    const docMah = await pipeline.processBatch(cfg, con, mahDir);
    const dMah = con.prepare("SELECT * FROM documents WHERE id=?").get(docMah);
    check("classified as reminder", dMah.doc_type === "reminder", dMah.doc_type);
    const mah = con.prepare(
      "SELECT * FROM invoices WHERE document_id=?").get(docMah);
    check("reminder level 1", mah && mah.reminder_level === 1,
          String(mah?.reminder_level));
    check("reminder linked to the invoice chain",
          mah && mah.parent_invoice_id === inv.id,
          `parent=${mah?.parent_invoice_id} inv=${inv.id}`);
    const root = con.prepare(
      "SELECT * FROM invoices WHERE id=?").get(inv.id);
    check("original moved to status reminded", root.status === "reminded");
    check("related documents linked via shared refs",
          db.relatedDocuments(con, docMah).some((r) => r.id === docInv));

    console.log("== rescan dedup ==");
    const docDup = await pipeline.processBatch(cfg, con, dupDir);
    const dDup = con.prepare("SELECT * FROM documents WHERE id=?").get(docDup);
    check("rescan detected as duplicate", dDup.duplicate_of === docInv,
          `duplicate_of=${dDup.duplicate_of} reason=${dDup.dup_reason}`);
    const nInv = con.prepare(
      "SELECT COUNT(*) c FROM invoices").get().c;
    check("duplicate created no extra invoice row", nInv === 2, `(got ${nInv})`);

    console.log("== originals + events ==");
    pipeline.finishBatch(cfg, mahDir, true, true);
    check("finishBatch moves batch to originals/",
          fs.existsSync(path.join(td, "originals", "fixture-mahnung",
                                  "page-001.png")) && !fs.existsSync(mahDir));
    const kinds = con.prepare(
      "SELECT DISTINCT kind FROM events").all().map((r) => r.kind);
    check("events logged", kinds.includes("batch-start")
          && kinds.includes("document"), kinds.join(","));
  } finally {
    con.close();
    fs.rmSync(td, { recursive: true, force: true });
  }

  console.log(`\n${failures.length} failure(s)`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
