import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { createServer } from "http";
import {
  metadataSchema,
  validateMetadata,
  extractMetadata,
  listLocalModels,
} from "../services/metadata_model";
import { extractHeuristic } from "../services/extraction";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import {
  requestAbort,
  clearAbort,
  finishAbort,
  BatchAborted,
} from "../infra/exec";
import { DEFAULTS } from "../infra/config";
import { page } from "./fixtures";
import type { Extraction } from "../domain/types";

const ocr = `Example Agency SA
Settlement of maintenance costs
For correspondence please quote MAINT-54321.
Your property enquiries are looked after by Camille Martin.
camille@example.test
Issued 27 August 2026
Born 2 January 1981`;
const { sender_key, ...base } = extractHeuristic(ocr);
const raw = metadataSchema.parse({
  ...base,
  title: "Settlement of maintenance costs",
  doc_type: "statement",
  sender_name: "Example Agency",
  doc_date: "2026-08-27",
  date_evidence: "Issued 27 August 2026",
  refs: [
    {
      kind: "case_no",
      value: "MAINT-54321",
      page: 1,
      evidence: "For correspondence please quote MAINT-54321.",
    },
  ],
  ref_dates: [
    {
      date: "2026-08-27",
      kind: "document",
      label: "Issued",
      page: 1,
      evidence: "Issued 27 August 2026",
    },
    {
      date: "1981-01-02",
      kind: "birth",
      label: "Born",
      page: 1,
      evidence: "Born 2 January 1981",
    },
  ],
  case_handler: {
    name: "Camille Martin",
    email: "camille@example.test",
    phone: null,
    routing_code: null,
    page: 1,
    evidence:
      "Your property enquiries are looked after by Camille Martin.\ncamille@example.test",
  },
});
const senders = [{ id: 1, key: "example", name: "Example Agency SA" }];
assert.equal(
  validateMetadata(raw, ocr, null, senders).sender_name,
  "Example Agency SA",
);
assert.throws(
  () =>
    validateMetadata({ ...raw, scanned_at: "2020-01-01" }, ocr, null, senders),
  "the model cannot supply scan time",
);
assert.throws(() =>
  validateMetadata(
    { ...raw, refs: [{ kind: "invented", value: "1234" }] },
    ocr,
    null,
    senders,
  ),
);
const unsupported = validateMetadata(
  {
    ...raw,
    doc_date: "1981-01-02",
    case_opened_date: "1981-01-02",
    refs: [
      {
        kind: "case_no",
        value: "NOT-PRINTED",
        page: 1,
        evidence: "For correspondence please quote MAINT-54321.",
      },
    ],
    case_handler: { ...raw.case_handler!, phone: "+41 12 555 12 12" },
  },
  ocr,
  null,
  senders,
);
assert.equal(unsupported.doc_date, null);
assert.equal(unsupported.case_opened_date, null);
assert.equal(unsupported.refs.length, 0);
assert.equal(unsupported.case_handler?.phone, null);
assert.equal(
  validateMetadata(
    { ...raw, case_handler: { ...raw.case_handler!, page: 2 } },
    ocr,
    null,
    senders,
  ).case_handler,
  null,
);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-model-test-"));
  const oldPath = process.env.PATH;
  const con = db.connect(path.join(dir, "docdoc.db"));
  const cfg = {
    ...DEFAULTS,
    data_root: dir,
    metadata_provider: "claude-cli" as const,
  };
  try {
    store.init(con);
    db.upsertSender(con, "example", "Example Agency SA");
    fs.writeFileSync(
      path.join(dir, "response.json"),
      JSON.stringify({ structured_output: raw, is_error: false }),
    );
    fs.writeFileSync(
      path.join(dir, "claude"),
      `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=__dirname,args=process.argv.slice(2);
assert.equal(args[args.indexOf('--tools')+1],'');
assert(args.includes('--safe-mode') && args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
assert.equal(args[args.indexOf('--model')+1],'haiku');
assert.equal(JSON.parse(args[args.indexOf('--json-schema')+1]).additionalProperties,false);
const input=JSON.parse(fs.readFileSync(0,'utf8'));assert(input.pages.length && input.known_senders.includes('Example Agency SA'));
fs.appendFileSync(path.join(root,'calls'),'1');
const mode=fs.existsSync(path.join(root,'mode'))?fs.readFileSync(path.join(root,'mode'),'utf8'):'';
if(mode==='wait') setTimeout(()=>{},60000);
else if(mode==='bad') console.log('{}');
else process.stdout.write(fs.readFileSync(path.join(root,'response.json')));
`,
      { mode: 0o700 },
    );
    process.env.PATH = dir + path.delimiter + oldPath;
    const gid = flow.newGroup(con, "Scan today", null, true);
    const png = path.join(dir, "page.png"),
      pdf = path.join(dir, "page.pdf");
    fs.writeFileSync(
      png,
      page([
        [180, 180, 50, true, "Example Agency SA"],
        [180, 300, 40, false, "Settlement of maintenance costs"],
      ]),
    );
    execFileSync("img2pdf", ["--output", pdf, png]);
    store.put(con, "source/model", fs.readFileSync(pdf), "application/pdf");
    const pid = Number(
      con
        .prepare(
          "INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/model',1,1,?,'test')",
        )
        .run(gid, ocr).lastInsertRowid,
    );
    store.copy(con, "source/model", store.pageKey(pid));
    execFileSync("pdftoppm", [
      "-jpeg",
      "-scale-to",
      "480",
      "-singlefile",
      pdf,
      path.join(dir, "thumb"),
    ]);
    store.put(
      con,
      store.pageKey(pid, "thumb"),
      fs.readFileSync(path.join(dir, "thumb.jpg")),
      "image/jpeg",
    );
    await flow.recognizeGroupMetadata(cfg, con, gid, () => {});
    let group = flow.workbench(con)[0];
    assert.equal(group.metadata.refs[0]?.value, "MAINT-54321");
    assert.equal(group.recognition.case_handler?.name, "Camille Martin");
    assert.equal(group.recognition.source, "Claude Haiku");
    flow.workbench(con);
    assert.equal(
      fs.readFileSync(path.join(dir, "calls"), "utf8"),
      "1",
      "viewing never calls the model",
    );
    con
      .prepare("UPDATE review_pages SET text=? WHERE id=?")
      .run(ocr + "\nAdditional page note", pid);
    assert.match(flow.workbench(con)[0].recognition.warning!, /Pages changed/);
    con.prepare("UPDATE review_pages SET text=? WHERE id=?").run(ocr, pid);
    group = flow.workbench(con)[0];
    const doc = await flow.fileGroup(
      cfg,
      con,
      { id: gid, revision: group.revision, title: group.title },
      () => {},
    );
    const saved = JSON.parse(
      (
        con.prepare("SELECT ai_json FROM documents WHERE id=?").get(doc) as {
          ai_json: string;
        }
      ).ai_json,
    ) as Extraction;
    assert.equal(saved.metadata_source, "Claude Haiku");
    assert.equal(saved.case_handler?.name, "Camille Martin");
    assert.equal(db.search(con, "MAINT54321")[0]?.id, doc);
    assert.equal(
      fs.readFileSync(path.join(dir, "calls"), "utf8"),
      "1",
      "saving reuses reviewed metadata",
    );
    fs.writeFileSync(path.join(dir, "mode"), "bad");
    const fallback = await extractMetadata(cfg, ocr, null, senders);
    assert.equal(fallback.metadata_source, "Local OCR");
    assert.match(fallback.metadata_warning!, /unavailable/);
    await assert.rejects(
      flow.recognizeDocumentMetadata(cfg, con, doc),
      /previous details have been kept/,
    );
    assert.equal(
      JSON.parse(
        (
          con.prepare("SELECT ai_json FROM documents WHERE id=?").get(doc) as {
            ai_json: string;
          }
        ).ai_json,
      ).metadata_source,
      "Claude Haiku",
    );
    fs.writeFileSync(path.join(dir, "mode"), "wait");
    const pending = extractMetadata(cfg, ocr, null, senders);
    const caught = assert.rejects(pending, BatchAborted);
    setTimeout(requestAbort, 100);
    await caught;
    await finishAbort();
    clearAbort();
    const claudeCalls = fs.readFileSync(path.join(dir, "calls"), "utf8");
    let mode = "ok";
    const server = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "small-local" }] }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        assert.equal(payload.model, "small-local");
        assert.equal(payload.response_format.json_schema.strict, true);
        assert(payload.messages[1].content.includes("MAINT-54321"));
        if (mode === "wait") return;
        if (mode === "error") {
          res.writeHead(503);
          res.end();
          return;
        }
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: mode === "truncated" ? "length" : "stop",
                message: { content: JSON.stringify(raw) },
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      const localCfg = {
        ...cfg,
        metadata_provider: "local-server" as const,
        metadata_base_url: base,
        metadata_model: "",
      };
      assert.deepEqual(await listLocalModels(base), ["small-local"]);
      const local = await extractMetadata(localCfg, ocr, null, senders);
      assert.equal(local.metadata_source, "Local model · small-local");
      assert.equal(local.case_handler?.name, "Camille Martin");
      for (const failure of ["error", "truncated"]) {
        mode = failure;
        const result = await extractMetadata(localCfg, ocr, null, senders);
        assert.equal(result.metadata_source, "Local OCR");
        assert.match(result.metadata_warning!, /Local model unavailable/);
      }
      assert.equal(
        fs.readFileSync(path.join(dir, "calls"), "utf8"),
        claudeCalls,
        "local failure must not call Claude",
      );
      mode = "wait";
      const canceled = assert.rejects(
        extractMetadata(
          { ...localCfg, metadata_model: "small-local" },
          ocr,
          null,
          senders,
        ),
        BatchAborted,
      );
      setTimeout(requestAbort, 100);
      await canceled;
      clearAbort();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    console.log(
      "Structured metadata validation, evidence, caching, save, fallback and cancellation passed.",
    );
  } finally {
    process.env.PATH = oldPath;
    clearAbort();
    con.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
