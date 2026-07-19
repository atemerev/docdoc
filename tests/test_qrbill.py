#!/usr/bin/python3
"""Round-trip test for the Swiss QR-bill parser: synthesize an SPC payload,
render it as a QR image (qrencode), decode it back (zbarimg), parse, verify.
Run: /usr/bin/python3 tests/test_qrbill.py
"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from docdoc import qrbill  # noqa: E402


def make_qrr(base26):
    carry = 0
    for d in base26:
        carry = qrbill.MOD10_TABLE[(carry + int(d)) % 10]
    return base26 + str((10 - carry) % 10)


def main():
    failures = []

    def check(name, cond, detail=""):
        status = "ok" if cond else "FAIL"
        print(f"  [{status}] {name} {detail}")
        if not cond:
            failures.append(name)

    print("== validation primitives ==")
    check("IBAN valid", qrbill.iban_valid("CH4431999123000889012"))
    check("IBAN invalid detected", not qrbill.iban_valid("CH4431999123000889013"))
    check("QR-IBAN detected", qrbill.is_qr_iban("CH4431999123000889012"))
    check("normal IBAN not QR", not qrbill.is_qr_iban("CH9300762011623852957"))
    # worked example from the SIX IG: 26-digit ref -> check digit 7
    ig = make_qrr("21000000000313947143000901")
    check("QRR IG example check digit", ig.endswith("7"), ig)
    check("QRR valid", qrbill.qrr_valid(ig))
    check("QRR bad check digit", not qrbill.qrr_valid(ig[:-1] + "5"))
    check("SCOR valid", qrbill.scor_valid("RF18539007547034"))
    check("SCOR invalid", not qrbill.scor_valid("RF19539007547034"))

    print("== swico ==")
    s = qrbill.parse_swico(
        "//S1/10/10201409/11/190512/20/1400.000-53/30/106017086/32/7.7/40/2:10;0:30")
    check("swico invoice_no", s["invoice_no"] == "10201409")
    check("swico invoice_date", s["invoice_date"] == "2019-05-12")
    check("swico uid", s["uid"] == "106017086")
    check("swico due date (invoice+30d)", s.get("due_date") == "2019-06-11", s.get("due_date"))
    check("swico discounts", s["discounts"] == [(2.0, 10), (0.0, 30)])
    esc = qrbill.parse_swico(r"//S1/10/X.66711\/8824/11/200712")
    check("swico escaped slash", esc["invoice_no"] == "X.66711/8824", esc["invoice_no"])

    print("== SPC round trip through a real QR image ==")
    qrr = make_qrr("21000000000313947143000901")
    payload = "\r\n".join([
        "SPC", "0200", "1",
        "CH4431999123000889012",
        "S", "Max Muster & Söhne", "Musterstrasse", "123", "8000", "Seldwyla", "CH",
        "", "", "", "", "", "", "",
        "1949.75", "CHF",
        "S", "Simon Muster", "Musterstrasse", "1", "8000", "Seldwyla", "CH",
        "QRR", qrr,
        "Auftrag vom 15.06.2026",
        "EPD",
        "//S1/10/10201409/11/260615/30/106017086/40/0:30",
    ])
    with tempfile.TemporaryDirectory() as td:
        png = os.path.join(td, "qr.png")
        subprocess.run(["qrencode", "-l", "M", "-s", "6", "-m", "4", "-o", png, payload],
                       check=True)
        found = qrbill.find_qrbill([png])
    check("QR decoded & parsed", found is not None)
    if found:
        check("iban", found["iban"] == "CH4431999123000889012")
        check("is QR-IBAN", found["is_qr_iban"])
        check("creditor name", found["creditor"]["name"] == "Max Muster & Söhne",
              str(found["creditor"]))
        check("amount", found["amount"] == 1949.75)
        check("currency", found["currency"] == "CHF")
        check("ref", found["reference"] == qrr)
        check("debtor", found["debtor"]["name"] == "Simon Muster")
        check("swico due date", found["swico"]["due_date"] == "2026-07-15",
              str(found["swico"].get("due_date")))
        check("no problems", found["problems"] == [], str(found["problems"]))
        check("not a notification", not found["is_notification"])

    print("== K-address (v2.2 legacy) and notification bills ==")
    legacy = payload.replace(
        "S\r\nMax Muster & Söhne\r\nMusterstrasse\r\n123\r\n8000\r\nSeldwyla\r\nCH",
        "K\r\nMax Muster & Söhne\r\nMusterstrasse 123\r\n8000 Seldwyla\r\n\r\n\r\nCH")
    k = qrbill.parse_spc(legacy)
    check("K address parsed", k and k["creditor"]["line2"] == "8000 Seldwyla",
          str(k and k["creditor"]))
    notif = qrbill.parse_spc(payload.replace("1949.75", "0.00"))
    check("0.00 = notification", notif["is_notification"])

    print()
    if failures:
        print(f"FAILED: {len(failures)}: {failures}")
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
