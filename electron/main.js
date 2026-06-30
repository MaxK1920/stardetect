'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { runBackend, killAll } = require('./backend-bridge');
const log = require('./logger');

const APP_ROOT = path.join(__dirname, '..');
const PRESETS_DIR = path.join(APP_ROOT, 'presets');
const STYLES_DIR = path.join(PRESETS_DIR, 'styles');
const ASSETS_DIR = path.join(APP_ROOT, 'assets');
const isDev = process.argv.includes('--dev');

let mainWindow = null;

// Register the media scheme as privileged BEFORE app is ready so the <video>
// element gets proper streaming + range-request (seeking) support.
protocol.registerSchemesAsPrivileged([
  // corsEnabled lets the renderer draw served <video> frames to a canvas and
  // read them back (getImageData) without tainting it — required by the
  // dither-gradient fill which samples the underlying footage.
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } },
]);

function tmpFile(name) {
  return path.join(os.tmpdir(), `stardetect_${Date.now()}_${name}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0c0e12',
    title: 'StarDetect',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Capture renderer console + crashes into the log file.
  const wc = mainWindow.webContents;
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = level >= 3 ? 'ERROR' : level === 2 ? 'WARN' : 'INFO';
    if (lvl !== 'INFO') log[lvl.toLowerCase()]('renderer', `${message} (${sourceId}:${line})`);
  });
  wc.on('render-process-gone', (_e, d) => log.error('renderer', `process gone: ${d.reason}`));
  wc.on('did-fail-load', (_e, code, desc, url) => log.error('renderer', `did-fail-load ${code} ${desc} ${url}`));
}

const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.jpg': 'image/jpeg',
};

// Serve local media to the renderer with proper HTTP range support so the
// <video> element can determine duration and seek/play. net.fetch('file://')
// does NOT expose range/Content-Length, which left duration=0 and a black,
// unplayable video.
function registerMediaProtocol() {
  protocol.handle('media', async (request) => {
    const u = new URL(request.url);
    // 'media' is a standard scheme, so a Windows path like "C:/..." gets parsed
    // with the drive letter as the URL host ("media://c/Users/..."). Rebuild it.
    let filePath = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (u.hostname) filePath = `${u.hostname}:/${filePath}`;
    let fd = null;
    try {
      const stat = await fs.promises.stat(filePath);
      const type = MEDIA_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      const range = request.headers.get('Range');
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        start = m[1] ? parseInt(m[1], 10) : 0;
        end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= stat.size) end = stat.size - 1;
        if (start > end) { start = 0; end = stat.size - 1; }
        status = 206;
      }
      const len = end - start + 1;
      // Read the exact slice into a Buffer. protocol.handle delivers a Buffer
      // body reliably (web streams via Readable.toWeb corrupted the container).
      const buf = Buffer.alloc(len);
      fd = await fs.promises.open(filePath, 'r');
      await fd.read(buf, 0, len, start);
      const headers = {
        'Content-Type': type,
        'Content-Length': String(len),
        'Accept-Ranges': 'bytes',
        // Allow the renderer's canvas to read pixels from this resource (used by
        // the dither fill). Paired with crossOrigin="anonymous" on the <video>.
        'Access-Control-Allow-Origin': '*',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      return new Response(buf, { status, headers });
    } catch (err) {
      log.error('media', `serve failed for ${filePath}: ${err.message}`);
      return new Response('not found', { status: 404 });
    } finally {
      if (fd) await fd.close().catch(() => {});
    }
  });
}

// Diagnostic: report whether Chromium is using the GPU or falling back to
// software (CPU) rendering on this machine. Surfaces blocklisted GPUs, crashed
// GPU processes and SwiftShader fallback, which all manifest as a sluggish UI.
async function logGpuStatus(phase = 'startup') {
  try {
    // What command line did Chromium actually receive, and is GPU explicitly off?
    if (phase === 'startup') log.info('gpu', `process.argv: ${JSON.stringify(process.argv)}`);
    log.info('gpu', `--- phase: ${phase} ---`);
    ['disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer',
      'use-gl', 'use-angle', 'in-process-gpu', 'disable-gpu-sandbox']
      .forEach((sw) => {
        if (app.commandLine.hasSwitch(sw)) {
          log.warn('gpu', `command-line switch present: --${sw}=${app.commandLine.getSwitchValue(sw) || '(set)'}`);
        }
      });
    const feat = app.getGPUFeatureStatus();
    log.info('gpu', `feature status: ${JSON.stringify(feat)}`);
    // Only a "*_software" value means a feature fell back to CPU. "disabled_off"
    // / "disabled_off_ok" are features Electron intentionally ships off (vulkan,
    // skia_graphite, raw_draw, webnn, direct display compositor) — not CPU
    // fallback. The startup phase reports bootstrap defaults before the GPU
    // process handshake, so only trust 'gpu-info-update' / 'delayed-3s'.
    const swSignals = Object.entries(feat || {})
      .filter(([, v]) => /software/i.test(String(v)))
      .map(([k, v]) => `${k}=${v}`);
    if (swSignals.length) {
      log.warn('gpu', `CPU/software fallback for: ${swSignals.join(', ')}`);
    } else {
      log.info('gpu', 'hardware acceleration ACTIVE for compositing/canvas/WebGL/raster');
    }
    const info = await app.getGPUInfo('complete');
    const aux = (info && info.auxAttributes) || {};
    log.info('gpu', `glRenderer=${aux.glRenderer || '?'} glVendor=${aux.glVendor || '?'} `
      + `swRendering=${aux.softwareRendering} glImplementation=${aux.glImplementation || '?'} `
      + `glResetNotificationStrategy=${aux.glResetNotificationStrategy}`);
    const devices = (info && info.gpuDevice) || [];
    if (!devices.length) {
      log.warn('gpu', 'no GPU device reported — GPU process did not enumerate any adapter.');
    }
    devices.forEach((d, i) => {
      log.info('gpu', `device[${i}] vendorId=${d.vendorId} deviceId=${d.deviceId} `
        + `active=${d.active} driverVendor=${d.driverVendor || '?'} driverVersion=${d.driverVersion || '?'}`);
    });
    if (aux.glRenderer && /swiftshader|llvmpipe|software/i.test(aux.glRenderer)) {
      log.warn('gpu', `GL renderer is software (${aux.glRenderer}) — UI is running on CPU.`);
    }
  } catch (err) {
    log.warn('gpu', `status query failed: ${err.message}`);
  }
}

app.whenReady().then(() => {
  log.clear();
  log.info('app', `StarDetect starting (electron ${process.versions.electron})`);
  registerMediaProtocol();
  createWindow();
  logGpuStatus('startup');
  // The GPU process completes its handshake asynchronously; the startup query
  // above can report bootstrap "software" defaults. Re-query once the real
  // status arrives and again after a short delay to capture steady state.
  app.once('gpu-info-update', () => logGpuStatus('gpu-info-update'));
  setTimeout(() => logGpuStatus('delayed-3s'), 3000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killAll();
  if (process.platform !== 'darwin') app.quit();
});

// --------------------------------------------------------------------------- //
// IPC: paths + filesystem
// --------------------------------------------------------------------------- //
ipcMain.handle('app:paths', () => ({
  appRoot: APP_ROOT,
  presetsDir: PRESETS_DIR,
  stylesDir: STYLES_DIR,
  assetsDir: ASSETS_DIR,
  demoVideo: path.join(ASSETS_DIR, 'demo', 'demo.mp4'),
  demoMeta: path.join(ASSETS_DIR, 'demo', 'demo.detections.json'),
  userData: app.getPath('userData'),
  outputDir: path.join(app.getPath('videos') || app.getPath('documents'), 'StarDetect'),
}));

ipcMain.handle('fs:readJson', (_e, p) => {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
});

ipcMain.handle('fs:writeJson', (_e, p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
});

ipcMain.handle('fs:exists', (_e, p) => fs.existsSync(p));

ipcMain.handle('media:url', (_e, p) => 'media:///' + encodeURI(p.replace(/\\/g, '/')));

ipcMain.handle('log:renderer', (_e, level, msg) => { (log[level] || log.info)('renderer', msg); });
ipcMain.handle('app:logPath', () => log.LOG_FILE);

// Ensure a YOLO weights file exists locally. Downloads via Electron's network
// stack (Chromium, system CA) which works behind proxies that break Python's
// certifi-based downloads. Returns the local path.
const MODEL_RELEASES = ['v8.3.0', 'v8.4.0', 'v8.2.0'];
ipcMain.handle('app:ensureModel', async (_e, name) => {
  const dest = path.join(APP_ROOT, 'models', name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) return { path: dest, downloaded: false };
  const { net } = require('electron');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (const rel of MODEL_RELEASES) {
    const url = `https://github.com/ultralytics/assets/releases/download/${rel}/${name}`;
    try {
      log.info('model', `downloading ${name} from ${rel}`);
      const res = await net.fetch(url, { redirect: 'follow' });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100000) { lastErr = new Error('file too small'); continue; }
      fs.writeFileSync(dest, buf);
      log.info('model', `downloaded ${name} (${buf.length} bytes)`);
      return { path: dest, downloaded: true };
    } catch (err) { lastErr = err; log.warn('model', `download attempt failed: ${err.message}`); }
  }
  throw new Error(`Could not download model '${name}': ${lastErr ? lastErr.message : 'unknown'}. Place the .pt file in the models/ folder manually.`);
});

// Enumerate installed system font families (Windows via System.Drawing).
let _fontCache = null;
ipcMain.handle('app:fonts', () => new Promise((resolve) => {
  if (_fontCache) return resolve(_fontCache);
  if (process.platform !== 'win32') return resolve([]);
  const ps = 'Add-Type -AssemblyName System.Drawing; '
    + '(New-Object System.Drawing.Text.InstalledFontCollection).Families | '
    + 'ForEach-Object { $_.Name } | Sort-Object';
  execFile('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (err, stdout) => {
    if (err) { log.warn('fonts', 'enumeration failed: ' + err.message); return resolve([]); }
    _fontCache = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    log.info('fonts', `found ${_fontCache.length} system fonts`);
    resolve(_fontCache);
  });
}));

// --------------------------------------------------------------------------- //
// IPC: dialogs
// --------------------------------------------------------------------------- //
ipcMain.handle('dialog:openVideo', async (_e, multi = false) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Video',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
  });
  return res.canceled ? (multi ? [] : null) : (multi ? res.filePaths : res.filePaths[0]);
});

ipcMain.handle('dialog:saveFile', async (_e, opts = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: opts.title || 'Export',
    defaultPath: opts.defaultPath,
    filters: opts.filters,
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:openAudio', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Sound Effect',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'flac'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// --------------------------------------------------------------------------- //
// IPC: presets
// --------------------------------------------------------------------------- //
ipcMain.handle('presets:listStyles', () => {
  fs.mkdirSync(STYLES_DIR, { recursive: true });
  return fs.readdirSync(STYLES_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, f), 'utf-8'));
    return { file: f, path: path.join(STYLES_DIR, f), name: data.name || f.replace('.json', ''), data };
  });
});

ipcMain.handle('presets:saveStyle', (_e, name, data) => {
  fs.mkdirSync(STYLES_DIR, { recursive: true });
  const safe = name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  const p = path.join(STYLES_DIR, `${safe}.json`);
  fs.writeFileSync(p, JSON.stringify({ name, ...data }, null, 2));
  return p;
});

ipcMain.handle('presets:listExports', () => {
  const p = path.join(PRESETS_DIR, 'exports', 'export-presets.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')).presets;
});

// --------------------------------------------------------------------------- //
// IPC: backend tasks (stream progress to renderer)
// --------------------------------------------------------------------------- //
function withProgress(event, taskId) {
  return (p) => event.sender.send('task:progress', { taskId, ...p });
}

ipcMain.handle('app:depsCheck', () => runBackend(['deps-check']));
ipcMain.handle('app:models', () => runBackend(['models']));

ipcMain.handle('task:demo', (e, { out, taskId }) =>
  runBackend(['demo', '--out', out], withProgress(e, taskId)));

ipcMain.handle('task:detect', (e, { params, taskId }) => {
  const a = ['detect', '--video', params.video, '--model', params.model,
    '--conf', String(params.conf), '--iou', String(params.iou),
    '--imgsz', String(params.imgsz), '--sample', String(params.sample || 1),
    '--engine', params.engine || 'auto', '--out', params.out];
  if (params.classes) a.push('--classes', params.classes);
  if (params.track) a.push('--track');
  return runBackend(a, withProgress(e, taskId));
});

ipcMain.handle('task:export', (e, { metaPath, config, settings, taskId }) => {
  const cfgPath = tmpFile('config.json');
  const setPath = tmpFile('settings.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  fs.writeFileSync(setPath, JSON.stringify(settings));
  return runBackend(['export', '--meta', metaPath, '--config', cfgPath, '--settings', setPath],
    withProgress(e, taskId)).finally(() => {
      try { fs.unlinkSync(cfgPath); fs.unlinkSync(setPath); } catch (_) {}
    });
});

ipcMain.handle('task:sound', (e, { preset, out, meta, trigger, classes, custom, volume, taskId }) => {
  const a = ['sound', '--preset', preset || 'digital_blip', '--out', out];
  if (meta) a.push('--meta', meta, '--trigger', trigger || 'new');
  if (classes) a.push('--classes', classes);
  if (custom) a.push('--custom', custom);
  if (volume != null) a.push('--volume', String(volume));
  return runBackend(a, withProgress(e, taskId));
});

ipcMain.handle('app:cancelAll', () => { killAll(); });
