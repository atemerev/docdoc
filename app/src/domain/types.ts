// The docdoc domain model. Everything that crosses a module boundary is
// typed here: database rows (the persisted shape), the AI extraction
// contract, the Swiss QR-bill value objects, and configuration.
//
// Layering: src/domain is pure (no I/O, no Electron, no DB imports),
// src/infra adapts the outside world (SQLite, CLI tools, image codecs),
// src/services orchestrates use cases, src/api is the renderer facade.

// ------------------------------------------------------------ vocabulary
export const DOC_TYPES = [
  "pursuit",
  "invoice",
  "reminder",
  "receipt",
  "letter",
  "contract",
  "policy",
  "statement",
  "return_slip",
  "medical",
  "insurance",
  "tax",
  "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const REF_KINDS = [
  "pursuit_no",
  "debt_certificate_no",
  "office_ref",
  "claim_no",
  "invoice_no",
  "customer_no",
  "policy_no",
  "contract_no",
  "case_no",
  "member_no",
  "order_no",
  "qr_reference",
  "other",
] as const;
export type RefKind = (typeof REF_KINDS)[number];

export type DocStatus = "inbox" | "filed" | "trash";
export type InvoiceStatus = "open" | "reminded" | "paid" | "void";
export type PendingState = "queued" | "error" | null;

// ------------------------------------------------------------ DB rows
export interface DocumentRow {
  id: number;
  created_at: string;
  doc_date: string | null;
  scanned_at: string | null;
  scan_date_source: string | null;
  case_opened_date: string | null;
  title: string | null;
  doc_type: DocType | null;
  sender_id: number | null;
  sender_name: string | null;
  recipient: string | null;
  language: string | null;
  summary: string | null;
  tags: string; // JSON array
  tags_text: string;
  pdf_path: string | null; // relative to <data_root>/archive
  thumb_path: string | null;
  pages: number | null;
  content: string | null; // full OCR text
  file_sha256: string | null;
  text_hash: string | null;
  batch: string | null;
  status: DocStatus;
  reviewed: number;
  duplicate_of: number | null;
  dup_reason: string | null;
  amount: number | null;
  currency: string | null;
  due_date: string | null;
  invoice_ref: string | null;
  ai_json: string | null;
  flags: string; // JSON array
  pending: PendingState;
}

export interface PageRow {
  id: number;
  document_id: number;
  page_no: number | null; // null = dropped blank
  scan_order: number;
  text: string | null;
  is_blank: number;
  marker: string | null;
}

export interface SenderRow {
  id: number;
  key: string;
  name: string;
  uid: string | null;
  iban: string | null;
  address: string | null; // JSON address
  notes: string | null;
}

export interface InvoiceRow {
  id: number;
  document_id: number;
  sender_id: number | null;
  status: InvoiceStatus;
  amount: number | null;
  currency: string;
  amount_due: number | null;
  due_date: string | null;
  invoice_ref: string | null;
  qr_iban: string | null;
  qr_ref_type: string | null;
  qr_reference: string | null;
  qr_creditor: string | null; // JSON address
  qr_payload: string | null;
  swico: string | null; // JSON SwicoS1
  is_notification: number;
  reminder_level: number;
  parent_invoice_id: number | null;
  fees: number;
  paid_at: string | null;
  paid_note: string | null;
  paid_account_id: number | null;
}

export interface BankAccountRow {
  id: number;
  holder: string;
  bank: string | null;
  iban: string | null;
}

export interface DocRefRow {
  id: number;
  document_id: number;
  kind: RefKind;
  value: string;
  norm: string;
}

export type EventKind =
  | "batch-start"
  | "document"
  | "error"
  | "invoice"
  | "info"
  | "abort";

export interface EventRow {
  id: number;
  at: string;
  kind: EventKind;
  batch: string | null;
  document_id: number | null;
  message: string | null;
}

// ------------------------------------------------------------ QR-bill
export interface QrAddress {
  name: string;
  country: string | null;
  type: string | null; // 'S' structured | 'K' combined (legacy)
  street?: string | null;
  building?: string | null;
  postal_code?: string | null;
  town?: string | null;
  line1?: string | null;
  line2?: string | null;
}

export interface SwicoS1 {
  scheme: string;
  raw: string;
  tags?: Record<string, string>;
  invoice_no?: string | null;
  invoice_date?: string | null;
  customer_ref?: string | null;
  uid?: string | null;
  discounts?: Array<[pct: number, days: number]>;
  due_date?: string;
}

export interface QrBill {
  iban: string;
  is_qr_iban: boolean;
  creditor: QrAddress | null;
  debtor: QrAddress | null;
  amount: number | null;
  currency: string;
  ref_type: string;
  reference: string | null;
  message: string | null;
  swico: SwicoS1 | null;
  alt_procedures: string[];
  is_notification: boolean;
  problems: string[]; // tolerant reader: recorded, not fatal
  payload: string;
}

// ------------------------------------------------------------ extraction
export interface ExtractedRef {
  kind: RefKind;
  value: string;
  page?: number;
  evidence?: string;
}

export interface ExtractedDate {
  date: string;
  label: string;
  kind?:
    | "document"
    | "cover_letter"
    | "case_opened"
    | "execution"
    | "claim"
    | "birth"
    | "observation"
    | "due"
    | "mentioned";
  page?: number;
  evidence?: string;
}
export interface PursuitDetails {
  subtype: string;
  parties: Array<{
    role: "creditor" | "debtor" | "representative";
    name: string;
    page: number;
  }>;
  claim_amount: number | null;
  interest: number | null;
  fees: number | null;
  outstanding_amount: number | null;
  currency: string | null;
}

export interface CaseHandler {
  name: string;
  email: string | null;
  phone: string | null;
  routing_code: string | null;
  page: number;
  evidence: string;
}

// The normalized AI output -- the contract between the extraction
// service and the pipeline. Never trust the model: everything here has
// been through normalize().
export interface Extraction {
  ocr_source?: string;
  metadata_source?: string;
  metadata_warning?: string | null;
  doc_type: DocType;
  sender_name: string | null;
  sender_key: string;
  recipient_name: string | null;
  title: string | null;
  language: string | null;
  summary_en: string | null;
  tags: string[];
  doc_date: string | null;
  case_opened_date: string | null;
  date_evidence: string | null;
  pursuit: PursuitDetails | null;
  case_handler: CaseHandler | null;
  due_date: string | null;
  amount: number | null;
  currency: string | null;
  invoice_ref: string | null;
  reminder_level: number;
  reminder_fee: number | null;
  refs: ExtractedRef[];
  ref_dates: ExtractedDate[];
}

// ------------------------------------------------------------ config
export interface Config {
  metadata_provider?: "local-server" | "claude-cli" | "local";
  metadata_base_url?: string;
  metadata_model?: string;
  export_directory?: string;
  ocr_engine?: "paddleocr-vl" | "tesseract";
  ocr_python?: string;
  ocr_device?: string;
  data_root: string;
  scanner_device?: string;
  ocr_languages: string;
  default_payment_term_days: number;
  min_chars_nonblank: number;
}
