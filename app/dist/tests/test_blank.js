"use strict";
// Blank-page detector test: synthesize scan images with the artifacts
// the ADS-4300N produces on duplex backsides (skew wedges of dark
// scanner background along the edges, a fold crease, a light stain) and
// verify isBlank/inkCoverage keeps content pages and drops empty ones.
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
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const imaging_1 = require("../infra/imaging");
const fixtures_1 = require("./fixtures");
const W = 1240, H = 1754; // A4 at 150 dpi
const gray = (v) => `rgb(${v},${v},${v})`;
function svgPage(extra = "") {
    return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
       <rect width="${W}" height="${H}" fill="${gray(252)}"/>${extra}</svg>`);
}
const WEDGES = `<polygon points="0,0 ${Math.round(W * 0.45)},0 0,${Math.round(H * 0.04)}" fill="${gray(15)}"/>
   <polygon points="${W},0 ${W - Math.round(W * 0.06)},0 ${W},${Math.round(H * 0.35)}" fill="${gray(15)}"/>
   <polygon points="${W},${H} ${W - Math.round(W * 0.30)},${H} ${W},${H - Math.round(H * 0.03)}" fill="${gray(20)}"/>`;
const CREASE_AND_STAIN = `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2 - 8}"
     stroke="${gray(185)}" stroke-width="4"/>
   <ellipse cx="${W * 0.3 + 30}" cy="${H * 0.85 + 22}" rx="30" ry="22"
     fill="${gray(205)}"/>`;
const PHOTO_BLOCK = `<rect x="${W * 0.25}" y="${H * 0.3}" width="${W * 0.5}" height="${H * 0.25}"
     fill="${gray(70)}"/>`;
function main() {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), "blanktest-"));
    const save = (svg, name) => {
        const p = path.join(td, name);
        fs.writeFileSync(p, (0, child_process_1.execFileSync)("rsvg-convert", ["--format", "png"], { input: svg, maxBuffer: 64 << 20 }));
        return p;
    };
    try {
        const clean = save(svgPage(), "clean.png");
        const wedged = save(svgPage(WEDGES + CREASE_AND_STAIN), "wedged.png");
        const photo = save(svgPage(WEDGES + PHOTO_BLOCK), "photo.png");
        const covClean = (0, imaging_1.inkCoverage)(clean);
        const covWedged = (0, imaging_1.inkCoverage)(wedged);
        const covPhoto = (0, imaging_1.inkCoverage)(photo);
        (0, fixtures_1.check)("clean blank page: no ink", covClean <= 0.004, `(coverage ${covClean.toFixed(4)})`);
        (0, fixtures_1.check)("skewed blank backside: wedges/crease/stain ignored", covWedged <= 0.004, `(coverage ${covWedged.toFixed(4)})`);
        (0, fixtures_1.check)("photo page: interior ink detected", covPhoto > 0.004, `(coverage ${covPhoto.toFixed(4)})`);
        (0, fixtures_1.check)("isBlank: empty backside with artifacts", (0, imaging_1.isBlank)("", wedged) === true);
        (0, fixtures_1.check)("isBlank: photo page with no OCR text", (0, imaging_1.isBlank)("", photo) === false);
        (0, fixtures_1.check)("isBlank: text page wins regardless of image", (0, imaging_1.isBlank)("Rechnung Nr. 2026-001", wedged) === false);
        (0, fixtures_1.check)("isBlank: missing image falls back to text", (0, imaging_1.isBlank)("", path.join(td, "gone.png")) === true);
    }
    finally {
        fs.rmSync(td, { recursive: true, force: true });
    }
    (0, fixtures_1.finish)();
}
main();
