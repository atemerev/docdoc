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
// Capture -> page review -> persistent background queue -> explicit Library save.
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const api_1 = require("../api/api");
const store = __importStar(require("../infra/storage"));
const ocr = __importStar(require("../infra/ocr"));
const scanner = __importStar(require("../services/scanner"));
const pdfMetadata = __importStar(require("../infra/pdf_metadata"));
const splitting = __importStar(require("../services/document_split"));
const exec_1 = require("../infra/exec");
const wait = async (condition) => {
    for (let i = 0; i < 500; i++) {
        if (condition())
            return;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error("Queue did not reach the expected state");
};
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-workflow-"));
    const originalDb = process.env.DOCDOC_DB;
    process.env.DOCDOC_DB = path.join(dir, "docdoc.db");
    let api = new api_1.Api();
    await api.initialize();
    api.set_settings({ metadata_provider: "local", ocr_engine: "tesseract" });
    const realOcr = ocr.ocrPdf, realScan = scanner.scan, realEnrich = pdfMetadata.enrichStoredPdf, realPlan = splitting.planDocuments;
    let lastOcrPages = 0;
    let calls = 0, mode = "normal", entered = false, release = () => { };
    ocr.ocrPdf = async (input, output, options) => {
        calls++;
        if (mode === "fail") {
            mode = "normal";
            throw new Error("Simulated OCR failure");
        }
        if (mode === "wait") {
            const controller = new AbortController();
            (0, exec_1.trackRequest)(controller);
            try {
                await new Promise((resolve, reject) => {
                    release = resolve;
                    controller.signal.addEventListener("abort", () => reject(new exec_1.BatchAborted("Stopped")), { once: true });
                    entered = true;
                });
            }
            finally {
                (0, exec_1.untrackRequest)(controller);
                entered = false;
            }
        }
        (0, exec_1.checkAbort)();
        fs.copyFileSync(input, output);
        const pageTexts = await ocr.pdfPageTexts(input);
        lastOcrPages = pageTexts.length;
        if (pageTexts.length > 1) {
            const job = api.status().background;
            const unread = api.get_workbench().find(g => g.id === job.id).pages.filter(p => !p.excluded && !p.ocr_source);
            options?.onProgress?.(1, pageTexts.length, { completedPages: [2], activePages: [1], phase: "reading" });
            const progress = api.status().background;
            strict_1.default.equal(progress.pages.find(p => p.id === unread[1].id)?.state, "read", "out-of-order OCR completion marks the correct original page");
            strict_1.default.equal(progress.pages.find(p => p.id === unread[0].id)?.state, "reading");
            strict_1.default.equal(progress.startedAt, job.startedAt, "elapsed time stays tied to this queue job");
            (0, strict_1.default)(progress.updatedAt >= job.updatedAt);
        }
        options?.onProgress?.(pageTexts.length, pageTexts.length, { completedPages: pageTexts.map((_, i) => i + 1), activePages: [], phase: "saving" });
        return { pdf: output, source: "Test native text", pageTexts };
    };
    const make = (name, texts) => {
        const file = path.join(dir, name + ".pdf");
        (0, child_process_1.execFileSync)("python3", ["-c", `import pymupdf as f,sys,json\nd=f.open()\nfor text in json.loads(sys.argv[2]):\n p=d.new_page();p.insert_textbox((50,50,550,750),text,fontsize=12)\nd.save(sys.argv[1])`, file, JSON.stringify(texts)]);
        return file;
    };
    const group = (id) => api.get_workbench().find(g => g.id === id);
    const enqueue = async (id) => { api.enqueue_group({ id }); await api.queue.idle(); strict_1.default.equal(group(id).phase, "ready", group(id).queue_error || "queue completed"); };
    try {
        const source = make("original", ["Example Corporation\nFirst page\nCase reference: AUTO-123456", "", "Second page\nCase reference: AUTO-123456"]);
        const id = await api.import_files([source]);
        strict_1.default.equal(calls, 0, "raw capture must never load OCR");
        strict_1.default.equal(api.list_documents().length, 0, "capture is not filed prematurely");
        strict_1.default.equal(group(id).phase, "pages");
        strict_1.default.deepEqual(group(id).pages.map(p => p.excluded), [0, 1, 0]);
        (0, strict_1.default)(!group(id).needs_preparation);
        (0, strict_1.default)(group(id).pages.every(p => !p.text), "text recognition waits for Done");
        const originalPages = group(id).pages;
        const extra = make("inserted", ["Inserted page\nCase reference: AUTO-123456"]);
        await api.import_files([extra], { group_id: id, after_page_id: originalPages[0].id });
        strict_1.default.equal(calls, 0);
        let included = group(id).pages.filter(p => !p.excluded);
        strict_1.default.deepEqual(included.map(p => p.id), [originalPages[0].id, group(id).pages[1].id, originalPages[2].id]);
        strict_1.default.match(included[1].batch, /inserted/);
        await api.reorder_pages({ id, pages: group(id).pages.map(p => p.id).reverse() });
        await strict_1.default.rejects(async () => api.file_group({ id, revision: group(id).revision, title: "Too early" }), /ready to review/);
        mode = "wait";
        api.enqueue_group({ id });
        await wait(() => entered);
        strict_1.default.equal(api.busy, false, "OCR cannot lock the foreground");
        strict_1.default.equal(api.status().background?.id, id);
        const second = await api.import_files([extra]);
        strict_1.default.equal(group(second).phase, "pages", "another set is immediately available for page review");
        await api.update_group_metadata({ id, values: { title: "Reviewed letter", sender_name: "Example Corporation", doc_type: "letter", doc_date: "2026-09-10" } });
        // Stopping a foreground scanner subprocess must not abort background OCR.
        scanner.scan = async () => {
            try {
                await (0, exec_1.run)(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
            }
            catch { }
            return { files: [extra], warning: "Scan interrupted by user. Verify completeness." };
        };
        const scan = api.scan_now();
        await wait(() => api.busy);
        await api.update_group_metadata({ id, values: { title: "Reviewed letter" } });
        (0, strict_1.default)(api.busy, "metadata edits leave scanner acquisition running");
        api.abort_scan();
        const partial = await scan;
        (0, strict_1.default)(entered, "stopping scan did not cancel OCR");
        (0, strict_1.default)(group(partial).needs_preparation, "captured files survive stopped preparation");
        strict_1.default.throws(() => api.enqueue_group({ id: partial }), /Prepare/);
        await api.prepare_group({ id: partial });
        (0, strict_1.default)(!group(partial).needs_preparation);
        mode = "normal";
        release();
        await api.queue.idle();
        strict_1.default.equal(group(id).phase, "ready");
        strict_1.default.equal(group(id).title, "Reviewed letter", "model completion must retain edits made during processing");
        strict_1.default.equal(api.list_documents().length, 0);
        (0, strict_1.default)(group(id).pages.filter(p => !p.excluded)[1].text.includes("Inserted page"), "inserted PDF maps back to the right page");
        const savedId = await api.file_group({ id, revision: group(id).revision, ...group(id).metadata, title: group(id).title });
        strict_1.default.equal(api.list_documents().length, 1);
        (0, strict_1.default)(!group(id));
        const pdf = path.join(dir, "stored.pdf");
        fs.writeFileSync(pdf, store.get(api.con, store.docKey(savedId)).data);
        (0, child_process_1.execFileSync)("python3", ["-c", `import pymupdf as f,json,sys\nd=f.open(sys.argv[1]);assert len(d)==3; m=json.loads(d.embfile_get('metadata.json'));assert m['title']=='Reviewed letter';assert len(m['page_texts'])==3;assert d.metadata['title']==m['title']`, pdf]);
        await api.update_document({ id: savedId, title: "Changed in Library" });
        strict_1.default.equal(api.get_document({ id: savedId }).title, "Changed in Library");
        const reopened = await api.reopen_document({ id: savedId });
        strict_1.default.equal(group(reopened).phase, "ready");
        (0, strict_1.default)(!group(reopened).needs_preparation);
        const beforeReopen = calls;
        await api.file_group({ id: reopened, revision: group(reopened).revision, title: group(reopened).title });
        strict_1.default.equal(calls, beforeReopen, "opening and saving a Library document does not rerun OCR");
        strict_1.default.equal(api.list_documents().length, 1, "review keeps the Library ID");
        // Failure is visible; later items still run. Retry uses the same durable set.
        mode = "fail";
        api.enqueue_group({ id: second });
        api.enqueue_group({ id: partial });
        await api.queue.idle();
        strict_1.default.equal(group(second).phase, "error");
        strict_1.default.match(group(second).queue_error, /Simulated/);
        strict_1.default.equal(group(partial).phase, "ready");
        await enqueue(second);
        (0, strict_1.default)(group(second).queue_duplicates.some(g => g.id === partial), "possible duplicates in queue are flagged");
        (0, strict_1.default)(group(second).related.some((d) => d.id === savedId), "queue knows related Library documents");
        pdfMetadata.enrichStoredPdf = async (con) => {
            strict_1.default.equal(con.inTransaction, false, "external PDF tools never hold a shared database transaction open");
            await api.update_group_metadata({ id: partial, values: { title: "Queue edit survives PDF failure" } });
            throw new Error("Simulated PDF enrichment failure");
        };
        await strict_1.default.rejects(api.file_group({ id: second, revision: group(second).revision, title: "Related letter" }), /Simulated PDF/);
        strict_1.default.equal(group(partial).title, "Queue edit survives PDF failure");
        (0, strict_1.default)(group(second).target_id, "a failed PDF finish retains the review and same Library ID");
        strict_1.default.match(group(second).queue_error, /retry saving/);
        pdfMetadata.enrichStoredPdf = realEnrich;
        const secondSaved = await api.file_group({ id: second, revision: group(second).revision, title: "Related letter" });
        strict_1.default.equal(api.list_documents().length, 2, "retrying PDF enrichment does not duplicate the document");
        const clusters = api.library_groups();
        (0, strict_1.default)(clusters.some(g => g.documents.some(d => d.id === savedId) && g.documents.some(d => d.id === secondSaved)));
        (0, strict_1.default)(clusters.some(g => g.relationships.some(r => r.reason.includes("AUTO-123456"))));
        api.con.prepare("UPDATE documents SET doc_date='2020-01-01',scanned_at='2026-09-17T00:00:00Z' WHERE id=?").run(secondSaved);
        api.con.prepare("UPDATE documents SET scanned_at='2026-09-01T00:00:00Z' WHERE id=?").run(savedId);
        strict_1.default.equal(api.list_documents({ sort: "document" })[0].id, savedId);
        strict_1.default.equal(api.list_documents({ sort: "scan" })[0].id, secondSaved);
        // Multiple identities split, while the two pages of one invoice collate.
        const mixed = await api.import_files([make("invoices", [
                "Invoice no: INV-10001\nPage 2 of 2\nExample Corporation",
                "Invoice no: INV-20002\nPage 1 of 1\nExample Corporation",
                "Invoice no: INV-10001\nPage 1 of 2\nExample Corporation",
            ])]);
        const idsBefore = new Set(api.get_workbench().map(g => g.id));
        await enqueue(mixed);
        const split = api.get_workbench().find(g => !idsBefore.has(g.id));
        (0, strict_1.default)(split, "different invoice identities split into separate documents");
        strict_1.default.equal(split.phase, "ready");
        strict_1.default.deepEqual(group(mixed).pages.map(p => p.marker), ["1/2", "2/2"]);
        strict_1.default.match(split.pages[0].text, /INV-20002/);
        (0, strict_1.default)(group(mixed).queue_note && split.queue_note);
        const chosenOrder = group(mixed).pages.map(p => p.id).reverse();
        await api.reorder_pages({ id: mixed, pages: chosenOrder });
        await enqueue(mixed);
        strict_1.default.deepEqual(group(mixed).pages.map(p => p.id), chosenOrder, "collation respects manual page order");
        await api.edit_page({ id: split.pages[0].id, group_id: mixed });
        const groupCount = api.get_workbench().length;
        await enqueue(mixed);
        strict_1.default.equal(api.get_workbench().length, groupCount, "manual regrouping is not split again");
        strict_1.default.equal(group(mixed).pages.length, 3);
        // A model partition is applied automatically, and children finish in the
        // same queue without another OCR or split request.
        let plans = 0;
        splitting.planDocuments = async (_cfg, pages) => {
            plans++;
            return { documents: [{ pageIds: [pages[0].id, pages[2].id], reason: "Letter and its continuation" }, { pageIds: [pages[1].id], reason: "Separate appointment notice" }] };
        };
        const semantic = await api.import_files([make("ordinary-letters", [
                "Example Corporation\nDear customer, your rent changes next month.",
                "Example Corporation\nPlease attend your inspection on Friday.",
                "Further terms of your rent adjustment are enclosed.\nYours sincerely.",
            ])]);
        const semanticPages = group(semantic).pages.map(p => p.id), beforeSemantic = new Set(api.get_workbench().map(g => g.id)), beforeOcr = calls;
        await enqueue(semantic);
        const semanticChild = api.get_workbench().find(g => !beforeSemantic.has(g.id));
        strict_1.default.equal(plans, 1, "split children keep the validated partition");
        strict_1.default.equal(calls, beforeOcr + 1, "split children reuse their recognized pages");
        strict_1.default.equal(semanticChild.phase, "ready", "all split documents finish automatically");
        strict_1.default.deepEqual(group(semantic).pages.map(p => p.id), [semanticPages[0], semanticPages[2]]);
        strict_1.default.deepEqual(semanticChild.pages.map(p => p.id), [semanticPages[1]]);
        strict_1.default.match(semanticChild.queue_note, /Automatically separated/);
        splitting.planDocuments = realPlan;
        // Page edits cancel only that item before mutating its pages.
        const edit = await api.import_files([source]);
        mode = "wait";
        api.enqueue_group({ id: edit });
        await wait(() => entered);
        const toRemove = group(edit).pages[0].id;
        await api.edit_page({ id: toRemove, group_id: edit, excluded: true });
        strict_1.default.equal(group(edit).phase, "pages");
        strict_1.default.equal(group(edit).pages[0].text, "");
        mode = "normal";
        await enqueue(edit);
        strict_1.default.equal(group(edit).pages[0].excluded, 1);
        // Closing aborts workers and persists the pending state; reopening resumes it.
        const resume = await api.import_files([extra]);
        mode = "wait";
        api.enqueue_group({ id: resume });
        await wait(() => entered);
        await api.update_group_metadata({ id: resume, values: { title: "Survives restart" } });
        await api.shutdown();
        mode = "normal";
        api = new api_1.Api();
        await api.initialize();
        await api.queue.idle();
        strict_1.default.equal(group(resume).phase, "ready");
        strict_1.default.equal(group(resume).title, "Survives restart");
        strict_1.default.equal(api.list_documents().length, 2, "resuming never files documents automatically");
        await api.import_files([extra], { group_id: resume, after_page_id: 0 });
        await enqueue(resume);
        strict_1.default.equal(lastOcrPages, 1, "adding one page recognizes only that new page");
        console.log("Workflow: blank removal before OCR, insertion/order, concurrent scan, scoped stop, queue failure/retry, metadata edits, splitting/collation, duplicate/related hints, explicit Library save, date sorts, PDF enrichment, restart resume passed.");
    }
    finally {
        ocr.ocrPdf = realOcr;
        scanner.scan = realScan;
        pdfMetadata.enrichStoredPdf = realEnrich;
        splitting.planDocuments = realPlan;
        if (api.con.open)
            await api.shutdown();
        if (originalDb)
            process.env.DOCDOC_DB = originalDb;
        else
            delete process.env.DOCDOC_DB;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
