// OCR stage: scanner images -> searchable PDF + per-page text.
//
// img2pdf embeds the JPEGs losslessly; ocrmypdf (tesseract) adds the text
// layer, auto-rotates (needs tesseract-osd) and deskews; the --sidecar text
// comes back with form-feed page separators, giving per-page text aligned
// with input page order. All heavy lifting is native CLI tools -- this
// module only orchestrates (see RESEARCH.md: the JS OCR ecosystem is WASM
// tesseract, a regression; the archival layer stays native).

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// tessdata_best models (Fedora langpacks are tessdata_fast, the least
// accurate ones) -- downloaded to /pool/docdoc/tessdata per RESEARCH.md
const TESSDATA_DIR = "/pool/docdoc/tessdata";

class OcrError extends Error {}

const pipeline = () => require("./pipeline");   // late import (abort registry)

function run(cmd, args, opts = {}) {
  const env = ["ocrmypdf", "tesseract"].includes(cmd)
      && fs.existsSync(TESSDATA_DIR)
    ? { ...process.env, TESSDATA_PREFIX: TESSDATA_DIR }
    : undefined;
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args,
      { env, maxBuffer: 64 << 20, ...opts },
      (err, stdout, stderr) => {
        pipeline().untrackChild(child);
        if (err)
          reject(new OcrError(
            `${cmd} failed (${err.code ?? err.signal}): `
            + String(stderr || err.message).trim().slice(-800)));
        else resolve({ stdout, stderr });
      });
    pipeline().trackChild(child);
  });
}

async function imagesToPdf(imagePaths, outPdf) {
  await run("img2pdf", ["--output", outPdf, ...imagePaths]);
  return outPdf;
}

async function ocrPdf(inPdf, outPdf, { languages = "deu+fra+ita+eng", jobs = 8 } = {}) {
  // Returns { pdf, pageTexts }. Page order == input order.
  const sidecar = outPdf + ".txt";
  await run("ocrmypdf", ["-l", languages, "--rotate-pages", "--deskew",
    "--sidecar", sidecar, "--output-type", "pdfa",
    "--optimize", "1", "--jobs", String(jobs), "--quiet",
    inPdf, outPdf]);
  let pages = fs.readFileSync(sidecar, "utf-8").split("\f");
  fs.unlinkSync(sidecar);
  // sidecar ends with a trailing \f -> drop the final empty chunk
  if (pages.length && pages[pages.length - 1].trim() === "")
    pages = pages.slice(0, -1);
  return { pdf: outPdf, pageTexts: pages.map((p) => p.trim()) };
}

function decodeGray(imagePath) {
  // -> { data: Uint8Array (grayscale), width, height } via pure-JS
  // decoders (jpeg-js / pngjs) -- native image libs (sharp) segfault
  // under Electron on Linux, and this path must run in the app process.
  const buf = fs.readFileSync(imagePath);
  let px, w, h;
  if (buf[0] === 0x89 && buf[1] === 0x50) {           // PNG
    const { PNG } = require("pngjs");
    const png = PNG.sync.read(buf);
    px = png.data; w = png.width; h = png.height;     // RGBA
  } else {                                            // JPEG
    const jpeg = require("jpeg-js");
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    px = img.data; w = img.width; h = img.height;     // RGBA
  }
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4)
    gray[i] = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
  return { data: gray, width: w, height: h };
}

function inkCoverage(imagePath, { darkThreshold = 128, trim = 0.08 } = {}) {
  // Fraction of dark pixels in the page interior; distinguishes truly
  // blank duplex backsides from photo/handwriting pages that OCR to
  // nothing. The outer `trim` fraction of every edge is ignored: a skewed
  // ADF feed shows the scanner background as dark wedges along the
  // borders (routine on the ADS-4300N), and edge shadows/punch holes must
  // not count as ink either. Mirrors the PIL implementation: thumbnail to
  // <=300px, crop the border, 3x3 median to kill scanner noise, histogram.
  const { data, width, height } = decodeGray(imagePath);
  // box-downscale to fit 300x300
  const scale = Math.max(1, Math.ceil(Math.max(width, height) / 300));
  const w = Math.floor(width / scale), h = Math.floor(height / scale);
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++)
          sum += data[(y * scale + sy) * width + (x * scale + sx)];
      small[y * w + x] = sum / (scale * scale);
    }
  const dx = Math.round(w * trim), dy = Math.round(h * trim);
  const cw = w - 2 * dx, ch = h - 2 * dy;
  if (cw <= 2 || ch <= 2) return 0.0;
  // 3x3 median inside the crop, then count dark pixels
  let dark = 0, total = 0;
  const win = new Uint8Array(9);
  for (let y = dy + 1; y < dy + ch - 1; y++)
    for (let x = dx + 1; x < dx + cw - 1; x++) {
      let k = 0;
      for (let sy = -1; sy <= 1; sy++)
        for (let sx = -1; sx <= 1; sx++)
          win[k++] = small[(y + sy) * w + (x + sx)];
      win.sort();
      if (win[4] < darkThreshold) dark++;
      total++;
    }
  return total ? dark / total : 0.0;
}

function isBlank(pageText, imagePath, { minChars = 12, maxInk = 0.004 } = {}) {
  if ((pageText || "").trim().length >= minChars) return false;
  try {
    return inkCoverage(imagePath) <= maxInk;
  } catch {
    return !(pageText || "").trim();
  }
}

async function rebuildPdf(inPdf, outPdf, keepOrder) {
  // Reorder/drop pages: keepOrder is a 1-based page list, e.g. [3,1,2].
  await run("qpdf", [inPdf, "--pages", ".", keepOrder.join(","), "--", outPdf]);
  return outPdf;
}

async function thumbnail(pdfPath, outJpg, width = 480) {
  const base = outJpg.endsWith(".jpg") ? outJpg.slice(0, -4) : outJpg;
  fs.mkdirSync(path.dirname(base), { recursive: true });
  await run("pdftoppm", ["-jpeg", "-f", "1", "-l", "1",
    "-scale-to-x", String(width), "-scale-to-y", "-1",
    "-singlefile", pdfPath, base]);
  return base + ".jpg";
}

async function pdfToImages(pdfPath, outDir, dpi = 300) {
  // Render every page as page-N.jpg (scanner-pushed PDFs arrive without
  // page images; downstream QR/AI/blank detection needs them).
  await run("pdftoppm", ["-jpeg", "-r", String(dpi),
    pdfPath, path.join(outDir, "page")]);
  return outDir;
}

async function pageCount(pdfPath) {
  const { stdout } = await run("qpdf", ["--show-npages", pdfPath]);
  return parseInt(stdout.trim(), 10);
}

module.exports = { OcrError, TESSDATA_DIR, imagesToPdf, ocrPdf, inkCoverage,
                   isBlank, rebuildPdf, thumbnail, pdfToImages, pageCount };
