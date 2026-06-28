'use strict';
window.App = window.App || {};

(function () {
  const { h, slider, selectRow, textRow, checkRow, group, toast, progress } = App.UI;

  const PRESETS = [
    { value: 'digital_blip', label: 'Subtle digital blip' },
    { value: 'scifi_scanner', label: 'Sci-fi scanner' },
    { value: 'tactical_beep', label: 'Tactical UI beep' },
    { value: 'glitch_tick', label: 'Glitch tick' },
    { value: 'soft_notify', label: 'Soft notification' },
  ];
  const TRIGGERS = [
    { value: 'new', label: 'New tracked object (ID first seen)' },
    { value: 'enter', label: 'Class enters frame' },
    { value: 'pulse', label: 'Repeated pulse while visible' },
    { value: 'all', label: 'Every detection frame' },
  ];

  // User-added sound files: { path, name }. cfg.preset holds either a builtin
  // preset value or the absolute path of a chosen custom file.
  let customs = [];
  const cfg = { enabled: true, preset: 'digital_blip', trigger: 'new', classes: '', volume: 1.0 };

  function isCustom(v) { return customs.some((c) => c.path === v); }
  function presetOptions() {
    return [...PRESETS, ...customs.map((c) => ({ value: c.path, label: '★ ' + c.name }))];
  }
  // Build the backend payload, routing to --preset or --custom as appropriate.
  function soundOpts(extra) {
    const o = { volume: cfg.volume, ...extra };
    if (isCustom(cfg.preset)) o.custom = cfg.preset; else o.preset = cfg.preset;
    return o;
  }

  function render() {
    const root = document.getElementById('sound-panel');
    root.innerHTML = '';
    root.append(
      group('Detection SFX',
        checkRow('Enable sound effects', cfg.enabled, (v) => { cfg.enabled = v; render(); }),
        h('p', { class: 'hint' }, cfg.enabled
          ? 'SFX can be muxed into exports (choose an SFX option in the Export tab) or exported as a standalone WAV.'
          : 'Sound effects are off — exports will have no detection SFX.')),

      group('Sound Design',
        selectRow('Sound', cfg.preset, presetOptions(), (v) => { cfg.preset = v; }),
        h('button', { class: 'btn btn-block', onclick: addCustom }, '＋ Add custom sound…'),
        h('div', { style: { height: '6px' } }),
        slider('Volume', cfg.volume, 0, 2, 0.05, (v) => { cfg.volume = v; }, (x) => Math.round(x * 100) + '%'),
        h('button', { class: 'btn btn-block', onclick: previewSfx }, '▶ Preview sound'),
        h('div', { style: { height: '6px' } }),
        h('button', { class: 'btn btn-block', onclick: exportSfx }, '⤓ Export single SFX (WAV)'),
        h('p', { class: 'hint' }, isCustom(cfg.preset)
          ? 'Using your custom sound file. Volume scales it on preview and export.'
          : 'Built-in synthesised blip. Add your own WAV/MP3/OGG with the button above.')),

      group('Detection Soundtrack',
        selectRow('Trigger', cfg.trigger, TRIGGERS, (v) => { cfg.trigger = v; }),
        textRow('Only classes (comma, blank = all)', cfg.classes, (v) => { cfg.classes = v.trim(); }),
        h('p', { class: 'hint' }, 'Builds a full WAV timed to the detection metadata. Can also be muxed into the final video from the Export tab.'),
        h('button', { class: 'btn btn-accent btn-block', onclick: exportTrack }, '⤓ Export detection soundtrack (WAV)'))
    );
  }

  async function addCustom() {
    const p = await window.api.openAudio();
    if (!p) return;
    const name = p.split(/[\\/]/).pop();
    if (!customs.some((c) => c.path === p)) customs.push({ path: p, name });
    cfg.preset = p;
    render();
    toast('Added custom sound: ' + name, 'ok');
  }

  async function previewSfx() {
    try {
      let url;
      if (isCustom(cfg.preset)) {
        url = await window.api.mediaUrl(cfg.preset);
      } else {
        const tmp = `${App.state.paths.userData}/_preview_${cfg.preset}.wav`.replace(/\\/g, '/');
        await window.api.sound({ preset: cfg.preset, out: tmp }, () => {});
        url = await window.api.mediaUrl(tmp);
      }
      const a = new Audio(url);
      a.volume = Math.max(0, Math.min(1, cfg.volume));
      a.play().catch(() => {});
    } catch (e) { toast('Preview failed: ' + e.message, 'err'); }
  }

  async function exportSfx() {
    const base = isCustom(cfg.preset) ? cfg.preset.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') : cfg.preset;
    const out = await window.api.saveFile({ title: 'Export SFX', defaultPath: `${base}.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] });
    if (!out) return;
    try {
      await window.api.sound(soundOpts({ out }), (p) => progress(p.value, 'Sound: ' + p.msg));
      progress(null); toast('SFX exported', 'ok');
      window.api.showItem(out);
    } catch (e) { progress(null); toast('Export failed: ' + e.message, 'err'); }
  }

  async function exportTrack() {
    if (!App.state.metaPath) { toast('Run detection first', 'err'); return; }
    const out = await window.api.saveFile({ title: 'Export soundtrack', defaultPath: 'detection-sfx.wav', filters: [{ name: 'WAV', extensions: ['wav'] }] });
    if (!out) return;
    try {
      const res = await window.api.sound(soundOpts({ out, meta: App.state.metaPath, trigger: cfg.trigger, classes: cfg.classes }), (p) => progress(p.value, 'Sound: ' + p.msg));
      progress(null); toast(`Soundtrack exported — ${res.triggers} triggers`, 'ok');
      window.api.showItem(out);
    } catch (e) { progress(null); toast('Export failed: ' + e.message, 'err'); }
  }

  // Config consumed by export-panel/batch. Always provides a builtin preset
  // fallback plus an optional custom file path and the volume.
  function getConfig() {
    const custom = isCustom(cfg.preset) ? cfg.preset : '';
    return {
      enabled: cfg.enabled,
      preset: custom ? 'digital_blip' : cfg.preset,
      custom, volume: cfg.volume,
      trigger: cfg.trigger, classes: cfg.classes,
    };
  }

  window.App.SoundPanel = { render, getConfig };
})();
