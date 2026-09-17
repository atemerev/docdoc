"""Foreground PaddleOCR-VL 1.6: page layout, transcription and invisible text.

The worker exits after each scan. Original PDF content is copied without image
recompression. Born-digital text is retained; scanner originals are re-read.
"""
import argparse
import html
import json
import os
import re
from pathlib import Path

import pymupdf as fitz


def plain_text(value):
    # Paddle emits HTML for superscripts and tables even with Markdown disabled.
    value = re.sub(r"</?(?:br|p|div|tr)\b[^>]*>", "\n", value, flags=re.I)
    value = re.sub(r"</(?:td|th)\s*>", "\t", value, flags=re.I)
    value = re.sub(r"</?(?:sup|sub|b|i|em|strong|table|thead|tbody|td|th)\b[^>]*>", "", value, flags=re.I)
    return html.unescape(value).strip()


def add_text(page, blocks, width, height):
    font = fitz.Font("cjk")
    for block in blocks:
        text = block.get("block_content", "").strip()
        if not text:
            continue
        x0, y0, x1, y1 = block["block_bbox"]
        rect = fitz.Rect(x0 / width * page.rect.width, y0 / height * page.rect.height,
                         x1 / width * page.rect.width, y1 / height * page.rect.height) & page.rect
        if rect.is_empty:
            raise ValueError("OCR returned text outside the page")
        # Fit all recognized text in its detected region. Never silently truncate.
        size = min(12.0, rect.height / max(1, len(text.splitlines())) / 1.4)
        size = max(size, 1.0)
        while True:
            writer = fitz.TextWriter(page.rect)
            overflow = writer.fill_textbox(rect, text, font=font, fontsize=size, warn=None)
            if not overflow:
                writer.write_text(page, render_mode=3)
                break
            size *= 0.8
            if size < 0.1:
                raise ValueError("Cannot fit recognized text in its page region")


def recognize(source, destination, data_root, device, batch_size=None):
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "HuggingFace")
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(Path(data_root) / "ocr-cache"))
    os.environ.setdefault("HF_HOME", str(Path(data_root) / "huggingface"))
    # Bound CPU preprocessing on large workstations instead of oversubscribing
    # every core while the GPU handles inference. Respect explicit user tuning.
    os.environ.setdefault("OMP_NUM_THREADS", str(min(8, os.cpu_count() or 1)))
    batch_size = batch_size or (4 if device.startswith("gpu:") else 2)
    if batch_size < 1:
        raise ValueError("OCR batch size must be positive")
    pipeline = None
    with fitz.open(source) as doc, fitz.open() as output:
        output.insert_pdf(doc)
        texts = [""] * len(doc)
        completed = 0
        completed_pages = []

        def progress(active_pages=None, phase="reading"):
            print(json.dumps({"completed": completed, "total": len(doc),
                "completed_pages": completed_pages, "active_pages": active_pages or [], "phase": phase}), flush=True)

        progress(phase="loading")

        pending = []

        def read_batch():
            nonlocal pipeline, completed
            # Import the heavy runtime only when a page actually needs OCR.
            import numpy as np
            if pipeline is None:
                progress(phase="loading")
                from paddleocr import PaddleOCRVL
                cache = Path(os.environ["PADDLE_PDX_CACHE_HOME"]) / "official_models"
                options = {}
                for key, name in [("layout_detection_model_dir", "PP-DocLayoutV3_safetensors"),
                                  ("vl_rec_model_dir", "PaddleOCR-VL-1.6-0.9B")]:
                    if (cache / name / "model.safetensors").exists():
                        options[key] = str(cache / name)
                pipeline = PaddleOCRVL(pipeline_version="v1.6", engine="transformers",
                    device=device, use_queues=False, **options)
            progress([i + 1 for i in pending])
            images = []
            for index in pending:
                pix = doc[index].get_pixmap(dpi=200, colorspace=fitz.csRGB, alpha=False)
                # Paddle accepts BGR arrays. Avoid PNG compression, disk writes,
                # and decoding the same pixels again for every page.
                rgb = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
                images.append(rgb[:, :, ::-1].copy())
            results = pipeline.predict_iter(images, use_ocr_for_image_block=True,
                use_seal_recognition=True, format_block_content=False)
            count = 0
            for result in results:
                if count >= len(pending):
                    raise ValueError("OCR returned an unexpected page count")
                index = pending[count]
                data = result.json
                data = data.get("res", data)
                blocks = data["parsing_res_list"]
                for block in blocks:
                    block["block_content"] = plain_text(block.get("block_content", ""))
                texts[index] = "\n\n".join(b["block_content"].strip() for b in blocks if b.get("block_content", "").strip())
                height, width = images[count].shape[:2]
                add_text(output[index], blocks, width, height)
                count += 1
                completed += 1
                completed_pages.append(index + 1)
                progress([i + 1 for i in pending[count:]])
            if count != len(pending):
                raise ValueError("OCR returned an unexpected page count")
            pending.clear()

        for index, page in enumerate(doc):
            target = output[index]
            # Visible native PDF text is more faithful than re-OCR. Hidden OCR
            # is removed before rereading so repeated runs do not duplicate text.
            traces = page.get_texttrace()
            if traces and any(span["type"] != 3 for span in traces):
                texts[index] = page.get_text().strip()
                completed += 1
                completed_pages.append(index + 1)
                progress()
            else:
                if traces:
                    target.add_redact_annot(target.rect, fill=False)
                    target.apply_redactions(images=0, graphics=0, text=0)
                pending.append(index)
                if len(pending) == batch_size:
                    read_batch()
        if pending:
            read_batch()
        progress(phase="saving")
        output.set_metadata({"creator": "docdoc", "producer": "PaddleOCR-VL 1.6 / docdoc"})
        output.save(destination, garbage=3, deflate=True)
    Path(destination + ".json").write_text(json.dumps({"pageTexts": texts, "engine": "PaddleOCR-VL 1.6"}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    recognize(args.source, args.destination, args.data_root, args.device)
