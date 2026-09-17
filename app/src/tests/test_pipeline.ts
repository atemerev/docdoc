// Real OCR/PDF integration and durable review, isolated from the user's database.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import assert from "node:assert/strict";
import { DEFAULTS } from "../infra/config";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import * as ocr from "../infra/ocr";
import { requestAbort, clearAbort } from "../infra/exec";
import { checkPages } from "../domain/collation";
import { invoicePage, mahnungPage, page, QRR } from "./fixtures";
import type { DocumentRow, InvoiceRow } from "../domain/types";
import type { ReportProgress, ProcessingProgress } from "../domain/progress";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-test-"));
  const cfg = {
    ...DEFAULTS,
    metadata_provider: "local" as const,
    ocr_engine: "tesseract" as const,
    data_root: dir,
    ocr_languages: "deu+fra+ita+eng",
  };
  let con = db.connect(path.join(dir, "docdoc.db"));
  store.init(con);
  const progress: ProcessingProgress[] = [];
  const status: ReportProgress = (s, stage) => {
    console.log(s);
    if (stage) progress.push(stage);
  };
  const input = (name: string, data: Buffer): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return file;
  };
  const saving = (id: number, title: string, note = "") => ({
    id,
    revision: flow.group(con, id).revision,
    title,
    note,
  });
  try {
    await store.migrateFiles(con, cfg);
    const knownSender = db.upsertSender(
      con,
      "helvetia",
      "Helvetia Versicherungen AG",
    );
    console.log("== capture is durable before OCR ==");
    const original = invoicePage(),
      file = input("invoice.png", original);
    const invoiceGroup = flow.queueFiles(con, [file], "Invoice");
    fs.unlinkSync(file);
    assert.equal(
      (con.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number })
        .n,
      0,
    );
    const source = (
      con.prepare("SELECT source_key FROM imports").get() as {
        source_key: string;
      }
    ).source_key;
    assert.deepEqual(store.get(con, source)!.data, original);
    await flow.readGroup(cfg, con, invoiceGroup, status);
    const invGroup = flow.workbench(con).find((g) => g.id === invoiceGroup)!;
    assert(invGroup.pages[0].text.includes("Hausratversicherung"));
    assert.equal(invGroup.pages.length, 1);
    assert.equal(invGroup.metadata.sender_name, "Helvetia Versicherungen AG");
    assert.equal(invGroup.metadata.doc_type, "invoice");
    assert.match(invGroup.title, /Rechnung/);
    assert(invGroup.pages[0].qr_json, "QR metadata available before saving");
    assert.deepEqual(
      [...new Set(progress.map((p) => p.stage))],
      ["prepare", "blank", "recognize", "check", "details"],
    );
    assert(
      progress.some((p) => p.stage === "check" && p.completed === p.total),
    );
    const invoiceId = await flow.fileGroup(
      cfg,
      con,
      saving(invoiceGroup, "Insurance invoice"),
      status,
    );
    assert(
      store
        .get(con, store.docKey(invoiceId))!
        .data.subarray(0, 4)
        .equals(Buffer.from("%PDF")),
    );
    assert(!fs.existsSync(path.join(dir, "archive")));
    const inv = con
      .prepare("SELECT * FROM invoices WHERE document_id=?")
      .get(invoiceId) as InvoiceRow;
    assert.equal(inv.qr_reference, QRR);
    assert.equal(inv.amount, 249.6);
    assert.equal(inv.sender_id, knownSender);
    const captured = con
      .prepare("SELECT captured_at FROM imports WHERE source_key=?")
      .get(source) as { captured_at: string };
    const dated = con
      .prepare("SELECT scanned_at,scan_date_source FROM documents WHERE id=?")
      .get(invoiceId) as { scanned_at: string; scan_date_source: string };
    assert.equal(
      dated.scanned_at,
      captured.captured_at,
      "capture time survives filing",
    );
    assert.equal(dated.scan_date_source, "capture");
    assert.equal(
      (con.prepare("SELECT count(*) n FROM senders").get() as { n: number }).n,
      1,
    );
    assert.equal(db.search(con, "Hausratversicherung")[0].id, invoiceId);

    console.log("== no automatic stack split; review groups span scans ==");
    const first = input(
      "first.png",
      page([
        [180, 160, 55, true, "Example Corporation"],
        [180, 350, 45, false, "Contract Nr. CASE-1234"],
        [180, 800, 45, false, "First section of agreement"],
        [180, 3000, 40, false, "Page 1 of 3"],
      ]),
    );
    const third = input(
      "third.png",
      page([
        [180, 160, 55, true, "Example Corporation"],
        [180, 350, 45, false, "Contract Nr. CASE-1234"],
        [180, 800, 45, false, "Final section and signature"],
        [180, 3000, 40, false, "Page 3 of 3"],
      ]),
    );
    const blank = input("blank.png", page([]));
    const stack = flow.queueFiles(con, [third, blank, first], "Mixed stack");
    await flow.readGroup(cfg, con, stack, status);
    let group = flow.workbench(con).find((g) => g.id === stack)!;
    assert.equal(group.pages.length, 3);
    assert(group.pages[1].blank);
    assert.equal(
      group.pages[1].excluded,
      1,
      "blank backside automatically excluded",
    );
    assert.equal(group.pages[0].excluded, 0, "printed page remains included");
    flow.editPage(con, group.pages[1].id, stack, false);
    flow.editPage(con, group.pages[0].id, stack, true);
    flow.updateMetadata(con, stack, {
      title: "My contract",
      sender_name: "Example Corporation",
      doc_type: "contract",
    });
    await flow.readGroup(cfg, con, stack, status);
    group = flow.workbench(con).find((g) => g.id === stack)!;
    assert.equal(
      group.title,
      "My contract",
      "recognition preserves manual edits",
    );
    assert.equal(
      group.pages[1].excluded,
      0,
      "restoring a blank survives OCR retry",
    );
    assert.equal(
      group.pages[0].excluded,
      1,
      "manual removal survives OCR retry",
    );
    flow.editPage(con, group.pages[0].id, stack, false);
    group = flow.workbench(con).find((g) => g.id === stack)!;
    assert(group.warnings.some((w) => w.includes("missing pages: 2")));
    assert(group.warnings.some((w) => w.includes("out of order")));
    assert.equal(flow.workbench(con).length, 1);
    const revision = group.revision;
    flow.editPage(con, group.pages[1].id, stack, true);
    flow.reorder(con, stack, [
      group.pages[2].id,
      group.pages[0].id,
      group.pages[1].id,
    ]);
    assert.throws(
      () => flow.reorder(con, stack, [group.pages[0].id, group.pages[0].id]),
      /exactly once/,
    );
    await assert.rejects(
      flow.fileGroup(
        cfg,
        con,
        { ...saving(stack, "Contract"), revision },
        status,
      ),
      /changed/,
    );
    const second = input(
      "second.png",
      page([
        [180, 160, 55, true, "Example Corporation"],
        [180, 350, 45, false, "Contract Nr. CASE-1234"],
        [180, 800, 45, false, "Middle section with obligations"],
        [180, 3000, 40, false, "Page 2 of 3"],
      ]),
    );
    const later = flow.queueFiles(con, [second], "Later scan");
    await flow.readGroup(cfg, con, later, status);
    const laterGroup = flow.workbench(con).find((g) => g.id === later)!;
    assert(laterGroup.other_groups.some((g) => g.id === stack));
    flow.editPage(con, laterGroup.pages[0].id, stack);
    flow.removeEmptyGroup(con, later);
    assert(!flow.workbench(con).some((group) => group.id === later));
    assert(store.has(con, laterGroup.pages[0].source_key));
    group = flow.workbench(con).find((g) => g.id === stack)!;
    const included = group.pages
      .filter((p) => !p.excluded)
      .sort(
        (a, b) =>
          Number(a.marker?.split("/")[0]) - Number(b.marker?.split("/")[0]),
      );
    flow.reorder(con, stack, [
      ...included.map((p) => p.id),
      ...group.pages.filter((p) => p.excluded).map((p) => p.id),
    ]);
    group = flow.workbench(con).find((g) => g.id === stack)!;
    assert(!group.warnings.some((w) => /missing|out of order/.test(w)));
    const contractId = await flow.fileGroup(
      cfg,
      con,
      saving(stack, "Complete contract"),
      status,
    );
    const contract = con
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(contractId) as DocumentRow;
    assert.equal(contract.pages, 3);
    const contractPdf = input(
      "contract.pdf",
      store.get(con, store.docKey(contractId))!.data,
    );
    assert.equal(await ocr.pageCount(contractPdf), 3);
    assert.equal(
      (
        con
          .prepare("SELECT COUNT(*) n FROM review_pages WHERE document_id=?")
          .get(contractId) as { n: number }
      ).n,
      4,
    );

    console.log("== warnings do not block a normal save ==");
    const partial = flow.queueFiles(con, [first], "Incomplete contract");
    await flow.readGroup(cfg, con, partial, status);
    assert(
      flow
        .workbench(con)
        .find((g) => g.id === partial)!
        .warnings.some((w) => w.includes("missing")),
    );
    const partialId = await flow.fileGroup(
      cfg,
      con,
      saving(partial, "Incomplete contract"),
      status,
    );
    const history = con
      .prepare("SELECT note,checks FROM review_log WHERE document_id=?")
      .get(partialId) as { note: string; checks: string };
    assert.equal(history.note, "");
    assert(
      !("checks" in JSON.parse(history.checks)),
      "saving does not fabricate user attestations",
    );
    assert.equal(
      checkPages([
        {
          id: 1,
          text: "A normal unnumbered letter.",
          excluded: 0,
          blank: 0,
          issue: null,
        },
      ]).length,
      0,
    );

    console.log("== reminders and duplicate scans ==");
    const reminder = flow.queueFiles(
      con,
      [input("reminder.png", mahnungPage())],
      "Reminder",
    );
    await flow.readGroup(cfg, con, reminder, status);
    assert(
      flow
        .workbench(con)
        .find((g) => g.id === reminder)!
        .related.some((r) => (r as { id: number }).id === invoiceId),
    );
    const reminderId = await flow.fileGroup(
      cfg,
      con,
      saving(reminder, "Payment reminder"),
      status,
    );
    const rem = con
      .prepare("SELECT * FROM invoices WHERE document_id=?")
      .get(reminderId) as InvoiceRow;
    assert.equal(rem.parent_invoice_id, inv.id);
    const duplicate = flow.queueFiles(
      con,
      [input("duplicate.png", original)],
      "Duplicate",
    );
    await flow.readGroup(cfg, con, duplicate, status);
    const dupId = await flow.fileGroup(
      cfg,
      con,
      saving(duplicate, "Duplicate insurance invoice"),
      status,
    );
    assert.equal(
      (
        con
          .prepare("SELECT duplicate_of FROM documents WHERE id=?")
          .get(dupId) as { duplicate_of: number }
      ).duplicate_of,
      invoiceId,
    );
    assert(
      !con.prepare("SELECT 1 FROM invoices WHERE document_id=?").get(dupId),
    );

    console.log("== reopen preserves saved PDF until verified ==");
    const before = store.get(con, store.docKey(contractId))!.data;
    const reopened = await flow.reopenDocument(con, contractId, status);
    assert.deepEqual(store.get(con, store.docKey(contractId))!.data, before);
    await flow.readGroup(cfg, con, reopened, status);
    const revised = await flow.fileGroup(
      cfg,
      con,
      saving(reopened, "Reviewed contract"),
      status,
    );
    assert.equal(revised, contractId);
    assert(
      con
        .prepare("SELECT 1 FROM assets WHERE key LIKE ?")
        .get(`revision/${contractId}/%`),
    );

    console.log("== interrupted import and source-only recovery ==");
    const pending = flow.queueFiles(
      con,
      [input("pending.png", original)],
      "Pending",
    );
    requestAbort();
    await assert.rejects(flow.readGroup(cfg, con, pending, status));
    clearAbort();
    assert.equal(
      flow.workbench(con).find((g) => g.id === pending)!.imports.length,
      1,
    );
    const bad = flow.queueFiles(
      con,
      [input("damaged.pdf", Buffer.from("not a pdf"))],
      "Damaged import",
    );
    await assert.rejects(flow.readGroup(cfg, con, bad, status));
    assert(flow.workbench(con).find((g) => g.id === bad)!.imports[0]);
    const revisedPdf = store.get(con, store.docKey(contractId))!.data;
    const backup = path.join(dir, "backup.db");
    await store.backup(con, backup);
    await assert.rejects(store.backup(con, backup), /already exists/);
    con.close();
    // Restore ONLY the backup, with no archive/original folders.
    const restored = path.join(dir, "restore");
    fs.mkdirSync(restored);
    fs.copyFileSync(backup, path.join(restored, "docdoc.db"));
    con = db.connect(path.join(restored, "docdoc.db"));
    store.init(con);
    assert.equal(
      (con.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]
        .integrity_check,
      "ok",
    );
    assert.equal(con.pragma("journal_mode", { simple: true }), "delete");
    assert.deepEqual(store.get(con, source)!.data, original);
    assert.deepEqual(
      store.get(con, store.docKey(contractId))!.data,
      revisedPdf,
    );
    assert(db.search(con, "Hausratversicherung").length >= 1);
    await flow.readGroup({ ...cfg, data_root: restored }, con, pending, status);
    assert.equal(
      flow.workbench(con).find((g) => g.id === pending)!.imports.length,
      0,
    );
    assert(!fs.existsSync(path.join(restored, "archive")));
    assert(
      checkPages([
        { id: 1, text: "Page 1 of 3", excluded: 0, blank: 0, issue: null },
      ]).some((w) => w.includes("2, 3")),
    );
    console.log("All foreground pipeline and restore checks passed.");
  } finally {
    con.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
