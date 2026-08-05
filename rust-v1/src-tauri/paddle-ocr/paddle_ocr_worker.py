#!/usr/bin/env python3
"""Local PP-OCRv5 bridge used by the desktop application.

The program accepts one image path and writes exactly one JSON object to stdout.
It deliberately has no network calls: model files must already exist in the
bundled Paddle runtime or in PaddleOCR's local model cache.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import sys
from pathlib import Path
from typing import Any


def as_data(value: Any) -> dict[str, Any]:
    """Normalise PaddleOCR 3.x result objects across patch releases."""
    if hasattr(value, "json"):
        value = value.json
        if callable(value):
            value = value()
    if isinstance(value, str):
        value = json.loads(value)
    if isinstance(value, dict) and isinstance(value.get("res"), dict):
        return value["res"]
    return value if isinstance(value, dict) else {}


def box_bounds(box: Any) -> tuple[float, float, float, float] | None:
    if not isinstance(box, list) or not box:
        return None
    if len(box) == 4 and all(isinstance(item, (int, float)) for item in box):
        x0, y0, x1, y1 = (float(item) for item in box)
        return x0, y0, x1, y1
    points = [point for point in box if isinstance(point, list) and len(point) >= 2]
    if not points:
        return None
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return min(xs), min(ys), max(xs), max(ys)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    image_path = Path(args.image)
    if not image_path.is_file():
        raise RuntimeError("Input figure image does not exist")

    bundle_root = Path(__file__).resolve().parent
    det_model = bundle_root / "models" / "PP-OCRv5_mobile_det"
    rec_model = bundle_root / "models" / "PP-OCRv5_mobile_rec"
    if not det_model.is_dir() or not rec_model.is_dir():
        raise RuntimeError(
            "Bundled PP-OCRv5 Mobile models are missing. Reinstall the application; "
            "the local engine never downloads models at runtime."
        )

    # PaddleOCR may log model information to stdout. Keep that separate so the
    # Rust bridge can always parse the final JSON result deterministically.
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCR

        ocr = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_detection_model_dir=str(det_model),
            text_recognition_model_name="PP-OCRv5_mobile_rec",
            text_recognition_model_dir=str(rec_model),
            device="cpu",
        )
        predictions = list(ocr.predict(input=str(image_path)))

    from PIL import Image

    with Image.open(image_path) as image:
        image_width, image_height = image.size

    words: list[dict[str, Any]] = []
    for prediction in predictions:
        data = as_data(prediction)
        texts = data.get("rec_texts", [])
        scores = data.get("rec_scores", [])
        boxes = data.get("rec_boxes") or data.get("rec_polys") or []
        for index, text in enumerate(texts):
            bounds = box_bounds(boxes[index]) if index < len(boxes) else None
            if not bounds or not str(text).strip():
                continue
            x0, y0, x1, y1 = bounds
            score = float(scores[index]) if index < len(scores) else 0.0
            words.append({
                "text": str(text),
                "left": max(0.0, min(100.0, x0 / max(image_width, 1) * 100.0)),
                "top": max(0.0, min(100.0, y0 / max(image_height, 1) * 100.0)),
                "width": max(0.0, min(100.0, (x1 - x0) / max(image_width, 1) * 100.0)),
                "height": max(0.0, min(100.0, (y1 - y0) / max(image_height, 1) * 100.0)),
                "confidence": max(0.0, min(100.0, score * 100.0)),
            })

    print(json.dumps({"engine": "PaddleOCR 3.x PP-OCRv5 Mobile", "words": words}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Printed to stderr for a user-actionable Rust error.
        print(f"PaddleOCR local worker failed: {error}", file=sys.stderr)
        raise SystemExit(1)
