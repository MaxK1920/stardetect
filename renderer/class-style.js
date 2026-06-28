'use strict';
window.App = window.App || {};

(function () {
  const { h, group, toast } = App.UI;

  const PALETTE = ['#14e0ff', '#ff2bd6', '#38e08b', '#ffb524', '#ff4d5e', '#9b5cff', '#00ffa3', '#ff7a00'];

  function classList() {
    const meta = App.state.meta;
    if (!meta) return [];
    return meta.classes || [];
  }

  function classCounts() {
    const meta = App.state.meta; const counts = {}; const ids = {};
    if (!meta) return { counts, ids };
    for (const fr of meta.frames) for (const o of fr.objects) {
      counts[o.cls] = (counts[o.cls] || 0) + 1;
      if (o.id != null) (ids[o.cls] = ids[o.cls] || new Set()).add(o.id);
    }
    return { counts, ids };
  }

  function ensureClassStyle(cls, i) {
    const cs = App.state.style.classStyles;
    if (!cs[cls]) {
      cs[cls] = { box: { color: PALETTE[i % PALETTE.length], glow: { color: PALETTE[i % PALETTE.length] } },
                  label: { bgColor: PALETTE[i % PALETTE.length] } };
    }
    return cs[cls];
  }

  function render() {
    const root = document.getElementById('classes-panel');
    root.innerHTML = '';
    const classes = classList();
    if (!classes.length) {
      root.appendChild(h('p', { class: 'empty-msg' }, 'Run detection to populate detected classes, then style each class independently here.'));
      return;
    }
    const { counts, ids } = classCounts();
    const vis = App.state.style.classVisibility;
    const aliases = App.state.style.classAliases = App.state.style.classAliases || {};

    const clsGroup = group('Per-Class Style');
    classes.forEach((cls, i) => {
      const cs = App.state.style.classStyles[cls];
      const curColor = (cs && cs.box && cs.box.color) || '#14e0ff';
      const visible = vis[cls] !== false;
      const colorInput = h('input', {
        type: 'color', value: curColor, title: 'class color',
        oninput: (e) => {
          const st = ensureClassStyle(cls, i);
          st.box.color = e.target.value; st.box.glow = st.box.glow || {}; st.box.glow.color = e.target.value;
          st.label = st.label || {}; st.label.bgColor = e.target.value;
          swatch.style.background = e.target.value; App.refresh();
        },
      });
      const swatch = h('span', { class: 'swatch', style: { background: curColor } });
      // Rename: shows the display alias; reverts to the original class name when cleared.
      const nameInput = h('input', {
        class: 'cname-input', type: 'text', value: aliases[cls] || cls, title: `rename "${cls}"`,
        spellcheck: 'false', autocomplete: 'off',
        oninput: (e) => {
          const v = e.target.value.trim();
          if (!v || v === cls) delete aliases[cls]; else aliases[cls] = v;
          App.refresh();
        },
      });
      const eye = h('button', { class: 'btn', style: { padding: '3px 8px' }, title: 'show/hide class',
        onclick: () => { vis[cls] = !(vis[cls] !== false); row.classList.toggle('hidden-cls', vis[cls] === false); eye.textContent = vis[cls] === false ? '🚫' : '👁'; App.refresh(); } },
        visible ? '👁' : '🚫');
      const row = h('div', { class: 'class-row' + (visible ? '' : ' hidden-cls') },
        swatch, nameInput, h('span', { class: 'ccount' }, (counts[cls] || 0) + ' det'),
        colorInput, eye);
      clsGroup.appendChild(row);
    });
    root.appendChild(clsGroup);

    // tracked IDs
    if (App.state.meta.tracking) {
      const idGroup = group('Tracked Objects');
      let any = false;
      classes.forEach((cls) => {
        const set = ids[cls]; if (!set) return;
        [...set].sort((a, b) => a - b).forEach((id) => {
          any = true;
          const hidden = App.state.idVisibility[String(id)] === false;
          const btn = h('button', { class: 'btn', style: { padding: '3px 8px' },
            onclick: () => { App.state.idVisibility[String(id)] = !(App.state.idVisibility[String(id)] === false); btn.textContent = App.state.idVisibility[String(id)] === false ? 'hidden' : 'shown'; App.refresh(); } },
            hidden ? 'hidden' : 'shown');
          idGroup.appendChild(h('div', { class: 'class-row' },
            h('span', { class: 'cname' }, `#${id}`), h('span', { class: 'ccount' }, cls), btn));
        });
      });
      if (any) root.appendChild(idGroup);
    }

    root.appendChild(h('button', { class: 'btn btn-block', onclick: () => { App.state.style.classStyles = {}; App.state.style.classVisibility = {}; App.state.style.classAliases = {}; App.state.idVisibility = {}; render(); App.refresh(); toast('Per-class overrides reset', 'ok'); } }, 'Reset class overrides'));
  }

  window.App.ClassStyle = { render };
})();
