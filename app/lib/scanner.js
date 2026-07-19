// Scanner module (replaces scan_buttond.py). Button-driven, NO polling:
//
// * Hardware buttons: the ADS-4300N's Network Device Scan Buttons push
//   finished scans (multipage PDF) over SFTP/FTP/SMB into scans_dir
//   entirely in firmware (Ethernet). The watcher picks files up via
//   inotify -- this module is not involved and nothing polls anything.
//   Setup: see RESEARCH.md "Zero-polling button scanning".
// * The app's Scan button: scanNow() drives scanimage over the existing
//   eSCL/ipp-usb (or network) SANE device into a timestamped batch dir,
//   with the same .scanning flag + .batch-done marker contract the
//   watcher expects. After a batch ends, the feeder is checked ONCE
//   (missed pickup / multifeed stop) -- a one-shot check, not a poll.
// * online(): on-demand eSCL probe, cached 30 s -- runs only when the
//   UI asks for status while the window is open; no background loop.
//
// SANE discovery uses a private config dir enabling only the airscan
// backend: full discovery loads every installed backend, including
// HPLIP's hpaio, which opens a CUPS connection per probe -- a
// scanner-offline retry loop once flooded cupsd overnight.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const config = require("./config");

const SANE_DIR = path.join(os.homedir(), ".config", "docdoc-scan.sane.d");
const SCAN_DEFAULTS = {
  source: "ADF Duplex",         // ADF | ADF Duplex
  mode: "Color",                // Color | Gray
  resolution: "300",
  format: "jpeg",
  page_width: "210",            // scan window, mm (A4; the ADS-4300N pads
  page_height: "297",           //   to the window instead of clipping)
};

let devname = null;             // SANE device (airscan:...)
let esclBase = null;            // eSCL base URL on ipp-usb
let onlineCache = { at: 0, value: false };
let current = null;             // { proc, dir, stamp, aborted }

const available = () => true;

function setupSaneConfig() {
  fs.mkdirSync(SANE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SANE_DIR, "dll.conf"), "airscan\n");
  const sys = "/etc/sane.d/airscan.conf";
  if (fs.existsSync(sys))
    fs.copyFileSync(sys, path.join(SANE_DIR, "airscan.conf"));
}

async function probeEscl() {
  // ipp-usb allocates one HTTP port per USB device starting at 60000.
  // It 302-redirects Host: 127.0.0.1 to localhost, so use localhost.
  for (let port = 60000; port < 60010; port++) {
    const base = `http://localhost:${port}`;
    try {
      const res = await fetch(`${base}/eSCL/ScannerStatus`,
                              { signal: AbortSignal.timeout(3000) });
      if ((await res.text()).includes("AdfState")) return base;
    } catch {}
  }
  return null;
}

async function discover() {
  setupSaneConfig();
  try {
    const { stdout } = await execFileP("scanimage", ["-L"],
      { env: { ...process.env, SANE_CONFIG_DIR: SANE_DIR }, timeout: 30000 });
    const m = /device `?'?(airscan:[^'`\n]+)'?/.exec(stdout);
    devname = m ? m[1] : null;
  } catch {
    devname = null;
  }
  // re-probe every time: ipp-usb may pick a different port after a
  // replug, and a stale URL would wedge reconnects
  esclBase = await probeEscl();
  return devname && esclBase ? devname : null;
}

async function online() {
  // cached on-demand check -- called from status() while the UI is open
  if (Date.now() - onlineCache.at < 30000) return onlineCache.value;
  onlineCache = { at: Date.now(), value: false };
  try {
    if (!esclBase) esclBase = await probeEscl();
    if (esclBase) {
      const res = await fetch(`${esclBase}/eSCL/ScannerStatus`,
                              { signal: AbortSignal.timeout(3000) });
      onlineCache.value = (await res.text()).includes("AdfState");
      if (!onlineCache.value) esclBase = null;
    }
  } catch { esclBase = null; }
  return onlineCache.value;
}

async function paperLoaded() {
  if (!esclBase) esclBase = await probeEscl();
  if (!esclBase) return false;
  const res = await fetch(`${esclBase}/eSCL/ScannerStatus`,
                          { signal: AbortSignal.timeout(5000) });
  return (await res.text()).includes("ScannerAdfLoaded");
}

const countPages = (dir) =>
  fs.readdirSync(dir).filter((f) => /^page-\d+\./.test(f)).length;

function runScanimage(dir, ext, startAt) {
  const cfg = SCAN_DEFAULTS;
  return new Promise((resolve) => {
    const proc = spawn("scanimage", [
      "-d", devname,
      "--source", cfg.source,
      "--mode", cfg.mode,
      "--resolution", cfg.resolution,
      "--format", cfg.format,
      "-x", cfg.page_width,
      "-y", cfg.page_height,
      `--batch=${path.join(dir, `page-%03d.${ext}`)}`,
      `--batch-start=${startAt}`,
    ], { env: { ...process.env, SANE_CONFIG_DIR: SANE_DIR },
         stdio: ["ignore", "pipe", "pipe"] });
    current.proc = proc;
    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("close", () => {
      current.proc = null;
      for (const line of out.split("\n"))
        if (line.trim()) console.log(`scanimage: ${line}`);
      resolve();
    });
  });
}

async function scanNow() {
  // Scan everything in the feeder into a fresh timestamped batch dir.
  if (current) throw new Error("a scan is already running");
  if (!(await discover()))
    throw new Error("scanner not connected -- power on / plug in the ADS-4300N");
  const cfg = config.load();
  const stamp = new Date().toISOString().slice(0, 19)
    .replace("T", "_").replace(/:/g, "").slice(0, 17);
  const dir = path.join(cfg.scans_dir, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const flag = path.join(cfg.scans_dir, ".scanning");
  fs.writeFileSync(flag, stamp);
  current = { proc: null, dir, stamp, aborted: false };
  runBatch(dir, flag).catch((e) => console.log(`scan: ${e.message}`));
  return true;
}

async function runBatch(dir, flag) {
  const ext = { pnm: "pnm", tiff: "tif", png: "png", jpeg: "jpg", pdf: "pdf" }
    [SCAN_DEFAULTS.format] || SCAN_DEFAULTS.format;
  let emptyTries = 0;
  try {
    while (!current.aborted) {
      const before = countPages(dir);
      await runScanimage(dir, ext, before + 1);
      if (current.aborted) break;
      const scanned = countPages(dir) - before;
      // if the batch ended but the feeder still reports paper (missed
      // pickup, multifeed stop), keep going -- trust the paper sensor.
      // This is a one-shot post-batch check, not a poll.
      let loaded = false;
      try { loaded = await paperLoaded(); } catch { break; }
      if (!loaded) break;
      if (scanned === 0 && ++emptyTries >= 3) {
        console.log("scan: feeder reports paper but nothing feeds, giving up");
        break;
      }
      if (scanned > 0) emptyTries = 0;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (current.aborted) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("scan: aborted by user, partial batch deleted");
      return;
    }
    if (countPages(dir)) {
      // signal the watcher that the batch is complete and ready
      fs.writeFileSync(path.join(dir, ".batch-done"), "");
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    try { fs.unlinkSync(flag); } catch {}
    current = null;
  }
}

function abort() {
  if (!current) return;
  current.aborted = true;
  if (current.proc) { try { current.proc.kill("SIGTERM"); } catch {} }
}

function start() {}
function stop() { abort(); }

module.exports = { start, stop, abort, available, online, scanNow,
                   discover, paperLoaded };
