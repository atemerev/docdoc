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
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbPath = exports.DEFAULTS = exports.CONFIG_PATH = void 0;
exports.load = load;
// Defaults and legacy location discovery. Current settings are stored in SQLite.
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
exports.CONFIG_PATH = path.join(os.homedir(), ".config", "docdoc", "config.json");
exports.DEFAULTS = {
    metadata_provider: "local-server",
    metadata_base_url: "http://127.0.0.1:8080/v1",
    metadata_model: "",
    export_directory: path.join(os.homedir(), "Documents", "scans"),
    ocr_engine: "paddleocr-vl",
    ocr_python: "/pool/docdoc/ocr-venv/bin/python",
    ocr_device: "gpu:2",
    data_root: "/pool/docdoc",
    ocr_languages: "deu+fra+ita+eng",
    default_payment_term_days: 30,
    min_chars_nonblank: 12,
};
function load() {
    const cfg = { ...exports.DEFAULTS };
    try {
        Object.assign(cfg, JSON.parse(fs.readFileSync(exports.CONFIG_PATH, "utf8")));
    }
    catch {
        /* first run */
    }
    cfg.data_root = process.env.DOCDOC_DB
        ? path.dirname(path.resolve(process.env.DOCDOC_DB))
        : cfg.data_root.startsWith("~")
            ? path.join(os.homedir(), cfg.data_root.slice(1))
            : cfg.data_root;
    return cfg;
}
const dbPath = (cfg) => process.env.DOCDOC_DB
    ? path.resolve(process.env.DOCDOC_DB)
    : path.join((cfg ?? load()).data_root, "docdoc.db");
exports.dbPath = dbPath;
