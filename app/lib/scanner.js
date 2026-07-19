// Scanner module (Phase 3 port of scan_buttond.py, button-driven).
// Until then this stub reports "not available" so the API falls back to
// signalling the legacy Python daemon.

function start() {}
function stop() {}
function abort() {}
const available = () => false;
const online = () => false;
function scanNow() {
  throw new Error("in-app scanner not active yet");
}

module.exports = { start, stop, abort, available, online, scanNow };
