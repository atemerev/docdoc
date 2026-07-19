// Batch watcher + background understanding queue (JS port of
// docdoc/watchd.py, event-driven).
//
// A batch is ready when its directory contains a `.batch-done` marker
// (written by the scan flow after a scan finishes) or, as a fallback for
// batches from other sources (e.g. the scanner's own SFTP push), when no
// file events have arrived for SETTLE_MS. Detection is inotify
// (fs.watch) + per-batch settle timers -- no periodic polling.
//
// Two-stage flow: ready batches are ingested immediately (raw PDF filed
// and visible in the app within seconds) and enqueued for a serial
// background worker that runs OCR + AI one document at a time. The queue
// is persistent -- documents.pending='queued' is re-enqueued on start.
//
// abort() kills the current stage's children and deletes every document
// still pending -- row, archive PDF, thumbnail and originals. Completed
// documents are never touched.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const config = require("./config");
const db = require("./db");
const pipeline = require("./pipeline");

const MARKER = ".batch-done";
const SETTLE_MS = 90000;

let started = false;
let con = null;
let scansWatcher = null;
const dirState = new Map();     // batch name -> { watcher, timer }
const queue = [];
let wakeWorker = null;
let workerRunning = false;

function notify(summary, body = "") {
  execFile("notify-send", ["-a", "docdoc", summary, body], () => {});
}

const alive = () => started;

function start() {
  if (started) return;
  const cfg = config.load();
  fs.mkdirSync(cfg.scans_dir, { recursive: true });
  con = db.connect();
  started = true;

  // recover the queue: ingested before a restart, not yet understood
  const pending = con.prepare(
    "SELECT id FROM documents WHERE pending='queued' ORDER BY id"
  ).all().map((r) => r.id);
  queue.push(...pending);
  if (pending.length)
    pipeline.log(`watcher: re-queued ${pending.length} pending document(s)`);

  scansWatcher = fs.watch(cfg.scans_dir, () => sweep(cfg));
  sweep(cfg);                      // batches that arrived while we were down
  runWorker();
  pipeline.log(`watcher: watching ${cfg.scans_dir} (archive: ${cfg.data_root})`);
}

function stop() {
  started = false;
  if (scansWatcher) { scansWatcher.close(); scansWatcher = null; }
  for (const st of dirState.values()) {
    st.watcher?.close();
    clearTimeout(st.timer);
  }
  dirState.clear();
}

const fileTimers = new Map();    // loose pushed files -> settle timer

function sweep(cfg) {
  // (re)track every visible batch directory in scans_dir; loose files
  // (the scanner's SFTP/FTP push delivers a PDF per job, no directory)
  // get their own batch dir once the upload has settled
  let names;
  try { names = fs.readdirSync(cfg.scans_dir); } catch { return; }
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const p = path.join(cfg.scans_dir, name);
    let st = null;
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
        pipeline.log(`watcher: pushed file ${name}: ${e.message}`);
      }
    }, 5000));
  }
  // forget vanished dirs
  for (const [name, st] of dirState)
    if (!fs.existsSync(path.join(cfg.scans_dir, name))) {
      st.watcher?.close();
      clearTimeout(st.timer);
      dirState.delete(name);
    }
}

function track(cfg, name, dir) {
  if (dirState.has(name)) return;
  const st = { watcher: null, timer: null, ingesting: false };
  dirState.set(name, st);
  const arm = () => {
    clearTimeout(st.timer);
    if (fs.existsSync(path.join(dir, MARKER))) {
      // marker written -> batch complete now
      st.timer = setTimeout(() => ready(cfg, name, dir), 250);
    } else {
      // fallback: consider ready after SETTLE_MS without events (batches
      // from sources that write no marker, e.g. scanner SFTP push)
      st.timer = setTimeout(() => ready(cfg, name, dir), SETTLE_MS);
    }
  };
  try {
    st.watcher = fs.watch(dir, arm);
  } catch { /* dir vanished between listing and watch */ }
  arm();
}

async function ready(cfg, name, dir) {
  const st = dirState.get(name);
  if (!st || st.ingesting || !started) return;
  if (pipeline.aborted()) return;    // abort sweep deletes the dirs
  if (!fs.existsSync(dir)) { dirState.delete(name); return; }
  st.ingesting = true;
  try {
    try { fs.unlinkSync(path.join(dir, MARKER)); } catch {}
    if (!pipeline.batchImages(dir).length) {
      pipeline.log(`watcher: ${name}: empty batch, removing`);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    let docId;
    try {
      docId = await pipeline.ingestBatch(cfg, con, dir);
    } catch (e) {
      if (pipeline.aborted()) {      // ingest child killed by an abort
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      pipeline.log(`watcher: ${name}: ingest FAILED: ${e.message}`);
      db.event(con, "error", `batch failed: ${e.message}`, { batch: name });
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
    if (wakeWorker) wakeWorker();
  } catch (e) {
    pipeline.log(`watcher: ${name}: FAILED: ${e.message}`);
    db.event(con, "error", `batch failed: ${e.message}`, { batch: name });
  } finally {
    const cur = dirState.get(name);
    if (cur) {
      cur.watcher?.close();
      clearTimeout(cur.timer);
      dirState.delete(name);
    }
  }
}

function deleteInflight(cfg) {
  // Abort: delete every document still awaiting understanding -- row,
  // archive PDF, thumbnail and original images. Filed (fully processed)
  // documents are untouched.
  queue.length = 0;
  const rows = con.prepare(
    `SELECT id, batch, pdf_path, thumb_path FROM documents
     WHERE pending='queued'`).all();
  for (const r of rows) {
    for (const [rel, sub] of [[r.pdf_path, "archive"], [r.thumb_path, "thumbs"]])
      if (rel) { try { fs.unlinkSync(path.join(cfg.data_root, sub, rel)); } catch {} }
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
  pipeline.clearAbort();
}

function abort() {
  if (!started) return;
  pipeline.requestAbort();
  if (wakeWorker) wakeWorker();
}

async function runWorker() {
  // Serial background queue: one document at a time through OCR + AI.
  if (workerRunning) return;
  workerRunning = true;
  while (started) {
    if (pipeline.aborted()) deleteInflight(config.load());
    const docId = queue.shift();
    if (docId === undefined) {
      await new Promise((r) => {
        wakeWorker = r;
        setTimeout(r, 1000);     // fallback tick (abort flag, races)
      });
      wakeWorker = null;
      continue;
    }
    const cfg = config.load();
    const doc = con.prepare(
      "SELECT id, batch FROM documents WHERE id=? AND pending='queued'"
    ).get(docId);
    if (!doc) continue;          // deleted by an abort, or already done
    try {
      await pipeline.processDocument(cfg, con, docId);
      const row = con.prepare(
        `SELECT title, sender_name, doc_type, duplicate_of
         FROM documents WHERE id=?`).get(docId);
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
      pipeline.log(`watcher: ${doc.batch}: understanding FAILED: ${e.message}`);
      db.event(con, "error", `processing failed: ${e.message}`,
               { batch: doc.batch, documentId: docId });
      con.prepare("UPDATE documents SET pending='error' WHERE id=?").run(docId);
      notify("Document processing failed",
             "The document is filed with its raw scan — "
             + "see the app's Activity tab.");
    }
  }
  workerRunning = false;
}

module.exports = { start, stop, abort, alive };
