// Batch watcher + background understanding queue. Event-driven: inotify
// (fs.watch) + per-batch settle timers -- no periodic polling.
//
// A batch is ready when its directory contains a `.batch-done` marker
// (written by the scan flow) or, as a fallback for batches from other
// sources (e.g. the scanner's own SFTP push), when no file events have
// arrived for SETTLE_MS. Loose files pushed into scans_dir (the
// scanner's firmware push delivers a PDF per job) get their own batch
// dir once the upload has settled.
//
// Two-stage flow: ready batches are ingested immediately (raw PDF filed
// and visible in the app within seconds) and enqueued for a serial
// background worker that runs OCR + AI one document at a time. The queue
// is persistent -- documents.pending='queued' is re-enqueued on start.
//
// abort() kills the current stage's children and deletes every document
// still pending -- row, archive PDF, thumbnail and originals. Completed
// documents are never touched.

import * as fs from "fs";
import * as path from "path";

import type { Config, DocumentRow } from "../domain/types";
import * as config from "../infra/config";
import * as db from "../infra/db";
import { aborted, clearAbort, requestAbort } from "../infra/exec";
import { notify } from "../infra/notify";
import * as pipeline from "./pipeline";

const MARKER = ".batch-done";
const SETTLE_MS = 90000;

interface DirState {
  watcher: fs.FSWatcher | null;
  timer: NodeJS.Timeout | null;
  ingesting: boolean;
}

let started = false;
let con: db.Db | null = null;
let scansWatcher: fs.FSWatcher | null = null;
const dirState = new Map<string, DirState>();
const fileTimers = new Map<string, NodeJS.Timeout>();
const queue: number[] = [];
let wakeWorker: (() => void) | null = null;
let workerRunning = false;

export const alive = (): boolean => started;

export function start(): void {
  if (started) return;
  const cfg = config.load();
  fs.mkdirSync(cfg.scans_dir, { recursive: true });
  con = db.connect();
  started = true;

  // recover the queue: ingested before a restart, not yet understood
  const pending = (con.prepare(
    "SELECT id FROM documents WHERE pending='queued' ORDER BY id"
  ).all() as Array<{ id: number }>).map((r) => r.id);
  queue.push(...pending);
  if (pending.length)
    pipeline.log(`watcher: re-queued ${pending.length} pending document(s)`);

  scansWatcher = fs.watch(cfg.scans_dir, () => sweep(cfg));
  sweep(cfg);                      // batches that arrived while we were down
  void runWorker();
  pipeline.log(`watcher: watching ${cfg.scans_dir} (archive: ${cfg.data_root})`);
}

export function stop(): void {
  started = false;
  scansWatcher?.close();
  scansWatcher = null;
  for (const st of dirState.values()) {
    st.watcher?.close();
    if (st.timer) clearTimeout(st.timer);
  }
  dirState.clear();
  for (const t of fileTimers.values()) clearTimeout(t);
  fileTimers.clear();
}

export function abort(): void {
  if (!started) return;
  requestAbort();
  wakeWorker?.();
}

function sweep(cfg: Config): void {
  // (re)track every visible batch directory in scans_dir; loose files
  // get their own batch dir once the upload has settled
  let names: string[];
  try { names = fs.readdirSync(cfg.scans_dir); } catch { return; }
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const p = path.join(cfg.scans_dir, name);
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      track(cfg, name, p);
      continue;
    }
    if (!/\.(pdf|jpe?g|png|tiff?)$/i.test(name)) continue;
    // uploads have no close signal visible to fs.watch -- give the
    // transfer a quiet window, re-armed on every event, then batch it
    clearTimeout(fileTimers.get(name));
    fileTimers.set(name, setTimeout(() => {
      fileTimers.delete(name);
      try {
        if (!fs.existsSync(p)) return;
        const stamp = new Date().toISOString().slice(0, 19)
          .replace("T", "_").replace(/:/g, "").slice(0, 17);
        const dir = path.join(cfg.scans_dir,
          `${stamp}_${name.replace(/[^A-Za-z0-9._-]/g, "")}`.slice(0, 80));
        fs.mkdirSync(dir);
        fs.renameSync(p, path.join(dir, name));
        fs.writeFileSync(path.join(dir, MARKER), "");
        pipeline.log(`watcher: pushed file ${name} -> ${path.basename(dir)}`);
      } catch (e) {
        pipeline.log(`watcher: pushed file ${name}: ${(e as Error).message}`);
      }
    }, 5000));
  }
  // forget vanished dirs
  for (const [name, st] of dirState)
    if (!fs.existsSync(path.join(cfg.scans_dir, name))) {
      st.watcher?.close();
      if (st.timer) clearTimeout(st.timer);
      dirState.delete(name);
    }
}

function track(cfg: Config, name: string, dir: string): void {
  if (dirState.has(name)) return;
  const st: DirState = { watcher: null, timer: null, ingesting: false };
  dirState.set(name, st);
  const arm = (): void => {
    if (st.timer) clearTimeout(st.timer);
    // marker written -> batch complete now; else consider ready after
    // SETTLE_MS without events (sources that write no marker)
    const delay = fs.existsSync(path.join(dir, MARKER)) ? 250 : SETTLE_MS;
    st.timer = setTimeout(() => { void ready(cfg, name, dir); }, delay);
  };
  try {
    st.watcher = fs.watch(dir, arm);
  } catch { /* dir vanished between listing and watch */ }
  arm();
}

async function ready(cfg: Config, name: string, dir: string): Promise<void> {
  const st = dirState.get(name);
  if (!st || st.ingesting || !started || !con) return;
  if (aborted()) return;    // abort sweep deletes the dirs
  if (!fs.existsSync(dir)) { dirState.delete(name); return; }
  st.ingesting = true;
  try {
    try { fs.unlinkSync(path.join(dir, MARKER)); } catch { /* absent */ }
    let docId: number | null;
    try {
      docId = await pipeline.ingestBatch(cfg, con, dir);
    } catch (e) {
      if (aborted()) {      // ingest child killed by an abort
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      pipeline.log(`watcher: ${name}: ingest FAILED: ${(e as Error).message}`);
      db.event(con, "error", `batch failed: ${(e as Error).message}`,
               { batch: name });
      pipeline.finishBatch(cfg, dir, false);
      notify("Document processing failed",
             `Batch ${name} moved to failed/ — see the app's Activity tab.`);
      return;
    }
    if (docId === null) {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    // keep the page images until OCR/AI ran (the AI reads them);
    // the worker applies keep_originals afterwards
    pipeline.finishBatch(cfg, dir, true, true);
    queue.push(docId);
    wakeWorker?.();
  } catch (e) {
    pipeline.log(`watcher: ${name}: FAILED: ${(e as Error).message}`);
    if (con)
      db.event(con, "error", `batch failed: ${(e as Error).message}`,
               { batch: name });
  } finally {
    const cur = dirState.get(name);
    if (cur) {
      cur.watcher?.close();
      if (cur.timer) clearTimeout(cur.timer);
      dirState.delete(name);
    }
  }
}

/**
 * Abort: delete every document still awaiting understanding -- row,
 * archive PDF, thumbnail and original images. Filed (fully processed)
 * documents are untouched.
 */
function deleteInflight(cfg: Config): void {
  if (!con) return;
  queue.length = 0;
  const rows = con.prepare(
    `SELECT id, batch, pdf_path, thumb_path FROM documents
     WHERE pending='queued'`).all() as Array<
    Pick<DocumentRow, "id" | "batch" | "pdf_path" | "thumb_path">>;
  for (const r of rows) {
    for (const [rel, sub] of
        [[r.pdf_path, "archive"], [r.thumb_path, "thumbs"]] as const)
      if (rel) {
        try { fs.unlinkSync(path.join(cfg.data_root, sub, rel)); }
        catch { /* already gone */ }
      }
    if (r.batch) {
      fs.rmSync(path.join(cfg.data_root, "originals", r.batch),
                { recursive: true, force: true });
      pipeline.clearProgress(cfg, r.batch);
    }
    con.prepare("DELETE FROM documents WHERE id=?").run(r.id);
  }
  if (rows.length) {
    const names = rows.map((r) => r.batch || `#${r.id}`).join(", ");
    pipeline.log(`watcher: abort deleted ${rows.length} in-flight `
                 + `document(s): ${names}`);
    db.event(con, "abort",
             `aborted -- deleted ${rows.length} in-flight document(s)`);
    notify("Processing aborted",
           `${rows.length} unprocessed document(s) deleted.`);
  }
  clearAbort();
}

/** Serial background queue: one document at a time through OCR + AI. */
async function runWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  while (started) {
    if (aborted()) deleteInflight(config.load());
    const docId = queue.shift();
    if (docId === undefined) {
      await new Promise<void>((r) => {
        wakeWorker = r;
        setTimeout(r, 1000);     // fallback tick (abort flag, races)
      });
      wakeWorker = null;
      continue;
    }
    const cfg = config.load();
    const doc = con!.prepare(
      "SELECT id, batch FROM documents WHERE id=? AND pending='queued'"
    ).get(docId) as Pick<DocumentRow, "id" | "batch"> | undefined;
    if (!doc) continue;          // deleted by an abort, or already done
    try {
      await pipeline.processDocument(cfg, con!, docId);
      const row = con!.prepare(
        `SELECT title, sender_name, doc_type, duplicate_of
         FROM documents WHERE id=?`).get(docId) as
        Pick<DocumentRow, "title" | "sender_name" | "doc_type" |
                          "duplicate_of"> | undefined;
      if (row) {
        let body = `${row.sender_name || "?"} — ${row.title || row.doc_type}`;
        if (row.duplicate_of) body += ` (duplicate of #${row.duplicate_of})`;
        notify("Document filed", body);
      }
      if (!(cfg.keep_originals ?? true) && doc.batch)
        fs.rmSync(path.join(cfg.data_root, "originals", doc.batch),
                  { recursive: true, force: true });
    } catch (e) {
      if (e instanceof pipeline.BatchAborted) {
        deleteInflight(cfg);
        continue;
      }
      pipeline.log(
        `watcher: ${doc.batch}: understanding FAILED: ${(e as Error).message}`);
      db.event(con!, "error", `processing failed: ${(e as Error).message}`,
               { batch: doc.batch, documentId: docId });
      con!.prepare("UPDATE documents SET pending='error' WHERE id=?").run(docId);
      notify("Document processing failed",
             "The document is filed with its raw scan — "
             + "see the app's Activity tab.");
    }
  }
  workerRunning = false;
}
