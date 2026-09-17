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
exports.documentPdfMetadata = documentPdfMetadata;
exports.enrichPdf = enrichPdf;
exports.enrichStoredPdf = enrichStoredPdf;
// The archive PDF itself carries the recognized text and metadata.
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const store = __importStar(require("./storage"));
const exec_1 = require("./exec");
function documentPdfMetadata(con, id) {
    const doc = con.prepare("SELECT * FROM documents WHERE id=?").get(id);
    if (!doc)
        throw new Error("Document not found.");
    const ext = JSON.parse(doc.ai_json || "{}");
    const pages = con
        .prepare("SELECT text FROM pages WHERE document_id=? ORDER BY page_no,scan_order")
        .all(id);
    return {
        ...ext,
        document_id: id,
        title: doc.title,
        sender_name: doc.sender_name,
        recipient_name: doc.recipient || ext.recipient_name,
        doc_type: doc.doc_type,
        doc_date: doc.doc_date,
        scanned_at: doc.scanned_at,
        scan_date_source: doc.scan_date_source,
        case_opened_date: doc.case_opened_date,
        summary: doc.summary,
        tags: JSON.parse(doc.tags || "[]"),
        recognition_source: ext.metadata_source,
        review_status: doc.reviewed ? "reviewed" : "awaiting_review",
        review_warnings: JSON.parse(doc.flags || "[]"),
        refs: con
            .prepare("SELECT kind,value,page,evidence FROM doc_refs WHERE document_id=? ORDER BY kind,norm")
            .all(id),
        metadata_history: con
            .prepare("SELECT valid_from,valid_to,recorded_from,recorded_to,source,snapshot FROM document_metadata_versions WHERE document_id=? ORDER BY recorded_from")
            .all(id),
        page_texts: pages.length
            ? pages.map((p) => p.text)
            : String(doc.content || "")
                .split("\f")
                .map((p) => p.trim()),
    };
}
async function enrichPdf(input, output, metadata) {
    await (0, exec_1.run)("python3", [path.resolve(__dirname, "../../python/export_pdf.py"), input, output], { input: JSON.stringify(metadata) });
    (0, exec_1.checkAbort)();
}
async function enrichStoredPdf(con, id) {
    const asset = store.get(con, store.docKey(id));
    if (!asset)
        return;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-metadata-"));
    try {
        const input = path.join(work, "input.pdf"), output = path.join(work, "enriched.pdf");
        fs.writeFileSync(input, asset.data);
        await enrichPdf(input, output, documentPdfMetadata(con, id));
        const data = fs.readFileSync(output);
        con.transaction(() => {
            store.put(con, store.docKey(id), data, "application/pdf");
            con.prepare("UPDATE documents SET file_sha256=? WHERE id=?").run(store.hash(data), id);
        })();
    }
    finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
