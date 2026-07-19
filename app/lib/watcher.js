// Batch watcher + background understanding queue (Phase 2 port of
// docdoc/watchd.py). Until then this stub reports "not running" so the
// API falls back to the legacy Python daemon signals.

function start() {}
function stop() {}
function abort() {}
const alive = () => false;

module.exports = { start, stop, abort, alive };
