"""Shared style + keyframe model for StarDetect overlays.

This module is the single source of truth for how a detection style is
*resolved* at a given point in time. The JavaScript canvas preview renderer
mirrors this same schema and interpolation logic so that the live preview and
the final exported render look identical.

The schema is intentionally plain dict/JSON so styles are editable presets.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional


# Canonical default style. Mirrors renderer/presets default. Keep in sync with
# presets/styles/default.json.
DEFAULT_STYLE: Dict[str, Any] = {
    "name": "Tactical HUD",
    "box": {
        "mode": "corners",        # full | corners
        "shape": "rect",          # rect | rounded
        "lineWidth": 2.0,
        "cornerLength": 18.0,
        "cornerRelative": False,
        "cornerPct": 25.0,
        "radius": 6.0,
        "color": "#000000",
        "opacity": 1.0,
        "glow": {"enabled": False, "blur": 14.0, "color": "#000000"},
        "fill": {"enabled": False, "color": "#000000", "opacity": 0.12},
        "gradient": {"enabled": False, "from": "#00e5ff", "to": "#ff2bd6", "angle": 0.0},
        "dither": {"enabled": False, "colors": ["#c71f05", "#ffe60d"],
                   "grain": 0.25, "levels": 3, "contrast": 1.0, "opacity": 1.0,
                   "fullFrame": False,
                   "pixelSort": {"enabled": False, "direction": "vertical", "reverse": False}},
    },
    "label": {
        "enabled": True,
        "font": "Consolas",
        "fontSize": 16.0,
        "color": "#ffffff",
        "bgColor": "#000000",
        "bgOpacity": 0.92,
        "position": "top",        # top | bottom | inside-top | inside-bottom
        "format": "{class} {conf}",
        "showConfidence": True,
        "showId": False,
        "padding": 5.0,
    },
    "scan": {"enabled": False, "color": "#00e5ff", "opacity": 0.25, "speed": 1.0},
    "trail": {"enabled": False, "length": 8, "decay": 0.6},
}


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _hex_to_rgb(h: str) -> tuple:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _rgb_to_hex(rgb) -> str:
    return "#%02x%02x%02x" % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def lerp_color(c1: str, c2: str, t: float) -> str:
    a, b = _hex_to_rgb(c1), _hex_to_rgb(c2)
    return _rgb_to_hex(tuple(_lerp(a[i], b[i], t) for i in range(3)))


def eval_keyframes(keyframes: Optional[Dict[str, List[dict]]], time_s: float) -> Dict[str, Any]:
    """Evaluate keyframe tracks at a given time (seconds).

    Each track is a list of ``{"t": seconds, "v": value}`` sorted or unsorted.
    Numeric values are linearly interpolated; booleans/strings use step (hold
    previous) interpolation. Colors (hex strings) are interpolated in RGB.

    Returns a dict of ``{track_name: value}`` for tracks that have keyframes.
    """
    result: Dict[str, Any] = {}
    if not keyframes:
        return result
    for name, track in keyframes.items():
        if not track:
            continue
        kfs = sorted(track, key=lambda k: k["t"])
        if time_s <= kfs[0]["t"]:
            result[name] = kfs[0]["v"]
            continue
        if time_s >= kfs[-1]["t"]:
            result[name] = kfs[-1]["v"]
            continue
        for i in range(len(kfs) - 1):
            a, b = kfs[i], kfs[i + 1]
            if a["t"] <= time_s <= b["t"]:
                span = b["t"] - a["t"]
                f = 0.0 if span == 0 else (time_s - a["t"]) / span
                va, vb = a["v"], b["v"]
                if isinstance(va, bool):
                    result[name] = va
                elif isinstance(va, (int, float)) and isinstance(vb, (int, float)):
                    result[name] = _lerp(va, vb, f)
                elif isinstance(va, str) and va.startswith("#"):
                    result[name] = lerp_color(va, vb, f)
                else:
                    result[name] = va
                break
    return result


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def resolve_style(
    global_style: dict,
    class_styles: Optional[Dict[str, dict]],
    cls_name: str,
    kf_values: Dict[str, Any],
) -> dict:
    """Resolve the final style for one detection.

    Layers: DEFAULT_STYLE <- global_style <- class_styles[cls] <- keyframes.
    """
    style = deep_merge(DEFAULT_STYLE, global_style or {})
    if class_styles and cls_name in class_styles:
        style = deep_merge(style, class_styles[cls_name])

    # Apply keyframe overrides (global, affect every object).
    if "opacity" in kf_values:
        style["box"]["opacity"] = float(kf_values["opacity"])
    if "lineWidth" in kf_values:
        style["box"]["lineWidth"] = float(kf_values["lineWidth"])
    if "labelsVisible" in kf_values:
        style["label"]["enabled"] = bool(kf_values["labelsVisible"])
    if "color" in kf_values and isinstance(kf_values["color"], str):
        style["box"]["color"] = kf_values["color"]
    return style


def format_label(fmt: str, cls_name: str, conf: float, obj_id, show_conf: bool, show_id: bool) -> str:
    text = fmt or "{class}"
    text = text.replace("{class}", cls_name)
    text = text.replace("{conf}", f"{conf * 100:.0f}%" if show_conf else "")
    text = text.replace("{id}", f"#{obj_id}" if (show_id and obj_id is not None) else "")
    return " ".join(text.split())  # collapse whitespace from emptied tokens
