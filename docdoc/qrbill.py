"""Swiss QR-bill: decode QR codes from page images (zbarimg) and parse the
Swiss Payments Code payload.

Implements SIX Implementation Guidelines v2.3 (accepting v2.2 'K' combined
addresses too -- pre-Nov-2025 paper is everywhere) and Swico S1 billing
information. Payload Version is '0200' for all of v2.0-2.4, so spec version
cannot be detected from the payload.
"""

import datetime
import re
import subprocess

QR_IID_MIN, QR_IID_MAX = 30000, 31999
MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5]

NOTIFICATION_TEXTS = (
    "NICHT ZUR ZAHLUNG VERWENDEN",
    "NE PAS UTILISER POUR LE PAIEMENT",
    "NON UTILIZZARE PER IL PAGAMENTO",
    "DO NOT USE FOR PAYMENT",
)


def iban_valid(iban):
    s = re.sub(r"\s", "", iban or "").upper()
    if not re.fullmatch(r"[A-Z]{2}[0-9]{2}[A-Z0-9]+", s):
        return False
    rearranged = s[4:] + s[:4]
    digits = "".join(str(int(c, 36)) for c in rearranged)
    return int(digits) % 97 == 1


def is_qr_iban(iban):
    s = re.sub(r"\s", "", iban or "")
    if len(s) < 9:
        return False
    try:
        iid = int(s[4:9])
    except ValueError:
        return False
    return QR_IID_MIN <= iid <= QR_IID_MAX


def qrr_valid(ref):
    """QR reference: 27 digits, mod-10 recursive check digit, not all zeros."""
    if not re.fullmatch(r"\d{27}", ref or "") or ref.strip("0") == "":
        return False
    carry = 0
    for d in ref[:26]:
        carry = MOD10_TABLE[(carry + int(d)) % 10]
    return (10 - carry) % 10 == int(ref[26])


def scor_valid(ref):
    """ISO 11649 creditor reference: RF + 2 check digits + <=21 alnum."""
    s = (ref or "").upper()
    if not re.fullmatch(r"RF\d{2}[A-Z0-9]{1,21}", s):
        return False
    rearranged = s[4:] + s[:4]
    digits = "".join(str(int(c, 36)) for c in rearranged)
    return int(digits) % 97 == 1


def _swico_split(s):
    """Split on '/' honoring \\/ and \\\\ escapes."""
    parts, cur, i = [], "", 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] in "/\\":
            cur += s[i + 1]
            i += 2
        elif c == "/":
            parts.append(cur)
            cur = ""
            i += 1
        else:
            cur += c
            i += 1
    parts.append(cur)
    return parts


def _yymmdd(s):
    try:
        d = datetime.datetime.strptime(s[:6], "%y%m%d").date()
        return d.isoformat()
    except ValueError:
        return None


def parse_swico(strd):
    """Parse Swico S1 billing information ('//S1/10/.../40/2:10;0:30').

    Returns dict with raw tags plus derived: invoice_no, invoice_date,
    customer_ref, uid, due_date (from /11/ + the 0%-entry of /40/),
    discounts [(pct, days), ...].
    """
    if not strd or not strd.startswith("//"):
        return None
    scheme = strd[2:4]
    if scheme != "S1":
        return {"scheme": scheme, "raw": strd}
    parts = _swico_split(strd[4:])
    # parts[0] is '' (leading /), then alternating tag, value
    tags = {}
    it = iter(parts[1:])
    for tag in it:
        val = next(it, "")
        if tag:
            tags[tag] = val
    out = {"scheme": "S1", "tags": tags, "raw": strd}
    out["invoice_no"] = tags.get("10")
    out["invoice_date"] = _yymmdd(tags["11"]) if "11" in tags else None
    out["customer_ref"] = tags.get("20")
    out["uid"] = tags.get("30")
    if "40" in tags:
        discounts = []
        for cond in tags["40"].split(";"):
            m = re.fullmatch(r"([\d.]+):(\d+)", cond.strip())
            if m:
                discounts.append((float(m.group(1)), int(m.group(2))))
        out["discounts"] = discounts
        net = next((days for pct, days in discounts if pct == 0), None)
        if net is not None and out["invoice_date"]:
            due = (datetime.date.fromisoformat(out["invoice_date"])
                   + datetime.timedelta(days=net))
            out["due_date"] = due.isoformat()
    return out


def _address(lines):
    """7 payload lines -> address dict (S structured or K combined)."""
    adrtp, name, l1, l2, pcode, town, country = (lines + [""] * 7)[:7]
    if not name:
        return None
    a = {"name": name, "country": country or None, "type": adrtp or None}
    if adrtp == "K":
        a["line1"], a["line2"] = l1 or None, l2 or None
    else:
        a["street"], a["building"] = l1 or None, l2 or None
        a["postal_code"], a["town"] = pcode or None, town or None
    return a


def parse_spc(payload):
    """Parse a Swiss Payments Code payload. Returns dict or None if not SPC.

    Tolerant reader: validation problems recorded in ['problems'] instead of
    rejecting (scanned archives contain old and slightly broken bills).
    """
    if not payload:
        return None
    lines = payload.replace("\r\n", "\n").split("\n")
    if len(lines) < 31 or lines[0].strip() != "SPC":
        return None
    L = [ln.strip() for ln in lines] + [""] * (34 - len(lines))
    problems = []
    if L[1] != "0200":
        problems.append(f"unexpected version {L[1]!r}")
    if L[2] != "1":
        problems.append(f"unexpected coding {L[2]!r}")

    iban = L[3].replace(" ", "").upper()
    if not iban_valid(iban):
        problems.append(f"IBAN check failed: {iban}")
    if iban[:2] not in ("CH", "LI"):
        problems.append(f"IBAN not CH/LI: {iban[:2]}")

    creditor = _address(L[4:11])
    debtor = _address(L[20:27])

    amount = None
    if L[18]:
        try:
            amount = float(L[18])
        except ValueError:
            problems.append(f"bad amount {L[18]!r}")
    currency = L[19]
    if currency not in ("CHF", "EUR"):
        problems.append(f"bad currency {currency!r}")

    ref_type, reference = L[27], L[28].replace(" ", "")
    if ref_type == "QRR":
        if not qrr_valid(reference):
            problems.append(f"QRR reference invalid: {reference}")
        if not is_qr_iban(iban):
            problems.append("QRR used with non-QR-IBAN")
    elif ref_type == "SCOR":
        if not scor_valid(reference):
            problems.append(f"SCOR reference invalid: {reference}")
        if is_qr_iban(iban):
            problems.append("SCOR used with QR-IBAN")
    elif ref_type == "NON":
        if reference:
            problems.append("reference present with type NON")
    else:
        problems.append(f"unknown reference type {ref_type!r}")

    message = L[29]
    if L[30] != "EPD":
        problems.append(f"missing EPD trailer (got {L[30]!r})")
    swico = parse_swico(L[31]) if L[31] else None
    alt = [x for x in L[32:34] if x]

    is_notification = (amount == 0.0 or
                       any(t in (message or "").upper() for t in NOTIFICATION_TEXTS))

    return {
        "iban": iban,
        "is_qr_iban": is_qr_iban(iban),
        "creditor": creditor,
        "debtor": debtor,
        "amount": amount,
        "currency": currency,
        "ref_type": ref_type,
        "reference": reference or None,
        "message": message or None,
        "swico": swico,
        "alt_procedures": alt,
        "is_notification": is_notification,
        "problems": problems,
        "payload": payload,
    }


def decode_qr_codes(image_path):
    """All QR payloads in an image via zbarimg. Returns list of strings."""
    proc = subprocess.run(
        ["zbarimg", "--raw", "-q", "-Sdisable", "-Sqrcode.enable", "-Sbinary",
         image_path],
        capture_output=True)
    if proc.returncode not in (0, 4):        # 4 = no symbols found
        return []
    # -Sbinary stops zbar from charset-guessing (it mangles UTF-8 umlauts
    # otherwise); we decode UTF-8 ourselves. SPC payloads embed newlines,
    # so symbols are split on the 'SPC' header anchor, not on lines.
    out = proc.stdout.decode("utf-8", errors="replace")
    if not out.strip():
        return []
    idxs = [m.start() for m in re.finditer(r"(?m)^SPC\r?$", out)]
    if idxs:
        idxs.append(len(out))
        return [out[idxs[i]:idxs[i + 1]].strip("\n") for i in range(len(idxs) - 1)]
    return [c for c in out.strip("\n").split("\n") if c]


def find_qrbill(image_paths):
    """Scan page images for a Swiss QR-bill; first valid SPC wins."""
    for path in image_paths:
        for payload in decode_qr_codes(path):
            parsed = parse_spc(payload)
            if parsed:
                return parsed
    return None


def build_spc(qr):
    """Rebuild an SPC payload from a parsed dict (for QR re-render).
    Uses the stored original payload when available."""
    return qr.get("payload")
