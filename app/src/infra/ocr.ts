// Foreground OCR workers; no persistent OCR service. Images remain in SQLite.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
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
  imagePaths: string[],
  outPdf: string,
): Promise<string> {
  await run("img2pdf", ["--output", outPdf, ...imagePaths]);
  return outPdf;
}

export interface OcrPageProgress {
  completedPages: number[];
  activePages: number[];
  phase?: "loading" | "reading" | "saving";
}
export interface OcrOutput {
  pdf: string;
  source: string;
  pageTexts: string[]; // page order == input order
}

export async function ocrPdf(
  inPdf: string,
  outPdf: string,
  {
    languages = "deu+fra+ita+eng",
    jobs = Math.min(8, os.availableParallelism()),
    engine = "tesseract",
    python = "/pool/docdoc/ocr-venv/bin/python",
    device = "cpu",
    dataRoot = "/pool/docdoc",
    onProgress,
  }: {
    languages?: string;
    jobs?: number;
    engine?: "tesseract" | "paddleocr-vl";
    python?: string;
    device?: string;
    dataRoot?: string;
    onProgress?: (completed: number, total: number, pages?: OcrPageProgress) => void;
  } = {},
): Promise<OcrOutput> {
  if (engine === "paddleocr-vl") {
    if (!fs.existsSync(python))
      throw new Error(
        "PaddleOCR runtime is not installed. Set up the local OCR runtime from README, or select Tesseract in Settings.",
      );
    let pending = "";
    await run(
      python,
      [
        path.resolve(__dirname, "../../python/ocr_pdf.py"),
        inPdf,
        outPdf,
        "--data-root",
        dataRoot,
        "--device",
        device,
      ],
      {
        timeout: 30 * 60 * 1000,
        onStdout(chunk) {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() || "";
          for (const line of lines) {
            try {
              const p = JSON.parse(line);
              if (Number.isInteger(p.completed) && Number.isInteger(p.total))
                onProgress?.(p.completed, p.total, {
                  completedPages:Array.isArray(p.completed_pages) ? p.completed_pages.filter((n:unknown)=>Number.isInteger(n) && Number(n)>0 && Number(n)<=p.total) : [],
                  activePages:Array.isArray(p.active_pages) ? p.active_pages.filter((n:unknown)=>Number.isInteger(n) && Number(n)>0 && Number(n)<=p.total) : [],
                  phase:p.phase,
                });
            } catch {
              /* runtime logs */
            }
          }
        },
      },
    );
    const result = JSON.parse(fs.readFileSync(outPdf + ".json", "utf8"));
    if (
      !Array.isArray(result.pageTexts) ||
      result.pageTexts.some((p: unknown) => typeof p !== "string")
    )
      throw new Error("OCR returned invalid text.");
    fs.unlinkSync(outPdf + ".json");
    return {
      pdf: outPdf,
      pageTexts: result.pageTexts,
      source: "PaddleOCR-VL 1.6",
    };
  }
  const sidecar = outPdf + ".txt";
  await run(
    "ocrmypdf",
    [
      "-l",
      languages,
      "--skip-text",
      "--rotate-pages",
      "--deskew",
      "--sidecar",
      sidecar,
      "--output-type",
      "pdfa",
      "--optimize",
      "1",
      "--jobs",
      String(jobs),
      "--quiet",
      inPdf,
      outPdf,
    ],
    { env: tessEnv() },
  );
  // pdftotext also includes text from pages OCRmyPDF skipped.
  const pages = await pdfPageTexts(outPdf);
  fs.unlinkSync(sidecar);
  onProgress?.(pages.length,pages.length,{completedPages:pages.map((_,i)=>i+1),activePages:[],phase:"saving"});
  return {
    pdf: outPdf,
    pageTexts: pages.map((p) => p.trim()),
    source: "Tesseract",
  };
}

/** Read an existing PDF text layer without starting an OCR engine. */
export async function pdfPageTexts(pdf: string): Promise<string[]> {
  const textFile = pdf + ".pages.txt";
  await run("pdftotext", ["-layout", pdf, textFile]);
  const pages = fs.readFileSync(textFile, "utf8").split("\f");
  fs.unlinkSync(textFile);
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  return pages.map((p) => p.trim());
}

/** Reorder/drop pages: keepOrder is a 1-based page list, e.g. [3,1,2]. */
export async function rebuildPdf(
  inPdf: string,
  outPdf: string,
  keepOrder: number[],
): Promise<string> {
  await run("qpdf", [inPdf, "--pages", ".", keepOrder.join(","), "--", outPdf]);
  return outPdf;
}

export async function thumbnail(
  pdfPath: string,
  outJpg: string,
  width = 480,
): Promise<string> {
  const base = outJpg.endsWith(".jpg") ? outJpg.slice(0, -4) : outJpg;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  await run("pdftoppm", [
    "-jpeg",
    "-f",
    "1",
    "-l",
    "1",
    "-scale-to-x",
    String(width),
    "-scale-to-y",
    "-1",
    "-singlefile",
    pdfPath,
    base,
  ]);
  return base + ".jpg";
}

/**
 * Render every page as page-N.jpg (scanner-pushed PDFs arrive without
 * page images; downstream QR/AI/blank detection needs them).
 */
export async function pdfToImages(
  pdfPath: string,
  outDir: string,
  dpi = 300,
): Promise<string> {
  await run("pdftoppm", [
    "-jpeg",
    "-r",
    String(dpi),
    pdfPath,
    path.join(outDir, "page"),
  ]);
  return outDir;
}

export async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await run("qpdf", ["--show-npages", pdfPath]);
  return parseInt(stdout.trim(), 10);
}
