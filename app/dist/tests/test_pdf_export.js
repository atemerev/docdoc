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
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const flow = __importStar(require("../services/pipeline"));
const pdf_export_1 = require("../services/pdf_export");
const config_1 = require("../infra/config");
async function main() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-export-test-"));
    const con = db.connect(path.join(work, "test.db"));
    store.init(con);
    try {
        const source = path.join(work, "source.pdf");
        (0, child_process_1.execFileSync)("python3", [
            "-c",
            `import pymupdf as f,sys\nd=f.open()\nfor t in ['Réduction de loyer 60% - Genève','PRIVATE REMOVED PAGE']:\n p=d.new_page();p.insert_text((50,80),t)\nd.save(sys.argv[1])`,
            source,
        ]);
        const id = flow.queueFiles(con, [source], "Scan", null, undefined, "2026-09-14T18:56:05.118Z");
        await flow.prepareImports(con, id, () => { });
        const pages = con
            .prepare("SELECT id FROM review_pages ORDER BY position")
            .all();
        con
            .prepare("UPDATE review_pages SET text='Réduction de loyer 60% - Genève',issue=NULL WHERE id=?")
            .run(pages[0].id);
        con
            .prepare("UPDATE review_pages SET text='PRIVATE REMOVED PAGE',issue=NULL,excluded=1 WHERE id=?")
            .run(pages[1].id);
        flow.updateMetadata(con, id, {
            title: "Réduction de loyer",
            sender_name: "Zoé & Émile",
            doc_date: "2026-09-10",
            doc_type: "letter",
            refs: [
                { kind: "case_no", value: "GE-123", evidence: "Manually corrected" },
            ],
        });
        const hash = store.hash(store.get(con, store.pageKey(pages[0].id)).data);
        const dir = path.join(work, "exports");
        const first = await (0, pdf_export_1.exportPdf)(con, { kind: "group", id }, dir);
        const second = await (0, pdf_export_1.exportPdf)(con, { kind: "group", id }, dir);
        strict_1.default.notEqual(first, second);
        strict_1.default.equal(store.hash(store.get(con, store.pageKey(pages[0].id)).data), hash);
        (0, strict_1.default)(flow.group(con, id));
        strict_1.default.equal(con.prepare("SELECT COUNT(*) n FROM documents").get().n, 0);
        const check = (file, status) => (0, child_process_1.execFileSync)("python3", [
            "-c",
            `import pymupdf as f,sys,json,xml.etree.ElementTree as E\nd=f.open(sys.argv[1]);original=f.open(sys.argv[2])\nassert len(d)==1\nassert d[0].get_pixmap().samples==original[0].get_pixmap().samples\nassert 'Genève' in d[0].get_text()\nassert d.metadata['title']=='Réduction de loyer'\nassert d.metadata['author']=='Zoé & Émile'\nassert 'GE-123' in d.metadata['keywords']\nassert d.metadata['creationDate']=='D:20260914185605Z'\nx=E.fromstring(d.get_xml_metadata())\nassert x.find('.//{urn:docdoc:metadata:1.0/}doc_date').text=='2026-09-10'\nassert 'PRIVATE REMOVED' not in d.get_xml_metadata()\nm=json.loads(d.embfile_get('metadata.json'))\nassert m['review_status']==sys.argv[3]\nassert m['doc_date']=='2026-09-10' and m['scanned_at']=='2026-09-14T18:56:05.118Z'\nassert 'Genève' in d.embfile_get('recognized-text.txt').decode()\nassert 'PRIVATE REMOVED' not in d.embfile_get('recognized-text.txt').decode()`,
            file,
            source,
            status,
        ]);
        check(first, "awaiting_review");
        const doc = await flow.fileGroup({ ...config_1.DEFAULTS, metadata_provider: "local" }, con, {
            id,
            revision: flow.group(con, id).revision,
            title: "Réduction de loyer",
        }, () => { });
        const saved = await (0, pdf_export_1.exportPdf)(con, { kind: "document", id: doc }, dir);
        check(saved, "reviewed");
        console.log("PDF export: searchable Unicode, properties/XMP/attachments, date roles, exclusion, unchanged rendering, safe filenames, saved/review states passed");
    }
    finally {
        con.close();
        fs.rmSync(work, { recursive: true, force: true });
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
