"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.untrackChild = exports.trackChild = exports.clearAbort = exports.aborted = exports.finishAbort = exports.untrackRequest = exports.trackRequest = exports.inScope = exports.ExecutionScope = exports.CliError = exports.BatchAborted = void 0;
exports.requestAbort = requestAbort;
exports.checkAbort = checkAbort;
exports.run = run;
exports.runBinary = runBinary;
// Independent foreground and queue jobs own their cancellation and children.
const async_hooks_1 = require("async_hooks");
const child_process_1 = require("child_process");
class BatchAborted extends Error {
}
exports.BatchAborted = BatchAborted;
class CliError extends Error {
}
exports.CliError = CliError;
class ExecutionScope {
    aborted = false;
    children = new Set();
    requests = new Set();
    termination = new Set();
}
exports.ExecutionScope = ExecutionScope;
const contexts = new async_hooks_1.AsyncLocalStorage();
const fallback = new ExecutionScope();
const current = () => contexts.getStore() || fallback;
const inScope = (scope, action) => contexts.run(scope, action);
exports.inScope = inScope;
const trackRequest = (controller) => { current().requests.add(controller); };
exports.trackRequest = trackRequest;
const untrackRequest = (controller) => { current().requests.delete(controller); };
exports.untrackRequest = untrackRequest;
function terminate(child, signal) {
    try {
        if (child.pid)
            process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            /* already gone */
        }
    }
}
function requestAbort(scope = current()) {
    scope.aborted = true;
    for (const request of scope.requests)
        request.abort();
    for (const child of scope.children) {
        terminate(child, "SIGTERM");
        const pending = new Promise((resolve) => setTimeout(() => {
            if (scope.children.has(child))
                terminate(child, "SIGKILL");
            resolve();
        }, 2000));
        scope.termination.add(pending);
        void pending.finally(() => scope.termination.delete(pending));
    }
}
const finishAbort = async (scope = current()) => {
    await Promise.all(scope.termination);
};
exports.finishAbort = finishAbort;
const aborted = () => current().aborted;
exports.aborted = aborted;
const clearAbort = () => {
    current().aborted = false;
};
exports.clearAbort = clearAbort;
function checkAbort() {
    if (current().aborted)
        throw new BatchAborted("Operation stopped; captured sources are kept.");
}
const trackChild = (child) => {
    current().children.add(child);
};
exports.trackChild = trackChild;
const untrackChild = (child) => {
    current().children.delete(child);
};
exports.untrackChild = untrackChild;
function run(cmd, args, opts = {}) {
    checkAbort();
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(cmd, args, {
            env: opts.env,
            cwd: opts.cwd,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        (0, exports.trackChild)(child);
        child.stdin.on("error", () => {
            /* child may stop before consuming input */
        });
        child.stdin.end(opts.input);
        const out = [], err = [];
        let size = 0, failure = null;
        const timer = setTimeout(() => {
            failure = new CliError(`${cmd} timed out`);
            terminate(child, "SIGKILL");
        }, opts.timeout || 600000);
        const collect = (list, data) => {
            size += data.length;
            if (size > (opts.maxBuffer ?? 64 << 20)) {
                failure = new CliError(`${cmd} produced too much output`);
                terminate(child, "SIGKILL");
            }
            else
                list.push(data);
        };
        child.stdout.on("data", (data) => {
            collect(out, data);
            opts.onStdout?.(data.toString());
        });
        child.stderr.on("data", (data) => collect(err, data));
        child.once("error", (error) => {
            clearTimeout(timer);
            (0, exports.untrackChild)(child);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            (0, exports.untrackChild)(child);
            const stderr = Buffer.concat(err).toString();
            if (failure)
                reject(failure);
            else if (code !== 0)
                reject(new CliError(`${cmd} failed (${code}): ${stderr.trim().slice(-800)}`));
            else
                resolve({ stdout: Buffer.concat(out).toString(), stderr });
        });
    });
}
function runBinary(cmd, args, opts = {}) {
    checkAbort();
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(cmd, args, {
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        (0, exports.trackChild)(child);
        const out = [];
        let stderr = "";
        const timer = setTimeout(() => terminate(child, "SIGKILL"), 120000);
        child.stdout.on("data", (data) => out.push(data));
        child.stderr.on("data", (data) => {
            stderr = (stderr + data.toString()).slice(-1000);
        });
        child.stdin.on("error", () => {
            /* child may finish before consuming stdin */
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            (0, exports.untrackChild)(child);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            (0, exports.untrackChild)(child);
            if (code === 0 || (opts.okCodes || []).includes(code ?? -1))
                resolve(Buffer.concat(out));
            else
                reject(new CliError(`${cmd} exited ${code}: ${stderr}`));
        });
        child.stdin.end(opts.input);
    });
}
