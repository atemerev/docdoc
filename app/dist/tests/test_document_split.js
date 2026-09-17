"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const http_1 = require("http");
const events_1 = require("events");
const config_1 = require("../infra/config");
const document_split_1 = require("../services/document_split");
const exec_1 = require("../infra/exec");
async function main() {
    const invoice = (id, ref, n, total) => ({ id, text: `Example Corporation\nInvoice no: ${ref}\nPage ${n} of ${total}` });
    strict_1.default.deepEqual((0, document_split_1.localSplit)([invoice(1, "INV-10001", 2, 2), invoice(2, "INV-20002", 1, 1), invoice(3, "INV-10001", 1, 2)]).map(d => d.pageIds), [[1, 3], [2]]);
    strict_1.default.deepEqual((0, document_split_1.localSplit)([
        { id: 1, text: "Invoice no: INV-10001\nSubject: Rent" },
        { id: 2, text: "Invoice no: INV-20002\nSubject: Inspection" },
        { id: 3, text: "Invoice no: INV-10001\nContinued rent charges" },
        { id: 4, text: "Subject: Rent\nContinued terms" },
    ]).map(d => d.pageIds), [[1, 3, 4], [2]], "continuations use the header of their own interleaved document");
    const numbered = [{ id: 10, text: "A letter\nPage 1 of 2" }, { id: 11, text: "Continued terms\nPage 2 of 2" }, { id: 12, text: "Another document\nPage 1 of 1" }];
    strict_1.default.deepEqual((0, document_split_1.localSplit)(numbered).map(d => d.pageIds), [[10, 11], [12]]);
    const letters = [{ id: 40, text: "Example Corporation\nSubject: Rent adjustment\nCase reference: CN-123456" }, { id: 41, text: "Continued reasons and signature" }, { id: 42, text: "Example Corporation\nSubject: Inspection appointment\nCase reference: CN-123456" }];
    strict_1.default.deepEqual((0, document_split_1.localSplit)(letters).map(d => d.pageIds), [[40, 41], [42]], "shared case references do not merge different letters");
    strict_1.default.deepEqual((0, document_split_1.localSplit)([letters[0], invoice(50, "INV-10001", 1, 1)]).map(d => d.pageIds), [[40], [50]], "an earlier letter is not an invoice cover");
    strict_1.default.equal((0, document_split_1.localSplit)([numbered[0], { ...numbered[0], id: 13 }, numbered[1]]).length, 1, "duplicate pages remain reviewable within their document");
    const valid = { documents: [{ pages: [1, 2], reason: "Rent adjustment and continuation", evidence: [{ page: 1, quote: "Subject: Rent adjustment" }] }, { pages: [3], reason: "Separate appointment letter", evidence: [{ page: 3, quote: "Inspection appointment" }] }] };
    strict_1.default.deepEqual((0, document_split_1.validateSplit)(valid, letters).map(d => d.pageIds), [[40, 41], [42]]);
    for (const wrong of [
        { ...valid, documents: [valid.documents[0]] },
        { ...valid, documents: [valid.documents[0], { ...valid.documents[1], pages: [2, 3] }] },
        { ...valid, documents: [valid.documents[0], { ...valid.documents[1], pages: [4] }] },
        { ...valid, documents: [valid.documents[0], { ...valid.documents[1], evidence: [{ page: 3, quote: "Invented heading" }] }] },
    ])
        strict_1.default.throws(() => (0, document_split_1.validateSplit)(wrong, letters));
    let mode = "normal", calls = 0;
    const server = (0, http_1.createServer)(async (req, res) => {
        let data = "";
        for await (const chunk of req)
            data += chunk;
        const request = JSON.parse(data);
        calls++;
        strict_1.default.equal(request.response_format.json_schema.name, "document_separation");
        (0, strict_1.default)(request.messages[0].content.includes("untrusted"));
        if (mode === "wait")
            return;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(mode === "invalid" ? { documents: [] } : valid) } }] }));
    });
    server.listen(0, "127.0.0.1");
    await (0, events_1.once)(server, "listening");
    const cfg = { ...config_1.DEFAULTS, metadata_provider: "local-server", metadata_model: "test", metadata_base_url: `http://127.0.0.1:${server.address().port}/v1` };
    try {
        strict_1.default.deepEqual((await (0, document_split_1.planDocuments)(cfg, letters)).documents.map(d => d.pageIds), [[40, 41], [42]]);
        mode = "invalid";
        const fallback = await (0, document_split_1.planDocuments)(cfg, letters);
        (0, strict_1.default)(fallback.warning);
        strict_1.default.equal(fallback.documents.length, 2);
        mode = "wait";
        const before = calls, scope = new exec_1.ExecutionScope();
        const running = (0, exec_1.inScope)(scope, () => (0, document_split_1.planDocuments)(cfg, letters));
        const rejected = strict_1.default.rejects(running, /stopped/);
        while (calls === before)
            await new Promise(r => setTimeout(r, 10));
        (0, exec_1.requestAbort)(scope);
        await rejected;
        console.log("Automatic separation: references, page restarts, ordinary letters, model schema/evidence, exhaustive page ownership, fallback and cancellation passed.");
    }
    finally {
        server.closeAllConnections();
        server.close();
    }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
