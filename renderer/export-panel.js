'use strict';
window.App = window.App || {};

(function () {
  const { h, selectRow, group, toast, progress } = App.UI;
  let presets = [];
  const sel = { presetId: 'mp4_h264', audio: 'source+sfx' };

  const AUDIO_OPTS = [
    { value: 'none', label: 'No audio' },
    { value: 'source', label: 'Source audio only' },
    { value: 'sfx', label: 'Detection SFX only' },
    { value: 'source+sfx', label: 'Source + detection SFX' },
  ];

  async function load() {
    presets = await window.api.listExports();
  }

  function encoderAvailable(s) {
    const enc = (App.state.deps && App.state.deps.ffmpeg_encoders) || {};
    if (!s.vcodec) return true;
    if (s.vcodec === 'libx264' || s.vcodec === 'png') return true;
    return !!enc[s.vcodec];
  }

  function render() {
    const root = document.getElementById('export-panel');
    root.innerHTML = '';
    if (App.state.deps && !App.state.deps.export_ready) {
      root.appendChild(h('div', { class: 'note' }, 'FFmpeg not found — export disabled. Install FFmpeg and restart.'));
    }
    const options = presets.map((p) => ({ value: p.id, label: p.label + (encoderAvailable(p.settings) ? '' : ' (unavailable)') }));

    root.append(
      group('Format',
        selectRow('Export preset', sel.presetId, options, (v) => { sel.presetId = v; render(); }),
        h('p', { class: 'hint', id: 'fmt-hint' }, formatHint())),

      group('Audio',
        selectRow('Audio track', sel.audio, AUDIO_OPTS, (v) => { sel.audio = v; render(); }),
        h('p', { class: 'hint' }, audioHint())),

      group('Run',
        h('button', { class: 'btn btn-accent btn-block btn-lg', onclick: runExport }, '⏏ Export Video'),
        h('p', { class: 'hint' }, App.state.metaPath ? '' : 'Tip: run detection first so the export has detections to render.'))
    );
  }

  function currentPreset() { return presets.find((p) => p.id === sel.presetId) || presets[0]; }
  function audioHint() {
    const enabled = App.SoundPanel ? App.SoundPanel.getConfig().enabled : true;
    if (sel.audio.includes('sfx') && !enabled)
      return 'Detection SFX is turned OFF in the Sound FX tab — this export will have no SFX. Enable it there or pick another audio option.';
    if (sel.audio.includes('sfx'))
      return 'SFX uses the preset + trigger configured in the Sound FX tab.';
    return 'No detection SFX will be muxed for this option.';
  }
  function formatHint() {
    const p = currentPreset(); if (!p) return '';
    const s = p.settings;
    return `mode: ${s.mode}${s.vcodec ? ' · codec: ' + s.vcodec : ''}${s.pixfmt ? ' · ' + s.pixfmt : ''}`;
  }

  async function runExport() {
    if (!App.state.video || !App.state.video.path) { toast('Import a video first', 'err'); return; }
    if (!App.state.metaPath) { toast('Run detection first (need metadata to render)', 'err'); return; }
    const preset = currentPreset();
    if (!encoderAvailable(preset.settings)) { toast('This codec is not available in your FFmpeg build', 'err'); return; }

    const isSeq = preset.settings.mode === 'sequence';
    let out;
    if (isSeq) {
      out = await window.api.openFolder();
    } else {
      const base = App.state.video.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      const suffix = preset.settings.mode === 'alpha' ? '_alpha' : '_overlay';
      out = await window.api.saveFile({
        title: 'Export', defaultPath: `${base}${suffix}${preset.ext}`,
        filters: preset.ext ? [{ name: preset.ext.replace('.', '').toUpperCase(), extensions: [preset.ext.replace('.', '')] }] : undefined,
      });
    }
    if (!out) return;

    const sfx = App.SoundPanel.getConfig();
    // Respect the Sound FX master on/off switch: strip SFX from the audio mode
    // when disabled so the export doesn't try to mux a silent/unwanted track.
    let audioMode = sel.audio;
    if (!sfx.enabled) audioMode = audioMode === 'source+sfx' ? 'source' : (audioMode === 'sfx' ? 'none' : audioMode);
    const settings = {
      ...preset.settings, out,
      video: App.state.video.path,
      audio: { mode: audioMode, preset: sfx.preset, custom: sfx.custom, volume: sfx.volume, trigger: sfx.trigger, classes: sfx.classes },
    };
    try {
      const res = await window.api.export(App.state.metaPath, App.getRenderConfig(), settings, (p) => progress(p.value, 'Export: ' + p.msg));
      progress(null);
      toast(`Export complete → ${res.out}`, 'ok', 6000);
      window.api.showItem(res.out);
    } catch (e) { progress(null); toast('Export failed: ' + e.message, 'err', 8000); }
  }

  window.App.ExportPanel = { load, render };
})();
