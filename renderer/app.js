'use strict';
window.App = window.App || {};

(function () {
  const { toast, progress } = App.UI;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  App.state = {
    paths: null, deps: null,
    video: null, meta: null, metaPath: null,
    style: { name: 'Tactical HUD', global: clone(App.Overlay.DEFAULT_STYLE), classStyles: {}, classVisibility: {}, classAliases: {} },
    idVisibility: {}, keyframes: {}, globalOpacity: 1,
  };

  App.getRenderConfig = function () {
    return {
      global: App.state.style.global,
      classStyles: App.state.style.classStyles,
      classVisibility: App.state.style.classVisibility,
      classAliases: App.state.style.classAliases || {},
      idVisibility: App.state.idVisibility,
      keyframes: App.state.keyframes,
      globalOpacity: App.state.globalOpacity,
    };
  };

  App.refresh = function () {
    App.Viewer.redraw();
    if (App.StyleEditor) App.StyleEditor.drawExample();
  };

  App.setMeta = function (meta, path) {
    App.state.meta = meta;
    App.state.metaPath = path;
    if (App.state.video) App.state.video.fps = meta.fps;
    App.ClassStyle.render();
    App.Viewer.setCoverage();
    if (App.Keyframes) App.Keyframes.renderLane();
    App.refresh();
  };

  App.onVideoLoaded = function () {
    App.Viewer.setCoverage();
    if (App.Keyframes) App.Keyframes.renderLane();
  };

  App.onTimeChange = function () { /* hook */ };

  function setDepsPill(deps) {
    const pill = document.getElementById('deps-pill');
    const txt = document.getElementById('deps-text');
    pill.classList.remove('ok', 'warn', 'err');
    if (!deps) { pill.classList.add('err'); txt.textContent = 'backend error'; return; }
    const mode = deps.mode === 'yolo' ? 'YOLO' : 'FALLBACK';
    const ff = deps.export_ready ? 'FFmpeg ✓' : 'no FFmpeg';
    txt.textContent = `${mode} · ${ff}`;
    if (deps.yolo_ready && deps.export_ready) pill.classList.add('ok');
    else if (!deps.export_ready) pill.classList.add('err');
    else pill.classList.add('warn');
    pill.title = (deps.messages || []).join('\n') || 'All systems ready';
  }

  async function importVideo() {
    const path = await window.api.openVideo(false);
    if (!path) return;
    App.state.meta = null; App.state.metaPath = null; App.state.keyframes = {};
    await App.Viewer.loadVideo(path);
    App.ClassStyle.render();
    toast('Video imported — run detection to add overlays', 'ok');
  }

  async function loadDemo() {
    const paths = App.state.paths;
    const hasVideo = await window.api.exists(paths.demoVideo);
    progress(0.1, 'Loading demo…');
    try {
      if (!hasVideo) { await window.api.demo(paths.demoVideo, (p) => progress(p.value, 'Demo: ' + p.msg)); }
      await App.Viewer.loadVideo(paths.demoVideo);
      const hasMeta = await window.api.exists(paths.demoMeta);
      if (hasMeta) {
        const meta = await window.api.readJson(paths.demoMeta);
        App.setMeta(meta, paths.demoMeta);
      }
      progress(null);
      toast('Demo loaded' + (hasMeta ? ' with detections' : ' — run detection'), 'ok');
    } catch (e) { progress(null); toast('Demo failed: ' + e.message, 'err'); }
  }

  function installErrorForwarding() {
    window.addEventListener('error', (e) => {
      try { window.api.log('error', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`); } catch (_) {}
    });
    window.addEventListener('unhandledrejection', (e) => {
      try { window.api.log('error', 'unhandledrejection: ' + (e.reason && e.reason.message || e.reason)); } catch (_) {}
    });
    const origErr = console.error.bind(console);
    console.error = (...a) => { try { window.api.log('error', a.map(String).join(' ')); } catch (_) {} origErr(...a); };
  }

  async function init() {
    installErrorForwarding();
    App.UI.initTabs();
    App.state.paths = await window.api.paths();

    // deps check (non-blocking-ish)
    try { App.state.deps = await window.api.depsCheck(); } catch (e) { App.state.deps = null; }
    setDepsPill(App.state.deps);
    if (App.state.deps && App.state.deps.messages && App.state.deps.messages.length)
      App.state.deps.messages.forEach((m) => toast(m, 'warn', 6000));

    // load presets/models/fonts
    App.exportPresets = await window.api.listExports();
    try { App.state.fonts = await window.api.fonts(); } catch (_) { App.state.fonts = []; }
    await App.DetectionPanel.loadModels();
    await App.Presets.load();
    await App.ExportPanel.load();

    // try to adopt the default style preset
    try {
      const def = (await window.api.listStyles()).find((p) => /default|tactical/i.test(p.file));
      if (def && def.data.global) {
        App.state.style = { name: def.data.name, global: def.data.global, classStyles: {}, classVisibility: {}, classAliases: {} };
      }
    } catch (_) {}

    // init modules
    App.Viewer.init();
    App.Keyframes.init();
    App.StyleEditor.render();
    App.DetectionPanel.render();
    App.ClassStyle.render();
    App.SoundPanel.render();
    App.ExportPanel.render();
    App.Batch.render();
    App.Presets.render();

    // top bar wiring
    document.getElementById('btn-import').addEventListener('click', importVideo);
    document.getElementById('btn-demo').addEventListener('click', loadDemo);
    document.getElementById('global-opacity').addEventListener('input', (e) => {
      App.state.globalOpacity = parseFloat(e.target.value); App.refresh();
    });
  }

  window.addEventListener('DOMContentLoaded', init);
})();
