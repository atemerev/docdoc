// Real PDF preparation with an intercepted OCR boundary: blanks must never
// reach either engine, and the subset must map back to the original page IDs.
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import * as ocr from "../infra/ocr";
import { DEFAULTS } from "../infra/config";
import { clearAbort, requestAbort } from "../infra/exec";

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-preocr-"));
  const con = db.connect(path.join(dir, "test.db"));
  store.init(con);
  const cfg = { ...DEFAULTS, data_root: dir, metadata_provider: "local" as const };
  const source = path.join(dir, "mixed.pdf"), blank = path.join(dir, "blank.pdf");
  execFileSync("python3", ["-c", `
import pymupdf as f,sys
d=f.open()
for text in ['First page', '', 'Third page', '', 'A']:
 p=d.new_page()
 if text: p.insert_text((50,80),text)
d.save(sys.argv[1])
b=f.open();b.new_page();b.new_page();b.save(sys.argv[2])
`, source, blank]);
  const realOcr = ocr.ocrPdf;
  let calls = 0;
  const inputs: string[][] = [];
  (ocr as { ocrPdf: typeof ocr.ocrPdf }).ocrPdf = async (input, output, options) => {
    calls++;
    const texts = await ocr.pdfPageTexts(input);
    inputs.push(texts);
    options?.onProgress?.(1,texts.length,{completedPages:[2],activePages:[1],phase:"reading"});
    fs.copyFileSync(input, output);
    return { pdf: output, source: "Test OCR", pageTexts: texts.map((t) => `Read: ${t}`) };
  };
  try {
    const id = flow.queueFiles(con, [source], "Mixed pages");
    let checkedBeforeOcr = false;
    await flow.readGroup(cfg, con, id, (_label, progress) => {
      if (progress?.stage === "recognize" && progress.completed === 1) {
        const pages = flow.workbench(con).find((g) => g.id === id)!.pages;
        assert.deepEqual(progress.completedPageIds,[pages[2].id],"OCR progress maps to original page IDs after blanks are removed");
        assert.deepEqual(progress.activePageIds,[pages[0].id]);
      }
      if (progress?.stage === "recognize" && progress.completed === 0) {
        const pages = flow.workbench(con).find((g) => g.id === id)!.pages;
        assert.deepEqual(pages.map((p) => p.excluded), [0, 1, 0, 1, 0]);
        assert.equal(calls, 0, "blank exclusions are committed before OCR starts");
        checkedBeforeOcr = true;
      }
    });
    assert(checkedBeforeOcr);
    assert.deepEqual(inputs[0], ["First page", "Third page", "A"]);
    let group = flow.workbench(con).find((g) => g.id === id)!;
    assert.deepEqual(group.pages.map((p) => p.text), ["Read: First page", "", "Read: Third page", "", "Read: A"]);
    for (const p of group.pages) {
      assert(store.has(con, p.source_key), "every original stays recoverable");
      assert(store.has(con, store.pageKey(p.id)), "blank page PDF stays recoverable");
    }
    // An explicit restore overrides the detector, while manually removed
    // content does not waste OCR work on a retry.
    flow.editPage(con, group.pages[1].id, id, false);
    flow.editPage(con, group.pages[0].id, id, true);
    await flow.readGroup(cfg, con, id, () => {});
    assert.deepEqual(inputs[1], ["", "Third page", "A"]);
    group = flow.workbench(con).find((g) => g.id === id)!;
    assert.deepEqual(group.pages.map((p) => p.excluded), [1, 0, 0, 1, 0]);

    const allBlank = flow.queueFiles(con, [blank], "Blank stack");
    (ocr as { ocrPdf: typeof ocr.ocrPdf }).ocrPdf = async () => {
      throw new Error("An all-blank stack must never start OCR");
    };
    await flow.readGroup(cfg, con, allBlank, () => {}, true);
    const blankGroup = flow.workbench(con).find((g) => g.id === allBlank)!;
    assert(blankGroup.pages.every((p) => p.blank && p.excluded && !p.issue));
    assert(blankGroup.target_id, "all-blank capture stays visible for recovery");

    const failed = flow.queueFiles(con, [source], "OCR failure");
    await assert.rejects(flow.readGroup(cfg, con, failed, () => {}), /must never start OCR/);
    assert.deepEqual(flow.workbench(con).find((g) => g.id === failed)!.pages.map((p) => p.excluded), [0, 1, 0, 1, 0]);

    const cancelled = flow.queueFiles(con, [source], "Stopped check");
    await assert.rejects(flow.readGroup(cfg, con, cancelled, (_label, p) => {
      if (p?.stage === "blank" && p.completed === 2) requestAbort();
    }));
    clearAbort();
    assert.equal(flow.workbench(con).find((g) => g.id === cancelled)!.pages[1].excluded, 1);
    console.log("Pre-OCR: blank skipping, subset order, native text, restore/removal, all-blank capture, failures and cancellation passed.");
  } finally {
    clearAbort();
    (ocr as { ocrPdf: typeof ocr.ocrPdf }).ocrPdf = realOcr;
    con.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
