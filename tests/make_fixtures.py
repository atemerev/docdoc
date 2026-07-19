#!/usr/bin/python3
"""Generate synthetic scan batches: a Swiss insurance premium invoice with a
QR-bill, and a matching 1. Mahnung. Used to exercise the invoice lifecycle,
reminder linking, refs and timeline end to end.

Usage: /usr/bin/python3 tests/make_fixtures.py <outdir>
Creates <outdir>/fixture-invoice/page-001.jpg and <outdir>/fixture-mahnung/page-001.jpg
"""

import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf"

IBAN = "CH4431999123000889012"          # valid QR-IBAN (IID 31999)
QRR = "210000000003139471430009017"     # valid mod-10 check digit
INVOICE_NO = "RE-2026-0042"
POLICY_NO = "P-778899"


def qr_png(payload, path):
    subprocess.run(["qrencode", "-l", "M", "-s", "8", "-m", "4", "-o", path,
                    payload], check=True)


def page(lines, qr_payload=None):
    """Render an A4-ish 300dpi page image; lines = [(x, y, size, bold, text)]."""
    im = Image.new("RGB", (2480, 3508), "white")
    d = ImageDraw.Draw(im)
    for x, y, size, bold, text in lines:
        f = ImageFont.truetype(FONT_BOLD if bold else FONT, size)
        d.text((x, y), text, font=f, fill="black")
    if qr_payload:
        with tempfile.NamedTemporaryFile(suffix=".png") as tf:
            qr_png(qr_payload, tf.name)
            qr = Image.open(tf.name)
            qr = qr.resize((560, 560), Image.NEAREST)
            im.paste(qr, (180, 2760))
    return im


def spc(amount, message, swico):
    return "\r\n".join([
        "SPC", "0200", "1", IBAN,
        "S", "Helvetia Versicherungen AG", "St. Alban-Anlage", "26",
        "4002", "Basel", "CH",
        "", "", "", "", "", "", "",
        f"{amount:.2f}", "CHF",
        "S", "Aryeh Testperson", "Musterweg", "1", "8000", "Zürich", "CH",
        "QRR", QRR,
        message, "EPD", swico,
    ])


def invoice_page():
    lines = [
        (180, 160, 64, True, "Helvetia Versicherungen AG"),
        (180, 250, 40, False, "St. Alban-Anlage 26, 4002 Basel"),
        (1700, 160, 40, False, "Basel, 15.06.2026"),
        (180, 480, 40, False, "Aryeh Testperson"),
        (180, 540, 40, False, "Musterweg 1"),
        (180, 600, 40, False, "8000 Zürich"),
        (180, 860, 56, True, "Rechnung Nr. RE-2026-0042"),
        (180, 970, 40, False, "Hausratversicherung — Prämie 2026/2027"),
        (180, 1030, 40, False, "Policen-Nr. P-778899"),
        (180, 1090, 40, False, "Kunden-Nr. K-556677"),
        (180, 1250, 40, False, "Versicherungsperiode: 01.07.2026 – 30.06.2027"),
        (180, 1400, 44, True, "Prämie total: CHF 249.60"),
        (180, 1520, 40, False, "Zahlbar bis 15.07.2026 (30 Tage netto)."),
        (180, 2650, 44, True, "Zahlteil / Section paiement"),
    ]
    sw = "//S1/10/RE-2026-0042/11/260615/30/106017086/40/0:30"
    return page(lines, qr_payload=spc(249.60, "Praemie Hausrat P-778899", sw))


def mahnung_page():
    lines = [
        (180, 160, 64, True, "Helvetia Versicherungen AG"),
        (180, 250, 40, False, "St. Alban-Anlage 26, 4002 Basel"),
        (1700, 160, 40, False, "Basel, 05.08.2026"),
        (180, 480, 40, False, "Aryeh Testperson"),
        (180, 540, 40, False, "Musterweg 1"),
        (180, 600, 40, False, "8000 Zürich"),
        (180, 860, 56, True, "1. Mahnung"),
        (180, 970, 40, False,
         "Unsere Rechnung Nr. RE-2026-0042 vom 15.06.2026 ist trotz"),
        (180, 1030, 40, False,
         "Fälligkeit am 15.07.2026 noch unbeglichen."),
        (180, 1150, 40, False, "Policen-Nr. P-778899"),
        (180, 1300, 40, False, "Rechnungsbetrag:          CHF 249.60"),
        (180, 1360, 40, False, "Mahngebühr:               CHF  20.00"),
        (180, 1450, 44, True, "Total zahlbar:            CHF 269.60"),
        (180, 1570, 40, False,
         "Wir bitten um Zahlung bis 19.08.2026 mit dem ursprünglichen"),
        (180, 1630, 40, False, "Einzahlungsschein."),
    ]
    # deliberately no QR payment part: reminders often arrive as plain
    # letters, so linking must work via the extracted invoice number
    return page(lines)


def main(outdir):
    for name, maker in [("fixture-invoice", invoice_page),
                        ("fixture-mahnung", mahnung_page)]:
        d = os.path.join(outdir, name)
        os.makedirs(d, exist_ok=True)
        maker().save(os.path.join(d, "page-001.jpg"), quality=90)
        print(f"wrote {d}/page-001.jpg")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
