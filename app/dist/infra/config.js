"use strict";
// Configuration: JSON file at ~/.config/docdoc/config.json, editable
// from the app's Settings page. Unknown keys are preserved.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbPath = exports.DEFAULTS = exports.CONFIG_PATH = void 0;
exports.load = load;
exports.save = save;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
exports.CONFIG_PATH = path.join(os.homedir(), ".config", "docdoc", "config.json");
exports.DEFAULTS = {
    // storage
    data_root: "/pool/docdoc", // archive/, originals/, thumbs/, docdoc.db
    scans_dir: "~/Scans", // where scan batches land
    keep_originals: true, // move raw scans to originals/ (false = delete)
    // OCR
    ocr_languages: "deu+fra+ita+eng",
    ocr_engine: "tesseract", // tesseract (via ocrmypdf); pluggable
    // AI understanding
    ai_provider: "claude-cli", // claude-cli | local-vllm | none
    ai_model: "sonnet", // model passed to claude -p
    ai_base_url: "http://localhost:8000/v1", // local-vllm OpenAI-compatible endpoint
    ai_send_images: true, // send page images (vision), not just text
    ai_max_pages: 4, // pages sent to AI per document (first N)
    // behaviour
    default_payment_term_days: 30, // Swiss convention when no /40/ tag
    blank_page_drop: true, // drop blank duplex backsides from PDF
    min_chars_nonblank: 12, // OCR chars below this = blank candidate
};
const expand = (p) => p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
function load() {
    const cfg = { ...exports.DEFAULTS };
    try {
        Object.assign(cfg, JSON.parse(fs.readFileSync(exports.CONFIG_PATH, "utf-8")));
    }
    catch { /* first run / unreadable -> defaults */ }
    cfg.data_root = expand(cfg.data_root);
    cfg.scans_dir = expand(cfg.scans_dir);
    return cfg;
}
function save(cfg) {
    fs.mkdirSync(path.dirname(exports.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(exports.CONFIG_PATH + ".tmp", JSON.stringify(cfg, Object.keys(cfg).sort(), 2));
    fs.renameSync(exports.CONFIG_PATH + ".tmp", exports.CONFIG_PATH);
}
const dbPath = (cfg) => path.join((cfg ?? load()).data_root, "docdoc.db");
exports.dbPath = dbPath;
