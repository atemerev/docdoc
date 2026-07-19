#!/usr/bin/python3
"""scan-buttond -- auto-scan daemon for the Brother ADS-4300N.

(Successor of p215_buttond.py, which drove a Canon P-215 via the SANE
canon_dr backend. The ADS-4300N is "driverless" on Linux: ipp-usb
publishes the USB device's eSCL interface on localhost and the
sane-airscan backend scans through it. Brother's proprietary
brscan5/brscan-skey do not support the ADS-4xxx generation at all.)

The ADS-4300N exposes no scan-button events to Linux, so instead of a
hardware button the daemon watches the feeder through the eSCL
ScannerStatus endpoint: when paper is inserted (AdfState goes
empty -> loaded) it waits AUTO_SCAN_DELAY seconds and runs
`scanimage --batch` into a new timestamped directory under OUTPUT_DIR.
Set AUTO_SCAN=no to scan only on demand.

Paper already sitting in the feeder when the daemon starts does NOT
trigger a scan (so a daemon restart never re-feeds a staged stack);
remove and reinsert it, or trigger manually.

SIGUSR1 starts a scan of whatever is loaded (the docdoc app's Scan
button, and handy for testing).
SIGUSR2 aborts the scan in progress (the docdoc app's Abort button):
the running scanimage is killed and the partial batch directory is
deleted, so nothing reaches the processing pipeline.

Configuration: ~/.config/docdoc-scan.conf (KEY=VALUE, see conf example).

scanimage is pointed at a private SANE config dir
(~/.config/docdoc-scan.sane.d) that enables only the airscan backend:
full discovery loads every installed backend, including HPLIP's hpaio,
which opens a CUPS connection per probe -- a scanner-offline retry loop
once flooded cupsd to MaxClients overnight.

The scanner pads the scan window to the full requested height instead
of clipping at the end of the page, so PAGE_WIDTH/PAGE_HEIGHT (mm,
default A4) are always passed to scanimage.
"""

import datetime
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

import sane

CONF_PATH = os.path.expanduser("~/.config/docdoc-scan.conf")
SANE_DIR = os.path.expanduser("~/.config/docdoc-scan.sane.d")

DEFAULTS = {
    "OUTPUT_DIR": "~/Scans",
    "SOURCE": "ADF Duplex",       # ADF | ADF Duplex
    "MODE": "Color",              # Color | Gray
    "RESOLUTION": "300",          # 75|150|200|240|300|400|500|600
    "FORMAT": "jpeg",             # pnm | tiff | png | jpeg | pdf
    "PAGE_WIDTH": "210",          # scan window, mm (A4; the ADS-4300N
    "PAGE_HEIGHT": "297",         #   pads to the window instead of clipping)
    "EXTRA_OPTS": "",             # extra scanimage args
    "AUTO_SCAN": "yes",           # scan when paper is inserted
    "AUTO_SCAN_DELAY": "3",       # seconds between insert and scan start
    "POLL_INTERVAL": "1.0",       # seconds between feeder polls
    "MAX_EMPTY_RETRIES": "3",     # consecutive zero-page batches before giving up
    "ESCL_URL": "auto",           # eSCL base URL, or auto = probe ipp-usb ports
}

FORMAT_EXT = {"pnm": "pnm", "tiff": "tif", "png": "png", "jpeg": "jpg", "pdf": "pdf"}

# abort state (SIGUSR2): the handler kills the scanimage in flight and
# _run_batch_loop deletes the partial batch. Reset at every batch start
# so an abort received while idle cannot cancel the next scan.
ABORT = {"requested": False, "proc": None}


def on_abort(*_args):
    ABORT["requested"] = True
    proc = ABORT["proc"]
    if proc is not None and proc.poll() is None:
        proc.terminate()


def log(msg):
    print(msg, flush=True)


def load_config():
    cfg = dict(DEFAULTS)
    try:
        with open(CONF_PATH) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"')
                if key in cfg:
                    cfg[key] = val
                else:
                    log(f"config: ignoring unknown key {key!r}")
    except FileNotFoundError:
        pass
    cfg["OUTPUT_DIR"] = os.path.expanduser(cfg["OUTPUT_DIR"])
    return cfg


def notify(summary, body=""):
    if shutil.which("notify-send"):
        subprocess.run(["notify-send", "-a", "Document scanner", summary, body],
                       check=False)


def set_online(cfg, online, devname=""):
    """Maintain OUTPUT_DIR/.scanner-online so the docdoc app can tell
    'daemon running, scanner unplugged' from 'ready to scan'. Consumers
    must ignore the flag when the daemon itself is dead -- we may be
    SIGTERMed without a chance to clean up."""
    flag = os.path.join(cfg["OUTPUT_DIR"], ".scanner-online")
    if online:
        with open(flag, "w") as f:
            f.write(devname)
    else:
        try:
            os.unlink(flag)
        except FileNotFoundError:
            pass


def setup_sane_config():
    """Private SANE config enabling only airscan (see module docstring).
    airscan.conf is copied from the system so backend options still apply;
    scanimage children inherit the environment variable."""
    os.makedirs(SANE_DIR, exist_ok=True)
    with open(os.path.join(SANE_DIR, "dll.conf"), "w") as f:
        f.write("airscan\n")
    system_conf = "/etc/sane.d/airscan.conf"
    if os.path.exists(system_conf):
        shutil.copyfile(system_conf, os.path.join(SANE_DIR, "airscan.conf"))
    os.environ["SANE_CONFIG_DIR"] = SANE_DIR


class Scanner:
    """Brother ADS-4300N through two parallel channels:

    * scanning: SANE device name of the sane-airscan backend, passed to
      scanimage (discovered via python-sane against the private config);
    * feeder sensor: the eSCL ScannerStatus endpoint that ipp-usb
      publishes on localhost (sane-airscan exposes no sensor options).
    """

    def __init__(self, escl_url="auto"):
        self.devname = None
        self._auto = escl_url == "auto"
        self.escl = None if self._auto else escl_url.rstrip("/")

    def discover(self):
        devs = [d for d in sane.get_devices() if d[0].startswith("airscan:")]
        self.devname = devs[0][0] if devs else None
        if self.devname and self._auto:
            # re-probe every time: ipp-usb may pick a different port after
            # a replug, and a stale URL would wedge the reconnect loop
            escl = self._probe_escl()
            if escl != self.escl:
                log(f"eSCL status endpoint: {escl}")
            self.escl = escl
        return self.devname if (self.devname and self.escl) else None

    @staticmethod
    def _probe_escl():
        # ipp-usb allocates one HTTP port per USB device starting at 60000.
        # It 302-redirects Host: 127.0.0.1 to localhost, so use localhost.
        for port in range(60000, 60010):
            base = f"http://localhost:{port}"
            try:
                xml_text = _http_get(f"{base}/eSCL/ScannerStatus", timeout=3)
            except OSError:
                continue
            if "AdfState" in xml_text:
                return base
        return None

    def _status(self):
        """(device state, adf loaded) from eSCL, e.g. ('Idle', True)."""
        xml_text = _http_get(f"{self.escl}/eSCL/ScannerStatus", timeout=5)
        root = ET.fromstring(xml_text)
        state = adf = None
        for el in root.iter():
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "State":
                state = (el.text or "").strip()
            elif tag == "AdfState":
                adf = (el.text or "").strip()
        return state, adf == "ScannerAdfLoaded"

    def paper_loaded(self):
        return self._status()[1]

    def idle(self):
        return self._status()[0] == "Idle"


def _http_get(url, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def count_pages(outdir):
    return len([f for f in os.listdir(outdir) if re.match(r"page-\d+\.", f)])


def run_batch(scanner, cfg):
    """Scan everything in the feeder into a fresh timestamped directory."""
    ext = FORMAT_EXT.get(cfg["FORMAT"], cfg["FORMAT"])
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
    outdir = os.path.join(cfg["OUTPUT_DIR"], stamp)
    os.makedirs(outdir, exist_ok=True)
    log(f"scan: starting batch -> {outdir}")

    # explicit scan-in-progress signal for the docdoc app's progress strip
    # (removed in the finally below; consumers must treat a stale file as
    # no-scan -- we might die mid-scan)
    scanning_flag = os.path.join(cfg["OUTPUT_DIR"], ".scanning")
    with open(scanning_flag, "w") as f:
        f.write(stamp)
    ABORT["requested"] = False
    try:
        _run_batch_loop(scanner, cfg, outdir, ext)
    finally:
        try:
            os.unlink(scanning_flag)
        except FileNotFoundError:
            pass


def _run_batch_loop(scanner, cfg, outdir, ext):
    empty_tries = 0
    while not ABORT["requested"]:
        next_page = count_pages(outdir) + 1
        cmd = [
            "scanimage", "-d", scanner.devname,
            "--source", cfg["SOURCE"],
            "--mode", cfg["MODE"],
            "--resolution", cfg["RESOLUTION"],
            "--format", cfg["FORMAT"],
            "-x", cfg["PAGE_WIDTH"],
            "-y", cfg["PAGE_HEIGHT"],
            f"--batch={os.path.join(outdir, f'page-%03d.{ext}')}",
            f"--batch-start={next_page}",
        ] + cfg["EXTRA_OPTS"].split()

        before = count_pages(outdir)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True)
        ABORT["proc"] = proc
        output = proc.communicate()[0]
        ABORT["proc"] = None
        for line in output.splitlines():
            if line.strip():
                log(f"scanimage: {line}")
        if ABORT["requested"]:
            break
        scanned = count_pages(outdir) - before

        # if the batch ended but the feeder still reports paper (missed
        # pickup, multifeed stop), keep going -- trust the paper sensor.
        try:
            loaded = scanner.paper_loaded()
        except OSError as e:
            log(f"scan: feeder status unavailable ({e!r}), ending batch")
            break
        if not loaded:
            break
        if scanned == 0:
            empty_tries += 1
            if empty_tries >= int(cfg["MAX_EMPTY_RETRIES"]):
                log("scan: feeder reports paper but nothing feeds, giving up")
                notify("Scan problem",
                       "Paper is detected but does not feed. "
                       "Reseat the stack; scanning resumes automatically.")
                break
        else:
            empty_tries = 0
        time.sleep(0.5)

    if ABORT["requested"]:
        shutil.rmtree(outdir, ignore_errors=True)
        log("scan: aborted by user, partial batch deleted")
        notify("Scan aborted", "Partially scanned pages were deleted.")
        return

    total = count_pages(outdir)
    if total:
        # signal docdocd that the batch is complete and ready to process
        with open(os.path.join(outdir, ".batch-done"), "w") as f:
            f.write(datetime.datetime.now().isoformat())
        log(f"scan: done, {total} page(s) in {outdir}")
        notify(f"Scanned {total} page(s)", outdir)
    else:
        os.rmdir(outdir)
        log("scan: no pages scanned")


def main():
    cfg = load_config()
    log(f"config: {cfg}")
    os.makedirs(cfg["OUTPUT_DIR"], exist_ok=True)

    simulated = {"press": False}
    signal.signal(signal.SIGUSR1, lambda *a: simulated.update(press=True))
    signal.signal(signal.SIGUSR2, on_abort)

    setup_sane_config()
    sane.init()
    scanner = Scanner(cfg["ESCL_URL"])
    poll = float(cfg["POLL_INTERVAL"])
    auto = cfg["AUTO_SCAN"].lower() in ("yes", "true", "1", "on")

    misses = 0
    while True:
        try:
            if not scanner.discover():
                set_online(cfg, False)
                misses += 1
                delay = 5 if misses <= 24 else 30   # ~2 min fast, then back off
                if misses == 1 or misses % 20 == 0:
                    log(f"scanner not found ({misses} tries), retrying every "
                        f"{delay}s (check USB cable and `systemctl status ipp-usb`)")
                time.sleep(delay)
                continue
            misses = 0
            log(f"watching feeder of {scanner.devname}"
                + ("" if auto else " (AUTO_SCAN off, SIGUSR1/app only)"))
            set_online(cfg, True, scanner.devname)
            prev_loaded = scanner.paper_loaded()
            if prev_loaded:
                log("paper already in feeder at startup -- not auto-scanning; "
                    "reinsert it or use the app's Scan button")
            while True:
                loaded = scanner.paper_loaded()
                trigger = None
                if simulated["press"]:
                    simulated["press"] = False
                    trigger = "requested"
                elif auto and loaded and not prev_loaded:
                    log(f"paper inserted, scanning in {cfg['AUTO_SCAN_DELAY']}s")
                    time.sleep(float(cfg["AUTO_SCAN_DELAY"]))
                    loaded = scanner.paper_loaded()   # may have been pulled out
                    trigger = "auto"
                if trigger:
                    if loaded and scanner.idle():
                        run_batch(scanner, cfg)
                        cfg = load_config()  # pick up config edits between scans
                        loaded = scanner.paper_loaded()
                    elif trigger == "requested":
                        log("scan requested but no paper loaded")
                        notify("No paper", "Load sheets to start a scan.")
                prev_loaded = loaded
                time.sleep(poll)
        except KeyboardInterrupt:
            set_online(cfg, False)
            return
        except Exception as e:
            log(f"error: {e!r}; reconnecting in 3s")
            set_online(cfg, False)
            time.sleep(3)


if __name__ == "__main__":
    main()
