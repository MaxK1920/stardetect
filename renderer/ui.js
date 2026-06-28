'use strict';
window.App = window.App || {};

(function () {
  // Tiny hyperscript helper.
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function toast(msg, type = 'info', ms = 3800) {
    const t = h('div', { class: `toast ${type}` }, msg);
    document.getElementById('toast-stack').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, ms);
  }

  let activeProgress = 0;
  function progress(value, label) {
    const bar = document.getElementById('progress-bar');
    const fill = document.getElementById('progress-fill');
    const lbl = document.getElementById('progress-label');
    if (value == null) { bar.classList.remove('show'); activeProgress = 0; return; }
    bar.classList.add('show');
    fill.style.width = Math.round(value * 100) + '%';
    lbl.textContent = label || (Math.round(value * 100) + '%');
  }

  // Labeled range with live numeric readout.
  function slider(label, value, min, max, step, onInput, fmt) {
    const val = h('span', { class: 'val' }, fmt ? fmt(value) : String(value));
    const input = h('input', {
      type: 'range', min, max, step, value,
      oninput: (e) => { const v = parseFloat(e.target.value); val.textContent = fmt ? fmt(v) : String(v); onInput(v); },
    });
    return h('div', { class: 'field' },
      h('label', {}, label),
      h('div', { class: 'range-field' }, input, val));
  }

  function colorRow(label, value, onChange) {
    return h('div', { class: 'field-row' },
      h('label', {}, label),
      h('input', { type: 'color', value, oninput: (e) => onChange(e.target.value) }));
  }

  function checkRow(label, checked, onChange) {
    const cb = h('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
    cb.checked = !!checked;
    return h('div', { class: 'toggle-row' }, h('label', {}, label), cb);
  }

  function selectRow(label, value, options, onChange) {
    const sel = h('select', { onchange: (e) => onChange(e.target.value) },
      ...options.map((o) => {
        const opt = h('option', { value: o.value }, o.label);
        if (o.value === value) opt.selected = true;
        return opt;
      }));
    return h('div', { class: 'field' }, h('label', {}, label), sel);
  }

  function textRow(label, value, onChange) {
    return h('div', { class: 'field' }, h('label', {}, label),
      h('input', { type: 'text', value: value || '', oninput: (e) => onChange(e.target.value) }));
  }

  // Type-to-search combobox backed by a native <datalist>. Typing filters the
  // suggestions; any free-text value is accepted and reported via onChange.
  let _comboSeq = 0;
  function comboRow(label, value, options, onChange) {
    const listId = `combo-list-${_comboSeq++}`;
    const dl = h('datalist', { id: listId },
      ...options.map((o) => h('option', { value: o.value }, o.label && o.label !== o.value ? o.label : undefined)));
    const input = h('input', {
      type: 'text', value: value || '', list: listId, placeholder: 'type to search…',
      autocomplete: 'off', spellcheck: 'false',
      onchange: (e) => onChange(e.target.value),
    });
    return h('div', { class: 'field' }, h('label', {}, label),
      h('div', { class: 'combo-field' }, input, dl));
  }

  function group(title, ...children) {
    return h('div', { class: 'group' }, h('h3', {}, title), ...children);
  }

  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function initTabs() {
    document.querySelectorAll('.tabs').forEach((tabs) => {
      const group = tabs.dataset.group;
      tabs.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          const col = tabs.closest('.col');
          col.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab.dataset.tab));
        });
      });
    });
  }

  window.App.UI = { h, toast, progress, slider, colorRow, checkRow, selectRow, textRow, comboRow, group, debounce, initTabs };
})();
