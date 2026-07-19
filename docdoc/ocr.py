"""OCR stage: scanner images -> searchable PDF + per-page text.

img2pdf embeds the JPEGs losslessly; ocrmypdf (tesseract) adds the text
layer, auto-rotates (needs tesseract-osd) and deskews; the --sidecar text
comes back with form-feed page separators, giving per-page text aligned
with input page order.
"""

import os
import subprocess

# tessdata_best models (Fedora langpacks are tessdata_fast, the least
# accurate ones) -- downloaded to /pool/docdoc/tessdata per RESEARCH.md
TESSDATA_DIR = "/pool/docdoc/tessdata"


class OcrError(RuntimeError):
    pass


def _run(cmd, **kw):
    env = None
    if cmd[0] in ("ocrmypdf", "tesseract") and os.path.isdir(TESSDATA_DIR):
        env = dict(os.environ, TESSDATA_PREFIX=TESSDATA_DIR)
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env, **kw)
    if proc.returncode != 0:
        raise OcrError(f"{cmd[0]} failed ({proc.returncode}): "
                       f"{proc.stderr.strip()[-800:]}")
    return proc


def images_to_pdf(image_paths, out_pdf):
    _run(["img2pdf", "--output", out_pdf, *image_paths])
    return out_pdf


def ocr_pdf(in_pdf, out_pdf, languages="deu+fra+ita+eng", jobs=8):
    """Returns (out_pdf, per_page_texts). Page order == input order."""
    sidecar = out_pdf + ".txt"
    _run(["ocrmypdf", "-l", languages, "--rotate-pages", "--deskew",
          "--sidecar", sidecar, "--output-type", "pdfa",
          "--optimize", "1", "--jobs", str(jobs), "--quiet",
          in_pdf, out_pdf])
    with open(sidecar, encoding="utf-8", errors="replace") as f:
        pages = f.read().split("\f")
    os.unlink(sidecar)
    # sidecar ends with a trailing \f -> drop the final empty chunk
    if pages and pages[-1].strip() == "":
        pages = pages[:-1]
    return out_pdf, [p.strip() for p in pages]


def ink_coverage(image_path, dark_threshold=128, trim=0.08):
    """Fraction of dark pixels in the page interior; distinguishes truly
    blank duplex backsides from photo/handwriting pages that OCR to
    nothing. The outer `trim` fraction of every edge is ignored: a skewed
    ADF feed shows the scanner background as dark wedges along the
    borders (routine on the ADS-4300N), and edge shadows/punch holes must
    not count as ink either."""
    from PIL import Image, ImageFilter
    with Image.open(image_path) as im:
        g = im.convert("L")
        g.thumbnail((300, 300))
        w, h = g.size
        dx, dy = round(w * trim), round(h * trim)
        g = g.crop((dx, dy, w - dx, h - dy))
        g = g.filter(ImageFilter.MedianFilter(3))     # kill scanner noise
        hist = g.histogram()
    dark = sum(hist[:dark_threshold])
    total = sum(hist)
    return dark / total if total else 0.0


def is_blank(page_text, image_path, min_chars=12, max_ink=0.004):
    if len((page_text or "").strip()) >= min_chars:
        return False
    try:
        return ink_coverage(image_path) <= max_ink
    except Exception:
        return not (page_text or "").strip()


def rebuild_pdf(in_pdf, out_pdf, keep_order):
    """Reorder/drop pages: keep_order is a 1-based page list, e.g. [3,1,2]."""
    spec = ",".join(str(p) for p in keep_order)
    _run(["qpdf", in_pdf, "--pages", ".", spec, "--", out_pdf])
    return out_pdf


def thumbnail(pdf_path, out_jpg, width=480):
    base = out_jpg[:-4] if out_jpg.endswith(".jpg") else out_jpg
    _run(["pdftoppm", "-jpeg", "-f", "1", "-l", "1",
          "-scale-to-x", str(width), "-scale-to-y", "-1",
          "-singlefile", pdf_path, base])
    return base + ".jpg"


def page_count(pdf_path):
    proc = _run(["qpdf", "--show-npages", pdf_path])
    return int(proc.stdout.strip())
