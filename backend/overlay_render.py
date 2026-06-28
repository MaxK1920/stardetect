"""Server-side overlay renderer (PIL) for StarDetect exports.

Produces an RGBA overlay image for a single frame given detection metadata and
a render config. The JS canvas renderer in ``renderer/overlay-renderer.js``
mirrors this logic for live preview; this module is the source of truth for the
*final* exported pixels (used for both burned-in and transparent-alpha export).
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Dict, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont

import style_model


_FONT_DIRS = [
    os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts"),
    "/usr/share/fonts", "/Library/Fonts", os.path.expanduser("~/.fonts"),
]
_FONT_ALIASES = {
    "consolas": "consola.ttf", "arial": "arial.ttf", "courier new": "cour.ttf",
    "verdana": "verdana.ttf", "tahoma": "tahoma.ttf", "segoe ui": "segoeui.ttf",
    "impact": "impact.ttf", "georgia": "georgia.ttf", "times new roman": "times.ttf",
}


@lru_cache(maxsize=1)
def _win_font_map() -> Dict[str, str]:
    """Map lowercase font family name -> font file path, from the registry.

    Lets the PIL exporter resolve any installed Windows font family the user
    picks in the UI (e.g. 'Segoe UI Semibold'), not just a hardcoded alias set.
    """
    mapping: Dict[str, str] = {}
    if os.name != "nt":
        return mapping
    try:
        import winreg
        fonts_dir = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")
        for root, sub in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
                          (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")):
            try:
                key = winreg.OpenKey(root, sub)
            except OSError:
                continue
            i = 0
            while True:
                try:
                    disp, val, _ = winreg.EnumValue(key, i)
                except OSError:
                    break
                i += 1
                # "Arial (TrueType)" -> "arial"; first family name before comma
                fam = disp.split("(")[0].strip().split("&")[0].strip()
                path = val if os.path.isabs(val) else os.path.join(fonts_dir, val)
                if fam and os.path.exists(path):
                    mapping.setdefault(fam.lower(), path)
    except Exception:
        pass
    return mapping


@lru_cache(maxsize=64)
def _load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    candidates = []
    reg = _win_font_map().get((name or "").lower().strip())
    if reg:
        candidates.append(reg)
    fname = _FONT_ALIASES.get((name or "").lower().strip(), None)
    if fname:
        candidates.append(fname)
    candidates += [f"{name}.ttf", f"{name}.otf", name]
    for cand in candidates:
        if os.path.isabs(cand) and os.path.exists(cand):
            try:
                return ImageFont.truetype(cand, size)
            except Exception:
                pass
        for d in _FONT_DIRS:
            p = os.path.join(d, cand)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    pass
        try:
            return ImageFont.truetype(cand, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _rgba(hex_color: str, alpha: float) -> Tuple[int, int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return (r, g, b, max(0, min(255, int(alpha * 255))))


def _gradient(size: Tuple[int, int], c1: str, c2: str, angle: float) -> Image.Image:
    import math
    w, h = size
    base = Image.new("RGBA", size)
    px = base.load()
    a, b = _rgba(c1, 1.0), _rgba(c2, 1.0)
    rad = math.radians(angle)
    dx, dy = math.cos(rad), math.sin(rad)
    denom = (abs(dx) * w + abs(dy) * h) or 1
    for y in range(h):
        for x in range(w):
            f = ((x * dx + y * dy) / denom) % 1.0
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(4))
    return base


def _draw_box(draw: ImageDraw.ImageDraw, box, style, line_w, alpha):
    x1, y1, x2, y2 = box
    color = _rgba(style["box"]["color"], alpha)
    mode = style["box"].get("mode", "full")
    if mode == "corners":
        if style["box"].get("cornerRelative"):
            min_side = min(x2 - x1, y2 - y1)
            cl = max(3, int(style["box"].get("cornerPct", 25) / 100.0 * min_side))
        else:
            cl = max(6, int(style["box"].get("cornerLength", 18)))
        rounded = style["box"].get("shape") == "rounded"
        r = min(int(style["box"].get("radius", 6)), cl) if rounded else 0
        # (corner x, corner y, arm dir x, arm dir y, arc start, arc end)
        corners = [
            (x1, y1, 1, 1, 180, 270),
            (x2, y1, -1, 1, 270, 360),
            (x1, y2, 1, -1, 90, 180),
            (x2, y2, -1, -1, 0, 90),
        ]
        for cx, cy, dx, dy, a0, a1 in corners:
            draw.line([(cx + dx * cl, cy), (cx + dx * r, cy)], fill=color, width=line_w)
            draw.line([(cx, cy + dy * r), (cx, cy + dy * cl)], fill=color, width=line_w)
            if r > 0:
                ccx, ccy = cx + dx * r, cy + dy * r
                draw.arc([ccx - r, ccy - r, ccx + r, ccy + r], a0, a1,
                         fill=color, width=line_w)
    elif style["box"].get("shape") == "rounded":
        draw.rounded_rectangle([x1, y1, x2, y2], radius=style["box"].get("radius", 6),
                               outline=color, width=line_w)
    else:
        draw.rectangle([x1, y1, x2, y2], outline=color, width=line_w)


def _dither_fill(source, box, d: Dict, alpha: float, seed=None) -> Optional[Image.Image]:
    """Grain-threshold gradient map of the footage inside ``box``.

    Mirrors ``drawDitherFill`` in renderer/overlay-renderer.js. ``source`` is the
    full RGB frame as an HxWx3 uint8 numpy array. Returns an RGBA tile to paste at
    ``(x1, y1)`` or ``None`` if the source is unavailable.
    """
    if source is None:
        return None
    import numpy as np

    h_src, w_src = source.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    x1 = max(0, min(w_src, x1)); x2 = max(0, min(w_src, x2))
    y1 = max(0, min(h_src, y1)); y2 = max(0, min(h_src, y2))
    if x2 <= x1 or y2 <= y1:
        return None

    crop = source[y1:y2, x1:x2, :3].astype(np.float32) / 255.0
    lum = crop[..., 0] * 0.299 + crop[..., 1] * 0.587 + crop[..., 2] * 0.114

    levels = max(2, int(round(d.get("levels", 3))))
    grain = max(0.0, float(d.get("grain", 0.25)))
    contrast = float(d.get("contrast", 1.0))

    lum = (lum - 0.5) * contrast + 0.5                       # contrast about mid-grey
    rng = np.random.default_rng(seed)
    lum = lum + (rng.random(lum.shape, dtype=np.float32) - 0.5) * grain
    lum = np.clip(lum, 0.0, 1.0)
    lum = np.round(lum * (levels - 1)) / (levels - 1)        # posterize / threshold

    fr, fg, fb, _ = _rgba(d.get("from", "#c71f05"), 1.0)
    tr, tg, tb, _ = _rgba(d.get("to", "#ffe60d"), 1.0)
    stops_lo = np.array([fr, fg, fb], dtype=np.float32)
    stops_hi = np.array([tr, tg, tb], dtype=np.float32)
    rgb = stops_lo + (stops_hi - stops_lo) * lum[..., None]

    a = max(0.0, min(1.0, float(d.get("opacity", 1.0)) * alpha))
    out = np.empty((lum.shape[0], lum.shape[1], 4), dtype=np.uint8)
    out[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[..., 3] = int(a * 255)
    return Image.fromarray(out, mode="RGBA")


def render_overlay(width: int, height: int, objects: List[Dict],
                   render_config: Dict, time_s: float, source=None) -> Image.Image:
    """Render an RGBA overlay for one frame.

    ``source`` is an optional full-frame RGB numpy array (HxWx3 uint8) of the
    underlying footage, used by the dither gradient fill. When ``None`` the
    dither fill is skipped (transparent), matching the preview's graceful
    fallback when no footage is available.
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    glow_draw = ImageDraw.Draw(glow_layer)

    global_style = render_config.get("global", {})
    class_styles = render_config.get("classStyles", {})
    class_vis = render_config.get("classVisibility", {})
    class_aliases = render_config.get("classAliases", {}) or {}
    id_vis = render_config.get("idVisibility", {})
    global_opacity = float(render_config.get("globalOpacity", 1.0))
    kf = style_model.eval_keyframes(render_config.get("keyframes"), time_s)

    conf_thresh = kf.get("confidence")
    max_glow_blur = 0.0
    for obj in objects:
        cname = obj.get("cls", "object")
        if conf_thresh is not None and obj.get("conf", 0.0) < conf_thresh:
            continue
        if class_vis.get(cname, True) is False:
            continue
        oid = obj.get("id")
        if oid is not None and id_vis.get(str(oid), True) is False:
            continue

        style = style_model.resolve_style(global_style, class_styles, cname, kf)
        box = obj["box"]
        x1, y1, x2, y2 = box
        alpha = max(0.0, min(1.0, style["box"]["opacity"] * global_opacity))
        line_w = max(1, int(round(style["box"]["lineWidth"])))

        # fill / gradient — dither takes precedence when enabled + footage present
        fill = style["box"].get("fill", {})
        grad = style["box"].get("gradient", {})
        dith = style["box"].get("dither", {})
        dither_tile = None
        if dith.get("enabled"):
            dither_tile = _dither_fill(source, box, dith, alpha)
        if dither_tile is not None:
            img.alpha_composite(dither_tile, (max(0, int(x1)), max(0, int(y1))))
        elif grad.get("enabled"):
            g = _gradient((max(1, int(x2 - x1)), max(1, int(y2 - y1))),
                          grad.get("from", "#00e5ff"), grad.get("to", "#ff2bd6"),
                          grad.get("angle", 0))
            ga = int(alpha * fill.get("opacity", 0.25) * 255) if fill.get("enabled") else int(alpha * 0.3 * 255)
            g.putalpha(g.getchannel("A").point(lambda _: ga))
            img.alpha_composite(g, (int(x1), int(y1)))
        elif fill.get("enabled"):
            draw.rectangle([x1, y1, x2, y2],
                           fill=_rgba(fill.get("color", "#00e5ff"),
                                      alpha * fill.get("opacity", 0.12)))

        # glow (draw onto glow layer)
        glow = style["box"].get("glow", {})
        if glow.get("enabled"):
            _draw_box(glow_draw, box, style, line_w + 2,
                      alpha)  # use box color in alpha; recolor below
            max_glow_blur = max(max_glow_blur, float(glow.get("blur", 12)))

        _draw_box(draw, box, style, line_w, alpha)

        # label
        lab = style["label"]
        if lab.get("enabled", True):
            custom = obj.get("label")
            if custom:
                text = str(custom)
            else:
                text = style_model.format_label(
                    lab.get("format", "{class}"), class_aliases.get(cname, cname),
                    obj.get("conf", 0.0), oid,
                    lab.get("showConfidence", True), lab.get("showId", False))
            if text:
                font = _load_font(lab.get("font", "Consolas"), int(lab.get("fontSize", 16)))
                pad = int(lab.get("padding", 5))
                tb = draw.textbbox((0, 0), text, font=font)
                tw, th = tb[2] - tb[0], tb[3] - tb[1]
                pos = lab.get("position", "top")
                lx = x1
                if pos in ("bottom", "inside-bottom"):
                    ly = (y2 if pos == "bottom" else y2 - th - 2 * pad)
                else:
                    ly = (y1 - th - 2 * pad if pos == "top" else y1)
                bg = _rgba(lab.get("bgColor", "#00e5ff"),
                           alpha * lab.get("bgOpacity", 0.9))
                draw.rectangle([lx, ly, lx + tw + 2 * pad, ly + th + 2 * pad], fill=bg)
                draw.text((lx + pad, ly + pad - tb[1]), text, font=font,
                          fill=_rgba(lab.get("color", "#001218"), alpha))

    # composite glow under main strokes
    if max_glow_blur > 0:
        glow_blurred = glow_layer.filter(ImageFilter.GaussianBlur(max_glow_blur))
        out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        out.alpha_composite(glow_blurred)
        out.alpha_composite(img)
        return out
    return img
