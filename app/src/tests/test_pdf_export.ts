import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import { exportPdf } from "../services/pdf_export";
import { DEFAULTS } from "../infra/config";

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-export-test-"));
  const con = db.connect(path.join(work, "test.db"));
  store.init(con);
  try {
    const source = path.join(work, "source.pdf");
    execFileSync("python3", [
      "-c",
      `import pymupdf as f,sys\nd=f.open()\nfor t in ['Réduction de loyer 60% - Genève','PRIVATE REMOVED PAGE']:\n p=d.new_page();p.insert_text((50,80),t)\nd.save(sys.argv[1])`,
      source,
    ]);
    const id = flow.queueFiles(
      con,
      [source],
      "Scan",
      null,
      undefined,
      "2026-09-14T18:56:05.118Z",
    );
    await flow.prepareImports(con, id, () => {});
    const pages = con
      .prepare("SELECT id FROM review_pages ORDER BY position")
      .all() as { id: number }[];
    con
      .prepare(
        "UPDATE review_pages SET text='Réduction de loyer 60% - Genève',issue=NULL WHERE id=?",
      )
      .run(pages[0].id);
    con
      .prepare(
        "UPDATE review_pages SET text='PRIVATE REMOVED PAGE',issue=NULL,excluded=1 WHERE id=?",
      )
      .run(pages[1].id);
    flow.updateMetadata(con, id, {
      title: "Réduction de loyer",
      sender_name: "Zoé & Émile",
      doc_date: "2026-09-10",
      doc_type: "letter",
      refs: [
        { kind: "case_no", value: "GE-123", evidence: "Manually corrected" },
      ],
    });
    const hash = store.hash(store.get(con, store.pageKey(pages[0].id))!.data);
    const dir = path.join(work, "exports");
    const first = await exportPdf(con, { kind: "group", id }, dir);
    const second = await exportPdf(con, { kind: "group", id }, dir);
    assert.notEqual(first, second);
    assert.equal(
      store.hash(store.get(con, store.pageKey(pages[0].id))!.data),
      hash,
    );
    assert(flow.group(con, id));
    assert.equal(
      (con.prepare("SELECT COUNT(*) n FROM documents").get() as any).n,
      0,
    );
    const check = (file: string, status: string) =>
      execFileSync("python3", [
        "-c",
        `import pymupdf as f,sys,json,xml.etree.ElementTree as E\nd=f.open(sys.argv[1]);original=f.open(sys.argv[2])\nassert len(d)==1\nassert d[0].get_pixmap().samples==original[0].get_pixmap().samples\nassert 'Genève' in d[0].get_text()\nassert d.metadata['title']=='Réduction de loyer'\nassert d.metadata['author']=='Zoé & Émile'\nassert 'GE-123' in d.metadata['keywords']\nassert d.metadata['creationDate']=='D:20260914185605Z'\nx=E.fromstring(d.get_xml_metadata())\nassert x.find('.//{urn:docdoc:metadata:1.0/}doc_date').text=='2026-09-10'\nassert 'PRIVATE REMOVED' not in d.get_xml_metadata()\nm=json.loads(d.embfile_get('metadata.json'))\nassert m['review_status']==sys.argv[3]\nassert m['doc_date']=='2026-09-10' and m['scanned_at']=='2026-09-14T18:56:05.118Z'\nassert 'Genève' in d.embfile_get('recognized-text.txt').decode()\nassert 'PRIVATE REMOVED' not in d.embfile_get('recognized-text.txt').decode()`,
        file,
        source,
        status,
      ]);
    check(first, "awaiting_review");
    const doc = await flow.fileGroup(
      { ...DEFAULTS, metadata_provider: "local" },
      con,
      {
        id,
        revision: flow.group(con, id).revision,
        title: "Réduction de loyer",
      },
      () => {},
    );
    const saved = await exportPdf(con, { kind: "document", id: doc }, dir);
    check(saved, "reviewed");
    console.log(
      "PDF export: searchable Unicode, properties/XMP/attachments, date roles, exclusion, unchanged rendering, safe filenames, saved/review states passed",
    );
  } finally {
    con.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
