'use strict';
window.App = window.App || {};

(function () {
  const { h, toast } = App.UI;
  let lane, select, readout;

  const TRACKS = {
    opacity:       { min: 0, max: 1, step: 0.01, def: () => 1, kind: 'num' },
    lineWidth:     { min: 1, max: 12, step: 0.5, def: () => App.state.style.global.box.lineWidth, kind: 'num' },
    confidence:    { min: 0.05, max: 0.95, step: 0.01, def: () => 0.25, kind: 'num' },
    labelsVisible: { kind: 'bool', def: () => true },
    color:         { kind: 'color', def: () => App.state.style.global.box.color },
  };

  function init() {
    lane = document.getElementById('kf-lane');
    select = document.getElementById('kf-track-select');
    readout = document.getElementById('kf-value-readout');
    select.addEventListener('change', renderLane);
    document.getElementById('btn-add-kf').addEventListener('click', addAtPlayhead);
    lane.addEventListener('dblclick', (e) => {
      const t = posToTime(e);
      addKeyframe(t);
    });
  }

  function track() { return select.value; }
  function kfData() { return (App.state.keyframes[track()] = App.state.keyframes[track()] || []); }
  function duration() { return (App.state.video && App.state.video.duration) || 1; }
  function posToTime(e) {
    const r = lane.getBoundingClientRect();
    return Math.max(0, Math.min(duration(), (e.clientX - r.left) / r.width * duration()));
  }

  function addAtPlayhead() {
    if (!App.state.video) { toast('Load a video first', 'err'); return; }
    addKeyframe(App.Viewer.currentTime());
  }

  function addKeyframe(t) {
    const spec = TRACKS[track()];
    const cur = App.Overlay.evalKeyframes({ [track()]: kfData() }, t)[track()];
    const v = (cur != null && kfData().length) ? cur : spec.def();
    kfData().push({ t: +t.toFixed(3), v });
    kfData().sort((a, b) => a.t - b.t);
    renderLane(); App.refresh();
    toast(`Keyframe added: ${track()} @ ${t.toFixed(2)}s`, 'ok', 1800);
  }

  function renderLane() {
    if (!lane) return;
    lane.innerHTML = '';
    const data = App.state.keyframes[track()] || [];
    const d = duration();
    data.forEach((kf, idx) => {
      const x = (kf.t / d) * 100;
      const dot = h('div', { class: 'kf-dot', style: { left: x + '%' }, title: `${track()}=${fmtVal(kf.v)} @ ${kf.t}s\n(drag to move, right-click to delete)` });
      dot.addEventListener('mousedown', (e) => startDrag(e, idx, dot));
      dot.addEventListener('contextmenu', (e) => { e.preventDefault(); data.splice(idx, 1); renderLane(); App.refresh(); });
      lane.appendChild(dot);
    });
    updateReadout(App.state.video ? App.Viewer.currentTime() : 0);
  }

  function startDrag(e, idx, dot) {
    e.preventDefault();
    const data = App.state.keyframes[track()];
    const move = (ev) => {
      const t = posToTime(ev);
      data[idx].t = +t.toFixed(3);
      dot.style.left = (t / duration() * 100) + '%';
      App.refresh();
    };
    const up = () => {
      data.sort((a, b) => a.t - b.t);
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      renderLane();
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }

  function fmtVal(v) {
    if (typeof v === 'number') return v.toFixed(2);
    return String(v);
  }

  function updateReadout(t) {
    if (!readout) return;
    const data = App.state.keyframes[track()];
    if (!data || !data.length) { readout.textContent = '— no keys'; return; }
    const v = App.Overlay.evalKeyframes({ [track()]: data }, t)[track()];
    readout.textContent = `${track()} = ${fmtVal(v)}`;
  }

  window.App.Keyframes = { init, renderLane, updateReadout };
})();
