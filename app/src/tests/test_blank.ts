// Blank-page detector test: synthesize scan images with the artifacts
// the ADS-4300N produces on duplex backsides (skew wedges of dark
// scanner background along the edges, a fold crease, a light stain) and
// verify isBlank/inkCoverage keeps content pages and drops empty ones.

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { inkCoverage, isBlank, isBlankBeforeOcr } from "../infra/imaging";
import { check, finish } from "./fixtures";

const W = 1240, H = 1754;   // A4 at 150 dpi

const gray = (v: number): string => `rgb(${v},${v},${v})`;

function svgPage(extra = ""): Buffer {
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

function main(): void {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), "blanktest-"));
  const save = (svg: Buffer, name: string): string => {
    const p = path.join(td, name);
    fs.writeFileSync(p, execFileSync("rsvg-convert", ["--format", "png"],
                                     { input: svg, maxBuffer: 64 << 20 }));
    return p;
  };
  try {
    const clean = save(svgPage(), "clean.png");
    const wedged = save(svgPage(WEDGES + CREASE_AND_STAIN), "wedged.png");
    const photo = save(svgPage(WEDGES + PHOTO_BLOCK), "photo.png");

    const covClean = inkCoverage(clean);
    const covWedged = inkCoverage(wedged);
    const covPhoto = inkCoverage(photo);

    check("clean blank page: no ink", covClean <= 0.004,
          `(coverage ${covClean.toFixed(4)})`);
    check("skewed blank backside: wedges/crease/stain ignored",
          covWedged <= 0.004, `(coverage ${covWedged.toFixed(4)})`);
    check("photo page: interior ink detected", covPhoto > 0.004,
          `(coverage ${covPhoto.toFixed(4)})`);

    check("isBlank: empty backside with artifacts",
          isBlank("", wedged) === true);
    check("isBlank: photo page with no OCR text",
          isBlank("", photo) === false);
    check("isBlank: text page wins regardless of image",
          isBlank("Rechnung Nr. 2026-001", wedged) === false);
    check("isBlank: missing image falls back to text",
          isBlank("", path.join(td, "gone.png")) === true);

    check("before OCR: clean and skewed backsides are blank",
          isBlankBeforeOcr(clean) && isBlankBeforeOcr(wedged));
    check("before OCR: photos remain", !isBlankBeforeOcr(photo));
    const connectedBorder = save(svgPage(
      `<path d="M10 0 V${H-10} H${W} M0 10 H${W}" fill="none" stroke="#555" stroke-width="22"/>` +
      `<rect x="${W*.025}" y="${H*.45}" width="18" height="15" fill="#222"/>` + CREASE_AND_STAIN), "border.png");
    check("before OCR: connected L-shaped borders and registration blocks are blank", isBlankBeforeOcr(connectedBorder));
    const borderWriting = save(svgPage(
      `<path d="M10 0 V${H-10} H${W}" fill="none" stroke="#555" stroke-width="22"/>` +
      '<text x="90" y="400" font-size="26" fill="#ccc">A faint note survives the scanner border</text>'), "border-note.png");
    check("before OCR: faint notes survive scanner borders", !isBlankBeforeOcr(borderWriting));
    const sparse = save(svgPage('<text x="90" y="100" font-size="24">Only a few words</text>'), "sparse.png");
    const footer = save(svgPage(`<text x="600" y="${H - 30}" font-size="20">3</text>`), "footer.png");
    const faint = save(svgPage('<text x="90" y="400" font-size="26" fill="#ccc">Faint handwriting</text>'), "faint.png");
    const signature = save(svgPage('<path d="M300 700 Q330 600 345 690 T395 695 L440 670" fill="none" stroke="#333" stroke-width="2"/>'), "signature.png");
    check("before OCR: sparse text remains", !isBlankBeforeOcr(sparse));
    check("before OCR: margin page number remains", !isBlankBeforeOcr(footer));
    check("before OCR: faint text remains", !isBlankBeforeOcr(faint));
    check("before OCR: handwriting remains", !isBlankBeforeOcr(signature));
    check("before OCR: any existing PDF text protects the page", !isBlankBeforeOcr(clean, "A"));
    check("before OCR: missing image is kept", !isBlankBeforeOcr(path.join(td, "gone.png")));
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
  finish();
}

main();
