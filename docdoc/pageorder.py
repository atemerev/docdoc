"""Page-order verification from OCR'd page markers.

Looks for 'Seite 2 von 5' / 'page 2 sur 5' / 'pagina 2 di 5' /
'page 2 of 5' / '2/5' style markers. Reordering only happens when the
evidence is unambiguous: every page carries exactly one consistent marker,
the totals agree, and the marker numbers are a permutation of 1..N.
Anything murkier just raises a flag for the review queue.
"""

import re

MARKER_RES = [
    re.compile(r"\bSeite\s+(\d{1,3})\s*(?:von|/)\s*(\d{1,3})\b", re.I),
    re.compile(r"\bpage\s+(\d{1,3})\s*(?:of|sur|de|/)\s*(\d{1,3})\b", re.I),
    re.compile(r"\bpagina\s+(\d{1,3})\s*(?:di|/)\s*(\d{1,3})\b", re.I),
    re.compile(r"(?<![\d./,])(\d{1,3})\s*/\s*(\d{1,3})(?![\d./,%])"),
]


def page_marker(text):
    """Best (x, y) marker in a page's text, or None."""
    candidates = []
    for i, rx in enumerate(MARKER_RES):
        for m in rx.finditer(text or ""):
            x, y = int(m.group(1)), int(m.group(2))
            if 1 <= x <= y <= 200:
                candidates.append((i, x, y))
        if candidates:
            break        # worded markers beat bare x/y
    if not candidates:
        return None
    # prefer the most common total among candidates
    totals = {}
    for _, x, y in candidates:
        totals.setdefault(y, []).append(x)
    y = max(totals, key=lambda k: len(totals[k]))
    xs = set(totals[y])
    if len(xs) != 1:
        return None      # contradictory markers on one page
    return (xs.pop(), y)


def check_order(page_texts):
    """-> (order, flags): order is a 1-based list mapping final position
    to scanned page (None = leave as scanned)."""
    n = len(page_texts)
    if n <= 1:
        return None, []
    markers = [page_marker(t) for t in page_texts]
    known = [(i, m) for i, m in enumerate(markers) if m]
    if not known:
        return None, []
    totals = {m[1] for _, m in known}
    if len(totals) != 1:
        return None, ["order-uncertain:mixed-totals"]
    total = totals.pop()
    if len(known) < n or total != n:
        # partial markers: verify the marked ones are ascending; else flag
        xs = [m[0] for _, m in known]
        if xs != sorted(xs):
            return None, ["order-uncertain:partial-markers"]
        return None, []
    xs = [m[0] for _, m in known]
    if sorted(xs) != list(range(1, n + 1)):
        return None, ["order-uncertain:not-a-permutation"]
    if xs == list(range(1, n + 1)):
        return None, []                     # already in order
    # scanned page i (0-based) claims position xs[i]
    order = [0] * n
    for scan_idx, pos in enumerate(xs):
        order[pos - 1] = scan_idx + 1       # 1-based scanned page number
    return order, ["page-order-fixed"]
