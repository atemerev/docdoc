# docdoc — AI document scanning & management platform

Press the scanner's button (or drop paper in the feeder and click Scan) →
the document is scanned, OCR'd into a searchable PDF/A, *understood* by AI
(type, sender, dates, references, amounts), deduplicated, filed into a
browsable archive, and — if it is a (Swiss) invoice — tracked through its
payment lifecycle (QR-bill, due dates, reminders/Mahnungen, fees, paid
state).

Built for a Brother ADS-4300N on Fedora (previously a Canon P-215), but the
pieces are generic: any file or image batch landing in `~/Scans/` feeds the
platform.

## Architecture

One Electron app, no external services. Everything runs in (or is spawned
by) the app's main process; heavy work is native CLI tools as children.

```
scanner button ──► ADS-4300N firmware pushes PDF over SFTP ─┐   (Ethernet,
                                                            │    zero polling)
app Scan button ──► scanimage (SANE airscan / eSCL over USB)┤
                     writes ~/Scans/<stamp>/page-NNN.jpg    │
                                                            ▼
                  in-app watcher (inotify + settle timers)  lib/watcher.js
                     │  lib/pipeline.js:
                     │   QR-bill decode (zbarimg) → img2pdf+OCRmyPDF (PDF/A)
                     │   → AI understanding (local vLLM or claude -p, vision)
                     │   → blank drop / page order → dedup → filing
                     ▼
      /pool/docdoc/  archive/YYYY/date_sender_title_id.pdf
                     docdoc.db (SQLite + FTS5, better-sqlite3 in-process)
                     originals/  thumbs/
                     ▲
                  Electron renderer (sandboxed pure UI, pdf.js preview)
```

The app lives in the tray: closing the window keeps scanning/processing
alive, and a login autostart entry (`~/.config/autostart/docdoc.desktop`,
created on first run) makes button scans work without opening anything.
System dependencies (spawned as CLIs): `tesseract` + tessdata_best,
`ocrmypdf`, `img2pdf`, `qpdf`, `poppler-utils` (pdftoppm), `zbar`
(zbarimg), `qrencode`, `sane-airscan` + `ipp-usb`.

## Daily use

- **Scan**: load sheets face down, top edge first, press the scanner's
  Network Device Scan Button (after the one-time setup below) — or click
  Scan in the app. A desktop notification announces the filed document;
  it appears in the app's **Inbox** for review (AI fills everything in;
  you confirm or fix — that's what marks it reviewed).
- **App**: `cd ~/devel/docdoc/app && npx electron .` (or the autostart
  tray instance).
- **Find anything**: the search box covers full OCR text, titles, senders,
  tags, references, with prefix search as you type (`zür` finds Zürich).
- **Invoices**: dashboard shows open/overdue totals. "Pay by QR" renders
  the Swiss QR (with the amount updated for reminder fees) to scan with a
  banking app. "Mark paid" asks for the paying bank account and value
  date and settles the whole reminder chain; "Do not pay" closes invoices
  settled elsewhere, with a comment.
- **Timeline & links**: every document shows its dated history (own date,
  scan date, due dates, reminders, payments) and documents linked by
  shared internal references (invoice/policy/customer/case numbers).

## Scanner button setup (one-time, zero polling)

The ADS-4300N's three **Network Device Scan Buttons** work entirely in
firmware over the network — no daemon watches the paper sensor. See
RESEARCH.md "Zero-polling button scanning" for the findings.

**No router needed**: the scanner plugs **directly into the PC's spare
Ethernet port** (enp36s0f0). A NetworkManager shared-mode profile
(`docdoc-scanner`) is pre-configured: on link-up the PC becomes
10.42.0.1/24 with DHCP, and the scanner picks an address automatically.
Just run a cable scanner-LAN → PC port.

Two button transports (USB stays connected in parallel for the app's own
Scan button via scanimage/eSCL):

- **WS Scan (preferred, true push)** — the same open Microsoft WSD
  protocol Windows uses driverlessly: docdoc registers as a scan
  destination via WS-Eventing, appears by name on the scanner's panel,
  and receives a ScanAvailableEvent when the button is pressed
  (implementation pending — needs the cable connected to test against
  the real firmware).
- **Scan to SFTP (fallback)** — firmware pushes a multipage PDF: keep an
  **RSA host key** enabled in sshd (the Brother SFTP client doesn't
  speak ed25519), chroot a `scan` user at `~/Scans`, and configure the
  profile in Web Based Management (`https://10.42.0.x`) → Scan → Scan to
  Network Device → Button 1. The watcher picks the PDF up via inotify.

## Storage layout (`/pool/docdoc`, symlinked as `~/DocDoc`)

- `archive/YYYY/<date>_<sender>_<title>_<id>.pdf` — searchable PDF/A,
  human-browsable without the app
- `docdoc.db` — SQLite (documents, pages, senders, invoices, bank
  accounts, doc_refs, events + FTS5 index)
- `originals/<batch>/` — raw scanner pages (kept by default; Settings)
- `thumbs/`, `failed/`, `tessdata/` (tessdata_best OCR models)
- `vllm/`, `hf/` — local AI serving venv + model weights (optional)

## AI understanding

Two providers (Settings → AI provider):

- `local-vllm`: an OpenAI-compatible endpoint (default
  `http://localhost:8000/v1`), e.g. vLLM serving **Qwen3-VL** on this
  machine's GPUs — benchmarked in RESEARCH.md at ~6 s/document fully
  offline. Structured outputs (json_schema) enforce the extraction shape.
  Falls back to claude-cli, then heuristics, when the server is down.
- `claude-cli`: headless `claude -p` with vision (the cloud path).

Either way the model **reads the page images** plus OCR text and QR data,
and returns document type, sender (canonical key reused across scans),
title, language, dates, amounts, internal references, mentioned dates,
correct page order, summary and tags. Reminders are matched to their
original invoice deterministically (QR reference / invoice number) and by
AI adjudication otherwise. Regex heuristics exist only as a degraded
no-AI fallback (`ai_provider: "none"`).

Note: the app strips `ANTHROPIC_API_KEY` from the environment when
calling `claude` — the login profile exports a zero-credit key that would
otherwise shadow the claude.ai subscription.

## Swiss invoice handling

- Swiss QR-bill (SPC v2.2/v2.3) parsed and validated: QR-IBAN vs IBAN,
  QRR mod-10 / SCOR mod-97 references, Swico S1 billing info — including
  `/40/` payment terms → due date; `0.00` notification bills are never
  marked payable.
- No QR? Due date comes from the AI ("zahlbar innert 30 Tagen" → date), or
  the 30-day Swiss convention as fallback.
- Reminders (Zahlungserinnerung / N. Mahnung / rappel / sollecito) link to
  the original invoice, raise its amount due by the Mahngebühr, move the
  due date, and set status `reminded`. Paying any chain member settles all.

## Testing

`cd app && npm test` — four suites, run under Electron's Node runtime
(better-sqlite3 is built for Electron's ABI):

- `tests/test_qrbill.js` — QR-bill parser round trip through real QR images
- `tests/test_invoices.js` — invoice chains, bank accounts, IBAN checks
- `tests/test_blank.js` — blank-backside detection with synthetic ADF artifacts
- `tests/test_pipeline.js` — full pipeline e2e on synthetic fixtures
  (`tests/make_fixtures.js`), isolated temp data root

`DOCDOC_SHOT=/tmp/x.png npx electron .` — app screenshot for debugging.

## Known quirks

- ADS-4300N: driverless on Linux — `ipp-usb` publishes the USB device's
  eSCL interface on `localhost:60000`, `sane-airscan` scans through it
  (Brother's brscan5 does *not* support the ADS-4xxx generation). eSCL
  has no events, so USB cannot signal buttons — hence the Ethernet
  SFTP-push flow above. The scanner pads images to the requested window
  instead of clipping at page end, so scans always pass `-x/-y` (A4).
- Native Node modules under Electron on Linux: better-sqlite3 needs
  `electron-rebuild` (wired into `npm install`); sharp segfaults and is
  deliberately NOT used — image math is pure JS (jpeg-js/pngjs).
- `/home` is nearly full — that's why everything lives on `/pool`.
- OCR models: tessdata_best in `/pool/docdoc/tessdata` (Fedora's langpacks
  are the less accurate "fast" ones); `configs/` symlink must exist there.

The original Python implementation (pipeline + daemons + stdio server)
lives in git history up to tag `python-final` and in
`/pool/docdoc/backup-pre-js-port-20260720.tar.gz`.

See `RESEARCH.md` for the research this design is based on, and
`FEATURES.md` for the roadmap.
