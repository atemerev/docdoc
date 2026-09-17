import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractHeuristic } from "../services/extraction";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import { recordMetadata } from "../infra/metadata_history";
import type { Extraction } from "../domain/types";

const letter = `Example Régie SA
Case Postale
CH - 1211 Genève 2
T. +41 22 555 10 00

Dossier traité par : Camille MARTIN
T +41 22 555 10 89
camille.martin@example.test
Réf. 4321.567 030.20

Madame et Monsieur
Alex Example
Genève, le 27 août 2026
Madame, Monsieur,
Votre décompte est joint à ce courrier.

Références :                                             4321.567 030.20 / CMA
Merci de retourner le coupon à refunds@example.test.
`;
const ext = extractHeuristic(letter);
assert.deepEqual(
  ext.refs.map(({ kind, value }) => ({ kind, value })),
  [{ kind: "case_no", value: "4321.567 030.20" }],
);
assert.equal(ext.case_handler?.name, "Camille MARTIN");
assert.equal(ext.case_handler?.email, "camille.martin@example.test");
assert.equal(ext.case_handler?.phone, "+41 22 555 10 89");
assert.equal(ext.case_handler?.routing_code, "CMA");
assert.equal(ext.case_handler?.page, 1);
assert(ext.case_handler?.evidence.includes("Dossier traité par"));
assert.equal(ext.refs[0].evidence, "Réf. 4321.567 030.20");
assert.equal(ext.doc_date, "2026-08-27");
assert.equal(ext.doc_type, "letter");
assert.equal(
  extractHeuristic("Dossier traité par : Marie Example\nCase Postale 1234").refs
    .length,
  0,
);
assert.equal(
  extractHeuristic(
    "Dossier traité par : Marie Example\nRéf. 123456\nrefunds@example.test",
  ).case_handler?.email,
  null,
);
assert.equal(
  extractHeuristic("Dossier traité par : Marie Example\n\nrefunds@example.test")
    .case_handler?.email,
  null,
);
assert.equal(
  extractHeuristic(
    "Dossier traité par : Marie Example\fDossier traité par : Jean Example",
  ).case_handler,
  null,
);
for (const [label, value] of [
  ["Dossier n°", "AB/1234/2026"],
  ["Case number:", "AB 12345"],
  ["Aktenzeichen:", "2026-1234"],
  ["Fall-Nr.", "98765"],
  ["Référence :", "1234.567 030.20"],
  ["N/réf :", "prod-12345678-987654"],
])
  assert.equal(
    extractHeuristic(`${label} ${value}`).refs[0]?.value,
    value,
    label,
  );
assert.equal(
  extractHeuristic("Référence :\n\n1234.567 030.20").refs[0]?.value,
  "1234.567 030.20",
);
assert.equal(
  extractHeuristic(
    "Case Postale                     Case number:\n1211 Genève                      987654",
  ).refs[0]?.value,
  "987654",
);
assert.equal(
  extractHeuristic(
    "\fDossier traité par :\nCamille MARTIN\ncamille@example.test",
  ).case_handler?.page,
  2,
);
assert.equal(
  extractHeuristic("Sachbearbeiterin: Maria Beispiel\nTel. +41 44 555 10 89")
    .case_handler?.name,
  "Maria Beispiel",
);
assert.equal(
  extractHeuristic("Handled by: Alex Example\nPhone: +44 20 5555 1234")
    .case_handler?.phone,
  "+44 20 5555 1234",
);
assert.equal(
  extractHeuristic("Réf. 12345 / ABC").refs[0]?.value,
  "12345 / ABC",
  "an uncorroborated suffix remains part of the identifier",
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-correspondence-"));
const con = db.connect(path.join(dir, "docdoc.db"));
try {
  store.init(con);
  const scan = "2026-09-14T12:00:00.000Z";
  const sender = db.upsertSender(con, "example", "Example Régie SA");
  con
    .prepare(
      "INSERT INTO documents(id,created_at,scanned_at,scan_date_source,title,doc_type,doc_date,sender_id,sender_name,content,status,ai_json) VALUES (1,?,?,'capture',?,'letter','2026-08-27',?,'Example Régie SA',?,'filed',?)",
    )
    .run(
      scan,
      scan,
      ext.title,
      sender,
      letter,
      JSON.stringify({
        ...ext,
        refs: [{ kind: "case_no", value: "trait" }],
        case_handler: null,
      }),
    );
  db.addRefs(con, 1, [["case_no", "trait"]]);
  store.put(
    con,
    store.docKey(1),
    Buffer.from("original PDF bytes"),
    "application/pdf",
  );
  recordMetadata(con, 1, "Original interpretation");
  flow.refreshDocumentMetadata(con, 1);
  const doc = con.prepare("SELECT * FROM documents WHERE id=1").get() as {
    ai_json: string;
    doc_date: string;
    scanned_at: string;
    sender_id: number;
  };
  assert.deepEqual(
    (JSON.parse(doc.ai_json) as Extraction).case_handler,
    ext.case_handler,
  );
  assert.equal(doc.scanned_at, scan);
  assert.equal(doc.doc_date, "2026-08-27");
  assert.equal(doc.sender_id, sender);
  assert.equal(
    (con.prepare("SELECT count(*) n FROM senders").get() as { n: number }).n,
    1,
  );
  assert.equal(
    store.get(con, store.docKey(1))!.data.toString(),
    "original PDF bytes",
  );
  assert.equal(db.search(con, "432156703020")[0]?.id, 1);
  assert.equal(
    (
      con
        .prepare("SELECT count(*) n FROM doc_refs WHERE value='trait'")
        .get() as { n: number }
    ).n,
    0,
  );
  const history = con
    .prepare(
      "SELECT snapshot FROM document_metadata_versions WHERE document_id=1 ORDER BY recorded_from",
    )
    .all() as Array<{ snapshot: string }>;
  assert.equal(history.length, 2);
  assert.equal(JSON.parse(history[0].snapshot).refs[0].value, "trait");
  assert.equal(
    JSON.parse(JSON.parse(history[1].snapshot).ai_json).case_handler.name,
    "Camille MARTIN",
  );
  const group = flow.newGroup(con);
  store.put(con, "source/followup", Buffer.from("scan"), "text/plain");
  con
    .prepare(
      "INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/followup',1,1,?,'test')",
    )
    .run(group, letter);
  const review = flow.workbench(con)[0];
  assert.deepEqual(review.recognition.case_handler, ext.case_handler);
  assert.equal(review.metadata.refs[0]?.value, "4321.567 030.20");
  assert(review.related.some((r) => (r as { id: number }).id === 1));
  console.log(
    "Case references, handler contacts, matching and correction history passed.",
  );
} finally {
  con.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
