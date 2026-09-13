#!/usr/bin/env python3
"""Persistent local PaddleOCR worker using JSON lines over stdin/stdout."""

import contextlib
import base64
import json
import os
import sys

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

with contextlib.redirect_stdout(sys.stderr):
    import cv2
    import numpy as np
    from paddleocr import PaddleOCR

    OCR = PaddleOCR(
        lang="pt",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,
        cpu_threads=4,
        text_rec_score_thresh=0.30,
    )


def recognize(image_base64):
    encoded = np.frombuffer(base64.b64decode(image_base64), dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("imagem local não pôde ser decodificada")
    with contextlib.redirect_stdout(sys.stderr):
        results = list(OCR.predict(image))
    if not results:
        return {"lines": [], "text": ""}
    result = results[0]
    raw_texts = result.get("rec_texts")
    raw_scores = result.get("rec_scores")
    raw_boxes = result.get("rec_boxes")
    texts = list(raw_texts) if raw_texts is not None else []
    scores = list(raw_scores) if raw_scores is not None else []
    boxes = list(raw_boxes) if raw_boxes is not None else []
    lines = []
    for index, text in enumerate(texts):
        cleaned = " ".join(str(text).split())
        if not cleaned:
            continue
        box = boxes[index].tolist() if index < len(boxes) and hasattr(boxes[index], "tolist") else (boxes[index] if index < len(boxes) else [])
        score = float(scores[index]) if index < len(scores) else 0.0
        x = float(box[0]) if len(box) >= 2 else 0.0
        y = float(box[1]) if len(box) >= 2 else float(index)
        lines.append({"text": cleaned, "confidence": round(score, 4), "x": x, "y": y})
    lines.sort(key=lambda item: (item["y"], item["x"]))
    return {"lines": lines, "text": "\n".join(item["text"] for item in lines)}


for raw_line in sys.stdin:
    try:
        request = json.loads(raw_line)
        response = {"id": request.get("id"), "ok": True, **recognize(request["imageBase64"])}
    except Exception as error:
        response = {"id": request.get("id") if "request" in locals() else None, "ok": False, "error": str(error)[:240]}
    print(json.dumps(response, ensure_ascii=False), flush=True)
