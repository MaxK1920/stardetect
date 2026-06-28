"""End-to-end smoke test for the StarDetect backend pipeline.

Verifies the vertical slice without the GUI:
  deps -> demo video -> detect (fallback) -> render frame -> burned export ->
  alpha export -> SFX wav -> detection soundtrack wav.

Run:  python tests/smoke_test.py
Exit code 0 = all critical checks passed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")
sys.path.insert(0, BACKEND)

import deps_check          # noqa: E402
import demo                # noqa: E402
import detect              # noqa: E402
import overlay_render      # noqa: E402
import export             # noqa: E402
import sound               # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f"  ({detail})" if detail else ""))


def stream_types(path):
    """Return the set of codec_type strings ffprobe finds in a media file."""
    import shutil
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:  # derive from the ffmpeg executable's directory
        ffmpeg = export.ffmpeg_path()
        d, base = os.path.split(ffmpeg)
        ffprobe = os.path.join(d, base.replace("ffmpeg", "ffprobe"))
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "stream=codec_type",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30)
        return set(out.stdout.split())
    except Exception as e:  # pragma: no cover
        return {f"probe-error:{e}"}


def main():
    tmp = tempfile.mkdtemp(prefix="stardetect_smoke_")
    deps = deps_check.collect()
    check("deps-check", True, f"mode={deps['mode']}, ffmpeg={deps['ffmpeg']['available']}")

    # demo video (reuse bundled one if present)
    demo_path = os.path.join(ROOT, "assets", "demo", "demo.mp4")
    if not os.path.exists(demo_path):
        demo_path = os.path.join(tmp, "demo.mp4")
        demo.generate(demo_path)
    check("demo video", os.path.exists(demo_path), demo_path)

    # detection (fallback engine guarantees detections on the demo shapes)
    meta = detect.detect(demo_path, engine="fallback", tracking=True)
    n_obj = sum(len(f["objects"]) for f in meta["frames"])
    check("detection metadata", n_obj > 0, f"{len(meta['frames'])} frames, {n_obj} objects, classes={meta['classes']}")

    meta_path = os.path.join(tmp, "meta.json")
    json.dump(meta, open(meta_path, "w"))

    # build a render config from the default preset
    preset = json.load(open(os.path.join(ROOT, "presets", "styles", "default.json")))
    config = {"global": preset["global"], "classStyles": {}, "classVisibility": {},
              "idVisibility": {}, "keyframes": {"opacity": [{"t": 0, "v": 1}, {"t": 4, "v": 0.4}]},
              "globalOpacity": 1.0}
    cfg_path = os.path.join(tmp, "config.json")
    json.dump(config, open(cfg_path, "w"))

    # single overlay frame render (PIL)
    mid = meta["frames"][len(meta["frames"]) // 2]
    img = overlay_render.render_overlay(meta["width"], meta["height"], mid["objects"], config, mid["t"])
    check("overlay render (PIL)", img.size == (meta["width"], meta["height"]), f"size={img.size}")

    # dither gradient fill: maps a source frame's luminance through the colour
    # ramp inside each box. Verify the palette appears only when a source frame
    # is supplied (and stays transparent inside the box without one).
    import numpy as _np
    dcfg = json.loads(json.dumps(config))
    dcfg["global"]["box"]["dither"] = {"enabled": True, "from": "#c71f05",
                                       "to": "#ffe60d", "grain": 0.2, "levels": 3,
                                       "contrast": 1.2, "opacity": 1.0}
    src = (_np.random.rand(meta["height"], meta["width"], 3) * 255).astype("uint8")
    di = overlay_render.render_overlay(meta["width"], meta["height"], mid["objects"], dcfg, mid["t"], src)
    bx = [int(v) for v in mid["objects"][0]["box"]]
    cx, cy = (bx[0] + bx[2]) // 2, (bx[1] + bx[3]) // 2
    r, g, b, a = di.getpixel((cx, cy))
    check("dither fill maps footage", a > 0 and r > g > b,
          f"center rgba=({r},{g},{b},{a})")

    # exports limited to a short range for speed
    rng = [0, min(30, len(meta["frames"]))]
    if deps["ffmpeg"]["available"]:
        burned = os.path.join(tmp, "burned.mp4")
        export.export_video(meta, config, {
            "mode": "burned", "vcodec": "libx264", "pixfmt": "yuv420p", "crf": 24,
            "out": burned, "video": demo_path,
            "range": rng, "audio": {"mode": "sfx", "preset": "tactical_beep", "trigger": "new"}})
        bs = stream_types(burned)
        check("burned export (mp4 + SFX)",
              os.path.getsize(burned) > 1000 and "video" in bs and "audio" in bs,
              f"{burned} streams={sorted(bs)}")

        # alpha + SFX: regression for the 12kb 'audio-only, no video' bug where
        # adding an audio -map dropped ffmpeg's automatic video stream.
        alpha = os.path.join(tmp, "alpha.mov")
        export.export_video(meta, config, {
            "mode": "alpha", "vcodec": "prores_ks", "pixfmt": "yuva444p10le",
            "proresProfile": 4, "out": alpha, "range": rng,
            "audio": {"mode": "sfx", "preset": "tactical_beep", "trigger": "new"}})
        as_ = stream_types(alpha)
        check("alpha export (ProRes 4444 + SFX keeps video)",
              os.path.getsize(alpha) > 1000 and "video" in as_,
              f"{alpha} streams={sorted(as_)}")

        # source+sfx on a source WITHOUT an audio track (the demo) must not
        # crash on amix [0:a]; it should degrade to SFX-only and still produce
        # both a video and an audio stream.
        srcsfx = os.path.join(tmp, "srcsfx.mp4")
        export.export_video(meta, config, {
            "mode": "burned", "vcodec": "libx264", "pixfmt": "yuv420p", "crf": 24,
            "out": srcsfx, "video": demo_path, "range": rng,
            "audio": {"mode": "source+sfx", "preset": "tactical_beep", "trigger": "new"}})
        ss = stream_types(srcsfx)
        check("source+sfx degrades when source has no audio",
              os.path.getsize(srcsfx) > 1000 and "video" in ss and "audio" in ss,
              f"{srcsfx} streams={sorted(ss)}")

        # dither burned export: exercises the OpenCV source-frame reading path in
        # _render_frames so exports match the live preview's dither fill.
        dith_out = os.path.join(tmp, "dither.mp4")
        export.export_video(meta, dcfg, {
            "mode": "burned", "vcodec": "libx264", "pixfmt": "yuv420p", "crf": 24,
            "out": dith_out, "video": demo_path, "range": rng,
            "audio": {"mode": "none"}})
        ds = stream_types(dith_out)
        check("dither burned export (samples source frames)",
              os.path.getsize(dith_out) > 1000 and "video" in ds,
              f"{dith_out} streams={sorted(ds)}")
    else:
        check("ffmpeg export", False, "FFmpeg not available - skipped")

    # sound
    sfx = os.path.join(tmp, "blip.wav")
    sound.export_sfx("digital_blip", sfx)
    check("SFX wav", os.path.getsize(sfx) > 100, sfx)

    track = os.path.join(tmp, "track.wav")
    res = sound.export_track(meta, "scifi_scanner", track, mode="new")
    check("detection soundtrack wav", os.path.getsize(track) > 100, f"{res['triggers']} triggers")

    # custom sound effect (reuse the generated blip as a user file) + volume scaling
    custom_out = os.path.join(tmp, "custom.wav")
    sound.export_sfx("digital_blip", custom_out, custom=sfx, volume=0.5)
    check("custom sound + volume", os.path.getsize(custom_out) > 100, custom_out)

    # imgsz 'auto' resolves from the video dimensions to a /32 multiple
    rs = detect.resolve_imgsz("auto", {"width": meta["width"], "height": meta["height"]})
    check("imgsz auto resolves", rs % 32 == 0 and 320 <= rs <= 1280, f"imgsz={rs}")

    # class alias renames the label in the PIL render without error
    cfg_alias = dict(config)
    cfg_alias["classAliases"] = {meta["classes"][0]: "RENAMED"}
    img_alias = overlay_render.render_overlay(meta["width"], meta["height"],
                                              mid["objects"], cfg_alias, mid["t"])
    check("class alias render", img_alias.size == (meta["width"], meta["height"]),
          f"alias={meta['classes'][0]}->RENAMED")

    # 'new' trigger without tracking IDs must still fire (falls back to 'enter')
    meta_notrack = detect.detect(demo_path, engine="fallback", tracking=False)
    has_ids = any(o.get("id") is not None
                  for fr in meta_notrack["frames"] for o in fr["objects"])
    track2 = os.path.join(tmp, "track_notrack.wav")
    res2 = sound.export_track(meta_notrack, "digital_blip", track2, mode="new")
    check("'new' SFX fires without tracking", (not has_ids) and res2["triggers"] > 0,
          f"has_ids={has_ids}, {res2['triggers']} triggers")

    print("\n" + "=" * 52)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f"  {passed}/{len(results)} checks passed")
    print(f"  artifacts in: {tmp}")
    print("=" * 52)
    failed = [n for n, ok, _ in results if not ok]
    if failed:
        print("FAILED:", ", ".join(failed))
        sys.exit(1)
    print("ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
