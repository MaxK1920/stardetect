'use strict';
window.App = window.App || {};

(function () {
  const { h, group, toast } = App.UI;
  let styles = [];

  async function load() { styles = await window.api.listStyles(); }

  function render() {
    const root = document.getElementById('presets-panel');
    root.innerHTML = '';

    const nameInput = h('input', { type: 'text', placeholder: 'preset name…', value: App.state.style.name || '' });
    root.append(
      group('Save Current Style',
        nameInput,
        h('button', { class: 'btn btn-accent btn-block', style: { marginTop: '8px' }, onclick: () => saveCurrent(nameInput.value) }, '⤓ Save preset'),
        h('p', { class: 'hint' }, 'Saves global style + per-class overrides as editable JSON in presets/styles.')),

      group('Style Presets', listEl())
    );
  }

  function listEl() {
    const wrap = h('div');
    if (!styles.length) { wrap.appendChild(h('p', { class: 'empty-msg' }, 'No presets found.')); return wrap; }
    styles.forEach((p) => {
      const g = p.data.global || {};
      const colors = [g.box && g.box.color, g.box && g.box.glow && g.box.glow.color, g.label && g.label.bgColor].filter(Boolean);
      wrap.appendChild(h('div', { class: 'preset-card', onclick: () => apply(p) },
        h('div', {}, h('div', { class: 'pc-name' }, p.data.name || p.name),
          h('div', { class: 'pc-meta' }, (g.box ? g.box.mode : '') + (g.box && g.box.gradient && g.box.gradient.enabled ? ' · gradient' : ''))),
        h('div', { class: 'preset-swatch' }, ...colors.map((c) => h('i', { style: { background: c } })))));
    });
    return wrap;
  }

  function apply(p) {
    const d = JSON.parse(JSON.stringify(p.data));
    App.state.style = {
      name: d.name || p.name,
      global: d.global || App.Overlay.DEFAULT_STYLE,
      classStyles: d.classStyles || {},
      classVisibility: d.classVisibility || {},
      classAliases: d.classAliases || {},
    };
    App.StyleEditor.render();
    App.ClassStyle.render();
    App.refresh();
    toast(`Applied preset: ${App.state.style.name}`, 'ok');
  }

  async function saveCurrent(name) {
    name = (name || '').trim() || 'Untitled Style';
    const data = {
      global: App.state.style.global,
      classStyles: App.state.style.classStyles,
      classVisibility: App.state.style.classVisibility,
      classAliases: App.state.style.classAliases || {},
    };
    await window.api.saveStyle(name, data);
    await load(); render();
    toast(`Preset "${name}" saved`, 'ok');
  }

  window.App.Presets = { load, render };
})();
