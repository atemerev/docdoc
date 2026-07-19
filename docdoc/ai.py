"""AI document understanding.

Default provider 'claude-cli': headless `claude -p` with vision — the model
Reads the page images directly (research: vision beats OCR-text-only for
stamps/logos/layout, and is immune to OCR errors). OCR text and QR-bill
data are included as extra context. Falls back to keyword heuristics when
no AI is available.

Gotcha handled here: this machine's login profile exports ANTHROPIC_API_KEY
for a zero-credit account, which would override the claude.ai subscription
login — the subprocess env drops it.
"""

import datetime
import json
import os
import re
import subprocess
import unicodedata

DOC_TYPES = ("invoice", "reminder", "receipt", "letter", "contract",
             "policy", "statement", "return_slip", "medical", "insurance",
             "tax", "other")

REF_KINDS = ("invoice_no", "customer_no", "policy_no", "contract_no",
             "case_no", "member_no", "order_no", "other")

PROMPT = """\
You are the extraction engine of a document management system. Analyze the
scanned document whose page images you must Read from these paths:
{image_list}

Additional context:
- OCR text of the document (may contain recognition errors):
---
{ocr_text}
---
{qr_context}{sender_context}
Output ONLY a JSON object, no prose, no code fences, with exactly these keys:
- doc_type: one of {doc_types}
  ("reminder" = payment reminder/Mahnung/rappel/sollecito for an earlier invoice)
- sender_name: organization/person who issued the document (not the recipient)
- sender_key: short lowercase-slug identifying the sender, reuse a known
  sender key when it is clearly the same organization
- recipient_name: or null
- doc_date: the document's own date, ISO YYYY-MM-DD, or null
- title: short human title in the document's language (max 60 chars),
  e.g. "Rechnung März 2026" — never include the sender name in it
- language: ISO 639-1 of the document body
- summary_en: 1-2 sentence English summary
- tags: 2-6 lowercase topical tags (English)
- amount: total amount due/paid as number, or null
- currency: ISO code or null
- due_date: payment due date ISO YYYY-MM-DD or null (if the text names a
  payment term like "zahlbar innert 30 Tagen", compute doc_date + term)
- invoice_ref: invoice/customer reference number or null
- reminder_level: 0 unless this is a reminder; 1 for Zahlungserinnerung or
  1. Mahnung / 1er rappel, 2 for 2. Mahnung, etc.
- reminder_fee: reminder/dunning fee amount charged in THIS document, or null
- refs: array of ALL internal identifiers printed on the document, each as
  {{"kind": one of {ref_kinds}, "value": "as printed"}}.
  Include invoice numbers, customer numbers, policy numbers (Police-Nr),
  contract numbers (Vertrags-Nr), case/dossier numbers (Fall-Nr, Schaden-Nr),
  member numbers, order numbers. These link related documents together, so
  be thorough — a reminder must include the original invoice number, a
  premium invoice must include the policy number.
- ref_dates: array of OTHER documents' dates mentioned in this one, each as
  {{"date": "YYYY-MM-DD", "label": "short description"}} — e.g. a reminder
  mentioning the original invoice date, a policy naming the coverage start.
- page_order: null if the {n_pages} page image(s) given above are already in
  correct reading order; otherwise the correct order as a list of 1-based
  positions, e.g. [2,1,3] means the 2nd image is really page 1. Judge from
  content flow, page numbering, letterhead/signature placement.
"""


def slugify(name):
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:40] or "unknown"


def _strip_fences(text):
    t = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    # tolerate prose around a JSON object
    if not t.startswith("{"):
        m = re.search(r"\{.*\}", t, re.S)
        t = m.group(0) if m else t
    return t


def _normalize(d, qr=None):
    """Validate/normalize an extraction dict; never trust the model."""
    out = {}
    out["doc_type"] = d.get("doc_type") if d.get("doc_type") in DOC_TYPES else "other"
    out["sender_name"] = (d.get("sender_name") or "").strip() or None
    out["sender_key"] = slugify(d.get("sender_key") or d.get("sender_name") or "")
    out["recipient_name"] = (d.get("recipient_name") or "").strip() or None
    out["title"] = ((d.get("title") or "").strip() or None)
    out["language"] = (d.get("language") or "")[:2].lower() or None
    out["summary_en"] = (d.get("summary_en") or "").strip() or None
    tags = d.get("tags") or []
    out["tags"] = [str(t).lower().strip()[:32] for t in tags if str(t).strip()][:8]
    for k in ("doc_date", "due_date"):
        v = d.get(k)
        try:
            out[k] = datetime.date.fromisoformat(str(v)[:10]).isoformat() if v else None
        except ValueError:
            out[k] = None
    for k in ("amount", "reminder_fee"):
        try:
            out[k] = float(d[k]) if d.get(k) is not None else None
        except (TypeError, ValueError):
            out[k] = None
    out["currency"] = (str(d.get("currency") or "")[:3].upper() or None)
    out["invoice_ref"] = (str(d.get("invoice_ref") or "").strip() or None)
    try:
        out["reminder_level"] = max(0, min(9, int(d.get("reminder_level") or 0)))
    except (TypeError, ValueError):
        out["reminder_level"] = 0
    refs = []
    for r in (d.get("refs") or []):
        if isinstance(r, dict) and r.get("value"):
            kind = r.get("kind") if r.get("kind") in REF_KINDS else "other"
            refs.append({"kind": kind, "value": str(r["value"]).strip()[:64]})
    out["refs"] = refs[:20]
    ref_dates = []
    for r in (d.get("ref_dates") or []):
        try:
            ref_dates.append({
                "date": datetime.date.fromisoformat(str(r["date"])[:10]).isoformat(),
                "label": str(r.get("label") or "")[:80]})
        except (KeyError, TypeError, ValueError):
            pass
    out["ref_dates"] = ref_dates[:10]
    order = d.get("page_order")
    out["page_order"] = None
    if isinstance(order, list):
        try:
            order = [int(x) for x in order]
            if sorted(order) == list(range(1, len(order) + 1)) and \
                    order != list(range(1, len(order) + 1)):
                out["page_order"] = order
        except (TypeError, ValueError):
            pass
    # QR-bill data is authoritative where present
    if qr:
        if qr.get("amount") and not qr.get("is_notification"):
            out["amount"] = qr["amount"]
            out["currency"] = qr.get("currency") or out["currency"]
        if qr.get("swico") and qr["swico"].get("due_date"):
            out["due_date"] = qr["swico"]["due_date"]
        if qr.get("swico") and qr["swico"].get("invoice_no"):
            out["invoice_ref"] = qr["swico"]["invoice_no"]
        if out["doc_type"] not in ("invoice", "reminder") and not qr.get("is_notification"):
            out["doc_type"] = "invoice"
        if qr.get("creditor") and not out["sender_name"]:
            out["sender_name"] = qr["creditor"]["name"]
            out["sender_key"] = slugify(qr["creditor"]["name"])
    return out


def _qr_context(qr):
    if not qr:
        return ""
    lines = ["- The document carries a Swiss QR-bill with:"]
    if qr.get("creditor"):
        lines.append(f"  creditor: {qr['creditor'].get('name')}")
    if qr.get("amount") is not None:
        lines.append(f"  amount: {qr['amount']} {qr.get('currency')}")
    if qr.get("reference"):
        lines.append(f"  reference: {qr['reference']}")
    if qr.get("is_notification"):
        lines.append("  NOTE: amount 0.00 = notification, not payable")
    return "\n".join(lines) + "\n"


def extract_claude_cli(image_paths, ocr_text, qr=None, known_senders=(),
                       model="sonnet", max_pages=4, timeout=300):
    images = image_paths[:max_pages]
    sender_ctx = ""
    if known_senders:
        sender_ctx = ("- Known sender keys (reuse when the same organization): "
                      + ", ".join(sorted(known_senders)[:80]) + "\n")
    prompt = PROMPT.format(
        image_list="\n".join(f"  {p}" for p in images),
        ocr_text=(ocr_text or "")[:6000],
        qr_context=_qr_context(qr),
        sender_context=sender_ctx,
        doc_types="|".join(DOC_TYPES),
        ref_kinds="|".join(REF_KINDS),
        n_pages=len(images),
    )
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    proc = subprocess.run(
        ["claude", "-p", prompt, "--allowedTools", "Read",
         "--output-format", "json", "--model", model],
        capture_output=True, text=True, timeout=timeout, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed: {proc.stderr.strip()[-400:]}")
    envelope = json.loads(proc.stdout)
    if envelope.get("is_error"):
        raise RuntimeError(f"claude -p error: {envelope.get('result')}")
    return _normalize(json.loads(_strip_fences(envelope["result"])), qr=qr)


MATCH_PROMPT = """\
A payment reminder was scanned into a document management system. Decide
which open invoice it belongs to — reason about invoice numbers, sender,
amounts (the reminder total usually equals the invoice amount plus a small
dunning fee), and dates. Do not guess: if none clearly matches, say null.

The reminder:
{reminder}

Open invoices:
{candidates}

Output ONLY a JSON object: {{"invoice_id": <id or null>, "reason": "<short>"}}
"""


def match_reminder(cfg, ext, candidates, timeout=120):
    """AI adjudication: which open invoice does this reminder belong to?
    candidates: list of dicts with id, sender_name, invoice_ref, amount,
    due_date, doc_date, title. Returns (invoice_id or None, reason)."""
    if cfg.get("ai_provider") != "claude-cli" or not candidates:
        return None, None
    prompt = MATCH_PROMPT.format(
        reminder=json.dumps({k: ext.get(k) for k in (
            "sender_name", "title", "doc_date", "amount", "currency",
            "due_date", "invoice_ref", "reminder_level", "reminder_fee",
            "refs", "summary_en")}, ensure_ascii=False),
        candidates=json.dumps(candidates, ensure_ascii=False, default=str))
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    try:
        proc = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json",
             "--model", cfg.get("ai_model", "sonnet")],
            capture_output=True, text=True, timeout=timeout, env=env)
        envelope = json.loads(proc.stdout)
        result = json.loads(_strip_fences(envelope["result"]))
        inv_id = result.get("invoice_id")
        if inv_id is not None and any(c["id"] == inv_id for c in candidates):
            return int(inv_id), result.get("reason")
    except Exception:
        pass
    return None, None


REMINDER_WORDS = re.compile(
    r"\b(zahlungserinnerung|mahnung|rappel|sollecito|payment reminder)\b", re.I)
TYPE_WORDS = [
    ("invoice", re.compile(r"\b(rechnung|facture|fattura|invoice)\b", re.I)),
    ("receipt", re.compile(r"\b(quittung|beleg|reçu|ricevuta|receipt)\b", re.I)),
    ("contract", re.compile(r"\b(vertrag|contrat|contratto|contract)\b", re.I)),
    ("statement", re.compile(r"\b(kontoauszug|auszug|relevé|estratto|statement)\b", re.I)),
]
DATE_RES = [
    (re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b"), "dmy"),
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), "ymd"),
]
REF_PATTERNS = [
    ("invoice_no", re.compile(
        r"(?:Rechnungs?[-\s]?(?:Nr|Nummer)|Facture\s?(?:no|n°)|Fattura\s?n\.?|"
        r"Invoice\s?(?:no|number|#))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})", re.I)),
    ("customer_no", re.compile(
        r"(?:Kunden[-\s]?(?:Nr|Nummer)|Client\s?(?:no|n°)|Customer\s?(?:no|number)|"
        r"Debitor[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})", re.I)),
    ("policy_no", re.compile(
        r"(?:Policen?[-\s]?(?:Nr|Nummer)|Police\s?(?:no|n°)?|Policy\s?(?:no|number)|"
        r"Versicherungs[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})", re.I)),
    ("contract_no", re.compile(
        r"(?:Vertrags?[-\s]?(?:Nr|Nummer)|Contrat\s?(?:no|n°)|Contract\s?(?:no|number))"
        r"\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})", re.I)),
    ("case_no", re.compile(
        r"(?:Fall[-\s]?Nr|Schadens?[-\s]?Nr|Dossier\s?(?:no|n°)?|Case\s?(?:no|number))"
        r"\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})", re.I)),
]
AMOUNT_RE = re.compile(
    r"\b(?:CHF|Fr\.?|EUR|€)\s*([\d'’  ]*\d(?:[.,]\d{2}))", re.I)


def extract_heuristic(ocr_text, qr=None):
    """No-AI fallback: keywords + QR data. Good enough to file, not to trust."""
    text = ocr_text or ""
    d = {}
    m = REMINDER_WORDS.search(text)
    if m:
        d["doc_type"] = "reminder"
        lvl = re.search(r"(\d)\s*\.?\s*(?:mahnung|rappel|sollecito)", text, re.I)
        d["reminder_level"] = int(lvl.group(1)) if lvl else 1
    else:
        d["doc_type"] = next((t for t, rx in TYPE_WORDS if rx.search(text)), "other")
    for rx, kind in DATE_RES:
        m = rx.search(text)
        if m:
            try:
                if kind == "dmy":
                    day, mon, yr = map(int, m.groups())
                else:
                    yr, mon, day = map(int, m.groups())
                d["doc_date"] = datetime.date(yr, mon, day).isoformat()
                break
            except ValueError:
                pass
    m = AMOUNT_RE.search(text)
    if m:
        d["amount"] = float(re.sub(r"['’  ]", "", m.group(1)).replace(",", "."))
        d["currency"] = "EUR" if "EUR" in m.group(0).upper() or "€" in m.group(0) else "CHF"
    if qr and qr.get("creditor"):
        d["sender_name"] = qr["creditor"]["name"]
    else:
        # first non-empty line that looks like a name
        for line in text.splitlines():
            line = line.strip()
            if 3 <= len(line) <= 60 and not line[0].isdigit():
                d["sender_name"] = line
                break
    d["sender_key"] = slugify(d.get("sender_name") or "")
    d["title"] = {"invoice": "Rechnung", "reminder": "Mahnung"}.get(
        d["doc_type"], d["doc_type"].capitalize())
    d["tags"] = [d["doc_type"]] if d["doc_type"] != "other" else []
    d["refs"] = [{"kind": kind, "value": m.group(1)}
                 for kind, rx in REF_PATTERNS for m in rx.finditer(text)]
    return _normalize(d, qr=qr)


def extract(cfg, image_paths, ocr_text, qr=None, known_senders=()):
    """-> (extraction dict, provider_used)."""
    if cfg.get("ai_provider") == "claude-cli":
        try:
            return extract_claude_cli(
                image_paths if cfg.get("ai_send_images", True) else [],
                ocr_text, qr=qr, known_senders=known_senders,
                model=cfg.get("ai_model", "sonnet"),
                max_pages=int(cfg.get("ai_max_pages", 4))), "claude-cli"
        except Exception as e:
            import sys
            print(f"ai: claude-cli failed ({e}); falling back to heuristics",
                  file=sys.stderr, flush=True)
    return extract_heuristic(ocr_text, qr=qr), "heuristic"
