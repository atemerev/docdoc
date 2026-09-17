// All durable bytes and settings live in SQLite. Files are temporary exports only.
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { Db } from "./db";
import type { Config } from "../domain/types";

export const hash = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");
export function init(con: Db): void {
  con.exec(`
    CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (
      key TEXT PRIMARY KEY, sha TEXT NOT NULL REFERENCES blobs(sha), mime TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS review_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TEXT NOT NULL,
      target_id INTEGER UNIQUE REFERENCES documents(id), revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL REFERENCES assets(key),
      name TEXT NOT NULL, group_id INTEGER REFERENCES review_groups(id),
      state TEXT NOT NULL DEFAULT 'new', issue TEXT);
    CREATE TABLE IF NOT EXISTS review_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES review_groups(id), document_id INTEGER REFERENCES documents(id),
      source_key TEXT NOT NULL REFERENCES assets(key), source_page INTEGER NOT NULL,
      position INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', marker TEXT,
      blank INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0,
      issue TEXT, batch TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS review_pages_group ON review_pages(group_id, position);
    CREATE TABLE IF NOT EXISTS document_links (
      a INTEGER NOT NULL REFERENCES documents(id), b INTEGER NOT NULL REFERENCES documents(id),
      PRIMARY KEY(a,b), CHECK(a != b));
    CREATE TABLE IF NOT EXISTS review_log (
      id INTEGER PRIMARY KEY, document_id INTEGER REFERENCES documents(id),
      at TEXT NOT NULL, note TEXT NOT NULL, checks TEXT NOT NULL);
  `);
  const columns = con.pragma("table_info(review_pages)") as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "exclusion_override")) {
    con.transaction(() => {
      con.exec(
        "ALTER TABLE review_pages ADD COLUMN exclusion_override INTEGER CHECK(exclusion_override IN (0,1))",
      );
      // Retain prior manual exclusions; apply the new default to unfiled blanks.
      con.exec(`UPDATE review_pages SET exclusion_override=1 WHERE excluded=1;
        UPDATE review_groups SET revision=revision+1 WHERE id IN
          (SELECT group_id FROM review_pages WHERE group_id IS NOT NULL AND blank=1 AND excluded=0);
        UPDATE review_pages SET excluded=1 WHERE group_id IS NOT NULL AND blank=1;`);
    })();
  }
  if (!columns.some((column) => column.name === "qr_json"))
    con.exec("ALTER TABLE review_pages ADD COLUMN qr_json TEXT");
  if (!columns.some((column) => column.name === "ocr_source"))
    con.exec("ALTER TABLE review_pages ADD COLUMN ocr_source TEXT");
  if (!columns.some((column) => column.name === "blank_checked"))
    con.exec(`ALTER TABLE review_pages ADD COLUMN blank_checked INTEGER NOT NULL DEFAULT 0;
      UPDATE review_pages SET blank_checked=1 WHERE ocr_source IS NOT NULL OR text!='';`);
  const importColumns = con.pragma("table_info(imports)") as Array<{
    name: string;
  }>;
  if (!importColumns.some((column) => column.name === "captured_at")) {
    con.exec(`ALTER TABLE imports ADD COLUMN captured_at TEXT;
      UPDATE imports SET captured_at=(SELECT created_at FROM review_groups WHERE id=imports.group_id);`);
  }
  const groupColumns = con.pragma("table_info(review_groups)") as Array<{
    name: string;
  }>;
  if (!groupColumns.some((column) => column.name === "phase")) {
    con.transaction(() => con.exec(`ALTER TABLE review_groups ADD COLUMN phase TEXT NOT NULL DEFAULT 'pages';
      ALTER TABLE review_groups ADD COLUMN queued_at TEXT;
      ALTER TABLE review_groups ADD COLUMN queue_error TEXT;
      ALTER TABLE review_groups ADD COLUMN queue_note TEXT;
      UPDATE review_groups SET phase='ready' WHERE target_id IS NOT NULL;`))();
  }
  for (const column of ["manual_grouping", "manual_order", "split_done"])
    if (!groupColumns.some((c) => c.name === column))
      con.exec(`ALTER TABLE review_groups ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  if (!groupColumns.some((column) => column.name === "metadata_result"))
    con.exec("ALTER TABLE review_groups ADD COLUMN metadata_result TEXT");
  if (!groupColumns.some((column) => column.name === "metadata_overrides")) {
    con.transaction(() => {
      con.exec(
        "ALTER TABLE review_groups ADD COLUMN metadata_overrides TEXT NOT NULL DEFAULT '{}'",
      );
      // Preserve existing user titles; timestamps and imported filenames can be
      // replaced by recognized document headings.
      const rows = con
        .prepare("SELECT id,title FROM review_groups")
        .all() as Array<{ id: number; title: string }>;
      for (const row of rows)
        if (
          !/^(Scan |Imported pages$|Untitled document$)|\.(pdf|png|jpe?g|tiff?)$/i.test(
            row.title,
          )
        )
          con
            .prepare("UPDATE review_groups SET metadata_overrides=? WHERE id=?")
            .run(JSON.stringify({ title: row.title }), row.id);
    })();
  }
}
export function put(con: Db, key: string, data: Buffer, mime: string): void {
  const sha = hash(data);
  con
    .prepare("INSERT OR IGNORE INTO blobs(sha,data) VALUES (?,?)")
    .run(sha, data);
  con
    .prepare(
      `INSERT INTO assets(key,sha,mime) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET sha=excluded.sha,mime=excluded.mime`,
    )
    .run(key, sha, mime);
}
export function get(
  con: Db,
  key: string,
): { data: Buffer; mime: string } | undefined {
  return con
    .prepare(
      "SELECT b.data,a.mime FROM assets a JOIN blobs b USING(sha) WHERE a.key=?",
    )
    .get(key) as { data: Buffer; mime: string } | undefined;
}
export function copy(con: Db, from: string, to: string): void {
  if (
    !con
      .prepare(
        `INSERT INTO assets(key,sha,mime) SELECT ?,sha,mime FROM assets WHERE key=?
    ON CONFLICT(key) DO UPDATE SET sha=excluded.sha,mime=excluded.mime`,
      )
      .run(to, from).changes
  )
    throw new Error(`Missing stored file: ${from}`);
}
export const has = (con: Db, key: string): boolean =>
  Boolean(con.prepare("SELECT 1 FROM assets WHERE key=?").get(key));
export const docKey = (id: number, kind = "pdf"): string =>
  `document/${id}/${kind}`;
export const pageKey = (id: number, kind = "pdf"): string =>
  `page/${id}/${kind}`;
export function setting<T>(con: Db, key: string): T | undefined {
  const row = con.prepare("SELECT value FROM settings WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}
export function setSetting(con: Db, key: string, value: unknown): void {
  con
    .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)")
    .run(key, JSON.stringify(value));
}
const mime = (name: string): string =>
  ({
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  })[path.extname(name).toLowerCase()] || "application/octet-stream";

/** Idempotent, all-or-nothing migration. Never deletes the source archive. */
export async function migrateFiles(con: Db, cfg: Config): Promise<void> {
  if (setting(con, "files_migrated")) return;
  const rows = con
    .prepare("SELECT id,pdf_path,thumb_path FROM documents")
    .all() as Array<{
    id: number;
    pdf_path: string | null;
    thumb_path: string | null;
  }>;
  if (rows.length) {
    const backup = path.join(cfg.data_root, "docdoc-before-single-file.db");
    if (!fs.existsSync(backup)) {
      await con.backup(backup);
      fs.chmodSync(backup, 0o600);
    }
  }
  con.transaction(() => {
    // Keep all historical originals, including dropped pages and orphan files.
    const walk = (dir: string, prefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name),
          key = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(file, key);
        else if (entry.isFile())
          put(con, key, fs.readFileSync(file), mime(file));
      }
    };
    for (const dir of ["archive", "originals", "thumbs", "failed"])
      walk(path.join(cfg.data_root, dir), `legacy/${dir}`);
    for (const row of rows) {
      if (row.pdf_path)
        copy(con, `legacy/archive/${row.pdf_path}`, docKey(row.id));
      if (row.thumb_path && has(con, `legacy/thumbs/${row.thumb_path}`))
        copy(con, `legacy/thumbs/${row.thumb_path}`, docKey(row.id, "thumb"));
    }
    setSetting(con, "config", cfg);
    setSetting(con, "files_migrated", true);
  })();
}

/** SQLite's online backup API includes committed data even while the app is open. */
export async function backup(con: Db, destination: string): Promise<void> {
  if (path.resolve(destination) === path.resolve(con.name))
    throw new Error("Choose a different backup file.");
  if (fs.existsSync(destination))
    throw new Error("Choose a new filename; this backup already exists.");
  try {
    await con.backup(destination);
    fs.chmodSync(destination, 0o600);
  } catch (e) {
    fs.rmSync(destination, { force: true });
    throw e;
  }
}
