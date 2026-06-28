'use strict';
window.App = window.App || {};

(function () {
  const { h, slider, checkRow, selectRow, textRow, group, toast, progress } = App.UI;
  let root, models = [], yoloAvailable = false;

  const params = {
    model: 'yolov8n.pt', conf: 0.25, iou: 0.45, imgsz: 'auto',
    classes: '', track: false, sample: 1, engine: 'auto',
  };

  // Map a video's largest side to a YOLO-friendly imgsz (multiple of 32, clamped).
  function autoImgsz() {
    const v = App.state.video;
    if (!v || !v.width || !v.height) return 640;
    const maxSide = Math.max(v.width, v.height);
    const snapped = Math.round(maxSide / 32) * 32;
    return Math.max(320, Math.min(1280, snapped));
  }

  async function loadModels() {
    try {
      const res = await window.api.models();
      models = res.models || [];
      yoloAvailable = res.yoloAvailable;
    } catch (e) { models = [{ id: 'yolov8n.pt', label: 'YOLOv8n' }]; }
  }

  function statusNote() {
    if (App.state.deps && !App.state.deps.yolo_ready) {
      return h('div', { class: 'note' }, 'YOLO not detected — detection will run in FALLBACK mode (synthetic detections). Install ultralytics + torch for real YOLO.');
    }
    return null;
  }

  function render() {
    root = document.getElementById('detection-panel');
    root.innerHTML = '';
    const note = statusNote();
    if (note) root.appendChild(note);

    root.append(
      group('Model',
        selectRow('YOLO model', params.model, models.map((m) => ({ value: m.id, label: m.label })), (v) => { params.model = v; }),
        selectRow('Engine', params.engine, [
          { value: 'auto', label: 'Auto (YOLO if available)' },
          { value: 'yolo', label: 'Force YOLO' },
          { value: 'fallback', label: 'Fallback (demo/contour)' }], (v) => { params.engine = v; })),

      group('Parameters',
        slider('Confidence', params.conf, 0.05, 0.95, 0.01, (v) => { params.conf = v; }, (x) => x.toFixed(2)),
        slider('IoU', params.iou, 0.1, 0.9, 0.01, (v) => { params.iou = v; }, (x) => x.toFixed(2)),
        selectRow('Image size', String(params.imgsz),
          [{ value: 'auto', label: `Auto (from video${App.state.video ? ' = ' + autoImgsz() : ''})` },
            ...[320, 416, 512, 640, 768, 960, 1280].map((s) => ({ value: String(s), label: String(s) }))],
          (v) => { params.imgsz = (v === 'auto' ? 'auto' : parseInt(v)); }),
        textRow('Classes (COCO ids, blank = all)', params.classes, (v) => { params.classes = v.trim(); }),
        h('p', { class: 'hint' }, 'e.g. "0,2,7" = person, car, truck. Leave blank to detect everything.'),
        checkRow('Tracking (object IDs)', params.track, (v) => { params.track = v; }),
        slider('Sample every N frames', params.sample, 1, 10, 1, (v) => { params.sample = v; })),

      group('Run',
        h('button', { id: 'btn-detect', class: 'btn btn-accent btn-block btn-lg', onclick: runDetect }, '◎ Detect Whole Video'),
        h('p', { class: 'hint' }, 'Runs detection across the whole clip and stores results as reusable metadata. Changing style afterwards never re-runs detection.'),
        h('div', { id: 'detect-summary' }))
    );
  }

  async function runDetect() {
    if (!App.state.video || !App.state.video.path) { toast('Import a video first', 'err'); return; }
    const paths = App.state.paths;
    const base = App.state.video.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const out = `${paths.userData}/detections/${base}.json`.replace(/\\/g, '/');
    const btn = document.getElementById('btn-detect');
    btn.disabled = true; btn.textContent = 'Detecting…';
    try {
      // Make sure the chosen weights exist locally (downloads via Electron if needed).
      if (params.engine !== 'fallback') {
        progress(0.01, 'Preparing model ' + params.model);
        try {
          const r = await window.api.ensureModel(params.model);
          if (r.downloaded) toast('Downloaded model ' + params.model, 'ok');
        } catch (me) {
          progress(null); toast(me.message, 'err', 9000);
          btn.disabled = false; btn.textContent = '◎ Detect Whole Video';
          return;
        }
      }
      const summary = await window.api.detect({ ...params, video: App.state.video.path, out }, (p) => progress(p.value, 'Detection: ' + p.msg));
      progress(null);
      const meta = await window.api.readJson(out);
      App.setMeta(meta, out);
      showSummary(summary);
      toast(`Detection complete — ${summary.frames} frames, engine: ${summary.engine}`, 'ok');
    } catch (e) {
      progress(null); toast('Detection failed: ' + e.message, 'err', 7000);
    } finally { btn.disabled = false; btn.textContent = '◎ Detect Whole Video'; }
  }

  function showSummary(s) {
    const el = document.getElementById('detect-summary');
    if (!el) return;
    el.innerHTML = '';
    el.append(h('div', { class: 'divider' }),
      h('div', { class: 'inline', style: { flexWrap: 'wrap', gap: '6px' } },
        h('span', { class: 'tag' }, 'engine: ' + s.engine),
        h('span', { class: 'tag' }, 'model: ' + s.model),
        h('span', { class: 'tag' }, s.frames + ' frames'),
        h('span', { class: 'tag' }, (s.tracking ? 'tracking on' : 'tracking off')),
        ...(s.classes || []).map((c) => h('span', { class: 'tag' }, c))));
  }

  window.App.DetectionPanel = { render, loadModels, getParams: () => ({ ...params }) };
})();
