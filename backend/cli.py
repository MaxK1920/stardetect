"""StarDetect backend CLI dispatcher.

Single entrypoint the Electron app spawns per task. Communicates over stdout
using newline-delimited JSON messages:

    {"type": "progress", "value": 0.0-1.0, "msg": "..."}
    {"type": "result",   "data": {...}}
    {"type": "error",    "message": "..."}

Run e.g.::

    python backend/cli.py deps-check
    python backend/cli.py demo --out assets/demo/demo.mp4
    python backend/cli.py detect --video clip.mp4 --model yolov8n.pt --out meta.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# Curated model list for the UI dropdown (ultralytics auto-downloads weights).
MODELS = [
    {"id": "yolov8n.pt", "label": "YOLOv8n (fastest, default)"},
    {"id": "yolov8s.pt", "label": "YOLOv8s (small)"},
    {"id": "yolov8m.pt", "label": "YOLOv8m (medium)"},
    {"id": "yolo11n.pt", "label": "YOLO11n (fast)"},
    {"id": "yolo11s.pt", "label": "YOLO11s"},
    {"id": "yolo11m.pt", "label": "YOLO11m"},
]


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def progress(value: float, msg: str = "") -> None:
    emit({"type": "progress", "value": round(float(value), 4), "msg": msg})


def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def cmd_deps_check(args):
    import deps_check
    data = deps_check.collect()
    data["models"] = MODELS
    emit({"type": "result", "data": data})


def cmd_models(args):
    import detect
    emit({"type": "result", "data": {"models": MODELS, "yoloAvailable": detect.yolo_available()}})


def cmd_demo(args):
    import demo
    path = demo.generate(args.out, progress)
    emit({"type": "result", "data": {"path": path}})


def cmd_detect(args):
    import detect
    classes = [int(c) for c in args.classes.split(",")] if args.classes else None
    imgsz = "auto" if str(args.imgsz).lower() == "auto" else int(args.imgsz)
    meta = detect.detect(
        video=args.video, model_name=args.model, conf=args.conf, iou=args.iou,
        imgsz=imgsz, classes=classes, tracking=args.track,
        sample_every=args.sample, engine=args.engine, progress=progress)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(meta, f)
    summary = {
        "metaPath": out, "engine": meta["engine"], "model": meta["model"],
        "frames": len(meta["frames"]), "classes": meta["classes"],
        "tracking": meta["tracking"], "width": meta["width"], "height": meta["height"],
        "fps": meta["fps"], "duration": meta["duration"],
    }
    emit({"type": "result", "data": summary})


def cmd_render_frame(args):
    import detect  # noqa: F401 (ensure path)
    import overlay_render
    meta = _load_json(args.meta)
    config = _load_json(args.config)
    fps = meta["fps"]
    by_i = {fr["i"]: fr["objects"] for fr in meta["frames"]}
    objs = by_i.get(args.frame, [])
    img = overlay_render.render_overlay(meta["width"], meta["height"], objs, config,
                                        args.frame / fps)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    img.save(args.out)
    emit({"type": "result", "data": {"path": os.path.abspath(args.out)}})


def cmd_export(args):
    import export
    meta = _load_json(args.meta)
    config = _load_json(args.config)
    settings = _load_json(args.settings)
    result = export.export_video(meta, config, settings, progress)
    emit({"type": "result", "data": result})


def cmd_sound(args):
    import sound
    custom = args.custom or None
    if args.meta:
        meta = _load_json(args.meta)
        res = sound.export_track(meta, args.preset, args.out, mode=args.trigger,
                                 classes=args.classes.split(",") if args.classes else None,
                                 custom=custom, volume=args.volume)
        emit({"type": "result", "data": res})
    else:
        path = sound.export_sfx(args.preset, args.out, custom=custom, volume=args.volume)
        emit({"type": "result", "data": {"path": path, "preset": custom or args.preset}})


def build_parser():
    p = argparse.ArgumentParser(prog="stardetect")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("deps-check").set_defaults(func=cmd_deps_check)
    sub.add_parser("models").set_defaults(func=cmd_models)

    d = sub.add_parser("demo")
    d.add_argument("--out", required=True)
    d.set_defaults(func=cmd_demo)

    de = sub.add_parser("detect")
    de.add_argument("--video", required=True)
    de.add_argument("--model", default="yolov8n.pt")
    de.add_argument("--conf", type=float, default=0.25)
    de.add_argument("--iou", type=float, default=0.45)
    de.add_argument("--imgsz", default="auto")
    de.add_argument("--classes", default="")
    de.add_argument("--track", action="store_true")
    de.add_argument("--sample", type=int, default=1)
    de.add_argument("--engine", default="auto", choices=["auto", "yolo", "fallback"])
    de.add_argument("--out", required=True)
    de.set_defaults(func=cmd_detect)

    rf = sub.add_parser("render-frame")
    rf.add_argument("--meta", required=True)
    rf.add_argument("--config", required=True)
    rf.add_argument("--frame", type=int, default=0)
    rf.add_argument("--out", required=True)
    rf.set_defaults(func=cmd_render_frame)

    ex = sub.add_parser("export")
    ex.add_argument("--meta", required=True)
    ex.add_argument("--config", required=True)
    ex.add_argument("--settings", required=True)
    ex.set_defaults(func=cmd_export)

    so = sub.add_parser("sound")
    so.add_argument("--preset", default="digital_blip")
    so.add_argument("--out", required=True)
    so.add_argument("--meta", default="")
    so.add_argument("--trigger", default="new")
    so.add_argument("--classes", default="")
    so.add_argument("--custom", default="")
    so.add_argument("--volume", type=float, default=1.0)
    so.set_defaults(func=cmd_sound)
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": str(exc), "trace": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
