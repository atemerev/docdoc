// SQLite schema and helpers. One writer (app/pipeline), WAL mode.
//
// FTS5 follows the external-content pattern: the index reads from
// documents by rowid, kept in sync by triggers (explicit rowid inserts and
// 'delete' inserts -- FTS5 does not auto-sync external content).
// sender_name/tags_text are denormalized onto documents so FTS can see them.
//
// Direct port of docdoc/db.py; schema text is byte-identical so both
// sides can share the live database during the migration.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("./config");

const SCHEMA = String.raw`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS senders (
    id INTEGER PRIMARY KEY,
    key TEXT UNIQUE NOT NULL,          -- canonical slug, e.g. 'swisscom'
    name TEXT NOT NULL,
    uid TEXT,                          -- Swiss UID from SWICO /30/ (digits only)
    iban TEXT,                         -- last-seen creditor IBAN
    address TEXT,                      -- JSON: last-seen creditor address
    notes TEXT
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,          -- ingest time, ISO
    doc_date TEXT,                     -- the document's own date, ISO
    title TEXT,
    doc_type TEXT,                     -- invoice|reminder|receipt|letter|contract|statement|return_slip|other
    sender_id INTEGER REFERENCES senders(id),
    sender_name TEXT,                  -- denormalized for FTS
    recipient TEXT,
    language TEXT,
    summary TEXT,
    tags TEXT DEFAULT '[]',            -- JSON array
    tags_text TEXT DEFAULT '',         -- space-joined, for FTS
    pdf_path TEXT,                     -- relative to <data_root>/archive
    thumb_path TEXT,                   -- relative to <data_root>/thumbs
    pages INTEGER,
    content TEXT,                      -- full OCR text (canonical copy for FTS)
    file_sha256 TEXT,
    text_hash TEXT,                    -- sha256 of normalized OCR text
    batch TEXT,                        -- source batch stamp
    status TEXT DEFAULT 'inbox',       -- inbox|filed|trash
    reviewed INTEGER DEFAULT 0,
    duplicate_of INTEGER REFERENCES documents(id),
    dup_reason TEXT,                   -- exact-file|exact-text|invoice-fields|similar
    amount REAL,                       -- convenience copies of invoice fields
    currency TEXT,
    due_date TEXT,
    invoice_ref TEXT,
    ai_json TEXT,                      -- raw AI extraction
    flags TEXT DEFAULT '[]',           -- JSON: page-order-fixed, order-uncertain, blank-dropped:N, ...
    pending TEXT                       -- background queue: 'queued' until OCR+AI ran,
                                       -- 'error' if that failed, NULL when done
);
CREATE INDEX IF NOT EXISTS idx_documents_pending ON documents(pending)
    WHERE pending IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_sender ON documents(sender_id);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(file_sha256);
CREATE INDEX IF NOT EXISTS idx_documents_texthash ON documents(text_hash);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(doc_date);

CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER,                   -- position in final PDF (1-based); NULL = dropped blank
    scan_order INTEGER NOT NULL,       -- position as scanned
    text TEXT,
    is_blank INTEGER DEFAULT 0,
    marker TEXT                        -- detected page marker, e.g. '2/5'
);
CREATE INDEX IF NOT EXISTS idx_pages_doc ON pages(document_id);

CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY,
    holder TEXT NOT NULL,              -- account holder, e.g. 'Alexander Temerev'
    bank TEXT,                         -- e.g. 'Postfinance', 'UBS'
    iban TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY,
    document_id INTEGER UNIQUE NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES senders(id),
    status TEXT DEFAULT 'open',        -- open|reminded|paid|void
    amount REAL,
    currency TEXT DEFAULT 'CHF',
    amount_due REAL,                   -- current amount incl. reminder fees
    due_date TEXT,
    invoice_ref TEXT,                  -- human invoice number
    qr_iban TEXT,
    qr_ref_type TEXT,                  -- QRR|SCOR|NON
    qr_reference TEXT,
    qr_creditor TEXT,                  -- JSON address
    qr_payload TEXT,                   -- full SPC payload (for QR re-render)
    swico TEXT,                        -- parsed S1 JSON
    is_notification INTEGER DEFAULT 0, -- amount 0.00 = do-not-pay notification
    reminder_level INTEGER DEFAULT 0,  -- 0=original, 1=first reminder, ...
    parent_invoice_id INTEGER REFERENCES invoices(id),
    fees REAL DEFAULT 0,
    paid_at TEXT,
    paid_note TEXT,
    paid_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due ON invoices(due_date);

CREATE TABLE IF NOT EXISTS doc_refs (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                -- invoice_no|customer_no|policy_no|contract_no|case_no|member_no|qr_reference|other
    value TEXT NOT NULL,               -- as printed on the document
    norm TEXT NOT NULL                 -- uppercase alnum only, for matching
);
CREATE INDEX IF NOT EXISTS idx_doc_refs_doc ON doc_refs(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_refs_norm ON doc_refs(norm);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,                -- batch-start|document|error|invoice|info
    batch TEXT,
    document_id INTEGER,
    message TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
    title, content, sender_name, tags_text,
    content='documents', content_rowid='id',
    tokenize = "unicode61 remove_diacritics 2 tokenchars '-_'",
    prefix = '2 3'
);

CREATE TRIGGER IF NOT EXISTS doc_fts_ai AFTER INSERT ON documents BEGIN
    INSERT INTO doc_fts(rowid, title, content, sender_name, tags_text)
    VALUES (new.id, new.title, new.content, new.sender_name, new.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS doc_fts_ad AFTER DELETE ON documents BEGIN
    INSERT INTO doc_fts(doc_fts, rowid, title, content, sender_name, tags_text)
    VALUES ('delete', old.id, old.title, old.content, old.sender_name, old.tags_text);
END;
CREATE TRIGGER IF NOT EXISTS doc_fts_au AFTER UPDATE ON documents BEGIN
    INSERT INTO doc_fts(doc_fts, rowid, title, content, sender_name, tags_text)
    VALUES ('delete', old.id, old.title, old.content, old.sender_name, old.tags_text);
    INSERT INTO doc_fts(rowid, title, content, sender_name, tags_text)
    VALUES (new.id, new.title, new.content, new.sender_name, new.tags_text);
END;
`;

// seeded once, when the bank_accounts table is first created; fixed ids +
// OR IGNORE make concurrent first connections idempotent
const PRESET_ACCOUNTS = [
  [1, "Alexander Temerev", "Postfinance"],
  [2, "Alexander Temerev", "UBS"],
  [3, "Liudmila Rozanova", "Postfinance"],
  [4, "Reactivity Sarl", "UBS"],
];

function connect(dbFile) {
  const file = dbFile || config.dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const con = new Database(file, { timeout: 30000 });
  con.pragma("foreign_keys = ON");
  const seedAccounts = !con.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_accounts'`
  ).get();
  migrate(con);
  con.exec(SCHEMA);
  if (seedAccounts) {
    const ins = con.prepare(
      "INSERT OR IGNORE INTO bank_accounts(id, holder, bank) VALUES (?,?,?)");
    for (const row of PRESET_ACCOUNTS) ins.run(...row);
  }
  return con;
}

function migrate(con) {
  // Additive upgrades for existing databases -- SCHEMA only creates,
  // it cannot add columns to live tables. Runs before SCHEMA so new
  // indexes on new columns apply.
  const cols = (table) => new Set(
    con.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  const doc = cols("documents");
  if (doc.size && !doc.has("pending"))
    con.exec("ALTER TABLE documents ADD COLUMN pending TEXT");
  const inv = cols("invoices");
  if (inv.size && !inv.has("paid_account_id"))
    con.exec(`ALTER TABLE invoices ADD COLUMN paid_account_id INTEGER
              REFERENCES bank_accounts(id) ON DELETE SET NULL`);
}

// Normalize text for indexing/search: ss for ß (unicode61 doesn't fold it).
const fold = (text) => (text || "").replace(/ß/g, "ss");

const nowIso = () => new Date().toISOString().slice(0, 19);

function event(con, kind, message, { batch = null, documentId = null, at = null } = {}) {
  con.prepare(
    "INSERT INTO events(at, kind, batch, document_id, message) VALUES (?,?,?,?,?)"
  ).run(at || nowIso(), kind, batch, documentId, message);
}

function upsertSender(con, key, name, { uid = null, iban = null, address = null } = {}) {
  // Create or enrich a sender; never overwrite good data with null.
  const addr = address ? JSON.stringify(address) : null;
  const row = con.prepare("SELECT * FROM senders WHERE key=?").get(key);
  if (!row) {
    return con.prepare(
      "INSERT INTO senders(key, name, uid, iban, address) VALUES (?,?,?,?,?)"
    ).run(key, name, uid, iban, addr).lastInsertRowid;
  }
  con.prepare(
    `UPDATE senders SET name=COALESCE(?, name), uid=COALESCE(?, uid),
     iban=COALESCE(?, iban), address=COALESCE(?, address) WHERE id=?`
  ).run(name, uid, iban, addr, row.id);
  return row.id;
}

// Normalize an internal reference for matching: uppercase alnum only.
const normRef = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function addRefs(con, documentId, refs) {
  // refs: iterable of [kind, value]. Skips short/duplicate values.
  const seen = new Set();
  const ins = con.prepare(
    "INSERT INTO doc_refs(document_id, kind, value, norm) VALUES (?,?,?,?)");
  for (const [kind, value] of refs) {
    const n = normRef(value);
    if (n.length < 4 || seen.has(n)) continue;   // too short to be a meaningful ID
    seen.add(n);
    ins.run(documentId, kind, String(value).trim(), n);
  }
}

function relatedDocuments(con, documentId) {
  // Documents sharing any internal reference with this one.
  return con.prepare(
    `SELECT DISTINCT d.id, d.title, d.doc_type, d.doc_date, d.created_at,
            d.sender_name, a.kind, a.value
     FROM doc_refs a
     JOIN doc_refs b ON b.norm = a.norm AND b.document_id != a.document_id
     JOIN documents d ON d.id = b.document_id AND d.status != 'trash'
     WHERE a.document_id = ?
     ORDER BY COALESCE(d.doc_date, d.created_at)`
  ).all(documentId);
}

function search(con, query, limit = 100) {
  // FTS search-as-you-type: each token quoted, last token prefixed.
  const tokens = fold(query).split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.replace(/[*"]/g, "").trim());
  if (!tokens.length) return [];
  const match = tokens.slice(0, -1).map((t) => `"${t}"`).join(" ")
    + ` "${tokens[tokens.length - 1]}"*`;
  return con.prepare(
    `SELECT d.*, snippet(doc_fts, 1, '<b>', '</b>', ' … ', 12) AS snip,
            bm25(doc_fts, 5.0, 1.0, 3.0, 2.0) AS rank
     FROM doc_fts JOIN documents d ON d.id = doc_fts.rowid
     WHERE doc_fts MATCH ? AND d.status != 'trash'
     ORDER BY rank LIMIT ?`
  ).all(match.trim(), limit);
}

module.exports = { SCHEMA, PRESET_ACCOUNTS, connect, fold, nowIso, event,
                   upsertSender, normRef, addRefs, relatedDocuments, search };
