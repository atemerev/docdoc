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
exports.pythonScript = exports.defaultExportDirectory = void 0;
exports.exportPdf = exportPdf;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const store = __importStar(require("../infra/storage"));
const exec_1 = require("../infra/exec");
const pdf_metadata_1 = require("../infra/pdf_metadata");
const pipeline_1 = require("./pipeline");
const defaultExportDirectory = () => path.join(os.homedir(), "Documents", "scans");
exports.defaultExportDirectory = defaultExportDirectory;
const pythonScript = (name) => path.resolve(__dirname, "../../python", name);
exports.pythonScript = pythonScript;
/** Snapshot first, build in scratch space, publish a complete PDF without overwriting. */
async function exportPdf(con, target, directory, destination) {
    if (!Number.isSafeInteger(target.id) ||
        target.id < 1 ||
        !["group", "document"].includes(target.kind))
        throw new Error("Choose a document or scan to export.");
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-export-"));
    try {
        let input, metadata;
        if (target.kind === "group") {
            const snapshot = (0, pipeline_1.workbench)(con).find((g) => g.id === target.id);
            if (!snapshot)
                throw new Error("Scan not found.");
            if (snapshot.imports.length)
                throw new Error("Read the remaining scans before exporting.");
            const kept = snapshot.pages.filter((p) => !p.excluded);
            if (kept.some((p) => p.issue === "Not read yet"))
                throw new Error("Read the pages before exporting.");
            const ext = (0, pipeline_1.groupExtraction)(con, (0, pipeline_1.group)(con, target.id), con.prepare("SELECT * FROM senders ORDER BY id").all());
            metadata = {
                ...ext,
                ...snapshot.metadata,
                title: snapshot.title,
                summary: ext.summary_en,
                scanned_at: snapshot.scanned_at,
                scan_date_source: "capture",
                review_status: "awaiting_review",
                review_warnings: snapshot.warnings,
                recognition_source: ext.metadata_source,
                page_texts: kept.map((p) => p.text),
                page_ids: kept.map((p) => p.id),
                group_id: target.id,
            };
            input = await (0, pipeline_1.combined)(con, kept, work);
        }
        else {
            const doc = con
                .prepare("SELECT * FROM documents WHERE id=?")
                .get(target.id);
            const pdf = store.get(con, store.docKey(target.id));
            if (!doc || !pdf)
                throw new Error("PDF not found.");
            metadata = (0, pdf_metadata_1.documentPdfMetadata)(con, target.id);
            input = path.join(work, "input.pdf");
            fs.writeFileSync(input, pdf.data);
        }
        const output = path.join(work, "export.pdf");
        await (0, pdf_metadata_1.enrichPdf)(input, output, metadata);
        (0, exec_1.checkAbort)();
        if (destination) {
            const staged = path.join(path.dirname(destination), `.docdoc-${(0, crypto_1.randomUUID)()}.pdf`);
            try {
                fs.copyFileSync(output, staged, fs.constants.COPYFILE_EXCL);
                fs.renameSync(staged, destination);
            }
            finally {
                fs.rmSync(staged, { force: true });
            }
            return destination;
        }
        fs.mkdirSync(directory, { recursive: true });
        let title = String(metadata.title || "Scan")
            .normalize("NFC")
            .replace(/[\x00-\x1f<>:"/\\|?*]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 100);
        while (Buffer.byteLength(title, "utf8") > 180)
            title = [...title].slice(0, -1).join("");
        const date = String(metadata.doc_date || metadata.scanned_at || new Date().toISOString()).slice(0, 10);
        const stem = `${date} - ${title} - ${target.kind}-${target.id}`;
        const staged = path.join(directory, `.docdoc-${(0, crypto_1.randomUUID)()}.pdf`);
        try {
            fs.copyFileSync(output, staged, fs.constants.COPYFILE_EXCL);
            for (let suffix = 0; suffix < 10000; suffix++) {
                const file = path.join(directory, `${stem}${suffix ? ` (${suffix + 1})` : ""}.pdf`);
                try {
                    fs.linkSync(staged, file);
                    return file;
                }
                catch (e) {
                    if (e.code !== "EEXIST")
                        throw e;
                }
            }
            throw new Error("Too many exports with the same name.");
        }
        finally {
            fs.rmSync(staged, { force: true });
        }
    }
    finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
