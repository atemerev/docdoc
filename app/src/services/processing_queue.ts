import type { Config } from "../domain/types";
import type { QueueProgress, PageWorkState, ReportProgress } from "../domain/progress";
import type { Db } from "../infra/db";
import { ExecutionScope, inScope, requestAbort, finishAbort, checkAbort } from "../infra/exec";
import * as flow from "./pipeline";
import { localSplit, planDocuments, type DocumentPart } from "./document_split";
import { pageMarker } from "../domain/pageorder";

/** Apply an exhaustive partition atomically; originals and page IDs are retained. */
export function collateQueueGroup(con: Db, id: number, proposed?: DocumentPart[], warning?: string): number[] {
  const g = flow.group(con, id);
  if (g.manual_grouping || g.split_done) return [id];
  const pages = con.prepare("SELECT * FROM review_pages WHERE group_id=? AND excluded=0 ORDER BY position,id").all(id) as flow.ReviewPage[];
  const parts = proposed || localSplit(pages);
  const assigned = parts.flatMap(p => p.pageIds);
  if (assigned.length !== pages.length || new Set(assigned).size !== pages.length || assigned.some(id => !pages.some(p => p.id === id)))
    throw new Error("Document separation must include every page exactly once");
  const buckets = parts.map(part => ({reason:part.reason, list:pages.filter(p => part.pageIds.includes(p.id))}));
  const order = (list: flow.ReviewPage[]) => {
    if (g.manual_order) return;
    const markers = list.map((p) => pageMarker(p.text));
    if (markers.every((m) => m && m[1] === markers[0]![1]) &&
        new Set(markers.map((m) => m![0])).size === list.length)
      list.sort((a, b) => pageMarker(a.text)![0] - pageMarker(b.text)![0]);
  };
  if (g.target_id || buckets.length < 2) {
    if (buckets.length === 1) {
      const sorted = [...pages];
      order(sorted);
      if (sorted.some((p, i) => p.id !== pages[i].id)) {
        const removed = con.prepare("SELECT id FROM review_pages WHERE group_id=? AND excluded=1 ORDER BY position,id").all(id) as {id:number}[];
        flow.reorder(con, id, [...sorted, ...removed].map((p) => p.id));
      }
    }
    con.prepare("UPDATE review_groups SET split_done=1,queue_note=COALESCE(?,queue_note) WHERE id=?").run(warning || null,id);
    return [id];
  }
  return con.transaction(() => {
    const ids: number[] = [];
    for (const [index, {reason, list}] of buckets.entries()) {
      const target = index === 0 ? id : flow.newGroup(con, g.title, null, true);
      con.prepare("UPDATE review_groups SET manual_order=? WHERE id=?").run(g.manual_order, target);
      // Retain explicit user choices; model suggestions remain separate.
      con.prepare("UPDATE review_groups SET metadata_overrides=?,phase=?,queued_at=?,queue_note=?,split_done=1 WHERE id=?")
        .run(g.metadata_overrides, index === 0 ? "processing" : "queued", g.queued_at,
          `Automatically separated into ${buckets.length} documents. ${reason}.${warning ? " " + warning : ""}`, target);
      order(list);
      list.forEach((p, i) => con.prepare("UPDATE review_pages SET group_id=?,position=? WHERE id=?").run(target, i + 1, p.id));
      // Excluded originals stay with the first group, after the included pages.
      if (index === 0) {
        const removed = con.prepare("SELECT id FROM review_pages WHERE group_id=? AND excluded=1 ORDER BY position,id").all(id) as {id:number}[];
        removed.forEach((p, i) => con.prepare("UPDATE review_pages SET position=? WHERE id=?").run(list.length + i + 1, p.id));
      }
      flow.touch(con, target);
      ids.push(target);
    }
    return ids;
  })();
}

export class ProcessingQueue {
  current: QueueProgress | null = null;
  version = 0;
  private stopped = false;
  private running: Promise<void> | null = null;
  private scope: ExecutionScope | null = null;
  constructor(private con: Db, private config: () => Config, private changed: () => void,
    private read: typeof flow.readGroup = flow.readGroup) {}

  resume(): void {
    this.con.prepare("UPDATE review_groups SET phase='queued',queue_error=NULL WHERE phase='processing'").run();
    this.kick();
  }
  enqueue(id: number): void {
    const g = flow.group(this.con, id);
    if (["queued", "processing"].includes(g.phase)) return;
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
  private notify(): void { this.version++; this.changed(); }
  kick(): void {
    if (this.stopped || this.running) return;
    this.running = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.drain()).finally(() => {
      this.running = null;
      if (!this.stopped && this.con.prepare("SELECT 1 FROM review_groups WHERE phase='queued'").get()) this.kick();
    });
  }
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const next = this.con.prepare("SELECT id FROM review_groups WHERE phase='queued' ORDER BY queued_at,id LIMIT 1").get() as {id:number} | undefined;
      if (!next) return;
      const id = next.id, scope = new ExecutionScope();
      this.scope = scope;
      const initialPages = this.con.prepare("SELECT id,excluded,ocr_source FROM review_pages WHERE group_id=? ORDER BY position,id").all(id) as flow.ReviewPage[];
      this.current = {id, label:"Preparing text recognition", progress:{stage:"prepare"}, startedAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
        pages:initialPages.map(p=>({id:p.id,state:p.excluded ? "excluded" : p.ocr_source ? "done" : "waiting"}))};
      this.con.prepare("UPDATE review_groups SET phase='processing',queue_error=NULL WHERE id=?").run(id);
      this.notify();
      const progress: ReportProgress = (label, p) => {
        if (!this.current) return;
        const completed = new Set(p?.completedPageIds || []), active = new Set(p?.activePageIds || []);
        this.current = {...this.current, label, progress:p || null, updatedAt:new Date().toISOString(),
          pages:this.current.pages.map(page=>({ ...page, state: completed.has(page.id) ? (p?.stage === "check" ? "done" : "read") : active.has(page.id) ? (p?.stage === "check" ? "checking" : "reading") : page.state } as {id:number;state:PageWorkState}))};
        this.changed();
      };
      try {
        await inScope(scope, async () => {
          // Split children already contain OCR; resume metadata without rereading.
          const unread = this.con.prepare("SELECT 1 FROM review_pages WHERE group_id=? AND excluded=0 AND (ocr_source IS NULL OR issue='Not read yet')").get(id);
          if (unread) await this.read(this.config(), this.con, id, progress, false, { prepared: true, metadata: false, unreadOnly: true });
          checkAbort();
          progress("Separating documents automatically", {stage: "split"});
          const g = flow.group(this.con,id);
          if (!g.manual_grouping && !g.split_done && !g.target_id) {
            const pages = this.con.prepare("SELECT id,text,qr_json FROM review_pages WHERE group_id=? AND excluded=0 ORDER BY position,id").all(id) as flow.ReviewPage[];
            const plan = await planDocuments(this.config(),pages);
            checkAbort();
            // Metadata edits are allowed while planning. Page edits cancel this scope.
            if (flow.group(this.con,id).phase !== "processing") checkAbort();
            const ids = collateQueueGroup(this.con,id,plan.documents,plan.warning);
            progress(ids.length > 1 ? `Created ${ids.length} documents automatically` : "Document pages grouped", {stage:"split",completed:pages.length,total:pages.length});
          }
          // A split changes which pages belong to this queue item.
          const own = new Set((this.con.prepare("SELECT id FROM review_pages WHERE group_id=?").all(id) as {id:number}[]).map(p=>p.id));
          if (this.current) this.current.pages = this.current.pages.filter(p=>own.has(p.id));
          this.notify();
          await flow.recognizeGroupMetadata(this.config(), this.con, id, progress);
          checkAbort();
          this.con.prepare("UPDATE review_groups SET phase='ready',queue_error=NULL WHERE id=?").run(id);
        });
      } catch (error) {
        // Pausing for a page edit sets phase=pages before cancellation.
        this.con.prepare("UPDATE review_groups SET phase=?,queue_error=? WHERE id=? AND phase='processing'")
          .run(this.stopped ? "queued" : "error", this.stopped ? null : String(error), id);
      } finally {
        await finishAbort(scope);
        this.current = null;
        this.scope = null;
        this.notify();
      }
    }
  }
  async editPages(id: number): Promise<void> {
    flow.group(this.con, id);
    this.con.prepare("UPDATE review_groups SET phase='pages',queue_error=NULL WHERE id=?").run(id);
    if (this.current?.id === id && this.scope) {
      requestAbort(this.scope);
      // Wait only for this item, not unrelated queued jobs.
      while (this.current?.id === id) await new Promise<void>((r) => setTimeout(r, 10));
    }
    this.notify();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scope) requestAbort(this.scope);
    await this.running;
  }
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}
