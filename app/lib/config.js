// Configuration: JSON file at ~/.config/docdoc/config.json, editable
// from the app's Settings page. Unknown keys are preserved.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_PATH = path.join(os.homedir(), ".config", "docdoc", "config.json");

const DEFAULTS = {
  // storage
  data_root: "/pool/docdoc",           // archive/, originals/, thumbs/, docdoc.db
  scans_dir: "~/Scans",                // where scan batches land
  keep_originals: true,                // move raw scans to originals/ (false = delete)
  // OCR
  ocr_languages: "deu+fra+ita+eng",
  ocr_engine: "tesseract",             // tesseract (via ocrmypdf); pluggable
  // AI understanding
  ai_provider: "claude-cli",           // claude-cli | local-vllm | none
  ai_model: "sonnet",                  // model passed to claude -p
  ai_base_url: "http://localhost:8000/v1", // local-vllm OpenAI-compatible endpoint
  ai_send_images: true,                // send page images (vision), not just text
  ai_max_pages: 4,                     // pages sent to AI per document (first N)
  // behaviour
  default_payment_term_days: 30,       // Swiss convention when no /40/ tag
  blank_page_drop: true,               // drop blank duplex backsides from PDF
  min_chars_nonblank: 12,              // OCR chars below this = blank candidate
};

const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function load() {
  const cfg = { ...DEFAULTS };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")));
  } catch {}
  cfg.data_root = expand(cfg.data_root);
  cfg.scans_dir = expand(cfg.scans_dir);
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH + ".tmp",
    JSON.stringify(cfg, Object.keys(cfg).sort(), 2));
  fs.renameSync(CONFIG_PATH + ".tmp", CONFIG_PATH);
}

const dbPath = (cfg) => path.join((cfg || load()).data_root, "docdoc.db");

module.exports = { CONFIG_PATH, DEFAULTS, load, save, dbPath };
