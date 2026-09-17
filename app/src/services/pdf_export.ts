import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import type { Db } from "../infra/db";
import * as store from "../infra/storage";
import { checkAbort } from "../infra/exec";
import { documentPdfMetadata, enrichPdf } from "../infra/pdf_metadata";
import { group, groupExtraction, workbench, combined } from "./pipeline";
import type { SenderRow } from "../domain/types";

export type ExportTarget = { kind: "document" | "group"; id: number };
export const defaultExportDirectory = () =>
  path.join(os.homedir(), "Documents", "scans");
export const pythonScript = (name: string) =>
  path.resolve(__dirname, "../../python", name);

/** Snapshot first, build in scratch space, publish a complete PDF without overwriting. */
export async function exportPdf(
  con: Db,
  target: ExportTarget,
  directory: string,
  destination?: string,
): Promise<string> {
  if (
    !Number.isSafeInteger(target.id) ||
    target.id < 1 ||
    !["group", "document"].includes(target.kind)
  )
    throw new Error("Choose a document or scan to export.");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-export-"));
  try {
    let input: string, metadata: Record<string, any>;
    if (target.kind === "group") {
      const snapshot = workbench(con).find((g) => g.id === target.id);
      if (!snapshot) throw new Error("Scan not found.");
      if (snapshot.imports.length)
        throw new Error("Read the remaining scans before exporting.");
      const kept = snapshot.pages.filter((p) => !p.excluded);
      if (kept.some((p) => p.issue === "Not read yet"))
        throw new Error("Read the pages before exporting.");
      const ext = groupExtraction(
        con,
        group(con, target.id),
        con.prepare("SELECT * FROM senders ORDER BY id").all() as SenderRow[],
      );
      metadata = {
        ...ext,
        ...snapshot.metadata,
        title: snapshot.title,
        summary: ext.summary_en,
        scanned_at: snapshot.scanned_at,
        scan_date_source: "capture",
        review_status: "awaiting_review",
        review_warnings: snapshot.warnings,
        recognition_source: ext.metadata_source,
        page_texts: kept.map((p) => p.text),
        page_ids: kept.map((p) => p.id),
        group_id: target.id,
      };
      input = await combined(con, kept, work);
    } else {
      const doc = con
        .prepare("SELECT * FROM documents WHERE id=?")
        .get(target.id) as Record<string, any> | undefined;
      const pdf = store.get(con, store.docKey(target.id));
      if (!doc || !pdf) throw new Error("PDF not found.");
      metadata = documentPdfMetadata(con, target.id);
      input = path.join(work, "input.pdf");
      fs.writeFileSync(input, pdf.data);
    }
    const output = path.join(work, "export.pdf");
    await enrichPdf(input, output, metadata);
    checkAbort();
    if (destination) {
      const staged = path.join(
        path.dirname(destination),
        `.docdoc-${randomUUID()}.pdf`,
      );
      try {
        fs.copyFileSync(output, staged, fs.constants.COPYFILE_EXCL);
        fs.renameSync(staged, destination);
      } finally {
        fs.rmSync(staged, { force: true });
      }
      return destination;
    }
    fs.mkdirSync(directory, { recursive: true });
    let title = String(metadata.title || "Scan")
      .normalize("NFC")
      .replace(/[\x00-\x1f<>:"/\\|?*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    while (Buffer.byteLength(title, "utf8") > 180)
      title = [...title].slice(0, -1).join("");
    const date = String(
      metadata.doc_date || metadata.scanned_at || new Date().toISOString(),
    ).slice(0, 10);
    const stem = `${date} - ${title} - ${target.kind}-${target.id}`;
    const staged = path.join(directory, `.docdoc-${randomUUID()}.pdf`);
    try {
      fs.copyFileSync(output, staged, fs.constants.COPYFILE_EXCL);
      for (let suffix = 0; suffix < 10000; suffix++) {
        const file = path.join(
          directory,
          `${stem}${suffix ? ` (${suffix + 1})` : ""}.pdf`,
        );
        try {
          fs.linkSync(staged, file);
          return file;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
      throw new Error("Too many exports with the same name.");
    } finally {
      fs.rmSync(staged, { force: true });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
