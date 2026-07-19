# docdoc — features

## Implemented (v0.1)

- **Drop-in pipeline**: paper inserted → searchable PDF/A archive +
  desktop notification, fully automatic (scan-buttond + docdocd services).
- **Instant visibility**: the scanned PDF is filed and viewable in the app
  ~1 s after the feeder stops (fast ingest: raw PDF + thumbnail under a
  provisional name); OCR + AI run per document on a persistent background
  queue (survives restarts, "reading…" chip until done) and fill in text,
  metadata and the final archive filename live.
- **Abort**: one button in the app stops everything in flight — kills the
  running scan (buttond SIGUSR2) and the background queue mid-stage
  (docdocd SIGUSR1, OCR/AI child killed) and deletes all temp scans:
  partial batch, waiting/queued batches, workdirs and every ingested
  document still awaiting OCR/AI (row, PDF, thumbnail, originals).
  Fully processed documents are never touched.
- **OCR**: OCRmyPDF/tesseract 5 with tessdata_best (deu+fra+ita+eng),
  auto-rotate, deskew, per-page text, thumbnails.
- **AI understanding (vision)**: document type, sender (canonical registry),
  title, language, doc date, due date, amounts, summary, tags — the model
  reads the page images, not just OCR text.
- **Internal references**: invoice/customer/policy/contract/case/member
  numbers extracted and indexed; documents sharing a reference are linked
  ("related documents"). Insurance policy ↔ premium invoices ↔ claims.
- **Timeline** per document: own dates, scan date, dates of documents it
  mentions, invoice chain (due dates, reminders, payment), related docs.
- **Swiss QR-bill**: full SPC v2.2/v2.3 parser (QR-IBAN, QRR/SCOR
  validation, Swico S1 → due date, notification bills), re-render with
  Swiss cross for banking-app payment, amount updated for reminder fees.
- **Invoice lifecycle**: open → reminded → paid; reminders (Mahnung/rappel/
  sollecito) auto-linked to the original (QR ref / invoice no. / AI
  adjudication), fees tracked, chain settled together; overdue dashboard.
  Mark paid records which bank account paid and the payment value date
  (default: next working day); accounts managed in the Bank accounts tab.
  Invoices settled elsewhere (employer, direct debit, dispute) can be
  closed as "do not pay" with a comment saying where they went.
- **Page order**: AI reports correct reading order (page-number markers as
  cross-check); blank duplex backsides dropped (recorded, reviewable).
- **Dedup, layered**: exact bytes → exact text → same references+type →
  text similarity soft flag. Duplicates linked, never silently rejected.
- **Search**: SQLite FTS5, diacritics-folded, prefix search-as-you-type,
  snippets, ranked (title/sender boosted).
- **App**: Electron 37, sandboxed renderer, pdf.js preview, inbox review
  queue, filters, senders, activity log, live updates, settings.
- **Robustness**: failed batches quarantined in failed/ with events;
  originals retained; heuristic no-AI degraded mode.

## Roadmap (from research; roughly ordered)

1. **Document splitting**: several documents in one feeder stack, split on
   separator pages / AI-detected boundaries.
2. **Email-in**: forward invoice mails to a local address → same pipeline
   (Papra's most-loved feature). Also drag-and-drop PDF import in the app.
3. **Due-date notifications**: scheduled reminders ("Helvetia due in 3
   days"), paperless-ngx-style scheduled workflow triggers.
4. **Reports**: spend per sender/category/quarter, year-end totals,
   open-items aging (the Neat/Evernote lesson: DMS + report layer).
5. **Auto-learning matcher**: train per-sender/type classifier on
   confirmed documents only, as a cheap pre-AI pass (paperless-ngx auto).
6. **RAG chat**: "when does my Helvetia policy renew?" over the archive
   (embeddings + local LLM; 4×4090 available).
7. **Local VLM option**: Qwen3-VL via ollama for a fully-offline AI
   provider.
8. **eBill awareness**: parse lines 33/34 alternative procedures.
9. **pain.001 export**: batch-pay open invoices via e-banking upload.
10. **Retention rules**: Swiss 10-year business-document retention hints,
    archive expiry review.
11. **Mobile companion / share links**, document versions, audit trail.
12. **PDF/A verification + jbig2 compression** (build jbig2enc) for
    smaller archives.
