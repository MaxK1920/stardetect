"""Generate a self-contained demo video for StarDetect.

The clip is dark and HUD-friendly, with a few bright moving shapes on a grid
background. The shapes are deliberately high-contrast so the FALLBACK detector
(contour/blob based) produces meaningful tracked detections without YOLO,
making the whole app testable out of the box.

    python backend/cli.py demo --out assets/demo/demo.mp4
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
from typing import List

import numpy as np


W, H, FPS, SECONDS = 1280, 720, 30, 8


def _draw_grid(frame: np.ndarray) -> None:
    step = 64
    color = (40, 30, 18)  # BGR dark teal-ish
    for x in range(0, W, step):
        frame[:, x] = color
    for y in range(0, H, step):
        frame[y, :] = color


def _shapes(t: float):
    """Return list of (kind, cx, cy, size, color_bgr) animated by time t (s)."""
    objs = []
    # Vehicle: cyan rectangle gliding left->right
    vx = int(120 + (W - 240) * ((t / SECONDS)))
    vy = int(H * 0.62 + 30 * math.sin(t * 1.3))
    objs.append(("rect", vx, vy, 150, (255, 230, 0)))
    # Drone: magenta circle on a sine arc (enters at t>1.2)
    if t > 1.2:
        dx = int(W * 0.2 + (W * 0.6) * (0.5 + 0.5 * math.sin(t * 0.9)))
        dy = int(H * 0.25 + 80 * math.sin(t * 2.1))
        objs.append(("circle", dx, dy, 70, (220, 0, 230)))
    # Subject: green rounded box bobbing (leaves at t>6.5)
    if t < 6.5:
        sx = int(W * 0.7 - 60 * math.cos(t * 1.1))
        sy = int(H * 0.45 + 50 * math.sin(t * 1.7))
        objs.append(("rect", sx, sy, 110, (60, 255, 120)))
    return objs


def _render_frame(i: int) -> np.ndarray:
    import cv2
    t = i / FPS
    frame = np.full((H, W, 3), (24, 16, 10), dtype=np.uint8)  # dark BGR
    _draw_grid(frame)
    for kind, cx, cy, size, color in _shapes(t):
        if kind == "rect":
            half = size // 2
            cv2.rectangle(frame, (cx - half, cy - half), (cx + half, cy + half), color, -1)
            cv2.rectangle(frame, (cx - half, cy - half), (cx + half, cy + half), (255, 255, 255), 2)
        else:
            cv2.circle(frame, (cx, cy), size // 2, color, -1)
            cv2.circle(frame, (cx, cy), size // 2, (255, 255, 255), 2)
    # subtle moving scanline
    sy = int((t * 180) % H)
    frame[sy:sy + 2, :] = np.clip(frame[sy:sy + 2, :] + 60, 0, 255)
    return frame


def generate(out_path: str, progress=lambda p, m="": None) -> str:
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    total = FPS * SECONDS

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        cmd = [
            ffmpeg, "-y", "-f", "rawvideo", "-pixel_format", "bgr24",
            "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-i", "-",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
            "-movflags", "+faststart", out_path,
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for i in range(total):
            proc.stdin.write(_render_frame(i).tobytes())
            if i % 10 == 0:
                progress(i / total, f"demo frame {i}/{total}")
        proc.stdin.close()
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg failed to encode demo video")
    else:
        # Fallback: OpenCV writer (may not preview in Chromium, but file exists)
        import cv2
        writer = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
        for i in range(total):
            writer.write(_render_frame(i))
            if i % 10 == 0:
                progress(i / total, f"demo frame {i}/{total}")
        writer.release()

    progress(1.0, "demo complete")
    return out_path
