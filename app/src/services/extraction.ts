// AI document understanding.
//
// Providers: 'claude-cli' (headless `claude -p` with vision -- the model
// Reads the page images from disk), 'local-vllm' (OpenAI-compatible
// endpoint, e.g. vLLM serving Qwen3-VL per RESEARCH.md benchmark --
// images sent as data URLs, JSON enforced via structured outputs), and
// keyword-heuristics fallback when no AI is available.
//
// Gotcha handled here: this machine's login profile exports
// ANTHROPIC_API_KEY for a zero-credit account, which would override the
// claude.ai subscription login -- the claude-cli subprocess env drops it.

import * as fs from "fs";
import { slugify } from "../domain/textsim";
import { DOC_TYPES, REF_KINDS } from "../domain/types";
import type { Config, DocType, ExtractedRef, Extraction, ExtractionResult,
              QrBill, RefKind } from "../domain/types";
import { run } from "../infra/exec";

export { slugify };

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

export function stripFences(text: string | null | undefined): string {
  let t = String(text ?? "").trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (m) t = m[1].trim();
  // tolerate prose around a JSON object
  if (!t.startsWith("{")) {
    const m2 = /\{[\s\S]*\}/.exec(t);
    t = m2 ? m2[0] : t;
  }
  return t;
}

const isoDate = (v: unknown): string | null => {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
    ? s : null;
};

/** Validate/normalize a raw extraction object; never trust the model. */
export function normalize(
  d: Record<string, unknown>, qr: QrBill | null = null,
): Extraction {
  const str = (v: unknown): string => String(v ?? "").trim();
  const num = (v: unknown): number | null => {
    const n = v != null ? parseFloat(String(v)) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const out: Extraction = {
    doc_type: DOC_TYPES.includes(d.doc_type as DocType)
      ? d.doc_type as DocType : "other",
    sender_name: str(d.sender_name) || null,
    sender_key: slugify(str(d.sender_key) || str(d.sender_name)),
    recipient_name: str(d.recipient_name) || null,
    title: str(d.title) || null,
    language: str(d.language).slice(0, 2).toLowerCase() || null,
    summary_en: str(d.summary_en) || null,
    tags: (Array.isArray(d.tags) ? d.tags : [])
      .map((t) => String(t).toLowerCase().trim().slice(0, 32))
      .filter(Boolean).slice(0, 8),
    doc_date: d.doc_date ? isoDate(d.doc_date) : null,
    due_date: d.due_date ? isoDate(d.due_date) : null,
    amount: num(d.amount),
    reminder_fee: num(d.reminder_fee),
    currency: str(d.currency).slice(0, 3).toUpperCase() || null,
    invoice_ref: str(d.invoice_ref) || null,
    reminder_level: (() => {
      const lvl = parseInt(String(d.reminder_level), 10);
      return Number.isFinite(lvl) ? Math.max(0, Math.min(9, lvl)) : 0;
    })(),
    refs: (Array.isArray(d.refs) ? d.refs : [])
      .filter((r): r is Record<string, unknown> =>
        !!r && typeof r === "object" && !!(r as Record<string, unknown>).value)
      .map((r): ExtractedRef => ({
        kind: REF_KINDS.includes(r.kind as RefKind) ? r.kind as RefKind : "other",
        value: String(r.value).trim().slice(0, 64),
      }))
      .slice(0, 20),
    ref_dates: (Array.isArray(d.ref_dates) ? d.ref_dates : [])
      .map((r) => {
        const rr = r as Record<string, unknown> | null;
        const date = rr ? isoDate(rr.date) : null;
        return date
          ? { date, label: String(rr!.label ?? "").slice(0, 80) }
          : null;
      })
      .filter((x): x is { date: string; label: string } => x !== null)
      .slice(0, 10),
    page_order: null,
    page_groups: null,
  };
  if (Array.isArray(d.page_order)) {
    const order = d.page_order.map((x) => parseInt(String(x), 10));
    const n = order.length;
    const sorted = [...order].sort((a, b) => a - b);
    const identity = Array.from({ length: n }, (_, i) => i + 1);
    if (order.every(Number.isFinite) &&
        JSON.stringify(sorted) === JSON.stringify(identity) &&
        JSON.stringify(order) !== JSON.stringify(identity))
      out.page_order = order;
  }
  // multiple documents in one scanned stack: shape-sanitized here,
  // completeness validated by the pipeline (which knows the page count)
  if (Array.isArray(d.page_groups) && d.page_groups.length > 1) {
    const groups = d.page_groups.map((g) => Array.isArray(g)
      ? g.map((x) => parseInt(String(x), 10))
        .filter((x) => Number.isFinite(x) && x >= 1)
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

function qrContext(qr: QrBill | null): string {
  if (!qr) return "";
  const lines = ["- The document carries a Swiss QR-bill with:"];
  if (qr.creditor) lines.push(`  creditor: ${qr.creditor.name}`);
  if (qr.amount != null) lines.push(`  amount: ${qr.amount} ${qr.currency}`);
  if (qr.reference) lines.push(`  reference: ${qr.reference}`);
  if (qr.is_notification) lines.push("  NOTE: amount 0.00 = notification, not payable");
  return lines.join("\n") + "\n";
}

interface PromptInput {
  imageSource: string;
  ocrText: string;
  qr: QrBill | null;
  knownSenders: string[];
  nPages: number;
}

function buildPrompt(p: PromptInput): string {
  const senderCtx = p.knownSenders.length
    ? "- Known sender keys (reuse when the same organization): "
      + [...p.knownSenders].sort().slice(0, 80).join(", ") + "\n"
    : "";
  return PROMPT
    .replace("{image_source}", p.imageSource)
    .replace("{ocr_text}", p.ocrText.slice(0, 6000))
    .replace("{qr_context}", qrContext(p.qr))
    .replace("{sender_context}", senderCtx)
    .replace("{doc_types}", DOC_TYPES.join("|"))
    .replace("{ref_kinds}", REF_KINDS.join("|"))
    .replace("{n_pages}", String(p.nPages));
}

const envWithoutAnthropicKey = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
};

interface ProviderOpts {
  qr?: QrBill | null;
  knownSenders?: string[];
  maxPages?: number;
  timeout?: number;
}

export async function extractClaudeCli(
  imagePaths: string[], ocrText: string,
  { qr = null, knownSenders = [], maxPages = 4, timeout = 300000,
    model = "sonnet" }: ProviderOpts & { model?: string } = {},
): Promise<Extraction> {
  const images = imagePaths.slice(0, maxPages);
  const prompt = buildPrompt({
    imageSource: "you must Read from these paths:\n"
      + images.map((p) => `  ${p}`).join("\n"),
    ocrText, qr, knownSenders, nPages: images.length,
  });
  const { stdout } = await run(
    "claude", ["-p", prompt, "--allowedTools", "Read",
               "--output-format", "json", "--model", model],
    { env: envWithoutAnthropicKey(), timeout });
  const envelope = JSON.parse(stdout) as { is_error?: boolean; result: string };
  if (envelope.is_error)
    throw new Error(`claude -p error: ${envelope.result}`);
  return normalize(JSON.parse(stripFences(envelope.result)), qr);
}

// flat JSON schema ($defs inlined -- small models echo $defs schemas
// back, see RESEARCH.md), enforced via OpenAI-style structured outputs
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    doc_type: { type: "string", enum: [...DOC_TYPES] },
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
      properties: { kind: { type: "string", enum: [...REF_KINDS] },
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
} as const;

async function vllmModel(baseUrl: string): Promise<string> {
  const res = await fetch(baseUrl.replace(/\/$/, "") + "/models",
                          { signal: AbortSignal.timeout(5000) });
  const body = await res.json() as { data: Array<{ id: string }> };
  return body.data[0].id;
}

export async function extractLocalVllm(
  imagePaths: string[], ocrText: string,
  { qr = null, knownSenders = [], maxPages = 4, timeout = 300000,
    baseUrl = "http://localhost:8000/v1" }:
    ProviderOpts & { baseUrl?: string } = {},
): Promise<Extraction> {
  const images = imagePaths.slice(0, maxPages);
  const prompt = buildPrompt({
    imageSource: "are attached below, in scan order.",
    ocrText, qr, knownSenders, nPages: images.length,
  });
  type Part = { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };
  const content: Part[] = [{ type: "text", text: prompt }];
  for (const p of images)
    content.push({ type: "image_url", image_url: {
      url: "data:image/jpeg;base64," + fs.readFileSync(p).toString("base64") } });
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: await vllmModel(base),
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
  const out = await res.json() as
    { choices: Array<{ message: { content: string } }> };
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

export interface ReminderCandidate {
  id: number;
  invoice_ref: string | null;
  amount: number | null;
  currency: string | null;
  due_date: string | null;
  sender_name: string | null;
  title: string | null;
  doc_date: string | null;
}

export interface ReminderMatch {
  invoiceId: number | null;
  reason: string | null;
}

/** AI adjudication: which open invoice does this reminder belong to? */
export async function matchReminder(
  cfg: Config, ext: Extraction, candidates: ReminderCandidate[],
  timeout = 120000,
): Promise<ReminderMatch> {
  if (!["claude-cli", "local-vllm"].includes(cfg.ai_provider)
      || !candidates.length)
    return { invoiceId: null, reason: null };
  const reminder: Record<string, unknown> = {};
  for (const k of ["sender_name", "title", "doc_date", "amount", "currency",
                   "due_date", "invoice_ref", "reminder_level", "reminder_fee",
                   "refs", "summary_en"] as const)
    reminder[k] = ext[k] ?? null;
  const prompt = MATCH_PROMPT
    .replace("{reminder}", JSON.stringify(reminder))
    .replace("{candidates}", JSON.stringify(candidates));
  try {
    let text: string;
    if (cfg.ai_provider === "local-vllm") {
      const base = (cfg.ai_base_url || "http://localhost:8000/v1")
        .replace(/\/$/, "");
      const res = await fetch(base + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: await vllmModel(base),
          max_tokens: 400, temperature: 0,
          messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(timeout) });
      const out = await res.json() as
        { choices: Array<{ message: { content: string } }> };
      text = out.choices[0].message.content;
    } else {
      const { stdout } = await run(
        "claude", ["-p", prompt, "--output-format", "json",
                   "--model", cfg.ai_model || "sonnet"],
        { env: envWithoutAnthropicKey(), timeout });
      text = (JSON.parse(stdout) as { result: string }).result;
    }
    const result = JSON.parse(stripFences(text)) as
      { invoice_id?: number | null; reason?: string };
    const invId = result.invoice_id;
    if (invId != null && candidates.some((c) => c.id === invId))
      return { invoiceId: invId, reason: result.reason ?? null };
  } catch { /* adjudication is best-effort */ }
  return { invoiceId: null, reason: null };
}

// ------------------------------------------------------------- heuristics
const REMINDER_WORDS =
  /\b(zahlungserinnerung|mahnung|rappel|sollecito|payment reminder)\b/i;
const TYPE_WORDS: Array<[DocType, RegExp]> = [
  ["invoice", /\b(rechnung|facture|fattura|invoice)\b/i],
  ["receipt", /\b(quittung|beleg|reçu|ricevuta|receipt)\b/i],
  ["contract", /\b(vertrag|contrat|contratto|contract)\b/i],
  ["statement", /\b(kontoauszug|auszug|relevé|estratto|statement)\b/i],
];
const DATE_RES: Array<[RegExp, "dmy" | "ymd"]> = [
  [/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/, "dmy"],
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, "ymd"],
];
const REF_PATTERNS: Array<[RefKind, RegExp]> = [
  ["invoice_no", /(?:Rechnungs?[-\s]?(?:Nr|Nummer)|Facture\s?(?:no|n°)|Fattura\s?n\.?|Invoice\s?(?:no|number|#))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["customer_no", /(?:Kunden[-\s]?(?:Nr|Nummer)|Client\s?(?:no|n°)|Customer\s?(?:no|number)|Debitor[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["policy_no", /(?:Policen?[-\s]?(?:Nr|Nummer)|Police\s?(?:no|n°)?|Policy\s?(?:no|number)|Versicherungs[-\s]?Nr)\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["contract_no", /(?:Vertrags?[-\s]?(?:Nr|Nummer)|Contrat\s?(?:no|n°)|Contract\s?(?:no|number))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
  ["case_no", /(?:Fall[-\s]?Nr|Schadens?[-\s]?Nr|Dossier\s?(?:no|n°)?|Case\s?(?:no|number))\.?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,30})/i],
];
const AMOUNT_RE =
  /\b(?:CHF|Fr\.?|EUR|€)\s*([\d'’   ]*\d(?:[.,]\d{2}))/i;

/** No-AI fallback: keywords + QR data. Good enough to file, not to trust. */
export function extractHeuristic(
  ocrText: string, qr: QrBill | null = null,
): Extraction {
  const text = ocrText || "";
  const d: Record<string, unknown> = {};
  if (REMINDER_WORDS.test(text)) {
    d.doc_type = "reminder";
    const lvl = /(\d)\s*\.?\s*(?:mahnung|rappel|sollecito)/i.exec(text);
    d.reminder_level = lvl ? parseInt(lvl[1], 10) : 1;
  } else {
    d.doc_type = TYPE_WORDS.find(([, rx]) => rx.test(text))?.[0] ?? "other";
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
    d.amount = parseFloat(am[1].replace(/['’   ]/g, "").replace(",", "."));
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
  d.sender_key = slugify(String(d.sender_name ?? ""));
  const dt = d.doc_type as string;
  d.title = ({ invoice: "Rechnung", reminder: "Mahnung" } as
    Record<string, string>)[dt] ?? dt[0].toUpperCase() + dt.slice(1);
  d.tags = dt !== "other" ? [dt] : [];
  const refs: ExtractedRef[] = [];
  for (const [kind, rx] of REF_PATTERNS)
    for (const m of text.matchAll(new RegExp(rx.source, rx.flags + "g")))
      refs.push({ kind, value: m[1] });
  d.refs = refs;
  return normalize(d, qr);
}

export interface ExtractOpts {
  qr?: QrBill | null;
  knownSenders?: string[];
}

export async function extract(
  cfg: Config, imagePaths: string[], ocrText: string,
  { qr = null, knownSenders = [] }: ExtractOpts = {},
): Promise<ExtractionResult> {
  const images = cfg.ai_send_images !== false ? imagePaths : [];
  const opts = { qr, knownSenders, maxPages: Number(cfg.ai_max_pages ?? 4) };
  if (cfg.ai_provider === "local-vllm") {
    try {
      return { ext: await extractLocalVllm(images, ocrText,
        { ...opts, baseUrl: cfg.ai_base_url }), provider: "local-vllm" };
    } catch (e) {
      console.error(`ai: local-vllm failed (${(e as Error).message}); trying claude-cli`);
    }
  }
  if (["claude-cli", "local-vllm"].includes(cfg.ai_provider)) {
    try {
      return { ext: await extractClaudeCli(images, ocrText,
        { ...opts, model: cfg.ai_model || "sonnet" }), provider: "claude-cli" };
    } catch (e) {
      console.error(`ai: claude-cli failed (${(e as Error).message}); falling back to heuristics`);
    }
  }
  return { ext: extractHeuristic(ocrText, qr), provider: "heuristic" };
}

// Indirection point so tests (and future routing) can swap the extractor.
export type ExtractFn = typeof extract;
let activeExtract: ExtractFn = extract;
export const setExtractor = (fn: ExtractFn): void => { activeExtract = fn; };
export const resetExtractor = (): void => { activeExtract = extract; };
export const runExtraction: ExtractFn = (...args) => activeExtract(...args);
