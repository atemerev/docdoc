import assert from "node:assert/strict";
import { createServer } from "http";
import { once } from "events";
import { DEFAULTS } from "../infra/config";
import { localSplit, validateSplit, planDocuments } from "../services/document_split";
import { ExecutionScope, inScope, requestAbort } from "../infra/exec";

async function main() {
  const invoice = (id:number,ref:string,n:number,total:number) => ({id,text:`Example Corporation\nInvoice no: ${ref}\nPage ${n} of ${total}`});
  assert.deepEqual(localSplit([invoice(1,"INV-10001",2,2),invoice(2,"INV-20002",1,1),invoice(3,"INV-10001",1,2)]).map(d=>d.pageIds),[[1,3],[2]]);
  assert.deepEqual(localSplit([
    {id:1,text:"Invoice no: INV-10001\nSubject: Rent"},
    {id:2,text:"Invoice no: INV-20002\nSubject: Inspection"},
    {id:3,text:"Invoice no: INV-10001\nContinued rent charges"},
    {id:4,text:"Subject: Rent\nContinued terms"},
  ]).map(d=>d.pageIds),[[1,3,4],[2]],"continuations use the header of their own interleaved document");
  const numbered=[{id:10,text:"A letter\nPage 1 of 2"},{id:11,text:"Continued terms\nPage 2 of 2"},{id:12,text:"Another document\nPage 1 of 1"}];
  assert.deepEqual(localSplit(numbered).map(d=>d.pageIds),[[10,11],[12]]);
  const letters=[{id:40,text:"Example Corporation\nSubject: Rent adjustment\nCase reference: CN-123456"},{id:41,text:"Continued reasons and signature"},{id:42,text:"Example Corporation\nSubject: Inspection appointment\nCase reference: CN-123456"}];
  assert.deepEqual(localSplit(letters).map(d=>d.pageIds),[[40,41],[42]],"shared case references do not merge different letters");
  assert.deepEqual(localSplit([letters[0],invoice(50,"INV-10001",1,1)]).map(d=>d.pageIds),[[40],[50]],"an earlier letter is not an invoice cover");
  assert.equal(localSplit([numbered[0],{...numbered[0],id:13},numbered[1]]).length,1,"duplicate pages remain reviewable within their document");
  const valid={documents:[{pages:[1,2],reason:"Rent adjustment and continuation",evidence:[{page:1,quote:"Subject: Rent adjustment"}]},{pages:[3],reason:"Separate appointment letter",evidence:[{page:3,quote:"Inspection appointment"}]}]};
  assert.deepEqual(validateSplit(valid,letters).map(d=>d.pageIds),[[40,41],[42]]);
  for (const wrong of [
    {...valid,documents:[valid.documents[0]]},
    {...valid,documents:[valid.documents[0],{...valid.documents[1],pages:[2,3]}]},
    {...valid,documents:[valid.documents[0],{...valid.documents[1],pages:[4]}]},
    {...valid,documents:[valid.documents[0],{...valid.documents[1],evidence:[{page:3,quote:"Invented heading"}]}]},
  ]) assert.throws(()=>validateSplit(wrong,letters));

  let mode="normal", calls=0;
  const server=createServer(async(req,res)=>{
    let data="";for await (const chunk of req)data+=chunk;
    const request=JSON.parse(data);calls++;
    assert.equal(request.response_format.json_schema.name,"document_separation");
    assert(request.messages[0].content.includes("untrusted"));
    if(mode==="wait")return;
    res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify(mode==="invalid" ? {documents:[]} : valid)}}]}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const cfg={...DEFAULTS,metadata_provider:"local-server" as const,metadata_model:"test",metadata_base_url:`http://127.0.0.1:${(server.address() as any).port}/v1`};
  try {
    assert.deepEqual((await planDocuments(cfg,letters)).documents.map(d=>d.pageIds),[[40,41],[42]]);
    mode="invalid";const fallback=await planDocuments(cfg,letters);assert(fallback.warning);assert.equal(fallback.documents.length,2);
    mode="wait";const before=calls,scope=new ExecutionScope();
    const running=inScope(scope,()=>planDocuments(cfg,letters));
    const rejected=assert.rejects(running,/stopped/);
    while(calls===before)await new Promise(r=>setTimeout(r,10));
    requestAbort(scope);await rejected;
    console.log("Automatic separation: references, page restarts, ordinary letters, model schema/evidence, exhaustive page ownership, fallback and cancellation passed.");
  } finally {server.closeAllConnections();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
