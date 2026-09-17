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
const child_process_1 = require("child_process");
const http_1 = require("http");
const metadata_model_1 = require("../services/metadata_model");
const extraction_1 = require("../services/extraction");
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const flow = __importStar(require("../services/pipeline"));
const exec_1 = require("../infra/exec");
const config_1 = require("../infra/config");
const fixtures_1 = require("./fixtures");
const ocr = `Example Agency SA
Settlement of maintenance costs
For correspondence please quote MAINT-54321.
Your property enquiries are looked after by Camille Martin.
camille@example.test
Issued 27 August 2026
Born 2 January 1981`;
const { sender_key, ...base } = (0, extraction_1.extractHeuristic)(ocr);
const raw = metadata_model_1.metadataSchema.parse({
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
        evidence: "Your property enquiries are looked after by Camille Martin.\ncamille@example.test",
    },
});
const senders = [{ id: 1, key: "example", name: "Example Agency SA" }];
strict_1.default.equal((0, metadata_model_1.validateMetadata)(raw, ocr, null, senders).sender_name, "Example Agency SA");
strict_1.default.throws(() => (0, metadata_model_1.validateMetadata)({ ...raw, scanned_at: "2020-01-01" }, ocr, null, senders), "the model cannot supply scan time");
strict_1.default.throws(() => (0, metadata_model_1.validateMetadata)({ ...raw, refs: [{ kind: "invented", value: "1234" }] }, ocr, null, senders));
const unsupported = (0, metadata_model_1.validateMetadata)({
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
    case_handler: { ...raw.case_handler, phone: "+41 12 555 12 12" },
}, ocr, null, senders);
strict_1.default.equal(unsupported.doc_date, null);
strict_1.default.equal(unsupported.case_opened_date, null);
strict_1.default.equal(unsupported.refs.length, 0);
strict_1.default.equal(unsupported.case_handler?.phone, null);
strict_1.default.equal((0, metadata_model_1.validateMetadata)({ ...raw, case_handler: { ...raw.case_handler, page: 2 } }, ocr, null, senders).case_handler, null);
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-model-test-"));
    const oldPath = process.env.PATH;
    const con = db.connect(path.join(dir, "docdoc.db"));
    const cfg = {
        ...config_1.DEFAULTS,
        data_root: dir,
        metadata_provider: "claude-cli",
    };
    try {
        store.init(con);
        db.upsertSender(con, "example", "Example Agency SA");
        fs.writeFileSync(path.join(dir, "response.json"), JSON.stringify({ structured_output: raw, is_error: false }));
        fs.writeFileSync(path.join(dir, "claude"), `#!/usr/bin/env node
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
`, { mode: 0o700 });
        process.env.PATH = dir + path.delimiter + oldPath;
        const gid = flow.newGroup(con, "Scan today", null, true);
        const png = path.join(dir, "page.png"), pdf = path.join(dir, "page.pdf");
        fs.writeFileSync(png, (0, fixtures_1.page)([
            [180, 180, 50, true, "Example Agency SA"],
            [180, 300, 40, false, "Settlement of maintenance costs"],
        ]));
        (0, child_process_1.execFileSync)("img2pdf", ["--output", pdf, png]);
        store.put(con, "source/model", fs.readFileSync(pdf), "application/pdf");
        const pid = Number(con
            .prepare("INSERT INTO review_pages(group_id,source_key,source_page,position,text,batch) VALUES (?,'source/model',1,1,?,'test')")
            .run(gid, ocr).lastInsertRowid);
        store.copy(con, "source/model", store.pageKey(pid));
        (0, child_process_1.execFileSync)("pdftoppm", [
            "-jpeg",
            "-scale-to",
            "480",
            "-singlefile",
            pdf,
            path.join(dir, "thumb"),
        ]);
        store.put(con, store.pageKey(pid, "thumb"), fs.readFileSync(path.join(dir, "thumb.jpg")), "image/jpeg");
        await flow.recognizeGroupMetadata(cfg, con, gid, () => { });
        let group = flow.workbench(con)[0];
        strict_1.default.equal(group.metadata.refs[0]?.value, "MAINT-54321");
        strict_1.default.equal(group.recognition.case_handler?.name, "Camille Martin");
        strict_1.default.equal(group.recognition.source, "Claude Haiku");
        flow.workbench(con);
        strict_1.default.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), "1", "viewing never calls the model");
        con
            .prepare("UPDATE review_pages SET text=? WHERE id=?")
            .run(ocr + "\nAdditional page note", pid);
        strict_1.default.match(flow.workbench(con)[0].recognition.warning, /Pages changed/);
        con.prepare("UPDATE review_pages SET text=? WHERE id=?").run(ocr, pid);
        group = flow.workbench(con)[0];
        const doc = await flow.fileGroup(cfg, con, { id: gid, revision: group.revision, title: group.title }, () => { });
        const saved = JSON.parse(con.prepare("SELECT ai_json FROM documents WHERE id=?").get(doc).ai_json);
        strict_1.default.equal(saved.metadata_source, "Claude Haiku");
        strict_1.default.equal(saved.case_handler?.name, "Camille Martin");
        strict_1.default.equal(db.search(con, "MAINT54321")[0]?.id, doc);
        strict_1.default.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), "1", "saving reuses reviewed metadata");
        fs.writeFileSync(path.join(dir, "mode"), "bad");
        const fallback = await (0, metadata_model_1.extractMetadata)(cfg, ocr, null, senders);
        strict_1.default.equal(fallback.metadata_source, "Local OCR");
        strict_1.default.match(fallback.metadata_warning, /unavailable/);
        await strict_1.default.rejects(flow.recognizeDocumentMetadata(cfg, con, doc), /previous details have been kept/);
        strict_1.default.equal(JSON.parse(con.prepare("SELECT ai_json FROM documents WHERE id=?").get(doc).ai_json).metadata_source, "Claude Haiku");
        fs.writeFileSync(path.join(dir, "mode"), "wait");
        const pending = (0, metadata_model_1.extractMetadata)(cfg, ocr, null, senders);
        const caught = strict_1.default.rejects(pending, exec_1.BatchAborted);
        setTimeout(exec_1.requestAbort, 100);
        await caught;
        await (0, exec_1.finishAbort)();
        (0, exec_1.clearAbort)();
        const claudeCalls = fs.readFileSync(path.join(dir, "calls"), "utf8");
        let mode = "ok";
        const server = (0, http_1.createServer)((req, res) => {
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
                strict_1.default.equal(payload.model, "small-local");
                strict_1.default.equal(payload.response_format.json_schema.strict, true);
                (0, strict_1.default)(payload.messages[1].content.includes("MAINT-54321"));
                if (mode === "wait")
                    return;
                if (mode === "error") {
                    res.writeHead(503);
                    res.end();
                    return;
                }
                res.end(JSON.stringify({
                    choices: [
                        {
                            finish_reason: mode === "truncated" ? "length" : "stop",
                            message: { content: JSON.stringify(raw) },
                        },
                    ],
                }));
            });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const base = `http://127.0.0.1:${server.address().port}/v1`;
            const localCfg = {
                ...cfg,
                metadata_provider: "local-server",
                metadata_base_url: base,
                metadata_model: "",
            };
            strict_1.default.deepEqual(await (0, metadata_model_1.listLocalModels)(base), ["small-local"]);
            const local = await (0, metadata_model_1.extractMetadata)(localCfg, ocr, null, senders);
            strict_1.default.equal(local.metadata_source, "Local model · small-local");
            strict_1.default.equal(local.case_handler?.name, "Camille Martin");
            for (const failure of ["error", "truncated"]) {
                mode = failure;
                const result = await (0, metadata_model_1.extractMetadata)(localCfg, ocr, null, senders);
                strict_1.default.equal(result.metadata_source, "Local OCR");
                strict_1.default.match(result.metadata_warning, /Local model unavailable/);
            }
            strict_1.default.equal(fs.readFileSync(path.join(dir, "calls"), "utf8"), claudeCalls, "local failure must not call Claude");
            mode = "wait";
            const canceled = strict_1.default.rejects((0, metadata_model_1.extractMetadata)({ ...localCfg, metadata_model: "small-local" }, ocr, null, senders), exec_1.BatchAborted);
            setTimeout(exec_1.requestAbort, 100);
            await canceled;
            (0, exec_1.clearAbort)();
        }
        finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(() => resolve()));
        }
        console.log("Structured metadata validation, evidence, caching, save, fallback and cancellation passed.");
    }
    finally {
        process.env.PATH = oldPath;
        (0, exec_1.clearAbort)();
        con.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
