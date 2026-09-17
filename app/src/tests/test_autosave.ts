// Capture -> page review -> persistent background queue -> explicit Library save.
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { Api } from "../api/api";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import * as ocr from "../infra/ocr";
import * as scanner from "../services/scanner";
import * as pdfMetadata from "../infra/pdf_metadata";
import * as splitting from "../services/document_split";
import { BatchAborted, checkAbort, trackRequest, untrackRequest, run } from "../infra/exec";

const wait = async (condition: () => boolean) => {
  for (let i=0;i<500;i++) { if (condition()) return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error("Queue did not reach the expected state");
};
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-workflow-"));
  const originalDb = process.env.DOCDOC_DB;
  process.env.DOCDOC_DB = path.join(dir,"docdoc.db");
  let api = new Api();
  await api.initialize();
  api.set_settings({metadata_provider:"local",ocr_engine:"tesseract"});
  const realOcr=ocr.ocrPdf, realScan=scanner.scan, realEnrich=pdfMetadata.enrichStoredPdf, realPlan=splitting.planDocuments;
  let lastOcrPages=0;
  let calls=0, mode="normal", entered=false, release=()=>{};
  (ocr as {ocrPdf:typeof ocr.ocrPdf}).ocrPdf=async(input,output,options) => {
    calls++;
    if(mode==="fail") { mode="normal"; throw new Error("Simulated OCR failure"); }
    if(mode==="wait") {
      const controller=new AbortController();trackRequest(controller);
      try { await new Promise<void>((resolve,reject)=>{
        release=resolve;
        controller.signal.addEventListener("abort",()=>reject(new BatchAborted("Stopped")),{once:true});
        entered=true;
      }); } finally {untrackRequest(controller);entered=false;}
    }
    checkAbort();
    fs.copyFileSync(input,output);
    const pageTexts=await ocr.pdfPageTexts(input);lastOcrPages=pageTexts.length;
    if (pageTexts.length>1) {
      const job=api.status().background!;
      const unread=api.get_workbench().find(g=>g.id===job.id)!.pages.filter(p=>!p.excluded&&!p.ocr_source);
      options?.onProgress?.(1,pageTexts.length,{completedPages:[2],activePages:[1],phase:"reading"});
      const progress=api.status().background!;
      assert.equal(progress.pages.find(p=>p.id===unread[1].id)?.state,"read","out-of-order OCR completion marks the correct original page");
      assert.equal(progress.pages.find(p=>p.id===unread[0].id)?.state,"reading");
      assert.equal(progress.startedAt,job.startedAt,"elapsed time stays tied to this queue job");
      assert(progress.updatedAt>=job.updatedAt);
    }
    options?.onProgress?.(pageTexts.length,pageTexts.length,{completedPages:pageTexts.map((_,i)=>i+1),activePages:[],phase:"saving"});
    return {pdf:output,source:"Test native text",pageTexts};
  };
  const make = (name:string,texts:string[]) => {
    const file=path.join(dir,name+".pdf");
    execFileSync("python3",["-c",`import pymupdf as f,sys,json\nd=f.open()\nfor text in json.loads(sys.argv[2]):\n p=d.new_page();p.insert_textbox((50,50,550,750),text,fontsize=12)\nd.save(sys.argv[1])`,file,JSON.stringify(texts)]);
    return file;
  };
  const group=(id:number)=>api.get_workbench().find(g=>g.id===id)!;
  const enqueue=async(id:number)=>{api.enqueue_group({id});await api.queue.idle();assert.equal(group(id).phase,"ready",group(id).queue_error || "queue completed");};
  try {
    const source=make("original",["Example Corporation\nFirst page\nCase reference: AUTO-123456","","Second page\nCase reference: AUTO-123456"]);
    const id=await api.import_files([source]);
    assert.equal(calls,0,"raw capture must never load OCR");
    assert.equal(api.list_documents().length,0,"capture is not filed prematurely");
    assert.equal(group(id).phase,"pages");
    assert.deepEqual(group(id).pages.map(p=>p.excluded),[0,1,0]);
    assert(!group(id).needs_preparation);
    assert(group(id).pages.every(p=>!p.text),"text recognition waits for Done");
    const originalPages=group(id).pages;
    const extra=make("inserted",["Inserted page\nCase reference: AUTO-123456"]);
    await api.import_files([extra],{group_id:id,after_page_id:originalPages[0].id});
    assert.equal(calls,0);
    let included=group(id).pages.filter(p=>!p.excluded);
    assert.deepEqual(included.map(p=>p.id),[originalPages[0].id,group(id).pages[1].id,originalPages[2].id]);
    assert.match(included[1].batch,/inserted/);
    await api.reorder_pages({id,pages:group(id).pages.map(p=>p.id).reverse()});
    await assert.rejects(async()=>api.file_group({id,revision:group(id).revision,title:"Too early"}),/ready to review/);

    mode="wait";api.enqueue_group({id});await wait(()=>entered);
    assert.equal(api.busy,false,"OCR cannot lock the foreground");
    assert.equal(api.status().background?.id,id);
    const second=await api.import_files([extra]);
    assert.equal(group(second).phase,"pages","another set is immediately available for page review");
    await api.update_group_metadata({id,values:{title:"Reviewed letter",sender_name:"Example Corporation",doc_type:"letter",doc_date:"2026-09-10"}});
    // Stopping a foreground scanner subprocess must not abort background OCR.
    (scanner as {scan:typeof scanner.scan}).scan=async()=>{
      try {await run(process.execPath,["-e","setTimeout(()=>{},30000)"]);} catch {}
      return {files:[extra],warning:"Scan interrupted by user. Verify completeness."};
    };
    const scan=api.scan_now();await wait(()=>api.busy);
    await api.update_group_metadata({id,values:{title:"Reviewed letter"}});
    assert(api.busy,"metadata edits leave scanner acquisition running");
    api.abort_scan();
    const partial=await scan;
    assert(entered,"stopping scan did not cancel OCR");
    assert(group(partial).needs_preparation,"captured files survive stopped preparation");
    assert.throws(()=>api.enqueue_group({id:partial}),/Prepare/);
    await api.prepare_group({id:partial});
    assert(!group(partial).needs_preparation);
    mode="normal";release();await api.queue.idle();
    assert.equal(group(id).phase,"ready");
    assert.equal(group(id).title,"Reviewed letter","model completion must retain edits made during processing");
    assert.equal(api.list_documents().length,0);
    assert(group(id).pages.filter(p=>!p.excluded)[1].text.includes("Inserted page"),"inserted PDF maps back to the right page");
    const savedId=await api.file_group({id,revision:group(id).revision,...group(id).metadata,title:group(id).title});
    assert.equal(api.list_documents().length,1);
    assert(!group(id));
    const pdf=path.join(dir,"stored.pdf");
    fs.writeFileSync(pdf,store.get(api.con,store.docKey(savedId))!.data);
    execFileSync("python3",["-c",`import pymupdf as f,json,sys\nd=f.open(sys.argv[1]);assert len(d)==3; m=json.loads(d.embfile_get('metadata.json'));assert m['title']=='Reviewed letter';assert len(m['page_texts'])==3;assert d.metadata['title']==m['title']`,pdf]);
    await api.update_document({id:savedId,title:"Changed in Library"});
    assert.equal((api.get_document({id:savedId}) as any).title,"Changed in Library");
    const reopened=await api.reopen_document({id:savedId});
    assert.equal(group(reopened).phase,"ready");
    assert(!group(reopened).needs_preparation);
    const beforeReopen=calls;
    await api.file_group({id:reopened,revision:group(reopened).revision,title:group(reopened).title});
    assert.equal(calls,beforeReopen,"opening and saving a Library document does not rerun OCR");
    assert.equal(api.list_documents().length,1,"review keeps the Library ID");

    // Failure is visible; later items still run. Retry uses the same durable set.
    mode="fail";api.enqueue_group({id:second});api.enqueue_group({id:partial});await api.queue.idle();
    assert.equal(group(second).phase,"error");assert.match(group(second).queue_error!,/Simulated/);
    assert.equal(group(partial).phase,"ready");
    await enqueue(second);
    assert(group(second).queue_duplicates.some(g=>g.id===partial),"possible duplicates in queue are flagged");
    assert(group(second).related.some((d:any)=>d.id===savedId),"queue knows related Library documents");
    (pdfMetadata as {enrichStoredPdf:typeof pdfMetadata.enrichStoredPdf}).enrichStoredPdf=async(con) => {
      assert.equal(con.inTransaction,false,"external PDF tools never hold a shared database transaction open");
      await api.update_group_metadata({id:partial,values:{title:"Queue edit survives PDF failure"}});
      throw new Error("Simulated PDF enrichment failure");
    };
    await assert.rejects(api.file_group({id:second,revision:group(second).revision,title:"Related letter"}),/Simulated PDF/);
    assert.equal(group(partial).title,"Queue edit survives PDF failure");
    assert(group(second).target_id,"a failed PDF finish retains the review and same Library ID");
    assert.match(group(second).queue_error!,/retry saving/);
    (pdfMetadata as {enrichStoredPdf:typeof pdfMetadata.enrichStoredPdf}).enrichStoredPdf=realEnrich;
    const secondSaved=await api.file_group({id:second,revision:group(second).revision,title:"Related letter"});
    assert.equal(api.list_documents().length,2,"retrying PDF enrichment does not duplicate the document");
    const clusters=api.library_groups();
    assert(clusters.some(g=>g.documents.some(d=>d.id===savedId)&&g.documents.some(d=>d.id===secondSaved)));
    assert(clusters.some(g=>g.relationships.some(r=>r.reason.includes("AUTO-123456"))));
    api.con.prepare("UPDATE documents SET doc_date='2020-01-01',scanned_at='2026-09-17T00:00:00Z' WHERE id=?").run(secondSaved);
    api.con.prepare("UPDATE documents SET scanned_at='2026-09-01T00:00:00Z' WHERE id=?").run(savedId);
    assert.equal((api.list_documents({sort:"document"}) as any[])[0].id,savedId);
    assert.equal((api.list_documents({sort:"scan"}) as any[])[0].id,secondSaved);

    // Multiple identities split, while the two pages of one invoice collate.
    const mixed=await api.import_files([make("invoices",[
      "Invoice no: INV-10001\nPage 2 of 2\nExample Corporation",
      "Invoice no: INV-20002\nPage 1 of 1\nExample Corporation",
      "Invoice no: INV-10001\nPage 1 of 2\nExample Corporation",
    ])]);
    const idsBefore=new Set(api.get_workbench().map(g=>g.id));
    await enqueue(mixed);
    const split=api.get_workbench().find(g=>!idsBefore.has(g.id))!;
    assert(split,"different invoice identities split into separate documents");
    assert.equal(split.phase,"ready");
    assert.deepEqual(group(mixed).pages.map(p=>p.marker),["1/2","2/2"]);
    assert.match(split.pages[0].text,/INV-20002/);
    assert(group(mixed).queue_note && split.queue_note);
    const chosenOrder=group(mixed).pages.map(p=>p.id).reverse();
    await api.reorder_pages({id:mixed,pages:chosenOrder});
    await enqueue(mixed);
    assert.deepEqual(group(mixed).pages.map(p=>p.id),chosenOrder,"collation respects manual page order");
    await api.edit_page({id:split.pages[0].id,group_id:mixed});
    const groupCount=api.get_workbench().length;
    await enqueue(mixed);
    assert.equal(api.get_workbench().length,groupCount,"manual regrouping is not split again");
    assert.equal(group(mixed).pages.length,3);

    // A model partition is applied automatically, and children finish in the
    // same queue without another OCR or split request.
    let plans=0;
    (splitting as {planDocuments:typeof splitting.planDocuments}).planDocuments=async(_cfg,pages)=>{
      plans++;
      return {documents:[{pageIds:[pages[0].id,pages[2].id],reason:"Letter and its continuation"},{pageIds:[pages[1].id],reason:"Separate appointment notice"}]};
    };
    const semantic=await api.import_files([make("ordinary-letters",[
      "Example Corporation\nDear customer, your rent changes next month.",
      "Example Corporation\nPlease attend your inspection on Friday.",
      "Further terms of your rent adjustment are enclosed.\nYours sincerely.",
    ])]);
    const semanticPages=group(semantic).pages.map(p=>p.id), beforeSemantic=new Set(api.get_workbench().map(g=>g.id)), beforeOcr=calls;
    await enqueue(semantic);
    const semanticChild=api.get_workbench().find(g=>!beforeSemantic.has(g.id))!;
    assert.equal(plans,1,"split children keep the validated partition");
    assert.equal(calls,beforeOcr+1,"split children reuse their recognized pages");
    assert.equal(semanticChild.phase,"ready","all split documents finish automatically");
    assert.deepEqual(group(semantic).pages.map(p=>p.id),[semanticPages[0],semanticPages[2]]);
    assert.deepEqual(semanticChild.pages.map(p=>p.id),[semanticPages[1]]);
    assert.match(semanticChild.queue_note!,/Automatically separated/);
    (splitting as {planDocuments:typeof splitting.planDocuments}).planDocuments=realPlan;

    // Page edits cancel only that item before mutating its pages.
    const edit=await api.import_files([source]);
    mode="wait";api.enqueue_group({id:edit});await wait(()=>entered);
    const toRemove=group(edit).pages[0].id;
    await api.edit_page({id:toRemove,group_id:edit,excluded:true});
    assert.equal(group(edit).phase,"pages");
    assert.equal(group(edit).pages[0].text,"");
    mode="normal";await enqueue(edit);
    assert.equal(group(edit).pages[0].excluded,1);

    // Closing aborts workers and persists the pending state; reopening resumes it.
    const resume=await api.import_files([extra]);
    mode="wait";api.enqueue_group({id:resume});await wait(()=>entered);
    await api.update_group_metadata({id:resume,values:{title:"Survives restart"}});
    await api.shutdown();
    mode="normal";api=new Api();await api.initialize();await api.queue.idle();
    assert.equal(group(resume).phase,"ready");assert.equal(group(resume).title,"Survives restart");
    assert.equal(api.list_documents().length,2,"resuming never files documents automatically");
    await api.import_files([extra],{group_id:resume,after_page_id:0});
    await enqueue(resume);
    assert.equal(lastOcrPages,1,"adding one page recognizes only that new page");
    console.log("Workflow: blank removal before OCR, insertion/order, concurrent scan, scoped stop, queue failure/retry, metadata edits, splitting/collation, duplicate/related hints, explicit Library save, date sorts, PDF enrichment, restart resume passed.");
  } finally {
    (ocr as {ocrPdf:typeof ocr.ocrPdf}).ocrPdf=realOcr;
    (scanner as {scan:typeof scanner.scan}).scan=realScan;
    (pdfMetadata as {enrichStoredPdf:typeof pdfMetadata.enrichStoredPdf}).enrichStoredPdf=realEnrich;
    (splitting as {planDocuments:typeof splitting.planDocuments}).planDocuments=realPlan;
    if(api.con.open) await api.shutdown();
    if(originalDb)process.env.DOCDOC_DB=originalDb;else delete process.env.DOCDOC_DB;
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
