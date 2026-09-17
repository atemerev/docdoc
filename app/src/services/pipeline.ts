// Durable capture, page preparation, recognition, and explicit filing.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type {
  Config,
  DocumentRow,
  Extraction,
  QrBill,
  SenderRow,
  ExtractedRef,
} from "../domain/types";
import { DOC_TYPES, REF_KINDS } from "../domain/types";
import { validDate } from "../domain/document_dates";
import { recordMetadata } from "../infra/metadata_history";
import type { ReportProgress } from "../domain/progress";
import { checkPages } from "../domain/collation";
import { pageMarker } from "../domain/pageorder";
import { normRef, textHash, slugify, jaccard, trigrams } from "../domain/textsim";
import { senderName } from "../domain/senders";
import * as db from "../infra/db";
import * as store from "../infra/storage";
import * as ocr from "../infra/ocr";
import { checkAbort, run, aborted } from "../infra/exec";
import { isBlankBeforeOcr } from "../infra/imaging";
import { extractHeuristic } from "./extraction";
import { extractMetadata, METADATA_VERSION } from "./metadata_model";
import { findQrbill } from "../infra/qrcodec";
import { findDuplicates, refDuplicate } from "./dedup";
import { recordInvoice } from "./invoices";
import { enrichStoredPdf } from "../infra/pdf_metadata";

export interface ReviewPage {
  id: number;
  group_id: number;
  position: number;
  text: string;
  marker: string | null;
  blank: number;
  excluded: number;
  issue: string | null;
  batch: string;
  source_key: string;
  source_page: number;
  qr_json: string | null;
  ocr_source?: string | null;
}
export interface Group {
  id: number;
  title: string;
  target_id: number | null;
  revision: number;
  created_at: string;
  metadata_overrides: string;
  metadata_result: string | null;
  phase: "pages" | "queued" | "processing" | "ready" | "error";
  queued_at: string | null;
  queue_error: string | null;
  queue_note: string | null;
  manual_grouping: number;
  manual_order: number;
  split_done: number;
}
export type DraftMetadata = Pick<
  Extraction,
  | "title"
  | "sender_name"
  | "doc_type"
  | "doc_date"
  | "case_opened_date"
  | "refs"
>;
export function updateMetadata(
  con: db.Db,
  id: number,
  values: Partial<DraftMetadata>,
): void {
  const g = group(con, id);
  const overrides = JSON.parse(g.metadata_overrides);
  for (const key of [
    "title",
    "sender_name",
    "doc_type",
    "doc_date",
    "case_opened_date",
  ] as const)
    if (key in values) {
      if (values[key] !== null && typeof values[key] !== "string")
        throw new Error("Document details must be text.");
      overrides[key] = values[key]?.trim() || null;
      if (
        (key === "doc_date" || key === "case_opened_date") &&
        overrides[key] &&
        !validDate(overrides[key])
      )
        throw new Error("Use a valid calendar date.");
      if (
        key === "doc_type" &&
        overrides[key] &&
        !DOC_TYPES.includes(overrides[key])
      )
        throw new Error("Unknown document type.");
    }
  if (values.refs !== undefined)
    overrides.refs = validateReferences(values.refs);
  con
    .prepare(
      "UPDATE review_groups SET metadata_overrides=?,revision=revision+1 WHERE id=?",
    )
    .run(JSON.stringify(overrides), id);
}
function validateReferences(refs: ExtractedRef[]): ExtractedRef[] {
  if (!Array.isArray(refs) || refs.length > 200)
    throw new Error("Invalid references.");
  return refs.map((ref) => {
    if (
      !REF_KINDS.includes(ref.kind) ||
      typeof ref.value !== "string" ||
      !ref.value.trim() ||
      ref.value.length > 64
    )
      throw new Error("Each reference needs a type and value.");
    return { ...ref, value: ref.value.trim() };
  });
}
function saveReferences(con: db.Db, id: number, refs: ExtractedRef[]): void {
  con.prepare("DELETE FROM doc_refs WHERE document_id=?").run(id);
  db.addRefs(
    con,
    id,
    refs.map((ref) => [ref.kind, ref.value]),
  );
  for (const ref of refs)
    con
      .prepare(
        "UPDATE doc_refs SET page=?,evidence=? WHERE document_id=? AND kind=? AND norm=?",
      )
      .run(
        ref.page || null,
        ref.evidence || null,
        id,
        ref.kind,
        normRef(ref.value),
      );
}
export interface ImportRow {
  id: number;
  source_key: string;
  name: string;
  group_id: number;
  state: string;
  issue: string | null;
}
const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-"));
const bytes = (con: db.Db, key: string): Buffer => {
  const value = store.get(con, key);
  if (!value) throw new Error(`Missing stored file: ${key}`);
  return value.data;
};
const pages = (con: db.Db, id: number): ReviewPage[] =>
  con
    .prepare("SELECT * FROM review_pages WHERE group_id=? ORDER BY position,id")
    .all(id) as ReviewPage[];
export function group(con: db.Db, id: number): Group {
  const value = con
    .prepare("SELECT * FROM review_groups WHERE id=?")
    .get(id) as Group | undefined;
  if (!value) throw new Error("This review group no longer exists.");
  return value;
}
export function newGroup(
  con: db.Db,
  title = "Untitled document",
  target: number | null = null,
  automaticTitle = false,
): number {
  return Number(
    con
      .prepare(
        "INSERT INTO review_groups(title,created_at,target_id,metadata_overrides) VALUES (?,?,?,?)",
      )
      .run(
        title,
        db.nowIso(),
        target,
        JSON.stringify(
          automaticTitle || title === "Untitled document" ? {} : { title },
        ),
      ).lastInsertRowid,
  );
}
export function removeEmptyGroup(con: db.Db, id: number): void {
  const g = group(con, id);
  con.transaction(() => {
    if (
      con.prepare("SELECT 1 FROM review_pages WHERE group_id=?").get(id) ||
      con
        .prepare("SELECT 1 FROM imports WHERE group_id=? AND state!='ready'")
        .get(id)
    )
      throw new Error("Move or prepare the pages first.");
    con.prepare("UPDATE imports SET group_id=NULL WHERE group_id=?").run(id);
    if (g.target_id)
      con
        .prepare("UPDATE documents SET status='trash' WHERE id=?")
        .run(g.target_id);
    con.prepare("DELETE FROM review_groups WHERE id=?").run(id);
  })();
}

/** Capture is visible in Library before OCR starts, including failed/stopped scans. */
export function ensureLibraryEntry(con: db.Db, id: number): number {
  const g = group(con, id);
  if (g.target_id) return g.target_id;
  return con.transaction(() => {
    const captured = con
      .prepare("SELECT MIN(captured_at) at FROM imports WHERE group_id=?")
      .get(id) as { at: string | null };
    const doc = Number(
      con
        .prepare(
          "INSERT INTO documents(created_at,status,reviewed,title,scanned_at,scan_date_source,pending,pages) VALUES (?,'filed',0,?,?,'capture','reading',0)",
        )
        .run(db.nowIso(), g.title, captured.at || g.created_at).lastInsertRowid,
    );
    con.prepare("UPDATE review_groups SET target_id=? WHERE id=?").run(doc, id);
    recordMetadata(con, doc, "Scan captured; recognition pending");
    return doc;
  })();
}

export async function saveDraft(
  cfg: Config,
  con: db.Db,
  id: number,
  status: (s: string) => void,
): Promise<number> {
  const target = ensureLibraryEntry(con, id);
  const snapshot = workbench(con).find((g) => g.id === id)!;
  if (snapshot.imports.length) return target;
  if (!snapshot.pages.some((p) => !p.excluded)) {
    con.transaction(() => {
      con
        .prepare(
          "UPDATE documents SET pages=0,content='',file_sha256=NULL,text_hash=NULL,reviewed=0,pending='All pages removed' WHERE id=?",
        )
        .run(target);
      con.prepare("DELETE FROM pages WHERE document_id=?").run(target);
      con.prepare("DELETE FROM doc_refs WHERE document_id=?").run(target);
      con
        .prepare("DELETE FROM assets WHERE key IN (?,?)")
        .run(store.docKey(target), store.docKey(target, "thumb"));
    })();
    return target;
  }
  return fileGroup(
    cfg,
    con,
    { id, revision: snapshot.revision, title: snapshot.title },
    status,
    true,
  );
}

/** Reversible removal: retained sources remain available in the single-file archive. */
export function deleteReview(con: db.Db, id: number): void {
  const g = group(con, id);
  con.transaction(() => {
    if (g.target_id)
      con
        .prepare("UPDATE documents SET status='trash' WHERE id=?")
        .run(g.target_id);
    con
      .prepare(
        "UPDATE review_pages SET group_id=NULL,document_id=COALESCE(document_id,?) WHERE group_id=?",
      )
      .run(g.target_id, id);
    con.prepare("UPDATE imports SET group_id=NULL WHERE group_id=?").run(id);
    con.prepare("DELETE FROM review_groups WHERE id=?").run(id);
  })();
}

export function touch(con: db.Db, id: number): void {
  con
    .prepare("UPDATE review_groups SET revision=revision+1 WHERE id=?")
    .run(id);
}
/** Original files are committed before OCR or PDF tools are invoked. */
export function queueFiles(
  con: db.Db,
  files: string[],
  title: string,
  issue: string | null = null,
  groupId?: number,
  capturedAt = new Date().toISOString(),
): number {
  if (!files.length) throw new Error("Choose at least one file.");
  for (const file of files)
    if (!/\.(pdf|jpe?g|png|tiff?|pnm)$/i.test(file))
      throw new Error(`Unsupported file: ${path.basename(file)}`);
  return con.transaction(() => {
    const id = groupId ?? newGroup(con, title, null, true);
    group(con, id);
    con.prepare("UPDATE review_groups SET split_done=0 WHERE id=?").run(id);
    for (const file of files) {
      const data = fs.readFileSync(file),
        key = `source/${randomUUID()}/${path.basename(file)}`;
      store.put(
        con,
        key,
        data,
        /\.pdf$/i.test(file) ? "application/pdf" : "application/octet-stream",
      );
      con
        .prepare(
          "INSERT INTO imports(source_key,name,group_id,issue,captured_at) VALUES (?,?,?,?,?)",
        )
        .run(key, path.basename(file), id, issue, capturedAt);
    }
    touch(con, id);
    return id;
  })();
}

/** A failed/interrupted import remains in SQLite and can be retried explicitly. */
export async function prepareImports(
  con: db.Db,
  id: number,
  status: ReportProgress,
): Promise<void> {
  group(con, id);
  const pending = con
    .prepare(
      "SELECT * FROM imports WHERE group_id=? AND state!='ready' ORDER BY id",
    )
    .all(id) as ImportRow[];
  for (const [index, input] of pending.entries()) {
    checkAbort();
    const work = temp();
    try {
      status(`Preparing scan ${index + 1} of ${pending.length}`, {
        stage: "prepare",
        completed: index,
        total: pending.length,
      });
      const file = path.join(work, input.name);
      fs.writeFileSync(file, bytes(con, input.source_key));
      const pdf = /\.pdf$/i.test(file)
        ? file
        : await ocr.imagesToPdf([file], path.join(work, "input.pdf"));
      const count = await ocr.pageCount(pdf);
      if (!Number.isInteger(count) || count < 1)
        throw new Error("The file has no readable pages.");
      const prepared: Array<{ pdf: Buffer; thumb: Buffer }> = [];
      for (let n = 1; n <= count; n++) {
        checkAbort();
        const one = path.join(work, `part-${n}.pdf`),
          thumb = path.join(work, `thumb-${n}.jpg`);
        await ocr.rebuildPdf(pdf, one, [n]);
        await ocr.thumbnail(one, thumb);
        prepared.push({
          pdf: fs.readFileSync(one),
          thumb: fs.readFileSync(thumb),
        });
      }
      checkAbort();
      con.transaction(() => {
        const start = (
          con
            .prepare(
              "SELECT COALESCE(MAX(position),0) n FROM review_pages WHERE group_id=?",
            )
            .get(id) as { n: number }
        ).n;
        prepared.forEach((item, index) => {
          const pid = Number(
            con
              .prepare(
                `INSERT INTO review_pages(group_id,source_key,source_page,position,issue,batch)
            VALUES (?,?,?,?,?,?)`,
              )
              .run(
                id,
                input.source_key,
                index + 1,
                start + index + 1,
                input.issue || "Not read yet",
                input.name,
              ).lastInsertRowid,
          );
          store.put(con, store.pageKey(pid), item.pdf, "application/pdf");
          store.put(con, store.pageKey(pid, "thumb"), item.thumb, "image/jpeg");
        });
        con
          .prepare("UPDATE imports SET state='ready' WHERE id=?")
          .run(input.id);
        touch(con, id);
      })();
      status(`Prepared ${index + 1} of ${pending.length} scans`, {
        stage: "prepare",
        completed: index + 1,
        total: pending.length,
      });
    } catch (e) {
      con
        .prepare("UPDATE imports SET state='error',issue=? WHERE id=?")
        .run(String(e), input.id);
      throw e;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
export async function combined(
  con: db.Db,
  list: ReviewPage[],
  work: string,
  originals = false,
): Promise<string> {
  if (!list.length) throw new Error("There are no included pages.");
  const args = ["--empty", "--pages"];
  const sources = new Map<string, string>();
  for (const p of list) {
    let file = path.join(work, `p-${p.id}.pdf`);
    if (originals) {
      const cached = sources.get(p.source_key);
      if (cached) {
        args.push(cached, String(p.source_page));
        continue;
      }
      const source = path.join(
        work,
        `original-${p.id}${path.extname(p.source_key) || ".pdf"}`,
      );
      fs.writeFileSync(source, bytes(con, p.source_key));
      file = /\.pdf$/i.test(source)
        ? source
        : await ocr.imagesToPdf([source], file);
      sources.set(p.source_key, file);
    } else fs.writeFileSync(file, bytes(con, store.pageKey(p.id)));
    args.push(file, String(originals ? p.source_page : 1));
  }
  const output = path.join(work, "combined.pdf");
  await run("qpdf", [...args, "--", output]);
  return output;
}
/** Capture preparation finishes here: durable page PDFs, thumbnails, and blanks. */
export async function prepareGroup(con: db.Db, id: number, status: ReportProgress): Promise<void> {
  await prepareImports(con, id, status);
  const allPages = pages(con, id);
  if (!allPages.length) return;
  const work = temp();
  try {
    status("Checking blank pages before text recognition", {
      stage: "blank", completed: 0, total: allPages.length,
    });
    const originals = await combined(con, allPages, work, true);
    const imageDir = path.join(work, "codes");
    fs.mkdirSync(imageDir);
    await ocr.pdfToImages(originals, imageDir, 150);
    const images = fs.readdirSync(imageDir).sort().map((name) => path.join(imageDir, name));
    const existingTexts = await ocr.pdfPageTexts(originals);
    if (images.length !== allPages.length || existingTexts.length !== allPages.length)
      throw new Error("Could not check every original page. Retry preparing the scan.");
    for (const [i, p] of allPages.entries()) {
      checkAbort();
      const blank = isBlankBeforeOcr(images[i], existingTexts[i]);
      con.prepare(
        "UPDATE review_pages SET blank=?,blank_checked=1,excluded=COALESCE(exclusion_override,?),issue=? WHERE id=?",
      ).run(Number(blank), Number(blank),
        blank && !p.issue?.startsWith("Scan interrupted") ? null : p.issue, p.id);
      status(`Checked ${i + 1} of ${allPages.length} pages for blanks`, {
        stage: "blank", completed: i + 1, total: allPages.length,
      });
    }
    touch(con, id);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
export async function readGroup(
  cfg: Config,
  con: db.Db,
  id: number,
  status: ReportProgress,
  autoSave = false,
  options: { prepared?: boolean; metadata?: boolean; unreadOnly?: boolean } = {},
): Promise<void> {
  if (autoSave) ensureLibraryEntry(con, id);
  if (!options.prepared) await prepareGroup(con, id, status);
  const allPages = pages(con, id).filter((p) => !options.unreadOnly ||
    (!p.excluded && (!p.ocr_source || p.issue === "Not read yet")));
  if (!allPages.length) return;
  const work = temp();
  try {
    status("Preparing pages for text recognition", {stage:"prepare",total:allPages.length,pageIds:allPages.map(p=>p.id)});
    const originals = await combined(con, allPages, work, true);
    const imageDir = path.join(work, "codes");
    fs.mkdirSync(imageDir);
    await ocr.pdfToImages(originals, imageDir, 150);
    const images = fs.readdirSync(imageDir).sort().map((name) => path.join(imageDir, name));
    if (images.length !== allPages.length) throw new Error("Could not render every page.");
    const pageImages = new Map(allPages.map((p, i) => [p.id, images[i]]));
    // Persist exclusions and the raw Library PDF before loading any OCR model.
    // Explicitly restored blanks stay included and are read on the next retry.
    if (autoSave) await saveDraft(cfg, con, id, status);
    const list = allPages.filter((p) => !p.excluded);
    if (!list.length) {
      status("No included pages need text recognition", {
        stage: "blank", completed: allPages.length, total: allPages.length,
      });
      return;
    }
    status(
      `Recognizing text on ${list.length} ${list.length === 1 ? "page" : "pages"}`,
      { stage: "recognize", total:list.length, pageIds:list.map(p=>p.id), completed:0 },
    );
    const input = path.join(work, "included.pdf"), output = path.join(work, "ocr.pdf");
    const included = new Set(list.map((p) => p.id));
    await ocr.rebuildPdf(originals, input,
      allPages.flatMap((p, i) => included.has(p.id) ? [i + 1] : []));
    const result = await ocr.ocrPdf(input, output, {
      languages: cfg.ocr_languages,
      engine: cfg.ocr_engine,
      python: cfg.ocr_python,
      device: cfg.ocr_device,
      dataRoot: cfg.data_root,
      onProgress: (completed, total, progress) => {
        const ids = (numbers: number[] = []) => numbers.flatMap(n=>list[n-1] ? [list[n-1].id] : []);
        status(progress?.phase === "loading" ? "Loading the text recognition model" : progress?.phase === "saving" ? "Saving recognized text" : `Read ${completed} of ${total} pages`, {
          stage:"recognize", completed, total, pageIds:list.map(p=>p.id),
          completedPageIds:ids(progress?.completedPages), activePageIds:ids(progress?.activePages),
        });
      },
    });
    if (result.pageTexts.length !== list.length)
      throw new Error(
        "OCR returned a different page count. Review the originals and retry.",
      );
    const prepared: Array<{
      p: ReviewPage;
      pdf: Buffer;
      thumb: Buffer;
      text: string;
      qr: QrBill | null;
    }> = [];
    status("Checking document codes", {
      stage: "check",
      completed: 0,
      total: list.length,
      completedPageIds:list.map(p=>p.id),
    });
    for (let i = 0; i < list.length; i++) {
      checkAbort();
      status(`Checking page ${i+1} of ${list.length}`,{stage:"check",completed:i,total:list.length,activePageIds:[list[i].id]});
      const one = path.join(work, `read-${i}.pdf`),
        thumb = path.join(work, `read-${i}.jpg`);
      await ocr.rebuildPdf(output, one, [i + 1]);
      await ocr.thumbnail(one, thumb);
      const text = result.pageTexts[i];
      prepared.push({
        p: list[i],
        pdf: fs.readFileSync(one),
        thumb: fs.readFileSync(thumb),
        text,
        qr: await findQrbill([pageImages.get(list[i].id)!]),
      });
      status(`Checked ${i + 1} of ${list.length} pages`, {
        stage: "check",
        completed: i + 1,
        total: list.length,
        completedPageIds:list.slice(0,i+1).map(p=>p.id),
      });
    }
    checkAbort();
    con.transaction(() => {
      for (const item of prepared) {
        const marker = pageMarker(item.text);
        // Scanner warnings survive successful OCR.
        const issue = item.p.issue?.startsWith("Scan interrupted")
          ? item.p.issue
          : null;
        con
          .prepare(
            "UPDATE review_pages SET text=?,marker=?,issue=?,qr_json=?,ocr_source=? WHERE id=?",
          )
          .run(
            item.text,
            marker ? marker.join("/") : null,
            issue,
            item.qr ? JSON.stringify(item.qr) : null,
            result.source,
            item.p.id,
          );
        store.put(con, store.pageKey(item.p.id), item.pdf, "application/pdf");
        store.put(
          con,
          store.pageKey(item.p.id, "thumb"),
          item.thumb,
          "image/jpeg",
        );
      }
      touch(con, id);
    })();
    if (autoSave) await saveDraft(cfg, con, id, status);
    if (options.metadata !== false) await recognizeGroupMetadata(cfg, con, id, status);
    if (autoSave) await saveDraft(cfg, con, id, status);
    checkAbort();
  } catch (e) {
    con
      .prepare(
        `UPDATE review_pages SET issue=COALESCE(issue,?) WHERE group_id=? AND excluded=0${options.unreadOnly ? " AND (ocr_source IS NULL OR issue='Not read yet')" : ""}`,
      )
      .run(
        aborted()
          ? "Reading stopped; original pages kept."
          : `Reading failed: ${String(e)}`,
        id,
      );
    touch(con, id);
    throw e;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
function metadataInput(con: db.Db, id: number) {
  const kept = pages(con, id).filter((p) => !p.excluded);
  return {
    content: kept.map((p) => p.text).join("\n\f\n"),
    ocr_source: [
      ...new Set(kept.map((p) => p.ocr_source).filter(Boolean)),
    ].join(" + "),
    qr: kept.find((p) => p.qr_json)?.qr_json
      ? (JSON.parse(kept.find((p) => p.qr_json)!.qr_json!) as QrBill)
      : null,
    hash: store.hash(
      Buffer.from(
        JSON.stringify([
          METADATA_VERSION,
          kept.map(({ id, text, qr_json }) => ({ id, text, qr_json })),
        ]),
      ),
    ),
  };
}
export function groupExtraction(
  con: db.Db,
  g: Group,
  senders: SenderRow[],
): Extraction {
  const input = metadataInput(con, g.id);
  try {
    const saved = g.metadata_result ? JSON.parse(g.metadata_result) : null;
    if (saved?.hash === input.hash) return saved.ext;
  } catch {
    /* invalid legacy cache is safe to recompute locally */
  }
  return {
    ...extractHeuristic(input.content, input.qr, senders),
    ocr_source: input.ocr_source,
    metadata_source: "Local OCR",
    metadata_warning: g.metadata_result
      ? "Pages changed. Recognize details again to update AI suggestions."
      : null,
  };
}
export async function recognizeGroupMetadata(
  cfg: Config,
  con: db.Db,
  id: number,
  status: ReportProgress,
): Promise<void> {
  status(
    cfg.metadata_provider !== "local"
      ? "AI is reading document details"
      : "Filling document details",
    { stage: "details" },
  );
  const input = metadataInput(con, id);
  const ext = await extractMetadata(
    cfg,
    input.content,
    input.qr,
    con.prepare("SELECT * FROM senders ORDER BY id").all() as SenderRow[],
  );
  ext.ocr_source = input.ocr_source;
  checkAbort();
  if (metadataInput(con, id).hash !== input.hash)
    throw new Error(
      "Pages changed during recognition. Retry with the current pages.",
    );
  con
    .prepare("UPDATE review_groups SET metadata_result=? WHERE id=?")
    .run(JSON.stringify({ hash: input.hash, ext }), id);
  touch(con, id);
}
export function workbench(con: db.Db) {
  const senders = con
    .prepare("SELECT * FROM senders ORDER BY id")
    .all() as SenderRow[];
  const groups = con
    .prepare("SELECT * FROM review_groups ORDER BY id")
    .all() as Group[];
  return groups.map((g) => {
    const list = pages(con, g.id),
      kept = list.filter((p) => !p.excluded);
    const content = kept.map((p) => p.text).join("\n\f\n"),
      ext = groupExtraction(con, g, senders);
    const effectiveRefs: ExtractedRef[] =
      JSON.parse(g.metadata_overrides).refs || ext.refs;
    const norms = [
      ...new Set(effectiveRefs.map((r) => normRef(r.value))),
    ].filter((n) => n.length >= 4);
    const related = norms.length
      ? con
          .prepare(
            `SELECT DISTINCT d.id,d.title,d.sender_name,r.value
      FROM documents d JOIN doc_refs r ON r.document_id=d.id
      WHERE d.status!='trash' AND d.id!=? AND (${effectiveRefs.map(() => "(r.kind=? AND r.norm=?)").join(" OR ")}) LIMIT 30`,
          )
          .all(
            g.target_id || 0,
            ...effectiveRefs.flatMap((ref) => [ref.kind, normRef(ref.value)]),
          )
      : [];
    const otherGroups = groups
      .filter((other) => other.id !== g.id)
      .filter((other) => {
        const otherRefs = groupExtraction(con, other, senders).refs;
        const refs: ExtractedRef[] =
          JSON.parse(other.metadata_overrides).refs || otherRefs;
        return refs.some((r) =>
          effectiveRefs.some(
            (ref) =>
              ref.kind === r.kind && normRef(ref.value) === normRef(r.value),
          ),
        );
      })
      .map((other) => ({ id: other.id, title: other.title }));
    const readingPending = ["pages", "queued", "processing"].includes(g.phase);
    const warnings = checkPages(readingPending ? list.map((p) => ({...p, issue: p.issue === "Not read yet" ? null : p.issue})) : list);
    const seen = new Set<string>();
    for (const p of kept) {
      if (!p.text.trim()) continue;
      const sha = textHash(p.text);
      if (seen.has(sha))
        warnings.push(
          "Two included pages have identical text; check for duplicates.",
        );
      seen.add(sha);
    }
    const imports = con
      .prepare(
        "SELECT id,name,issue FROM imports WHERE group_id=? AND state!='ready'",
      )
      .all(g.id);
    if (imports.length)
      warnings.push(
        "Some source files still need preparation. Retry reading before filing.",
      );
    const duplicates = content.trim()
      ? findDuplicates(con, "", textHash(content), content, 0.75, g.target_id || 0)
      : { id: null, reason: null };
    const metadata: DraftMetadata = {
      title: ext.title,
      sender_name: ext.sender_name,
      doc_type: ext.doc_type,
      doc_date: ext.doc_date,
      case_opened_date: ext.case_opened_date,
      refs: effectiveRefs,
      ...JSON.parse(g.metadata_overrides),
    };
    if (metadata.sender_name) {
      const canonical = db.findSender(con, metadata.sender_name);
      if (canonical) metadata.sender_name = canonical.name;
    }
    return {
      ...g,
      title: metadata.title || g.title,
      pages: list,
      warnings: [...new Set(warnings)],
      related,
      other_groups: otherGroups,
      queue_duplicates: content.trim() ? groups.filter((other) => {
        if (other.id === g.id || other.phase === "pages") return false;
        const otherText = pages(con, other.id).filter((p) => !p.excluded).map((p) => p.text).join("\n\f\n");
        return otherText.trim() && jaccard(trigrams(content), trigrams(otherText)) >= 0.75;
      }).map((other) => ({ id: other.id, title: other.title })) : [],
      imports,
      needs_preparation: Boolean(imports.length || con.prepare("SELECT 1 FROM review_pages WHERE group_id=? AND blank_checked=0").get(g.id)),
      duplicate: duplicates,
      metadata,
      scanned_at: g.target_id
        ? (
            con
              .prepare("SELECT scanned_at FROM documents WHERE id=?")
              .get(g.target_id) as { scanned_at: string | null }
          ).scanned_at
        : (
            con
              .prepare(
                "SELECT MIN(i.captured_at) at FROM imports i JOIN review_pages p ON p.source_key=i.source_key WHERE p.group_id=?",
              )
              .get(g.id) as { at: string | null }
          ).at || g.created_at,
      recognition: {
        date_evidence: ext.date_evidence,
        dates: ext.ref_dates,
        pursuit: ext.pursuit,
        case_handler: ext.case_handler,
        source: ext.metadata_source || "Local OCR",
        warning: ext.metadata_warning || null,
      },
    };
  });
}
export function editPage(
  con: db.Db,
  id: number,
  target: number,
  excluded?: boolean,
): void {
  const p = con
    .prepare("SELECT * FROM review_pages WHERE id=? AND group_id IS NOT NULL")
    .get(id) as ReviewPage | undefined;
  if (!p) throw new Error("This page is no longer in review.");
  group(con, target);
  con.transaction(() => {
    const end = (
      con
        .prepare(
          "SELECT COALESCE(MAX(position),0)+1 n FROM review_pages WHERE group_id=?",
        )
        .get(target) as { n: number }
    ).n;
    con
      .prepare(
        "UPDATE review_pages SET group_id=?,position=?,excluded=?,exclusion_override=COALESCE(?,exclusion_override) WHERE id=?",
      )
      .run(
        target,
        target === p.group_id ? p.position : end,
        excluded === undefined ? p.excluded : Number(excluded),
        excluded === undefined ? null : Number(excluded),
        id,
      );
    touch(con, p.group_id);
    if (target !== p.group_id) {
      // Moving between sets is an explicit document-boundary decision.
      con.prepare("UPDATE review_groups SET manual_grouping=1 WHERE id IN (?,?)").run(p.group_id, target);
      touch(con, target);
    }
  })();
}
export function reorder(con: db.Db, id: number, ids: number[]): void {
  const actual = pages(con, id).map((p) => p.id);
  if (
    ids.length !== actual.length ||
    new Set(ids).size !== ids.length ||
    ids.some((p) => !actual.includes(p))
  )
    throw new Error("Page order must contain every page exactly once.");
  con.transaction(() => {
    ids.forEach((pid, i) =>
      con
        .prepare("UPDATE review_pages SET position=? WHERE id=?")
        .run(i + 1, pid),
    );
    touch(con, id);
  })();
}
export async function reopenDocument(
  con: db.Db,
  id: number,
  status: (s: string) => void,
): Promise<number> {
  const existing = con
    .prepare("SELECT id FROM review_groups WHERE target_id=?")
    .get(id) as { id: number } | undefined;
  if (existing) return existing.id;
  const doc = con
    .prepare("SELECT * FROM documents WHERE id=? AND status!='trash'")
    .get(id) as DocumentRow | undefined;
  if (!doc) throw new Error("Document not found.");
  const work = temp();
  try {
    const file = path.join(work, `document-${id}.pdf`);
    fs.writeFileSync(file, bytes(con, store.docKey(id)));
    const gid = con.transaction(() => {
      const result = newGroup(con, doc.title || `Document ${id}`, id);
      queueFiles(con, [file], doc.title || "Document", null, result);
      return result;
    })();
    await prepareImports(con, gid, status);
    const originalTexts = con
      .prepare(
        "SELECT text FROM pages WHERE document_id=? ORDER BY page_no,scan_order",
      )
      .all(id) as { text: string }[];
    const existingExt = doc.ai_json
      ? (JSON.parse(doc.ai_json) as Extraction)
      : null;
    con.transaction(() => {
      for (const [index, p] of pages(con, gid).entries())
        con
          .prepare(
            "UPDATE review_pages SET text=?,issue=NULL,blank_checked=1,ocr_source=? WHERE id=?",
          )
          .run(
            originalTexts[index]?.text || "",
            existingExt?.ocr_source || null,
            p.id,
          );
      const refs = con
        .prepare(
          "SELECT kind,value,page,evidence FROM doc_refs WHERE document_id=? ORDER BY kind,norm",
        )
        .all(id);
      con
        .prepare(
          "UPDATE review_groups SET metadata_overrides=?,metadata_result=? WHERE id=?",
        )
        .run(
          JSON.stringify({
            title: doc.title,
            sender_name: doc.sender_name,
            doc_type: doc.doc_type,
            doc_date: doc.doc_date,
            case_opened_date: doc.case_opened_date,
            refs,
          }),
          existingExt
            ? JSON.stringify({
                hash: metadataInput(con, gid).hash,
                ext: existingExt,
              })
            : null,
          gid,
        );
    })();
    return gid;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
export interface FileReview {
  id: number;
  revision: number;
  title: string;
  sender_name?: string | null;
  doc_type?: string;
  doc_date?: string | null;
  case_opened_date?: string | null;
  refs?: ExtractedRef[];
  note?: string;
  related_ids?: number[];
}
export async function fileGroup(
  cfg: Config,
  con: db.Db,
  input: FileReview,
  status: (s: string) => void,
  draft = false,
): Promise<number> {
  const g = group(con, input.id);
  if (g.revision !== input.revision)
    throw new Error("The pages changed. Review them again before saving.");
  if (!input.title?.trim()) throw new Error("Give this document a title.");
  const snapshot = workbench(con).find((item) => item.id === g.id)!;
  if (snapshot.imports.length)
    throw new Error("Prepare all source files before saving.");
  const list = pages(con, g.id).filter((p) => !p.excluded);
  if (!list.length) throw new Error("Include at least one page.");
  const links = [...new Set(input.related_ids || [])];
  for (const id of links)
    if (
      !Number.isInteger(id) ||
      id === g.target_id ||
      !con
        .prepare("SELECT 1 FROM documents WHERE id=? AND status!='trash'")
        .get(id)
    )
      throw new Error("Invalid related document.");
  const work = temp();
  try {
    status("Saving document");
    const pdf = await combined(con, list, work),
      data = fs.readFileSync(pdf);
    let qr: QrBill | null = list.find((p) => p.qr_json)?.qr_json
      ? JSON.parse(list.find((p) => p.qr_json)!.qr_json!)
      : null;
    if (!draft && !qr) {
      const imageDir = path.join(work, "images");
      fs.mkdirSync(imageDir);
      await ocr.pdfToImages(pdf, imageDir, 150);
      checkAbort();
      qr = await findQrbill(
        fs
          .readdirSync(imageDir)
          .sort()
          .map((f) => path.join(imageDir, f)),
      );
    }
    const content = list.map((p) => p.text).join("\n\f\n");
    const ext: Extraction = groupExtraction(
      con,
      g,
      con.prepare("SELECT * FROM senders ORDER BY id").all() as SenderRow[],
    );
    Object.assign(ext, {
      title: input.title.trim(),
      sender_name:
        input.sender_name !== undefined
          ? input.sender_name?.trim() || null
          : snapshot.metadata.sender_name,
      doc_type: input.doc_type || snapshot.metadata.doc_type || ext.doc_type,
      doc_date:
        input.doc_date !== undefined
          ? input.doc_date
          : snapshot.metadata.doc_date,
      case_opened_date:
        input.case_opened_date !== undefined
          ? input.case_opened_date
          : snapshot.metadata.case_opened_date,
      refs: validateReferences(input.refs || snapshot.metadata.refs),
    });
    const sha = store.hash(data),
      thash = textHash(content);
    let dup = findDuplicates(
      con,
      sha,
      content.trim() ? thash : "",
      content,
      0.75,
      g.target_id || undefined,
    );
    if (!dup.id && !dup.reason)
      dup = refDuplicate(con, ext, content, 0.5, g.target_id || undefined);
    checkAbort();
    if (group(con, g.id).revision !== input.revision)
      throw new Error("Pages changed while saving. Review again.");
    // Keep transactions synchronous: queue jobs share this connection.
    let savedId: number;
    con.exec("BEGIN IMMEDIATE");
    try {
      const creditor = qr?.creditor?.name;
      const canonicalCreditor = creditor
        ? db.findSender(con, creditor)?.name || creditor
        : null;
      const sameCreditor =
        canonicalCreditor &&
        ext.sender_name &&
        senderName(canonicalCreditor) === senderName(ext.sender_name);
      // QR identity belongs to the creditor, not an unrelated sender selected
      // manually by the user.
      const identity =
        sameCreditor && qr
          ? { uid: qr.swico?.uid, iban: qr.iban, address: qr.creditor }
          : {};
      const provisional =
        draft &&
        cfg.metadata_provider !== "local" &&
        ext.metadata_source === "Local OCR" &&
        !Object.prototype.hasOwnProperty.call(
          JSON.parse(g.metadata_overrides),
          "sender_name",
        );
      const sid = ext.sender_name
        ? provisional
          ? db.findSender(con, ext.sender_name)?.id || null
          : db.upsertSender(
              con,
              slugify(ext.sender_name),
              ext.sender_name,
              identity,
            )
        : null;
      if (sid)
        ext.sender_name = (
          con.prepare("SELECT name FROM senders WHERE id=?").get(sid) as {
            name: string;
          }
        ).name;
      ext.sender_key = slugify(ext.sender_name);
      if (
        qr?.reference &&
        !ext.refs.some(
          (ref) =>
            ref.kind === "qr_reference" &&
            normRef(ref.value) === normRef(qr.reference),
        )
      )
        ext.refs.push({ kind: "qr_reference", value: qr.reference });
      const id =
        g.target_id ||
        Number(
          con
            .prepare(
              `INSERT INTO documents(created_at,status,reviewed,scanned_at,scan_date_source) VALUES (?,'filed',1,?,'capture')`,
            )
            .run(db.nowIso(), snapshot.scanned_at).lastInsertRowid,
        );
      const previous = con
        .prepare("SELECT reviewed FROM documents WHERE id=?")
        .get(id) as { reviewed: number };
      if (
        g.target_id &&
        store.has(con, store.docKey(id)) &&
        (!draft || previous.reviewed)
      )
        store.copy(con, store.docKey(id), `revision/${id}/${randomUUID()}/pdf`);
      store.put(con, store.docKey(id), data, "application/pdf");
      store.copy(
        con,
        store.pageKey(list[0].id, "thumb"),
        store.docKey(id, "thumb"),
      );
      con
        .prepare(
          `UPDATE documents SET title=?,sender_name=?,sender_id=?,doc_type=?,doc_date=?,pages=?,content=?,
        file_sha256=?,text_hash=?,status='filed',reviewed=?,pending=?,flags=?,duplicate_of=?,dup_reason=? WHERE id=?`,
        )
        .run(
          ext.title,
          ext.sender_name,
          sid,
          ext.doc_type,
          ext.doc_date,
          list.length,
          content,
          sha,
          thash,
          draft ? 0 : 1,
          draft && list.some((p) => p.issue === "Not read yet")
            ? "reading"
            : null,
          JSON.stringify(snapshot.warnings),
          dup.id,
          dup.reason,
          id,
        );
      if (!con.prepare("SELECT 1 FROM invoices WHERE document_id=?").get(id))
        con
          .prepare(
            "UPDATE documents SET amount=?,currency=?,due_date=?,invoice_ref=?,ai_json=?,summary=? WHERE id=?",
          )
          .run(
            ext.amount,
            ext.currency,
            ext.due_date,
            ext.invoice_ref,
            JSON.stringify(ext),
            ext.summary_en,
            id,
          );
      con
        .prepare("UPDATE documents SET case_opened_date=?,ai_json=? WHERE id=?")
        .run(ext.case_opened_date, JSON.stringify(ext), id);
      con
        .prepare(
          "UPDATE documents SET recipient=?,language=?,summary=?,tags=?,tags_text=? WHERE id=?",
        )
        .run(
          ext.recipient_name,
          ext.language,
          ext.summary_en,
          JSON.stringify(ext.tags),
          ext.tags.join(" "),
          id,
        );
      con.prepare("DELETE FROM pages WHERE document_id=?").run(id);
      list.forEach((p, i) =>
        con
          .prepare(
            "INSERT INTO pages(document_id,page_no,scan_order,text,is_blank,marker) VALUES (?,?,?,?,?,?)",
          )
          .run(id, i + 1, p.source_page, p.text, p.blank, p.marker),
      );
      saveReferences(con, id, ext.refs);
      for (const related of links)
        con
          .prepare("INSERT OR IGNORE INTO document_links(a,b) VALUES (?,?)")
          .run(Math.min(id, related), Math.max(id, related));
      con
        .prepare(
          "INSERT INTO review_log(document_id,at,note,checks) VALUES (?,?,?,?)",
        )
        .run(
          id,
          db.nowIso(),
          input.note || "",
          JSON.stringify({
            action: "saved",
            warnings: snapshot.warnings,
            pages: list.map((p) => p.id),
          }),
        );
      if (
        !draft &&
        !con.prepare("SELECT 1 FROM invoices WHERE document_id=?").get(id) &&
        !dup.id &&
        ext.doc_type !== "pursuit" &&
        (["invoice", "reminder"].includes(ext.doc_type) || qr)
      )
        recordInvoice(con, cfg, id, sid, ext, qr);
      checkAbort();
      // Retain the review until the enriched PDF is safely stored. A failed or
      // interrupted export retries against this same Library ID.
      con.prepare("UPDATE review_pages SET document_id=? WHERE group_id=?").run(id, g.id);
      con.prepare("UPDATE review_groups SET target_id=?,title=? WHERE id=?")
        .run(id, ext.title || input.title, g.id);
      db.event(
        con,
        "document",
        `${draft ? "Automatically saved" : "Reviewed"}: ${input.title}`,
        { documentId: id },
      );
      recordMetadata(
        con,
        id,
        draft ? "Scan automatically saved" : "Review completed",
      );
      con.exec("COMMIT");
      savedId = id;
    } catch (e) {
      con.exec("ROLLBACK");
      throw e;
    }
    try {
      await enrichStoredPdf(con, savedId);
      checkAbort();
      if (group(con, g.id).revision !== input.revision)
        throw new Error("Details changed while saving. The saved copy is in Library; review the latest changes and save again.");
      if (!draft) con.transaction(() => {
        con.prepare("UPDATE review_pages SET group_id=NULL WHERE group_id=?").run(g.id);
        con.prepare("UPDATE imports SET group_id=NULL WHERE group_id=?").run(g.id);
        con.prepare("DELETE FROM review_groups WHERE id=?").run(g.id);
      })();
      return savedId;
    } catch (error) {
      con.prepare("UPDATE review_groups SET queue_error=? WHERE id=?").run(
        `The Library copy was saved, but finishing its PDF failed. Review is kept; retry saving. ${String(error)}`, g.id);
      throw error;
    }

  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Reinterpret existing OCR without changing a PDF, capture time, or payments. */
export function refreshDocumentMetadata(
  con: db.Db,
  id: number,
  recognized?: Extraction,
): void {
  const doc = con.prepare("SELECT * FROM documents WHERE id=?").get(id) as
    | DocumentRow
    | undefined;
  if (!doc) throw new Error("Document not found.");
  const qrPage = con
    .prepare(
      "SELECT qr_json FROM review_pages WHERE document_id=? AND excluded=0 AND qr_json IS NOT NULL LIMIT 1",
    )
    .get(id) as { qr_json: string } | undefined;
  const ext =
    recognized ||
    extractHeuristic(
      doc.content || "",
      qrPage ? JSON.parse(qrPage.qr_json) : null,
      con.prepare("SELECT * FROM senders ORDER BY id").all() as SenderRow[],
    );
  ext.ocr_source ||= doc.ai_json
    ? JSON.parse(doc.ai_json).ocr_source
    : undefined;
  con.transaction(() => {
    recordMetadata(con, id, "Before recognition correction");
    const sid = ext.sender_name
      ? db.upsertSender(con, slugify(ext.sender_name), ext.sender_name)
      : null;
    if (sid)
      ext.sender_name = (
        con.prepare("SELECT name FROM senders WHERE id=?").get(sid) as {
          name: string;
        }
      ).name;
    con
      .prepare(
        "UPDATE documents SET title=?,doc_type=?,sender_id=?,sender_name=?,doc_date=?,case_opened_date=?,recipient=?,ai_json=? WHERE id=?",
      )
      .run(
        ext.title || doc.title,
        ext.doc_type,
        sid,
        ext.sender_name,
        ext.doc_date,
        ext.case_opened_date,
        ext.recipient_name || doc.recipient,
        JSON.stringify(ext),
        id,
      );
    if (ext.pursuit)
      con
        .prepare("UPDATE documents SET amount=?,currency=? WHERE id=?")
        .run(ext.pursuit.outstanding_amount, ext.pursuit.currency, id);
    else if (!con.prepare("SELECT 1 FROM invoices WHERE document_id=?").get(id))
      con
        .prepare(
          "UPDATE documents SET amount=?,currency=?,due_date=? WHERE id=?",
        )
        .run(ext.amount, ext.currency, ext.due_date, id);
    con
      .prepare("UPDATE documents SET summary=?,tags=?,language=? WHERE id=?")
      .run(ext.summary_en, JSON.stringify(ext.tags), ext.language, id);
    saveReferences(con, id, ext.refs);
    recordMetadata(con, id, "Recognized metadata corrected");
  })();
}

export async function recognizeDocumentMetadata(
  cfg: Config,
  con: db.Db,
  id: number,
): Promise<void> {
  const doc = con
    .prepare("SELECT content,ai_json FROM documents WHERE id=?")
    .get(id) as { content: string; ai_json: string | null } | undefined;
  if (!doc) throw new Error("Document not found.");
  const qr = con
    .prepare(
      "SELECT qr_json FROM review_pages WHERE document_id=? AND excluded=0 AND qr_json IS NOT NULL LIMIT 1",
    )
    .get(id) as { qr_json: string } | undefined;
  const ext = await extractMetadata(
    cfg,
    doc.content || "",
    qr ? JSON.parse(qr.qr_json) : null,
    con.prepare("SELECT * FROM senders ORDER BY id").all() as SenderRow[],
  );
  checkAbort();
  if (
    ext.metadata_warning &&
    doc.ai_json &&
    JSON.parse(doc.ai_json).metadata_source &&
    JSON.parse(doc.ai_json).metadata_source !== "Local OCR"
  )
    throw new Error(
      "AI recognition was unavailable. The previous details have been kept; try again later.",
    );
  refreshDocumentMetadata(con, id, ext);
}
