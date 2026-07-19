// AI document understanding.
//
// Providers: 'claude-cli' (headless `claude -p` with vision -- the model
// Reads the page images from disk), 'local-vllm' (OpenAI-compatible
// endpoint, e.g. vLLM serving Qwen3-VL per RESEARCH.md benchmark --
// images sent as data URLs, JSON enforced via structured outputs), and
// keyword-heuristics fallback when no AI is available.
//
// Gotcha handled here: this machine's login profile exports ANTHROPIC_API_KEY
// for a zero-credit account, which would override the claude.ai subscription
// login -- the claude-cli subprocess env drops it.

const fs = require("fs");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const DOC_TYPES = ["invoice", "reminder", "receipt", "letter", "contract",
                   "policy", "statement", "return_slip", "medical", "insurance",
                   "tax", "other"];

const REF_KINDS = ["invoice_no", "customer_no", "policy_no", "contract_no",
                   "case_no", "member_no", "order_no", "other"];

const PROMPT = `You are the extraction engine of a document management system. Analyze the
scanned document whose page images {image_source}

Additional context:
- OCR text of the document (may contain recognition errors):
---
{ocr_text}
---
{qr_context}{sender_context}
Output ONLY a JSON object, no prose, no code fences, with exactly these keys:
- doc_type: one of {doc_types}
  ("reminder" = payment reminder/Mahnung/rappel/sollecito for an earlier invoice)
  Classification rules: a cost statement/décompte/Abrechnung with a payment
  slip is an "invoice", not a reminder; a bank/account statement is
  "statement"; only call it "reminder" when it explicitly references an
  earlier unpaid invoice.
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
  1. Mahnung / 1er rappel; 2 for 2. Mahnung / 2e rappel; a "sommation"
  or "letzte Mahnung" is level 2 or higher, never 1
- reminder_fee: reminder/dunning fee amount charged in THIS document, or null
- refs: array of ALL internal identifiers printed on the document, each as
  {"kind": one of {ref_kinds}, "value": "as printed"}.
  Include invoice numbers, customer numbers, policy numbers (Police-Nr),
  contract numbers (Vertrags-Nr), case/dossier numbers (Fall-Nr, Schaden-Nr),
  member numbers, order numbers. These link related documents together, so
  be thorough — a reminder must include the original invoice number, a
  premium invoice must include the policy number.
- ref_dates: array of OTHER documents' dates mentioned in this one, each as
  {"date": "YYYY-MM-DD", "label": "short description"} — e.g. a reminder
  mentioning the original invoice date, a policy naming the coverage start.
- page_order: null if the {n_pages} page image(s) given above are already in
  correct reading order; otherwise the correct order as a list of 1-based
  positions, e.g. [2,1,3] means the 2nd image is really page 1. Judge from
  content flow, page numbering, letterhead/signature placement.
- page_groups: null if all pages belong to ONE document. If the scanned
  stack contains MULTIPLE separate documents (e.g. two unrelated invoices
  fed in one go), an array of page-number arrays, one per document, each
  in reading order — e.g. [[1,2],[3]] = pages 1-2 form one document,
  page 3 another. A payment slip belongs to its invoice's group, and
  continuation pages are not separate documents — split only on a clear
  new document start (new letterhead/sender/date/subject). When you
  report page_groups, fill all other fields for the FIRST group's
  document.
`;

function slugify(name) {
  const s = String(name || "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40) || "unknown";
}

function stripFences(text) {
  let t = String(text || "").trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (m) t = m[1].trim();
  // tolerate prose around a JSON object
  if (!t.startsWith("{")) {
    const m2 = /\{[\s\S]*\}/.exec(t);
    t = m2 ? m2[0] : t;
  }
  return t;
}

const isoDate = (v) => {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
    ? s : null;
};

function normalize(d, qr = null) {
  // Validate/normalize an extraction dict; never trust the model.
  const out = {};
  out.doc_type = DOC_TYPES.includes(d.doc_type) ? d.doc_type : "other";
  out.sender_name = String(d.sender_name || "").trim() || null;
  out.sender_key = slugify(d.sender_key || d.sender_name || "");
  out.recipient_name = String(d.recipient_name || "").trim() || null;
  out.title = String(d.title || "").trim() || null;
  out.language = String(d.language || "").slice(0, 2).toLowerCase() || null;
  out.summary_en = String(d.summary_en || "").trim() || null;
  out.tags = (Array.isArray(d.tags) ? d.tags : [])
    .map((t) => String(t).toLowerCase().trim().slice(0, 32))
    .filter(Boolean).slice(0, 8);
  out.doc_date = d.doc_date ? isoDate(d.doc_date) : null;
  out.due_date = d.due_date ? isoDate(d.due_date) : null;
  for (const k of ["amount", "reminder_fee"]) {
    const v = d[k] != null ? parseFloat(d[k]) : NaN;
    out[k] = Number.isFinite(v) ? v : null;
  }
  out.currency = String(d.currency || "").slice(0, 3).toUpperCase() || null;
  out.invoice_ref = String(d.invoice_ref ?? "").trim() || null;
  const lvl = parseInt(d.reminder_level, 10);
  out.reminder_level = Number.isFinite(lvl) ? Math.max(0, Math.min(9, lvl)) : 0;
  out.refs = (Array.isArray(d.refs) ? d.refs : [])
    .filter((r) => r && typeof r === "object" && r.value)
    .map((r) => ({ kind: REF_KINDS.includes(r.kind) ? r.kind : "other",
                   value: String(r.value).trim().slice(0, 64) }))
    .slice(0, 20);
  out.ref_dates = (Array.isArray(d.ref_dates) ? d.ref_dates : [])
    .map((r) => r && isoDate(r.date)
      ? { date: isoDate(r.date), label: String(r.label || "").slice(0, 80) }
      : null)
    .filter(Boolean).slice(0, 10);
  out.page_order = null;
  if (Array.isArray(d.page_order)) {
    const order = d.page_order.map((x) => parseInt(x, 10));
    const n = order.length;
    const sorted = [...order].sort((a, b) => a - b);
    const identity = Array.from({ length: n }, (_, i) => i + 1);
    if (order.every(Number.isFinite) &&
        JSON.stringify(sorted) === JSON.stringify(identity) &&
        JSON.stringify(order) !== JSON.stringify(identity))
      out.page_order = order;
  }
  // multiple documents in one scanned stack: array of 1-based page-number
  // arrays; shape-sanitized here, completeness validated by the pipeline
  // (which knows the page count)
  out.page_groups = null;
  if (Array.isArray(d.page_groups) && d.page_groups.length > 1) {
    const groups = d.page_groups.map((g) => Array.isArray(g)
      ? g.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x >= 1)
      : []);
    if (groups.every((g) => g.length)) out.page_groups = groups;
  }
  // QR-bill data is authoritative where present
  if (qr) {
    if (qr.amount && !qr.is_notification) {
      out.amount = qr.amount;
      out.currency = qr.currency || out.currency;
    }
    if (qr.swico?.due_date) out.due_date = qr.swico.due_date;
    if (qr.swico?.invoice_no) out.invoice_ref = qr.swico.invoice_no;
    if (!["invoice", "reminder"].includes(out.doc_type) && !qr.is_notification)
      out.doc_type = "invoice";
    if (qr.creditor && !out.sender_name) {
      out.sender_name = qr.creditor.name;
      out.sender_key = slugify(qr.creditor.name);
    }
  }
  return out;
}

function qrContext(qr) {
  if (!qr) return "";
  const lines = ["- The document carries a Swiss QR-bill with:"];
  if (qr.creditor) lines.push(`  creditor: ${qr.creditor.name}`);
  if (qr.amount != null) lines.push(`  amount: ${qr.amount} ${qr.currency}`);
  if (qr.reference) lines.push(`  reference: ${qr.reference}`);
  if (qr.is_notification) lines.push("  NOTE: amount 0.00 = notification, not payable");
  return lines.join("\n") + "\n";
}

function buildPrompt({ imageSource, ocrText, qr, knownSenders, nPages }) {
  const senderCtx = knownSenders?.length
    ? "- Known sender keys (reuse when the same organization): "
      + [...knownSenders].sort().slice(0, 80).join(", ") + "\n"
    : "";
  return PROMPT
    .replace("{image_source}", imageSource)
    .replace("{ocr_text}", String(ocrText || "").slice(0, 6000))
    .replace("{qr_context}", qrContext(qr))
    .replace("{sender_context}", senderCtx)
    .replace("{doc_types}", DOC_TYPES.join("|"))
    .replace("{ref_kinds}", REF_KINDS.join("|"))
    .replace("{n_pages}", String(nPages));
}

const envWithoutAnthropicKey = () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
};

async function extractClaudeCli(imagePaths, ocrText, { qr = null, knownSenders = [],
    model = "sonnet", maxPages = 4, timeout = 300000 } = {}) {
  const images = imagePaths.slice(0, maxPages);
  const prompt = buildPrompt({
    imageSource: "you must Read from these paths:\n"
      + images.map((p) => `  ${p}`).join("\n"),
    ocrText, qr, knownSenders, nPages: images.length,
  });
  const { stdout } = await execFileP(
    "claude", ["-p", prompt, "--allowedTools", "Read",
               "--output-format", "json", "--model", model],
    { env: envWithoutAnthropicKey(), timeout, maxBuffer: 16 << 20 });
  const envelope = JSON.parse(stdout);
  if (envelope.is_error)
    throw new Error(`claude -p error: ${envelope.result}`);
  return normalize(JSON.parse(stripFences(envelope.result)), qr);
}

// flat JSON schema ($defs inlined -- small models echo $defs schemas back,
// see RESEARCH.md), enforced via OpenAI-style structured outputs
const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    doc_type: { type: "string", enum: DOC_TYPES },
    sender_name: { type: ["string", "null"] },
    sender_key: { type: ["string", "null"] },
    recipient_name: { type: ["string", "null"] },
    doc_date: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    language: { type: ["string", "null"] },
    summary_en: { type: ["string", "null"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 8 },
    amount: { type: ["number", "null"] },
    currency: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    invoice_ref: { type: ["string", "null"] },
    reminder_level: { type: "integer" },
    reminder_fee: { type: ["number", "null"] },
    refs: { type: "array", maxItems: 20, items: {
      type: "object",
      properties: { kind: { type: "string", enum: REF_KINDS },
                    value: { type: "string" } },
      required: ["kind", "value"], additionalProperties: false } },
    ref_dates: { type: "array", maxItems: 10, items: {
      type: "object",
      properties: { date: { type: "string" }, label: { type: "string" } },
      required: ["date", "label"], additionalProperties: false } },
    page_order: { type: ["array", "null"], items: { type: "integer" } },
    page_groups: { type: ["array", "null"],
      items: { type: "array", items: { type: "integer" } } },
  },
  required: ["doc_type", "sender_name", "sender_key", "title", "language",
             "summary_en", "tags", "amount", "currency", "refs"],
  additionalProperties: false,
};

async function extractLocalVllm(imagePaths, ocrText, { qr = null, knownSenders = [],
    baseUrl = "http://localhost:8000/v1", maxPages = 4, timeout = 300000 } = {}) {
  const images = imagePaths.slice(0, maxPages);
  const prompt = buildPrompt({
    imageSource: "are attached below, in scan order.",
    ocrText, qr, knownSenders, nPages: images.length,
  });
  const content = [{ type: "text", text: prompt }];
  for (const p of images)
    content.push({ type: "image_url", image_url: {
      url: "data:image/jpeg;base64," + fs.readFileSync(p).toString("base64") } });
  const modelsRes = await fetch(baseUrl.replace(/\/$/, "") + "/models",
                                { signal: AbortSignal.timeout(5000) });
  const model = (await modelsRes.json()).data[0].id;
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 2500,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: {
        name: "extraction", schema: EXTRACTION_SCHEMA } },
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok)
    throw new Error(`vllm ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  return normalize(JSON.parse(stripFences(out.choices[0].message.content)), qr);
}

const MATCH_PROMPT = `A payment reminder was scanned into a document management system. Decide
which open invoice it belongs to — reason about invoice numbers, sender,
amounts (the reminder total usually equals the invoice amount plus a small
dunning fee), and dates. Do not guess: if none clearly matches, say null.

The reminder:
{reminder}

Open invoices:
{candidates}

Output ONLY a JSON object: {"invoice_id": <id or null>, "reason": "<short>"}
`;

async function matchReminder(cfg, ext, candidates, timeout = 120000) {
  // AI adjudication: which open invoice does this reminder belong to?
  // candidates: list of {id, sender_name, invoice_ref, amount, due_date,
  // doc_date, title}. Returns { invoiceId or null, reason }.
  if (!["claude-cli", "local-vllm"].includes(cfg.ai_provider) || !candidates.length)
    return { invoiceId: null, reason: null };
  const reminder = {};
  for (const k of ["sender_name", "title", "doc_date", "amount", "currency",
                   "due_date", "invoice_ref", "reminder_level", "reminder_fee",
                   "refs", "summary_en"])
    reminder[k] = ext[k] ?? null;
  const prompt = MATCH_PROMPT
    .replace("{reminder}", JSON.stringify(reminder))
    .replace("{candidates}", JSON.stringify(candidates));
  try {
    let text;
    if (cfg.ai_provider === "local-vllm") {
      const base = (cfg.ai_base_url || "http://localhost:8000/v1").replace(/\/$/, "");
      const model = (await (await fetch(base + "/models",
        { signal: AbortSignal.timeout(5000) })).json()).data[0].id;
      const res = await fetch(base + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 400, temperature: 0,
          messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(timeout) });
      text = (await res.json()).choices[0].message.content;
    } else {
      const { stdout } = await execFileP(
        "claude", ["-p", prompt, "--output-format", "json",
                   "--model", cfg.ai_model || "sonnet"],
        { env: envWithoutAnthropicKey(), timeout, maxBuffer: 16 << 20 });
      text = JSON.parse(stdout).result;
    }
    const result = JSON.parse(stripFences(text));
    const invId = result.invoice_id;
    if (invId != null && candidates.some((c) => c.id === invId))
      return { invoiceId: parseInt(invId, 10), reason: result.reason };
  } catch {}
  return { invoiceId: null, reason: null };
}

// ------------------------------------------------------------- heuristics
const REMINDER_WORDS =
  /\b(zahlungserinnerung|mahnung|rappel|sollecito|payment reminder)\b/i;
const TYPE_WORDS = [
  ["invoice", /\b(rechnung|facture|fattura|invoice)\b/i],
  ["receipt", /\b(quittung|beleg|reçu|ricevuta|receipt)\b/i],
  ["contract", /\b(vertrag|contrat|contratto|contract)\b/i],
  ["statement", /\b(kontoauszug|auszug|relevé|estratto|statement)\b/i],
];
const DATE_RES = [
  [/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/, "dmy"],
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, "ymd"],
];
const REF_PATTERNS = [
  ["invoice_no", /(?:Rechnungs?[-\s]?(?:Nr|Nummer)|Facture\s?(?:no|n°)|Fattura\s?n\.?|Invoice\s?(?:no|number|#))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["customer_no", /(?:Kunden[-\s]?(?:Nr|Nummer)|Client\s?(?:no|n°)|Customer\s?(?:no|number)|Debitor[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["policy_no", /(?:Policen?[-\s]?(?:Nr|Nummer)|Police\s?(?:no|n°)?|Policy\s?(?:no|number)|Versicherungs[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["contract_no", /(?:Vertrags?[-\s]?(?:Nr|Nummer)|Contrat\s?(?:no|n°)|Contract\s?(?:no|number))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["case_no", /(?:Fall[-\s]?Nr|Schadens?[-\s]?Nr|Dossier\s?(?:no|n°)?|Case\s?(?:no|number))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
];
const AMOUNT_RE =
  /\b(?:CHF|Fr\.?|EUR|€)\s*([\d'’   ]*\d(?:[.,]\d{2}))/i;

function extractHeuristic(ocrText, qr = null) {
  // No-AI fallback: keywords + QR data. Good enough to file, not to trust.
  const text = ocrText || "";
  const d = {};
  if (REMINDER_WORDS.test(text)) {
    d.doc_type = "reminder";
    const lvl = /(\d)\s*\.?\s*(?:mahnung|rappel|sollecito)/i.exec(text);
    d.reminder_level = lvl ? parseInt(lvl[1], 10) : 1;
  } else {
    d.doc_type = TYPE_WORDS.find(([, rx]) => rx.test(text))?.[0] || "other";
  }
  for (const [rx, kind] of DATE_RES) {
    const m = rx.exec(text);
    if (m) {
      const [day, mon, yr] = kind === "dmy"
        ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
      const dt = new Date(Date.UTC(yr, mon - 1, day));
      if (dt.getUTCMonth() + 1 === mon && dt.getUTCDate() === day) {
        d.doc_date = dt.toISOString().slice(0, 10);
        break;
      }
    }
  }
  const am = AMOUNT_RE.exec(text);
  if (am) {
    d.amount = parseFloat(am[1].replace(/['’   ]/g, "").replace(",", "."));
    d.currency = /EUR|€/i.test(am[0]) ? "EUR" : "CHF";
  }
  if (qr?.creditor) {
    d.sender_name = qr.creditor.name;
  } else {
    // first non-empty line that looks like a name
    for (let line of text.split("\n")) {
      line = line.trim();
      if (line.length >= 3 && line.length <= 60 && !/^\d/.test(line)) {
        d.sender_name = line;
        break;
      }
    }
  }
  d.sender_key = slugify(d.sender_name || "");
  d.title = { invoice: "Rechnung", reminder: "Mahnung" }[d.doc_type]
    || d.doc_type[0].toUpperCase() + d.doc_type.slice(1);
  d.tags = d.doc_type !== "other" ? [d.doc_type] : [];
  d.refs = [];
  for (const [kind, rx] of REF_PATTERNS)
    for (const m of text.matchAll(new RegExp(rx.source, rx.flags + "g")))
      d.refs.push({ kind, value: m[1] });
  return normalize(d, qr);
}

async function extract(cfg, imagePaths, ocrText, { qr = null, knownSenders = [] } = {}) {
  // -> { ext, provider }
  const images = cfg.ai_send_images !== false ? imagePaths : [];
  const opts = { qr, knownSenders, maxPages: parseInt(cfg.ai_max_pages ?? 4, 10) };
  if (cfg.ai_provider === "local-vllm") {
    try {
      return { ext: await extractLocalVllm(images, ocrText,
        { ...opts, baseUrl: cfg.ai_base_url }), provider: "local-vllm" };
    } catch (e) {
      console.error(`ai: local-vllm failed (${e.message}); trying claude-cli`);
    }
  }
  if (["claude-cli", "local-vllm"].includes(cfg.ai_provider)) {
    try {
      return { ext: await extractClaudeCli(images, ocrText,
        { ...opts, model: cfg.ai_model || "sonnet" }), provider: "claude-cli" };
    } catch (e) {
      console.error(`ai: claude-cli failed (${e.message}); falling back to heuristics`);
    }
  }
  return { ext: extractHeuristic(ocrText, qr), provider: "heuristic" };
}

module.exports = { DOC_TYPES, REF_KINDS, PROMPT, EXTRACTION_SCHEMA,
                   slugify, stripFences, normalize, qrContext,
                   extractClaudeCli, extractLocalVllm, extractHeuristic,
                   extract, matchReminder };
