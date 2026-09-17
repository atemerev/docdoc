// Smoke test the real Electron window, IPC, grouping controls, preview and close.
import { app, dialog, type BrowserWindow } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import assert from "node:assert/strict";
import { createServer } from "http";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import { newGroup } from "../services/pipeline";
import { DEFAULTS } from "../infra/config";
import { page } from "./fixtures";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-ui-"));
process.env.DOCDOC_DB = path.join(dir, "docdoc.db");
let saveCounter = 0;
dialog.showSaveDialog = (async () => {
  const folder = path.join(dir, "exports");
  fs.mkdirSync(folder, { recursive: true });
  return {
    canceled: false,
    filePath: path.join(folder, `saved-${++saveCounter}.pdf`),
  };
}) as typeof dialog.showSaveDialog;
const con = db.connect(process.env.DOCDOC_DB);
store.init(con);
store.setSetting(con, "files_migrated", true);
store.setSetting(con, "config", {
  ...DEFAULTS,
  data_root: dir,
  metadata_provider: "local",
  ocr_engine: "tesseract",
  export_directory: path.join(dir, "exports"),
});
db.upsertSender(con, "example", "Example Corporation");
const groupId = newGroup(con, "Scan today", null, true);
for (const number of [3, 1]) {
  const image = path.join(dir, `sample-${number}.png`),
    pdf = path.join(dir, `sample-${number}.pdf`),
    thumb = path.join(dir, `thumb-${number}`);
  fs.writeFileSync(
    image,
    page([
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
    ]),
  );
  execFileSync("img2pdf", ["--output", pdf, image]);
  execFileSync("pdftoppm", [
    "-jpeg",
    "-scale-to",
    "480",
    "-singlefile",
    pdf,
    thumb,
  ]);
  const source = `source/sample-${number}.png`;
  store.put(con, source, fs.readFileSync(image), "image/png");
  const id = Number(
    con
      .prepare(
        "INSERT INTO review_pages(group_id,source_key,source_page,position,text,marker,batch) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        groupId,
        source,
        1,
        number === 3 ? 1 : 2,
        `Example Corporation\nEmployment agreement\nCase reference: CN-123456\nHandled by: Camille Martin\ncamille@example.test\nPage ${number} of 3`,
        `${number}/3`,
        "Sample scan",
      ).lastInsertRowid,
  );
  store.put(con, store.pageKey(id), fs.readFileSync(pdf), "application/pdf");
  store.put(
    con,
    store.pageKey(id, "thumb"),
    fs.readFileSync(thumb + ".jpg"),
    "image/jpeg",
  );
  if (number === 1) {
    con
      .prepare(
        "INSERT INTO documents(id,created_at,title,pages,reviewed,status) VALUES (1,?,'Sample saved document',1,1,'filed')",
      )
      .run(db.nowIso());
    store.copy(con, store.pageKey(id), store.docKey(1));
    store.copy(con, store.pageKey(id, "thumb"), store.docKey(1, "thumb"));
  }
}
// Seed raw prepared pages; actual recognition must start only after Done.
con.prepare("UPDATE review_pages SET text='',marker=NULL,blank_checked=1,issue='Not read yet'").run();
con.prepare("INSERT INTO doc_refs(document_id,kind,value,norm) VALUES (1,'case_no','CN-123456','CN123456')").run();
con.close();
dialog.showOpenDialog = (async () => ({ canceled:false, filePaths:[path.join(dir,"sample-1.pdf")] })) as typeof dialog.showOpenDialog;
const modelServer = createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
});
modelServer.listen(0, "127.0.0.1");
let done = false;
const timeout = setTimeout(() => {
  console.error("UI smoke test timed out");
  app.exit(1);
}, 180000);
app.on("browser-window-created", (_event, win) => {
  win.webContents.once(
    "did-finish-load",
    () =>
      void checkWindow(win).catch((e) => {
        console.error(e);
        app.exit(1);
      }),
  );
});
app.on("will-quit", () => {
  modelServer.closeAllConnections();
  modelServer.close();
  clearTimeout(timeout);
  if (!done) process.exitCode = 1;
  fs.rmSync(dir, { recursive: true, force: true });
});
async function checkWindow(win: BrowserWindow): Promise<void> {
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const wait = async (condition: string) => {
    for (let i = 0; i < 1200; i++) {
      if (await js(condition)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`UI condition failed: ${condition}`);
  };
  await wait('document.querySelectorAll(".page").length===2');
  assert.equal(await js('document.querySelector("#save-document").textContent'), "Done");
  assert(await js('document.querySelector(".metadata-row").hidden'));
  assert.equal((await js('window.docdoc.call("list_documents")')).length,1);
  const first=await js('document.querySelector("[data-preview-page]").dataset.previewPage');
  await js('document.querySelector("[data-down]").click()');
  await wait(`document.querySelector("[data-preview-page]").dataset.previewPage!==${JSON.stringify(first)}`);
  await js('document.querySelector("[data-exclude]").click()');
  await wait('document.querySelectorAll(".page.excluded").length===1');
  assert(await js('!document.querySelector("#excluded-pages").open'));
  await js('document.querySelector("#excluded-pages").open=true;document.querySelector(".excluded [data-exclude]").click()');
  await wait('document.querySelectorAll(".page.excluded").length===0');
  await js('document.querySelector("#insert-after").value="0";document.querySelector("#insert-import").click()');
  await wait('document.querySelectorAll(".page").length===3');
  assert.equal(await js('document.querySelector(".page small").textContent'),"sample-1.pdf");
  assert.equal((await js('window.docdoc.call("list_documents")')).length,1,"page review stays out of Library");
  await js('window.processingEvents=[];window.docdoc.onEvent(msg=>{if(msg.status)window.processingEvents.push(msg.status)});document.querySelector("#save-document").click()');
  await wait('document.querySelector("#message").textContent.startsWith("Queued.")');
  await wait('window.processingEvents.some(s=>s.background?.progress?.stage==="recognize")');
  assert(await js('!document.querySelector("#scan-btn").disabled'));
  assert(await js('!document.querySelector("#import-btn").disabled'));
  assert(await js('document.querySelector("#processing-panel").hidden'));
  await wait('!document.querySelector("#queue-live-progress").hidden');
  assert(await js('document.querySelector("#queue-live-progress [data-progress-count]").textContent.includes("of 3 pages read")'));
  assert(await js('document.querySelector("#queue-live-progress [data-queue-stage=recognize]").classList.contains("active")'));
  await js('document.querySelector("[data-view=library]").click()');
  await wait('document.querySelector("#group-library")!==null');
  assert(await js('!document.querySelector("#queue-live-progress").hidden'),"progress remains visible while browsing Library");
  await js('document.querySelector("#new-group").click()');
  await wait('document.querySelectorAll("[data-group]").length===2');
  assert(await js('document.querySelector("#queue-sidebar").textContent.includes("Processing queue")'));
  await js(`document.querySelector('[data-group="${groupId}"]').click()`);
  await wait('document.querySelector("#edit-pages")!==null');
  await wait('!document.querySelector("#selected-queue-progress").hidden');
  assert.equal(await js('document.querySelectorAll("[data-page-work]").length'),3);
  assert(await js('!document.body.textContent.includes("Some pages have not been read successfully")'),"pending pages are not reported as failed");
  assert(await js('document.querySelector("#read-pages")===null'),"active work does not offer a misleading retry");
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync("/tmp/docdoc-ui-progress.png",(await win.webContents.capturePage()).toPNG());
  // Metadata remains editable while OCR runs.
  await js('document.querySelector("#group-title").focus();document.querySelector("#group-title").value="Reviewed agreement";document.querySelector("#group-title").dispatchEvent(new Event("change"))');
  await wait('document.querySelector("#save-document")?.textContent==="Save to Library" && !document.querySelector("#save-document").disabled');
  assert.equal(await js('document.querySelector("#group-title").value'),"Reviewed agreement");
  assert(await js('document.activeElement===document.querySelector("#group-title")'),"queue updates preserve active metadata typing");
  await js('document.querySelector("#group-title").blur()');
  await wait('document.querySelector("#file-sender").value==="Example Corporation"');
  assert.equal(await js('document.querySelector("#file-type").value'),"contract");
  assert.equal(await js('document.querySelector("#file-sender").value'),"Example Corporation");
  assert(await js('document.body.textContent.includes("Possible missing pages: 2")'));
  assert(await js('document.querySelector(".reference-details").open'));
  assert(await js('document.querySelector(".case-handler").textContent.includes("Camille Martin")'));
  assert.equal((await js('window.docdoc.call("list_documents")')).length,1,"ready documents still await explicit save");
  fs.writeFileSync("/tmp/docdoc-ui-queue.png",(await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("#save-document").click()');
  await wait('document.querySelector("#message").textContent==="Saved to Library."');
  const saved=await js('window.docdoc.call("list_documents")');
  assert.equal(saved.length,2);
  const documentId=saved.find((d:{title:string})=>d.title==="Reviewed agreement").id;
  await js('document.querySelector("[data-view=library]").click()');
  await wait('document.querySelectorAll(".document").length===2');
  await js('document.querySelector("#library-sort").value="scan";document.querySelector("#library-sort").dispatchEvent(new Event("change"))');
  await wait('document.querySelector("#library-sort").value==="scan"');
  await js('document.querySelector("#group-library").click()');
  await wait('document.querySelector("#group-library").getAttribute("aria-pressed")==="true"');
  await wait('document.querySelectorAll(".relationship-group").length===1');
  assert(await js('document.querySelector(".relationship-reasons").textContent.includes("CN-123456")'));
  await js(`document.querySelector('[data-doc="${documentId}"]').click()`);
  await wait('document.querySelector("#pdf-position")?.textContent==="1 / 3"');
  assert(await js('document.querySelector("#pdf-canvas").width>300'));
  await js('document.querySelector("#library-edit").open=true;document.querySelector("#library-title").value="Edited in Library";document.querySelector("#library-metadata-form").requestSubmit()');
  await wait('document.querySelector("#modal-message")?.textContent==="Metadata saved."');
  assert.equal((await js(`window.docdoc.call("get_document",{id:${documentId}})`)).title,"Edited in Library");
  await js('document.querySelector("#export-as").click()');
  await wait('document.querySelector("#message").textContent.startsWith("Saved PDF to ")');
  assert.equal(fs.readdirSync(path.join(dir,"exports")).length,1);
  fs.writeFileSync("/tmp/docdoc-ui-library.png",(await win.webContents.capturePage()).toPNG());
  await js('document.querySelector("#modal").close()');
  await js('document.querySelector("#settings-btn").click()');
  await wait('document.querySelector("#backup-btn")!==null');
  assert(await js('document.body.textContent.includes("One file to keep")'));
  await js(
    'document.querySelector("#metadata-provider").value="local-server";document.querySelector("#metadata-provider").dispatchEvent(new Event("change"))',
  );
  assert(await js('!document.querySelector("#local-model-settings").hidden'));
  const modelAddress = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}/v1`;
  await js(
    `document.querySelector("#model-server").value=${JSON.stringify(modelAddress)};document.querySelector("#connect-model").click()`,
  );
  await wait(
    'document.querySelector("#model-connection").textContent.includes("Connected.")',
  );
  assert.equal(
    await js('document.querySelector("#model-name").value'),
    "test-model",
  );
  await js('document.querySelector("#save-settings").click()');
  await wait(
    'document.querySelector("#message")?.textContent==="Settings saved."',
  );
  const settings = await js('window.docdoc.call("get_settings")');
  assert.equal(settings.metadata_provider, "local-server");
  assert.equal(settings.metadata_model, "test-model");
  assert.equal(settings.metadata_base_url, modelAddress);
  done = true;
  console.log(
    "Electron UI: raw page review, insertion/order, exclusion/restore, concurrent queue, editable metadata, explicit Library save, related grouping, date sort, direct Library editing, export, PDF preview and settings passed. Closing window.",
  );
  win.close();
}
require("../main");
