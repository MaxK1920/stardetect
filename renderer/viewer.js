'use strict';
window.App = window.App || {};

(function () {
  const S = {};
  let rafId = null;
  let _lastDrawnFrame = -1;

  function init() {
    S.video = document.getElementById('video');
    S.canvas = document.getElementById('overlay');
    S.ctx = S.canvas.getContext('2d');
    S.empty = document.getElementById('viewer-empty');
    S.readout = document.getElementById('viewer-readout');
    S.timecode = document.getElementById('timecode');
    S.playhead = document.getElementById('playhead');
    S.track = document.getElementById('timeline-track');
    S.ruler = document.getElementById('timeline-ruler');
    S.coverage = document.getElementById('detect-coverage');

    document.getElementById('btn-play').addEventListener('click', togglePlay);
    document.getElementById('btn-step-fwd').addEventListener('click', () => stepFrame(1));
    document.getElementById('btn-step-back').addEventListener('click', () => stepFrame(-1));

    S.editBtn = document.getElementById('btn-edit-labels');
    if (S.editBtn) S.editBtn.addEventListener('click', toggleEditLabels);
    S.canvas.addEventListener('click', onCanvasClick);

    S.video.addEventListener('loadedmetadata', onLoaded);
    S.video.addEventListener('error', () => {
      const err = S.video.error;
      const msg = `Video load error (code ${err ? err.code : '?'}): ${err ? err.message : 'unknown'}`;
      try { window.api.log('error', msg + ' src=' + S.video.currentSrc); } catch (_) {}
      App.UI.toast(msg, 'err', 8000);
    });
    S.video.addEventListener('timeupdate', () => { if (S.video.paused) redraw(); updateClock(); });
    S.video.addEventListener('play', () => { _lastDrawnFrame = -1; loop(); });
    S.video.addEventListener('pause', () => { document.getElementById('btn-play').textContent = '▶'; updateClock(); });
    S.video.addEventListener('seeked', redraw);

    // timeline scrubbing
    let scrubbing = false;
    const scrub = (e) => {
      const r = S.track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      if (S.video.duration) S.video.currentTime = f * S.video.duration;
    };
    S.track.addEventListener('mousedown', (e) => { scrubbing = true; scrub(e); });
    window.addEventListener('mousemove', (e) => { if (scrubbing) scrub(e); });
    window.addEventListener('mouseup', () => { scrubbing = false; });

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'ArrowRight') { stepFrame(1); }
      else if (e.code === 'ArrowLeft') { stepFrame(-1); }
    });
  }

  async function loadVideo(path) {
    const url = await window.api.mediaUrl(path);
    // Needed so the overlay canvas can sample video pixels (dither fill) without
    // tainting. The media:// handler returns Access-Control-Allow-Origin: *.
    S.video.crossOrigin = 'anonymous';
    S.video.src = url;
    S.video.load();
    App.state.video = { path, url };
    S.empty.style.display = 'none';
  }

  function onLoaded() {
    const w = S.video.videoWidth, h = S.video.videoHeight;
    S.canvas.width = w; S.canvas.height = h;
    const v = App.state.video || {};
    v.width = w; v.height = h; v.duration = S.video.duration;
    // fps from metadata if available, else estimate
    v.fps = (App.state.meta && App.state.meta.fps) || v.fps || 30;
    App.state.video = v;
    buildRuler();
    updateClock();
    redraw();
    if (App.onVideoLoaded) App.onVideoLoaded();
  }

  function fps() { return (App.state.video && App.state.video.fps) || (App.state.meta && App.state.meta.fps) || 30; }
  function frameIndex() { return Math.round(S.video.currentTime * fps()); }

  function objectsAt(frame) {
    const meta = App.state.meta;
    if (!meta) return [];
    if (!S._byFrame || S._metaRef !== meta) {
      S._byFrame = {}; S._metaRef = meta; S._sampled = [];
      for (const fr of meta.frames) { S._byFrame[fr.i] = fr.objects; S._sampled.push(fr.i); }
    }
    if (S._byFrame[frame]) return S._byFrame[frame];
    // forward-fill from nearest previous sampled frame
    let best = null;
    for (const i of S._sampled) { if (i <= frame) best = i; else break; }
    return best != null ? S._byFrame[best] : [];
  }

  function redraw() {
    if (!App.state.video) return;
    const t = S.video.currentTime;
    const objs = objectsAt(frameIndex());
    App.Overlay.drawOverlay(S.ctx, objs, App.getRenderConfig(), t, S.video);
    // readout
    const meta = App.state.meta;
    S.readout.innerHTML = `FRAME ${frameIndex()}<br>OBJECTS ${objs.length}` +
      (meta ? `<br>ENGINE ${meta.engine.toUpperCase()}` : '');
    if (App.Keyframes) App.Keyframes.updateReadout(t);
    if (App.onTimeChange) App.onTimeChange(t);
  }

  function updateClock() {
    const d = S.video.duration || 0, c = S.video.currentTime || 0;
    S.timecode.textContent = `${tc(c)} / ${tc(d)}`;
    if (d) S.playhead.style.left = (c / d * 100) + '%';
  }

  function tc(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60), f = Math.floor((s % 1) * fps());
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
  }

  function buildRuler() {
    S.ruler.innerHTML = '';
    const d = S.video.duration || 0;
    const ticks = Math.min(12, Math.max(4, Math.floor(d)));
    for (let i = 0; i <= ticks; i++) {
      const t = (i / ticks) * d;
      const span = App.UI.h('span', { style: { left: (i / ticks * 100) + '%' } }, t.toFixed(1) + 's');
      S.ruler.appendChild(span);
    }
  }

  function togglePlay() {
    if (!S.video.src) return;
    if (S.video.paused) { S.video.play(); document.getElementById('btn-play').textContent = '❚❚'; }
    else S.video.pause();
  }

  function stepFrame(dir) {
    if (!S.video.src) return;
    S.video.pause();
    S.video.currentTime = Math.max(0, Math.min(S.video.duration || 0, S.video.currentTime + dir / fps()));
  }

  function loop() {
    if (S.video.paused) { cancelAnimationFrame(rafId); return; }
    // The overlay only changes when the video advances to a new frame. On a
    // high-refresh display rAF fires far faster than the video fps, so gate the
    // (CPU-bound) overlay redraw on the frame index changing. updateClock stays
    // every tick so the playhead/timecode remain smooth.
    const fi = frameIndex();
    if (fi !== _lastDrawnFrame) { _lastDrawnFrame = fi; redraw(); }
    updateClock();
    rafId = requestAnimationFrame(loop);
  }

  function setCoverage() {
    // detection covers whole clip in our pipeline; show full bar when meta present
    S.coverage.style.width = App.state.meta ? '100%' : '0';
  }

  // --------------------------------------------------------------------- //
  // Label editing: click a detection box in the preview to rename it.
  // --------------------------------------------------------------------- //
  function toggleEditLabels() {
    S.editLabels = !S.editLabels;
    S.canvas.style.pointerEvents = S.editLabels ? 'auto' : 'none';
    S.canvas.style.cursor = S.editLabels ? 'pointer' : '';
    if (S.editBtn) S.editBtn.classList.toggle('active', S.editLabels);
    if (S.editLabels) {
      S.video.pause();
      App.UI.toast('Label edit: click a detection box to rename it', 'ok', 3500);
    } else {
      closeLabelEditor();
    }
  }

  // Translate a mouse event into video-pixel coordinates on the overlay canvas.
  function eventToVideoPx(e) {
    const r = S.canvas.getBoundingClientRect();
    const sx = S.canvas.width / r.width;
    const sy = S.canvas.height / r.height;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  function hitObject(px) {
    const objs = objectsAt(frameIndex());
    let best = null, bestArea = Infinity;
    for (const o of objs) {
      const [x1, y1, x2, y2] = o.box;
      if (px.x >= x1 && px.x <= x2 && px.y >= y1 && px.y <= y2) {
        const area = (x2 - x1) * (y2 - y1);
        if (area < bestArea) { best = o; bestArea = area; }
      }
    }
    return best;
  }

  function onCanvasClick(e) {
    if (!S.editLabels) return;
    if (!App.state.meta) { App.UI.toast('Run detection first', 'warn'); return; }
    const obj = hitObject(eventToVideoPx(e));
    if (!obj) { closeLabelEditor(); return; }
    openLabelEditor(obj, e);
  }

  function defaultLabelFor(obj) {
    const aliases = (App.state.style.classAliases) || {};
    const cls = aliases[obj.cls] || obj.cls;
    const L = (App.state.style.global && App.state.style.global.label) || {};
    return App.Overlay.formatLabel(L.format || '{class}', cls, obj.conf || 0, obj.id, L.showConfidence, L.showId);
  }

  function openLabelEditor(obj, e) {
    closeLabelEditor();
    const stage = document.getElementById('viewer-stage');
    const r = S.canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const dispX = obj.box[0] / S.canvas.width * r.width + (r.left - sr.left);
    const dispY = obj.box[1] / S.canvas.height * r.height + (r.top - sr.top);

    const input = App.UI.h('input', {
      class: 'label-editor', type: 'text',
      value: obj.label != null ? obj.label : defaultLabelFor(obj),
      placeholder: 'label (blank = default)', spellcheck: 'false', autocomplete: 'off',
    });
    input.style.left = Math.max(0, dispX) + 'px';
    input.style.top = Math.max(0, dispY - 26) + 'px';

    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      applyLabel(obj, input.value.trim());
      closeLabelEditor();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeLabelEditor(); }
    });
    input.addEventListener('blur', commit);
    stage.appendChild(input);
    S.labelEditor = input;
    input.focus(); input.select();
  }

  function closeLabelEditor() {
    if (S.labelEditor) { S.labelEditor.remove(); S.labelEditor = null; }
  }

  // Set (or clear, when empty) a label. With tracking, applies to every frame
  // that shares the object's id so the rename sticks across the whole clip.
  function applyLabel(obj, value) {
    const meta = App.state.meta;
    if (!meta) return;
    const setOne = (o) => { if (value) o.label = value; else delete o.label; };
    if (obj.id != null) {
      for (const fr of meta.frames) for (const o of fr.objects) if (o.id === obj.id) setOne(o);
    } else {
      setOne(obj);
    }
    redraw();
    if (App.state.metaPath) {
      Promise.resolve(window.api.writeJson(App.state.metaPath, meta)).catch((err) => {
        try { window.api.log('error', 'label save failed: ' + (err && err.message)); } catch (_) {}
      });
    }
    App.UI.toast(value ? `Label set: ${value}` : 'Label reset to default', 'ok', 2000);
  }

  function currentTime() { return S.video.currentTime; }
  function seek(t) { S.video.currentTime = t; }

  window.App.Viewer = { init, loadVideo, redraw, currentTime, seek, frameIndex, fps, setCoverage, objectsAt };
})();
