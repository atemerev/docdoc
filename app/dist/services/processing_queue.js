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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessingQueue = void 0;
exports.collateQueueGroup = collateQueueGroup;
const exec_1 = require("../infra/exec");
const flow = __importStar(require("./pipeline"));
const document_split_1 = require("./document_split");
const pageorder_1 = require("../domain/pageorder");
/** Apply an exhaustive partition atomically; originals and page IDs are retained. */
function collateQueueGroup(con, id, proposed, warning) {
    const g = flow.group(con, id);
    if (g.manual_grouping || g.split_done)
        return [id];
    const pages = con.prepare("SELECT * FROM review_pages WHERE group_id=? AND excluded=0 ORDER BY position,id").all(id);
    const parts = proposed || (0, document_split_1.localSplit)(pages);
    const assigned = parts.flatMap(p => p.pageIds);
    if (assigned.length !== pages.length || new Set(assigned).size !== pages.length || assigned.some(id => !pages.some(p => p.id === id)))
        throw new Error("Document separation must include every page exactly once");
    const buckets = parts.map(part => ({ reason: part.reason, list: pages.filter(p => part.pageIds.includes(p.id)) }));
    const order = (list) => {
        if (g.manual_order)
            return;
        const markers = list.map((p) => (0, pageorder_1.pageMarker)(p.text));
        if (markers.every((m) => m && m[1] === markers[0][1]) &&
            new Set(markers.map((m) => m[0])).size === list.length)
            list.sort((a, b) => (0, pageorder_1.pageMarker)(a.text)[0] - (0, pageorder_1.pageMarker)(b.text)[0]);
    };
    if (g.target_id || buckets.length < 2) {
        if (buckets.length === 1) {
            const sorted = [...pages];
            order(sorted);
            if (sorted.some((p, i) => p.id !== pages[i].id)) {
                const removed = con.prepare("SELECT id FROM review_pages WHERE group_id=? AND excluded=1 ORDER BY position,id").all(id);
                flow.reorder(con, id, [...sorted, ...removed].map((p) => p.id));
            }
        }
        con.prepare("UPDATE review_groups SET split_done=1,queue_note=COALESCE(?,queue_note) WHERE id=?").run(warning || null, id);
        return [id];
    }
    return con.transaction(() => {
        const ids = [];
        for (const [index, { reason, list }] of buckets.entries()) {
            const target = index === 0 ? id : flow.newGroup(con, g.title, null, true);
            con.prepare("UPDATE review_groups SET manual_order=? WHERE id=?").run(g.manual_order, target);
            // Retain explicit user choices; model suggestions remain separate.
            con.prepare("UPDATE review_groups SET metadata_overrides=?,phase=?,queued_at=?,queue_note=?,split_done=1 WHERE id=?")
                .run(g.metadata_overrides, index === 0 ? "processing" : "queued", g.queued_at, `Automatically separated into ${buckets.length} documents. ${reason}.${warning ? " " + warning : ""}`, target);
            order(list);
            list.forEach((p, i) => con.prepare("UPDATE review_pages SET group_id=?,position=? WHERE id=?").run(target, i + 1, p.id));
            // Excluded originals stay with the first group, after the included pages.
            if (index === 0) {
                const removed = con.prepare("SELECT id FROM review_pages WHERE group_id=? AND excluded=1 ORDER BY position,id").all(id);
                removed.forEach((p, i) => con.prepare("UPDATE review_pages SET position=? WHERE id=?").run(list.length + i + 1, p.id));
            }
            flow.touch(con, target);
            ids.push(target);
        }
        return ids;
    })();
}
class ProcessingQueue {
    con;
    config;
    changed;
    read;
    current = null;
    version = 0;
    stopped = false;
    running = null;
    scope = null;
    constructor(con, config, changed, read = flow.readGroup) {
        this.con = con;
        this.config = config;
        this.changed = changed;
        this.read = read;
    }
    resume() {
        this.con.prepare("UPDATE review_groups SET phase='queued',queue_error=NULL WHERE phase='processing'").run();
        this.kick();
    }
    enqueue(id) {
        const g = flow.group(this.con, id);
        if (["queued", "processing"].includes(g.phase))
            return;
        if (this.con.prepare("SELECT 1 FROM imports WHERE group_id=? AND state!='ready'").get(id))
            throw new Error("Prepare all captured pages first.");
        if (this.con.prepare("SELECT 1 FROM review_pages WHERE group_id=? AND blank_checked=0").get(id))
            throw new Error("Finish checking blank pages first. Choose Prepare pages / retry.");
        if (!this.con.prepare("SELECT 1 FROM review_pages WHERE group_id=? AND excluded=0").get(id))
            throw new Error("Include at least one page before pressing Done.");
        this.con.prepare("UPDATE review_groups SET phase='queued',queued_at=?,queue_error=NULL WHERE id=?").run(new Date().toISOString(), id);
        this.notify();
        this.kick();
    }
    notify() { this.version++; this.changed(); }
    kick() {
        if (this.stopped || this.running)
            return;
        this.running = new Promise((resolve) => setImmediate(resolve)).then(() => this.drain()).finally(() => {
            this.running = null;
            if (!this.stopped && this.con.prepare("SELECT 1 FROM review_groups WHERE phase='queued'").get())
                this.kick();
        });
    }
    async drain() {
        while (!this.stopped) {
            const next = this.con.prepare("SELECT id FROM review_groups WHERE phase='queued' ORDER BY queued_at,id LIMIT 1").get();
            if (!next)
                return;
            const id = next.id, scope = new exec_1.ExecutionScope();
            this.scope = scope;
            const initialPages = this.con.prepare("SELECT id,excluded,ocr_source FROM review_pages WHERE group_id=? ORDER BY position,id").all(id);
            this.current = { id, label: "Preparing text recognition", progress: { stage: "prepare" }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                pages: initialPages.map(p => ({ id: p.id, state: p.excluded ? "excluded" : p.ocr_source ? "done" : "waiting" })) };
            this.con.prepare("UPDATE review_groups SET phase='processing',queue_error=NULL WHERE id=?").run(id);
            this.notify();
            const progress = (label, p) => {
                if (!this.current)
                    return;
                const completed = new Set(p?.completedPageIds || []), active = new Set(p?.activePageIds || []);
                this.current = { ...this.current, label, progress: p || null, updatedAt: new Date().toISOString(),
                    pages: this.current.pages.map(page => ({ ...page, state: completed.has(page.id) ? (p?.stage === "check" ? "done" : "read") : active.has(page.id) ? (p?.stage === "check" ? "checking" : "reading") : page.state })) };
                this.changed();
            };
            try {
                await (0, exec_1.inScope)(scope, async () => {
                    // Split children already contain OCR; resume metadata without rereading.
                    const unread = this.con.prepare("SELECT 1 FROM review_pages WHERE group_id=? AND excluded=0 AND (ocr_source IS NULL OR issue='Not read yet')").get(id);
                    if (unread)
                        await this.read(this.config(), this.con, id, progress, false, { prepared: true, metadata: false, unreadOnly: true });
                    (0, exec_1.checkAbort)();
                    progress("Separating documents automatically", { stage: "split" });
                    const g = flow.group(this.con, id);
                    if (!g.manual_grouping && !g.split_done && !g.target_id) {
                        const pages = this.con.prepare("SELECT id,text,qr_json FROM review_pages WHERE group_id=? AND excluded=0 ORDER BY position,id").all(id);
                        const plan = await (0, document_split_1.planDocuments)(this.config(), pages);
                        (0, exec_1.checkAbort)();
                        // Metadata edits are allowed while planning. Page edits cancel this scope.
                        if (flow.group(this.con, id).phase !== "processing")
                            (0, exec_1.checkAbort)();
                        const ids = collateQueueGroup(this.con, id, plan.documents, plan.warning);
                        progress(ids.length > 1 ? `Created ${ids.length} documents automatically` : "Document pages grouped", { stage: "split", completed: pages.length, total: pages.length });
                    }
                    // A split changes which pages belong to this queue item.
                    const own = new Set(this.con.prepare("SELECT id FROM review_pages WHERE group_id=?").all(id).map(p => p.id));
                    if (this.current)
                        this.current.pages = this.current.pages.filter(p => own.has(p.id));
                    this.notify();
                    await flow.recognizeGroupMetadata(this.config(), this.con, id, progress);
                    (0, exec_1.checkAbort)();
                    this.con.prepare("UPDATE review_groups SET phase='ready',queue_error=NULL WHERE id=?").run(id);
                });
            }
            catch (error) {
                // Pausing for a page edit sets phase=pages before cancellation.
                this.con.prepare("UPDATE review_groups SET phase=?,queue_error=? WHERE id=? AND phase='processing'")
                    .run(this.stopped ? "queued" : "error", this.stopped ? null : String(error), id);
            }
            finally {
                await (0, exec_1.finishAbort)(scope);
                this.current = null;
                this.scope = null;
                this.notify();
            }
        }
    }
    async editPages(id) {
        flow.group(this.con, id);
        this.con.prepare("UPDATE review_groups SET phase='pages',queue_error=NULL WHERE id=?").run(id);
        if (this.current?.id === id && this.scope) {
            (0, exec_1.requestAbort)(this.scope);
            // Wait only for this item, not unrelated queued jobs.
            while (this.current?.id === id)
                await new Promise((r) => setTimeout(r, 10));
        }
        this.notify();
    }
    async stop() {
        this.stopped = true;
        if (this.scope)
            (0, exec_1.requestAbort)(this.scope);
        await this.running;
    }
    async idle() {
        while (this.running)
            await this.running;
    }
}
exports.ProcessingQueue = ProcessingQueue;
