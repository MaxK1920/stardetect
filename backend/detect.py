"""Detection backend for StarDetect.

Primary engine is **real YOLO** via ultralytics (YOLOv8/YOLO11/YOLO26 family,
weights auto-download on first use). When ultralytics/torch are unavailable a
contour-based FALLBACK engine produces synthetic-but-real detections of bright
moving shapes so the UI stays testable.

Output is detection *metadata* (JSON) kept completely separate from rendering,
so changing style/colors never requires re-running detection.
"""

from __future__ import annotations

import json
import os
from typing import Callable, Dict, List, Optional


ProgressFn = Callable[[float, str], None]


def _video_info(path: str) -> Dict:
    import cv2
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {path}")
    info = {
        "fps": cap.get(cv2.CAP_PROP_FPS) or 30.0,
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "frameCount": int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
    }
    cap.release()
    if info["fps"] <= 0:
        info["fps"] = 30.0
    return info


def yolo_available() -> bool:
    import importlib.util
    return (importlib.util.find_spec("ultralytics") is not None
            and importlib.util.find_spec("torch") is not None)


def resolve_imgsz(imgsz, info: Dict) -> int:
    """Resolve an ``imgsz`` value to an int YOLO inference size.

    ``"auto"`` derives the size from the video's largest side, snapped to a
    multiple of 32 and clamped to a sane [320, 1280] range.
    """
    if isinstance(imgsz, int):
        return imgsz
    if str(imgsz).lower() != "auto":
        return int(imgsz)
    max_side = max(int(info.get("width", 0)), int(info.get("height", 0)))
    if max_side <= 0:
        return 640
    snapped = int(round(max_side / 32) * 32)
    return max(320, min(1280, snapped))


def resolve_model(model_name: str) -> str:
    """Resolve a model id to a local weights file if one is bundled.

    Looks in <repo>/models and the current working directory before falling
    back to the bare name (which lets ultralytics auto-download when online).
    """
    if os.path.isabs(model_name) and os.path.exists(model_name):
        return model_name
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for cand in (os.path.join(root, "models", model_name),
                 os.path.join(os.getcwd(), model_name)):
        if os.path.exists(cand):
            return cand
    return model_name


# --------------------------------------------------------------------------- #
# Real YOLO engine
# --------------------------------------------------------------------------- #
def _detect_yolo(video: str, model_name: str, conf: float, iou: float, imgsz,
                 classes: Optional[List[int]], tracking: bool, sample_every: int,
                 progress: ProgressFn) -> Dict:
    from ultralytics import YOLO

    info = _video_info(video)
    imgsz = resolve_imgsz(imgsz, info)
    total = max(info["frameCount"], 1)
    resolved = resolve_model(model_name)

    # Run on the GPU when a CUDA build of torch can see one; otherwise CPU. Being
    # explicit (and reporting it) makes a slow CPU-only torch obvious to the user.
    device = "cpu"
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            device = "0"
    except Exception:
        pass
    dev_label = "GPU" if device != "cpu" else "CPU"

    progress(0.02, f"loading model {os.path.basename(resolved)} on {dev_label}")
    model = YOLO(resolved)

    common = dict(source=video, stream=True, conf=conf, iou=iou, imgsz=imgsz,
                  device=device, verbose=False)
    if classes:
        common["classes"] = classes

    if tracking:
        results = model.track(persist=True, tracker="bytetrack.yaml", **common)
    else:
        results = model.predict(**common)

    frames: List[Dict] = []
    names = {}
    present = set()
    idx = 0
    for r in results:
        names = r.names
        if idx % sample_every == 0:
            objects = []
            boxes = r.boxes
            if boxes is not None and len(boxes) > 0:
                xyxy = boxes.xyxy.cpu().numpy()
                confs = boxes.conf.cpu().numpy()
                clss = boxes.cls.cpu().numpy().astype(int)
                ids = (boxes.id.cpu().numpy().astype(int)
                       if (tracking and boxes.id is not None) else [None] * len(clss))
                for j in range(len(xyxy)):
                    cname = names.get(int(clss[j]), str(int(clss[j])))
                    present.add(cname)
                    objects.append({
                        "id": int(ids[j]) if ids[j] is not None else None,
                        "cls": cname,
                        "clsId": int(clss[j]),
                        "conf": round(float(confs[j]), 4),
                        "box": [round(float(v), 1) for v in xyxy[j]],
                    })
            frames.append({"i": idx, "t": round(idx / info["fps"], 4), "objects": objects})
        idx += 1
        if idx % 5 == 0:
            progress(min(idx / total, 0.99), f"detect frame {idx}/{total}")

    return _assemble(video, model_name, "yolo", info, frames, sorted(present),
                     tracking, conf, iou, imgsz, classes, sample_every)


# --------------------------------------------------------------------------- #
# Fallback engine: bright-blob contour detection + centroid tracking
# --------------------------------------------------------------------------- #
_FALLBACK_CLASSES = {  # crude hue -> label mapping for the demo shapes
    "cyan": "vehicle", "magenta": "drone", "green": "subject",
    "other": "object",
}


def _classify_color(hsv_mean) -> str:
    h, s, v = hsv_mean
    if s < 40:
        return "other"
    if 40 <= h <= 90:
        return "green"
    if 90 < h <= 130:
        return "cyan"
    if 130 < h <= 175:
        return "magenta"
    return "other"


def _detect_fallback(video: str, conf: float, sample_every: int,
                     tracking: bool, progress: ProgressFn) -> Dict:
    import cv2
    import numpy as np

    info = _video_info(video)
    cap = cv2.VideoCapture(video)
    total = max(info["frameCount"], 1)

    frames: List[Dict] = []
    present = set()
    tracks: List[Dict] = []  # {id, cx, cy}
    next_id = 1
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % sample_every == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            _, mask = cv2.threshold(gray, 90, 255, cv2.THRESH_BINARY)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            objects = []
            dets = []
            for c in contours:
                area = cv2.contourArea(c)
                if area < 1500:
                    continue
                x, y, w, h = cv2.boundingRect(c)
                roi = hsv[y:y + h, x:x + w].reshape(-1, 3).mean(axis=0)
                cname = _FALLBACK_CLASSES[_classify_color(roi)]
                pseudo_conf = round(min(0.99, 0.55 + area / (info["width"] * info["height"]) * 4), 4)
                if pseudo_conf < conf:
                    continue
                dets.append((x, y, w, h, cname, pseudo_conf))

            # simple nearest-centroid tracking
            used = set()
            for (x, y, w, h, cname, pc) in dets:
                cx, cy = x + w / 2, y + h / 2
                oid = None
                if tracking:
                    best, bestd = None, 80
                    for tr in tracks:
                        if tr["id"] in used:
                            continue
                        d = ((tr["cx"] - cx) ** 2 + (tr["cy"] - cy) ** 2) ** 0.5
                        if d < bestd:
                            best, bestd = tr, d
                    if best is None:
                        best = {"id": next_id, "cx": cx, "cy": cy}
                        next_id += 1
                        tracks.append(best)
                    best["cx"], best["cy"] = cx, cy
                    used.add(best["id"])
                    oid = best["id"]
                present.add(cname)
                objects.append({
                    "id": oid, "cls": cname, "clsId": 0, "conf": pc,
                    "box": [float(x), float(y), float(x + w), float(y + h)],
                })
            frames.append({"i": idx, "t": round(idx / info["fps"], 4), "objects": objects})
        idx += 1
        if idx % 5 == 0:
            progress(min(idx / total, 0.99), f"fallback frame {idx}/{total}")
    cap.release()

    return _assemble(video, "fallback-contour", "fallback", info, frames,
                     sorted(present), tracking, conf, 0.45, 640, None, sample_every)


def _assemble(video, model_name, engine, info, frames, classes, tracking,
              conf, iou, imgsz, class_filter, sample_every) -> Dict:
    return {
        "schema": 1,
        "video": os.path.abspath(video),
        "engine": engine,
        "model": model_name,
        "fps": info["fps"],
        "width": info["width"],
        "height": info["height"],
        "frameCount": info["frameCount"],
        "duration": round(info["frameCount"] / info["fps"], 3) if info["fps"] else 0,
        "tracking": tracking,
        "classes": classes,
        "params": {"conf": conf, "iou": iou, "imgsz": imgsz,
                   "classes": class_filter, "sampleEvery": sample_every},
        "frames": frames,
    }


def detect(video: str, model_name: str = "yolov8n.pt", conf: float = 0.25,
           iou: float = 0.45, imgsz="auto", classes: Optional[List[int]] = None,
           tracking: bool = False, sample_every: int = 1, engine: str = "auto",
           progress: ProgressFn = lambda p, m="": None) -> Dict:
    """Run detection and return metadata dict.

    Args:
        engine: ``auto`` (YOLO if available else fallback), ``yolo``, or ``fallback``.
    """
    if engine == "fallback" or (engine == "auto" and not yolo_available()):
        progress(0.0, "using fallback detector")
        return _detect_fallback(video, conf, sample_every, tracking, progress)
    return _detect_yolo(video, model_name, conf, iou, imgsz, classes,
                        tracking, sample_every, progress)
