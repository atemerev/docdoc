import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractHeuristic, normalize } from "../services/extraction";
import { documentDates } from "../domain/document_dates";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as flow from "../services/pipeline";
import { recordMetadata, metadataAsOf } from "../infra/metadata_history";
import { refDuplicate } from "../services/dedup";
import type { QrBill } from "../domain/types";

export const pursuitText = `Office cantonal des poursuites
V/réf : prod-76543210-123456                 Genève, le 2 août 2025
Concerne : Acte de défaut de biens
Poursuite n° 25 543210 Z
Vous trouverez en annexe à la présente l'acte de défaut de biens.
\f
Acte de défaut de biens
Procès verbal de saisie selon art. 115 LP
Case Postale 208                          Poursuite
1211 Genève 8                            25 543210 Z
ADB n° 23 25 543210 Z
Réf. : prod-76543210-123456
Débiteur
Example Person
Né(e) le        02.01.1981
Créancier                                1205 Genève
Example Delivery SA
Représentant du créancier
Collections Example SA
[1] 76543210, Facture du 09.09.2024, INV1234567 (CHF 1'582.55)
Montant de la créance             1955.50
Intérêts                           38.24
Frais                             205.80
Montant total du découvert       2'199.54
Date de l'exécution: 04 août 2025          Genève, le 04 août 2025
\f
ADB n° 23 25 543210 Z
enfants - Child (17.05.2014)
selon le constat du 1er juillet 2025
`;

const ext = extractHeuristic(pursuitText);
assert.equal(ext.doc_type, "pursuit");
assert.equal(ext.title, "Acte de défaut de biens · Poursuite 25 543210 Z");
assert.equal(ext.doc_date, "2025-08-04");
assert.equal(
  ext.case_opened_date,
  null,
  "execution and observation dates are not case initiation",
);
assert(ext.date_evidence?.startsWith("Page 2:"));
assert.deepEqual(
  ext.refs.filter((r) => r.kind === "pursuit_no").map((r) => r.value),
  ["25 543210 Z"],
  "postal address in adjacent column is not a pursuit reference",
);
for (const [kind, value] of [
  ["debt_certificate_no", "23 25 543210 Z"],
  ["office_ref", "prod-76543210-123456"],
  ["claim_no", "76543210"],
  ["invoice_no", "INV1234567"],
])
  assert(ext.refs.some((r) => r.kind === kind && r.value === value));
assert.equal(ext.pursuit!.parties.length, 3);
assert.equal(ext.pursuit!.outstanding_amount, 2199.54);
assert.equal(ext.pursuit!.claim_amount, 1955.5);
assert(
  ext.ref_dates.some((d) => d.kind === "birth" && d.date === "1981-01-02"),
);
assert(
  ext.ref_dates.some((d) => d.kind === "claim" && d.date === "2024-09-09"),
);
assert(
  ext.ref_dates.some(
    (d) => d.kind === "cover_letter" && d.date === "2025-08-02",
  ),
);
assert.equal(
  extractHeuristic(
    "Poursuite n° 25 543210 Z\nNé(e) le 02.01.1981\nFacture du 09.09.2024",
  ).doc_date,
  null,
);
assert.equal(
  extractHeuristic(
    "Betreibung Nr. 1234567\nZahlungsbefehl\nZürich, den 4. August 2025",
  ).doc_type,
  "pursuit",
);
assert.equal(
  documentDates("Genève, le 2 août 2025\nGenève, le 4 août 2025").doc_date,
  null,
  "conflicting same-priority issue dates remain unknown",
);
assert.equal(documentDates("Date du document: 31.02.2025").doc_date, null);
assert.equal(
  documentDates("Date d'ouverture du dossier: 15.06.2025", true)
    .case_opened_date,
  "2025-06-15",
);
assert.equal(
  normalize({ ...ext }, {
    amount: 10,
    is_notification: false,
    currency: "CHF",
  } as QrBill).doc_type,
  "pursuit",
  "a payment QR does not turn a pursuit into an invoice",
);
const pursuitWithQr = extractHeuristic(pursuitText, {amount: 10, currency: "CHF", is_notification: false, creditor: {name: "Referenced invoice company"}} as QrBill);
assert.equal(pursuitWithQr.amount, 2199.54, "the act's outstanding total takes precedence over an attached QR amount");
assert.equal(pursuitWithQr.sender_name, "Office cantonal des poursuites", "the issuing office is distinct from an attached invoice creditor");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-pursuit-"));
let con = db.connect(path.join(dir, "docdoc.db"));
try {
  store.init(con);
  const scan = "2026-09-14T12:00:00.000Z";
  con
    .prepare(
      "INSERT INTO documents(id,created_at,scanned_at,scan_date_source,title,doc_type,doc_date,content,status) VALUES (1,?,?, 'capture','Incorrect invoice','invoice','1981-01-02',?,'filed')",
    )
    .run(scan, scan, pursuitText);
  store.put(
    con,
    store.docKey(1),
    Buffer.from("original PDF bytes"),
    "application/pdf",
  );
  recordMetadata(con, 1, "Original interpretation");
  const before = con
    .prepare("SELECT * FROM document_metadata_versions WHERE document_id=1")
    .get() as { recorded_from: string };
  flow.refreshDocumentMetadata(con, 1);
  const doc = con.prepare("SELECT * FROM documents WHERE id=1").get() as {
    doc_date: string;
    scanned_at: string;
    case_opened_date: string | null;
  };
  assert.equal(doc.doc_date, "2025-08-04");
  assert.equal(doc.scanned_at, scan);
  assert.equal(doc.case_opened_date, null);
  assert.equal(
    store.get(con, store.docKey(1))!.data.toString(),
    "original PDF bytes",
  );
  const versions = con
    .prepare(
      "SELECT * FROM document_metadata_versions WHERE document_id=1 ORDER BY recorded_from",
    )
    .all() as Array<{ recorded_from: string; recorded_to: string | null }>;
  assert.equal(versions.length, 2);
  assert.equal(versions[0].recorded_to, versions[1].recorded_from);
  assert.equal(
    metadataAsOf(con, 1, before.recorded_from)?.metadata.doc_date,
    "1981-01-02",
  );
  assert.equal(
    metadataAsOf(con, 1, versions[1].recorded_from)?.metadata.doc_date,
    "2025-08-04",
  );
  assert.equal(
    metadataAsOf(con, 1, versions[1].recorded_from, "2024-12-31"),
    null,
  );
  assert.equal(db.search(con, "25543210Z")[0].id, 1);
  assert.equal(db.search(con, "prod76543210123456")[0].id, 1);
  const other = flow.newGroup(con);
  store.put(con, "source/followup", Buffer.from("scan"), "text/plain");
  con
    .prepare(
      "INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/followup',1,1,?,'test')",
    )
    .run(
      other,
      "Office cantonal des poursuites\nAvis de saisie\nPoursuite n° 25 543210 Z\nGenève, le 5 août 2025",
    );
  assert(
    flow.workbench(con)[0].related.some((r) => (r as { id: number }).id === 1),
  );
  assert.equal(
    refDuplicate(con, ext, pursuitText).id,
    null,
    "sharing a case is not a hard duplicate",
  );
  con
    .prepare(
      "INSERT INTO documents(id,created_at,title,status) VALUES (2,?,'Different identifier type','filed')",
    )
    .run(scan);
  db.addRefs(con, 2, [["customer_no", "25 543210 Z"]]);
  assert(!db.relatedDocuments(con, 1).some((doc) => doc.id === 2));
  const backup = path.join(dir, "backup.db");
  con.exec("PRAGMA wal_checkpoint");
  con.close();
  fs.copyFileSync(path.join(dir, "docdoc.db"), backup);
  con = db.connect(backup);
  assert.equal(
    metadataAsOf(con, 1, before.recorded_from)?.metadata.doc_date,
    "1981-01-02",
  );
  console.log(
    "Pursuit metadata, role-aware dates, typed reference matching, correction history and single-file restore passed.",
  );
} finally {
  con.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
