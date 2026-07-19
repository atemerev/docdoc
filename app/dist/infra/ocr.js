"use strict";
// OCR stage adapters: scanner images -> searchable PDF + per-page text.
//
// img2pdf embeds the JPEGs losslessly; ocrmypdf (tesseract) adds the
// text layer, auto-rotates (needs tesseract-osd) and deskews; the
// --sidecar text comes back with form-feed page separators, giving
// per-page text aligned with input page order. All heavy lifting is
// native CLI tools -- this module only orchestrates (see RESEARCH.md:
// the JS OCR ecosystem is WASM tesseract, a regression; the archival
// layer stays native).
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
exports.rebuildPdf = rebuildPdf;
exports.thumbnail = thumbnail;
exports.pdfToImages = pdfToImages;
exports.pageCount = pageCount;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
async function ocrPdf(inPdf, outPdf, { languages = "deu+fra+ita+eng", jobs = 8 } = {}) {
    const sidecar = outPdf + ".txt";
    await (0, exec_1.run)("ocrmypdf", ["-l", languages, "--rotate-pages", "--deskew",
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
async function rebuildPdf(inPdf, outPdf, keepOrder) {
    await (0, exec_1.run)("qpdf", [inPdf, "--pages", ".", keepOrder.join(","), "--", outPdf]);
    return outPdf;
}
async function thumbnail(pdfPath, outJpg, width = 480) {
    const base = outJpg.endsWith(".jpg") ? outJpg.slice(0, -4) : outJpg;
    fs.mkdirSync(path.dirname(base), { recursive: true });
    await (0, exec_1.run)("pdftoppm", ["-jpeg", "-f", "1", "-l", "1",
        "-scale-to-x", String(width), "-scale-to-y", "-1",
        "-singlefile", pdfPath, base]);
    return base + ".jpg";
}
/**
 * Render every page as page-N.jpg (scanner-pushed PDFs arrive without
 * page images; downstream QR/AI/blank detection needs them).
 */
async function pdfToImages(pdfPath, outDir, dpi = 300) {
    await (0, exec_1.run)("pdftoppm", ["-jpeg", "-r", String(dpi),
        pdfPath, path.join(outDir, "page")]);
    return outDir;
}
async function pageCount(pdfPath) {
    const { stdout } = await (0, exec_1.run)("qpdf", ["--show-npages", pdfPath]);
    return parseInt(stdout.trim(), 10);
}
