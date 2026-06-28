'use strict';
window.App = window.App || {};

(function () {
  const { h, selectRow, group, toast, progress } = App.UI;
  let queue = [];           // {path, base, status, prog}
  let outputDir = null;
  let exportPresetId = 'mp4_h264';
  let running = false;

  function render() {
    const root = document.getElementById('batch-panel');
    root.innerHTML = '';
    const presets = App.exportPresets || [];

    root.append(
      group('Batch Queue',
        h('div', { class: 'inline', style: { gap: '8px' } },
          h('button', { class: 'btn btn-block', onclick: addFiles }, '＋ Add videos'),
          h('button', { class: 'btn btn-block', onclick: () => { queue = []; render(); } }, 'Clear')),
        selectRow('Export preset (applied to all)', exportPresetId, presets.map((p) => ({ value: p.id, label: p.label })), (v) => { exportPresetId = v; }),
        h('div', { class: 'inline', style: { gap: '8px' } },
          h('button', { class: 'btn btn-block', onclick: pickOut }, '📁 Output folder'),
          h('span', { class: 'mono dim', style: { fontSize: '10px', overflow: 'hidden', textOverflow: 'ellipsis' } }, outputDir || 'not set')),
        h('p', { class: 'hint' }, 'Applies current detection settings + style + selected export preset to every queued video.')),

      group('Items', listEl()),
      h('button', { class: 'btn btn-accent btn-block btn-lg', onclick: run, disabled: running }, running ? 'Running…' : '▶ Run Queue')
    );
  }

  function listEl() {
    const wrap = h('div');
    if (!queue.length) { wrap.appendChild(h('p', { class: 'empty-msg' }, 'No videos queued.')); return wrap; }
    queue.forEach((it) => {
      wrap.appendChild(h('div', { class: 'batch-item' },
        h('div', { class: 'bi-name' }, it.base),
        h('div', { class: 'bi-bar' }, h('i', { style: { width: (it.prog * 100) + '%' } })),
        h('div', { class: 'bi-status' }, h('span', {}, it.status), it.out ? h('a', { class: 'mono', style: { color: 'var(--accent)', cursor: 'pointer' }, onclick: () => window.api.showItem(it.out) }, 'open') : '')));
    });
    return wrap;
  }

  async function addFiles() {
    const files = await window.api.openVideo(true);
    if (!files || !files.length) return;
    for (const f of files) queue.push({ path: f, base: f.split(/[\\/]/).pop().replace(/\.[^.]+$/, ''), status: 'queued', prog: 0 });
    render();
  }

  async function pickOut() { const d = await window.api.openFolder(); if (d) { outputDir = d; render(); } }

  async function run() {
    if (running) return;
    if (!queue.length) { toast('Add videos first', 'err'); return; }
    if (!outputDir) { outputDir = App.state.paths.outputDir; }
    running = true; render();
    const params = App.DetectionPanel.getParams();
    const preset = (App.exportPresets || []).find((p) => p.id === exportPresetId);
    const sfx = App.SoundPanel.getConfig();

    if (params.engine !== 'fallback') {
      try { await window.api.ensureModel(params.model); }
      catch (e) { toast(e.message, 'err', 9000); running = false; render(); return; }
    }

    for (const it of queue) {
      try {
        it.status = 'detecting'; it.prog = 0.05; render();
        const metaPath = `${App.state.paths.userData}/detections/${it.base}.json`.replace(/\\/g, '/');
        await window.api.detect({ ...params, video: it.path, out: metaPath }, (p) => { it.prog = p.value * 0.5; updateItem(it); });
        it.status = 'exporting'; render();
        const ext = preset.ext;
        const suffix = preset.settings.mode === 'alpha' ? '_alpha' : '_overlay';
        const out = preset.settings.mode === 'sequence'
          ? `${outputDir}/${it.base}_seq`.replace(/\\/g, '/')
          : `${outputDir}/${it.base}${suffix}${ext}`.replace(/\\/g, '/');
        const settings = { ...preset.settings, out, video: it.path, audio: { mode: 'none', preset: sfx.preset, custom: sfx.custom, volume: sfx.volume, trigger: sfx.trigger } };
        const res = await window.api.export(metaPath, App.getRenderConfig(), settings, (p) => { it.prog = 0.5 + p.value * 0.5; updateItem(it); });
        it.status = 'done'; it.prog = 1; it.out = res.out; render();
      } catch (e) {
        it.status = 'failed: ' + e.message; render();
      }
    }
    running = false; render();
    progress(null);
    toast('Batch complete', 'ok');
  }

  function updateItem(it) {
    const items = document.querySelectorAll('#batch-panel .batch-item');
    // cheap: re-render whole list occasionally
    progress(it.prog, `${it.base}: ${it.status}`);
  }

  window.App.Batch = { render };
})();
