"""Detection sound-effects generator for StarDetect.

Synthesises short HUD/sci-fi blips with numpy and can either export a single
preset as a WAV or build a full detection-triggered soundtrack timed to the
detection metadata (for muxing into the final video or exporting standalone).
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from typing import Dict, List, Optional

import numpy as np


SR = 48000
PRESETS = ["digital_blip", "scifi_scanner", "tactical_beep", "glitch_tick", "soft_notify"]


def _env(n: int, attack=0.005, release=0.08) -> np.ndarray:
    e = np.ones(n)
    a = int(SR * attack)
    r = int(SR * release)
    if a > 0:
        e[:a] = np.linspace(0, 1, a)
    if r > 0 and r < n:
        e[-r:] = np.linspace(1, 0, r)
    return e


def _tone(freq: float, dur: float, kind="sine", vol=0.6) -> np.ndarray:
    t = np.linspace(0, dur, int(SR * dur), endpoint=False)
    if kind == "square":
        wave_ = np.sign(np.sin(2 * np.pi * freq * t))
    elif kind == "saw":
        wave_ = 2 * (t * freq - np.floor(0.5 + t * freq))
    else:
        wave_ = np.sin(2 * np.pi * freq * t)
    return (wave_ * _env(len(t)) * vol).astype(np.float32)


def synth_preset(name: str) -> np.ndarray:
    """Return a mono float32 waveform for the named preset."""
    if name == "digital_blip":
        return _tone(1400, 0.06, "sine", 0.5)
    if name == "scifi_scanner":
        t = np.linspace(0, 0.5, int(SR * 0.5), endpoint=False)
        sweep = np.sin(2 * np.pi * (400 + 1600 * t / 0.5) * t)
        return (sweep * _env(len(t), 0.01, 0.2) * 0.45).astype(np.float32)
    if name == "tactical_beep":
        return np.concatenate([_tone(880, 0.05, "square", 0.4),
                               np.zeros(int(SR * 0.03), np.float32),
                               _tone(1320, 0.05, "square", 0.4)])
    if name == "glitch_tick":
        n = int(SR * 0.05)
        noise = (np.random.rand(n).astype(np.float32) * 2 - 1)
        return (noise * _env(n, 0.001, 0.03) * 0.5).astype(np.float32)
    if name == "soft_notify":
        return np.concatenate([_tone(660, 0.12, "sine", 0.35),
                               _tone(990, 0.18, "sine", 0.3)])
    raise ValueError(f"Unknown sound preset: {name}")


def load_audio(path: str) -> np.ndarray:
    """Load an arbitrary audio file as mono float32 at ``SR``.

    Uses FFmpeg when available (handles mp3/ogg/m4a/flac/wav and resamples),
    falling back to a plain WAV reader so the feature degrades gracefully.
    """
    ff = shutil.which("ffmpeg")
    if ff:
        proc = subprocess.run(
            [ff, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
             "-f", "f32le", "-"],
            capture_output=True)
        if proc.returncode == 0 and proc.stdout:
            return np.frombuffer(proc.stdout, dtype=np.float32).copy()
    with wave.open(path, "rb") as w:  # WAV fallback
        ch, sw, n = w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    else:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data.astype(np.float32)


def _source_wave(preset: str, custom: Optional[str]) -> np.ndarray:
    """Return the waveform to place at each trigger (custom file or preset)."""
    return load_audio(custom) if custom else synth_preset(preset)


def write_wav(path: str, samples: np.ndarray, sr: int = SR) -> str:
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return path


def export_sfx(preset: str, out_path: str, custom: Optional[str] = None,
               volume: float = 1.0) -> str:
    return write_wav(out_path, _source_wave(preset, custom) * float(volume))


def _trigger_times(metadata: Dict, mode: str, classes: List[str] | None) -> List[float]:
    """Compute trigger times (seconds) from detection metadata.

    mode: ``new`` (id first seen) | ``enter`` (any object appears in a frame
    that had none of that class before) | ``pulse`` (every ~0.4s while visible)
    | ``all`` (every detection frame with objects).
    """
    times: List[float] = []
    seen_ids = set()
    prev_classes: set = set()
    last_pulse = -1.0
    # 'new' relies on tracked object IDs. If detection ran without tracking,
    # there are no IDs, so fall back to 'enter' (fires when a class appears)
    # instead of producing a silent track.
    if mode == "new":
        has_ids = any(
            o.get("id") is not None
            for fr in metadata.get("frames", []) for o in fr["objects"])
        if not has_ids:
            mode = "enter"
    for fr in metadata.get("frames", []):
        objs = fr["objects"]
        if classes:
            objs = [o for o in objs if o["cls"] in classes]
        t = fr["t"]
        cur_classes = {o["cls"] for o in objs}
        if mode == "new":
            for o in objs:
                if o.get("id") is not None and o["id"] not in seen_ids:
                    seen_ids.add(o["id"])
                    times.append(t)
        elif mode == "enter":
            if cur_classes - prev_classes:
                times.append(t)
        elif mode == "pulse":
            if objs and (t - last_pulse) >= 0.4:
                times.append(t)
                last_pulse = t
        else:  # all
            if objs:
                times.append(t)
        prev_classes = cur_classes
    return times


def export_track(metadata: Dict, preset: str, out_path: str, mode: str = "new",
                 classes: List[str] | None = None, duration: float | None = None,
                 custom: Optional[str] = None, volume: float = 1.0) -> Dict:
    """Build a full soundtrack with the sound placed at every trigger time."""
    times = _trigger_times(metadata, mode, classes)
    dur = duration or metadata.get("duration") or (times[-1] + 1 if times else 1)
    track = np.zeros(int(SR * dur) + SR, dtype=np.float32)
    blip = _source_wave(preset, custom) * float(volume)
    for t in times:
        start = int(t * SR)
        end = min(len(track), start + len(blip))
        track[start:end] += blip[:end - start]
    write_wav(out_path, track)
    return {"path": out_path, "triggers": len(times), "duration": round(dur, 3)}
