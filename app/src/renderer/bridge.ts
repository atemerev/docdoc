// Typed access to the preload bridge (window.docdoc) and the view-model
// shapes the API returns to the renderer.

export interface DocRowVM {
  id: number;
  created_at: string;
  doc_date: string | null;
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
  pdf_abs: string | null;
  invoice: InvoiceVM | null;
  refs: Array<{ kind: string; value: string }>;
  related: Array<{ id: number; title: string | null; doc_type: string | null;
                   doc_date: string | null; created_at: string;
                   kind: string; value: string }>;
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
  scanning: Array<{ batch: string; pages: number }>;
  waiting: string[];
  queued: string[];
  processing: Array<{ batch: string; label: string | null;
                      pct: number | null; ceil: number | null }>;
  watcher_alive: boolean;
  scanner_alive: boolean;
  scanner_online: boolean;
  busy: boolean;
}

export interface SettingsVM extends Record<string, unknown> {
  data_root: string;
}

interface DocdocBridge {
  call(method: string, params?: unknown): Promise<unknown>;
  openExternal(id: number): void;
  openFolder(id: number): void;
  onEvent(cb: (msg: { event: string }) => void): void;
}

declare global {
  interface Window { docdoc: DocdocBridge }
}

export const api = <T>(method: string, params?: unknown): Promise<T> =>
  window.docdoc.call(method, params) as Promise<T>;

export const bridge = (): DocdocBridge => window.docdoc;
