"""Download PP-OCRv5 release assets during build assembly only.

This helper is never called by the desktop app. It creates Paddle's local cache,
from which `prepare-paddle-runtime.ps1` copies the two required model folders.
"""

from paddleocr import PaddleOCR

PaddleOCR(
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    text_detection_model_name="PP-OCRv5_mobile_det",
    text_recognition_model_name="PP-OCRv5_mobile_rec",
    device="cpu",
)
print("PP-OCRv5 Mobile models prepared")
