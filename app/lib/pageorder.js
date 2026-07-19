// Page-order verification from OCR'd page markers.
//
// Looks for 'Seite 2 von 5' / 'page 2 sur 5' / 'pagina 2 di 5' /
// 'page 2 of 5' / '2/5' style markers. Reordering only happens when the
// evidence is unambiguous: every page carries exactly one consistent marker,
// the totals agree, and the marker numbers are a permutation of 1..N.
// Anything murkier just raises a flag for the review queue.

const MARKER_RES = [
  /\bSeite\s+(\d{1,3})\s*(?:von|\/)\s*(\d{1,3})\b/gi,
  /\bpage\s+(\d{1,3})\s*(?:of|sur|de|\/)\s*(\d{1,3})\b/gi,
  /\bpagina\s+(\d{1,3})\s*(?:di|\/)\s*(\d{1,3})\b/gi,
  /(?<![\d./,])(\d{1,3})\s*\/\s*(\d{1,3})(?![\d./,%])/g,
];

function pageMarker(text) {
  // Best [x, y] marker in a page's text, or null.
  const candidates = [];
  for (const rx of MARKER_RES) {
    rx.lastIndex = 0;
    for (const m of String(text || "").matchAll(rx)) {
      const x = parseInt(m[1], 10), y = parseInt(m[2], 10);
      if (x >= 1 && x <= y && y <= 200) candidates.push([x, y]);
    }
    if (candidates.length) break;      // worded markers beat bare x/y
  }
  if (!candidates.length) return null;
  // prefer the most common total among candidates
  const totals = new Map();
  for (const [x, y] of candidates) {
    if (!totals.has(y)) totals.set(y, []);
    totals.get(y).push(x);
  }
  let bestY = null, bestLen = -1;
  for (const [y, xs] of totals)
    if (xs.length > bestLen) { bestY = y; bestLen = xs.length; }
  const xs = new Set(totals.get(bestY));
  if (xs.size !== 1) return null;      // contradictory markers on one page
  return [[...xs][0], bestY];
}

function checkOrder(pageTexts) {
  // -> { order, flags }: order is a 1-based list mapping final position
  // to scanned page (null = leave as scanned).
  const n = pageTexts.length;
  if (n <= 1) return { order: null, flags: [] };
  const markers = pageTexts.map(pageMarker);
  const known = markers.map((m, i) => [i, m]).filter(([, m]) => m);
  if (!known.length) return { order: null, flags: [] };
  const totals = new Set(known.map(([, m]) => m[1]));
  if (totals.size !== 1)
    return { order: null, flags: ["order-uncertain:mixed-totals"] };
  const total = [...totals][0];
  if (known.length < n || total !== n) {
    // partial markers: verify the marked ones are ascending; else flag
    const xs = known.map(([, m]) => m[0]);
    const sorted = [...xs].sort((a, b) => a - b);
    if (JSON.stringify(xs) !== JSON.stringify(sorted))
      return { order: null, flags: ["order-uncertain:partial-markers"] };
    return { order: null, flags: [] };
  }
  const xs = known.map(([, m]) => m[0]);
  const identity = Array.from({ length: n }, (_, i) => i + 1);
  const sorted = [...xs].sort((a, b) => a - b);
  if (JSON.stringify(sorted) !== JSON.stringify(identity))
    return { order: null, flags: ["order-uncertain:not-a-permutation"] };
  if (JSON.stringify(xs) === JSON.stringify(identity))
    return { order: null, flags: [] };          // already in order
  // scanned page i (0-based) claims position xs[i]
  const order = new Array(n).fill(0);
  xs.forEach((pos, scanIdx) => { order[pos - 1] = scanIdx + 1; });
  return { order, flags: ["page-order-fixed"] };
}

module.exports = { pageMarker, checkOrder };
