"use strict";
// Child-process execution with a global abort registry.
//
// requestAbort() sets the flag consulted between pipeline stages and
// kills every tracked child (ocrmypdf, claude, scanimage, ...) so the
// running stage ends promptly. The watcher turns BatchAborted into
// deletion of the in-flight documents.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliError = exports.untrackChild = exports.trackChild = exports.clearAbort = exports.aborted = exports.BatchAborted = void 0;
exports.requestAbort = requestAbort;
exports.checkAbort = checkAbort;
exports.run = run;
exports.runBinary = runBinary;
const child_process_1 = require("child_process");
class BatchAborted extends Error {
}
exports.BatchAborted = BatchAborted;
let ABORT = false;
const children = new Set();
function requestAbort() {
    ABORT = true;
    for (const child of children) {
        try {
            child.kill("SIGTERM");
        }
        catch { /* already gone */ }
    }
}
const aborted = () => ABORT;
exports.aborted = aborted;
const clearAbort = () => { ABORT = false; };
exports.clearAbort = clearAbort;
function checkAbort() {
    if (ABORT)
        throw new BatchAborted();
}
const trackChild = (c) => { children.add(c); };
exports.trackChild = trackChild;
const untrackChild = (c) => { children.delete(c); };
exports.untrackChild = untrackChild;
class CliError extends Error {
}
exports.CliError = CliError;
/** Run a CLI tool, tracked for abort. Rejects with CliError on non-zero. */
function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.execFile)(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) => {
            (0, exports.untrackChild)(child);
            if (err)
                reject(new CliError(`${cmd} failed (${err.code ?? err.signal}): `
                    + String(stderr || err.message).trim().slice(-800)));
            else
                resolve({ stdout, stderr });
        });
        (0, exports.trackChild)(child);
    });
}
/** Like run(), but with binary stdout and optional stdin payload. */
function runBinary(cmd, args, opts = {}) {
    const { spawn } = require("child_process");
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
        (0, exports.trackChild)(child);
        const chunks = [];
        child.stdout.on("data", (c) => chunks.push(c));
        child.on("error", (e) => { (0, exports.untrackChild)(child); reject(e); });
        child.on("close", (code) => {
            (0, exports.untrackChild)(child);
            if (code === 0 || (opts.okCodes ?? []).includes(code ?? -1))
                resolve(Buffer.concat(chunks));
            else
                reject(new CliError(`${cmd} exited ${code}`));
        });
        if (opts.input !== undefined)
            child.stdin.end(opts.input);
        else
            child.stdin.end();
    });
}
