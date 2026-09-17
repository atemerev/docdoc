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
const senders_1 = require("../domain/senders");
const extraction_1 = require("../services/extraction");
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const flow = __importStar(require("../services/pipeline"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-metadata-"));
const file = path.join(dir, "docdoc.db");
let con = db.connect(file);
try {
    store.init(con);
    const id = db.upsertSender(con, "regie", "Régie du Rhône SA");
    strict_1.default.equal(db.upsertSender(con, "regie-du-rhone", "REGIE DU RHONE"), id);
    strict_1.default.equal(db.upsertSender(con, "punctuated", "Régie du Rhône S.A."), id);
    strict_1.default.equal(db.findSender(con, "Regie du Rhone").name, "Régie du Rhône SA", "canonical spelling is preserved");
    const post = db.upsertSender(con, "postfinance", "PostFinance AG");
    const senders = con.prepare("SELECT * FROM senders").all();
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
    const ext = (0, extraction_1.extractHeuristic)("Direct print-out from e-finance\nPostFinance\nTransaction overview\n2026-09-14\nAccount movements", null, senders);
    strict_1.default.equal(ext.title, "Transaction overview");
    strict_1.default.equal(ext.doc_type, "statement");
    strict_1.default.equal(ext.sender_name, "PostFinance AG");
    const printed = (0, extraction_1.extractHeuristic)("Transaction overview | E-finance | PostFinance    https://www.postfinance.ch/page\nDirect print-out from e-finance\nLe PostFinance\nTransaction overview", null, senders);
    strict_1.default.equal(printed.sender_name, "PostFinance AG");
    strict_1.default.equal(printed.title, "Transaction overview");
    strict_1.default.equal((0, extraction_1.extractHeuristic)("Example AG\nEmployment agreement\nThe parties agree.")
        .doc_type, "contract");
    strict_1.default.equal((0, extraction_1.extractHeuristic)("").title, null);
    strict_1.default.equal((0, extraction_1.extractHeuristic)("Invoice 1234\n15.09.2026").sender_name, null, "a document heading is not a sender");
    strict_1.default.equal((0, senders_1.matchSender)([
        { id: 1, name: "Example AG", key: "example-ag" },
        { id: 2, name: "Example GmbH", key: "example-gmbh" },
    ], "Example"), undefined, "ambiguous shortened names are not merged");
    strict_1.default.equal((0, senders_1.matchSender)([{ id: 1, key: "a", name: "Alpha AG", iban: "CH1234" }], "Beta AG", { iban: "CH1234" }), undefined, "shared bank accounts do not merge unrelated senders");
    const gid = flow.newGroup(con, "Scan 9/14/2026", null, true);
    store.put(con, "source/test", Buffer.from("test"), "text/plain");
    con
        .prepare("INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/test',1,1,?,'test')")
        .run(gid, "PostFinance\nTransaction overview\n2026-09-14");
    let g = flow.workbench(con)[0];
    strict_1.default.equal(g.title, "Transaction overview");
    strict_1.default.equal(g.metadata.sender_name, "PostFinance AG");
    flow.updateMetadata(con, gid, {
        title: "My statement",
        sender_name: "Regie du Rhone",
        doc_type: "letter",
    });
    con.close();
    con = db.connect(file);
    store.init(con);
    g = flow.workbench(con)[0];
    strict_1.default.equal(g.title, "My statement");
    strict_1.default.equal(g.metadata.sender_name, "Régie du Rhône SA");
    strict_1.default.equal(g.metadata.doc_type, "letter");
    strict_1.default.equal(db.findSender(con, "POSTFINANCE").id, post);
    strict_1.default.equal(con.prepare("SELECT count(*) n FROM senders").get().n, 2, "suggestions never create senders");
    console.log("Autofill, canonical sender matching, ambiguity handling, and persistent edits passed.");
}
finally {
    con.close();
    fs.rmSync(dir, { recursive: true, force: true });
}
