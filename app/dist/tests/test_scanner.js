"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Exercise the foreground scanner lifecycle without touching physical hardware.
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const strict_1 = __importDefault(require("node:assert/strict"));
const api_1 = require("../api/api");
const exec_1 = require("../infra/exec");
const scanner = __importStar(require("../services/scanner"));
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-scanner-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const originalPath = process.env.PATH, originalDb = process.env.DOCDOC_DB;
    // The fake SANE command emits one partial source, then waits for Stop.
    fs.writeFileSync(path.join(bin, "scanimage"), `#!/usr/bin/env python3
import sys,time,pathlib,os
if any(arg.startswith('--formatted-device-list') for arg in sys.argv):
 print('fake:usb|Test USB scanner')
 sys.exit(0)
pattern=next(arg.split('=',1)[1] for arg in sys.argv if arg.startswith('--batch='))
pathlib.Path(pattern % 1).write_bytes(b'partial source, preserved on stop')
print('captured page',file=sys.stderr,flush=True)
time.sleep(60)
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.DOCDOC_DB = path.join(dir, "docdoc.db");
    const api = new api_1.Api();
    await api.initialize();
    try {
        const task = api.scan_now();
        await strict_1.default.rejects(api.scan_now(), /current operation/);
        for (let n = 0; n < 100 && !api.label.startsWith("Scanning"); n++)
            await new Promise((r) => setTimeout(r, 30));
        (0, strict_1.default)(api.busy);
        api.abort_scan();
        await task;
        await (0, exec_1.finishAbort)();
        (0, strict_1.default)(!api.busy);
        strict_1.default.equal(api.status().processing, null);
        const groups = api.get_workbench();
        strict_1.default.equal(groups.length, 1);
        strict_1.default.equal(groups[0].imports.length, 1);
        const key = api.con.prepare("SELECT source_key FROM imports").get().source_key;
        const stored = api.con
            .prepare("SELECT data FROM blobs JOIN assets USING(sha) WHERE key=?")
            .get(key);
        strict_1.default.equal(stored.data.toString(), "partial source, preserved on stop");
        strict_1.default.equal(api.con.prepare("SELECT COUNT(*) n FROM documents").get().n, 0);
        strict_1.default.equal(groups[0].target_id, null);
        strict_1.default.equal(groups[0].phase, "pages");
        (0, strict_1.default)(groups[0].needs_preparation);
        (0, exec_1.clearAbort)();
        await strict_1.default.rejects(api.prepare_group({ id: groups[0].id }), /failed/);
        strict_1.default.deepEqual(api.status(), { busy: false, label: "Ready", processing: null, background: null, queue_version: api.queue.version }, "a failed preparation clears progress and unlocks the app");
        fs.writeFileSync(path.join(bin, "scanimage"), "#!/bin/sh\nexit 127\n", {
            mode: 0o755,
        });
        await strict_1.default.rejects(scanner.discover(), /failed/);
        console.log("Concurrent scans rejected; Stop preserves source bytes and leaves a retryable import.");
    }
    finally {
        await api.shutdown();
        process.env.PATH = originalPath;
        if (originalDb)
            process.env.DOCDOC_DB = originalDb;
        else
            delete process.env.DOCDOC_DB;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    (0, exec_1.clearAbort)();
    const long = (0, exec_1.run)("sh", ["-c", "sleep 60 & wait"]);
    await new Promise((r) => setTimeout(r, 100));
    (0, exec_1.requestAbort)();
    await strict_1.default.rejects(long);
    await (0, exec_1.finishAbort)();
    (0, exec_1.clearAbort)();
    console.log("Native process-group cancellation completed.");
}
void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
