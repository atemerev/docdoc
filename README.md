# docdoc — AI document scanning & management platform

Drop paper in the scanner → the document is scanned, OCR'd into a searchable
PDF/A, *understood* by AI (type, sender, dates, references, amounts),
deduplicated, filed into a browsable archive, and — if it is a (Swiss)
invoice — tracked through its payment lifecycle (QR-bill, due dates,
reminders/Mahnungen, fees, paid state).

Built for a Brother ADS-4300N on Fedora (previously a Canon P-215), but the
pieces are generic: anything that drops page images into `~/Scans/<batch>/`
feeds the platform.

## Architecture

```
paper inserted ──► scan_buttond (SANE airscan)  systemd user service
                     │  writes ~/Scans/<stamp>/page-NNN.jpg + .batch-done
                     ▼
                  docdocd watcher               systemd user service
                     │  docdoc/pipeline.py:
                     │   QR-bill decode → img2pdf+OCRmyPDF (PDF/A + text)
                     │   → AI understanding (claude -p, vision)
                     │   → blank drop / page order → dedup → filing
                     ▼
      /pool/docdoc/  archive/YYYY/date_sender_title_id.pdf
                     docdoc.db (SQLite + FTS5)   originals/  thumbs/
                     ▲
                     │ JSON-lines stdio (docdoc/server.py)
                  Electron app (app/)           UI: inbox, search, invoices,
                                                senders, timeline, settings
```

All data work is Python (`docdoc/` package, system Python 3.14 —
`/usr/bin/python3`, because RPM deps live there). The Electron renderer is
sandboxed pure UI; the main process spawns the Python API server and
proxies over IPC. PDFs render in-app via bundled pdf.js.

## Daily use

- **Scan**: load sheets face down, top edge first — scanning starts by
  itself a few seconds later (the ADS-4300N has no Linux-visible button;
  the app's Scan button also works). A desktop notification announces the
  filed document; it appears in the app's **Inbox** for review (AI fills
  everything in; you confirm or fix — that's what marks it reviewed).
- **App**: `cd ~/devel/docdoc/app && npx electron .`
- **Find anything**: the search box covers full OCR text, titles, senders,
  tags, references, with prefix search as you type (`zür` finds Zürich).
- **Invoices**: dashboard shows open/overdue totals. "Pay by QR" renders
  the Swiss QR (with the amount updated for reminder fees) to scan with a
  banking app. "Mark paid" settles the whole reminder chain.
- **Timeline & links**: every document shows its dated history (own date,
  scan date, due dates, reminders, payments) and documents linked by
  shared internal references (invoice/policy/customer/case numbers).

## Services

| unit | role | logs |
|---|---|---|
| `scan-buttond` | paper inserted → batch of JPEGs | `journalctl --user -u scan-buttond -f` |
| `docdocd` | batch → processed document | `journalctl --user -u docdocd -f` |

Both are systemd **user** services (`systemctl --user restart docdocd`…).
For operation before login: `loginctl enable-linger aryeh`.

## Storage layout (`/pool/docdoc`, symlinked as `~/DocDoc`)

- `archive/YYYY/<date>_<sender>_<title>_<id>.pdf` — searchable PDF/A,
  human-browsable without the app
- `docdoc.db` — SQLite (documents, pages, senders, invoices, doc_refs,
  events + FTS5 index)
- `originals/<batch>/` — raw scanner JPEGs (kept by default; Settings)
- `thumbs/`, `failed/`, `tessdata/` (tessdata_best OCR models)

## Configuration

- `~/.config/docdoc/config.json` — pipeline + app settings (editable in
  the app's Settings page): AI provider/model, OCR languages, scans dir,
  originals retention, default payment term.
- `~/.config/docdoc-scan.conf` — scanner settings (duplex, dpi, format,
  page size, auto-scan on paper insert).

## AI understanding

Default provider is `claude-cli`: headless `claude -p`, which **reads the
page images** (vision) plus OCR text and QR data, and returns document
type, sender (canonical key reused across scans), title, language, dates,
amounts, internal references, mentioned dates, correct page order, summary
and tags. Reminders are matched to their original invoice deterministically
(QR reference / invoice number) and by AI adjudication otherwise. Regex
heuristics exist only as a degraded no-AI fallback (`ai_provider: "none"`).

Note: the daemon strips `ANTHROPIC_API_KEY` from the environment when
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

- `tests/test_qrbill.py` — QR-bill parser round trip (real QR images)
- `tests/make_fixtures.py`, `tests/make_fixture2.py` — synthetic Swiss
  invoice / Mahnung / phone-bill scans for pipeline e2e tests
- `systemctl --user kill -s USR1 scan-buttond` — trigger a scan manually
- `DOCDOC_SHOT=/tmp/x.png npx electron .` — app screenshot for debugging

## Known quirks

- ADS-4300N: driverless on Linux — `ipp-usb` publishes the USB device's
  eSCL interface on `localhost:60000`, `sane-airscan` scans through it
  (Brother's brscan5 does *not* support the ADS-4xxx generation). No
  button events either, hence auto-scan on paper insert; feeder state
  comes from polling `/eSCL/ScannerStatus`. The scanner pads images to
  the requested window instead of clipping at page end, so scan_buttond
  always passes `-x/-y` (PAGE_WIDTH/PAGE_HEIGHT, default A4).
- `/home` is nearly full — that's why everything lives on `/pool`.
- OCR models: tessdata_best in `/pool/docdoc/tessdata` (Fedora's langpacks
  are the less accurate "fast" ones); `configs/` symlink must exist there.

See `RESEARCH.md` for the research this design is based on, and
`FEATURES.md` for the roadmap.
