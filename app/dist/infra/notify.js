"use strict";
// Desktop notifications (notify-send; silently a no-op when absent).
Object.defineProperty(exports, "__esModule", { value: true });
exports.notify = notify;
const child_process_1 = require("child_process");
function notify(summary, body = "", appName = "docdoc") {
    (0, child_process_1.execFile)("notify-send", ["-a", appName, summary, body], () => { });
}
