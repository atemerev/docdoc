#!/usr/bin/python3
"""Blank-page detector test: synthesize scan images with the artifacts the
ADS-4300N produces on duplex backsides (skew wedges of dark scanner
background along the edges, a fold crease, a light stain) and verify
is_blank/ink_coverage keeps content pages and drops empty ones.
Run: /usr/bin/python3 tests/test_blank.py
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from docdoc import ocr  # noqa: E402

from PIL import Image, ImageDraw  # noqa: E402

W, H = 1240, 1754   # A4 at 150 dpi


def base_page():
    return Image.new("L", (W, H), 252)


def add_skew_wedges(im):
    """Dark scanner background peeking in at the borders of a skewed feed."""
    d = ImageDraw.Draw(im)
    d.polygon([(0, 0), (int(W * 0.45), 0), (0, int(H * 0.04))], fill=15)
    d.polygon([(W, 0), (W - int(W * 0.06), 0), (W, int(H * 0.35))], fill=15)
    d.polygon([(W, H), (W - int(W * 0.30), H), (W, H - int(H * 0.03))], fill=20)
    return im


def add_crease_and_stain(im):
    d = ImageDraw.Draw(im)
    d.line([(0, H // 2), (W, H // 2 - 8)], fill=185, width=4)   # fold shadow
    d.ellipse([(W * 0.3, H * 0.85), (W * 0.3 + 60, H * 0.85 + 45)],
              fill=205)                                         # light stain
    return im


def add_photo_block(im):
    d = ImageDraw.Draw(im)
    d.rectangle([(W * 0.25, H * 0.3), (W * 0.75, H * 0.55)], fill=70)
    return im


def main():
    failures = []

    def check(name, cond, detail=""):
        status = "ok" if cond else "FAIL"
        print(f"  [{status}] {name} {detail}")
        if not cond:
            failures.append(name)

    with tempfile.TemporaryDirectory() as td:
        def save(im, name):
            p = os.path.join(td, name)
            im.save(p, "JPEG", quality=85)
            return p

        clean = save(base_page(), "clean.jpg")
        wedged = save(add_crease_and_stain(add_skew_wedges(base_page())),
                      "wedged.jpg")
        photo = save(add_photo_block(add_skew_wedges(base_page())),
                     "photo.jpg")

        cov_clean = ocr.ink_coverage(clean)
        cov_wedged = ocr.ink_coverage(wedged)
        cov_photo = ocr.ink_coverage(photo)

        check("clean blank page: no ink", cov_clean <= 0.004,
              f"(coverage {cov_clean:.4f})")
        check("skewed blank backside: wedges/crease/stain ignored",
              cov_wedged <= 0.004, f"(coverage {cov_wedged:.4f})")
        check("photo page: interior ink detected", cov_photo > 0.004,
              f"(coverage {cov_photo:.4f})")

        check("is_blank: empty backside with artifacts",
              ocr.is_blank("", wedged) is True)
        check("is_blank: photo page with no OCR text",
              ocr.is_blank("", photo) is False)
        check("is_blank: text page wins regardless of image",
              ocr.is_blank("Rechnung Nr. 2026-001", wedged) is False)
        check("is_blank: missing image falls back to text",
              ocr.is_blank("", os.path.join(td, "gone.jpg")) is True)

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
