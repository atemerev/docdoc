// Defaults and legacy location discovery. Current settings are stored in SQLite.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Config } from "../domain/types";
export const CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "docdoc",
  "config.json",
);
export const DEFAULTS: Config = {
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
export function load(): Config {
  const cfg = { ...DEFAULTS };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    /* first run */
  }
  cfg.data_root = process.env.DOCDOC_DB
    ? path.dirname(path.resolve(process.env.DOCDOC_DB))
    : cfg.data_root.startsWith("~")
      ? path.join(os.homedir(), cfg.data_root.slice(1))
      : cfg.data_root;
  return cfg;
}
export const dbPath = (cfg?: Config): string =>
  process.env.DOCDOC_DB
    ? path.resolve(process.env.DOCDOC_DB)
    : path.join((cfg ?? load()).data_root, "docdoc.db");
