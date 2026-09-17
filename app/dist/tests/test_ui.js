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
// Smoke test the real Electron window, IPC, grouping controls, preview and close.
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const strict_1 = __importDefault(require("node:assert/strict"));
const http_1 = require("http");
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const pipeline_1 = require("../services/pipeline");
const config_1 = require("../infra/config");
const fixtures_1 = require("./fixtures");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-ui-"));
process.env.DOCDOC_DB = path.join(dir, "docdoc.db");
let saveCounter = 0;
electron_1.dialog.showSaveDialog = (async () => {
    const folder = path.join(dir, "exports");
    fs.mkdirSync(folder, { recursive: true });
    return {
        canceled: false,
        filePath: path.join(folder, `saved-${++saveCounter}.pdf`),
    };
});
const con = db.connect(process.env.DOCDOC_DB);
store.init(con);
store.setSetting(con, "files_migrated", true);
store.setSetting(con, "config", {
    ...config_1.DEFAULTS,
    data_root: dir,
    metadata_provider: "local",
    ocr_engine: "tesseract",
    export_directory: path.join(dir, "exports"),
});
db.upsertSender(con, "example", "Example Corporation");
const groupId = (0, pipeline_1.newGroup)(con, "Scan today", null, true);
for (const number of [3, 1]) {
    const image = path.join(dir, `sample-${number}.png`), pdf = path.join(dir, `sample-${number}.pdf`), thumb = path.join(dir, `thumb-${number}`);
    fs.writeFileSync(image, (0, fixtures_1.page)([
        [180, 180, 64, true, "Example Corporation"],
        [180, 600, 54, true, "Employment agreement"],
        [180, 760, 40, false, "Case reference: CN-123456"],
        [180, 840, 40, false, "Handled by: Camille Martin"],
        [180, 885, 40, false, "camille@example.test"],
        [
            180,
            1100,
            44,
            false,
            number === 1
                ? "The parties agree to the following terms."
                : "Signed and dated by both parties.",
        ],
        [180, 3000, 40, false, `Page ${number} of 3`],
    ]));
    (0, child_process_1.execFileSync)("img2pdf", ["--output", pdf, image]);
    (0, child_process_1.execFileSync)("pdftoppm", [
        "-jpeg",
        "-scale-to",
        "480",
        "-singlefile",
        pdf,
        thumb,
    ]);
    const source = `source/sample-${number}.png`;
    store.put(con, source, fs.readFileSync(image), "image/png");
    const id = Number(con
        .prepare("INSERT INTO review_pages(group_id,source_key,source_page,position,text,marker,batch) VALUES (?,?,?,?,?,?,?)")
        .run(groupId, source, 1, number === 3 ? 1 : 2, `Example Corporation\nEmployment agreement\nCase reference: CN-123456\nHandled by: Camille Martin\ncamille@example.test\nPage ${number} of 3`, `${number}/3`, "Sample scan").lastInsertRowid);
    store.put(con, store.pageKey(id), fs.readFileSync(pdf), "application/pdf");
    store.put(con, store.pageKey(id, "thumb"), fs.readFileSync(thumb + ".jpg"), "image/jpeg");
    if (number === 1) {
        con
            .prepare("INSERT INTO documents(id,created_at,title,pages,reviewed,status) VALUES (1,?,'Sample saved document',1,1,'filed')")
            .run(db.nowIso());
        store.copy(con, store.pageKey(id), store.docKey(1));
        store.copy(con, store.pageKey(id, "thumb"), store.docKey(1, "thumb"));
    }
}
// Seed raw prepared pages; actual recognition must start only after Done.
con.prepare("UPDATE review_pages SET text='',marker=NULL,blank_checked=1,issue='Not read yet'").run();
con.prepare("INSERT INTO doc_refs(document_id,kind,value,norm) VALUES (1,'case_no','CN-123456','CN123456')").run();
con.close();
electron_1.dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path.join(dir, "sample-1.pdf")] }));
const modelServer = (0, http_1.createServer)((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
});
modelServer.listen(0, "127.0.0.1");
let done = false;
const timeout = setTimeout(() => {
    console.error("UI smoke test timed out");
    electron_1.app.exit(1);
}, 180000);
electron_1.app.on("browser-window-created", (_event, win) => {
    win.webContents.once("did-finish-load", () => void checkWindow(win).catch((e) => {
        console.error(e);
        electron_1.app.exit(1);
    }));
});
electron_1.app.on("will-quit", () => {
    modelServer.closeAllConnections();
    modelServer.close();
    clearTimeout(timeout);
    if (!done)
        process.exitCode = 1;
    fs.rmSync(dir, { recursive: true, force: true });
});
async function checkWindow(win) {
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = async (condition) => {
        for (let i = 0; i < 1200; i++) {
            if (await js(condition))
                return;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`UI condition failed: ${condition}`);
    };
    await wait('document.querySelectorAll(".page").length===2');
    strict_1.default.equal(await js('document.querySelector("#save-document").textContent'), "Done");
    (0, strict_1.default)(await js('document.querySelector(".metadata-row").hidden'));
    strict_1.default.equal((await js('window.docdoc.call("list_documents")')).length, 1);
    const first = await js('document.querySelector("[data-preview-page]").dataset.previewPage');
    await js('document.querySelector("[data-down]").click()');
    await wait(`document.querySelector("[data-preview-page]").dataset.previewPage!==${JSON.stringify(first)}`);
    await js('document.querySelector("[data-exclude]").click()');
    await wait('document.querySelectorAll(".page.excluded").length===1');
    (0, strict_1.default)(await js('!document.querySelector("#excluded-pages").open'));
    await js('document.querySelector("#excluded-pages").open=true;document.querySelector(".excluded [data-exclude]").click()');
    await wait('document.querySelectorAll(".page.excluded").length===0');
    await js('document.querySelector("#insert-after").value="0";document.querySelector("#insert-import").click()');
    await wait('document.querySelectorAll(".page").length===3');
    strict_1.default.equal(await js('document.querySelector(".page small").textContent'), "sample-1.pdf");
    strict_1.default.equal((await js('window.docdoc.call("list_documents")')).length, 1, "page review stays out of Library");
    await js('window.processingEvents=[];window.docdoc.onEvent(msg=>{if(msg.status)window.processingEvents.push(msg.status)});document.querySelector("#save-document").click()');
    await wait('document.querySelector("#message").textContent.startsWith("Queued.")');
    await wait('window.processingEvents.some(s=>s.background?.progress?.stage==="recognize")');
    (0, strict_1.default)(await js('!document.querySelector("#scan-btn").disabled'));
    (0, strict_1.default)(await js('!document.querySelector("#import-btn").disabled'));
    (0, strict_1.default)(await js('document.querySelector("#processing-panel").hidden'));
    await wait('!document.querySelector("#queue-live-progress").hidden');
    (0, strict_1.default)(await js('document.querySelector("#queue-live-progress [data-progress-count]").textContent.includes("of 3 pages read")'));
    (0, strict_1.default)(await js('document.querySelector("#queue-live-progress [data-queue-stage=recognize]").classList.contains("active")'));
    await js('document.querySelector("[data-view=library]").click()');
    await wait('document.querySelector("#group-library")!==null');
    (0, strict_1.default)(await js('!document.querySelector("#queue-live-progress").hidden'), "progress remains visible while browsing Library");
    await js('document.querySelector("#new-group").click()');
    await wait('document.querySelectorAll("[data-group]").length===2');
    (0, strict_1.default)(await js('document.querySelector("#queue-sidebar").textContent.includes("Processing queue")'));
    await js(`document.querySelector('[data-group="${groupId}"]').click()`);
    await wait('document.querySelector("#edit-pages")!==null');
    await wait('!document.querySelector("#selected-queue-progress").hidden');
    strict_1.default.equal(await js('document.querySelectorAll("[data-page-work]").length'), 3);
    (0, strict_1.default)(await js('!document.body.textContent.includes("Some pages have not been read successfully")'), "pending pages are not reported as failed");
    (0, strict_1.default)(await js('document.querySelector("#read-pages")===null'), "active work does not offer a misleading retry");
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync("/tmp/docdoc-ui-progress.png", (await win.webContents.capturePage()).toPNG());
    // Metadata remains editable while OCR runs.
    await js('document.querySelector("#group-title").focus();document.querySelector("#group-title").value="Reviewed agreement";document.querySelector("#group-title").dispatchEvent(new Event("change"))');
    await wait('document.querySelector("#save-document")?.textContent==="Save to Library" && !document.querySelector("#save-document").disabled');
    strict_1.default.equal(await js('document.querySelector("#group-title").value'), "Reviewed agreement");
    (0, strict_1.default)(await js('document.activeElement===document.querySelector("#group-title")'), "queue updates preserve active metadata typing");
    await js('document.querySelector("#group-title").blur()');
    await wait('document.querySelector("#file-sender").value==="Example Corporation"');
    strict_1.default.equal(await js('document.querySelector("#file-type").value'), "contract");
    strict_1.default.equal(await js('document.querySelector("#file-sender").value'), "Example Corporation");
    (0, strict_1.default)(await js('document.body.textContent.includes("Possible missing pages: 2")'));
    (0, strict_1.default)(await js('document.querySelector(".reference-details").open'));
    (0, strict_1.default)(await js('document.querySelector(".case-handler").textContent.includes("Camille Martin")'));
    strict_1.default.equal((await js('window.docdoc.call("list_documents")')).length, 1, "ready documents still await explicit save");
    fs.writeFileSync("/tmp/docdoc-ui-queue.png", (await win.webContents.capturePage()).toPNG());
    await js('document.querySelector("#save-document").click()');
    await wait('document.querySelector("#message").textContent==="Saved to Library."');
    const saved = await js('window.docdoc.call("list_documents")');
    strict_1.default.equal(saved.length, 2);
    const documentId = saved.find((d) => d.title === "Reviewed agreement").id;
    await js('document.querySelector("[data-view=library]").click()');
    await wait('document.querySelectorAll(".document").length===2');
    await js('document.querySelector("#library-sort").value="scan";document.querySelector("#library-sort").dispatchEvent(new Event("change"))');
    await wait('document.querySelector("#library-sort").value==="scan"');
    await js('document.querySelector("#group-library").click()');
    await wait('document.querySelector("#group-library").getAttribute("aria-pressed")==="true"');
    await wait('document.querySelectorAll(".relationship-group").length===1');
    (0, strict_1.default)(await js('document.querySelector(".relationship-reasons").textContent.includes("CN-123456")'));
    await js(`document.querySelector('[data-doc="${documentId}"]').click()`);
    await wait('document.querySelector("#pdf-position")?.textContent==="1 / 3"');
    (0, strict_1.default)(await js('document.querySelector("#pdf-canvas").width>300'));
    await js('document.querySelector("#library-edit").open=true;document.querySelector("#library-title").value="Edited in Library";document.querySelector("#library-metadata-form").requestSubmit()');
    await wait('document.querySelector("#modal-message")?.textContent==="Metadata saved."');
    strict_1.default.equal((await js(`window.docdoc.call("get_document",{id:${documentId}})`)).title, "Edited in Library");
    await js('document.querySelector("#export-as").click()');
    await wait('document.querySelector("#message").textContent.startsWith("Saved PDF to ")');
    strict_1.default.equal(fs.readdirSync(path.join(dir, "exports")).length, 1);
    fs.writeFileSync("/tmp/docdoc-ui-library.png", (await win.webContents.capturePage()).toPNG());
    await js('document.querySelector("#modal").close()');
    await js('document.querySelector("#settings-btn").click()');
    await wait('document.querySelector("#backup-btn")!==null');
    (0, strict_1.default)(await js('document.body.textContent.includes("One file to keep")'));
    await js('document.querySelector("#metadata-provider").value="local-server";document.querySelector("#metadata-provider").dispatchEvent(new Event("change"))');
    (0, strict_1.default)(await js('!document.querySelector("#local-model-settings").hidden'));
    const modelAddress = `http://127.0.0.1:${modelServer.address().port}/v1`;
    await js(`document.querySelector("#model-server").value=${JSON.stringify(modelAddress)};document.querySelector("#connect-model").click()`);
    await wait('document.querySelector("#model-connection").textContent.includes("Connected.")');
    strict_1.default.equal(await js('document.querySelector("#model-name").value'), "test-model");
    await js('document.querySelector("#save-settings").click()');
    await wait('document.querySelector("#message")?.textContent==="Settings saved."');
    const settings = await js('window.docdoc.call("get_settings")');
    strict_1.default.equal(settings.metadata_provider, "local-server");
    strict_1.default.equal(settings.metadata_model, "test-model");
    strict_1.default.equal(settings.metadata_base_url, modelAddress);
    done = true;
    console.log("Electron UI: raw page review, insertion/order, exclusion/restore, concurrent queue, editable metadata, explicit Library save, related grouping, date sort, direct Library editing, export, PDF preview and settings passed. Closing window.");
    win.close();
}
require("../main");
