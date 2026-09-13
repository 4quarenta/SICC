"""Local scene text detection and recognition; JSONL IPC, no remote inference."""
import base64
import contextlib
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
with contextlib.redirect_stdout(sys.stderr):
    import cv2
    import numpy as np
    from rapidocr import RapidOCR, OCRVersion, ModelType, LangRec
    engine = RapidOCR(params={
        "Global.use_cls": False,
        "Global.text_score": 0.3,
        "Global.log_level": "error",
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.MOBILE,
        "Det.limit_side_len": 1280,
        "Det.limit_type": "max",
        "Det.mean": [0.485, 0.456, 0.406],
        "Det.std": [0.229, 0.224, 0.225],
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
        "Rec.lang_type": LangRec.LATIN,
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    })
    # RapidOCR 3.9.2 initializes model weights in its constructor, before IPC.

for raw in sys.stdin:
    request = {}
    try:
        request = json.loads(raw)
        img = cv2.imdecode(np.frombuffer(base64.b64decode(request["imageBase64"]), dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Invalid image")
        with contextlib.redirect_stdout(sys.stderr):
            result = engine(img)
        lines = []
        if result.txts is not None:
            for text, score, polygon in zip(result.txts, result.scores, result.boxes):
                box = [float(polygon[:, 0].min()), float(polygon[:, 1].min()), float(polygon[:, 0].max()), float(polygon[:, 1].max())]
                lines.append({"text": str(text), "confidence": float(score), "box": box})
        lines.sort(key=lambda line: (line["box"][1], line["box"][0]))
        response = {"id": request["id"], "ok": True, "lines": lines, "text": "\n".join(line["text"] for line in lines), "width": img.shape[1], "height": img.shape[0]}
    except Exception as error:
        response = {"id": request.get("id"), "ok": False, "error": type(error).__name__ + ": local scene OCR failed"}
    print(json.dumps(response, ensure_ascii=False), flush=True)
