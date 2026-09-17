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
const extraction_1 = require("../services/extraction");
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const flow = __importStar(require("../services/pipeline"));
const metadata_history_1 = require("../infra/metadata_history");
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
const ext = (0, extraction_1.extractHeuristic)(letter);
strict_1.default.deepEqual(ext.refs.map(({ kind, value }) => ({ kind, value })), [{ kind: "case_no", value: "4321.567 030.20" }]);
strict_1.default.equal(ext.case_handler?.name, "Camille MARTIN");
strict_1.default.equal(ext.case_handler?.email, "camille.martin@example.test");
strict_1.default.equal(ext.case_handler?.phone, "+41 22 555 10 89");
strict_1.default.equal(ext.case_handler?.routing_code, "CMA");
strict_1.default.equal(ext.case_handler?.page, 1);
(0, strict_1.default)(ext.case_handler?.evidence.includes("Dossier traité par"));
strict_1.default.equal(ext.refs[0].evidence, "Réf. 4321.567 030.20");
strict_1.default.equal(ext.doc_date, "2026-08-27");
strict_1.default.equal(ext.doc_type, "letter");
strict_1.default.equal((0, extraction_1.extractHeuristic)("Dossier traité par : Marie Example\nCase Postale 1234").refs
    .length, 0);
strict_1.default.equal((0, extraction_1.extractHeuristic)("Dossier traité par : Marie Example\nRéf. 123456\nrefunds@example.test").case_handler?.email, null);
strict_1.default.equal((0, extraction_1.extractHeuristic)("Dossier traité par : Marie Example\n\nrefunds@example.test")
    .case_handler?.email, null);
strict_1.default.equal((0, extraction_1.extractHeuristic)("Dossier traité par : Marie Example\fDossier traité par : Jean Example").case_handler, null);
for (const [label, value] of [
    ["Dossier n°", "AB/1234/2026"],
    ["Case number:", "AB 12345"],
    ["Aktenzeichen:", "2026-1234"],
    ["Fall-Nr.", "98765"],
    ["Référence :", "1234.567 030.20"],
    ["N/réf :", "prod-12345678-987654"],
])
    strict_1.default.equal((0, extraction_1.extractHeuristic)(`${label} ${value}`).refs[0]?.value, value, label);
strict_1.default.equal((0, extraction_1.extractHeuristic)("Référence :\n\n1234.567 030.20").refs[0]?.value, "1234.567 030.20");
strict_1.default.equal((0, extraction_1.extractHeuristic)("Case Postale                     Case number:\n1211 Genève                      987654").refs[0]?.value, "987654");
strict_1.default.equal((0, extraction_1.extractHeuristic)("\fDossier traité par :\nCamille MARTIN\ncamille@example.test").case_handler?.page, 2);
strict_1.default.equal((0, extraction_1.extractHeuristic)("Sachbearbeiterin: Maria Beispiel\nTel. +41 44 555 10 89")
    .case_handler?.name, "Maria Beispiel");
strict_1.default.equal((0, extraction_1.extractHeuristic)("Handled by: Alex Example\nPhone: +44 20 5555 1234")
    .case_handler?.phone, "+44 20 5555 1234");
strict_1.default.equal((0, extraction_1.extractHeuristic)("Réf. 12345 / ABC").refs[0]?.value, "12345 / ABC", "an uncorroborated suffix remains part of the identifier");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-correspondence-"));
const con = db.connect(path.join(dir, "docdoc.db"));
try {
    store.init(con);
    const scan = "2026-09-14T12:00:00.000Z";
    const sender = db.upsertSender(con, "example", "Example Régie SA");
    con
        .prepare("INSERT INTO documents(id,created_at,scanned_at,scan_date_source,title,doc_type,doc_date,sender_id,sender_name,content,status,ai_json) VALUES (1,?,?,'capture',?,'letter','2026-08-27',?,'Example Régie SA',?,'filed',?)")
        .run(scan, scan, ext.title, sender, letter, JSON.stringify({
        ...ext,
        refs: [{ kind: "case_no", value: "trait" }],
        case_handler: null,
    }));
    db.addRefs(con, 1, [["case_no", "trait"]]);
    store.put(con, store.docKey(1), Buffer.from("original PDF bytes"), "application/pdf");
    (0, metadata_history_1.recordMetadata)(con, 1, "Original interpretation");
    flow.refreshDocumentMetadata(con, 1);
    const doc = con.prepare("SELECT * FROM documents WHERE id=1").get();
    strict_1.default.deepEqual(JSON.parse(doc.ai_json).case_handler, ext.case_handler);
    strict_1.default.equal(doc.scanned_at, scan);
    strict_1.default.equal(doc.doc_date, "2026-08-27");
    strict_1.default.equal(doc.sender_id, sender);
    strict_1.default.equal(con.prepare("SELECT count(*) n FROM senders").get().n, 1);
    strict_1.default.equal(store.get(con, store.docKey(1)).data.toString(), "original PDF bytes");
    strict_1.default.equal(db.search(con, "432156703020")[0]?.id, 1);
    strict_1.default.equal(con
        .prepare("SELECT count(*) n FROM doc_refs WHERE value='trait'")
        .get().n, 0);
    const history = con
        .prepare("SELECT snapshot FROM document_metadata_versions WHERE document_id=1 ORDER BY recorded_from")
        .all();
    strict_1.default.equal(history.length, 2);
    strict_1.default.equal(JSON.parse(history[0].snapshot).refs[0].value, "trait");
    strict_1.default.equal(JSON.parse(JSON.parse(history[1].snapshot).ai_json).case_handler.name, "Camille MARTIN");
    const group = flow.newGroup(con);
    store.put(con, "source/followup", Buffer.from("scan"), "text/plain");
    con
        .prepare("INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/followup',1,1,?,'test')")
        .run(group, letter);
    const review = flow.workbench(con)[0];
    strict_1.default.deepEqual(review.recognition.case_handler, ext.case_handler);
    strict_1.default.equal(review.metadata.refs[0]?.value, "4321.567 030.20");
    (0, strict_1.default)(review.related.some((r) => r.id === 1));
    console.log("Case references, handler contacts, matching and correction history passed.");
}
finally {
    con.close();
    fs.rmSync(dir, { recursive: true, force: true });
}
