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
Object.defineProperty(exports, "__esModule", { value: true });
exports.discover = discover;
exports.scan = scan;
// Discovery and one scan only when requested by the foreground app.
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const exec_1 = require("../infra/exec");
async function discover() {
    const { stdout } = await (0, exec_1.run)("scanimage", ["--formatted-device-list=%d|%v %m%n"], { timeout: 20000 });
    return stdout
        .trim()
        .split("\n")
        .filter((line) => line.includes("|"))
        .map((line) => {
        const at = line.indexOf("|");
        return { id: line.slice(0, at), name: line.slice(at + 1).trim() };
    });
}
async function scan(dir, device, onPage) {
    const devices = await discover();
    (0, exec_1.checkAbort)();
    if (device && !devices.some((d) => d.id === device))
        throw new Error("The selected scanner is not connected. Check USB and power, then try again.");
    if (!device && devices.length > 1)
        throw new Error("More than one scanner is connected. Select one in Settings.");
    const chosen = device || devices[0]?.id;
    if (!chosen)
        throw new Error("No scanner detected. Check USB and power, then try again.");
    fs.mkdirSync(dir, { recursive: true });
    const result = await new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)("scanimage", [
            "-d",
            chosen,
            "--source",
            "ADF Duplex",
            "--mode",
            "Color",
            "--resolution",
            "300",
            "--format",
            "jpeg",
            "-x",
            "210",
            "-y",
            "297",
            `--batch=${path.join(dir, "page-%04d.jpg")}`,
        ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
        (0, exec_1.trackChild)(child);
        let error = "";
        child.stderr.on("data", (data) => {
            error = (error + data.toString()).slice(-8000);
            onPage?.(fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length);
        });
        child.once("error", (e) => {
            (0, exec_1.untrackChild)(child);
            reject(e);
        });
        child.once("close", (code) => {
            (0, exec_1.untrackChild)(child);
            resolve({ code, error });
        });
    });
    const files = fs
        .readdirSync(dir)
        .filter((f) => /^page-\d+\.jpg$/.test(f))
        .sort()
        .map((f) => path.join(dir, f));
    // SANE returns 7 at normal feeder exhaustion. Never restart after a jam/multifeed.
    const normal = result.code === 0 || result.code === 7;
    if (!files.length)
        throw new Error(normal
            ? "No pages scanned. Load the feeder and try again."
            : `Scan failed: ${result.error.slice(-600)}`);
    return {
        files,
        warning: normal
            ? null
            : `Scan interrupted. Check for missing or damaged pages. ${result.error.slice(-400)}`,
    };
}
