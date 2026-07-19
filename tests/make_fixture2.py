#!/usr/bin/python3
"""A second synthetic document: Swisscom phone bill WITHOUT a QR code --
exercises the non-QR invoice path (AI-only amount/due-date extraction).
Usage: /usr/bin/python3 tests/make_fixture2.py <batch_dir>"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from make_fixtures import page  # noqa: E402


def main(outdir):
    lines = [
        (180, 160, 64, True, "Swisscom (Schweiz) AG"),
        (180, 250, 40, False, "Postfach, 3050 Bern"),
        (1700, 160, 40, False, "Bern, 01.07.2026"),
        (180, 480, 40, False, "Aryeh Testperson"),
        (180, 540, 40, False, "Musterweg 1"),
        (180, 600, 40, False, "8000 Zürich"),
        (180, 860, 56, True, "Rechnung Juli 2026"),
        (180, 970, 40, False, "Rechnungsnummer: 7300-4455-6677"),
        (180, 1030, 40, False, "Kundennummer: SC-991122"),
        (180, 1180, 40, False, "Mobile Abo blue M          CHF 45.00"),
        (180, 1240, 40, False, "Internet Home              CHF 59.90"),
        (180, 1360, 44, True, "Total CHF 104.90"),
        (180, 1480, 40, False, "Zahlbar bis 31.07.2026."),
    ]
    os.makedirs(outdir, exist_ok=True)
    page(lines).save(os.path.join(outdir, "page-001.jpg"), quality=90)
    print(f"wrote {outdir}/page-001.jpg")


if __name__ == "__main__":
    main(sys.argv[1])
