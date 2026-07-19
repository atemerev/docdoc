#!/usr/bin/env node
// Blank-page detector test (JS port of test_blank.py): synthesize scan
// images with the artifacts the ADS-4300N produces on duplex backsides
// (skew wedges of dark scanner background along the edges, a fold crease,
// a light stain) and verify isBlank/inkCoverage keeps content pages and
// drops empty ones. Run: node tests/test_blank.js

const fs = require("fs");
const os = require("os");
const path = require("path");

const ocr = require(path.join(__dirname, "..", "app", "lib", "ocr.js"));

const W = 1240, H = 1754;   // A4 at 150 dpi

const failures = [];
function check(name, cond, detail = "") {
  console.log(`  [${cond ? "ok" : "FAIL"}] ${name} ${detail}`);
  if (!cond) failures.push(name);
}

const gray = (v) => `rgb(${v},${v},${v})`;

function svgPage(extra = "") {
  return Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
       <rect width="${W}" height="${H}" fill="${gray(252)}"/>${extra}</svg>`);
}

const WEDGES =
  `<polygon points="0,0 ${Math.round(W * 0.45)},0 0,${Math.round(H * 0.04)}" fill="${gray(15)}"/>
   <polygon points="${W},0 ${W - Math.round(W * 0.06)},0 ${W},${Math.round(H * 0.35)}" fill="${gray(15)}"/>
   <polygon points="${W},${H} ${W - Math.round(W * 0.30)},${H} ${W},${H - Math.round(H * 0.03)}" fill="${gray(20)}"/>`;

const CREASE_AND_STAIN =
  `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2 - 8}"
     stroke="${gray(185)}" stroke-width="4"/>
   <ellipse cx="${W * 0.3 + 30}" cy="${H * 0.85 + 22}" rx="30" ry="22"
     fill="${gray(205)}"/>`;

const PHOTO_BLOCK =
  `<rect x="${W * 0.25}" y="${H * 0.3}" width="${W * 0.5}" height="${H * 0.25}"
     fill="${gray(70)}"/>`;

async function main() {
  const { execFileSync } = require("child_process");
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "blanktest-"));
  const save = (svg, name) => {
    const p = path.join(td, name);
    fs.writeFileSync(p, execFileSync("rsvg-convert", ["--format", "png"],
                                     { input: svg, maxBuffer: 64 << 20 }));
    return p;
  };
  try {
    const clean = save(svgPage(), "clean.png");
    const wedged = save(svgPage(WEDGES + CREASE_AND_STAIN), "wedged.png");
    const photo = save(svgPage(WEDGES + PHOTO_BLOCK), "photo.png");

    const covClean = ocr.inkCoverage(clean);
    const covWedged = ocr.inkCoverage(wedged);
    const covPhoto = ocr.inkCoverage(photo);

    check("clean blank page: no ink", covClean <= 0.004,
          `(coverage ${covClean.toFixed(4)})`);
    check("skewed blank backside: wedges/crease/stain ignored",
          covWedged <= 0.004, `(coverage ${covWedged.toFixed(4)})`);
    check("photo page: interior ink detected", covPhoto > 0.004,
          `(coverage ${covPhoto.toFixed(4)})`);

    check("isBlank: empty backside with artifacts",
          (await ocr.isBlank("", wedged)) === true);
    check("isBlank: photo page with no OCR text",
          (await ocr.isBlank("", photo)) === false);
    check("isBlank: text page wins regardless of image",
          (await ocr.isBlank("Rechnung Nr. 2026-001", wedged)) === false);
    check("isBlank: missing image falls back to text",
          (await ocr.isBlank("", path.join(td, "gone.jpg"))) === true);
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
  console.log(`\n${failures.length} failure(s)`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
