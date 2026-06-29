'use strict';
window.App = window.App || {};

(function () {
  const { h, slider, colorRow, checkRow, selectRow, textRow, comboRow, group } = App.UI;
  let exampleCanvas, exampleCtx, root;

  const FONTS_FALLBACK = ['Consolas', 'JetBrains Mono', 'Chakra Petch', 'Segoe UI', 'Arial',
    'Courier New', 'Verdana', 'Tahoma', 'Impact', 'Georgia'];

  function fontOptions(current) {
    let list = (App.state.fonts && App.state.fonts.length) ? App.state.fonts.slice() : FONTS_FALLBACK.slice();
    if (current && !list.includes(current)) list.unshift(current);
    return list.map((f) => ({ value: f, label: f }));
  }

  function S() { return App.state.style.global; }       // style being edited (global)
  function changed() { App.refresh(); App.markDirty && App.markDirty(); }

  function drawExample() {
    if (!exampleCtx) return;
    App.Overlay.drawExampleBox(exampleCtx, App.getRenderConfig());
  }

  // Re-render the current playhead frame with the active style so the user can
  // confirm how it looks on real detections at the position they're viewing.
  function previewOnFrame() {
    const { toast } = App.UI;
    if (!App.state.video || !App.state.video.path) { toast('Import a video first', 'err'); return; }
    const meta = App.state.meta;
    if (!meta || !meta.frames || !meta.frames.length) {
      toast('Run detection first to preview the style on real boxes', 'warn');
      return;
    }
    App.Viewer.redraw();
    const frame = App.Viewer.frameIndex();
    const objs = App.Viewer.objectsAt ? App.Viewer.objectsAt(frame) : [];
    if (!objs.length) {
      toast(`Frame ${frame} has no detections — scrub the timeline to a frame with objects`, 'warn', 3500);
    } else {
      toast(`Previewing style on frame ${frame} (${objs.length} objects)`, 'ok', 2500);
    }
  }

  function render() {
    root = document.getElementById('style-panel');
    root.innerHTML = '';
    const b = S().box, L = S().label, sc = S().scan;
    // Back-fill the dither block for styles/presets created before it existed.
    const d = b.dither = Object.assign(
      { enabled: false, colors: ['#c71f05', '#ffe60d'], grain: 0.25, levels: 3, contrast: 1, opacity: 1, fullFrame: false },
      b.dither || {});
    if (!d.colors || !d.colors.length) d.colors = [d.from || '#c71f05', d.to || '#ffe60d'];
    const dps = d.pixelSort = Object.assign(
      { enabled: false, direction: 'vertical', reverse: false }, d.pixelSort || {});
    const tr = S().trail = Object.assign(
      { enabled: false, length: 8, decay: 0.6 }, S().trail || {});

    // instant example preview
    exampleCanvas = h('canvas', { width: 318, height: 150, style: { width: '100%', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: '#0a0d12' } });
    const previewBtns = h('div', { class: 'inline', style: { marginTop: '8px', gap: '8px' } },
      h('button', { class: 'btn btn-block', onclick: drawExample }, 'Refresh Example'),
      h('button', { class: 'btn btn-block', onclick: previewOnFrame }, 'Preview on Frame'));

    root.append(
      group('Live Example', exampleCanvas, previewBtns,
        h('p', { class: 'hint' }, 'Instant generic box — no detection needed. "Preview on Frame" applies the style to the current detected frame in the viewer.')),

      group('Box',
        selectRow('Box mode', b.mode, [{ value: 'full', label: 'Full box' }, { value: 'corners', label: 'Corner brackets' }], (v) => { b.mode = v; changed(); }),
        selectRow('Shape', b.shape, [{ value: 'rect', label: 'Rectangle' }, { value: 'rounded', label: 'Rounded' }], (v) => { b.shape = v; changed(); }),
        slider('Line width', b.lineWidth, 1, 12, 0.5, (v) => { b.lineWidth = v; changed(); }),
        checkRow('Corner size relative to box', !!b.cornerRelative, (v) => { b.cornerRelative = v; render(); changed(); }),
        b.cornerRelative
          ? slider('Corner size (% of box)', b.cornerPct != null ? b.cornerPct : 25, 5, 50, 1, (v) => { b.cornerPct = v; changed(); }, (x) => x + '%')
          : slider('Corner length', b.cornerLength, 6, 60, 1, (v) => { b.cornerLength = v; changed(); }),
        slider('Corner radius', b.radius, 0, 40, 1, (v) => { b.radius = v; changed(); }),
        colorRow('Box color', b.color, (v) => { b.color = v; changed(); }),
        slider('Opacity', b.opacity, 0, 1, 0.01, (v) => { b.opacity = v; changed(); }, (x) => x.toFixed(2))),

      group('Glow',
        checkRow('Enable glow', b.glow.enabled, (v) => { b.glow.enabled = v; changed(); }),
        slider('Glow blur', b.glow.blur, 0, 40, 1, (v) => { b.glow.blur = v; changed(); }),
        colorRow('Glow color', b.glow.color, (v) => { b.glow.color = v; changed(); })),

      group('Fill / Gradient',
        checkRow('Solid fill', b.fill.enabled, (v) => { b.fill.enabled = v; changed(); }),
        colorRow('Fill color', b.fill.color, (v) => { b.fill.color = v; changed(); }),
        slider('Fill opacity', b.fill.opacity, 0, 1, 0.01, (v) => { b.fill.opacity = v; changed(); }, (x) => x.toFixed(2)),
        checkRow('Gradient fill', b.gradient.enabled, (v) => { b.gradient.enabled = v; changed(); }),
        colorRow('Gradient from', b.gradient.from, (v) => { b.gradient.from = v; changed(); }),
        colorRow('Gradient to', b.gradient.to, (v) => { b.gradient.to = v; changed(); }),
        slider('Gradient angle', b.gradient.angle, 0, 360, 1, (v) => { b.gradient.angle = v; changed(); })),

      group('Dither Gradient Fill',
        checkRow('Dither gradient fill', d.enabled, (v) => { d.enabled = v; changed(); }),
        checkRow('Apply to full frame', d.fullFrame, (v) => { d.fullFrame = v; changed(); }),
        h('p', { class: 'hint' }, 'Posterizes the footage inside the box, adds grain, and maps brightness through the colors below. Overrides solid/gradient fill when on. "Full frame" applies the dither to the entire video instead of just inside detection boxes.'),
        selectRow('Number of colors', d.colors.length,
          [2, 3, 4, 5, 6].map((n) => ({ value: n, label: `${n} colors` })),
          (v) => {
            const n = parseInt(v, 10);
            while (d.colors.length < n) d.colors.push(d.colors[d.colors.length - 1]);
            d.colors = d.colors.slice(0, n);
            render(); changed();
          }),
        ...d.colors.map((c, i) => {
          const lbl = i === 0 ? 'Color 1 (darkest)'
            : i === d.colors.length - 1 ? `Color ${i + 1} (brightest)`
            : `Color ${i + 1}`;
          return colorRow(lbl, c, (v) => { d.colors[i] = v; changed(); });
        }),
        slider('Noise strength', d.grain, 0, 1, 0.01, (v) => { d.grain = v; changed(); }, (x) => x.toFixed(2)),
        slider('Levels (threshold)', d.levels, 2, 8, 1, (v) => { d.levels = v; changed(); }),
        slider('Contrast', d.contrast, 0.2, 3, 0.05, (v) => { d.contrast = v; changed(); }, (x) => x.toFixed(2)),
        slider('Fill opacity', d.opacity, 0, 1, 0.01, (v) => { d.opacity = v; changed(); }, (x) => x.toFixed(2)),
        checkRow('Pixel sort', dps.enabled, (v) => { dps.enabled = v; changed(); }),
        selectRow('Sort direction', dps.direction,
          [{ value: 'vertical', label: 'Vertical (columns)' }, { value: 'horizontal', label: 'Horizontal (rows)' }],
          (v) => { dps.direction = v; changed(); }),
        checkRow('Reverse sort order', dps.reverse, (v) => { dps.reverse = v; changed(); })),

      group('Label',
        checkRow('Show label', L.enabled, (v) => { L.enabled = v; changed(); }),
        comboRow('Font (type to search)', L.font, fontOptions(L.font), (v) => { L.font = v || L.font; changed(); }),
        slider('Font size', L.fontSize, 8, 48, 1, (v) => { L.fontSize = v; changed(); }),
        textRow('Format ({class} {conf} {id})', L.format, (v) => { L.format = v; changed(); }),
        selectRow('Position', L.position, [
          { value: 'top', label: 'Above box' }, { value: 'bottom', label: 'Below box' },
          { value: 'inside-top', label: 'Inside top' }, { value: 'inside-bottom', label: 'Inside bottom' }], (v) => { L.position = v; changed(); }),
        checkRow('Show confidence', L.showConfidence, (v) => { L.showConfidence = v; changed(); }),
        checkRow('Show object ID', L.showId, (v) => { L.showId = v; changed(); }),
        colorRow('Text color', L.color, (v) => { L.color = v; changed(); }),
        colorRow('Label bg', L.bgColor, (v) => { L.bgColor = v; changed(); }),
        slider('Label bg opacity', L.bgOpacity, 0, 1, 0.01, (v) => { L.bgOpacity = v; changed(); }, (x) => x.toFixed(2)),
        slider('Label padding', L.padding, 0, 20, 1, (v) => { L.padding = v; changed(); })),

      group('Scan Effect',
        checkRow('Enable scanline', sc.enabled, (v) => { sc.enabled = v; changed(); }),
        colorRow('Scan color', sc.color, (v) => { sc.color = v; changed(); }),
        slider('Scan opacity', sc.opacity, 0, 1, 0.01, (v) => { sc.opacity = v; changed(); }, (x) => x.toFixed(2)),
        slider('Scan speed', sc.speed, 0.1, 4, 0.1, (v) => { sc.speed = v; changed(); }, (x) => x.toFixed(1))),

      group('Trail',
        checkRow('Enable trail', tr.enabled, (v) => { tr.enabled = v; changed(); }),
        h('p', { class: 'hint' }, 'Draws ghost copies of previous box positions behind moving tracked objects. Requires object tracking (IDs).'),
        slider('Trail length (frames)', tr.length, 1, 20, 1, (v) => { tr.length = v; changed(); }),
        slider('Opacity decay', tr.decay, 0.1, 0.95, 0.01, (v) => { tr.decay = v; changed(); }, (x) => x.toFixed(2)))
    );

    exampleCtx = exampleCanvas.getContext('2d');
    drawExample();
  }

  window.App.StyleEditor = { render, drawExample };
})();
