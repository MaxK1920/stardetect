# StarDetect

Desktop app that runs YOLO object detection on a video and draws stylable overlays on top: boxes, corner brackets, labels, glow, gradients, scan effects. It can also add sounds when objects show up, and export the overlay with a transparent background so you can drop it into Premiere, After Effects or Resolve.

Detection results are saved separately from the styling. Changing colors, fonts or anything else never re-runs the model.

Built with Electron, a Python backend and FFmpeg.

## Setup

You need Node.js, Python 3 and [FFmpeg](https://ffmpeg.org) on your `PATH`. Without FFmpeg the app still runs, but export is disabled.

```powershell
pip install -r backend/requirements.txt
npm install
npm run deps:check
npm start
```

`npm run dev` does the same but opens devtools.

`Load Demo` in the app generates a short test clip, so you can try things without your own footage. The basic flow is: load a video, detect, adjust the style, export.

## Detection models

The dropdown offers `yolov8n/s/m` and `yolo11n/s/m`. Ultralytics downloads the weights the first time you use one. If you're offline or behind a proxy, put the `.pt` file in `models/` and it will be picked up from there. `yolov8n.pt` is already included.

If ultralytics or torch aren't installed, detection falls back to a simple contour-based detector for bright moving shapes. It's not useful for real footage, but the rest of the app (styling, keyframes, export, sound, batch) still works.

## Features

- **Playback:** import local video, scrub the timeline, step frame by frame, overlay drawn over the footage.
- **Detection:** choose the model, confidence, IoU, image size, class filter and tracking. Results are cached as JSON.
- **Style editor:** full boxes or corner brackets, line width, color, opacity, glow, fill, gradients, label font/size/format/position, scan effect. Presets can be saved and loaded.
- **Per-class and per-object styling:** colors and visibility per class, and show/hide for individual tracked objects.
- **Keyframes:** animate opacity, line width, confidence threshold, label visibility and color over time. Double-click the timeline lane to add one, drag to move, right-click to delete.
- **Export:** MP4 (H.264 / H.265), ProRes, image sequence, burned-in video, or a transparent overlay (ProRes 4444, VP9, PNG sequence). Source audio and detection sounds are optional.
- **Sound:** a handful of generated sounds (blip, scanner, beep, glitch, notify), triggered when a new object appears, a class enters the frame, or on a pulse while visible. Export as WAV or mux into the video.
- **Batch:** queue several videos and apply the same detection, style and export settings to all of them.

## Tests

```powershell
python tests/smoke_test.py
```

Runs the backend pipeline without the GUI: demo clip, detection, frame render, burned and alpha export, sound effects. Prints pass/fail per step.

## Building

```powershell
npm run pack      # unpacked build in release/
npm run dist      # installer
```

## Code layout

| What | Where |
| --- | --- |
| Detection (YOLO and fallback) | `backend/detect.py` |
| CLI entry point | `backend/cli.py` |
| Style and keyframe model | `backend/style_model.py` |
| Overlay rendering for export (PIL) | `backend/overlay_render.py` |
| Overlay rendering for preview (canvas) | `renderer/overlay-renderer.js` |
| FFmpeg export | `backend/export.py` |
| Sound generation | `backend/sound.py` |
| Demo clip generator | `backend/demo.py` |
| Dependency check | `backend/deps_check.py` |
| Electron main process and IPC | `electron/main.js` |
| Python bridge | `electron/backend-bridge.js` |
| UI panels | `renderer/*.js` |
| Style presets | `presets/styles/` |
| Export presets | `presets/exports/export-presets.json` |

The renderer never talks to Python directly. `electron/main.js` exposes IPC handlers, and `backend-bridge.js` spawns `python backend/cli.py <command>` and reads newline-delimited JSON (`progress`, `result`, `error`) from stdout.

The preview and the export use two separate renderers (canvas and PIL) that read the same style schema, so they should look the same.

Local videos reach the `<video>` element through a `media://` protocol registered in `main.js`, which supports range requests for seeking.

## License

AGPL-3.0, see [LICENSE](LICENSE). StarDetect depends on [Ultralytics YOLO](https://github.com/ultralytics/ultralytics) and its weights, which are AGPL-3.0 as well, so the whole project uses the same license.

Other things it uses:

- Ultralytics YOLO and weights (including `models/yolov8n.pt`): AGPL-3.0
- FFmpeg: LGPL or GPL depending on the build. Installed separately, not bundled.
- Electron, Pillow, NumPy, OpenCV: their own permissive licenses
