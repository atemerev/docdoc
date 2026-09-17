"""Portable PDF export: original pages, standard properties, XMP and attachments."""
import datetime as dt
import json
import re
import sys
import xml.etree.ElementTree as ET

import pymupdf as fitz


def pdf_date(value):
    if not value:
        return ""
    try:
        date = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            date = date.astimezone()
        return date.astimezone(dt.timezone.utc).strftime("D:%Y%m%d%H%M%SZ")
    except (ValueError, TypeError):
        return ""


def export(source, destination, metadata):
    doc = fitz.open(source)
    recognized = "\n\f\n".join(metadata["page_texts"])
    if len(metadata["page_texts"]) != len(doc):
        raise ValueError("PDF pages and recognized text do not agree")
    exported = dt.datetime.now(dt.timezone.utc).isoformat()
    metadata = {**metadata, "pdf_metadata_updated_at": exported}
    encoded = json.dumps(metadata, ensure_ascii=False, indent=2)
    refs = metadata.get("refs", [])
    keywords = "; ".join(str(x) for x in [metadata.get("doc_type"),
        *metadata.get("tags", []), *(r["value"] for r in refs)] if x)
    doc.set_metadata({"title": metadata.get("title") or "Scanned document",
        "author": metadata.get("sender_name") or "",
        "subject": metadata.get("summary") or metadata.get("doc_type") or "",
        "keywords": keywords, "creator": "docdoc", "producer": "docdoc / PyMuPDF",
        "creationDate": pdf_date(metadata.get("scanned_at")),
        "modDate": pdf_date(exported)})
    # This is a portable PDF with attachments, not a claim of PDF/A conformance.
    # Build fresh XMP so a source PDF/A-2 declaration cannot become misleading.
    namespaces = {"x": "adobe:ns:meta/", "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "dc": "http://purl.org/dc/elements/1.1/", "xmp": "http://ns.adobe.com/xap/1.0/",
        "pdf": "http://ns.adobe.com/pdf/1.3/", "docdoc": "urn:docdoc:metadata:1.0/"}
    for prefix, uri in namespaces.items():
        ET.register_namespace(prefix, uri)
    def tag(prefix, name):
        return "{" + namespaces[prefix] + "}" + name
    root = ET.Element(tag("x", "xmpmeta"))
    rdf = ET.SubElement(root, tag("rdf", "RDF"))
    desc = ET.SubElement(rdf, tag("rdf", "Description"), {tag("rdf", "about"): ""})
    def field(prefix, name, value):
        if value is not None:
            ET.SubElement(desc, tag(prefix, name)).text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "\n", str(value))
    for name, value in [("title", metadata.get("title")), ("description", metadata.get("summary"))]:
        alt = ET.SubElement(ET.SubElement(desc, tag("dc", name)), tag("rdf", "Alt"))
        ET.SubElement(alt, tag("rdf", "li"), {"{http://www.w3.org/XML/1998/namespace}lang": "x-default"}).text = value or ""
    seq = ET.SubElement(ET.SubElement(desc, tag("dc", "creator")), tag("rdf", "Seq"))
    ET.SubElement(seq, tag("rdf", "li")).text = metadata.get("sender_name") or ""
    field("pdf", "Keywords", keywords)
    field("xmp", "CreatorTool", "docdoc")
    field("xmp", "CreateDate", metadata.get("scanned_at"))
    field("xmp", "ModifyDate", exported)
    field("xmp", "MetadataDate", exported)
    for key in ["doc_date", "case_opened_date", "scanned_at", "scan_date_source", "doc_type", "recognition_source", "review_status"]:
        field("docdoc", key, metadata.get(key))
    field("docdoc", "recognizedText", recognized)
    field("docdoc", "metadataJSON", encoded)
    for element in root.iter():
        if element.text:
            element.text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "\n", element.text)
    doc.set_xml_metadata(ET.tostring(root, encoding="unicode"))
    # MuPDF appends name-tree entries without sorting. Rebuild in PDF byte order,
    # retaining any original attachments, so every PDF reader can find them.
    attachments = {}
    for name in doc.embfile_names():
        attachments[name] = (doc.embfile_get(name), doc.embfile_info(name))
    for name, content, description in [
        ("recognized-text.txt", recognized, "Recognized text in page order; form feed separates pages"),
        ("metadata.json", encoded, "Document metadata, references, date roles and recognition provenance")]:
        attachments[name] = (content.encode("utf-8"), {"filename": name, "ufilename": name, "description": description})
    for name in list(doc.embfile_names()):
        doc.embfile_del(name)
    def pdf_name_bytes(name):
        encoded = fitz.get_pdf_str(name)
        return bytes.fromhex(encoded[1:-1]) if encoded.startswith("<") else name.encode("ascii")
    for name in sorted(attachments, key=pdf_name_bytes):
        content, info = attachments[name]
        doc.embfile_add(name, content, filename=info.get("filename", name),
            ufilename=info.get("ufilename", name), desc=info.get("description", ""))
    doc.save(destination, garbage=3, deflate=True)
    doc.close()


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2], json.load(sys.stdin))
