"""Configuration: JSON file at ~/.config/docdoc/config.json, editable
from the app's Settings page. Unknown keys are preserved."""

import json
import os

CONFIG_PATH = os.path.expanduser("~/.config/docdoc/config.json")

DEFAULTS = {
    # storage
    "data_root": "/pool/docdoc",           # archive/, originals/, thumbs/, docdoc.db
    "scans_dir": "~/Scans",                # where the scanner daemon drops batches
    "keep_originals": True,                # move raw scans to originals/ (False = delete)
    # OCR
    "ocr_languages": "deu+fra+ita+eng",
    "ocr_engine": "tesseract",             # tesseract (via ocrmypdf); pluggable
    # AI understanding
    "ai_provider": "claude-cli",           # claude-cli | none
    "ai_model": "sonnet",                  # model passed to claude -p
    "ai_send_images": True,                # send page images (vision), not just text
    "ai_max_pages": 4,                     # pages sent to AI per document (first N)
    # behaviour
    "default_payment_term_days": 30,       # Swiss convention when no /40/ tag
    "blank_page_drop": True,               # drop blank duplex backsides from PDF
    "min_chars_nonblank": 12,              # OCR chars below this = blank candidate
}


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH) as f:
            cfg.update(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    cfg["data_root"] = os.path.expanduser(cfg["data_root"])
    cfg["scans_dir"] = os.path.expanduser(cfg["scans_dir"])
    return cfg


def save(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
    os.replace(tmp, CONFIG_PATH)


def db_path(cfg=None):
    cfg = cfg or load()
    return os.path.join(cfg["data_root"], "docdoc.db")
