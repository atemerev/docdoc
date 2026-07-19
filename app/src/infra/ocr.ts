// OCR stage adapters: scanner images -> searchable PDF + per-page text.
//
// img2pdf embeds the JPEGs losslessly; ocrmypdf (tesseract) adds the
// text layer, auto-rotates (needs tesseract-osd) and deskews; the
// --sidecar text comes back with form-feed page separators, giving
// per-page text aligned with input page order. All heavy lifting is
// native CLI tools -- this module only orchestrates (see RESEARCH.md:
// the JS OCR ecosystem is WASM tesseract, a regression; the archival
// layer stays native).

import * as fs from "fs";
import * as path from "path";
import { CliError, run } from "./exec";

export { CliError as OcrError };

// tessdata_best models (Fedora langpacks are tessdata_fast, the least
// accurate ones) -- downloaded to /pool/docdoc/tessdata per RESEARCH.md
export const TESSDATA_DIR = "/pool/docdoc/tessdata";

const tessEnv = (): NodeJS.ProcessEnv | undefined =>
  fs.existsSync(TESSDATA_DIR)
    ? { ...process.env, TESSDATA_PREFIX: TESSDATA_DIR }
    : undefined;

export async function imagesToPdf(
  imagePaths: string[], outPdf: string,
): Promise<string> {
  await run("img2pdf", ["--output", outPdf, ...imagePaths]);
  return outPdf;
}

export interface OcrOutput {
  pdf: string;
  pageTexts: string[];               // page order == input order
}

export async function ocrPdf(
  inPdf: string, outPdf: string,
  { languages = "deu+fra+ita+eng", jobs = 8 } = {},
): Promise<OcrOutput> {
  const sidecar = outPdf + ".txt";
  await run("ocrmypdf", ["-l", languages, "--rotate-pages", "--deskew",
    "--sidecar", sidecar, "--output-type", "pdfa",
    "--optimize", "1", "--jobs", String(jobs), "--quiet",
    inPdf, outPdf], { env: tessEnv() });
  let pages = fs.readFileSync(sidecar, "utf-8").split("\f");
  fs.unlinkSync(sidecar);
  // sidecar ends with a trailing \f -> drop the final empty chunk
  if (pages.length && pages[pages.length - 1].trim() === "")
    pages = pages.slice(0, -1);
  return { pdf: outPdf, pageTexts: pages.map((p) => p.trim()) };
}

/** Reorder/drop pages: keepOrder is a 1-based page list, e.g. [3,1,2]. */
export async function rebuildPdf(
  inPdf: string, outPdf: string, keepOrder: number[],
): Promise<string> {
  await run("qpdf", [inPdf, "--pages", ".", keepOrder.join(","), "--", outPdf]);
  return outPdf;
}

export async function thumbnail(
  pdfPath: string, outJpg: string, width = 480,
): Promise<string> {
  const base = outJpg.endsWith(".jpg") ? outJpg.slice(0, -4) : outJpg;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  await run("pdftoppm", ["-jpeg", "-f", "1", "-l", "1",
    "-scale-to-x", String(width), "-scale-to-y", "-1",
    "-singlefile", pdfPath, base]);
  return base + ".jpg";
}

/**
 * Render every page as page-N.jpg (scanner-pushed PDFs arrive without
 * page images; downstream QR/AI/blank detection needs them).
 */
export async function pdfToImages(
  pdfPath: string, outDir: string, dpi = 300,
): Promise<string> {
  await run("pdftoppm", ["-jpeg", "-r", String(dpi),
    pdfPath, path.join(outDir, "page")]);
  return outDir;
}

export async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await run("qpdf", ["--show-npages", pdfPath]);
  return parseInt(stdout.trim(), 10);
}
