"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeMetadataHistory = initializeMetadataHistory;
exports.recordMetadata = recordMetadata;
exports.metadataAsOf = metadataAsOf;
const document_dates_1 = require("../domain/document_dates");
/** Valid time is the document's effective date; recorded time is when docdoc
 * knew this interpretation. Corrections close recorded intervals, never erase
 * prior assertions or overwrite the immutable capture timestamp. */
function initializeMetadataHistory(con) {
    con.exec(`CREATE TABLE IF NOT EXISTS document_metadata_versions (
    id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id),
    valid_from TEXT, valid_to TEXT, recorded_from TEXT NOT NULL, recorded_to TEXT,
    source TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS document_metadata_current ON document_metadata_versions(document_id) WHERE recorded_to IS NULL;
    CREATE INDEX IF NOT EXISTS document_metadata_recorded ON document_metadata_versions(document_id,recorded_from,recorded_to);`);
    con.transaction(() => {
        // Old versions recorded save time only. Preserve it as an explicitly labeled
        // legacy approximation rather than claiming the physical scan time is known.
        con.exec("UPDATE documents SET scanned_at=created_at,scan_date_source='legacy_recorded_at' WHERE scanned_at IS NULL");
        const rows = con
            .prepare("SELECT id FROM documents WHERE id NOT IN (SELECT document_id FROM document_metadata_versions)")
            .all();
        for (const row of rows)
            recordMetadata(con, row.id, "Legacy metadata first observed");
    })();
}
function recordMetadata(con, id, source) {
    con.transaction(() => {
        const doc = con
            .prepare(`SELECT title,doc_type,sender_id,sender_name,recipient,doc_date,case_opened_date,scanned_at,scan_date_source,amount,currency,ai_json FROM documents WHERE id=?`)
            .get(id);
        if (!doc)
            throw new Error("Document not found.");
        const refs = con
            .prepare("SELECT kind,value,page,evidence FROM doc_refs WHERE document_id=? ORDER BY kind,norm")
            .all(id);
        const snapshot = JSON.stringify({ ...doc, refs });
        const previous = con
            .prepare("SELECT * FROM document_metadata_versions WHERE document_id=? AND recorded_to IS NULL")
            .get(id);
        if (previous?.snapshot === snapshot)
            return;
        const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.recorded_from) + 1 : 0)).toISOString();
        if (previous)
            con
                .prepare("UPDATE document_metadata_versions SET recorded_to=? WHERE id=?")
                .run(now, previous.id);
        con
            .prepare("INSERT INTO document_metadata_versions(document_id,valid_from,recorded_from,source,snapshot) VALUES (?,?,?,?,?)")
            .run(id, doc.doc_date ?? null, now, source, snapshot);
    })();
}
function metadataAsOf(con, id, knownAt, effectiveOn) {
    if (!Number.isFinite(Date.parse(knownAt)))
        throw new Error("A valid recorded timestamp is required.");
    if (effectiveOn && !(0, document_dates_1.validDate)(effectiveOn))
        throw new Error("A valid effective date is required.");
    const known = new Date(knownAt).toISOString();
    const row = con
        .prepare(`SELECT * FROM document_metadata_versions WHERE document_id=? AND recorded_from<=? AND (recorded_to IS NULL OR recorded_to>?) ${effectiveOn ? "AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)" : ""} ORDER BY recorded_from DESC LIMIT 1`)
        .get(id, known, known, ...(effectiveOn ? [effectiveOn, effectiveOn] : []));
    return row ? { ...row, metadata: JSON.parse(row.snapshot) } : null;
}
