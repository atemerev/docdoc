import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { matchSender } from "../domain/senders";
import { extractHeuristic } from "../services/extraction";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import type { SenderRow } from "../domain/types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-metadata-"));
const file = path.join(dir, "docdoc.db");
let con = db.connect(file);
try {
  store.init(con);
  const id = db.upsertSender(con, "regie", "Régie du Rhône SA");
  assert.equal(db.upsertSender(con, "regie-du-rhone", "REGIE DU RHONE"), id);
  assert.equal(db.upsertSender(con, "punctuated", "Régie du Rhône S.A."), id);
  assert.equal(
    db.findSender(con, "Regie du Rhone")!.name,
    "Régie du Rhône SA",
    "canonical spelling is preserved",
  );
  const post = db.upsertSender(con, "postfinance", "PostFinance AG");
  const senders = con.prepare("SELECT * FROM senders").all() as SenderRow[];
  // Old archives may contain a print-header mistakenly stored as a sender.
  senders.push({
    id: 999,
    key: "direct-print-out-from-e-finance",
    name: "Direct print-out from e-finance",
    uid: null,
    iban: null,
    address: null,
    notes: null,
  });
  const ext = extractHeuristic(
    "Direct print-out from e-finance\nPostFinance\nTransaction overview\n2026-09-14\nAccount movements",
    null,
    senders,
  );
  assert.equal(ext.title, "Transaction overview");
  assert.equal(ext.doc_type, "statement");
  assert.equal(ext.sender_name, "PostFinance AG");
  const printed = extractHeuristic(
    "Transaction overview | E-finance | PostFinance    https://www.postfinance.ch/page\nDirect print-out from e-finance\nLe PostFinance\nTransaction overview",
    null,
    senders,
  );
  assert.equal(printed.sender_name, "PostFinance AG");
  assert.equal(printed.title, "Transaction overview");
  assert.equal(
    extractHeuristic("Example AG\nEmployment agreement\nThe parties agree.")
      .doc_type,
    "contract",
  );
  assert.equal(extractHeuristic("").title, null);
  assert.equal(
    extractHeuristic("Invoice 1234\n15.09.2026").sender_name,
    null,
    "a document heading is not a sender",
  );
  assert.equal(
    matchSender(
      [
        { id: 1, name: "Example AG", key: "example-ag" },
        { id: 2, name: "Example GmbH", key: "example-gmbh" },
      ],
      "Example",
    ),
    undefined,
    "ambiguous shortened names are not merged",
  );
  assert.equal(
    matchSender(
      [{ id: 1, key: "a", name: "Alpha AG", iban: "CH1234" }],
      "Beta AG",
      { iban: "CH1234" },
    ),
    undefined,
    "shared bank accounts do not merge unrelated senders",
  );
  const gid = flow.newGroup(con, "Scan 9/14/2026", null, true);
  store.put(con, "source/test", Buffer.from("test"), "text/plain");
  con
    .prepare(
      "INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/test',1,1,?,'test')",
    )
    .run(gid, "PostFinance\nTransaction overview\n2026-09-14");
  let g = flow.workbench(con)[0];
  assert.equal(g.title, "Transaction overview");
  assert.equal(g.metadata.sender_name, "PostFinance AG");
  flow.updateMetadata(con, gid, {
    title: "My statement",
    sender_name: "Regie du Rhone",
    doc_type: "letter",
  });
  con.close();
  con = db.connect(file);
  store.init(con);
  g = flow.workbench(con)[0];
  assert.equal(g.title, "My statement");
  assert.equal(g.metadata.sender_name, "Régie du Rhône SA");
  assert.equal(g.metadata.doc_type, "letter");
  assert.equal(db.findSender(con, "POSTFINANCE")!.id, post);
  assert.equal(
    (con.prepare("SELECT count(*) n FROM senders").get() as { n: number }).n,
    2,
    "suggestions never create senders",
  );
  console.log(
    "Autofill, canonical sender matching, ambiguity handling, and persistent edits passed.",
  );
} finally {
  con.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
