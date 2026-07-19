"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.alive = void 0;
exports.start = start;
exports.stop = stop;
exports.abort = abort;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config = __importStar(require("../infra/config"));
const db = __importStar(require("../infra/db"));
const exec_1 = require("../infra/exec");
const notify_1 = require("../infra/notify");
const pipeline = __importStar(require("./pipeline"));
const MARKER = ".batch-done";
const SETTLE_MS = 90000;
let started = false;
let con = null;
let scansWatcher = null;
const dirState = new Map();
const fileTimers = new Map();
const queue = [];
let wakeWorker = null;
let workerRunning = false;
const alive = () => started;
exports.alive = alive;
function start() {
    if (started)
        return;
    const cfg = config.load();
    fs.mkdirSync(cfg.scans_dir, { recursive: true });
    con = db.connect();
    started = true;
    // recover the queue: ingested before a restart, not yet understood
    const pending = con.prepare("SELECT id FROM documents WHERE pending='queued' ORDER BY id").all().map((r) => r.id);
    queue.push(...pending);
    if (pending.length)
        pipeline.log(`watcher: re-queued ${pending.length} pending document(s)`);
    scansWatcher = fs.watch(cfg.scans_dir, () => sweep(cfg));
    sweep(cfg); // batches that arrived while we were down
    void runWorker();
    pipeline.log(`watcher: watching ${cfg.scans_dir} (archive: ${cfg.data_root})`);
}
function stop() {
    started = false;
    scansWatcher?.close();
    scansWatcher = null;
    for (const st of dirState.values()) {
        st.watcher?.close();
        if (st.timer)
            clearTimeout(st.timer);
    }
    dirState.clear();
    for (const t of fileTimers.values())
        clearTimeout(t);
    fileTimers.clear();
}
function abort() {
    if (!started)
        return;
    (0, exec_1.requestAbort)();
    wakeWorker?.();
}
function sweep(cfg) {
    // (re)track every visible batch directory in scans_dir; loose files
    // get their own batch dir once the upload has settled
    let names;
    try {
        names = fs.readdirSync(cfg.scans_dir);
    }
    catch {
        return;
    }
    for (const name of names.sort()) {
        if (name.startsWith("."))
            continue;
        const p = path.join(cfg.scans_dir, name);
        let st;
        try {
            st = fs.statSync(p);
        }
        catch {
            continue;
        }
        if (st.isDirectory()) {
            track(cfg, name, p);
            continue;
        }
        if (!/\.(pdf|jpe?g|png|tiff?)$/i.test(name))
            continue;
        // uploads have no close signal visible to fs.watch -- give the
        // transfer a quiet window, re-armed on every event, then batch it
        clearTimeout(fileTimers.get(name));
        fileTimers.set(name, setTimeout(() => {
            fileTimers.delete(name);
            try {
                if (!fs.existsSync(p))
                    return;
                const stamp = new Date().toISOString().slice(0, 19)
                    .replace("T", "_").replace(/:/g, "").slice(0, 17);
                const dir = path.join(cfg.scans_dir, `${stamp}_${name.replace(/[^A-Za-z0-9._-]/g, "")}`.slice(0, 80));
                fs.mkdirSync(dir);
                fs.renameSync(p, path.join(dir, name));
                fs.writeFileSync(path.join(dir, MARKER), "");
                pipeline.log(`watcher: pushed file ${name} -> ${path.basename(dir)}`);
            }
            catch (e) {
                pipeline.log(`watcher: pushed file ${name}: ${e.message}`);
            }
        }, 5000));
    }
    // forget vanished dirs
    for (const [name, st] of dirState)
        if (!fs.existsSync(path.join(cfg.scans_dir, name))) {
            st.watcher?.close();
            if (st.timer)
                clearTimeout(st.timer);
            dirState.delete(name);
        }
}
function track(cfg, name, dir) {
    if (dirState.has(name))
        return;
    const st = { watcher: null, timer: null, ingesting: false };
    dirState.set(name, st);
    const arm = () => {
        if (st.timer)
            clearTimeout(st.timer);
        // marker written -> batch complete now; else consider ready after
        // SETTLE_MS without events (sources that write no marker)
        const delay = fs.existsSync(path.join(dir, MARKER)) ? 250 : SETTLE_MS;
        st.timer = setTimeout(() => { void ready(cfg, name, dir); }, delay);
    };
    try {
        st.watcher = fs.watch(dir, arm);
    }
    catch { /* dir vanished between listing and watch */ }
    arm();
}
async function ready(cfg, name, dir) {
    const st = dirState.get(name);
    if (!st || st.ingesting || !started || !con)
        return;
    if ((0, exec_1.aborted)())
        return; // abort sweep deletes the dirs
    if (!fs.existsSync(dir)) {
        dirState.delete(name);
        return;
    }
    st.ingesting = true;
    try {
        try {
            fs.unlinkSync(path.join(dir, MARKER));
        }
        catch { /* absent */ }
        let docId;
        try {
            docId = await pipeline.ingestBatch(cfg, con, dir);
        }
        catch (e) {
            if ((0, exec_1.aborted)()) { // ingest child killed by an abort
                fs.rmSync(dir, { recursive: true, force: true });
                return;
            }
            pipeline.log(`watcher: ${name}: ingest FAILED: ${e.message}`);
            db.event(con, "error", `batch failed: ${e.message}`, { batch: name });
            pipeline.finishBatch(cfg, dir, false);
            (0, notify_1.notify)("Document processing failed", `Batch ${name} moved to failed/ — see the app's Activity tab.`);
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
    }
    catch (e) {
        pipeline.log(`watcher: ${name}: FAILED: ${e.message}`);
        if (con)
            db.event(con, "error", `batch failed: ${e.message}`, { batch: name });
    }
    finally {
        const cur = dirState.get(name);
        if (cur) {
            cur.watcher?.close();
            if (cur.timer)
                clearTimeout(cur.timer);
            dirState.delete(name);
        }
    }
}
/**
 * Abort: delete every document still awaiting understanding -- row,
 * archive PDF, thumbnail and original images. Filed (fully processed)
 * documents are untouched.
 */
function deleteInflight(cfg) {
    if (!con)
        return;
    queue.length = 0;
    const rows = con.prepare(`SELECT id, batch, pdf_path, thumb_path FROM documents
     WHERE pending='queued'`).all();
    for (const r of rows) {
        for (const [rel, sub] of [[r.pdf_path, "archive"], [r.thumb_path, "thumbs"]])
            if (rel) {
                try {
                    fs.unlinkSync(path.join(cfg.data_root, sub, rel));
                }
                catch { /* already gone */ }
            }
        if (r.batch) {
            fs.rmSync(path.join(cfg.data_root, "originals", r.batch), { recursive: true, force: true });
            pipeline.clearProgress(cfg, r.batch);
        }
        con.prepare("DELETE FROM documents WHERE id=?").run(r.id);
    }
    if (rows.length) {
        const names = rows.map((r) => r.batch || `#${r.id}`).join(", ");
        pipeline.log(`watcher: abort deleted ${rows.length} in-flight `
            + `document(s): ${names}`);
        db.event(con, "abort", `aborted -- deleted ${rows.length} in-flight document(s)`);
        (0, notify_1.notify)("Processing aborted", `${rows.length} unprocessed document(s) deleted.`);
    }
    (0, exec_1.clearAbort)();
}
/** Serial background queue: one document at a time through OCR + AI. */
async function runWorker() {
    if (workerRunning)
        return;
    workerRunning = true;
    while (started) {
        if ((0, exec_1.aborted)())
            deleteInflight(config.load());
        const docId = queue.shift();
        if (docId === undefined) {
            await new Promise((r) => {
                wakeWorker = r;
                setTimeout(r, 1000); // fallback tick (abort flag, races)
            });
            wakeWorker = null;
            continue;
        }
        const cfg = config.load();
        const doc = con.prepare("SELECT id, batch FROM documents WHERE id=? AND pending='queued'").get(docId);
        if (!doc)
            continue; // deleted by an abort, or already done
        try {
            await pipeline.processDocument(cfg, con, docId);
            const row = con.prepare(`SELECT title, sender_name, doc_type, duplicate_of
         FROM documents WHERE id=?`).get(docId);
            if (row) {
                let body = `${row.sender_name || "?"} — ${row.title || row.doc_type}`;
                if (row.duplicate_of)
                    body += ` (duplicate of #${row.duplicate_of})`;
                (0, notify_1.notify)("Document filed", body);
            }
            if (!(cfg.keep_originals ?? true) && doc.batch)
                fs.rmSync(path.join(cfg.data_root, "originals", doc.batch), { recursive: true, force: true });
        }
        catch (e) {
            if (e instanceof pipeline.BatchAborted) {
                deleteInflight(cfg);
                continue;
            }
            pipeline.log(`watcher: ${doc.batch}: understanding FAILED: ${e.message}`);
            db.event(con, "error", `processing failed: ${e.message}`, { batch: doc.batch, documentId: docId });
            con.prepare("UPDATE documents SET pending='error' WHERE id=?").run(docId);
            (0, notify_1.notify)("Document processing failed", "The document is filed with its raw scan — "
                + "see the app's Activity tab.");
        }
    }
    workerRunning = false;
}
