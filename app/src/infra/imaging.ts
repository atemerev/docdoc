// Image analysis in pure JS (jpeg-js / pngjs) -- native image libraries
// (sharp) segfault under Electron on Linux, and this code must run in
// the app process.

import * as fs from "fs";

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export function decodeGray(imagePath: string): GrayImage {
  const buf = fs.readFileSync(imagePath);
  let px: Uint8Array, w: number, h: number;
  if (buf[0] === 0x89 && buf[1] === 0x50) {           // PNG
    const { PNG } = require("pngjs") as typeof import("pngjs");
    const png = PNG.sync.read(buf);
    px = png.data; w = png.width; h = png.height;     // RGBA
  } else {                                            // JPEG
    const jpeg = require("jpeg-js") as typeof import("jpeg-js");
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    px = img.data; w = img.width; h = img.height;     // RGBA
  }
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4)
    gray[i] = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
  return { data: gray, width: w, height: h };
}

/**
 * Fraction of dark pixels in the page interior; distinguishes truly
 * blank duplex backsides from photo/handwriting pages that OCR to
 * nothing. The outer `trim` fraction of every edge is ignored: a skewed
 * ADF feed shows the scanner background as dark wedges along the borders
 * (routine on the ADS-4300N), and edge shadows/punch holes must not
 * count as ink either. Thumbnail to <=300px, crop the border, 3x3 median
 * to kill scanner noise, then histogram.
 */
export function inkCoverage(
  imagePath: string,
  { darkThreshold = 128, trim = 0.08 } = {},
): number {
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

export function isBlank(
  pageText: string | null | undefined,
  imagePath: string | null,
  { minChars = 12, maxInk = 0.004 } = {},
): boolean {
  if ((pageText ?? "").trim().length >= minChars) return false;
  try {
    if (!imagePath) throw new Error("no image");
    return inkCoverage(imagePath) <= maxInk;
  } catch {
    return !(pageText ?? "").trim();
  }
}

/** Conservative pre-OCR check: keep sparse writing, including headers/footers.
 * Unlike the post-OCR coverage heuristic, this must not depend on recognized
 * text or blur small letters away. Only edge-connected scanner shadows, tiny
 * specks, and broad light stains/creases are ignored. Unreadable images stay.
 */
export function isBlankBeforeOcr(imagePath: string, existingText = ""): boolean {
  if (existingText.trim()) return false;
  try {
    const { data, width, height } = decodeGray(imagePath);
    const scale = Math.max(1, Math.ceil(Math.max(width, height) / 1200));
    const w = Math.floor(width / scale), h = Math.floor(height / scale);
    if (w < 20 || h < 20) return false;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            sum += data[(y * scale + dy) * width + x * scale + dx];
        gray[y * w + x] = sum / (scale * scale);
      }
    const seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
    const smallMarks: { x: number; y: number; height: number }[] = [];
    // Remove edge-connected scanner background within the margins first. A
    // light fold can touch a dark border; its interior must be judged separately.
    let edgeHead = 0, edgeTail = 0;
    const seed = (x: number, y: number) => {
      const at = y * w + x;
      if (!seen[at] && gray[at] < 225) { seen[at] = 1; queue[edgeTail++] = at; }
    };
    for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
    for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
    while (edgeHead < edgeTail) {
      const at = queue[edgeHead++], x = at % w, y = Math.floor(at / w);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++)
        for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++)
          if (!(nx > w * 0.08 && nx < w * 0.92 && ny > h * 0.08 && ny < h * 0.92)) seed(nx, ny);
    }
    // Real folded sheets produce broken light components along a broad crease.
    // A nearly continuous shaded row distinguishes these from faint lettering.
    const foldRows: number[] = [];
    for (let y = Math.round(h * 0.1); y < h * 0.9; y += 4) {
      let shaded = 0;
      for (let x = Math.round(w * 0.08); x < w * 0.92; x++) {
        let count = 0;
        for (let dy = -8; dy <= 8; dy++) if (gray[(y + dy) * w + x] < 242) count++;
        if (count >= 3) shaded++;
      }
      if (shaded > w * 0.70) foldRows.push(y);
    }
    for (let start = 0; start < gray.length; start++) {
      if (seen[start] || gray[start] >= 225) continue;
      let head = 0, tail = 1, darkest = 255, interior = 0;
      let left = w, right = 0, top = h, bottom = 0;
      queue[0] = start;
      seen[start] = 1;
      while (head < tail) {
        const at = queue[head++], x = at % w, y = Math.floor(at / w);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        darkest = Math.min(darkest, gray[at]);
        if (x > w * 0.08 && x < w * 0.92 && y > h * 0.08 && y < h * 0.92) interior++;
        for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++)
          for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
            const next = ny * w + nx;
            if (!seen[next] && gray[next] < 225) {
              seen[next] = 1;
              queue[tail++] = next;
            }
          }
      }
      const cw = right - left + 1, ch = bottom - top + 1;
      // Ignore a shadow only when it touches an edge and stays in its margin.
      // Detached marks there can be a page number or a short handwritten note.
      const edgeShadow = !interior && (left === 0 || right === w - 1 || top === 0 || bottom === h - 1);
      // Small, solid printer registration blocks at the side of a blank back.
      // Do not discard detached letters/page numbers in the top/bottom margin.
      const registration = (right < w * 0.05 || left > w * 0.95) &&
        cw >= 3 && ch >= 3 && cw < w * 0.03 && ch < h * 0.03 && tail / (cw * ch) > 0.82;
      if (edgeShadow || registration || tail < 6 || Math.max(cw, ch) < 3) continue;
      if (darkest >= 175) {
        if (ch < h * 0.03 && foldRows.some((y) => top >= y - h * 0.02 && bottom <= y + h * 0.02)) continue;
        const crease = (cw > w * 0.75 && ch < h * 0.02) ||
          (ch > h * 0.75 && cw < w * 0.02);
        const stain = cw > 10 && ch > 10 && tail < w * h * 0.005 &&
          tail / (cw * ch) > 0.65;
        if (crease || stain) continue;
      }
      if (tail < 12 || (darkest > 150 && tail < 30)) {
        smallMarks.push({ x: (left + right) / 2, y: (top + bottom) / 2, height: ch });
        continue;
      }
      return false;
    }
    // Dust is isolated. Even low-contrast lettering forms a nearby row of marks.
    if (smallMarks.some((a) => smallMarks.filter((b) =>
      Math.abs(a.y - b.y) <= Math.max(a.height, b.height) && Math.abs(a.x - b.x) < w * 0.1).length >= 3)) return false;
    return true;
  } catch {
    return false;
  }
}
