"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const strict_1 = __importDefault(require("node:assert/strict"));
const db = __importStar(require("../infra/db"));
const store = __importStar(require("../infra/storage"));
const config_1 = require("../infra/config");
async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-storage-"));
    const con = db.connect(path.join(dir, "docdoc.db"));
    store.init(con);
    try {
        const cfg = { ...config_1.DEFAULTS, data_root: dir };
        fs.mkdirSync(path.join(dir, "archive/2026"), { recursive: true });
        fs.mkdirSync(path.join(dir, "originals/batch"), { recursive: true });
        fs.mkdirSync(path.join(dir, "thumbs"), { recursive: true });
        const pdf = Buffer.from("%PDF-legacy-data"), original = Buffer.from("original, including excluded page");
        fs.writeFileSync(path.join(dir, "archive/2026/original.pdf"), pdf);
        fs.writeFileSync(path.join(dir, "originals/batch/page.png"), original);
        fs.writeFileSync(path.join(dir, "thumbs/1.jpg"), Buffer.from("thumbnail"));
        con
            .prepare("INSERT INTO documents(id,created_at,pdf_path,thumb_path,title,content) VALUES (1,?,'2026/original.pdf','1.jpg','Legacy','searchable legacy text')")
            .run(db.nowIso());
        await store.migrateFiles(con, cfg);
        (0, strict_1.default)(fs.existsSync(path.join(dir, "docdoc-before-single-file.db")));
        strict_1.default.deepEqual(store.get(con, store.docKey(1)).data, pdf);
        strict_1.default.deepEqual(store.get(con, "legacy/originals/batch/page.png").data, original);
        strict_1.default.equal(con.prepare("SELECT COUNT(*) n FROM blobs").get().n, 3);
        (0, strict_1.default)(fs.existsSync(path.join(dir, "archive/2026/original.pdf")));
        await store.migrateFiles(con, cfg); // idempotent even when originals no longer exist
        fs.rmSync(path.join(dir, "archive"), { recursive: true });
        fs.rmSync(path.join(dir, "originals"), { recursive: true });
        fs.rmSync(path.join(dir, "thumbs"), { recursive: true });
        await store.migrateFiles(con, cfg);
        const backup = path.join(dir, "backup.db");
        await store.backup(con, backup);
        const restored = db.connect(backup);
        store.init(restored);
        strict_1.default.deepEqual(store.get(restored, store.docKey(1)).data, pdf);
        strict_1.default.equal(db.search(restored, "legacy")[0].id, 1);
        strict_1.default.equal(store.setting(restored, "config").ocr_languages, cfg.ocr_languages);
        restored.close();
        // Upgrade a pending scan from the checkbox-era schema.
        con.exec("ALTER TABLE review_pages DROP COLUMN exclusion_override");
        con
            .prepare("INSERT INTO review_groups(id,title,created_at) VALUES (1,'Pending',?)")
            .run(db.nowIso());
        con.exec("INSERT INTO review_pages(id,group_id,source_key,source_page,position,blank,excluded,batch) VALUES (1,1,'legacy/originals/batch/page.png',1,1,1,0,'scan'),(2,1,'legacy/originals/batch/page.png',2,2,0,1,'scan')");
        store.init(con);
        strict_1.default.equal(con.prepare("SELECT excluded FROM review_pages WHERE id=1").get().excluded, 1);
        strict_1.default.equal(con
            .prepare("SELECT exclusion_override FROM review_pages WHERE id=2")
            .get().exclusion_override, 1);
        con.exec("UPDATE review_pages SET excluded=0,exclusion_override=0 WHERE id=1");
        store.init(con);
        strict_1.default.equal(con.prepare("SELECT excluded FROM review_pages WHERE id=1").get().excluded, 0);
        console.log("Legacy migration, byte deduplication, idempotency and one-file backup passed.");
    }
    finally {
        con.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "docdoc-missing-"));
    const bad = db.connect(path.join(broken, "docdoc.db"));
    store.init(bad);
    try {
        bad
            .prepare("INSERT INTO documents(created_at,pdf_path) VALUES (?,'missing.pdf')")
            .run(db.nowIso());
        await strict_1.default.rejects(store.migrateFiles(bad, { ...config_1.DEFAULTS, data_root: broken }), /Missing stored file/);
        (0, strict_1.default)(!store.setting(bad, "files_migrated"));
        strict_1.default.equal(bad.prepare("SELECT COUNT(*) n FROM documents").get()
            .n, 1);
        console.log("Missing legacy PDF fails migration without losing the original row.");
    }
    finally {
        bad.close();
        fs.rmSync(broken, { recursive: true, force: true });
    }
}
void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
