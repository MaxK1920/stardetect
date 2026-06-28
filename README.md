# StarDetect

An internal desktop tool for creating **artistic object-detection overlays** on
video — YOLO-style bounding boxes, corner-bracket HUDs, labels, glow, gradients,
scan effects, plus detection-triggered sound design and a transparent-alpha
overlay export for compositing in Premiere / After Effects / Resolve.

- **Real YOLO** detection backend (ultralytics) with a contour-based fallback so
  the UI is fully testable even before YOLO/weights are installed.
- **Detection metadata is stored separately from rendering** — changing fonts,
  colors or styles never re-runs YOLO.
- **Two matching renderers**: a canvas renderer for instant live preview and a
  PIL renderer for final export (identical style schema).
- Electron desktop GUI, Python backend, FFmpeg for encoding.

---

## Quick start

```powershell
# 1. Python deps (backend)
pip install -r backend/requirements.txt

# 2. App deps (Electron)
npm install

# 3. Check everything is wired up
npm run deps:check

# 4. Run the app
npm start          # or: npm run dev  (opens devtools)
```

Then in the app: **Load Demo → Detect Whole Video → tweak Style → Export Video →
Export alpha overlay**. A demo clip and demo detections are bundled, so it works
with zero setup.

> **FFmpeg** must be installed and on `PATH` (https://ffmpeg.org). The app
> auto-detects it and disables export if missing.

### Vertical slice (the intended core flow)
import video → run real YOLO detection → preview overlay → change style live →
export burned-in video → export alpha overlay → export detection sound WAV.

---

## Smoke test (no GUI)

```powershell
python tests/smoke_test.py
```

Runs the whole backend pipeline end-to-end (demo → detect → render frame →
burned export → alpha export → SFX wav → detection soundtrack) and prints a
PASS/FAIL summary.

---

## Where things live

| Concern | File |
| --- | --- |
| **YOLO detection** (real + fallback) | `backend/detect.py` |
| Detection CLI / task dispatcher | `backend/cli.py` |
| **Style + keyframe model** (shared schema) | `backend/style_model.py` |
| **Overlay rendering** for export (PIL) | `backend/overlay_render.py` |
| Overlay rendering for live preview (canvas) | `renderer/overlay-renderer.js` |
| **FFmpeg export** (burned / alpha / sequence) | `backend/export.py` |
| **Sound generation** (SFX + detection soundtrack) | `backend/sound.py` |
| Demo video generator | `backend/demo.py` |
| Dependency check | `backend/deps_check.py` |
| Electron main / IPC | `electron/main.js` |
| Python bridge (spawn + JSON protocol) | `electron/backend-bridge.js` |
| Renderer UI (panels) | `renderer/*.js` |
| **Style presets** (editable JSON) | `presets/styles/*.json` |
| **Export presets** (Premiere-style) | `presets/exports/export-presets.json` |
| Bundled demo + detections | `assets/demo/` |
| YOLO weights (bundled / offline) | `models/` |

---

## Features

- **Import & playback** — local video import, preview, timeline/playhead scrubbing,
  frame stepping, overlay drawn on top of footage.
- **Detection** — YOLO model dropdown, confidence / IoU / image size / class
  filter / tracking. Pre-detect the whole clip; results cached as JSON metadata.
- **Live style editor** — box mode (full / corner brackets), shape, line width,
  color, opacity, glow, fill, gradients, label font/size/format/position,
  confidence & ID toggles, scan effect. Instant generic example box + preview on
  a real detected frame. Save/load presets.
- **Style by class / object** — per-class colors & visibility; per-tracked-ID
  show/hide.
- **Keyframes** — keyframe opacity, line width, confidence threshold, label
  visibility and color over time, with interpolation. Dot lane in the timeline
  (double-click to add, drag to move, right-click to delete).
- **Export** — Premiere-style presets: MP4 H.264 / H.265, ProRes, image sequence,
  **transparent alpha overlay** (ProRes 4444 / VP9 / PNG sequence) and burned-in.
  Optional source + detection-SFX audio.
- **Sound FX** — digital blip, sci-fi scanner, tactical beep, glitch tick, soft
  notify. Trigger on new tracked object / class enters frame / pulse while
  visible. Export as standalone WAV or mux into the video.
- **Batch** — queue multiple videos, apply the same detection + style + export
  preset, with per-item progress and output location.

---

## Models / offline use

The model dropdown lists `yolov8n/s/m` and `yolo11n/s/m`. ultralytics
auto-downloads weights on first use. If you are behind a proxy or offline,
drop the `.pt` file into the `models/` folder (e.g. `models/yolov8n.pt`) and the
backend will use it without downloading. `yolov8n.pt` is bundled by default.

If YOLO/torch are not installed, detection automatically runs in **fallback**
mode (contour/blob detection of bright moving shapes) so the full UI — style
editing, keyframes, export, sound, batch — remains testable.

---

## Build / package

```powershell
npm run pack      # unpacked build (release/)
npm run dist      # installer via electron-builder
```

---

## Architecture notes

- The Electron renderer never talks to Python directly. `electron/main.js`
  exposes IPC handlers; `backend-bridge.js` spawns `python backend/cli.py <cmd>`
  and parses newline-delimited JSON (`progress` / `result` / `error`) from stdout.
- Local video is served to the `<video>` element through a privileged `media://`
  protocol (range-request/seeking support) registered in `main.js`.
- Detection metadata (`*.detections.json`) is the contract between detection and
  rendering. Style presets and export settings are separate JSON so the same
  detection can be restyled and re-encoded many ways without re-running YOLO.
