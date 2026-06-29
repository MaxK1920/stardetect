'use strict';
// Canvas overlay renderer. Mirrors backend/overlay_render.py + style_model.py so
// the live preview matches the final export. Pure functions on window.App.Overlay.

window.App = window.App || {};

(function () {
  const DEFAULT_STYLE = {
    box: {
      mode: 'corners', shape: 'rect', lineWidth: 2, cornerLength: 18, cornerRelative: false, cornerPct: 25, radius: 6,
      color: '#000000', opacity: 1,
      glow: { enabled: false, blur: 14, color: '#000000' },
      fill: { enabled: false, color: '#000000', opacity: 0.12 },
      gradient: { enabled: false, from: '#00e5ff', to: '#ff2bd6', angle: 0 },
      dither: { enabled: false, from: '#c71f05', to: '#ffe60d', grain: 0.25, levels: 3, contrast: 1, opacity: 1,
               fullFrame: false,
               pixelSort: { enabled: false, direction: 'vertical', reverse: false } },
    },
    label: {
      enabled: true, font: 'Consolas', fontSize: 16, color: '#ffffff',
      bgColor: '#000000', bgOpacity: 0.92, position: 'top',
      format: '{class} {conf}', showConfidence: true, showId: false, padding: 5,
    },
    scan: { enabled: false, color: '#00e5ff', opacity: 0.25, speed: 1 },
    trail: { enabled: false, length: 8, decay: 0.6 },
  };

  function hexToRgb(h) {
    h = (h || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpColor(c1, c2, t) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    const v = a.map((x, i) => Math.round(lerp(x, b[i], t)));
    return '#' + v.map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function deepMerge(base, ov) {
    const out = JSON.parse(JSON.stringify(base));
    for (const k in (ov || {})) {
      if (ov[k] && typeof ov[k] === 'object' && !Array.isArray(ov[k]) && typeof out[k] === 'object')
        out[k] = deepMerge(out[k], ov[k]);
      else out[k] = ov[k];
    }
    return out;
  }

  function evalKeyframes(keyframes, t) {
    const res = {};
    if (!keyframes) return res;
    for (const name in keyframes) {
      const track = keyframes[name];
      if (!track || !track.length) continue;
      const kfs = track.slice().sort((a, b) => a.t - b.t);
      if (t <= kfs[0].t) { res[name] = kfs[0].v; continue; }
      if (t >= kfs[kfs.length - 1].t) { res[name] = kfs[kfs.length - 1].v; continue; }
      for (let i = 0; i < kfs.length - 1; i++) {
        const a = kfs[i], b = kfs[i + 1];
        if (a.t <= t && t <= b.t) {
          const span = b.t - a.t, f = span === 0 ? 0 : (t - a.t) / span;
          if (typeof a.v === 'boolean') res[name] = a.v;
          else if (typeof a.v === 'number') res[name] = lerp(a.v, b.v, f);
          else if (typeof a.v === 'string' && a.v[0] === '#') res[name] = lerpColor(a.v, b.v, f);
          else res[name] = a.v;
          break;
        }
      }
    }
    return res;
  }

  function resolveStyle(global, classStyles, cls, kf) {
    let s = deepMerge(DEFAULT_STYLE, global || {});
    if (classStyles && classStyles[cls]) s = deepMerge(s, classStyles[cls]);
    if ('opacity' in kf) s.box.opacity = kf.opacity;
    if ('lineWidth' in kf) s.box.lineWidth = kf.lineWidth;
    if ('labelsVisible' in kf) s.label.enabled = !!kf.labelsVisible;
    if ('color' in kf && typeof kf.color === 'string') s.box.color = kf.color;
    return s;
  }

  function formatLabel(fmt, cls, conf, id, showConf, showId) {
    let t = fmt || '{class}';
    t = t.replace('{class}', cls);
    t = t.replace('{conf}', showConf ? Math.round(conf * 100) + '%' : '');
    t = t.replace('{id}', (showId && id != null) ? '#' + id : '');
    return t.replace(/\s+/g, ' ').trim();
  }

  // One corner bracket. (cx,cy)=corner; dx,dy = direction the arms run (±1);
  // r = corner radius (0 = sharp L).
  function cornerBracket(ctx, cx, cy, dx, dy, cl, r) {
    ctx.moveTo(cx + dx * cl, cy);
    ctx.lineTo(cx + dx * r, cy);
    if (r > 0) ctx.quadraticCurveTo(cx, cy, cx, cy + dy * r);
    ctx.lineTo(cx, cy + dy * cl);
  }

  function drawBoxPath(ctx, x1, y1, x2, y2, style, lw) {
    const b = style.box;
    if (b.mode === 'corners') {
      const minSide = Math.min(x2 - x1, y2 - y1);
      const cl = b.cornerRelative
        ? Math.max(3, (b.cornerPct || 25) / 100 * minSide)
        : Math.max(6, b.cornerLength);
      const r = b.shape === 'rounded' ? Math.min(b.radius, cl) : 0;
      ctx.beginPath();
      cornerBracket(ctx, x1, y1, 1, 1, cl, r);
      cornerBracket(ctx, x2, y1, -1, 1, cl, r);
      cornerBracket(ctx, x1, y2, 1, -1, cl, r);
      cornerBracket(ctx, x2, y2, -1, -1, cl, r);
      ctx.stroke();
    } else if (b.shape === 'rounded') {
      const r = b.radius;
      ctx.beginPath();
      ctx.moveTo(x1 + r, y1);
      ctx.arcTo(x2, y1, x2, y2, r); ctx.arcTo(x2, y2, x1, y2, r);
      ctx.arcTo(x1, y2, x1, y1, r); ctx.arcTo(x1, y1, x2, y1, r);
      ctx.closePath(); ctx.stroke();
    } else {
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
  }

  // Module-level trail history: Map<id, [{box, t}]>.
  let _trailHistory = new Map();
  let _trailLastTime = -Infinity;

  // Reusable offscreen canvas for sampling/processing the source footage.
  let _ditherCanvas = null;
  function ditherScratch(w, h) {
    if (!_ditherCanvas) _ditherCanvas = document.createElement('canvas');
    if (_ditherCanvas.width !== w) _ditherCanvas.width = w;
    if (_ditherCanvas.height !== h) _ditherCanvas.height = h;
    return _ditherCanvas;
  }

  // Sort imageData pixels in each column or row by brightness (in-place).
  function applyPixelSort(imageData, ps) {
    const w = imageData.width, h = imageData.height;
    const px = imageData.data;
    const rev = !!ps.reverse;
    if ((ps.direction || 'vertical') === 'horizontal') {
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          row.push([px[i], px[i+1], px[i+2], px[i+3],
                    px[i]*0.299 + px[i+1]*0.587 + px[i+2]*0.114]);
        }
        row.sort((a, b) => rev ? b[4] - a[4] : a[4] - b[4]);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          px[i]=row[x][0]; px[i+1]=row[x][1]; px[i+2]=row[x][2]; px[i+3]=row[x][3];
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        const col = [];
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          col.push([px[i], px[i+1], px[i+2], px[i+3],
                    px[i]*0.299 + px[i+1]*0.587 + px[i+2]*0.114]);
        }
        col.sort((a, b) => rev ? b[4] - a[4] : a[4] - b[4]);
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          px[i]=col[y][0]; px[i+1]=col[y][1]; px[i+2]=col[y][2]; px[i+3]=col[y][3];
        }
      }
    }
  }

  // Draw a ghost (trail) frame: box stroke + label at the given alpha.
  function drawGhostBox(ctx, obj, style, alpha, displayCls) {
    const [x1, y1, x2, y2] = obj.box;
    const b = style.box;
    const lw = Math.max(1, b.lineWidth);
    ctx.save();
    ctx.lineWidth = lw; ctx.lineCap = 'square';
    ctx.strokeStyle = rgba(b.color, alpha);
    if (b.glow && b.glow.enabled) {
      ctx.shadowColor = rgba(b.glow.color, alpha);
      ctx.shadowBlur = b.glow.blur;
    }
    drawBoxPath(ctx, x1, y1, x2, y2, style, lw);
    ctx.restore();
    const L = style.label;
    if (L.enabled) {
      const text = (obj.label != null && obj.label !== '')
        ? obj.label
        : formatLabel(L.format, displayCls || obj.cls, obj.conf || 0, obj.id, L.showConfidence, L.showId);
      if (text) {
        ctx.font = `${L.fontSize}px "${L.font}", monospace`;
        ctx.textBaseline = 'top';
        const pad = L.padding;
        const tw = ctx.measureText(text).width;
        const th = L.fontSize;
        let lx = x1, ly;
        if (L.position === 'bottom') ly = y2;
        else if (L.position === 'inside-bottom') ly = y2 - th - 2 * pad;
        else if (L.position === 'inside-top') ly = y1;
        else ly = y1 - th - 2 * pad;
        ctx.fillStyle = rgba(L.bgColor, alpha * L.bgOpacity);
        ctx.fillRect(lx, ly, tw + 2 * pad, th + 2 * pad);
        ctx.fillStyle = rgba(L.color, alpha);
        ctx.fillText(text, lx + pad, ly + pad);
      }
    }
  }

  // Posterized grain-threshold gradient map of the source footage inside the box.
  // Mirrors backend/overlay_render.py:_dither_fill. ``source`` is any drawable
  // (HTMLVideoElement / canvas) in video-pixel coordinates. Returns false if the
  // source could not be sampled (e.g. tainted canvas) so the caller can fall back.
  function drawDitherFill(ctx, source, x1, y1, x2, y2, d, alpha) {
    const w = Math.max(1, Math.round(x2 - x1));
    const h = Math.max(1, Math.round(y2 - y1));
    let data, sc;
    try {
      sc = ditherScratch(w, h);
      const sctx = sc.getContext('2d', { willReadFrequently: true });
      sctx.clearRect(0, 0, w, h);
      sctx.drawImage(source, Math.round(x1), Math.round(y1), w, h, 0, 0, w, h);
      data = sctx.getImageData(0, 0, w, h);
    } catch (_) {
      return false;
    }
    const px = data.data;
    const levels = Math.max(2, Math.round(d.levels || 3));
    const grain = Math.max(0, d.grain || 0);
    const contrast = d.contrast != null ? d.contrast : 1;
    const colors = (d.colors && d.colors.length >= 2) ? d.colors : [d.from || '#c71f05', d.to || '#ffe60d'];
    const parsedColors = colors.map(hexToRgb);
    const numStops = parsedColors.length;
    for (let i = 0; i < px.length; i += 4) {
      let lum = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
      lum = (lum - 0.5) * contrast + 0.5;                  // contrast about mid-grey
      lum += (Math.random() - 0.5) * grain;                // pre-threshold grain
      lum = lum < 0 ? 0 : lum > 1 ? 1 : lum;
      lum = Math.round(lum * (levels - 1)) / (levels - 1); // posterize / threshold
      const t = lum * (numStops - 1);
      const seg = Math.min(numStops - 2, Math.floor(t));
      const tSeg = t - seg;
      const [r0, g0, b0] = parsedColors[seg];
      const [r1, g1, b1] = parsedColors[seg + 1];
      px[i]     = r0 + (r1 - r0) * tSeg;
      px[i + 1] = g0 + (g1 - g0) * tSeg;
      px[i + 2] = b0 + (b1 - b0) * tSeg;
      px[i + 3] = 255;
    }
    const ps = d.pixelSort || {};
    if (ps.enabled) applyPixelSort(data, ps);
    sc.getContext('2d').putImageData(data, 0, 0);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, (d.opacity != null ? d.opacity : 1) * alpha));
    ctx.drawImage(sc, Math.round(x1), Math.round(y1));
    ctx.restore();
    return true;
  }

  // Draw one resolved object. ctx in video-pixel coordinates. ``source`` is the
  // underlying footage (video/canvas) sampled by the dither fill, if enabled.
  function drawObject(ctx, obj, style, globalOpacity, displayCls, source) {
    const [x1, y1, x2, y2] = obj.box;
    const alpha = Math.max(0, Math.min(1, style.box.opacity * globalOpacity));
    const lw = Math.max(1, style.box.lineWidth);
    const b = style.box;

    // dither (grain-threshold gradient map of the footage) takes precedence over
    // solid/gradient fill when enabled and a source frame is available.
    const ditherDone = (b.dither && b.dither.enabled && source)
      ? drawDitherFill(ctx, source, x1, y1, x2, y2, b.dither, alpha)
      : false;

    // fill / gradient
    if (ditherDone) {
      /* interior already painted by the dither fill */
    } else if (b.gradient.enabled) {
      const ang = (b.gradient.angle || 0) * Math.PI / 180;
      const g = ctx.createLinearGradient(x1, y1, x1 + Math.cos(ang) * (x2 - x1), y1 + Math.sin(ang) * (y2 - y1));
      g.addColorStop(0, rgba(b.gradient.from, alpha * (b.fill.enabled ? b.fill.opacity : 0.3)));
      g.addColorStop(1, rgba(b.gradient.to, alpha * (b.fill.enabled ? b.fill.opacity : 0.3)));
      ctx.fillStyle = g; ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    } else if (b.fill.enabled) {
      ctx.fillStyle = rgba(b.fill.color, alpha * b.fill.opacity);
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    // stroke + glow
    ctx.save();
    ctx.lineWidth = lw; ctx.lineCap = 'square'; ctx.strokeStyle = rgba(b.color, alpha);
    if (b.glow.enabled) { ctx.shadowColor = rgba(b.glow.color, alpha); ctx.shadowBlur = b.glow.blur; }
    drawBoxPath(ctx, x1, y1, x2, y2, style, lw);
    ctx.restore();

    // label
    const L = style.label;
    if (L.enabled) {
      const text = (obj.label != null && obj.label !== '')
        ? obj.label
        : formatLabel(L.format, displayCls || obj.cls, obj.conf || 0, obj.id, L.showConfidence, L.showId);
      if (text) {
        ctx.font = `${L.fontSize}px "${L.font}", monospace`;
        ctx.textBaseline = 'top';
        const pad = L.padding;
        const tw = ctx.measureText(text).width;
        const th = L.fontSize;
        let lx = x1, ly;
        if (L.position === 'bottom') ly = y2;
        else if (L.position === 'inside-bottom') ly = y2 - th - 2 * pad;
        else if (L.position === 'inside-top') ly = y1;
        else ly = y1 - th - 2 * pad;
        ctx.fillStyle = rgba(L.bgColor, alpha * L.bgOpacity);
        ctx.fillRect(lx, ly, tw + 2 * pad, th + 2 * pad);
        ctx.fillStyle = rgba(L.color, alpha);
        ctx.fillText(text, lx + pad, ly + pad);
      }
    }
  }

  function drawOverlay(ctx, objects, config, time, source) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const kf = evalKeyframes(config.keyframes, time);
    const gOp = (config.globalOpacity != null ? config.globalOpacity : 1);

    // optional scanline aesthetic (from global style)
    const gs = deepMerge(DEFAULT_STYLE, config.global || {});
    if (gs.scan && gs.scan.enabled) {
      const sy = (time * 180 * (gs.scan.speed || 1)) % h;
      ctx.fillStyle = rgba(gs.scan.color, gs.scan.opacity * gOp);
      ctx.fillRect(0, sy, w, 2);
    }

    const gsDith = (gs.box && gs.box.dither) || {};
    if (gsDith.enabled && gsDith.fullFrame && source) {
      drawDitherFill(ctx, source, 0, 0, w, h, gsDith, gOp);
    }

    const confThresh = ('confidence' in kf) ? kf.confidence : null;
    const aliases = config.classAliases || {};

    const trail = gs.trail || {};
    const trailEnabled = !!trail.enabled;
    const trailLen = Math.max(1, Math.round(trail.length || 8));
    const trailDecay = trail.decay != null ? trail.decay : 0.6;
    if (time < _trailLastTime - 0.5) _trailHistory.clear();
    _trailLastTime = time;

    for (let _oi = 0; _oi < objects.length; _oi++) {
      const obj = objects[_oi];
      const cls = obj.cls || 'object';
      if (confThresh != null && (obj.conf || 0) < confThresh) continue;
      if (config.classVisibility && config.classVisibility[cls] === false) continue;
      if (obj.id != null && config.idVisibility && config.idVisibility[String(obj.id)] === false) continue;
      const style = resolveStyle(config.global, config.classStyles, cls, kf);
      const alpha = Math.max(0, Math.min(1, style.box.opacity * gOp));
      const trailKey = obj.id != null ? obj.id : _oi;

      if (trailEnabled) {
        const hist = _trailHistory.get(trailKey) || [];
        for (let ti = 0; ti < hist.length; ti++) {
          const age = hist.length - ti;
          const ghostAlpha = Math.pow(trailDecay, age) * alpha;
          if (ghostAlpha > 0.005)
            drawGhostBox(ctx, { box: hist[ti].box, cls: obj.cls, conf: obj.conf, id: obj.id, label: obj.label },
                         style, ghostAlpha, aliases[cls] || cls);
        }
      }

      drawObject(ctx, obj, style, gOp, aliases[cls] || cls, source);

      if (trailEnabled) {
        const hist = _trailHistory.get(trailKey) || [];
        hist.push({ box: obj.box.slice(), t: time });
        while (hist.length > trailLen) hist.shift();
        _trailHistory.set(trailKey, hist);
      }
    }
  }

  // Instant example box for the style editor (no detection needed).
  function drawExampleBox(ctx, config) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(0, 0, w, h);
    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const style = resolveStyle(config.global, null, '__example__', {});
    const obj = { box: [w * 0.18, h * 0.28, w * 0.82, h * 0.8], cls: 'subject', conf: 0.94, id: 7 };
    // Synthetic "footage" so the dither fill has something to sample in the
    // example. A diagonal luminance ramp + soft blob reads like real content.
    const src = document.createElement('canvas');
    src.width = w; src.height = h;
    const sctx = src.getContext('2d');
    const lg = sctx.createLinearGradient(0, 0, w, h);
    lg.addColorStop(0, '#10131a'); lg.addColorStop(0.5, '#7d8794'); lg.addColorStop(1, '#f2f5fb');
    sctx.fillStyle = lg; sctx.fillRect(0, 0, w, h);
    const rg = sctx.createRadialGradient(w * 0.5, h * 0.55, 8, w * 0.5, h * 0.55, h * 0.5);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = rg; sctx.fillRect(0, 0, w, h);
    drawObject(ctx, obj, style, config.globalOpacity != null ? config.globalOpacity : 1, null, src);
  }

  window.App.Overlay = {
    DEFAULT_STYLE, drawOverlay, drawExampleBox, resolveStyle, evalKeyframes,
    formatLabel, hexToRgb, lerpColor,
  };
})();
