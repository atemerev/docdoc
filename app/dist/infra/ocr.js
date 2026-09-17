"use strict";
// Foreground OCR workers; no persistent OCR service. Images remain in SQLite.
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
exports.TESSDATA_DIR = exports.OcrError = void 0;
exports.imagesToPdf = imagesToPdf;
exports.ocrPdf = ocrPdf;
exports.pdfPageTexts = pdfPageTexts;
exports.rebuildPdf = rebuildPdf;
exports.thumbnail = thumbnail;
exports.pdfToImages = pdfToImages;
exports.pageCount = pageCount;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const exec_1 = require("./exec");
Object.defineProperty(exports, "OcrError", { enumerable: true, get: function () { return exec_1.CliError; } });
// tessdata_best models (Fedora langpacks are tessdata_fast, the least
// accurate ones) -- downloaded to /pool/docdoc/tessdata per RESEARCH.md
exports.TESSDATA_DIR = "/pool/docdoc/tessdata";
const tessEnv = () => fs.existsSync(exports.TESSDATA_DIR)
    ? { ...process.env, TESSDATA_PREFIX: exports.TESSDATA_DIR }
    : undefined;
async function imagesToPdf(imagePaths, outPdf) {
    await (0, exec_1.run)("img2pdf", ["--output", outPdf, ...imagePaths]);
    return outPdf;
}
async function ocrPdf(inPdf, outPdf, { languages = "deu+fra+ita+eng", jobs = Math.min(8, os.availableParallelism()), engine = "tesseract", python = "/pool/docdoc/ocr-venv/bin/python", device = "cpu", dataRoot = "/pool/docdoc", onProgress, } = {}) {
    if (engine === "paddleocr-vl") {
        if (!fs.existsSync(python))
            throw new Error("PaddleOCR runtime is not installed. Set up the local OCR runtime from README, or select Tesseract in Settings.");
        let pending = "";
        await (0, exec_1.run)(python, [
            path.resolve(__dirname, "../../python/ocr_pdf.py"),
            inPdf,
            outPdf,
            "--data-root",
            dataRoot,
            "--device",
            device,
        ], {
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
                                completedPages: Array.isArray(p.completed_pages) ? p.completed_pages.filter((n) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= p.total) : [],
                                activePages: Array.isArray(p.active_pages) ? p.active_pages.filter((n) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= p.total) : [],
                                phase: p.phase,
                            });
                    }
                    catch {
                        /* runtime logs */
                    }
                }
            },
        });
        const result = JSON.parse(fs.readFileSync(outPdf + ".json", "utf8"));
        if (!Array.isArray(result.pageTexts) ||
            result.pageTexts.some((p) => typeof p !== "string"))
            throw new Error("OCR returned invalid text.");
        fs.unlinkSync(outPdf + ".json");
        return {
            pdf: outPdf,
            pageTexts: result.pageTexts,
            source: "PaddleOCR-VL 1.6",
        };
    }
    const sidecar = outPdf + ".txt";
    await (0, exec_1.run)("ocrmypdf", [
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
    ], { env: tessEnv() });
    // pdftotext also includes text from pages OCRmyPDF skipped.
    const pages = await pdfPageTexts(outPdf);
    fs.unlinkSync(sidecar);
    onProgress?.(pages.length, pages.length, { completedPages: pages.map((_, i) => i + 1), activePages: [], phase: "saving" });
    return {
        pdf: outPdf,
        pageTexts: pages.map((p) => p.trim()),
        source: "Tesseract",
    };
}
/** Read an existing PDF text layer without starting an OCR engine. */
async function pdfPageTexts(pdf) {
    const textFile = pdf + ".pages.txt";
    await (0, exec_1.run)("pdftotext", ["-layout", pdf, textFile]);
    const pages = fs.readFileSync(textFile, "utf8").split("\f");
    fs.unlinkSync(textFile);
    if (pages.length && !pages[pages.length - 1].trim())
        pages.pop();
    return pages.map((p) => p.trim());
}
/** Reorder/drop pages: keepOrder is a 1-based page list, e.g. [3,1,2]. */
async function rebuildPdf(inPdf, outPdf, keepOrder) {
    await (0, exec_1.run)("qpdf", [inPdf, "--pages", ".", keepOrder.join(","), "--", outPdf]);
    return outPdf;
}
async function thumbnail(pdfPath, outJpg, width = 480) {
    const base = outJpg.endsWith(".jpg") ? outJpg.slice(0, -4) : outJpg;
    fs.mkdirSync(path.dirname(base), { recursive: true });
    await (0, exec_1.run)("pdftoppm", [
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
async function pdfToImages(pdfPath, outDir, dpi = 300) {
    await (0, exec_1.run)("pdftoppm", [
        "-jpeg",
        "-r",
        String(dpi),
        pdfPath,
        path.join(outDir, "page"),
    ]);
    return outDir;
}
async function pageCount(pdfPath) {
    const { stdout } = await (0, exec_1.run)("qpdf", ["--show-npages", pdfPath]);
    return parseInt(stdout.trim(), 10);
}
