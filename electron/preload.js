'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Generate a unique id per task so progress events can be routed.
let taskCounter = 0;
function nextTaskId() { return `t${Date.now()}_${taskCounter++}`; }

// Wrap a streaming task: subscribes to progress for its taskId, runs, cleans up.
function runTask(channel, payload, onProgress) {
  const taskId = nextTaskId();
  const listener = (_e, data) => { if (data.taskId === taskId && onProgress) onProgress(data); };
  ipcRenderer.on('task:progress', listener);
  return ipcRenderer.invoke(channel, { ...payload, taskId })
    .finally(() => ipcRenderer.removeListener('task:progress', listener));
}

contextBridge.exposeInMainWorld('api', {
  // paths + fs
  paths: () => ipcRenderer.invoke('app:paths'),
  readJson: (p) => ipcRenderer.invoke('fs:readJson', p),
  writeJson: (p, data) => ipcRenderer.invoke('fs:writeJson', p, data),
  exists: (p) => ipcRenderer.invoke('fs:exists', p),
  mediaUrl: (p) => ipcRenderer.invoke('media:url', p),

  // dialogs / shell
  openVideo: (multi) => ipcRenderer.invoke('dialog:openVideo', multi),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // presets
  listStyles: () => ipcRenderer.invoke('presets:listStyles'),
  saveStyle: (name, data) => ipcRenderer.invoke('presets:saveStyle', name, data),
  listExports: () => ipcRenderer.invoke('presets:listExports'),

  // info
  depsCheck: () => ipcRenderer.invoke('app:depsCheck'),
  models: () => ipcRenderer.invoke('app:models'),
  ensureModel: (name) => ipcRenderer.invoke('app:ensureModel', name),
  fonts: () => ipcRenderer.invoke('app:fonts'),
  logPath: () => ipcRenderer.invoke('app:logPath'),
  log: (level, msg) => ipcRenderer.invoke('log:renderer', level, msg),
  cancelAll: () => ipcRenderer.invoke('app:cancelAll'),

  // streaming tasks
  demo: (out, onProgress) => runTask('task:demo', { out }, onProgress),
  detect: (params, onProgress) => runTask('task:detect', { params }, onProgress),
  export: (metaPath, config, settings, onProgress) =>
    runTask('task:export', { metaPath, config, settings }, onProgress),
  sound: (opts, onProgress) => runTask('task:sound', opts, onProgress),
});
