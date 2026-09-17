# docdoc

A scanner app with page review, a processing queue, and a local, single-file archive.

Scan or import a set, review the pages, then press **Done** to put it in the queue.
OCR and document understanding run in the background while you scan the next set.
Review a ready document and explicitly **Save to Library**.
Closing the window stops work and quits; unfinished queued work resumes on reopening.
There is no tray, login autostart, folder watcher, or automatic scanner retry.

## Use

```sh
cd app
npm install
npm start
```

- **Scan pages** runs one A4, color, 300 dpi duplex batch through SANE. A jam,
  cancellation, or feeder error preserves captured source files and warns about
  completeness. The app never retries the feeder automatically.
- **Import** accepts PDFs, JPEGs, PNGs, TIFFs and PNM images. Originals are committed
  to SQLite before preparation or OCR. Failed imports remain in page review; use
  **Prepare pages / retry** to prepare them again.
- After capture, a progress panel shows preparation and blank removal. This stage
  does not run OCR. **Stop** keeps captured originals and does not cancel another
  set’s background processing. An interrupted blank check must finish before Done.
- Title, sender, type and date are filled from recognized headings, text and QR-bill
  data. Existing senders are matched by normalized names, unique shortened names,
  and creditor identity before a sender is created. Canonical spelling is retained;
  ambiguous shortened names are not merged automatically. The sender field also
  suggests existing entries. Edits are kept in SQLite and survive rereading.
- **Pursuit** is a separate type, including payment orders, seizure notices and
  debt certificates. Pursuit, ADB/debt-certificate, office, case, claim and invoice
  references retain their types and source evidence. Matching compares normalized
  references of the same type; sharing a case does not make papers duplicates.
  Pursuit parties and the printed claim, interest, fees and outstanding total are
  shown separately. A payment QR or a quoted invoice does not change this category.
- **Dates** have explicit roles: capture/import time, document date, case initiation
  (only when stated), execution, covering letter, underlying claim, birth and other
  mentioned dates. Named months are recognized alongside numeric dates. Birthdays
  and referenced invoices are not pursuit issue dates. For a cover plus an attached
  debt certificate, the certificate's issue date is used and the covering date kept.
  Ambiguous issue dates stay empty rather than silently selecting the first date.
  Expand **Dates found in the document** to inspect the evidence.
- **Page review** shows thumbnails and full-size previews before OCR. Rearrange or
  remove pages, move them between sets, and insert another scan or imported file
  at the beginning, middle, or end. Blank backsides are checked from their images
  before OCR, excluded automatically, and tucked under **Show removed blank pages**.
  Edge shadows, registration blocks, light folds and isolated dust are ignored;
  sparse text, faint writing and photos remain. **Restore page** overrides removal
  and survives retries. Removed pages and originals remain recoverable in SQLite.
- **Done** sends the set to the persistent **Processing queue** in the sidebar.
  You can immediately scan another set, view Library, or review queue documents.
  The queue reads included pages, extracts metadata, classifies documents, finds
  typed references, possible duplicates and related documents, then marks the
  result **Ready to review**. Newly added pages are recognized without rereading
  already processed pages. **Read pages again** explicitly rereads the whole set.
- Queue progress stays visible in the sidebar while scanning or browsing Library.
  It shows the current stage, elapsed time, pages read, and waiting/ready counts.
  Open the working set to see page badges for waiting, reading and checking.
  PaddleOCR reports actual completed pages, including native PDF pages read out of
  order; stages without measurable progress show an activity bar.
- Mixed sets separate into documents automatically before metadata extraction.
  The configured document model uses page text, subjects, dates, references and
  continuity, with an exhaustive page assignment and checked source excerpts.
  With OCR-only mode, or if the model fails, local rules use document identities,
  printed numbering restarts and distinct letter subjects/dates; a model failure
  leaves a visible note. Shared customer/case references alone do not establish
  that pages are one document. Split children continue through the queue without
  rereading their pages. Consistent printed page markers order each document.
  Explicit page order and manual moves between sets override automatic collation.
  Automatic splits carry a visible note to check the grouping. Missing/repeated
  page numbers and duplicate hints remain advisory.
- Metadata can be edited while a queue item is processing; manual corrections
  survive completion. **Edit pages / add scans** pauses that item for page review;
  press Done to resume. A failed item shows its error and offers retry, while the
  queue continues with other items. Closing docdoc stops active work, keeps queued
  sets, and resumes them the next time the app opens. Ready items stay ready.
- **Save to Library** files the reviewed document with its searchable, enriched
  PDF. Raw scans and ready queue items stay out of Library until this step.
  **Library** searches titles, senders, tags and OCR text with SQLite FTS5. Use
  **Group related documents** to see clusters and the references/links connecting
  them, or use the flat list sorted by **Document date** or **Scan date**.
- In Library, open a document and expand **Edit metadata** to correct its details.
  **Review / add pages** opens its saved pages without OCR and retains the same
  Library ID when saved again. Original sources and prior reviewed PDFs remain in
  SQLite; expand **Original scans and previous versions** to recover their pages.

- **Save PDF as…** is the only export control, available in Review and Library.
  The archived PDF is already enriched; exporting is not required to add metadata.
  It carries title, author/sender, subject, keywords, XMP with separate document,
  scan and case dates, full OCR, and embedded `recognized-text.txt` and
  `metadata.json` with references, provenance and metadata history. PDFs contain
  only included pages. Invoice/payment records and Swiss QR display remain in the
  document details. Originals remain unchanged in SQLite.

## Document understanding

**Settings → Document understanding** offers a local model server (the default),
Claude Haiku through the existing Claude CLI sign-in, or local OCR only.
For a local server enter its API address, press **Find models**, select a model,
and save settings. Common addresses are `http://127.0.0.1:8080/v1` for llama.cpp,
`http://127.0.0.1:11434/v1` for Ollama, and `http://127.0.0.1:8000/v1` for vLLM.
The server must support `/models` and schema-constrained `/chat/completions`.
For example, run an installed llama.cpp server in a terminal:

```sh
CUDA_VISIBLE_DEVICES=1 llama-server \
  -m /pool/docdoc/models/Qwen3.8-27B-UD-Q4_K_M.gguf --alias docdoc-qwen3.8-27b \
  --host 127.0.0.1 --port 8080 -c 16384 -ngl all --parallel 1 --reasoning off
```

The configured local model is **Qwen3.8-27B**, using the Unsloth Q4 GGUF quantization of the official Qwen model. Its weights occupy about 16 GB. The server stays in the terminal where it was started; no login service is installed. Select `docdoc-qwen3.8-27b` in Settings.

The model reads all included pages' OCR text and returns a strict JSON schema:
title, sender, category, dated events, typed identifiers, case handler and direct
contacts, plus pursuit parties and amounts. The app validates the schema and
checks cited text against its source page before accepting references, contacts
and dates. Scan time is never supplied by the model. Existing sender names are
resolved locally before saving. Outputs remain suggestions to review.

Recognition runs after OCR in the processing queue while the app is open. Results
are stored in SQLite and reused when viewing or saving. Moving, excluding or
reordering pages invalidates old suggestions; **Recognize details again** queues
metadata extraction from the current OCR without rescanning. Failed or incomplete model
responses produce an explicit local-fallback notice. Local-server failures never
send documents to Claude; cloud use requires selecting that provider in Settings.

The app does not start a model server or enable a login service. Without one it
still scans, collates and files documents using basic local suggestions. Model
weights and runtime software are replaceable dependencies outside the archive;
documents, metadata and settings remain in the single backup file. Search uses
SQLite FTS5 without a separate vector database.

Protocols: [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md),
[Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs),
[Claude CLI structured output](https://code.claude.com/docs/en/cli-usage).

## Local text recognition

The default OCR engine is **PaddleOCR-VL 1.6** with PP-DocLayoutV3, running locally
through Transformers. It is the current PaddleOCR document model (May 2026),
whose authors report 96.3% on OmniDocBench v1.6. Benchmark leadership is not a
guarantee for every handwriting sample; review remains part of the workflow.
[PaddleOCR model and benchmarks](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6).

The app starts one OCR worker when reading pages and releases its GPU memory when
it exits. PaddleOCR processes up to four pages together on GPU (two on CPU), using
in-memory images and bounded CPU preprocessing. Existing native PDF text bypasses
model loading. Tesseract uses up to eight available CPU workers. Blank and manually
removed pages never enter either OCR engine; original page order and restore
choices are retained. It adds invisible Unicode text to the detected page regions and keeps
source images intact. **Read pages again** queues the originals for another OCR pass; existing
visible digital text is preserved, while old invisible OCR is replaced. PaddleOCR
updates page counts and individual page states as each batch completes; Tesseract
shows activity until it returns its results. A failure stays visible for retry and never
silently switches to a different OCR engine. Tesseract remains an explicit,
lighter option in Settings.

Install the replaceable runtime (Python 3.12 and `uv`):

```sh
uv venv /pool/docdoc/ocr-venv
uv pip install --python /pool/docdoc/ocr-venv/bin/python -r app/python/requirements-ocr.txt
python3 -m pip install pymupdf
```

Settings → OCR runtime selects the Python executable and device (`gpu:2` on this
machine, or `cpu`). Models cache under `/pool/docdoc/ocr-cache`; these downloaded
weights and the Python environment do not need to be backed up with documents.
The initial download needs a network connection; recognition itself is local.
PDF export uses system Python with PyMuPDF. Model source: [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B).

## USB scanner

The connected Brother ADS-4300N is exposed to SANE by `sane-airscan` and the system
`ipp-usb` USB driver bridge. This small system component is still necessary for
this model's driverless USB interface. Docdoc does not start or manage it and
never polls the device while idle. Discovery happens only for **Scan pages** or
**Settings → Find scanner**. Other SANE devices must support the configured scan
options; the current profile is tested against the ADS-4300N.

Native dependencies: `sane-backends` (`scanimage`), `sane-airscan`, `ipp-usb`,
`img2pdf`, `ocrmypdf`, `tesseract`, `qpdf`, Poppler (`pdftoppm`, `pdftotext`),
`zbar` (`zbarimg`), and `qrencode`. OCR languages default to `deu+fra+ita+eng`.
The existing `/pool/docdoc/tessdata` models are used when present, otherwise
Tesseract's installed language data is used. Models and installed software are
runtime dependencies and are not part of document backups.

## One database to back up

Default file: **`/pool/docdoc/docdoc.db`**. Settings shows the exact active path.
Use `DOCDOC_DB=/absolute/path/my-documents.db` to open a different database.

The database contains metadata, searchable text, PDFs, original source files,
excluded pages, thumbnails, unfinished imports/groups and queue states, review notes, links,
PDF revision history, and settings. Identical bytes share a SHA-256-addressed
BLOB. SQLite uses rollback journaling and FULL synchronous commits; a temporary
`-journal` may exist during a transaction, but is not a separate archive file.

**Backup while open:** Settings → Back up database uses SQLite's online backup API
and writes one consistent `.db` file. Choose a new filename. **Backup while closed:**
copy the database normally. **Restore:** quit docdoc, retain a copy of the current
database, replace it with the backup, and reopen. Or set `DOCDOC_DB` to the backup
path. No archive/original/thumb folders are needed for a restored database.

Temporary OCR files and exported previews use the OS temporary directory and are
removed after normal operations/exit. Originals remain in SQLite on cancellation;
an OS/power failure during an active scan can interrupt a not-yet-captured page.

Metadata uses two time axes in the same SQLite file. `scanned_at` records capture
or import and is independent of filing time and OCR. Each metadata interpretation
has a valid interval (`valid_from` is the document date; no end is invented) and a
recorded interval (`recorded_from` inclusive, `recorded_to` exclusive). Corrections
close the recorded interval and append a complete snapshot including references.
**Metadata history** shows those corrections; `metadata_as_of` accepts `known_at`
and optional `effective_on` for reconstruction. Unknown valid dates remain null.
Old installations did not retain exact capture timestamps, so their saved time is
explicitly labeled **Scan recorded (legacy)**. The first observed legacy metadata
is snapshotted at migration time; earlier system-time history is not fabricated.

## Existing installations

On first launch, migration copies the old PDFs, thumbnails, originals and failed
files into SQLite in one transaction. It creates `docdoc-before-single-file.db`
first and leaves the original folders untouched as a recovery copy. A missing
referenced PDF fails migration rather than silently omitting a document. Migration
is idempotent. Old unreviewed/pending documents stay visible in Library; choose
**Review / add pages** to amend or delete them. Old folders may be moved out of
the active data directory after verifying the new database and making a backup.

The app removes its own former `~/.config/autostart/docdoc.desktop` entry. Quit the
old hidden/tray instance before launching the new version; only one instance may
own the database. Files left in the old `~/Scans` folder can be imported explicitly.

## Development and validation

TypeScript/Electron main process, one SQLite connection, sandboxed renderer, no
HTTP API server. The renderer is vanilla TypeScript/CSS; PDF.js is loaded on demand
and renders one preview page at a time. Foreground operations and the sequential processing queue have independent
cancellation scopes. Closing the window terminates their tracked process groups,
waits for capture persistence, returns the active queue item to Waiting, closes
SQLite, then exits.

```sh
cd app
npm run build
npm test
npm run test:ui
```

Tests use isolated databases and synthetic scans, real OCR/PDF/QR tools, and cover
invoice records, blank detection, legacy migration, interrupted imports, page
insertion and grouping across scans, blank exclusion before OCR, concurrent capture,
scoped cancellation, queue failure/retry and restart resume, splitting/collation,
Library grouping/date sorts, explicit saving, and revision/backup restoration. `rsvg-convert` is needed for synthetic test pages.

For an isolated visual check:

```sh
DOCDOC_DB=/tmp/docdoc-demo/docdoc.db DOCDOC_SHOT=/tmp/docdoc.png \
DOCDOC_EXIT_AFTER_SHOT=1 app/node_modules/.bin/electron app
```

`RESEARCH.md` records the previous architecture's research; it is historical,
not the current operating instructions.
