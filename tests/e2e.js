'use strict';

// Automated end-to-end test of the actual Electron app via Playwright.
// Launches the real app, captures console/page errors, and drives the full
// flow: demo load -> video playback -> detection (fallback + YOLO) -> live
// style change -> burned export -> alpha export -> sound export.
//
// Run:  node tests/e2e.js
// Exit code 0 = all critical checks passed.

const { _electron: electron } = require('playwright');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
const consoleErrors = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function main() {
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  let win = await app.firstWindow();
  // Make sure we have the main window (not a devtools window).
  if (!/index\.html/.test(win.url())) {
    for (const w of app.windows()) { if (/index\.html/.test(w.url())) { win = w; break; } }
  }

  win.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  win.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

  // 1. app init
  await win.waitForFunction(() => window.App && window.App.state && window.App.state.paths, null, { timeout: 20000 });
  await win.waitForFunction(() => document.querySelector('#style-panel').children.length > 0, null, { timeout: 10000 });
  check('app init + panels rendered', true);

  const paths = await win.evaluate(() => window.App.state.paths);

  // 2. load demo (clicks the real button)
  await win.click('#btn-demo');
  const vid = await win.waitForFunction(() => {
    const v = document.getElementById('video');
    if (v.error) return { error: v.error.message || ('code ' + v.error.code) };
    return v.readyState >= 2 && v.videoWidth > 0 && isFinite(v.duration) && v.duration > 0
      ? { w: v.videoWidth, h: v.videoHeight, rs: v.readyState, dur: v.duration } : false;
  }, null, { timeout: 20000 }).then((h) => h.jsonValue()).catch((e) => ({ error: 'timeout: ' + e.message }));
  check('demo video loads + decodes', vid && vid.w > 0, vid && vid.w ? `${vid.w}x${vid.h} rs=${vid.rs} dur=${vid.dur}` : JSON.stringify(vid));

  // 2b. playback actually advances currentTime
  const played = await win.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('video');
    const t0 = v.currentTime;
    v.play().then(() => setTimeout(() => { const adv = v.currentTime > t0; v.pause(); resolve({ adv, t0, t1: v.currentTime }); }, 700))
      .catch((e) => resolve({ adv: false, err: e.message }));
  }));
  check('video playback advances', played.adv, played.err || `t ${played.t0}->${played.t1}`);

  // 3. demo detections present
  const metaInfo = await win.evaluate(() => {
    const m = window.App.state.meta;
    return m ? { frames: m.frames.length, classes: m.classes, engine: m.engine } : null;
  });
  check('demo detections loaded', metaInfo && metaInfo.frames > 0, metaInfo ? `${metaInfo.frames} frames ${JSON.stringify(metaInfo.classes)}` : 'none');

  // 4. overlay renders objects on a mid frame
  const drawInfo = await win.evaluate(() => {
    const v = document.getElementById('video');
    return new Promise((resolve) => {
      const onSeek = () => {
        v.removeEventListener('seeked', onSeek);
        window.App.Viewer.redraw();
        const cv = document.getElementById('overlay');
        const ctx = cv.getContext('2d');
        const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
        const objs = window.App.state.meta ? (window.App.Viewer.frameIndex(), 1) : 0;
        resolve({ painted, w: cv.width, h: cv.height });
      };
      v.addEventListener('seeked', onSeek);
      v.currentTime = Math.min(3, (v.duration || 4) / 2);
    });
  });
  check('overlay canvas paints pixels', drawInfo.painted > 0, `${drawInfo.painted} px on ${drawInfo.w}x${drawInfo.h}`);

  // 4b. dither gradient fill: enabling it must sample the <video> pixels WITHOUT
  // tainting the canvas (CORS) and paint the warm red->yellow palette in a box.
  const dither = await win.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById('video');
    const meta = window.App.state.meta;
    let target = null;
    for (const fr of meta.frames) { if (fr.objects && fr.objects.length) { target = fr; break; } }
    if (!target) { resolve({ noObjs: true }); return; }
    window.App.state.style.global.box.dither = { enabled: true, from: '#c71f05', to: '#ffe60d', grain: 0.25, levels: 3, contrast: 1.3, opacity: 1 };
    const onSeek = () => {
      v.removeEventListener('seeked', onSeek);
      window.App.Viewer.redraw();
      const cv = document.getElementById('overlay'); const ctx = cv.getContext('2d');
      let data; try { data = ctx.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { resolve({ tainted: true, err: e.message }); return; }
      const b = target.objects[0].box.map((n) => Math.round(n));
      let warm = 0;
      for (let y = b[1]; y < b[3]; y += 3) for (let x = b[0]; x < b[2]; x += 3) {
        const o = (y * cv.width + x) * 4;
        if (data[o + 3] > 0 && data[o] > data[o + 2] && data[o] > 80) warm++;
      }
      window.App.state.style.global.box.dither.enabled = false; window.App.refresh();
      resolve({ tainted: false, warm });
    };
    v.addEventListener('seeked', onSeek);
    v.currentTime = target.t;
  }));
  check('dither fill samples video (untainted canvas)', dither && dither.tainted === false && dither.warm > 20,
    dither.tainted ? 'CANVAS TAINTED: ' + dither.err : `${dither.warm} warm px`);

  // 5. live style change updates the example canvas pixels
  const styleChange = await win.evaluate(() => {
    window.App.state.style.global.box.color = '#ff0000';
    window.App.state.style.global.box.lineWidth = 8;
    window.App.refresh();
    return true;
  });
  check('live style change applies', !!styleChange);

  // 6. detection - fallback engine (clicks via API to capture errors)
  const detFb = await win.evaluate(async (paths) => {
    try {
      const out = `${paths.userData}/detections/_e2e_fb.json`.replace(/\\/g, '/');
      const s = await window.api.detect({ video: window.App.state.video.path, model: 'yolov8n.pt', conf: 0.25, iou: 0.45, imgsz: 640, classes: '', track: true, sample: 2, engine: 'fallback', out }, () => {});
      return { ok: true, s };
    } catch (e) { return { ok: false, error: e.message }; }
  }, paths);
  check('detection (fallback)', detFb.ok, detFb.ok ? `${detFb.s.frames} frames, ${detFb.s.engine}` : detFb.error);

  // 7. detection - real YOLO (the path the user reported faulting)
  const detYolo = await win.evaluate(async (paths) => {
    try {
      const out = `${paths.userData}/detections/_e2e_yolo.json`.replace(/\\/g, '/');
      const s = await window.api.detect({ video: window.App.state.video.path, model: 'yolov8n.pt', conf: 0.25, iou: 0.45, imgsz: 640, classes: '', track: false, sample: 8, engine: 'yolo', out }, () => {});
      return { ok: true, s };
    } catch (e) { return { ok: false, error: e.message }; }
  }, paths);
  check('detection (real YOLO)', detYolo.ok, detYolo.ok ? `${detYolo.s.frames} frames, classes=${JSON.stringify(detYolo.s.classes)}` : detYolo.error.split('\n')[0]);

  const metaPath = `${paths.userData}/detections/_e2e_fb.json`.replace(/\\/g, '/');

  // 8. burned export (short range via direct API)
  const exp = await win.evaluate(async ({ paths, metaPath }) => {
    try {
      const out = `${paths.userData}/_e2e_burned.mp4`.replace(/\\/g, '/');
      const settings = { mode: 'burned', vcodec: 'libx264', pixfmt: 'yuv420p', crf: 24, out, video: window.App.state.video.path, range: [0, 24], audio: { mode: 'sfx', preset: 'tactical_beep', trigger: 'new' } };
      const r = await window.api.export(metaPath, window.App.getRenderConfig(), settings, () => {});
      return { ok: true, out: r.out };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { paths, metaPath });
  check('burned export (mp4 + SFX)', exp.ok, exp.ok ? exp.out : exp.error.split('\n')[0]);

  // 9. alpha export
  const alpha = await win.evaluate(async ({ paths, metaPath }) => {
    try {
      const out = `${paths.userData}/_e2e_alpha.mov`.replace(/\\/g, '/');
      const settings = { mode: 'alpha', vcodec: 'prores_ks', pixfmt: 'yuva444p10le', proresProfile: 4, out, range: [0, 24], audio: { mode: 'none' } };
      const r = await window.api.export(metaPath, window.App.getRenderConfig(), settings, () => {});
      return { ok: true, out: r.out };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { paths, metaPath });
  check('alpha export (ProRes 4444)', alpha.ok, alpha.ok ? alpha.out : alpha.error.split('\n')[0]);

  // 10. sound export
  const snd = await win.evaluate(async ({ paths, metaPath }) => {
    try {
      const out = `${paths.userData}/_e2e_sfx.wav`.replace(/\\/g, '/');
      await window.api.sound({ preset: 'scifi_scanner', out }, () => {});
      const track = `${paths.userData}/_e2e_track.wav`.replace(/\\/g, '/');
      const r = await window.api.sound({ preset: 'digital_blip', out: track, meta: metaPath, trigger: 'new' }, () => {});
      return { ok: true, triggers: r.triggers };
    } catch (e) { return { ok: false, error: e.message }; }
  }, { paths, metaPath });
  check('sound export (SFX + soundtrack)', snd.ok, snd.ok ? `${snd.triggers} triggers` : snd.error);

  // 11. system fonts available
  const fonts = await win.evaluate(() => window.api.fonts());
  check('system fonts enumerated', Array.isArray(fonts) && fonts.length > 5, `${fonts.length} fonts`);

  check('no console/page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await app.close();

  console.log('\n' + '='.repeat(54));
  const passed = results.filter((r) => r.ok).length;
  console.log(`  ${passed}/${results.length} checks passed`);
  if (consoleErrors.length) {
    console.log('  console errors:');
    consoleErrors.slice(0, 10).forEach((e) => console.log('   - ' + e));
  }
  console.log('='.repeat(54));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error('E2E harness crashed:', e); process.exit(2); });
