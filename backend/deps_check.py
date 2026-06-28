"""Dependency checker for StarDetect.

Reports which optional/required backends are available so the UI can show a
useful status instead of crashing. Run directly:

    python backend/deps_check.py
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from typing import Any, Dict


def _module_version(name: str) -> str | None:
    if importlib.util.find_spec(name) is None:
        return None
    try:
        mod = __import__(name)
        return getattr(mod, "__version__", "installed")
    except Exception as exc:  # pragma: no cover - defensive
        return f"error: {exc}"


def _ffmpeg_info() -> Dict[str, Any]:
    path = shutil.which("ffmpeg")
    info: Dict[str, Any] = {"available": path is not None, "path": path, "version": None}
    if path:
        try:
            out = subprocess.run(
                [path, "-version"], capture_output=True, text=True, timeout=10
            ).stdout.splitlines()
            if out:
                info["version"] = out[0]
        except Exception:
            pass
    return info


def _ffmpeg_encoders() -> Dict[str, bool]:
    """Detect which export-relevant encoders are present in this ffmpeg."""
    encoders = {"libx264": False, "libx265": False, "prores_ks": False,
                "libvpx-vp9": False, "png": True}
    path = shutil.which("ffmpeg")
    if not path:
        return encoders
    try:
        out = subprocess.run([path, "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=10).stdout
        for enc in encoders:
            if enc in out:
                encoders[enc] = True
    except Exception:
        pass
    return encoders


def collect() -> Dict[str, Any]:
    numpy_v = _module_version("numpy")
    pillow_v = _module_version("PIL")
    cv2_v = _module_version("cv2")
    ultra_v = _module_version("ultralytics")
    torch_v = _module_version("torch")
    ffmpeg = _ffmpeg_info()

    cuda = False
    if torch_v and not str(torch_v).startswith("error"):
        try:
            import torch  # type: ignore
            cuda = bool(torch.cuda.is_available())
        except Exception:
            cuda = False

    yolo_ready = bool(ultra_v and torch_v and not str(ultra_v).startswith("error"))

    report: Dict[str, Any] = {
        "python": sys.version.split()[0],
        "numpy": numpy_v,
        "pillow": pillow_v,
        "opencv": cv2_v,
        "ultralytics": ultra_v,
        "torch": torch_v,
        "cuda": cuda,
        "ffmpeg": ffmpeg,
        "ffmpeg_encoders": _ffmpeg_encoders(),
        "yolo_ready": yolo_ready,
        "render_ready": bool(pillow_v and numpy_v),
        "video_io_ready": bool(cv2_v),
        "export_ready": ffmpeg["available"],
        "mode": "yolo" if yolo_ready else "fallback",
        "messages": [],
    }

    if not yolo_ready:
        report["messages"].append(
            "YOLO (ultralytics + torch) not available - running in FALLBACK mode "
            "with synthetic detections. Install with: pip install -r backend/requirements.txt"
        )
    if not ffmpeg["available"]:
        report["messages"].append(
            "FFmpeg not found on PATH - video export disabled. Install from https://ffmpeg.org"
        )
    if not cv2_v:
        report["messages"].append(
            "opencv-python not installed - frame extraction/detection disabled."
        )
    return report


if __name__ == "__main__":
    print(json.dumps(collect(), indent=2))
