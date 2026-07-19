// End-to-end pipeline test: synthetic invoice (with QR-bill) + Mahnung
// run through the full pipeline -- img2pdf/ocrmypdf OCR, QR decode,
// extraction (heuristics, no AI dependency), reminder linking via shared
// refs, dedup on rescan, multi-document stack splitting. Fully isolated
// temp data_root; touches nothing real. Takes ~1 min (4x OCR).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Config, DocumentRow, InvoiceRow } from "../domain/types";
import * as db from "../infra/db";
import { normalize, resetExtractor, setExtractor } from "../services/extraction";
import * as pipeline from "../services/pipeline";
import { QRR, check, finish, invoicePage, mahnungPage, page }
  from "./fixtures";

async function main(): Promise<void> {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "pipetest-"));
  const cfg: Config = {
    data_root: td,
    scans_dir: path.join(td, "scans"),
    keep_originals: true,
    ocr_languages: "deu+fra+ita+eng",
    ocr_engine: "tesseract",
    ai_provider: "none",
    ai_model: "sonnet",
    ai_base_url: "http://localhost:8000/v1",
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
    fs.writeFileSync(path.join(invDir, "page-001.png"), invoicePage());
    fs.writeFileSync(path.join(mahDir, "page-001.png"), mahnungPage());
    // rescan copy for the dedup check (same paper, separate batch)
    const dupDir = path.join(td, "in", "fixture-invoice-rescan");
    fs.mkdirSync(dupDir, { recursive: true });
    fs.copyFileSync(path.join(invDir, "page-001.png"),
                    path.join(dupDir, "page-001.png"));

    console.log("== invoice batch (QR-bill) ==");
    const docInv = (await pipeline.processBatch(cfg, con, invDir))!;
    const dInv = con.prepare("SELECT * FROM documents WHERE id=?")
      .get(docInv) as DocumentRow;
    check("document filed (pending cleared)", dInv.pending === null);
    check("classified as invoice", dInv.doc_type === "invoice",
          String(dInv.doc_type));
    check("OCR text captured",
          (dInv.content || "").includes("Hausratversicherung"),
          `(len ${String(dInv.content || "").length})`);
    check("archive PDF exists",
          fs.existsSync(path.join(td, "archive", dInv.pdf_path!)),
          dInv.pdf_path ?? "");
    check("thumbnail exists",
          fs.existsSync(path.join(td, "thumbs", dInv.thumb_path!)));
    const inv = con.prepare(
      "SELECT * FROM invoices WHERE document_id=?").get(docInv) as InvoiceRow;
    check("invoice row with QR reference", inv?.qr_reference === QRR,
          String(inv?.qr_reference));
    check("QR amount authoritative", inv?.amount === 249.60,
          String(inv?.amount));
    check("due date from Swico /40/ net term",
          inv?.due_date === "2026-07-15", String(inv?.due_date));
    check("sender from QR creditor",
          (dInv.sender_name || "").includes("Helvetia"),
          String(dInv.sender_name));
    const refs = (con.prepare(
      "SELECT norm FROM doc_refs WHERE document_id=?").all(docInv) as
      Array<{ norm: string }>).map((r) => r.norm);
    check("invoice number extracted as ref",
          refs.includes("RE20260042"), refs.join(","));
    check("policy number extracted as ref",
          refs.includes("P778899"), refs.join(","));

    console.log("== Mahnung batch (no QR; links via refs) ==");
    const docMah = (await pipeline.processBatch(cfg, con, mahDir))!;
    const dMah = con.prepare("SELECT * FROM documents WHERE id=?")
      .get(docMah) as DocumentRow;
    check("classified as reminder", dMah.doc_type === "reminder",
          String(dMah.doc_type));
    const mah = con.prepare(
      "SELECT * FROM invoices WHERE document_id=?").get(docMah) as InvoiceRow;
    check("reminder level 1", mah?.reminder_level === 1,
          String(mah?.reminder_level));
    check("reminder linked to the invoice chain",
          mah?.parent_invoice_id === inv.id,
          `parent=${mah?.parent_invoice_id} inv=${inv.id}`);
    const root = con.prepare(
      "SELECT * FROM invoices WHERE id=?").get(inv.id) as InvoiceRow;
    check("original moved to status reminded", root.status === "reminded");
    check("related documents linked via shared refs",
          db.relatedDocuments(con, docMah).some((r) => r.id === docInv));

    console.log("== rescan dedup ==");
    const docDup = (await pipeline.processBatch(cfg, con, dupDir))!;
    const dDup = con.prepare("SELECT * FROM documents WHERE id=?")
      .get(docDup) as DocumentRow;
    check("rescan detected as duplicate", dDup.duplicate_of === docInv,
          `duplicate_of=${dDup.duplicate_of} reason=${dDup.dup_reason}`);
    const nInv = (con.prepare("SELECT COUNT(*) c FROM invoices").get() as
      { c: number }).c;
    check("duplicate created no extra invoice row", nInv === 2, `(got ${nInv})`);

    console.log("== two documents in one scanned stack ==");
    // detection needs a model; stub the extractor to test the split
    // mechanics (partitioned PDFs, per-part rows/invoices/refs) exactly
    let calls = 0;
    setExtractor(async (_c, _images, _text, opts) => {
      calls++;
      const base = { language: "de", tags: ["test"], refs: [] };
      if (calls === 1)                      // stack-level: report the split
        return { ext: normalize({ ...base, doc_type: "other",
          sender_name: "stack", page_groups: [[1], [2]] }, opts?.qr ?? null),
          provider: "heuristic" };
      const who = calls === 2
        ? { sender_name: "Alpha Versicherung AG", amount: 111.10,
            invoice_ref: "ALPHA-1", title: "Rechnung Alpha" }
        : { sender_name: "Beta Energie SA", amount: 222.20,
            invoice_ref: "BETA-2", title: "Facture Beta" };
      return { ext: normalize({ ...base, doc_type: "invoice",
        doc_date: "2026-07-01", ...who,
        refs: [{ kind: "invoice_no", value: who.invoice_ref }] },
        opts?.qr ?? null), provider: "heuristic" };
    });
    try {
      const stackDir = path.join(td, "in", "fixture-stack");
      fs.mkdirSync(stackDir, { recursive: true });
      // unique pages (reusing earlier fixtures would trip exact-text dedup)
      fs.writeFileSync(path.join(stackDir, "page-001.png"), page([
        [180, 160, 64, true, "Alpha Versicherung AG"],
        [180, 860, 56, true, "Rechnung ALPHA-1"],
        [180, 1400, 44, false, "Praemie total: CHF 111.10"],
      ]));
      fs.writeFileSync(path.join(stackDir, "page-002.png"), page([
        [180, 160, 64, true, "Beta Energie SA"],
        [180, 860, 56, true, "Facture BETA-2"],
        [180, 1400, 44, false, "Montant total: CHF 222.20"],
      ]));
      const primary = await pipeline.processBatch(cfg, con, stackDir);
      const parts = con.prepare(
        "SELECT * FROM documents WHERE batch='fixture-stack' ORDER BY id"
      ).all() as DocumentRow[];
      check("stack produced two documents", parts.length === 2,
            `(got ${parts.length})`);
      check("first part keeps the ingested row", parts[0]?.id === primary);
      check("both parts fully processed",
            parts.every((p) => p.pending === null));
      check("one page each", parts.every((p) => p.pages === 1),
            parts.map((p) => p.pages).join(","));
      check("distinct senders",
            (parts[0]?.sender_name ?? "").includes("Alpha")
            && (parts[1]?.sender_name ?? "").includes("Beta"),
            parts.map((p) => p.sender_name).join(" | "));
      check("distinct archive PDFs exist",
            parts.every((p) => fs.existsSync(
              path.join(td, "archive", p.pdf_path!)))
            && parts[0].pdf_path !== parts[1].pdf_path);
      check("multi-doc flags set",
            (JSON.parse(parts[0].flags) as string[]).includes("multi-doc:1/2")
            && (JSON.parse(parts[1].flags) as string[]).includes("multi-doc:2/2"));
      const stackInvs = con.prepare(
        `SELECT i.* FROM invoices i JOIN documents d ON d.id=i.document_id
         WHERE d.batch='fixture-stack' ORDER BY i.id`).all() as InvoiceRow[];
      check("an invoice row per part", stackInvs.length === 2
            && stackInvs[0].amount === 111.10 && stackInvs[1].amount === 222.20,
            stackInvs.map((i) => i.amount).join(","));
      check("parts have their own page rows",
            parts.every((p) => (con.prepare(
              "SELECT COUNT(*) c FROM pages WHERE document_id=?"
            ).get(p.id) as { c: number }).c === 1));
    } finally {
      resetExtractor();
    }

    console.log("== originals + events ==");
    pipeline.finishBatch(cfg, mahDir, true, true);
    check("finishBatch moves batch to originals/",
          fs.existsSync(path.join(td, "originals", "fixture-mahnung",
                                  "page-001.png")) && !fs.existsSync(mahDir));
    const kinds = (con.prepare("SELECT DISTINCT kind FROM events").all() as
      Array<{ kind: string }>).map((r) => r.kind);
    check("events logged", kinds.includes("batch-start")
          && kinds.includes("document"), kinds.join(","));
  } finally {
    con.close();
    fs.rmSync(td, { recursive: true, force: true });
  }
  finish();
}

void main().catch((e) => { console.error(e); process.exit(1); });
