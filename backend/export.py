"""Export pipeline for StarDetect.

Renders overlay frames with ``overlay_render`` (the source of truth for final
pixels), then uses FFmpeg to either:
  * burn overlays over the source footage, or
  * export a transparent-alpha overlay (ProRes 4444 / PNG seq / VP9), or
  * write an image sequence.

Detection metadata + style config drive the render; export settings (codec /
container / alpha) are kept separate so the same detection/style can be encoded
many ways. Optional detection-triggered SFX can be muxed in.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from typing import Callable, Dict, List, Optional

from PIL import Image

import overlay_render
import sound as sound_mod


ProgressFn = Callable[[float, str], None]


def ffmpeg_path() -> str:
    p = shutil.which("ffmpeg")
    if not p:
        raise RuntimeError("FFmpeg not found on PATH. Install from https://ffmpeg.org")
    return p


def _has_audio_stream(path: str) -> bool:
    """True if ``path`` contains at least one audio stream (via ffprobe)."""
    if not path or not os.path.exists(path):
        return False
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        d, base = os.path.split(ffmpeg_path())
        ffprobe = os.path.join(d, base.replace("ffmpeg", "ffprobe"))
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30)
        return bool(out.stdout.strip())
    except Exception:
        return False


def _frame_index(metadata: Dict) -> Dict[int, List[Dict]]:
    """Map every source frame index -> objects, forward-filling sampled gaps."""
    by_i = {fr["i"]: fr["objects"] for fr in metadata.get("frames", [])}
    total = metadata.get("frameCount", 0) or (max(by_i) + 1 if by_i else 0)
    out: Dict[int, List[Dict]] = {}
    last: List[Dict] = []
    sampled = sorted(by_i)
    sample_every = metadata.get("params", {}).get("sampleEvery", 1)
    for i in range(total):
        if i in by_i:
            last = by_i[i]
        elif sample_every > 1:
            # hold previous sampled detections between samples
            pass
        out[i] = last
    return out


def _uses_dither(render_config: Dict) -> bool:
    """True if the global style or any class override enables the dither fill."""
    g = (render_config.get("global", {}) or {}).get("box", {}).get("dither", {})
    if g.get("enabled"):
        return True
    for cs in (render_config.get("classStyles", {}) or {}).values():
        if (cs or {}).get("box", {}).get("dither", {}).get("enabled"):
            return True
    return False


def _render_frames(metadata: Dict, render_config: Dict, tmp_dir: str,
                   rng, progress: ProgressFn, source_video: Optional[str] = None) -> int:
    w, h = metadata["width"], metadata["height"]
    fps = metadata["fps"]
    idx_map = _frame_index(metadata)
    start, end = rng if rng else (0, metadata.get("frameCount", len(idx_map)))
    end = min(end, len(idx_map))
    count = max(1, end - start)

    # The dither fill needs the underlying footage. Open the source with OpenCV
    # and read frames in lock-step with the overlay indices when required.
    cap = None
    if _uses_dither(render_config) and source_video and os.path.exists(source_video):
        try:
            import cv2  # type: ignore
            cap = cv2.VideoCapture(source_video)
            if start > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, start)
        except Exception:
            cap = None

    try:
        for n, i in enumerate(range(start, end)):
            t = i / fps
            objs = idx_map.get(i, [])
            source = None
            if cap is not None:
                ok, frame = cap.read()
                if ok and frame is not None:
                    import cv2  # type: ignore
                    source = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = overlay_render.render_overlay(w, h, objs, render_config, t, source)
            img.save(os.path.join(tmp_dir, f"ov_{n:06d}.png"))
            if n % 5 == 0:
                progress(0.05 + 0.65 * (n / count), f"render overlay {n}/{count}")
    finally:
        if cap is not None:
            cap.release()
    return end - start


def _audio_inputs(settings: Dict, metadata: Dict, tmp_dir: str) -> Dict:
    """Returns dict describing audio: source flag and optional sfx wav path."""
    audio = settings.get("audio", {}) or {}
    mode = audio.get("mode", "none")  # none | source | sfx | source+sfx
    sfx_path = None
    if "sfx" in mode:
        sfx_path = os.path.join(tmp_dir, "sfx.wav")
        sound_mod.export_track(
            metadata, audio.get("preset", "digital_blip"), sfx_path,
            mode=audio.get("trigger", "new"), classes=audio.get("classes"),
            custom=audio.get("custom") or None,
            volume=float(audio.get("volume", 1.0)))
    return {"mode": mode, "sfx": sfx_path}


def export_video(metadata: Dict, render_config: Dict, settings: Dict,
                 progress: ProgressFn = lambda p, m="": None) -> Dict:
    """Run a full export. ``settings`` keys:

        out, mode(burned|alpha|sequence), container, vcodec, pixfmt,
        crf|bitrate|proresProfile, fps(optional), range(optional [s,e]),
        audio{mode,preset,trigger,classes}
    """
    ff = ffmpeg_path()
    out_path = os.path.abspath(settings["out"])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fps = settings.get("fps") or metadata["fps"]
    mode = settings.get("mode", "burned")
    # Source footage: prefer the path supplied by the caller (current video in
    # the app) over the one baked into the metadata, which may be stale/missing.
    source_video = settings.get("video") or metadata.get("video")
    if mode == "burned" or (mode == "sequence" and settings.get("compositeSource")):
        if not source_video or not os.path.exists(source_video):
            raise FileNotFoundError(
                f"Source video not found for '{mode}' export: {source_video!r}. "
                f"Re-import the video or run detection again.")

    tmp_dir = tempfile.mkdtemp(prefix="stardetect_")
    try:
        progress(0.02, "rendering overlay frames")
        n = _render_frames(metadata, render_config, tmp_dir, settings.get("range"),
                           progress, source_video)
        seq = os.path.join(tmp_dir, "ov_%06d.png")

        # Image sequence export -> just move/composite PNGs to an output folder.
        if mode == "sequence":
            os.makedirs(out_path, exist_ok=True)
            if settings.get("compositeSource") and source_video:
                cmd = [ff, "-y", "-i", source_video, "-framerate", str(fps),
                       "-i", seq, "-filter_complex", "[0:v][1:v]overlay=shortest=1",
                       os.path.join(out_path, "frame_%06d.png")]
                _run(cmd, progress)
            else:
                for f in os.listdir(tmp_dir):
                    if f.endswith(".png"):
                        shutil.copy(os.path.join(tmp_dir, f), os.path.join(out_path, f))
            progress(1.0, "image sequence written")
            return {"out": out_path, "frames": n, "mode": mode}

        audio = _audio_inputs(settings, metadata, tmp_dir)
        cmd = [ff, "-y"]
        filt: List[str] = []      # filter_complex chains
        maps: List[str] = []      # -map args

        if mode == "alpha":
            # Transparent overlay only, no source video underneath. The image
            # sequence is input 0; map it explicitly so that adding an audio
            # -map below doesn't disable ffmpeg's automatic video selection
            # (which would yield a file with audio but no video stream).
            cmd += ["-framerate", str(fps), "-i", seq]
            maps += ["-map", "0:v"]
            vcodec = settings.get("vcodec", "prores_ks")
            pixfmt = settings.get("pixfmt", "yuva444p10le")
            sfx_idx = 1
            use_source = False
        else:  # burned
            cmd += ["-i", source_video, "-framerate", str(fps), "-i", seq]
            filt.append("[0:v][1:v]overlay=shortest=1[v]")
            maps += ["-map", "[v]"]
            vcodec = settings.get("vcodec", "libx264")
            pixfmt = settings.get("pixfmt", "yuv420p")
            sfx_idx = 2
            use_source = "source" in audio["mode"]
            # Source footage may have no audio stream (e.g. the demo clip). In
            # that case amix's [0:a] reference would abort the whole export, so
            # drop the source-audio branch and fall back to SFX-only / silent.
            if use_source and not _has_audio_stream(source_video):
                use_source = False

        # audio graph
        a_args: List[str] = []
        if audio["sfx"]:
            cmd += ["-i", audio["sfx"]]
        if use_source and audio["sfx"]:
            filt.append(f"[0:a][{sfx_idx}:a]amix=inputs=2:duration=longest[a]")
            maps += ["-map", "[a]"]
            a_args = ["-c:a", "aac", "-b:a", "192k"]
        elif use_source:
            maps += ["-map", "0:a?"]
            a_args = ["-c:a", "aac", "-b:a", "192k"]
        elif audio["sfx"]:
            maps += ["-map", f"{sfx_idx}:a"]
            a_args = ["-c:a", "aac", "-b:a", "192k"]
        else:
            a_args = ["-an"]

        if filt:
            cmd += ["-filter_complex", ";".join(filt)]
        cmd += maps
        cmd += ["-c:v", vcodec, "-pix_fmt", pixfmt]
        cmd += _profile_args(settings)
        cmd += a_args
        if out_path.lower().endswith((".mp4", ".mov")):
            cmd += ["-movflags", "+faststart"]
        cmd.append(out_path)

        progress(0.72, "encoding")
        _run(cmd, progress)
        progress(1.0, "export complete")
        return {"out": out_path, "frames": n, "mode": mode}
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _profile_args(settings: Dict) -> List[str]:
    args: List[str] = []
    vcodec = settings.get("vcodec", "")
    if "prores" in vcodec:
        args += ["-profile:v", str(settings.get("proresProfile", 4))]  # 4 = 4444
    elif settings.get("bitrate"):
        args += ["-b:v", str(settings["bitrate"])]
    elif vcodec not in ("png",):
        args += ["-crf", str(settings.get("crf", 20))]
    return args


def _run(cmd: List[str], progress: ProgressFn) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("FFmpeg export failed:\n" + proc.stderr[-1500:])
