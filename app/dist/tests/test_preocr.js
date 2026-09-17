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
// Real PDF preparation with an intercepted OCR boundary: blanks must never
// reach either engine, and the subset must map back to the original page IDs.
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const flow = __importStar(require("../services/pipeline"));
const ocr = __importStar(require("../infra/ocr"));
const config_1 = require("../infra/config");
const exec_1 = require("../infra/exec");
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-preocr-"));
    const con = db.connect(path.join(dir, "test.db"));
    store.init(con);
    const cfg = { ...config_1.DEFAULTS, data_root: dir, metadata_provider: "local" };
    const source = path.join(dir, "mixed.pdf"), blank = path.join(dir, "blank.pdf");
    (0, child_process_1.execFileSync)("python3", ["-c", `
import pymupdf as f,sys
d=f.open()
for text in ['First page', '', 'Third page', '', 'A']:
 p=d.new_page()
 if text: p.insert_text((50,80),text)
d.save(sys.argv[1])
b=f.open();b.new_page();b.new_page();b.save(sys.argv[2])
`, source, blank]);
    const realOcr = ocr.ocrPdf;
    let calls = 0;
    const inputs = [];
    ocr.ocrPdf = async (input, output, options) => {
        calls++;
        const texts = await ocr.pdfPageTexts(input);
        inputs.push(texts);
        options?.onProgress?.(1, texts.length, { completedPages: [2], activePages: [1], phase: "reading" });
        fs.copyFileSync(input, output);
        return { pdf: output, source: "Test OCR", pageTexts: texts.map((t) => `Read: ${t}`) };
    };
    try {
        const id = flow.queueFiles(con, [source], "Mixed pages");
        let checkedBeforeOcr = false;
        await flow.readGroup(cfg, con, id, (_label, progress) => {
            if (progress?.stage === "recognize" && progress.completed === 1) {
                const pages = flow.workbench(con).find((g) => g.id === id).pages;
                strict_1.default.deepEqual(progress.completedPageIds, [pages[2].id], "OCR progress maps to original page IDs after blanks are removed");
                strict_1.default.deepEqual(progress.activePageIds, [pages[0].id]);
            }
            if (progress?.stage === "recognize" && progress.completed === 0) {
                const pages = flow.workbench(con).find((g) => g.id === id).pages;
                strict_1.default.deepEqual(pages.map((p) => p.excluded), [0, 1, 0, 1, 0]);
                strict_1.default.equal(calls, 0, "blank exclusions are committed before OCR starts");
                checkedBeforeOcr = true;
            }
        });
        (0, strict_1.default)(checkedBeforeOcr);
        strict_1.default.deepEqual(inputs[0], ["First page", "Third page", "A"]);
        let group = flow.workbench(con).find((g) => g.id === id);
        strict_1.default.deepEqual(group.pages.map((p) => p.text), ["Read: First page", "", "Read: Third page", "", "Read: A"]);
        for (const p of group.pages) {
            (0, strict_1.default)(store.has(con, p.source_key), "every original stays recoverable");
            (0, strict_1.default)(store.has(con, store.pageKey(p.id)), "blank page PDF stays recoverable");
        }
        // An explicit restore overrides the detector, while manually removed
        // content does not waste OCR work on a retry.
        flow.editPage(con, group.pages[1].id, id, false);
        flow.editPage(con, group.pages[0].id, id, true);
        await flow.readGroup(cfg, con, id, () => { });
        strict_1.default.deepEqual(inputs[1], ["", "Third page", "A"]);
        group = flow.workbench(con).find((g) => g.id === id);
        strict_1.default.deepEqual(group.pages.map((p) => p.excluded), [1, 0, 0, 1, 0]);
        const allBlank = flow.queueFiles(con, [blank], "Blank stack");
        ocr.ocrPdf = async () => {
            throw new Error("An all-blank stack must never start OCR");
        };
        await flow.readGroup(cfg, con, allBlank, () => { }, true);
        const blankGroup = flow.workbench(con).find((g) => g.id === allBlank);
        (0, strict_1.default)(blankGroup.pages.every((p) => p.blank && p.excluded && !p.issue));
        (0, strict_1.default)(blankGroup.target_id, "all-blank capture stays visible for recovery");
        const failed = flow.queueFiles(con, [source], "OCR failure");
        await strict_1.default.rejects(flow.readGroup(cfg, con, failed, () => { }), /must never start OCR/);
        strict_1.default.deepEqual(flow.workbench(con).find((g) => g.id === failed).pages.map((p) => p.excluded), [0, 1, 0, 1, 0]);
        const cancelled = flow.queueFiles(con, [source], "Stopped check");
        await strict_1.default.rejects(flow.readGroup(cfg, con, cancelled, (_label, p) => {
            if (p?.stage === "blank" && p.completed === 2)
                (0, exec_1.requestAbort)();
        }));
        (0, exec_1.clearAbort)();
        strict_1.default.equal(flow.workbench(con).find((g) => g.id === cancelled).pages[1].excluded, 1);
        console.log("Pre-OCR: blank skipping, subset order, native text, restore/removal, all-blank capture, failures and cancellation passed.");
    }
    finally {
        (0, exec_1.clearAbort)();
        ocr.ocrPdf = realOcr;
        con.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
