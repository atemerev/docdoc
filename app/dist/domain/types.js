"use strict";
// The docdoc domain model. Everything that crosses a module boundary is
// typed here: database rows (the persisted shape), the AI extraction
// contract, the Swiss QR-bill value objects, and configuration.
//
// Layering: src/domain is pure (no I/O, no Electron, no DB imports),
// src/infra adapts the outside world (SQLite, CLI tools, image codecs),
// src/services orchestrates use cases, src/api is the renderer facade.
Object.defineProperty(exports, "__esModule", { value: true });
exports.REF_KINDS = exports.DOC_TYPES = void 0;
// ------------------------------------------------------------ vocabulary
exports.DOC_TYPES = [
    "invoice", "reminder", "receipt", "letter", "contract", "policy",
    "statement", "return_slip", "medical", "insurance", "tax", "other",
];
exports.REF_KINDS = [
    "invoice_no", "customer_no", "policy_no", "contract_no", "case_no",
    "member_no", "order_no", "qr_reference", "other",
];
