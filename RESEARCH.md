# docdoc research notes (2026-07-06)

Groundwork for the AI document-management platform. Local experiments first;
web research on OCR engines, Swiss QR-bill, and prior art follows.

## Local environment findings (verified on this machine)

### Hardware
- 4× NVIDIA RTX 4090 (24 GB each, 96 GB VRAM total), Threadripper PRO 3975WX
  (32c/64t), 251 GB RAM → local GPU OCR/VLM models are fully viable.
- **Disk: `/home` (btrfs, 930 GB) is 100 % full — 4.4 GB free.**
  `/pool` (ext4, 15 TB) has 2.4 TB free and holds the user's big data.
  → Document archive, DB, and any model weights must live under `/pool/docdoc`
  (symlink `~/DocDoc` for convenience). node_modules for the app is small
  enough for /home but worth watching.

### Baseline OCR quality (tesseract 5 via ocrmypdf, deu+fra+ita+eng)
Test doc: real duplex scan (mystore.ch return slip, 300 dpi).
- Clean printed text: good.
- Noisy zones (dotted lines, stamps): garbage strings emitted
  ("RUOLI I ESS AS SS SL PAS A A OR SR RIRE…").
- Mixed-language page: mostly fine with multi-lang model.
- ocrmypdf pipeline works: img2pdf → ocrmypdf --rotate-pages --deskew
  --sidecar; produces searchable PDF + text. ~5 s/page CPU.

### Barcode/QR decode
- `zbarimg --raw` decodes the 1D barcodes on the test doc fine
  (return-slip tracking codes). QR decode path ready for Swiss QR-bills.

### Headless Claude as vision extractor (validated end-to-end)
- **Gotcha:** login profile sets `ANTHROPIC_API_KEY` pointing at a
  zero-credit API account, which overrides the claude.ai subscription in
  `claude -p` ("Credit balance is too low"). Fix: run
  `env -u ANTHROPIC_API_KEY claude -p …`.
- `claude -p "<prompt>" --allowedTools Read --output-format json --model sonnet`
  reads a page **image** directly and returns clean metadata JSON:
  correctly classified the return slip, sender mystore.ch, recipient,
  invoice ref B94F0C2D0555, tags. ~10 s/page.
- Output arrives wrapped in ```json fences despite instructions → parser
  must strip fences.
- Correctly identified the blank duplex back side of page 1 (blank-page
  detection matters).

## Web research

### Swiss QR-bill (parser implementation reference)

Sources: SIX *Implementation Guidelines QR-bill* v2.3 (in force since Nov 2025),
Swico S1 syntax v1.2, IG v2.4 announcement (Feb 2026).

**Version status:** payload `Version` field is `0200` for ALL of v2.0–v2.4 —
you cannot detect spec version from the payload. v2.3 removed combined
address type "K" (structured "S" only), but a parser for scanned archives
**must accept both S and K** (pre-Nov-2025 paper is everywhere). v2.4
(Nov 2026): EUR bills only IBAN+SCOR/NON; no CHF change.

**SPC payload layout** — UTF-8, split `\r?\n`, min 31 / max 34 lines,
≤997 chars total; no trailing newline:

| Line | Field | Notes |
|---|---|---|
| 1–3 | `SPC` / `0200` / `1` | header, validate fixed values |
| 4 | IBAN | 21 chars, CH/LI only, ISO 13616 mod-97 == 1 |
| 5–11 | Creditor | AdrTp(S\|K), Name≤70, Strt/AdrLine1≤70, Bldg/AdrLine2≤16 or ≤70(K), PstCd≤16, Town≤35 (both empty for K), Country ISO-2 |
| 12–18 | UltmtCdtr | 7 empty lines (tolerate content from old emitters) |
| 19 | Amount | 0.01–999999999.99, 2 decimals, empty allowed (payer fills); **`0.00` = notification, never propose payment** |
| 20 | Currency | `CHF` or `EUR` only |
| 21–27 | Debtor ("payable by") | same 7-line structure as creditor; may be all empty |
| 28 | RefType | `QRR` \| `SCOR` \| `NON` |
| 29 | Reference | QRR: exactly 27 digits; SCOR: `RF` + 2 check + ≤21 alnum; NON: empty |
| 30 | Unstructured msg | ≤140 (shared budget with line 32) |
| 31 | `EPD` | trailer, end-of-payment-data anchor |
| 32 | Billing info | `//S1/...` Swico tags (absent if unused) |
| 33–34 | Alt. procedures | e.g. `eBill...` (absent if unused) |

**Cross-rule (mandatory reader check):** IID = IBAN chars 5–9;
30000–31999 ⇒ QR-IBAN ⇒ ref must be QRR; otherwise SCOR/NON.

**QRR check digit (mod-10 recursive):**
`table=[0,9,4,6,8,2,7,1,3,5]; carry=0; for d in ref[:26]: carry=table[(carry+int(d))%10]; check=(10-carry)%10`
**SCOR:** move `RFcc` to end, letters A→10…Z→35, big-int mod 97 == 1.

**SWICO S1** (line 32): `//S1` + `/tag/value` pairs, ascending tags, escaping
`\/` and `\\`, dates `YYMMDD`. Key tags: `/10/` invoice no, `/11/` invoice
date, `/20/` customer ref, `/30/` biller UID (index senders on this!),
`/32/` VAT details, **`/40/` payment conditions `2:10;0:30` = 2% skonto 10d,
net 30d → due date = /11/ + days-of-0%-entry**.

**Swiss dunning conventions:** 30 days net is the de-facto default term
(fallback when no /40/). Ladder: Zahlungserinnerung → 1. Mahnung →
2./letzte Mahnung → Betreibung. Mahngebühr CHF 10–50 only if in AGB;
statutory default interest 5 % p.a. (OR Art. 104). Reminder titles to
detect: Zahlungserinnerung / N. Mahnung / Rappel / Sollecito.

**Re-rendering a scannable QR:** ISO 18004 byte mode UTF-8, **ECC level M
mandatory**, print 46×46 mm with **7×7 mm Swiss cross overlay centered**
(keep 46:7 ratio on screen), quiet zone ≥5 mm, smallest QR version that fits.

### Prior art (paperless-ngx et al.) and UI stack

**paperless-ngx** (2.20.x stable, v3.0 beta absorbing AI features — validates
this project's thesis). Data model worth copying: correspondents, document
types, hierarchical tags, **inbox-tag review queue** (every new doc lands
"unreviewed"; AI proposes, user confirms — their most-loved workflow),
typed custom fields (monetary, date, select, doc-link), metadata-driven
filename templates so the disk archive stays browsable without the app,
auto-matching classifier that **learns only from confirmed docs**.
Complaints to avoid: taxonomy chaos at 1000+ docs, exact-checksum-only
dedup, heavyweight setup (Docker+Redis) — a desktop app that "just opens"
is a differentiator. AI companions (paperless-gpt/paperless-ai) converge on:
vision-LLM OCR fallback for bad scans + LLM-proposed metadata + review queue.

Standout ideas elsewhere: Papra — unique inbound email address per org;
DEVONthink — suggest-don't-decide classification; Neat/Evernote — category
totals and year-end report layer (what a Swiss invoice tracker needs).

**Dedup (layered, per practice):** (1) SHA-256 of file bytes → hard
block/link; (2) (correspondent + invoice_no + amount) equality — highest
precision signal for invoices; (3) normalized-OCR-text similarity +
page-1 perceptual hash → **non-blocking "possible duplicate" flag** in
review queue. Never silent-reject (rescans of same paper differ in bytes).

**Electron (mid-2026):** stable major 43 (Chromium 150/Node 24). Security
day-one: contextIsolation+sandbox (defaults), preload with minimal
contextBridge API, renderer = pure UI, everything else in main process.
**PDF viewing: bundle pdf.js.** Chromium's built-in viewer works only for
main-frame loads; iframe/webview embedding is a decade-old minefield
(issues #33907 "not planned", etc.); webview officially discouraged.
pdf.js runs in a sandboxed renderer, gives text layer for search-hit
highlighting + thumbnails. Escape hatch: shell.openPath to system viewer.

**SQLite FTS5 schema:** external-content table over documents with manual
sync triggers (explicit rowid + 'delete' inserts — FTS5 does not auto-sync);
`tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"` (é→e, ü→u;
normalize ß→ss ourselves), `prefix='2 3'` for search-as-you-type
(quote tokens, star the last); bm25 weights title/correspondent above body;
snippet() for excerpts; optimize after bulk ingest.

### OCR landscape (2025-26) — decision

**Verdict: two-tier pipeline** (also the paperless-ngx ecosystem consensus):
classical OCR for the archival text layer, vision AI for understanding.

- **Text layer: OCRmyPDF + Tesseract 5.5.2** stays. On clean 300 dpi
  printed Latin text tesseract scores ~99.3 % — statistically tied with
  billion-param VLMs; it's the only engine with word-level boxes, hOCR,
  deterministic output, and PDF/A via ghostscript. VLM "OCR" fails by
  *inventing fluent plausible text* (checkbox inversions, repetition
  loops, hallucinated digits) — for IBANs/QR references, tesseract's
  obvious garbage is the safer failure mode.
- **Accuracy upgrade applied:** Fedora langpacks are built from
  tessdata_fast (least accurate, 2019 integerized). Downloaded
  **tessdata_best** deu/fra/ita/eng + osd → `/pool/docdoc/tessdata`,
  pipeline sets `TESSDATA_PREFIX`. Known weak spot: `deu` model misreads
  € often; CHF (ASCII) is fine.
- `--output-type pdfa` for archival (PDF/A-2b).
- Fedora's ocrmypdf RPM is 16.11 (17.x is pip-only); 16.11 suffices —
  we pass --output-type explicitly, which is the main 17.x behavior change.
- **Understanding: send page images to Claude** (validated locally, see
  above) — vision reads stamps, logos, layout that OCR text loses, and is
  immune to OCR errors. Local fallback options if docs must stay offline:
  Qwen3-VL via ollama (advisory only). Upgrade path if tesseract errors
  ever annoy: PaddleOCR 3.7 via ocrmypdf-paddleocr plugin (hOCR word
  boxes, CPU-viable); Surya has best OSS multilingual accuracy but no
  hOCR/ocrmypdf integration.

## Faster AI step: local models on the 4× 4090 (2026-07-19)

Deep research (23 sources, 25 claims adversarially verified 3-vote,
23 confirmed / 2 refuted). Goal: replace the ~10 s/page `claude -p` call
(~30–100 s/doc pipeline) with a local extractor at ~2–5 s/doc.

### Verdict: split architecture

Keep tesseract for the archival PDF/A text layer; run **Qwen3-VL**
resident in **vLLM V1** with guided JSON decoding for understanding.
Feed it page images PLUS layout-preserving OCR text. Cross-validate
digit-dense fields against OCR. Keep `claude -p` as low-confidence
fallback.

### Extraction model: Qwen3-VL (verified best open family)

- Family: 2B/4B/8B/32B dense + 30B-A3B/235B-A22B MoE, 256K context.
  **8B fits one 4090** (FP8/AWQ); 32B needs 2 GPUs at 4-bit (~19–20 GB
  weights, tight with vision encoder + KV); 30B-A3B MoE ~16–17 GB at
  4-bit fits one card.
- 32B: DocVQA 96.9, OCRBench 895 — above Gemini 2.5 Flash and GPT-5-mini
  (vendor-reported, near-saturated benchmarks).
- **8B is genuinely competitive**: 96.6 % field-level EM on VAREX (above
  Llama 4 Maverick and GPT-4o); best-open 79.05 F1 on UniKIE-Bench
  (ACL 2026), ~3.3 F1 behind Gemini-3-Pro, above GPT-4o/GPT-5/Sonnet-4.5.
- Multilingual OCR: 39 languages; fr ~80 %, it ~74 %, de ~73 % (all pass
  the >70 % bar but de/it near the bottom of the passing group);
  independent MORE benchmark corroborates (de ~98 %, fr ~90 % parsing).
- Caveat: no verified benchmark measures scanned de/fr/it Swiss mail
  directly (VAREX = English born-digital; UniKIE = zh/en). Evidence base
  is Qwen-centric; InternVL3.5/GLM-4.6V/MiniCPM-V/Mistral/Pixtral/Phi-4
  produced NO surviving claims — absence of evidence, not inferiority.
  Verifiers allude to Qwen3.5/3.6 families — re-check landscape at
  implementation time.

### Input design (single largest quality lever)

- **Images + layout-preserving (whitespace-aligned) OCR text** is best or
  tied-best in VAREX's controlled 4-modality ablation; upgrading raw
  reading-order text to layout-preserving text is worth **+3–18 pp**.
  Our tesseract hOCR word boxes can generate exactly this.
- Parse-to-markdown as sole input (Docling route) is catastrophic on
  scans: 87.46 % native-image vs 47.00 % best-parse (Fraunhofer).
  → keep sending images; ADD the layout text (today we send raw text).

### Hallucination finding CONFIRMED for 2026 models (5 claims, all 3-0)

- VLM-as-OCR still silently invents plausible text — architectural, not
  maturity: DeepSeek-OCR collapses ~90 %→~20 % precision on zero-prior
  random strings; ALL 13 tested end-to-end systems collapse 40–68 pp;
  pipeline PaddleOCR-v5 drops only 4.9 % (to 89.53 %).
- **IBANs are the worst-extracted field class for every benchmarked LLM**
  (0/O/U confusions). IBANs/references/amounts are exactly zero-prior
  strings → must come from or be validated against deterministic OCR
  (QR-bill data already authoritative where present).

### OCR layer: tesseract stays (for now)

- OmniDocBench 2026: specialists beat generalist VLMs at parsing
  (MinerU2.5-Pro 95.75, GLM-OCR 95.22, PaddleOCR-VL-1.5 94.93 vs
  Qwen3-VL-235B 89.78) — but these score markdown parsing, not word-box
  OCR for archival layers. Caveat: leaderboard owner = MinerU maintainer.
- **PP-OCRv6** (June 2026, PaddleOCR 3.7): 34.5M params, 50 languages,
  +5.1 pp recognition over v5; beats billion-scale VLMs at pure OCR on
  (CJK-skewed, self-reported) benchmarks. No head-to-head vs tessdata_best
  on clean 300 dpi Latin exists — our use case is unmeasured.
- ocrmypdf-paddleocr plugin (MPL-2.0) verified at code level: drop-in
  OcrEngine hook, word-level hOCR via return_word_box=True. Maturity
  risks: single maintainer, no releases, skewed-line box inaccuracy,
  umlaut token-merge heuristics. → bounded experiment, not a default.

### Small fast tier (doc-type classify first)?

- Sub-4B VLMs zero-shot are dominated by "schema echo" (returning the
  schema, −45–65 pp) — but it's a JSON-Schema $defs artifact: inlining
  $defs recovers Qwen3-VL-2B 27.4 %→91.8 %; extraction-tuned NuExtract
  2.0 2B hits 90.8 % EM with zero echo. With constrained decoding + flat
  schema (our case) a small tier is viable; residual risk is
  under-extraction. Not needed for latency if the 8B alone hits target.

### Serving

- **vLLM V1 structured outputs**: guided decoding off the critical path
  (V0 could degrade whole server; xgrammar up to 5× TPOT vs Outlines).
  Two backends, XGrammar (cached schema — our case) + llguidance, picked
  by `auto`. Batch≈1 + one fixed schema + resident server = the favorable
  case. REFUTED: exact `guided_json` API parameter claims (1-2) — check
  live vLLM docs for current param names (guided_json vs
  structured_outputs) before coding.
- Nothing on SGLang/llama.cpp/TabbyAPI or 4×4090 no-P2P TP scaling
  survived verification. All latency figures = extrapolation; the
  2–5 s/doc target is plausible (8B, resident, ~4 images) but UNPROVEN —
  benchmark locally before committing.
- REFUTED 0-3: the arXiv 2510.23066 "8.8× accuracy, 92.6 % latency cut
  multi-stage pipeline" paper — distrust aggressive pipeline-speedup
  numbers from that literature.

### Benchmarked on this machine (2026-07-19, tests/bench_vlm.py)

vLLM 0.25.1 in /pool/docdoc/vllm/venv, models in /pool/docdoc/hf
(HF_HOME — /home is full). 12 real reviewed documents (fr/de Swiss mail,
1–4 pages), production inputs (first 4 original page images + OCR text +
QR context + known senders, same PROMPT). Reference = reviewed DB values
(derived from Claude, so Claude scores ~100 % by construction).

| model (quant, GPUs) | s/doc avg (min–max) | fields | notes |
|---|---|---|---|
| Qwen3-VL-8B FP8 (1× 4090) | 8.5 (5.0–12.0) | 85 % | taxonomy confusions |
| Qwen3-VL-30B-A3B AWQ (1× 4090) | **5.7** (2.4–7.8) | 84 % | fastest (3B active); 1 JSON truncated at max_tokens |
| Qwen3-VL-32B FP8 (TP=2, PCIe) | 20.8 (11.4–30.0) | **92 %** | fixes all doc_type errors; decode only ~25 tok/s |
| Claude Sonnet (cloud, baseline) | ~10 s/page ⇒ ~20–40 s/doc | ref | needs internet |

Findings:
- **Image tokens dominate**: at native 300 dpi a page costs ~8k tokens
  (4-page doc blows 32k context, 400s). Server-side cap
  `--mm-processor-kwargs '{"max_pixels": 1605632}'` → ~1–2k tokens/page,
  no measurable accuracy loss (OCR text carries the small print).
- **Error profile is taxonomy, not extraction**: amounts/dates/refs are
  near-perfect on all three; 8B/30B misclassify French admin nuance
  (décompte→"reminder", statement→"return_slip") and level of a
  "sommation" (all local models say 1, correct is 2 — add explicit
  prompt rules: sommation/2e rappel ⇒ level 2, décompte ⇒ invoice, and
  per-class definitions). 32B gets doc_type right with the same prompt.
- Several scored "misses" are reference artifacts (model read
  "DeinDeal AG" printed on the mystore.ch slip; found a due date the
  reference left null though it's in the document).
- **PCIe TP=2 answered**: dense 32B FP8 decodes ~25 tok/s across two
  4090s — the quality tier is real but too slow for the default path.
- Structured outputs verified working on vLLM 0.25: OpenAI-style
  `response_format {"type":"json_schema", ...}` with enums — use it
  (also fixes the max_tokens JSON truncation).
- Cold start: 40–90 s to READY (weights cached on /pool) — a resident
  or lazily-started-but-kept-warm server is required; per-scan spawn is
  not viable.

**Conclusion: Qwen3-VL-30B-A3B-AWQ on one 4090 is the default local
extractor** (5.7 s/doc ≈ 4–6× faster than the cloud AI stage, offline);
close the ~8 pp taxonomy gap with prompt class-rules + guided JSON
(+ layout-text input, the research's +3–18 pp lever, untested here).
Escalation tier: 32B (slow but 92 %) or claude-cli when online.

## Single-app decision: port the Python side to JS (2026-07-19)

Direction: eliminate docdoc's Python entirely; the Electron app becomes
the single deliverable that supervises everything and talks to AI over
HTTP (local vLLM or cloud API).

Ground truth from the code: the 3 034 Python lines are orchestration —
every heavy operation is a spawned native CLI (img2pdf, ocrmypdf, qpdf,
pdftoppm, tesseract, zbarimg, qrencode, scanimage). PIL is used twice
(blank-page ink histogram; QR Swiss-cross overlay) → `sharp`.

**Not the plan: moving OCR itself into JS.** tesseract.js is a WASM
build — 2–5× slower than native, no deskew/rotate/PDF-A pipeline, and
the rest of the "JS OCR ecosystem" is cloud-API wrappers. The archival
text layer keeps native tesseract via ocrmypdf, spawned from JS exactly
as Python spawns it today. ocrmypdf is itself a Python app but is
treated as an opaque system binary like qpdf/ghostscript — "no Python"
means no docdoc Python, not purging /usr/bin. (True zero-Python option
exists — tesseract's native searchable-PDF output + ghostscript PDF/A —
at the cost of reimplementing rotate/deskew/optimization; revisit only
if ocrmypdf becomes a problem.)

Spike verified (scratchpad, 2026-07-19): better-sqlite3 (SQLite 3.53.2
bundled) opens a copy of the production DB and runs the schema
unmodified — FTS5 external-content search + snippet(), trigger sync on
insert, foreign keys, WAL, PRAGMA data_version. Caveat: native module →
needs @electron/rebuild against Electron's ABI.

Port map (Python → JS, strangler order, Python stays live until each
phase is verified):
1. **db.js** (schema/migrations/FTS/helpers), **invoices.js**,
   **qrbill.js** (SPC parse, mod10/mod97 — pure logic), API layer in
   main.js with the SAME method names the renderer already calls →
   stdio server (551 lines) evaporates, renderer untouched. Port
   test_invoices/test_qrbill to node.
2. **pipeline.js** (spawn img2pdf/ocrmypdf/qpdf/pdftoppm; blank
   detection via sharp), **ai.js** (fetch → vLLM OpenAI endpoint with
   json_schema per benchmark, or Anthropic API directly — replaces the
   claude -p subprocess), dedup/pageorder pure ports; watcher into a
   supervised main.js module (replaces docdocd systemd unit).
3. **scanner.js**: ADS-4300N is driverless eSCL over ipp-usb — plain
   HTTP (status poll = GET ScannerStatus XML), scanimage spawn for the
   actual scan (replaces scan_buttond + its systemd unit). Tray +
   login autostart (paper-insert scanning must survive window close).
   Then delete docdoc/*.py + systemd units; electron-builder packaging.

npm deps: better-sqlite3, sharp, chokidar, qrcode. System deps
(unchanged, unbundleable anyway — SANE alone guarantees that):
tesseract+tessdata_best, ocrmypdf, img2pdf, qpdf, poppler(pdftoppm),
zbar, ghostscript.

### Implementation sketch

1. vLLM V1 server (systemd, weights under /pool/docdoc/models) with
   Qwen3-VL-8B-Instruct FP8/AWQ on one 4090, resident; optional 32B AWQ
   TP=2 quality tier for hard docs.
2. ai.py: new provider "local-vllm" (OpenAI-compatible endpoint), prompt =
   4 page images + whitespace-aligned layout text built from hOCR + flat
   $defs-inlined JSON schema via guided decoding.
3. Post-extraction cross-check: every IBAN/amount/reference the VLM emits
   must fuzzy-match the tesseract text or QR data; mismatch → claude-cli
   fallback (also the confidence signal).
4. Benchmark first (open questions): measured latency for 4× 300 dpi
   images + ~1500-token JSON on one 4090; AWQ vs FP8 multilingual JSON
   quality; PP-OCRv6 vs tessdata_best on our own scans.

Key sources: Qwen3-VL TR (arXiv 2511.21631), VAREX (2603.15118),
UniKIE-Bench (2602.07038, ACL 2026), PP-OCRv6 (2606.13108), DeepSeek-OCR
prior-collapse study (2601.03714), Fraunhofer invoice study (2509.04469),
OmniDocBench leaderboard, Red Hat vLLM structured-outputs article,
github.com/clefru/ocrmypdf-paddleocr.
