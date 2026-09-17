// Typed access to the preload bridge (window.docdoc) and the view-model
// shapes the API returns to the renderer.

export interface DocRowVM {
  id: number;
  created_at: string;
  doc_date: string | null;
  scanned_at: string | null;
  scan_date_source: string | null;
  case_opened_date: string | null;
  title: string | null;
  doc_type: string | null;
  sender_id: number | null;
  sender_name: string | null;
  summary: string | null;
  tags: string;
  pages: number | null;
  batch: string | null;
  reviewed: number;
  duplicate_of: number | null;
  dup_reason: string | null;
  amount: number | null;
  currency: string | null;
  due_date: string | null;
  flags: string;
  pending: string | null;
  snip?: string;
}

export interface InvoiceVM {
  id: number;
  document_id: number;
  status: string;
  amount: number | null;
  currency: string;
  amount_due: number | null;
  due_date: string | null;
  invoice_ref: string | null;
  qr_iban: string | null;
  qr_ref_type: string | null;
  qr_reference: string | null;
  qr_payload: string | null;
  is_notification: number;
  reminder_level: number;
  fees: number;
  paid_at: string | null;
  paid_note: string | null;
  paid_account?: string;
  overdue?: number;
  reminder_count?: number;
  max_reminder_level?: number;
  title?: string | null;
  sender_name?: string | null;
  reviewed?: number;
  chain?: Array<{ doc_id: number; reminder_level: number }>;
}

export interface TimelineVM {
  date: string;
  label: string;
  kind: string;
  document_id: number | null;
}

export interface DetailVM extends DocRowVM {
  has_pdf: boolean;
  recognition: RecognitionVM;
  metadata_history: Array<{
    recorded_from: string;
    recorded_to: string | null;
    valid_from: string | null;
    source: string;
    snapshot: string;
  }>;
  sources: Array<{ key: string; bytes: number }>;
  review_history: Array<{ at: string; note: string; checks: string }>;
  pdf_abs: string | null;
  invoice: InvoiceVM | null;
  refs: import("../domain/types").ExtractedRef[];
  related: Array<{
    id: number;
    title: string | null;
    doc_type: string | null;
    doc_date: string | null;
    created_at: string;
    kind: string;
    value: string;
  }>;
  timeline: TimelineVM[];
  duplicates: number[];
}

export interface SenderVM {
  id: number;
  name: string;
  uid: string | null;
  iban: string | null;
  doc_count: number;
  last_doc: string | null;
}

export interface BankAccountVM {
  id: number;
  holder: string;
  bank: string | null;
  iban: string | null;
}

export interface EventVM {
  id: number;
  at: string;
  kind: string;
  batch: string | null;
  document_id: number | null;
  message: string | null;
}

export interface StatsVM {
  documents: number;
  inbox: number;
  unpaid_count: number;
  unpaid_total: number;
  overdue: number;
}

export interface StatusVM {
  busy: boolean;
  label: string;
  processing: import("../domain/progress").ProcessingProgress | null;
  background: import("../domain/progress").QueueProgress | null;
  queue_version: number;
}

export interface SettingsVM extends Record<string, unknown> {
  data_root: string;
}

interface DocdocBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  openExternal(id: number): Promise<void>;
  importFiles(options?: {group_id?: number; after_page_id?: number}): Promise<number | null>;
  backup(): Promise<string | null>;
  exportPdf(id: number): Promise<string | null>;
  onEvent(cb: (msg: { event: string; status?: StatusVM }) => void): void;
}

declare global {
  interface Window {
    docdoc: DocdocBridge;
  }
}

export const api = <T>(method: string, params?: unknown): Promise<T> =>
  window.docdoc.call(method, params) as Promise<T>;

export const bridge = (): DocdocBridge => window.docdoc;

export interface ReviewPageVM {
  id: number;
  group_id: number;
  position: number;
  text: string;
  marker: string | null;
  blank: number;
  excluded: number;
  issue: string | null;
  batch: string;
  source_page: number;
  ocr_source?: string | null;
}
export interface ReviewGroupVM {
  id: number;
  title: string;
  target_id: number | null;
  revision: number;
  phase: "pages" | "queued" | "processing" | "ready" | "error";
  queue_error: string | null;
  queue_note: string | null;
  scanned_at: string | null;
  recognition: RecognitionVM;
  pages: ReviewPageVM[];
  warnings: string[];
  needs_preparation: boolean;
  imports: Array<{ id: number; name: string; issue: string | null }>;
  related: Array<{
    id: number;
    title: string;
    sender_name: string;
    value: string;
  }>;
  other_groups: Array<{ id: number; title: string }>;
  queue_duplicates: Array<{ id: number; title: string }>;
  duplicate: { id: number | null; reason: string | null };
  metadata: {
    title: string | null;
    sender_name: string | null;
    doc_type: string | null;
    doc_date: string | null;
    case_opened_date: string | null;
    refs: import("../domain/types").ExtractedRef[];
  };
}
export interface RecognitionVM {
  source: string;
  warning: string | null;
  case_handler: import("../domain/types").CaseHandler | null;
  dates: import("../domain/types").ExtractedDate[];
  date_evidence: string | null;
  pursuit: import("../domain/types").PursuitDetails | null;
}
