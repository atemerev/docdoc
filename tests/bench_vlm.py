#!/usr/bin/python3
"""Benchmark a local OpenAI-compatible VLM (vLLM) against the stored
claude extractions on this machine's real documents.

Reads the live DB read-only, writes nothing to it. Mirrors production
inputs: first 4 page images from originals/<batch> + OCR text + QR
context + known sender keys, same PROMPT as ai.py (image paths replaced
by attached images).

Run: /usr/bin/python3 tests/bench_vlm.py [--url http://localhost:8000/v1]
     [--max-docs N] [--guided]
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from docdoc import ai, config, db, pipeline  # noqa: E402


def img_part(path):
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return {"type": "image_url",
            "image_url": {"url": "data:image/jpeg;base64," + b64}}


def api_call(url, payload, timeout=600):
    req = urllib.request.Request(
        url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r), time.time() - t0


def get_model(url):
    with urllib.request.urlopen(url.rstrip("/") + "/models", timeout=10) as r:
        return json.load(r)["data"][0]["id"]


def qr_dict(con, doc_id):
    """Reconstruct the qr context dict production passed to the AI."""
    inv = con.execute("SELECT * FROM invoices WHERE document_id=?",
                      (doc_id,)).fetchone()
    if not inv or not inv["qr_payload"]:
        return None
    return {
        "iban": inv["qr_iban"], "ref_type": inv["qr_ref_type"],
        "reference": inv["qr_reference"],
        "creditor": json.loads(inv["qr_creditor"]) if inv["qr_creditor"] else None,
        "amount": inv["amount"], "currency": inv["currency"],
        "is_notification": bool(inv["is_notification"]),
        "swico": json.loads(inv["swico"]) if inv["swico"] else None,
        "payload": inv["qr_payload"],
    }


def build_messages(cfg, con, doc, senders):
    images_dir = os.path.join(cfg["data_root"], "originals", doc["batch"])
    images = sorted(pipeline.batch_images(images_dir))[:4]
    qr = qr_dict(con, doc["id"])
    sender_ctx = ("- Known sender keys (reuse when the same organization): "
                  + ", ".join(sorted(senders)[:80]) + "\n") if senders else ""
    prompt = ai.PROMPT.format(
        image_list="  (attached below, in scan order)",
        ocr_text=(doc["content"] or "")[:6000],
        qr_context=ai._qr_context(qr),
        sender_context=sender_ctx,
        doc_types="|".join(ai.DOC_TYPES),
        ref_kinds="|".join(ai.REF_KINDS),
        n_pages=len(images),
    )
    content = [{"type": "text", "text": prompt}] + [img_part(p) for p in images]
    return [{"role": "user", "content": content}], qr, len(images)


def compare(local, doc, inv, claude):
    """Score the local extraction against reviewed DB values (reference)
    and note disagreements with claude's stored extraction."""
    rows = []

    def row(field, ref, got, ok):
        rows.append((field, ok, ref, got))

    row("doc_type", doc["doc_type"], local["doc_type"],
        local["doc_type"] == doc["doc_type"])
    ref_s = (doc["sender_name"] or "").lower()
    got_s = (local["sender_name"] or "").lower()
    row("sender", doc["sender_name"], local["sender_name"],
        bool(ref_s) and (ref_s in got_s or got_s in ref_s
                         or ai.slugify(got_s)[:12] == ai.slugify(ref_s)[:12]))
    row("doc_date", doc["doc_date"], local["doc_date"],
        local["doc_date"] == doc["doc_date"])
    row("language", claude.get("language"), local["language"],
        local["language"] == claude.get("language"))
    if inv:
        row("amount", inv["amount"], local["amount"],
            local["amount"] is not None and inv["amount"] is not None
            and abs(local["amount"] - inv["amount"]) < 0.01)
        row("due_date", inv["due_date"], local["due_date"],
            local["due_date"] == inv["due_date"])
        row("reminder_level", inv["reminder_level"], local["reminder_level"],
            local["reminder_level"] == inv["reminder_level"])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000/v1")
    ap.add_argument("--max-docs", type=int, default=99)
    ap.add_argument("--guided", action="store_true",
                    help="use vLLM structured outputs (json_object)")
    args = ap.parse_args()

    cfg = config.load()
    con = db.connect()
    model = get_model(args.url)
    print(f"model: {model}\n")

    senders = [r["key"] for r in con.execute("SELECT key FROM senders")]
    docs = con.execute(
        """SELECT * FROM documents WHERE status!='trash'
           AND ai_json IS NOT NULL AND batch IS NOT NULL
           ORDER BY id""").fetchall()
    docs = [d for d in docs if os.path.isdir(
        os.path.join(cfg["data_root"], "originals", d["batch"]))][:args.max_docs]
    print(f"{len(docs)} documents with stored claude extraction + originals\n")

    # warmup (compile/caches) on the first doc, untimed in the report
    msgs, _, _ = build_messages(cfg, con, docs[0], senders)
    payload = {"model": model, "messages": msgs, "max_tokens": 2000,
               "temperature": 0}
    if args.guided:
        payload["response_format"] = {"type": "json_object"}
    print("warmup...", flush=True)
    _, warm_t = api_call(args.url, payload)
    print(f"warmup done in {warm_t:.1f}s\n")

    results, total_t, field_ok, field_n = [], 0.0, 0, 0
    for d in docs:
        claude = json.loads(d["ai_json"])
        inv = con.execute("SELECT * FROM invoices WHERE document_id=?",
                          (d["id"],)).fetchone()
        msgs, qr, n_img = build_messages(cfg, con, d, senders)
        payload = {"model": model, "messages": msgs, "max_tokens": 2000,
                   "temperature": 0}
        if args.guided:
            payload["response_format"] = {"type": "json_object"}
        try:
            out, dt = api_call(args.url, payload)
        except Exception as e:
            print(f"#{d['id']}: FAILED {e}")
            continue
        total_t += dt
        usage = out.get("usage", {})
        raw = out["choices"][0]["message"]["content"]
        try:
            local = ai._normalize(json.loads(ai._strip_fences(raw)), qr=qr)
        except Exception as e:
            print(f"#{d['id']}: JSON parse failed: {e}\n  raw: {raw[:200]}")
            continue

        rows = compare(local, d, inv, claude)
        ok = sum(1 for _, o, _, _ in rows if o)
        field_ok += ok
        field_n += len(rows)
        # reference-number recall (what links related docs together)
        want = {r["norm"] for r in con.execute(
            "SELECT norm FROM doc_refs WHERE document_id=?", (d["id"],))}
        got = {db.norm_ref(r["value"]) for r in local["refs"]}
        rec = f"{len(want & got)}/{len(want)}" if want else "-"

        print(f"#{d['id']} [{d['doc_type']}] {n_img} img "
              f"{dt:6.2f}s  ptok={usage.get('prompt_tokens')} "
              f"ctok={usage.get('completion_tokens')}  "
              f"fields {ok}/{len(rows)}  refs {rec}")
        for f, o, ref, got_v in rows:
            if not o:
                print(f"     ✗ {f}: ref={ref!r} got={got_v!r}")
        results.append({
            "id": d["id"], "secs": round(dt, 2), "images": n_img,
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "fields_ok": ok, "fields_total": len(rows),
            "ref_recall": rec, "local": local, "claude": claude,
        })

    n = len(results)
    print(f"\n=== {model} ===")
    print(f"docs: {n}  avg {total_t/max(n,1):.2f}s/doc  "
          f"(min {min(r['secs'] for r in results):.2f} "
          f"max {max(r['secs'] for r in results):.2f})")
    print(f"field accuracy vs reviewed DB: {field_ok}/{field_n} "
          f"({100*field_ok/max(field_n,1):.0f}%)")
    outp = f"/pool/docdoc/vllm/bench-{model.replace('/', '_')}.json"
    with open(outp, "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1, default=str)
    print(f"saved {outp}")


if __name__ == "__main__":
    main()
