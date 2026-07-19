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
