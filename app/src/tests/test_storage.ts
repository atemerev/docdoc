import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import assert from "node:assert/strict";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import { DEFAULTS } from "../infra/config";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-storage-"));
  const con = db.connect(path.join(dir, "docdoc.db"));
  store.init(con);
  try {
    const cfg = { ...DEFAULTS, data_root: dir };
    fs.mkdirSync(path.join(dir, "archive/2026"), { recursive: true });
    fs.mkdirSync(path.join(dir, "originals/batch"), { recursive: true });
    fs.mkdirSync(path.join(dir, "thumbs"), { recursive: true });
    const pdf = Buffer.from("%PDF-legacy-data"),
      original = Buffer.from("original, including excluded page");
    fs.writeFileSync(path.join(dir, "archive/2026/original.pdf"), pdf);
    fs.writeFileSync(path.join(dir, "originals/batch/page.png"), original);
    fs.writeFileSync(path.join(dir, "thumbs/1.jpg"), Buffer.from("thumbnail"));
    con
      .prepare(
        "INSERT INTO documents(id,created_at,pdf_path,thumb_path,title,content) VALUES (1,?,'2026/original.pdf','1.jpg','Legacy','searchable legacy text')",
      )
      .run(db.nowIso());
    await store.migrateFiles(con, cfg);
    assert(fs.existsSync(path.join(dir, "docdoc-before-single-file.db")));
    assert.deepEqual(store.get(con, store.docKey(1))!.data, pdf);
    assert.deepEqual(
      store.get(con, "legacy/originals/batch/page.png")!.data,
      original,
    );
    assert.equal(
      (con.prepare("SELECT COUNT(*) n FROM blobs").get() as { n: number }).n,
      3,
    );
    assert(fs.existsSync(path.join(dir, "archive/2026/original.pdf")));
    await store.migrateFiles(con, cfg); // idempotent even when originals no longer exist
    fs.rmSync(path.join(dir, "archive"), { recursive: true });
    fs.rmSync(path.join(dir, "originals"), { recursive: true });
    fs.rmSync(path.join(dir, "thumbs"), { recursive: true });
    await store.migrateFiles(con, cfg);
    const backup = path.join(dir, "backup.db");
    await store.backup(con, backup);
    const restored = db.connect(backup);
    store.init(restored);
    assert.deepEqual(store.get(restored, store.docKey(1))!.data, pdf);
    assert.equal(db.search(restored, "legacy")[0].id, 1);
    assert.equal(
      store.setting<typeof cfg>(restored, "config")!.ocr_languages,
      cfg.ocr_languages,
    );
    restored.close();
    // Upgrade a pending scan from the checkbox-era schema.
    con.exec("ALTER TABLE review_pages DROP COLUMN exclusion_override");
    con
      .prepare(
        "INSERT INTO review_groups(id,title,created_at) VALUES (1,'Pending',?)",
      )
      .run(db.nowIso());
    con.exec(
      "INSERT INTO review_pages(id,group_id,source_key,source_page,position,blank,excluded,batch) VALUES (1,1,'legacy/originals/batch/page.png',1,1,1,0,'scan'),(2,1,'legacy/originals/batch/page.png',2,2,0,1,'scan')",
    );
    store.init(con);
    assert.equal(
      (
        con.prepare("SELECT excluded FROM review_pages WHERE id=1").get() as {
          excluded: number;
        }
      ).excluded,
      1,
    );
    assert.equal(
      (
        con
          .prepare("SELECT exclusion_override FROM review_pages WHERE id=2")
          .get() as { exclusion_override: number }
      ).exclusion_override,
      1,
    );
    con.exec(
      "UPDATE review_pages SET excluded=0,exclusion_override=0 WHERE id=1",
    );
    store.init(con);
    assert.equal(
      (
        con.prepare("SELECT excluded FROM review_pages WHERE id=1").get() as {
          excluded: number;
        }
      ).excluded,
      0,
    );
    console.log(
      "Legacy migration, byte deduplication, idempotency and one-file backup passed.",
    );
  } finally {
    con.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-missing-"));
  const bad = db.connect(path.join(broken, "docdoc.db"));
  store.init(bad);
  try {
    bad
      .prepare(
        "INSERT INTO documents(created_at,pdf_path) VALUES (?,'missing.pdf')",
      )
      .run(db.nowIso());
    await assert.rejects(
      store.migrateFiles(bad, { ...DEFAULTS, data_root: broken }),
      /Missing stored file/,
    );
    assert(!store.setting(bad, "files_migrated"));
    assert.equal(
      (bad.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number })
        .n,
      1,
    );
    console.log(
      "Missing legacy PDF fails migration without losing the original row.",
    );
  } finally {
    bad.close();
    fs.rmSync(broken, { recursive: true, force: true });
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
