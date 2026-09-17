"""Verify export text placement and re-OCR do not change visible page content."""
import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import types
import sys
import subprocess
import unittest
from unittest.mock import patch
import pymupdf as fitz
import numpy as np  # Keep the extension loaded outside patched sys.modules.
from ocr_pdf import recognize
from export_pdf import export

class PdfTests(unittest.TestCase):
    def test_hidden_ocr_replacement_native_text_and_blank(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp=Path(tmp)
            source=tmp/'source.pdf';out=tmp/'read.pdf'
            d=fitz.open()
            p=d.new_page(width=600,height=800)
            p.draw_rect(fitz.Rect(30,40,400,200),color=(0,0,0))
            p.insert_text((40,80),'OLD OCR MUST DISAPPEAR',render_mode=3)
            p=d.new_page(width=600,height=800)
            p.insert_text((40,80),'Native PDF text remains')
            d.new_page(width=600,height=800)
            d.save(source)
            calls=[]
            class Result:
                def __init__(self,blocks):self.blocks=blocks
                @property
                def json(self):return {'res': {'parsing_res_list': self.blocks}}
            class Pipeline:
                def __init__(self,**kwargs):self.kwargs=kwargs
                def predict_iter(self,images,**kwargs):
                    calls.append(images)
                    for i, image in enumerate(images):
                        yield Result([{'block_bbox':[120,140,800,260], 'block_content':'Réduction à Genève - Alexander Temerev - 60%'}] if i==0 else [])
            progress_output=io.StringIO()
            with redirect_stdout(progress_output), patch.dict(sys.modules,{'paddleocr':types.SimpleNamespace(PaddleOCRVL=Pipeline)}):
                recognize(str(source),str(out),str(tmp),'cpu')
            events=[json.loads(line) for line in progress_output.getvalue().splitlines()]
            self.assertEqual(events[0]['phase'],'loading')
            self.assertEqual(events[-1]['phase'],'saving')
            self.assertEqual(events[-1]['completed_pages'],[2,1,3], 'native pages may finish before earlier OCR pages')
            self.assertTrue(any(e['active_pages']==[1,3] for e in events))
            for event in events:
                self.assertEqual(event['completed'],len(event['completed_pages']))
                self.assertFalse(set(event['completed_pages']) & set(event['active_pages']))
            updated=fitz.open(out)
            self.assertEqual(len(calls),1)
            self.assertEqual(len(calls[0]),2)
            for a,b in zip(d,updated):self.assertEqual(a.get_pixmap().samples,b.get_pixmap().samples)
            self.assertNotIn('OLD OCR',updated[0].get_text())
            self.assertIn('Genève',updated[0].get_text())
            self.assertIn('Alexander Temerev',updated[0].get_text())
            self.assertIn('Native PDF',updated[1].get_text())
            self.assertFalse(updated[2].get_text().strip())
            text=json.loads(Path(str(out)+'.json').read_text())['pageTexts']
            final=tmp/'export.pdf'
            export(str(out),str(final),{'title':'Réduction & dates','page_texts':text,'doc_date':'2026-09-14','scanned_at':'2026-09-14T20:56:05+02:00'})
            e=fitz.open(final)
            subprocess.run(['qpdf','--check',str(final)],check=True,capture_output=True)
            self.assertEqual(e.embfile_get('recognized-text.txt').decode(),'\n\f\n'.join(text))
            import xml.etree.ElementTree as ET
            ET.fromstring(e.get_xml_metadata())
            for a,b in zip(d,e):self.assertEqual(a.get_pixmap().samples,b.get_pixmap().samples)

    def test_native_text_does_not_import_ocr_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'native.pdf';out=Path(tmp)/'out.pdf'
            with fitz.open() as d:
                d.new_page().insert_text((40,80),'Keep native text')
                d.save(source)
            with patch.dict(sys.modules, {'paddleocr': None}):
                recognize(str(source),str(out),tmp,'cpu')
            self.assertEqual(json.loads(Path(str(out)+'.json').read_text())['pageTexts'],['Keep native text'])

    def test_batched_order_bounded_memory_and_page_count_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'pages.pdf';out=Path(tmp)/'out.pdf'
            with fitz.open() as d:
                for i in range(5):
                    p=d.new_page(width=100,height=120)
                    p.draw_rect(p.rect,color=(1,0,0),fill=(1,0,0))
                d.save(source)
            batches=[]
            class Pipeline:
                def __init__(self,**kwargs):pass
                def predict_iter(self,images,**kwargs):
                    batches.append(len(images))
                    for image in images:
                        selftest.assertEqual(tuple(image[100,100]),(0,0,255), 'Paddle receives BGR')
                        yield types.SimpleNamespace(json={'res':{'parsing_res_list':[]}})
            selftest=self
            with patch.dict(sys.modules,{'paddleocr':types.SimpleNamespace(PaddleOCRVL=Pipeline)}):
                recognize(str(source),str(out),tmp,'gpu:2',batch_size=2)
            self.assertEqual(batches,[2,2,1])
            self.assertEqual(len(json.loads(Path(str(out)+'.json').read_text())['pageTexts']),5)
            with patch.object(Pipeline,'predict_iter',return_value=iter([])):
                with patch.dict(sys.modules,{'paddleocr':types.SimpleNamespace(PaddleOCRVL=Pipeline)}):
                    with self.assertRaisesRegex(ValueError,'page count'):
                        recognize(str(source),str(out),tmp,'cpu')

if __name__=='__main__':unittest.main()
